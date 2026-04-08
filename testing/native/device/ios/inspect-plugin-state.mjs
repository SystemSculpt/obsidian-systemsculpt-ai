#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  IOS_RUNTIME_READY_DELAY_MS,
  IOS_RUNTIME_ENABLE_ATTEMPTS,
} from "../../shared/ios-runtime-constants.mjs";

const DEFAULT_PORT = 9000;
const DEFAULT_PLUGIN_ID = "systemsculpt-ai";
const DEFAULT_TARGET_HINT = "Obsidian";
const DEFAULT_HOST = "127.0.0.1";
const ADAPTER_BOOT_TIMEOUT_MS = 15000;

function usage() {
  console.log(`Usage: node testing/native/device/ios/inspect-plugin-state.mjs [options]

Inspect the live Obsidian runtime on a connected iPhone or iPad through the
RemoteDebug iOS WebKit Adapter and print the current plugin-manager state for a
community plugin.

Options:
  --plugin-id <id>       Plugin id to inspect. Default: systemsculpt-ai
  --port <port>          Adapter port. Default: 9000
  --host <host>          Adapter host. Default: 127.0.0.1
  --target-hint <text>   Match target title/url text. Default: Obsidian
  --community-toggle     Also open Settings > Community plugins and report the rendered toggle state
  --expression <js>      Evaluate custom JS in the live Obsidian runtime instead of the default plugin probe
  --expression-file <p>  Read the custom JS expression from a file
  --strict               Exit non-zero when the plugin is missing, disabled, or reports failures
  --no-start-adapter     Do not auto-start remotedebug_ios_webkit_adapter
  --help, -h             Show this help.`);
}

function fail(message) {
  console.error(`[ios-inspect] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    pluginId: DEFAULT_PLUGIN_ID,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    targetHint: DEFAULT_TARGET_HINT,
    communityToggle: false,
    strict: false,
    startAdapter: true,
    expression: null,
    expressionFile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plugin-id") {
      options.pluginId = String(argv[index + 1] || "").trim() || DEFAULT_PLUGIN_ID;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const parsed = Number(argv[index + 1] || "");
      if (!Number.isFinite(parsed) || parsed <= 0) {
        fail(`Invalid --port value: ${argv[index + 1] || ""}`);
      }
      options.port = parsed;
      index += 1;
      continue;
    }
    if (arg === "--host") {
      options.host = String(argv[index + 1] || "").trim() || DEFAULT_HOST;
      index += 1;
      continue;
    }
    if (arg === "--target-hint") {
      options.targetHint = String(argv[index + 1] || "").trim() || DEFAULT_TARGET_HINT;
      index += 1;
      continue;
    }
    if (arg === "--community-toggle") {
      options.communityToggle = true;
      continue;
    }
    if (arg === "--expression") {
      options.expression = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--expression-file") {
      options.expressionFile = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--no-start-adapter") {
      options.startAdapter = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

async function resolveExpression(options) {
  if (options.expression && options.expressionFile) {
    fail("Use either --expression or --expression-file, not both.");
  }

  if (options.communityToggle && (options.expression || options.expressionFile)) {
    fail("--community-toggle cannot be combined with --expression or --expression-file.");
  }

  if (options.expressionFile) {
    return await readFile(options.expressionFile, "utf8");
  }

  return options.expression;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function enableRuntimeWithSettle(inspector) {
  let lastError = null;
  for (let attempt = 1; attempt <= IOS_RUNTIME_ENABLE_ATTEMPTS; attempt += 1) {
    await sleep(IOS_RUNTIME_READY_DELAY_MS);
    try {
      await inspector.send("Runtime.enable");
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out enabling Runtime.");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return await response.json();
}

async function waitForAdapter(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchJson(`${baseUrl}/json`);
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for the adapter at ${baseUrl}`);
}

async function waitForTarget(baseUrl, targetHint, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await fetchJson(`${baseUrl}/json`);
      const target = selectTarget(targets, targetHint);
      if (target?.webSocketDebuggerUrl) {
        return target;
      }
    } catch {
      // Keep polling until the timeout expires.
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for an inspectable target matching "${targetHint}"`);
}

function startAdapter(port) {
  const child = spawn("remotedebug_ios_webkit_adapter", [`--port=${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let bufferedOutput = "";
  const appendOutput = (chunk) => {
    const text = String(chunk || "");
    bufferedOutput = `${bufferedOutput}${text}`.slice(-8000);
  };

  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  return {
    child,
    getOutput: () => bufferedOutput.trim(),
  };
}

function selectTarget(targets, targetHint) {
  const hint = String(targetHint || "").trim().toLowerCase();
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  const exactHintMatch = normalizedTargets.find((target) => {
    const title = String(target?.title || "").toLowerCase();
    const url = String(target?.url || "").toLowerCase();
    return hint && (title.includes(hint) || url.includes(hint));
  });
  if (exactHintMatch) {
    return exactHintMatch;
  }

  const capacitorTarget = normalizedTargets.find((target) =>
    String(target?.url || "").toLowerCase().includes("capacitor://")
  );
  if (capacitorTarget) {
    return capacitorTarget;
  }

  return normalizedTargets[0] || null;
}

async function connectToTarget(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 8000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      "error",
      (event) => {
        clearTimeout(timer);
        reject(new Error(String(event?.message || "WebSocket error")));
      },
      { once: true }
    );
  });

  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    if (!payload.id || !pending.has(payload.id)) {
      return;
    }

    const { resolve, reject, method } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) {
      reject(new Error(`${method} failed: ${JSON.stringify(payload.error)}`));
      return;
    }
    resolve(payload.result);
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pending.has(id)) {
          return;
        }
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 8000);
      pending.set(id, {
        method,
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  };

  const close = async () => {
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      socket.close();
    });
  };

  return { socket, send, close };
}

function buildInspectionExpression(pluginId) {
  return `(() => {
    const pluginId = ${JSON.stringify(pluginId)};
    const appRef = globalThis.app ?? null;
    const plugins = appRef?.plugins ?? null;
    const plugin = plugins?.plugins?.[pluginId] ?? null;
    const manifest = plugins?.manifests?.[pluginId] ?? plugin?.manifest ?? null;
    const enabledPlugins = Array.from(plugins?.enabledPlugins ?? []);

    return {
      pluginId,
      documentTitle: globalThis.document?.title ?? null,
      vaultName: appRef?.vault?.getName?.() ?? null,
      appName: appRef?.appId ?? null,
      enabledPlugins,
      loadedPluginIds: Object.keys(plugins?.plugins ?? {}),
      hasPluginInstance: Boolean(plugin),
      manifestVersion: manifest?.version ?? null,
      constructorName: plugin?.constructor?.name ?? null,
      failures: Array.isArray(plugin?.failures) ? [...plugin.failures] : plugin?.failures ?? [],
    };
  })()`;
}

function buildCommunityToggleExpression(pluginId) {
  return `(() => {
    const pluginId = ${JSON.stringify(pluginId)};
    const appRef = globalThis.app ?? null;
    const plugins = appRef?.plugins ?? null;
    const plugin = plugins?.plugins?.[pluginId] ?? null;
    const manifest = plugins?.manifests?.[pluginId] ?? plugin?.manifest ?? null;
    const enabledPlugins = Array.from(plugins?.enabledPlugins ?? []);
    const pluginState = {
      pluginId,
      documentTitle: globalThis.document?.title ?? null,
      vaultName: appRef?.vault?.getName?.() ?? null,
      appName: appRef?.appId ?? null,
      enabledPlugins,
      loadedPluginIds: Object.keys(plugins?.plugins ?? {}),
      hasPluginInstance: Boolean(plugin),
      manifestVersion: manifest?.version ?? null,
      constructorName: plugin?.constructor?.name ?? null,
      failures: Array.isArray(plugin?.failures) ? [...plugin.failures] : plugin?.failures ?? [],
    };

    const setting = appRef?.setting ?? null;
    if (!setting?.open || !setting?.openTabById) {
      return {
        plugin: pluginState,
        settingsUi: {
          available: false,
          reason: "app.setting is unavailable",
        },
      };
    }

    setting.open();
    setting.openTabById("community-plugins");

    const rows = Array.from(globalThis.document?.querySelectorAll?.(".setting-item.mod-toggle") ?? []);
    const item = rows.find((row) => String(row?.textContent || "").includes(manifest?.name || pluginId));
    const checkbox = item?.querySelector?.("input[type=checkbox]") ?? null;
    const container = item?.querySelector?.(".checkbox-container") ?? null;

    return {
      plugin: pluginState,
      settingsUi: {
        available: true,
        activeTabId: setting?.activeTab?.id ?? null,
        pluginRowFound: Boolean(item),
        itemClass: item?.className || null,
        itemText: String(item?.textContent || "").trim() || null,
        toggleContainerClass: container?.className || null,
        toggleEnabledClass: container?.classList?.contains?.("is-enabled") === true,
        checkboxInputChecked: checkbox ? Boolean(checkbox.checked) : null,
      },
    };
  })()`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const customExpression = await resolveExpression(options);
  const baseUrl = `http://${options.host}:${options.port}`;
  let adapterChild = null;
  let adapterOutput = () => "";

  let targets;
  try {
    targets = await fetchJson(`${baseUrl}/json`);
  } catch (initialError) {
    if (!options.startAdapter) {
      throw new Error(`Adapter is not reachable at ${baseUrl}: ${initialError.message}`);
    }

    const started = startAdapter(options.port);
    adapterChild = started.child;
    adapterOutput = started.getOutput;

    try {
      targets = await waitForAdapter(baseUrl, ADAPTER_BOOT_TIMEOUT_MS);
    } catch (waitError) {
      adapterChild.kill("SIGTERM");
      throw new Error(
        `Adapter failed to start on ${baseUrl}: ${waitError.message}\n${adapterOutput()}`.trim()
      );
    }
  }

  try {
    let target = selectTarget(targets, options.targetHint);
    if (!target?.webSocketDebuggerUrl) {
      target = await waitForTarget(baseUrl, options.targetHint, ADAPTER_BOOT_TIMEOUT_MS);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      target = await waitForTarget(baseUrl, options.targetHint, ADAPTER_BOOT_TIMEOUT_MS);
      const inspector = await connectToTarget(target.webSocketDebuggerUrl);
      try {
        await enableRuntimeWithSettle(inspector);
        const expression = customExpression
          || (options.communityToggle
            ? buildCommunityToggleExpression(options.pluginId)
            : buildInspectionExpression(options.pluginId));
        const evaluation = await inspector.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });

        const runtimeValue = evaluation?.result?.value ?? null;
        const payload = customExpression
          ? {
              target: {
                title: target.title || null,
                url: target.url || null,
                metadata: target.metadata || null,
              },
              evaluation: runtimeValue,
            }
          : options.communityToggle
            ? {
                target: {
                  title: target.title || null,
                  url: target.url || null,
                  metadata: target.metadata || null,
                },
                plugin: runtimeValue?.plugin ?? null,
                settingsUi: runtimeValue?.settingsUi ?? null,
              }
            : {
          target: {
            title: target.title || null,
            url: target.url || null,
            metadata: target.metadata || null,
          },
          plugin: runtimeValue,
        };

        console.log(JSON.stringify(payload, null, 2));

        const pluginState = options.communityToggle ? runtimeValue?.plugin : runtimeValue;
        const failures = Array.isArray(pluginState?.failures) ? pluginState.failures : [];
        const enabledPlugins = Array.isArray(pluginState?.enabledPlugins)
          ? pluginState.enabledPlugins
          : [];
        const isEnabled = enabledPlugins.includes(options.pluginId);
        const hasInstance = pluginState?.hasPluginInstance === true;
        const uiToggleEnabled = options.communityToggle
          ? runtimeValue?.settingsUi?.toggleEnabledClass === true
          : true;
        const uiToggleFound = options.communityToggle
          ? runtimeValue?.settingsUi?.pluginRowFound === true
          : true;

        if (
          !customExpression &&
          options.strict &&
          (!isEnabled || !hasInstance || failures.length > 0 || !uiToggleEnabled || !uiToggleFound)
        ) {
          process.exitCode = 1;
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 4) {
          await sleep(1000);
        }
      } finally {
        await inspector.close();
      }
    }

    if (lastError) {
      throw lastError;
    }
  } finally {
    if (adapterChild) {
      adapterChild.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
