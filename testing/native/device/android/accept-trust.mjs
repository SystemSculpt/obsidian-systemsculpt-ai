#!/usr/bin/env node
/**
 * Accept the Obsidian vault trust prompt on an Android device via CDP.
 *
 * On first open with community plugins, Obsidian shows "Do you trust the
 * author of this vault?" which blocks plugin loading. This script connects
 * to the WebView debugger and clicks "Trust author and enable plugins".
 *
 * Usage:
 *   node testing/native/device/android/accept-trust.mjs [--serial <id>] [--timeout <ms>]
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30000;
const CDP_PORT = 9222;

function log(msg) {
  console.log(`[android-trust] ${msg}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { serial: null, timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--serial" && args[i + 1]) opts.serial = args[++i];
    if (args[i] === "--timeout" && args[i + 1]) opts.timeout = parseInt(args[++i], 10);
  }
  return opts;
}

function adb(cmdArgs, serial) {
  const args = serial ? ["-s", serial, ...cmdArgs] : cmdArgs;
  return execFileSync("adb", args, { encoding: "utf8", timeout: 10000 }).trim();
}

function findWebViewSocket(serial) {
  const unix = adb(["shell", "cat", "/proc/net/unix"], serial);
  const match = unix.match(/@webview_devtools_remote_(\d+)/);
  return match ? `localabstract:webview_devtools_remote_${match[1]}` : null;
}

async function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let idCounter = 1;
    const pending = new Map();

    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = idCounter++;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); },
    });

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const { resolve: res } = pending.get(data.id);
        pending.delete(data.id);
        res(data.result || data);
      }
    };

    ws.onerror = (err) => reject(err);
    setTimeout(() => reject(new Error("CDP connection timeout")), 5000);
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

async function main() {
  const opts = parseArgs();
  const deadline = Date.now() + opts.timeout;

  // Forward CDP port
  const socket = findWebViewSocket(opts.serial);
  if (!socket) {
    log("No WebView debug socket found. Is Obsidian running?");
    process.exit(1);
  }

  const forwardArgs = ["forward", `tcp:${CDP_PORT}`, socket];
  if (opts.serial) forwardArgs.unshift("-s", opts.serial);
  execFileSync("adb", forwardArgs, { stdio: "pipe" });

  // Find the main page target
  let targets;
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
    targets = await resp.json();
  } catch {
    log("Cannot reach CDP endpoint. Is the WebView debuggable?");
    process.exit(1);
  }

  const page = targets.find((t) => t.type === "page");
  if (!page) {
    log("No page target found");
    process.exit(1);
  }

  const cdp = await connectCDP(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  // Poll for trust prompt or plugin loaded state
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, `JSON.stringify({
      hasPlugin: !!app?.plugins?.plugins?.['systemsculpt-ai'],
      trustButton: document.querySelector('.mod-cta')?.textContent?.trim(),
      modalVisible: !!document.querySelector('.modal-container'),
    })`);

    const parsed = JSON.parse(state || "{}");

    if (parsed.hasPlugin) {
      log("Plugin already loaded. No trust prompt needed.");
      cdp.close();
      return;
    }

    if (parsed.trustButton && parsed.trustButton.includes("Trust")) {
      log(`Found trust button: "${parsed.trustButton}". Clicking...`);
      await evaluate(cdp, `document.querySelector('.mod-cta').click()`);
      log("Trust accepted. Waiting for plugin to load...");

      // Wait for plugin to load after trust
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const loaded = await evaluate(cdp, `!!app?.plugins?.plugins?.['systemsculpt-ai']`);
        if (loaded) {
          log("Plugin loaded successfully after trust acceptance.");
          cdp.close();
          return;
        }
      }
      log("Plugin did not load within 20s after trust acceptance.");
      cdp.close();
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  log("Timeout waiting for trust prompt or plugin load.");
  cdp.close();
  process.exit(1);
}

main().catch((err) => {
  log(`Error: ${err.message}`);
  process.exit(1);
});
