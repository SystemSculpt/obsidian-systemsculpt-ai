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

  // Wait for Obsidian to process trust acceptance and auto-load plugins.
  // On macOS this is usually enough; on Windows loadPlugin() often fails
  // internally, so we give it extra time and then fall back to require().
  console.log("Waiting 15s for Obsidian to process trust and auto-load plugins...");
  await sleep(15000);

  // Check if plugin was auto-loaded by trust acceptance.  If not, try
  // Obsidian's loadPlugin() once, then switch to require() for the rest.
  let pluginLoaded = false;
  let loadPluginFailed = false;
  const EVAL_TIMEOUT = 60000; // 60s — plugin onload can be slow

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    // --- Step 1: check current state ---
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const plugins = globalThis.app?.plugins;
        if (!plugins) return { ready: false, reason: 'no-plugins-api' };
        const id = ${JSON.stringify(pluginId)};
        return {
          ready: Boolean(plugins.plugins?.[id]),
          hasManifest: Boolean(plugins.manifests?.[id]),
          isEnabled: plugins.enabledPlugins?.has?.(id) ?? false,
          dir: plugins.manifests?.[id]?.dir ?? null,
          basePath: globalThis.app?.vault?.adapter?.basePath ?? null,
          loadedIds: Object.keys(plugins.plugins ?? {}),
          hasRequire: typeof require === 'function',
        };
      })()`,
      returnByValue: true,
    });
    const state = result?.result?.value;
    console.log(`[attempt ${attempt}] state: ${JSON.stringify(state)}`);

    if (state?.ready) {
      pluginLoaded = true;
      console.log("Plugin already loaded by Obsidian");
      break;
    }

    if (!state?.hasManifest) {
      console.log("No manifest found — waiting for Obsidian to discover plugin...");
      await sleep(3000);
      continue;
    }

    // --- Step 2: try loadPlugin() once, then require() ---
    if (!loadPluginFailed) {
      console.log("Trying Obsidian's loadPlugin()...");
      const loadResult = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const plugins = globalThis.app?.plugins;
          const id = ${JSON.stringify(pluginId)};
          const manifest = plugins.manifests?.[id];
          // Resolve relative path and normalise backslashes
          if (manifest?.dir) {
            let d = manifest.dir;
            const bp = globalThis.app?.vault?.adapter?.basePath || '';
            if (bp && !d.match(/^[A-Za-z]:/) && !d.startsWith('/')) d = bp + '/' + d;
            manifest.dir = d.replace(/\\\\/g, '/');
          }
          try {
            if (!plugins.enabledPlugins?.has?.(id)) await plugins.enablePluginAndSave(id);
            if (!plugins.plugins?.[id]) await plugins.loadPlugin(id);
            return { ok: Boolean(plugins.plugins?.[id]), dir: manifest?.dir };
          } catch (e) {
            return { ok: false, error: e.message, dir: manifest?.dir };
          }
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, EVAL_TIMEOUT);
      const lr = loadResult?.result?.value;
      console.log(`loadPlugin result: ${JSON.stringify(lr)}`);
      if (lr?.ok) { pluginLoaded = true; break; }
      loadPluginFailed = true;
      console.log("loadPlugin() failed — switching to require() for remaining attempts");
    }

    // --- Step 3: require() fallback ---
    console.log("Trying require() fallback...");
    const reqResult = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const plugins = globalThis.app?.plugins;
        const id = ${JSON.stringify(pluginId)};
        const manifest = plugins.manifests?.[id];
        if (!manifest) return { ok: false, reason: 'no-manifest' };

        let dir = manifest.dir;
        const bp = globalThis.app?.vault?.adapter?.basePath || '';
        if (bp && !dir.match(/^[A-Za-z]:/) && !dir.startsWith('/')) dir = bp + '/' + dir;
        dir = dir.replace(/\\\\/g, '/');
        const mainPath = dir + '/main.js';

        try {
          // Clear cache
          if (require.cache) {
            Object.keys(require.cache).forEach(k => {
              if (k.includes('systemsculpt-ai')) delete require.cache[k];
            });
          }
          const mod = (typeof require === 'function') ? require(mainPath) : await import('file:///' + dir + '/main.js');
          const Cls = mod.default || mod;
          if (typeof Cls !== 'function') {
            return { ok: false, reason: 'no-constructor', type: typeof Cls, keys: Object.keys(mod||{}).slice(0,5) };
          }
          const inst = new Cls(globalThis.app, manifest);
          plugins.plugins[id] = inst;
          let onloadErr = null;
          try { await inst.onload(); } catch (e) { onloadErr = e.message; }
          return { ok: true, action: 'require', onloadErr, mainPath };
        } catch (e) {
          return { ok: false, reason: 'require-error', error: e.message, stack: (e.stack||'').slice(0,500), mainPath };
        }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    }, EVAL_TIMEOUT);
    const rr = reqResult?.result?.value;
    console.log(`require() result: ${JSON.stringify(rr)}`);
    if (rr?.ok) { pluginLoaded = true; break; }

    await sleep(3000);
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
