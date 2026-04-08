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

  // Wait for Obsidian to process trust acceptance and load plugins
  console.log("Waiting for plugin to load...");
  await sleep(5000);

  // Check plugin state and enable programmatically if needed
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const plugins = globalThis.app?.plugins;
        if (!plugins) return { ready: false, reason: 'no-plugins-api' };
        const enabled = Array.from(plugins.enabledPlugins ?? []);
        const loaded = Object.keys(plugins.plugins ?? {});
        if (!enabled.includes(${JSON.stringify(pluginId)})) {
          try {
            await plugins.enablePluginAndSave(${JSON.stringify(pluginId)});
            return { ready: true, action: 'enabled' };
          } catch (e) {
            return { ready: false, reason: 'enable-failed', error: e.message, loaded, enabled };
          }
        }
        const hasInstance = Boolean(plugins.plugins?.[${JSON.stringify(pluginId)}]);
        return { ready: true, action: 'already-enabled', hasInstance };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const state = result?.result?.value;
    console.log(`Plugin state attempt ${attempt}: ${JSON.stringify(state)}`);
    if (state?.ready) break;
    await sleep(2000);
  }

  // Give the bridge time to start after plugin enable
  console.log("Waiting 10s for bridge to initialize...");
  await sleep(10000);

  cdp.close();
  console.log("CDP trust dismissal and plugin enable complete");
}

main().catch((error) => {
  console.error(`[cdp-trust] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
