#!/usr/bin/env node
/**
 * Uses Chrome DevTools Protocol to dismiss Obsidian's first-run trust prompt
 * and enable the community plugin. This is used in macOS CI where AppleScript
 * cannot reliably interact with Electron UI elements.
 *
 * Requires Obsidian to be launched with --remote-debugging-port=<port>.
 *
 * Usage:
 *   node testing/native/desktop-automation/cdp-trust-and-enable.mjs [--port 9222] [--plugin-id systemsculpt-ai]
 */
import { setTimeout as sleep } from "node:timers/promises";
import process from "node:process";

const DEFAULT_PORT = 9222;
const DEFAULT_PLUGIN_ID = "systemsculpt-ai";

function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, pluginId: DEFAULT_PLUGIN_ID };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") {
      options.port = Number(argv[++i]) || DEFAULT_PORT;
    } else if (argv[i] === "--plugin-id") {
      options.pluginId = String(argv[++i] || "").trim() || DEFAULT_PLUGIN_ID;
    }
  }
  return options;
}

async function waitForCdpTargets(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/json/list`);
      const targets = await res.json();
      if (Array.isArray(targets) && targets.length > 0) return targets;
    } catch {
      // CDP not ready yet
    }
    await sleep(500);
  }
  throw new Error(`No CDP targets found at ${baseUrl} within ${timeoutMs}ms`);
}

function createCdpConnection(wsUrl) {
  let nextId = 1;
  const pending = new Map();

  const ws = new WebSocket(wsUrl);

  const ready = new Promise((resolve, reject) => {
    const timer = global.setTimeout(() => reject(new Error("WebSocket connect timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket error")); }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });

  function send(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = global.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve(v) { clearTimeout(timer); resolve(v); },
        reject(e) { clearTimeout(timer); reject(e); },
      });
    });
  }

  function close() { ws.close(); }

  return { ready, send, close };
}

async function main() {
  const { port, pluginId } = parseArgs(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Waiting for CDP endpoint on port ${port}...`);
  const targets = await waitForCdpTargets(baseUrl);
  const target = targets.find((t) => t.type === "page") || targets[0];
  console.log(`CDP target: ${target.title} (${target.url})`);

  const cdp = createCdpConnection(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  console.log("Runtime.enable OK");

  // Patch url.pathToFileURL BEFORE clicking trust so it's in place when
  // Obsidian auto-loads plugins after trust acceptance.  On Windows,
  // manifest.dir is relative (".obsidian/plugins/foo") which causes
  // pathToFileURL to throw "File URL path must be absolute".
  console.log("Patching pathToFileURL for relative-path support...");
  const patchResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      try {
        const url = require('url');
        const nodePath = require('path');
        if (url.__ptfuPatched) return 'already-patched';
        const orig = url.pathToFileURL;
        url.pathToFileURL = function(p) {
          if (typeof p === 'string' && !nodePath.isAbsolute(p)) {
            const bp = globalThis.app?.vault?.adapter?.basePath || '';
            if (bp) p = nodePath.resolve(bp, p);
          }
          return orig(p);
        };
        url.__ptfuPatched = true;
        return 'patched';
      } catch (e) { return 'error: ' + e.message; }
    })()`,
    returnByValue: true,
  });
  console.log(`pathToFileURL patch: ${patchResult?.result?.value}`);

  // Poll for trust button and click it
  let trustClicked = false;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.includes('Trust author')) {
            btn.click();
            return 'clicked';
          }
        }
        const cta = document.querySelector('.mod-warning .mod-cta, .modal-button-container .mod-cta');
        if (cta && cta.textContent.includes('Trust')) {
          cta.click();
          return 'clicked-cta';
        }
        return 'not-found:' + Array.from(buttons).map(b => b.textContent.trim()).join('|');
      })()`,
      returnByValue: true,
    });
    const value = result?.result?.value || "";
    console.log(`Trust attempt ${attempt}: ${value}`);
    if (value.startsWith("clicked")) {
      trustClicked = true;
      break;
    }
    await sleep(1000);
  }

  if (!trustClicked) {
    console.log("WARNING: Trust button not found — vault may already be trusted");
  }

  // Wait for Obsidian to process trust acceptance.
  console.log("Waiting 8s for Obsidian to process trust...");
  await sleep(8000);

  // On Windows, Obsidian's loadPlugin() has an unsolvable contradiction:
  //   - pathToFileURL(manifest.dir) needs an absolute dir
  //   - adapter.read(manifest.dir + '/...') needs a RELATIVE dir
  // Making dir absolute fixes pathToFileURL but breaks the adapter (doubled
  // path), and vice versa.  So we skip loadPlugin() entirely on Windows and
  // load the plugin ourselves via require(), after patching Module resolution
  // so that externalized imports (obsidian, electron, @codemirror/*) resolve.
  let pluginLoaded = false;
  const EVAL_TIMEOUT = 60000;

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const plugins = globalThis.app?.plugins;
        if (!plugins) return { ready: false, reason: 'no-plugins-api' };
        const id = ${JSON.stringify(pluginId)};
        if (plugins.plugins?.[id]) return { ready: true, action: 'already-loaded' };

        const manifest = plugins.manifests?.[id];
        if (!manifest) return { ready: false, reason: 'no-manifest' };

        // Enable the plugin in Obsidian's config
        if (!plugins.enabledPlugins?.has?.(id)) {
          try { await plugins.enablePluginAndSave(id); } catch {}
        }

        // Try loadPlugin() first (works on macOS, may work on some Windows)
        try {
          await plugins.loadPlugin(id);
          if (plugins.plugins?.[id]) return { ready: true, action: 'loadPlugin' };
        } catch {}

        // --- Windows fallback: manual require() with module resolution ---
        const nodePath = require('path');
        const bp = globalThis.app?.vault?.adapter?.basePath || '';
        const absDir = bp ? nodePath.resolve(bp, manifest.dir) : manifest.dir;
        const mainPath = nodePath.join(absDir, 'main.js');

        // Make externalized deps (obsidian, electron, etc.) resolvable.
        // Obsidian bundles its API inside app.asar which isn't in standard
        // module paths.  Find it in Module._cache or via createRequire.
        const Module = require('module');
        if (!Module.__cdpPatched) {
          Module.__cdpPatched = true;

          // Strategy 1: search Module._cache for the obsidian module
          // by looking for a cached module that exports Plugin + Notice
          for (const [key, cached] of Object.entries(Module._cache)) {
            const ex = cached?.exports;
            if (ex && typeof ex.Plugin === 'function' && typeof ex.Notice === 'function') {
              Module._cache['obsidian'] = cached;
              break;
            }
          }

          // Strategy 2: try createRequire from app.asar
          if (!Module._cache['obsidian'] && process.resourcesPath) {
            try {
              const asarReq = Module.createRequire(
                nodePath.join(process.resourcesPath, 'app.asar', 'dummy.js')
              );
              const obs = asarReq('obsidian');
              Module._cache['obsidian'] = {
                id: 'obsidian', filename: 'obsidian', loaded: true,
                exports: obs, children: [], paths: [],
              };
            } catch {}
          }

          // Strategy 3: add app.asar to global module paths
          if (process.resourcesPath) {
            const asarPath = nodePath.join(process.resourcesPath, 'app.asar');
            if (!Module.globalPaths.includes(asarPath)) {
              Module.globalPaths.unshift(asarPath);
            }
          }

          // Patch _resolveFilename as a final safety net
          const origResolve = Module._resolveFilename;
          Module._resolveFilename = function(request, parent) {
            if (request === 'obsidian' && Module._cache['obsidian']) {
              return 'obsidian';
            }
            return origResolve.apply(this, arguments);
          };
        }

        try {
          // Clear stale cache
          Object.keys(require.cache).forEach(k => {
            if (k.includes('systemsculpt-ai')) delete require.cache[k];
          });
          const mod = require(mainPath);
          const Cls = mod.default || mod;
          if (typeof Cls !== 'function') {
            return { ready: false, reason: 'no-constructor', type: typeof Cls, mainPath };
          }
          const inst = new Cls(globalThis.app, manifest);
          plugins.plugins[id] = inst;
          let onloadErr = null;
          try { await inst.onload(); } catch (e) { onloadErr = e.message; }
          return { ready: true, action: 'manual-require', onloadErr, mainPath };
        } catch (e) {
          return { ready: false, reason: 'require-failed', error: e.message, mainPath };
        }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    }, EVAL_TIMEOUT);
    const state = result?.result?.value;
    console.log(`[attempt ${attempt}] ${JSON.stringify(state)}`);
    if (state?.ready) {
      pluginLoaded = true;
      break;
    }
    await sleep(2000);
  }

  if (!pluginLoaded) {
    console.error("ERROR: Plugin did not load after all attempts — bridge will not start.");
    cdp.close();
    process.exit(1);
  }

  // Give the bridge time to start after plugin load
  console.log("Waiting 15s for bridge to initialize...");
  await sleep(15000);

  cdp.close();
  console.log("CDP trust dismissal and plugin enable complete");
}

main().catch((error) => {
  console.error(`[cdp-trust] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
