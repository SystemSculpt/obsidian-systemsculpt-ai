#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findProviderModelOption,
  normalizeProviderId,
  resolveProviderModelPreferences,
} from "../../shared/model-inventory.mjs";

export const DEFAULT_MANAGED_MODEL_ID = "systemsculpt@@systemsculpt/ai-agent";
export const DEFAULT_LOCAL_PI_MODEL_ID = "local-pi-openrouter@@openai/gpt-5.4-mini";
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
export const DEFAULT_SEND_TIMEOUT_MS = 300_000;
const PROVIDER_CONNECTED_MODEL_ID_ENV = "SYSTEMSCULPT_DESKTOP_PROVIDER_MODEL_ID";

function fail(message) {
  throw new Error(message);
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseCleanInstallParityArgs(argv, env = process.env) {
  const options = {
    managedModelId: String(env.SYSTEMSCULPT_WINDOWS_MANAGED_MODEL_ID || "").trim() || DEFAULT_MANAGED_MODEL_ID,
    localPiModelId: String(env.SYSTEMSCULPT_WINDOWS_LOCAL_PI_MODEL_ID || "").trim() || DEFAULT_LOCAL_PI_MODEL_ID,
    providerId: normalizeProviderId(env.SYSTEMSCULPT_DESKTOP_PROVIDER_ID || ""),
    preferredProviderModelIds: String(env[PROVIDER_CONNECTED_MODEL_ID_ENV] || "")
      .split(",")
      .map((entry) => String(entry || "").trim())
      .filter((entry) => entry.length > 0),
    apiKeyFile: "",
    apiKey: "",
    waitTimeoutMs: numberOption(env.SYSTEMSCULPT_WINDOWS_WAIT_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS),
    sendTimeoutMs: numberOption(env.SYSTEMSCULPT_WINDOWS_SEND_TIMEOUT_MS, DEFAULT_SEND_TIMEOUT_MS),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--managed-model-id") {
      options.managedModelId = String(argv[index + 1] || "").trim() || options.managedModelId;
      index += 1;
      continue;
    }
    if (arg === "--local-pi-model-id") {
      options.localPiModelId = String(argv[index + 1] || "").trim() || options.localPiModelId;
      index += 1;
      continue;
    }
    if (arg === "--provider-id") {
      options.providerId = normalizeProviderId(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--provider-model-id") {
      options.preferredProviderModelIds = String(argv[index + 1] || "")
        .split(",")
        .map((entry) => String(entry || "").trim())
        .filter((entry) => entry.length > 0);
      index += 1;
      continue;
    }
    if (arg === "--api-key-file") {
      options.apiKeyFile = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--api-key") {
      options.apiKey = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--wait-timeout-ms") {
      options.waitTimeoutMs = numberOption(argv[index + 1], options.waitTimeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--send-timeout-ms") {
      options.sendTimeoutMs = numberOption(argv[index + 1], options.sendTimeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.log(`Usage: node testing/native/device/windows/clean-install-parity.mjs [options]

Run the Windows clean-install parity checks against the live desktop bridge.

Options:
  --provider-id <id>          Optional provider id for API-key auth parity
  --provider-model-id <id>    Optional provider model id or comma list. Default env: ${PROVIDER_CONNECTED_MODEL_ID_ENV}
  --api-key-file <path>       Optional file containing the provider API key
  --api-key <value>           Optional provider API key literal
  --managed-model-id <id>     Managed model id. Default: ${DEFAULT_MANAGED_MODEL_ID}
  --local-pi-model-id <id>    Local Pi fallback model id. Default: ${DEFAULT_LOCAL_PI_MODEL_ID}
  --wait-timeout-ms <n>       Wait timeout for provider and model refreshes
  --send-timeout-ms <n>       Chat send timeout
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toText(entry)).join("");
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
  }
  return String(value ?? "");
}

export function isTransientError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    /\b429\b/.test(message) ||
    [
      "http 429",
      "status 429",
      "too many requests",
      "rate limited",
      "rate-limited",
      "temporarily unavailable",
      "retry shortly",
      "retry after",
      "upstream error",
    ].some((needle) => message.includes(needle))
  );
}

async function retryTransient(operation, attempts = 3, pauseMs = 1500) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await operation(index);
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || index === attempts - 1) {
        throw error;
      }
      await sleep(pauseMs);
    }
  }
  throw lastError || new Error("Transient retry exhausted.");
}

async function loadLatestRecord() {
  const discoveryDir = path.win32.resolve(os.homedir(), ".systemsculpt", "obsidian-automation");
  const names = (await fs.readdir(discoveryDir)).filter((name) => name.endsWith(".json"));
  if (names.length < 1) {
    fail("No Windows bridge discovery files were found.");
  }

  const records = [];
  for (const name of names) {
    const filePath = path.win32.join(discoveryDir, name);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    records.push({ ...parsed, discoveryFilePath: filePath });
  }

  records.sort((left, right) => String(right.startedAt || "").localeCompare(String(left.startedAt || "")));
  return records[0];
}

async function request(record, pathname, options = {}) {
  const response = await fetch(`http://${record.host || "127.0.0.1"}:${record.port}${pathname}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${record.token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(numberOption(options.timeoutMs, 60_000)),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status} for ${pathname}`);
  }

  return payload.data;
}

function providerRows(snapshot) {
  return Array.isArray(snapshot?.providers?.rows) ? snapshot.providers.rows : [];
}

export function findProviderRow(snapshot, providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  return (
    providerRows(snapshot).find(
      (row) => normalizeProviderId(row?.providerId) === normalizedProviderId
    ) || null
  );
}

function findModelOption(inventory, predicate) {
  const options = Array.isArray(inventory?.options) ? inventory.options : [];
  return options.find((option) => predicate(option)) || null;
}

export function findProviderModel(inventory, providerId, authenticated, options = {}) {
  return findProviderModelOption(inventory, providerId, {
    authenticated,
    preferredSections: ["pi", "local"],
    preferredModelIds: resolveProviderModelPreferences(
      providerId,
      options.preferredModelIds
    ),
  });
}

function summarizeProviderRow(row) {
  return row
    ? {
        providerId: normalizeProviderId(row.providerId),
        label: String(row.label || row.providerId || "").trim() || null,
        source: String(row.source || "").trim() || null,
        hasAnyAuth: Boolean(row.hasAnyAuth),
        hasStoredCredential: Boolean(row.hasStoredCredential),
        apiKeyEnabled: Boolean(row.apiKeyEnabled),
        ready: Boolean(row.display?.ready),
      }
    : null;
}

export function summarizeProvidersPanel(snapshot) {
  return {
    settingsModalOpen: Boolean(snapshot?.settings?.settingsModalOpen),
    pluginSettingsOpen: Boolean(snapshot?.settings?.pluginSettingsOpen),
    activePluginTabId:
      String(snapshot?.settings?.activePluginTabId || "").trim() || null,
    panelVisible: Boolean(snapshot?.ui?.panelVisible),
    rowCount: providerRows(snapshot).length,
    error:
      String(snapshot?.providers?.error || snapshot?.ui?.error || "").trim() || null,
  };
}

function assertProvidersPanelReady(snapshot) {
  const summary = summarizeProvidersPanel(snapshot);
  if (
    !summary.settingsModalOpen ||
    !summary.pluginSettingsOpen ||
    summary.activePluginTabId !== "providers" ||
    !summary.panelVisible
  ) {
    fail(
      `Providers panel did not open correctly. Snapshot: ${JSON.stringify(summary)}`
    );
  }
  return summary;
}

async function waitFor(label, check, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = 750) {
  const deadline = Date.now() + numberOption(timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  let lastValue = null;

  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  fail(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function selectModel(record, modelId) {
  await request(record, "/v1/chat/ensure-open", {
    method: "POST",
    body: { reset: true, selectedModelId: modelId },
    timeoutMs: 30_000,
  });
  await request(record, "/v1/chat/model", {
    method: "POST",
    body: { modelId },
    timeoutMs: 30_000,
  });
}

async function sendExactToken(record, modelId, token, options = {}) {
  await selectModel(record, modelId);
  const snapshot = await retryTransient(() =>
    request(record, "/v1/chat/send", {
      method: "POST",
      body: {
        text: `Reply with this exact token and nothing else: ${token}`,
        includeContextFiles: false,
        webSearchEnabled: false,
        approvalMode: "interactive",
      },
      timeoutMs: numberOption(options.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS),
    })
  );

  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const assistant = [...messages].reverse().find((message) => message?.role === "assistant") || null;
  const assistantText = toText(assistant?.content).trim();
  if (!assistantText.includes(token)) {
    fail(`Model ${modelId} did not echo the expected token. Actual reply: ${assistantText}`);
  }

  return {
    selectedModelId: snapshot?.selectedModelId || modelId,
    currentModelName: snapshot?.currentModelName || null,
    reply: assistantText,
  };
}

async function expectProvidersFailure(record, modelId, label) {
  await selectModel(record, modelId);
  let message = null;
  try {
    await request(record, "/v1/chat/send", {
      method: "POST",
      body: {
        text: "Reply with OK.",
        includeContextFiles: false,
        webSearchEnabled: false,
        approvalMode: "interactive",
      },
      timeoutMs: 120_000,
    });
  } catch (error) {
    message = String(error?.message || error || "").trim();
  }

  if (!message || !/providers/i.test(message)) {
    fail(`${label} expected Providers guidance. Actual: ${String(message || "success")}`);
  }

  return message;
}

async function resolveApiKey(options) {
  if (options.apiKey) {
    return options.apiKey;
  }
  if (!options.apiKeyFile) {
    return "";
  }
  return String((await fs.readFile(options.apiKeyFile, "utf8")) || "").trim();
}

export async function runCleanInstallParityAgainstRecord(record, options = {}) {
  const apiKey = await resolveApiKey(options);
  if (!record || typeof record !== "object") {
    fail("Missing desktop automation bridge record.");
  }
  if (!String(record.token || "").trim()) {
    fail("Desktop automation bridge record is missing its token.");
  }
  if (!Number.isFinite(Number(record.port)) || Number(record.port) <= 0) {
    fail("Desktop automation bridge record is missing a valid port.");
  }
  const ping = await request(record, "/v1/ping", { timeoutMs: 5_000 });
  const inventoryBefore = await request(record, "/v1/chat/models?refresh=1", { timeoutMs: 60_000 });
  const managedOption = findModelOption(
    inventoryBefore,
    (option) => String(option?.value || "").trim() === options.managedModelId
  );

  if (!managedOption) {
    fail(`Managed SystemSculpt model "${options.managedModelId}" was not present in the Windows chat inventory.`);
  }
  if (!managedOption.providerAuthenticated) {
    fail("Managed SystemSculpt model is present but not authenticated.");
  }

  const managedTurn = await sendExactToken(
    record,
    options.managedModelId,
    `WINDOWS_MANAGED_${Date.now()}`,
    options
  );
  const blockedLocalPi = await expectProvidersFailure(
    record,
    options.localPiModelId,
    "Local Pi blocked baseline"
  );

  await request(record, "/v1/settings/open", {
    method: "POST",
    body: { targetTab: "providers" },
    timeoutMs: 30_000,
  });
  const providersSnapshot = await request(record, "/v1/settings/providers/snapshot", {
    method: "POST",
    body: { ensureOpen: true, waitForLoaded: true, preflightRefresh: false },
    timeoutMs: 30_000,
  });
  const providersPanel = assertProvidersPanelReady(providersSnapshot);

  const result = {
    ok: true,
    ping,
    bridge: {
      host: record.host || "127.0.0.1",
      port: Number(record.port) || null,
      discoveryFilePath: record.discoveryFilePath || null,
      startedAt: record.startedAt || null,
      vaultPath: record.vaultPath || null,
      vaultName: record.vaultName || null,
    },
    managed: {
      modelId: options.managedModelId,
      providerAuthenticated: Boolean(managedOption.providerAuthenticated),
      turn: managedTurn,
    },
    blockedLocalPi: {
      modelId: options.localPiModelId,
      error: blockedLocalPi,
    },
    providersPanel: {
      ...providersPanel,
    },
    provider: null,
  };

  if (!options.providerId) {
    return result;
  }
  if (!apiKey) {
    fail(`Provider "${options.providerId}" was requested but no API key was resolved.`);
  }

  const initialRow = findProviderRow(providersSnapshot, options.providerId);
  if (!initialRow) {
    fail(`Providers snapshot did not include provider "${options.providerId}".`);
  }

  await request(record, "/v1/settings/providers/clear-auth", {
    method: "POST",
    body: { providerId: options.providerId },
    timeoutMs: 30_000,
  }).catch(() => null);

  const disconnected = await waitFor(
    `${options.providerId} disconnected row`,
    async () => {
      const snapshot = await request(record, "/v1/settings/providers/snapshot", {
        method: "POST",
        body: { ensureOpen: false, waitForLoaded: true, preflightRefresh: false },
        timeoutMs: 30_000,
      });
      const row = findProviderRow(snapshot, options.providerId);
      return row && !row.hasAnyAuth && !row.hasStoredCredential && !row.display?.ready
        ? { snapshot, row }
        : null;
    },
    options.waitTimeoutMs
  );

  await request(record, "/v1/settings/providers/api-key", {
    method: "POST",
    body: { providerId: options.providerId, apiKey },
    timeoutMs: 30_000,
  });

  const connected = await waitFor(
    `${options.providerId} connected row`,
    async () => {
      const snapshot = await request(record, "/v1/settings/providers/snapshot", {
        method: "POST",
        body: { ensureOpen: false, waitForLoaded: true, preflightRefresh: false },
        timeoutMs: 30_000,
      });
      const row = findProviderRow(snapshot, options.providerId);
      return row && row.source === "api_key" && row.hasAnyAuth && row.hasStoredCredential && row.display?.ready
        ? { snapshot, row }
        : null;
    },
    options.waitTimeoutMs
  );

  const providerModelState = await waitFor(
    `${options.providerId} authenticated model`,
    async () => {
      const inventory = await request(record, "/v1/chat/models?refresh=1", { timeoutMs: 60_000 });
      const option = findProviderModel(inventory, options.providerId, true, {
        preferredModelIds: options.preferredProviderModelIds,
      });
      return option ? { inventory, option } : null;
    },
    options.waitTimeoutMs
  );

  const providerTurn = await sendExactToken(
    record,
    providerModelState.option.value,
    `WINDOWS_PROVIDER_${options.providerId.toUpperCase()}_${Date.now()}`,
    options
  );

  await request(record, "/v1/settings/providers/clear-auth", {
    method: "POST",
    body: { providerId: options.providerId },
    timeoutMs: 30_000,
  });

  const cleared = await waitFor(
    `${options.providerId} cleared row`,
    async () => {
      const snapshot = await request(record, "/v1/settings/providers/snapshot", {
        method: "POST",
        body: { ensureOpen: false, waitForLoaded: true, preflightRefresh: false },
        timeoutMs: 30_000,
      });
      const row = findProviderRow(snapshot, options.providerId);
      return row && !row.hasAnyAuth && !row.hasStoredCredential && !row.display?.ready
        ? { snapshot, row }
        : null;
    },
    options.waitTimeoutMs
  );

  const inventoryAfterClear = await waitFor(
    `${options.providerId} deauthenticated model`,
    async () => {
      const inventory = await request(record, "/v1/chat/models?refresh=1", { timeoutMs: 60_000 });
      return findProviderModel(inventory, options.providerId, true, {
        preferredModelIds: options.preferredProviderModelIds,
      })
        ? null
        : inventory;
    },
    options.waitTimeoutMs
  );

  const blockedProviderOption =
    findProviderModel(inventoryAfterClear, options.providerId, false, {
      preferredModelIds: options.preferredProviderModelIds,
    }) || providerModelState.option;
  const blockedProviderSend = await expectProvidersFailure(
    record,
    blockedProviderOption.value,
    "Provider blocked after auth clear"
  );

  result.provider = {
    providerId: options.providerId,
    initial: summarizeProviderRow(initialRow),
    disconnected: summarizeProviderRow(disconnected.row),
    connected: summarizeProviderRow(connected.row),
    model: {
      value: providerModelState.option.value,
      label: String(providerModelState.option.label || "").trim() || null,
      providerAuthenticated: Boolean(providerModelState.option.providerAuthenticated),
    },
    turn: providerTurn,
    cleared: summarizeProviderRow(cleared.row),
    blockedAfterClear: {
      modelId: blockedProviderOption.value,
      error: blockedProviderSend,
    },
  };

  return result;
}

export async function runWindowsCleanInstallParity(options = {}) {
  const record = await loadLatestRecord();
  return await runCleanInstallParityAgainstRecord(record, options);
}

async function main() {
  const options = parseCleanInstallParityArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const result = await runWindowsCleanInstallParity(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[windows-clean-install-parity] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
