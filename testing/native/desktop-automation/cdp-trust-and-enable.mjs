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

  // Wait for Obsidian to process trust acceptance
  console.log("Waiting 8s for Obsidian to process trust...");
  await sleep(8000);

  // Explicitly load the plugin — trust acceptance adds the ID to enabledPlugins
  // but may not actually instantiate the plugin code on first run.
  //
  // On Windows, Obsidian's loadPlugin() fails with "File URL path must be
  // absolute" because it passes backslash paths to pathToFileURL().  We first
  // normalise manifest.dir (backslash → forward-slash) so the native loader
  // succeeds.  If it still fails we fall back to a manual dynamic import.
  let pluginLoaded = false;
  let triedPathFix = false;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const plugins = globalThis.app?.plugins;
        if (!plugins) return { ready: false, reason: 'no-plugins-api' };
        const id = ${JSON.stringify(pluginId)};
        const hasInstance = Boolean(plugins.plugins?.[id]);
        const isEnabled = plugins.enabledPlugins?.has?.(id) || Array.from(plugins.enabledPlugins ?? []).includes(id);
        const manifest = plugins.manifests?.[id];

        // If already loaded, we're done
        if (hasInstance) {
          return { ready: true, action: 'already-loaded', hasInstance: true };
        }

        // Normalise Windows backslash paths in manifest.dir so that
        // Obsidian's internal pathToFileURL call receives a path it accepts.
        if (manifest?.dir && manifest.dir.includes('\\\\')) {
          manifest.dir = manifest.dir.replace(/\\\\/g, '/');
        }

        // Try to enable and load the plugin
        try {
          // First ensure it's enabled
          if (!isEnabled) {
            await plugins.enablePluginAndSave(id);
          }
          // Force load the plugin if it has a manifest but no instance
          if (manifest && !plugins.plugins?.[id]) {
            await plugins.loadPlugin(id);
          }
          // Check again after loading
          const nowLoaded = Boolean(plugins.plugins?.[id]);
          return {
            ready: nowLoaded,
            action: nowLoaded ? 'loaded' : 'load-pending',
            hasInstance: nowLoaded,
            hasManifest: Boolean(manifest),
            isEnabled: plugins.enabledPlugins?.has?.(id) ?? false,
            dir: manifest?.dir,
            loadedIds: Object.keys(plugins.plugins ?? {}),
          };
        } catch (e) {
          return {
            ready: false,
            reason: 'load-failed',
            error: e.message,
            hasManifest: Boolean(manifest),
            isEnabled,
            dir: manifest?.dir,
            loadedIds: Object.keys(plugins.plugins ?? {}),
          };
        }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const state = result?.result?.value;
    console.log(`Plugin state attempt ${attempt}: ${JSON.stringify(state)}`);
    if (state?.ready && state?.hasInstance) {
      pluginLoaded = true;
      break;
    }

    // Fallback: manual dynamic import when loadPlugin keeps failing
    if (attempt >= 2 && state?.reason === "load-failed" && state?.dir) {
      if (!triedPathFix) {
        triedPathFix = true;
        console.log(`loadPlugin() failed: ${state.error} — trying manual import...`);
      }
      const manualResult = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const plugins = globalThis.app?.plugins;
          const id = ${JSON.stringify(pluginId)};
          const manifest = plugins.manifests?.[id];
          if (!manifest) return { ready: false, reason: 'no-manifest' };

          // manifest.dir is often relative (e.g. ".obsidian/plugins/foo").
          // Resolve against vault basePath, then construct a valid file URL.
          let dir = manifest.dir;
          const basePath = globalThis.app?.vault?.adapter?.basePath || '';
          if (basePath && !dir.match(/^[A-Za-z]:/) && !dir.startsWith('/')) {
            dir = basePath + '/' + dir;
          }
          dir = dir.replace(/\\\\/g, '/');
          if (/^[A-Za-z]:/.test(dir)) dir = '/' + dir;
          const fileUrl = 'file://' + encodeURI(dir).replace(/%3A/gi, ':') + '/main.js';

          try {
            const mod = await import(fileUrl);
            const PluginClass = mod.default;
            if (typeof PluginClass !== 'function') {
              return { ready: false, reason: 'no-default-export', fileUrl };
            }
            const instance = new PluginClass(globalThis.app, manifest);
            plugins.plugins[id] = instance;

            // Run onload — do NOT swallow errors so we get diagnostics
            await instance.onload();

            return { ready: true, action: 'manual-import', fileUrl };
          } catch (e) {
            return { ready: false, reason: 'manual-import-failed', error: e.message, stack: (e.stack || '').slice(0, 400), fileUrl };
          }
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      const manualState = manualResult?.result?.value;
      console.log(`Manual import result: ${JSON.stringify(manualState)}`);
      if (manualState?.ready) {
        pluginLoaded = true;
        break;
      }
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
