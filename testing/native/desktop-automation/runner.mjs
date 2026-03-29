import fs from "node:fs/promises";
import path from "node:path";
import {
  bootstrapDesktopAutomationClient,
  DEFAULT_RELOAD_SETTLE_INTERVAL_MS,
  DEFAULT_RELOAD_STABLE_FOR_MS,
  DEFAULT_RELOAD_TIMEOUT_MS,
} from "./bootstrap.mjs";
import { waitForStableDesktopAutomationClient } from "./client.mjs";
import { loadFixtureBundle } from "../runtime-smoke/fixtures.mjs";
import {
  DEFAULT_FIXTURE_DIR,
  DEFAULT_PAUSE_MS,
  DEFAULT_REPEAT,
  DEFAULT_WEB_FETCH_URL,
  DEFAULT_YOUTUBE_URL,
} from "../runtime-smoke/constants.mjs";
import {
  describeModelOptions,
  findProviderModelOption,
  normalizeProviderId,
} from "../shared/model-inventory.mjs";

export const CORE_CASES = ["model-switch", "chat-exact", "file-read", "file-write", "web-fetch"];
export const EXTENDED_CASES = [...CORE_CASES, "youtube-transcript"];
export const STRESS_CASES = ["reload-stress"];
export const DEFAULT_STRESS_CASE = STRESS_CASES[0];
export const CHATVIEW_STRESS_CASE = "chatview-stress";
export const SETUP_BASELINE_CASE = "setup-baseline";
export const MANAGED_BASELINE_CASE = "managed-baseline";
export const PROVIDER_CONNECTED_BASELINE_CASE = "provider-connected-baseline";
export const SOAK_CASES = [DEFAULT_STRESS_CASE, CHATVIEW_STRESS_CASE];
const MANAGED_SYSTEMSCULPT_MODEL_ID = "systemsculpt@@systemsculpt/ai-agent";
const WINDOWS_BASELINE_LOCAL_MODEL_ID = "local-pi-openai@@gpt-4.1";
const WINDOWS_BASELINE_LOCAL_MODEL_LABEL = "gpt-4.1";
const PROVIDER_CONNECTED_PROVIDER_ID_ENV = "SYSTEMSCULPT_DESKTOP_PROVIDER_ID";
const PROVIDER_CONNECTED_API_KEY_ENV = "SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY";
const PROVIDER_CONNECTED_API_KEYS_ENV = "SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS";
const PROVIDER_CONNECTED_MODEL_ID_ENV = "SYSTEMSCULPT_DESKTOP_PROVIDER_MODEL_ID";
const DEFAULT_PROVIDER_CONNECTED_WAIT_TIMEOUT_MS = 90_000;
const DEFAULT_TRANSIENT_SEND_ATTEMPTS = 3;
const DEFAULT_TRANSIENT_SEND_PAUSE_MS = 5_000;
const DEFAULT_PROVIDER_CONNECTED_MODEL_PREFERENCES = new Map([
  [
    "openrouter",
    [
      "openai/gpt-5.4-mini",
      "openai/gpt-4.1-mini",
      "google/gemini-2.5-flash",
      "anthropic/claude-3.7-sonnet",
    ],
  ],
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryTransientOperation(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 1);
  const pauseMs = Math.max(0, Number(options.pauseMs) || 0);
  const onTransientError = typeof options.onTransientError === "function" ? options.onTransientError : null;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isTransientModelExecutionError(error) || attempt === attempts - 1) {
        throw error;
      }
      lastError = error;
      if (onTransientError) {
        onTransientError(error, attempt + 1);
      }
      if (pauseMs > 0) {
        await sleep(pauseMs);
      }
    }
  }

  throw lastError || new Error("Transient retry loop exhausted without a result.");
}

function sanitizeEnsuredForReport(ensured) {
  const settings =
    ensured?.settings && typeof ensured.settings === "object" && !Array.isArray(ensured.settings)
      ? ensured.settings
      : {};

  return {
    dataFilePath: ensured?.dataFilePath || null,
    existed: Boolean(ensured?.existed),
    wrote: Boolean(ensured?.wrote),
    seedSource: ensured?.seedSource || null,
    seedVaultName: ensured?.seedVaultName || null,
    vaultInstanceId: ensured?.vaultInstanceId || null,
    desktopAutomationBridgeEnabled: Boolean(ensured?.desktopAutomationBridgeEnabled),
    selectedModelId:
      typeof settings.selectedModelId === "string" ? settings.selectedModelId : null,
    settingsMode: typeof settings.settingsMode === "string" ? settings.settingsMode : null,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isTransientModelExecutionError(error) {
  const message = errorMessage(error).toLowerCase();
  const staleCatalogModel =
    ((/\b404\b/.test(message) || message.includes("not_found")) &&
      message.includes("model") &&
      (
        message.includes("not found") ||
        message.includes("does not exist") ||
        message.includes("not supported")
      )) ||
    (message.includes("call listmodels") && message.includes("model"));
  return (
    /\b429\b/.test(message) ||
    staleCatalogModel ||
    [
      "http 429",
      "status 429",
      "provider returned error",
      "too many requests",
      "rate-limited",
      "rate limited",
      "retry shortly",
      "retry after",
      "upstream error",
      "upstream failure",
      "temporarily unavailable",
    ].some((needle) => message.includes(needle))
  );
}

function toMessageText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toMessageText(entry)).join("");
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

function getLastAssistantMessage(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index];
    }
  }
  return null;
}

function assertIncludes(actual, expected, label) {
  if (!String(actual || "").includes(expected)) {
    throw new Error(`${label} did not contain "${expected}". Actual value: ${String(actual || "")}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected "${expected}" but got "${actual}"`);
  }
}

function assertTruthy(value, label) {
  if (!value) {
    throw new Error(`${label} was missing.`);
  }
}

function assertGreaterThan(actual, threshold, label) {
  if (!(Number(actual) > Number(threshold))) {
    throw new Error(`${label} expected to be greater than "${threshold}" but got "${actual}"`);
  }
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function isLocalSectionOption(option) {
  return String(option?.section || "").trim().toLowerCase() === "local";
}

function isReadyModelOption(option, options = {}) {
  if (!option || !option.providerAuthenticated) {
    return false;
  }
  if (options.allowLocalPi) {
    return true;
  }
  return !isLocalSectionOption(option);
}

function parseProviderConnectedApiKeyMap(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return new Map();
  }

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${PROVIDER_CONNECTED_API_KEYS_ENV} must be valid JSON. ${errorMessage(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${PROVIDER_CONNECTED_API_KEYS_ENV} must be a JSON object keyed by provider id.`);
  }

  const apiKeysByProvider = new Map();
  for (const [providerId, apiKey] of Object.entries(parsed)) {
    const normalizedProviderId = normalizeProviderId(providerId);
    const normalizedApiKey = String(apiKey || "").trim();
    if (!normalizedProviderId || !normalizedApiKey) {
      continue;
    }
    apiKeysByProvider.set(normalizedProviderId, normalizedApiKey);
  }

  return apiKeysByProvider;
}

function resolveProviderConnectedAuthConfig(env = process.env) {
  const explicitProviderId = normalizeProviderId(env[PROVIDER_CONNECTED_PROVIDER_ID_ENV]);
  const explicitApiKey = String(env[PROVIDER_CONNECTED_API_KEY_ENV] || "").trim();
  const apiKeysByProvider = parseProviderConnectedApiKeyMap(env[PROVIDER_CONNECTED_API_KEYS_ENV]);
  const preferredModelIds = String(env[PROVIDER_CONNECTED_MODEL_ID_ENV] || "")
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry.length > 0);

  if (explicitApiKey && !explicitProviderId) {
    throw new Error(
      `${PROVIDER_CONNECTED_API_KEY_ENV} requires ${PROVIDER_CONNECTED_PROVIDER_ID_ENV} to name the target provider.`
    );
  }

  if (explicitProviderId && explicitApiKey) {
    apiKeysByProvider.set(explicitProviderId, explicitApiKey);
  }

  return {
    env,
    explicitProviderId: explicitProviderId || null,
    apiKeysByProvider,
    preferredModelIds,
  };
}

function resolveProviderConnectedModelPreferences(providerId, authConfig) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const defaults = DEFAULT_PROVIDER_CONNECTED_MODEL_PREFERENCES.get(normalizedProviderId) || [];
  return Array.from(
    new Set([
      ...(Array.isArray(authConfig?.preferredModelIds) ? authConfig.preferredModelIds : []),
      ...defaults,
    ])
  );
}

function getProviderSettingsRows(snapshot) {
  return Array.isArray(snapshot?.providers?.rows) ? snapshot.providers.rows : [];
}

function summarizeProviderRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  return {
    providerId: String(row.providerId || "").trim() || null,
    label: String(row.label || "").trim() || null,
    source: String(row.source || "").trim() || null,
    credentialType: String(row.credentialType || "").trim() || null,
    isLocalProvider: Boolean(row.isLocalProvider),
    apiKeyEnvVar: String(row.apiKeyEnvVar || "").trim() || null,
    display: row.display || null,
  };
}

function describeProviderCredentialInputs(rows) {
  const providers = [];
  const seen = new Set();

  for (const row of rows) {
    const providerId = normalizeProviderId(row?.providerId);
    const envVar = String(row?.apiKeyEnvVar || "").trim();
    if (!providerId || !envVar || Boolean(row?.isLocalProvider)) {
      continue;
    }

    const summary = `${providerId}:${envVar}`;
    if (seen.has(summary)) {
      continue;
    }
    seen.add(summary);
    providers.push(summary);
  }

  return providers.join(", ");
}

function assertProvidersSnapshotReady(snapshot, label = "Providers settings") {
  if (!snapshot?.settings?.settingsModalOpen) {
    throw new Error(`${label} did not have the Obsidian settings modal open.`);
  }
  if (!snapshot?.settings?.pluginSettingsOpen) {
    throw new Error(`${label} did not have the SystemSculpt settings tab open.`);
  }
  if (snapshot?.settings?.activePluginTabId !== "providers") {
    throw new Error(
      `${label} did not focus the Providers tab. Active tab: ${String(snapshot?.settings?.activePluginTabId || "")}`
    );
  }
  if (!snapshot?.ui?.panelVisible) {
    throw new Error(`${label} did not render the providers panel.`);
  }
  if (!Number.isFinite(Number(snapshot?.providers?.rowCount)) || Number(snapshot.providers.rowCount) < 1) {
    const providerError =
      String(snapshot?.providers?.error || snapshot?.ui?.error || "").trim() || null;
    throw new Error(
      `${label} did not expose any provider rows${providerError ? `: ${providerError}` : "."}`
    );
  }
}

function findProviderRow(snapshot, providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  return getProviderSettingsRows(snapshot).find(
    (row) => normalizeProviderId(row?.providerId) === normalizedProviderId
  ) || null;
}

function resolveProviderConnectedCandidate(row, authConfig) {
  const providerId = normalizeProviderId(row?.providerId);
  if (!providerId || Boolean(row?.isLocalProvider) || !Boolean(row?.apiKeyEnabled)) {
    return null;
  }

  if (authConfig.explicitProviderId && providerId !== authConfig.explicitProviderId) {
    return null;
  }

  const mappedApiKey = String(authConfig.apiKeysByProvider.get(providerId) || "").trim();
  if (mappedApiKey) {
    return {
      providerId,
      label: String(row?.label || providerId).trim() || providerId,
      apiKey: mappedApiKey,
      credentialSource:
        authConfig.explicitProviderId === providerId
          ? PROVIDER_CONNECTED_API_KEY_ENV
          : PROVIDER_CONNECTED_API_KEYS_ENV,
      apiKeyEnvVar: String(row?.apiKeyEnvVar || "").trim() || null,
    };
  }

  const envVar = String(row?.apiKeyEnvVar || "").trim();
  const envApiKey = envVar ? String(authConfig.env?.[envVar] || "").trim() : "";
  if (!envApiKey) {
    return null;
  }

  return {
    providerId,
    label: String(row?.label || providerId).trim() || providerId,
    apiKey: envApiKey,
    credentialSource: envVar,
    apiKeyEnvVar: envVar || null,
  };
}

function resolveProviderConnectedCandidates(snapshot, authConfig) {
  return getProviderSettingsRows(snapshot)
    .map((row) => resolveProviderConnectedCandidate(row, authConfig))
    .filter(Boolean);
}

function buildProviderConnectedCredentialError(snapshot, authConfig) {
  const rows = getProviderSettingsRows(snapshot);

  if (authConfig.explicitProviderId) {
    const row = findProviderRow(snapshot, authConfig.explicitProviderId);
    if (!row) {
      return new Error(
        `Provider-connected desktop automation could not find "${authConfig.explicitProviderId}" in Settings -> Providers. Available providers: ${rows
          .map((entry) => normalizeProviderId(entry?.providerId))
          .filter(Boolean)
          .join(", ")}`
      );
    }

    if (row.isLocalProvider) {
      return new Error(
        `Provider-connected desktop automation cannot target "${authConfig.explicitProviderId}" because it is a local-only provider.`
      );
    }

    if (!row.apiKeyEnabled) {
      return new Error(
        `Provider-connected desktop automation cannot target "${authConfig.explicitProviderId}" because it does not expose API-key auth in Settings -> Providers.`
      );
    }

    const providerEnvVar = String(row.apiKeyEnvVar || "").trim();
    const suggestedSources = [
      `${PROVIDER_CONNECTED_PROVIDER_ID_ENV}=${authConfig.explicitProviderId} + ${PROVIDER_CONNECTED_API_KEY_ENV}`,
      PROVIDER_CONNECTED_API_KEYS_ENV,
      providerEnvVar || null,
    ].filter(Boolean);

    return new Error(
      `No API key was available for provider "${authConfig.explicitProviderId}". Supply one through ${suggestedSources.join(
        ", "
      )}.`
    );
  }

  const providerHints = describeProviderCredentialInputs(rows);
  return new Error(
    `No provider API key was available for provider-connected desktop automation. Set ${PROVIDER_CONNECTED_API_KEYS_ENV} or one of the provider-specific env vars exposed by Settings -> Providers${
      providerHints ? ` (${providerHints})` : ""
    }. You can also pin a provider with ${PROVIDER_CONNECTED_PROVIDER_ID_ENV} plus ${PROVIDER_CONNECTED_API_KEY_ENV}.`
  );
}

async function waitForProviderRow(client, providerId, predicate, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs) || DEFAULT_PROVIDER_CONNECTED_WAIT_TIMEOUT_MS
  );
  const intervalMs = Math.max(100, Number(options.intervalMs) || 500);
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = options.initialSnapshot || null;

  if (lastSnapshot) {
    assertProvidersSnapshotReady(lastSnapshot, options.label || "Providers settings");
    const row = findProviderRow(lastSnapshot, providerId);
    if (row && predicate(row, lastSnapshot)) {
      return { snapshot: lastSnapshot, row };
    }
  }

  while (Date.now() < deadline) {
    const snapshot = await client.getProvidersSnapshot({
      ensureOpen: false,
      waitForLoaded: true,
      preflightRefresh: false,
    });
    assertProvidersSnapshotReady(snapshot, options.label || "Providers settings");
    const row = findProviderRow(snapshot, providerId);
    if (row && predicate(row, snapshot)) {
      return { snapshot, row };
    }
    lastSnapshot = snapshot;
    await sleep(intervalMs);
  }

  const lastRow = summarizeProviderRow(findProviderRow(lastSnapshot, providerId));
  throw new Error(
    `Timed out waiting for ${options.label || providerId}. Last provider row: ${JSON.stringify(lastRow)}`
  );
}

async function waitForProviderModelOption(client, providerId, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs) || DEFAULT_PROVIDER_CONNECTED_WAIT_TIMEOUT_MS
  );
  const intervalMs = Math.max(100, Number(options.intervalMs) || 750);
  const deadline = Date.now() + timeoutMs;
  let lastInventory = null;
  let refresh = true;

  while (Date.now() < deadline) {
    const inventory = await client.listModels({ refresh, preflightRefresh: false });
    const option = findProviderModelOption(inventory, providerId, options);
    if (option) {
      return { inventory, option };
    }
    lastInventory = inventory;
    refresh = false;
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for provider model ${providerId}. Available options: ${describeModelOptions(lastInventory)}`
  );
}

async function waitForProviderModelDeauthenticated(client, providerId, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs) || DEFAULT_PROVIDER_CONNECTED_WAIT_TIMEOUT_MS
  );
  const intervalMs = Math.max(100, Number(options.intervalMs) || 750);
  const deadline = Date.now() + timeoutMs;
  let lastInventory = null;
  let refresh = true;

  while (Date.now() < deadline) {
    const inventory = await client.listModels({ refresh, preflightRefresh: false });
    const authenticatedOption = findProviderModelOption(inventory, providerId, {
      authenticated: true,
      preferredSections: ["pi", "local"],
    });
    if (!authenticatedOption) {
      return inventory;
    }
    lastInventory = inventory;
    refresh = false;
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for provider ${providerId} to leave the authenticated model list. Available options: ${describeModelOptions(lastInventory)}`
  );
}

async function getChatSelectionSnapshot(client) {
  if (typeof client?.getChatSnapshot === "function") {
    return await client.getChatSnapshot();
  }

  if (typeof client?.listModels === "function") {
    const inventory = await client.listModels({ refresh: false, preflightRefresh: false });
    return {
      selectedModelId:
        typeof inventory?.selectedModelId === "string" ? inventory.selectedModelId : null,
      currentModelName:
        typeof inventory?.currentModelName === "string" ? inventory.currentModelName : null,
    };
  }

  return null;
}

async function waitForChatModelSelection(client, modelId, options = {}) {
  const expectedModelId = String(modelId || "").trim();
  if (!expectedModelId) {
    throw new Error("waitForChatModelSelection requires a model id.");
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30_000);
  const intervalMs = Math.max(100, Number(options.intervalMs) || 250);
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = options.initialSnapshot || null;

  if (String(lastSnapshot?.selectedModelId || "").trim() === expectedModelId) {
    return lastSnapshot;
  }

  while (Date.now() < deadline) {
    lastSnapshot = await getChatSelectionSnapshot(client);
    if (String(lastSnapshot?.selectedModelId || "").trim() === expectedModelId) {
      return lastSnapshot;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `${options.label || "Chat model selection"} did not settle on "${expectedModelId}". Last snapshot: ${JSON.stringify(
      {
        selectedModelId:
          typeof lastSnapshot?.selectedModelId === "string" ? lastSnapshot.selectedModelId : null,
        currentModelName:
          typeof lastSnapshot?.currentModelName === "string" ? lastSnapshot.currentModelName : null,
      }
    )}`
  );
}

async function ensureChatModelSelection(client, modelId, options = {}) {
  const expectedModelId = String(modelId || "").trim();
  if (!expectedModelId) {
    throw new Error("ensureChatModelSelection requires a model id.");
  }

  const ensureOptions = {
    selectedModelId: expectedModelId,
  };
  if (options.reset === true) {
    ensureOptions.reset = true;
  }

  const ensuredSnapshot = await client.ensureChatOpen(ensureOptions);
  const setModelSnapshot = await client.setModel(expectedModelId);
  return await waitForChatModelSelection(client, expectedModelId, {
    ...options,
    initialSnapshot: setModelSnapshot || ensuredSnapshot || null,
  });
}

export function caseList(caseName) {
  if (caseName === "all") {
    return CORE_CASES;
  }
  if (caseName === "extended") {
    return EXTENDED_CASES;
  }
  if (caseName === "soak") {
    return SOAK_CASES;
  }
  if (caseName === "stress" || caseName === DEFAULT_STRESS_CASE) {
    return STRESS_CASES;
  }
  if (caseName === CHATVIEW_STRESS_CASE) {
    return [CHATVIEW_STRESS_CASE];
  }
  if (caseName === SETUP_BASELINE_CASE) {
    return [SETUP_BASELINE_CASE];
  }
  if (caseName === MANAGED_BASELINE_CASE) {
    return [MANAGED_BASELINE_CASE];
  }
  if (caseName === PROVIDER_CONNECTED_BASELINE_CASE) {
    return [PROVIDER_CONNECTED_BASELINE_CASE];
  }
  return [caseName];
}

export function resolveBootstrapReload(options = {}) {
  if (options.reload === false) {
    return false;
  }
  return !caseList(options.caseName || "all").includes(DEFAULT_STRESS_CASE);
}

export function summarizeStatusForReport(status, client = null) {
  return {
    bridge: {
      baseUrl: client?.baseUrl || null,
      host: typeof status?.bridge?.host === "string" ? status.bridge.host : client?.record?.host || null,
      port: numberOrNull(status?.bridge?.port ?? client?.record?.port),
      discoveryFilePath:
        typeof status?.bridge?.discoveryFilePath === "string"
          ? status.bridge.discoveryFilePath
          : client?.record?.discoveryFilePath || null,
      startedAt:
        typeof status?.bridge?.startedAt === "string"
          ? status.bridge.startedAt
          : client?.record?.startedAt || null,
      reload: {
        scheduled: Boolean(status?.bridge?.reload?.scheduled),
        inFlight: Boolean(status?.bridge?.reload?.inFlight),
        requestedAt:
          typeof status?.bridge?.reload?.requestedAt === "string"
            ? status.bridge.reload.requestedAt
            : null,
      },
    },
    ui: {
      pluginStatusBarClass:
        typeof status?.ui?.pluginStatusBarClass === "string" ? status.ui.pluginStatusBarClass : null,
      pluginStatusBarItemCount: numberOrNull(status?.ui?.pluginStatusBarItemCount),
      embeddingsStatusBarItemCount: numberOrNull(status?.ui?.embeddingsStatusBarItemCount),
      embeddingsStatusBarTexts: Array.isArray(status?.ui?.embeddingsStatusBarTexts)
        ? status.ui.embeddingsStatusBarTexts.map((entry) => String(entry))
        : [],
    },
    chat: {
      selectedModelId:
        typeof status?.chat?.selectedModelId === "string" ? status.chat.selectedModelId : null,
      currentModelName:
        typeof status?.chat?.currentModelName === "string" ? status.chat.currentModelName : null,
    },
  };
}

export function assertHealthyStatus(status, label, client = null) {
  const summary = summarizeStatusForReport(status, client);
  if (!summary.bridge.startedAt) {
    throw new Error(`${label} bridge startedAt was missing.`);
  }
  assertEqual(summary.bridge.reload.scheduled, false, `${label} reload scheduled`);
  assertEqual(summary.bridge.reload.inFlight, false, `${label} reload in flight`);
  assertEqual(summary.ui.pluginStatusBarItemCount, 1, `${label} plugin status bar item count`);
  assertEqual(
    summary.ui.embeddingsStatusBarItemCount,
    1,
    `${label} embeddings status bar item count`
  );
  return summary;
}

export async function collectHealthyStatusSnapshot(client, label) {
  const status = await client.status();
  return assertHealthyStatus(status, label, client);
}

async function seedTextFixtures(client, fixtureDir, options = {}) {
  const loadFixtures =
    typeof options.loadFixtureBundle === "function" ? options.loadFixtureBundle : loadFixtureBundle;
  const bundle = await loadFixtures();
  const writes = [];
  for (const entry of bundle.textFiles || []) {
    writes.push(await client.writeVaultText(`${fixtureDir}/${entry.name}`, entry.content));
  }
  return {
    fixtureDir,
    files: writes.map((entry) => ({
      path: entry.path,
      absolutePath: entry.absolutePath,
      bytes: String(entry.content || "").length,
    })),
  };
}

async function loadModelInventory(client, options = {}) {
  const models = await client.listModels();
  const availableOptions = Array.isArray(models?.options) ? models.options : [];
  const ready = availableOptions.filter((option) => isReadyModelOption(option, options));
  const managedOption =
    availableOptions.find((option) => option && option.value === MANAGED_SYSTEMSCULPT_MODEL_ID) ||
    null;

  return {
    models,
    options: availableOptions,
    ready,
    managedOption,
  };
}

function pickWindowsLocalFallbackOption(options) {
  return (
    options.find((option) => option && option.value === WINDOWS_BASELINE_LOCAL_MODEL_ID) || {
      value: WINDOWS_BASELINE_LOCAL_MODEL_ID,
      label: WINDOWS_BASELINE_LOCAL_MODEL_LABEL,
      providerAuthenticated: false,
      providerId: "local-pi-openai",
      providerLabel: "OpenAI",
      section: "pi",
    }
  );
}

async function pickReadyModels(client, options = {}) {
  const inventory = await loadModelInventory(client, options);
  const { models, options: availableOptions, ready } = inventory;
  const minimumReady = Math.max(1, Number(options.minimumReady) || 2);

  if (ready.length < minimumReady) {
    throw new Error(
      `Desktop automation needs at least ${minimumReady} authenticated chat model${
        minimumReady === 1 ? "" : "s"
      }, but only found ${ready.length}.`
    );
  }

  const preferredFirst = ready.find((option) => option.value === models.selectedModelId) || ready[0];
  const preferredSecond =
    ready.length < 2
      ? null
      : ready.find(
          (option) =>
            option.value !== preferredFirst.value &&
            (option.providerId !== preferredFirst.providerId || option.section !== preferredFirst.section)
        ) || ready.find((option) => option.value !== preferredFirst.value);

  if (minimumReady >= 2 && !preferredSecond) {
    throw new Error("Desktop automation could not find a second distinct authenticated chat model.");
  }

  const candidates = [];
  const seen = new Set();
  const appendCandidate = (option) => {
    if (!option || seen.has(option.value)) {
      return;
    }
    seen.add(option.value);
    candidates.push(option);
  };

  appendCandidate(preferredFirst);
  if (preferredSecond) {
    appendCandidate(preferredSecond);
  }
  ready.forEach(appendCandidate);

  return {
    ...inventory,
    all: availableOptions,
    ready,
    candidates,
    selected: preferredSecond ? [preferredFirst, preferredSecond] : [preferredFirst],
    fallbackLocalOption: pickWindowsLocalFallbackOption(availableOptions),
  };
}

async function runSingleModelSwitchFallbackCase(client, models) {
  const primaryModel = models.selected[0];
  const fallbackModel = models.fallbackLocalOption;

  if (!primaryModel) {
    throw new Error("Desktop automation could not find an authenticated primary model.");
  }
  if (!fallbackModel) {
    throw new Error(
      "Desktop automation only found one authenticated model and could not find the Windows local-Pi fallback option."
    );
  }

  const firstTurn = await runManagedExactTurn(client, primaryModel, "DESKTOP_SINGLE_MODEL_SWITCH");

  await ensureChatModelSelection(client, fallbackModel.value, {
    reset: true,
    label: "Single-model fallback selection",
  });
  const blockedFallback = await expectChatSendFailure(
    client,
    {
      text: "Reply with OK.",
      includeContextFiles: false,
      webSearchEnabled: false,
      approvalMode: "interactive",
    },
    {
      label: "Single-model fallback send",
      expectedTarget: "providers",
    }
  );

  const recoveryTurn = await runManagedExactTurn(client, primaryModel, "DESKTOP_SINGLE_MODEL_RECOVERY");

  return {
    readyModelCount: models.ready.length,
    availableModelCount: models.all.length,
    candidateModelCount: models.candidates.length,
    switches: [
      {
        modelId: primaryModel.value,
        label: primaryModel.label,
        providerLabel: primaryModel.providerLabel,
        section: primaryModel.section,
        response: firstTurn.response,
        token: firstTurn.token,
      },
      {
        modelId: fallbackModel.value,
        label: fallbackModel.label,
        providerLabel: fallbackModel.providerLabel,
        section: fallbackModel.section,
        blocked: true,
        error: blockedFallback,
      },
      {
        modelId: primaryModel.value,
        label: primaryModel.label,
        providerLabel: primaryModel.providerLabel,
        section: primaryModel.section,
        response: recoveryTurn.response,
        token: recoveryTurn.token,
        recovery: true,
      },
    ],
    singleModelFallback: {
      primaryModel: buildModelSummary(primaryModel),
      fallbackModel: buildModelSummary(fallbackModel),
      blockedError: blockedFallback,
      recoveryTurn,
    },
    transientSkips: [],
  };
}

function buildModelSummary(option) {
  return option
    ? {
        modelId: option.value,
        label: option.label,
        providerLabel: option.providerLabel,
        section: option.section,
        providerAuthenticated: Boolean(option.providerAuthenticated),
      }
    : null;
}

function assertSetupGuidance(message, label, expectedTarget) {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error(`${label} did not return actionable setup guidance.`);
  }

  const target = String(expectedTarget || "").trim().toLowerCase();
  const mentionsTarget = target ? normalized.includes(target) : true;
  const mentionsSettings = normalized.includes("settings");
  const mentionsSetup = normalized.includes("setup") || normalized.includes("unavailable");
  const mentionsAction = ["activate", "connect", "reconnect", "finish", "open"].some((needle) =>
    normalized.includes(needle)
  );
  if (!mentionsTarget || (!mentionsSettings && !mentionsSetup && !mentionsAction)) {
    throw new Error(
      `${label} did not contain actionable ${expectedTarget} guidance. Actual value: ${message}`
    );
  }
}

async function expectChatSendFailure(client, body, options = {}) {
  try {
    await client.sendChat(body);
  } catch (error) {
    const message = errorMessage(error);
    if (options.expectedTarget) {
      assertSetupGuidance(message, options.label || "Chat send", options.expectedTarget);
    }
    return message;
  }

  throw new Error(`${options.label || "Chat send"} unexpectedly succeeded.`);
}

async function runManagedExactTurn(client, model, tokenPrefix) {
  const token = `${tokenPrefix}_${Date.now()}`;
  const transientRetries = [];
  const snapshot = await retryTransientOperation(
    async () => {
      const preSendSnapshot = await ensureChatModelSelection(client, model.value, {
        reset: true,
        label: `${model.label} selection before send`,
      });
      try {
        return await client.sendChat({
          text: `Reply with this exact token and nothing else: ${token}`,
          includeContextFiles: false,
          webSearchEnabled: false,
          approvalMode: "interactive",
        });
      } catch (error) {
        const failedSnapshot = await getChatSelectionSnapshot(client).catch(() => null);
        throw new Error(
          `${model.label} send failed for "${model.value}". ` +
            `Pre-send snapshot: ${JSON.stringify({
              selectedModelId:
                typeof preSendSnapshot?.selectedModelId === "string"
                  ? preSendSnapshot.selectedModelId
                  : null,
              currentModelName:
                typeof preSendSnapshot?.currentModelName === "string"
                  ? preSendSnapshot.currentModelName
                  : null,
            })}. ` +
            `Failure snapshot: ${JSON.stringify({
              selectedModelId:
                typeof failedSnapshot?.selectedModelId === "string"
                  ? failedSnapshot.selectedModelId
                  : null,
              currentModelName:
                typeof failedSnapshot?.currentModelName === "string"
                  ? failedSnapshot.currentModelName
                  : null,
            })}. ` +
            `Upstream error: ${errorMessage(error)}`
        );
      }
    },
    {
      attempts: DEFAULT_TRANSIENT_SEND_ATTEMPTS,
      pauseMs: DEFAULT_TRANSIENT_SEND_PAUSE_MS,
      onTransientError: (error, attempt) => {
        transientRetries.push({
          attempt,
          modelId: model.value,
          label: model.label,
          error: errorMessage(error),
        });
      },
    }
  );
  const assistant = getLastAssistantMessage(snapshot);
  const assistantText = toMessageText(assistant?.content).trim();

  assertEqual(snapshot.selectedModelId, model.value, `${model.label} selected model after send`);
  assertIncludes(assistantText, token, `${model.label} hosted reply`);

  return {
    token,
    response: assistantText,
    model: buildModelSummary(model),
    transientRetries,
    selectedModelId: snapshot.selectedModelId,
    currentModelName: snapshot.currentModelName || null,
  };
}

async function captureManagedTurnOutcome(client, model, tokenPrefix, phase) {
  try {
    return {
      turn: await runManagedExactTurn(client, model, tokenPrefix),
      failure: null,
    };
  } catch (error) {
    if (!isTransientModelExecutionError(error)) {
      throw error;
    }
    return {
      turn: null,
      failure: {
        phase,
        modelId: model.value,
        label: model.label,
        error: errorMessage(error),
      },
    };
  }
}

function buildProviderTurnTokenPrefix(providerId) {
  const suffix = normalizeProviderId(providerId).replace(/[^a-z0-9]+/g, "_").toUpperCase() || "PROVIDER";
  return `PROVIDER_CONNECTED_${suffix}`;
}

function isDisconnectedProviderRow(row) {
  return !Boolean(row?.hasAnyAuth) && !Boolean(row?.hasStoredCredential) && !Boolean(row?.display?.ready);
}

function isConnectedApiKeyProviderRow(row) {
  return (
    String(row?.source || "").trim() === "api_key" &&
    Boolean(row?.hasAnyAuth) &&
    Boolean(row?.hasStoredCredential) &&
    Boolean(row?.display?.ready)
  );
}

async function clearProviderAuthAndWait(client, candidate, options = {}) {
  const initialSnapshot = await client.clearProviderAuth(candidate.providerId);
  const waitResult = await waitForProviderRow(
    client,
    candidate.providerId,
    (row) => isDisconnectedProviderRow(row),
    {
      initialSnapshot,
      timeoutMs: options.timeoutMs,
      label: `${candidate.label} disconnected state`,
    }
  );
  await waitForProviderModelDeauthenticated(client, candidate.providerId, {
    timeoutMs: options.timeoutMs,
  });
  return waitResult;
}

async function connectProviderApiKeyAndWait(client, candidate, options = {}) {
  const initialSnapshot = await client.setProviderApiKey(candidate.providerId, candidate.apiKey);
  const waitResult = await waitForProviderRow(
    client,
    candidate.providerId,
    (row) => isConnectedApiKeyProviderRow(row),
    {
      initialSnapshot,
      timeoutMs: options.timeoutMs,
      label: `${candidate.label} connected via API key`,
    }
  );
  const { option } = await waitForProviderModelOption(client, candidate.providerId, {
    authenticated: true,
    preferredSections: ["pi", "local"],
    preferredModelIds: resolveProviderConnectedModelPreferences(
      candidate.providerId,
      options.authConfig
    ),
    timeoutMs: options.timeoutMs,
  });
  return {
    snapshot: waitResult.snapshot,
    row: waitResult.row,
    model: option,
  };
}

async function runProviderConnectedCandidateCase(client, managedOption, candidate, options = {}) {
  const preClear = await clearProviderAuthAndWait(client, candidate, options);
  const connected = await connectProviderApiKeyAndWait(client, candidate, options);

  const providerTurn = await runManagedExactTurn(
    client,
    connected.model,
    buildProviderTurnTokenPrefix(candidate.providerId)
  );

  const postClear = await clearProviderAuthAndWait(client, candidate, options);
  const deauthenticatedInventory = await client.listModels({ refresh: true, preflightRefresh: false });
  const blockedProviderModel =
    findProviderModelOption(deauthenticatedInventory, candidate.providerId, {
      authenticated: false,
      modelId: connected.model.value,
      preferredSections: ["pi", "local"],
    }) ||
    findProviderModelOption(deauthenticatedInventory, candidate.providerId, {
      authenticated: false,
      preferredSections: ["pi", "local"],
    });

  const blockedModelId = String(
    blockedProviderModel?.value || connected.model.value || providerTurn.selectedModelId || ""
  ).trim();
  await ensureChatModelSelection(client, blockedModelId, {
    reset: true,
    label: `${candidate.label} blocked provider model selection`,
  });
  const blockedProviderSend = await expectChatSendFailure(
    client,
    {
      text: "Reply with OK.",
      includeContextFiles: false,
      webSearchEnabled: false,
      approvalMode: "interactive",
    },
    {
      label: `${candidate.label} send after auth clear`,
      expectedTarget: "providers",
    }
  );

  const recoverySelection = await ensureChatModelSelection(client, managedOption.value, {
    reset: true,
    label: `${candidate.label} managed recovery selection`,
  });

  return {
    managedModel: buildModelSummary(managedOption),
    providerModel: buildModelSummary(connected.model),
    provider: {
      providerId: candidate.providerId,
      label: candidate.label,
      credentialSource: candidate.credentialSource,
      apiKeyEnvVar: candidate.apiKeyEnvVar,
    },
    providerTurn,
    blockedProviderSend: {
      modelId: blockedModelId,
      matchedProviderTurnModelId: blockedModelId === connected.model.value,
      error: blockedProviderSend,
    },
    recoverySelection: {
      model: buildModelSummary(managedOption),
      selectedModelId:
        typeof recoverySelection?.selectedModelId === "string"
          ? recoverySelection.selectedModelId
          : managedOption.value,
      currentModelName:
        typeof recoverySelection?.currentModelName === "string"
          ? recoverySelection.currentModelName
          : null,
    },
    providerStates: {
      beforeConnect: summarizeProviderRow(preClear.row),
      connected: summarizeProviderRow(connected.row),
      afterClear: summarizeProviderRow(postClear.row),
    },
  };
}

function buildDistinctModelPairs(models) {
  const pairs = [];
  const seen = new Set();
  const appendPair = (primary, secondary) => {
    if (!primary || !secondary || primary.value === secondary.value) {
      return;
    }
    const key = `${primary.value}::${secondary.value}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    pairs.push([primary, secondary]);
  };

  appendPair(models.selected[0], models.selected[1]);
  for (const primary of models.candidates) {
    for (const secondary of models.candidates) {
      appendPair(primary, secondary);
    }
  }

  return pairs;
}

export async function runSetupBaselineCase(client) {
  const inventory = await loadModelInventory(client);
  const managedOption = inventory.managedOption;
  if (!managedOption) {
    throw new Error("Desktop automation could not find the managed SystemSculpt model.");
  }

  const managedSnapshot = await client.ensureChatOpen({
    reset: true,
    selectedModelId: managedOption.value,
  });
  assertEqual(
    managedSnapshot?.selectedModelId,
    managedOption.value,
    "Managed model selected during setup baseline"
  );

  const accountError = await expectChatSendFailure(
    client,
    {
      text: "Reply with OK.",
      includeContextFiles: false,
      webSearchEnabled: false,
      approvalMode: "interactive",
    },
    {
      label: "Managed setup baseline send",
      expectedTarget: "account",
    }
  );

  await client.ensureChatOpen({
    reset: true,
    selectedModelId: WINDOWS_BASELINE_LOCAL_MODEL_ID,
  });
  const providersError = await expectChatSendFailure(
    client,
    {
      text: "Reply with OK.",
      includeContextFiles: false,
      webSearchEnabled: false,
      approvalMode: "interactive",
    },
    {
      label: "Local Pi setup baseline send",
      expectedTarget: "providers",
    }
  );

  return {
    availableModelCount: inventory.options.length,
    readyModelCount: inventory.ready.length,
    managedModel: buildModelSummary(managedOption),
    setupRequired: {
      account: accountError,
      providers: providersError,
    },
  };
}

export async function runManagedBaselineCase(client) {
  const inventory = await loadModelInventory(client);
  const managedOption = inventory.managedOption;
  if (!managedOption) {
    throw new Error("Desktop automation could not find the managed SystemSculpt model.");
  }
  if (!managedOption.providerAuthenticated) {
    throw new Error(
      "Managed SystemSculpt model is present but not authenticated. Seed hosted auth or complete Account setup first."
    );
  }
  if (inventory.ready.length < 1) {
    throw new Error("Desktop automation expected at least one authenticated chat model.");
  }

  const hostedOutcome = await captureManagedTurnOutcome(
    client,
    managedOption,
    "WINDOWS_MANAGED_BASELINE",
    "hosted"
  );

  await client.ensureChatOpen({
    reset: true,
    selectedModelId: WINDOWS_BASELINE_LOCAL_MODEL_ID,
  });
  const blockedLocalPi = await expectChatSendFailure(
    client,
    {
      text: "Reply with OK.",
      includeContextFiles: false,
      webSearchEnabled: false,
      approvalMode: "interactive",
    },
    {
      label: "Local Pi unavailable baseline send",
      expectedTarget: "providers",
    }
  );

  const recoveryOutcome = await captureManagedTurnOutcome(
    client,
    managedOption,
    "WINDOWS_MANAGED_RECOVERY",
    "recovery"
  );
  const transientFailures = [hostedOutcome.failure, recoveryOutcome.failure].filter(Boolean);
  if (!hostedOutcome.turn && !recoveryOutcome.turn) {
    throw new Error(
      `Managed baseline could not complete a hosted turn after transient upstream failures. ${transientFailures
        .map((entry) => `${entry.phase}: ${entry.error}`)
        .join(" | ")}`
    );
  }

  return {
    availableModelCount: inventory.options.length,
    readyModelCount: inventory.ready.length,
    managedModel: buildModelSummary(managedOption),
    hostedTurn: hostedOutcome.turn,
    blockedLocalPi: {
      modelId: WINDOWS_BASELINE_LOCAL_MODEL_ID,
      error: blockedLocalPi,
    },
    recoveryTurn: recoveryOutcome.turn,
    transientFailures,
  };
}

export async function runProviderConnectedBaselineCase(client, options = {}) {
  const authConfig = resolveProviderConnectedAuthConfig(options.env || process.env);
  const inventory = await loadModelInventory(client);
  const managedOption = inventory.managedOption;
  if (!managedOption) {
    throw new Error("Desktop automation could not find the managed SystemSculpt model.");
  }
  if (!managedOption.providerAuthenticated) {
    throw new Error(
      "Managed SystemSculpt model is present but not authenticated. Seed hosted auth or complete Account setup first."
    );
  }

  const providerSnapshot = await client.getProvidersSnapshot({
    ensureOpen: true,
    waitForLoaded: true,
  });
  assertProvidersSnapshotReady(providerSnapshot, "Provider-connected baseline");
  const candidates = resolveProviderConnectedCandidates(providerSnapshot, authConfig);
  if (candidates.length < 1) {
    throw buildProviderConnectedCredentialError(providerSnapshot, authConfig);
  }

  const candidateFailures = [];
  for (const candidate of candidates) {
    try {
      const result = await runProviderConnectedCandidateCase(
        client,
        managedOption,
        candidate,
        {
          ...options,
          authConfig,
        }
      );
      return {
        availableModelCount: inventory.options.length,
        readyModelCount: inventory.ready.length,
        candidateCount: candidates.length,
        attemptedCandidateIds: [...candidateFailures.map((entry) => entry.providerId), candidate.providerId],
        ...result,
      };
    } catch (error) {
      const failure = {
        providerId: candidate.providerId,
        label: candidate.label,
        credentialSource: candidate.credentialSource,
        error: errorMessage(error),
      };
      candidateFailures.push(failure);
      if (authConfig.explicitProviderId || candidates.length === 1) {
        throw new Error(
          `Provider-connected desktop automation failed for ${candidate.label}. ${failure.error}`
        );
      }
    }
  }

  throw new Error(
    `Provider-connected desktop automation could not authenticate any provider candidate. ${candidateFailures
      .map((entry) => `${entry.label} (${entry.credentialSource}): ${entry.error}`)
      .join(" | ")}`
  );
}

export async function runModelSwitchCase(client, options = {}) {
  const models = await pickReadyModels(client, {
    minimumReady: 1,
    allowLocalPi: options.allowLocalPi,
  });
  if (models.ready.length < 2) {
    if (options.allowSingleModelFallback) {
      const transientSkips = [];
      return await retryTransientOperation(
        async () => {
          const result = await runSingleModelSwitchFallbackCase(client, models);
          return {
            ...result,
            transientSkips,
          };
        },
        {
          attempts: 3,
          pauseMs: 1500,
          onTransientError: (error, attempt) => {
            transientSkips.push({
              attempt,
              primaryModelId: models.selected[0]?.value || null,
              primaryLabel: models.selected[0]?.label || null,
              error: errorMessage(error),
            });
          },
        }
      );
    }
    throw new Error(
      `Desktop automation needs at least two authenticated chat models, but only found ${models.ready.length}.`
    );
  }

  const switches = [];
  const transientSkips = [];

  for (const model of models.candidates) {
    if (switches.length >= 2) {
      break;
    }

    const index = switches.length;
    const token = `DESKTOP_MODEL_SWITCH_${index + 1}_${Date.now()}`;
    try {
      await ensureChatModelSelection(client, model.value, {
        reset: true,
        label: `${model.label} model-switch selection`,
      });
      const snapshot = await client.sendChat({
        text: `Reply with this exact token and nothing else: ${token}`,
        includeContextFiles: false,
        webSearchEnabled: false,
        approvalMode: "interactive",
      });
      const assistant = getLastAssistantMessage(snapshot);
      const assistantText = toMessageText(assistant?.content).trim();

      assertEqual(snapshot.selectedModelId, model.value, "Selected model after switch");
      assertIncludes(assistantText, token, `Response from ${model.label}`);

      switches.push({
        modelId: model.value,
        label: model.label,
        providerLabel: model.providerLabel,
        section: model.section,
        response: assistantText,
        token,
      });
    } catch (error) {
      if (!isTransientModelExecutionError(error)) {
        throw error;
      }

      transientSkips.push({
        modelId: model.value,
        label: model.label,
        providerLabel: model.providerLabel,
        section: model.section,
        error: errorMessage(error),
      });
    }
  }

  if (switches.length < 2) {
    throw new Error(
      `Desktop automation only completed ${switches.length}/2 model switches. Transient skips: ${transientSkips
        .map((entry) => `${entry.label}: ${entry.error}`)
        .join(" | ")}`
    );
  }

  return {
    readyModelCount: models.ready.length,
    availableModelCount: models.all.length,
    candidateModelCount: models.candidates.length,
    transientSkips,
    switches,
  };
}

export async function runChatExactCase(client, options = {}) {
  const models = await pickReadyModels(client, {
    minimumReady: 1,
    allowLocalPi: options.allowLocalPi,
  });
  const transientSkips = [];

  for (const model of models.candidates) {
    const token = `DESKTOP_CHAT_EXACT_${Date.now()}`;

    try {
      await ensureChatModelSelection(client, model.value, {
        reset: true,
        label: `${model.label} chat-exact selection`,
      });

      await client.setWebSearch(true);
      await client.setApprovalMode("deny");
      const enabledSnapshot = await client.getChatSnapshot();
      assertEqual(Boolean(enabledSnapshot?.input?.webSearchEnabled), true, "Web search enabled snapshot");
      assertEqual(enabledSnapshot?.input?.approvalMode, "deny", "Approval mode when deny is set");

      await client.setWebSearch(false);
      await client.setApprovalMode("interactive");
      const disabledSnapshot = await client.getChatSnapshot();
      assertEqual(Boolean(disabledSnapshot?.input?.webSearchEnabled), false, "Web search disabled snapshot");
      assertEqual(
        disabledSnapshot?.input?.approvalMode,
        "interactive",
        "Approval mode when reset to interactive"
      );

      await client.setInput(`Reply with exactly ${token}`);
      const finalSnapshot = await client.sendChat({
        includeContextFiles: false,
      });
      const assistant = getLastAssistantMessage(finalSnapshot);
      const assistantText = toMessageText(assistant?.content).trim();
      assertIncludes(assistantText, token, "Chat exact reply");

      return {
        selectedModelId: finalSnapshot.selectedModelId,
        currentModelName: finalSnapshot.currentModelName,
        candidateModelCount: models.candidates.length,
        transientSkips,
        token,
        response: assistantText,
      };
    } catch (error) {
      if (!isTransientModelExecutionError(error)) {
        throw error;
      }

      transientSkips.push({
        modelId: model.value,
        label: model.label,
        providerLabel: model.providerLabel,
        section: model.section,
        error: errorMessage(error),
      });
    }
  }

  throw new Error(
    `Desktop automation could not complete the chat-exact case with any authenticated model. Transient skips: ${transientSkips
      .map((entry) => `${entry.label}: ${entry.error}`)
      .join(" | ")}`
  );
}

async function runFileReadCase(client, fixtureDir) {
  const alpha = await client.readVaultText(`${fixtureDir}/alpha.md`);
  const beta = await client.readVaultText(`${fixtureDir}/beta.md`);

  assertIncludes(alpha.content, "ALPHA_20260311-194643", "alpha.md");
  assertIncludes(beta.content, "BETA_20260311-194643", "beta.md");

  return {
    alphaPath: alpha.path,
    betaPath: beta.path,
    alphaPreview: String(alpha.content || "").trim().slice(0, 200),
    betaPreview: String(beta.content || "").trim().slice(0, 200),
  };
}

async function runFileWriteCase(client, fixtureDir) {
  const outputPath = `${fixtureDir}/desktop-automation-output-${Date.now()}.md`;
  const content = [
    "ALPHA=ALPHA_20260311-194643",
    "BETA=BETA_20260311-194643",
    "SHARED=GAMMA_20260311-194643",
  ].join("\n");

  await client.writeVaultText(outputPath, content);
  const written = await client.readVaultText(outputPath);
  assertEqual(String(written.content || ""), content, "Written vault content");

  return {
    outputPath,
    outputPreview: String(written.content || "").trim(),
  };
}

async function runWebFetchCase(client, requestedUrl) {
  const result = await client.fetchWeb({
    url: requestedUrl,
    chatId: `desktop-automation-web-${Date.now()}`,
  });
  const markdown = String(result?.fetch?.markdown || "");

  if (markdown.trim().length < 80) {
    throw new Error("web-fetch returned too little markdown content.");
  }
  if (!result?.persisted?.indexPath || !result?.persisted?.filePath) {
    throw new Error("web-fetch did not persist its corpus artifacts.");
  }

  const index = await client.readVaultText(result.persisted.indexPath);
  const fetched = await client.readVaultText(result.persisted.filePath);

  return {
    requestedUrl,
    finalUrl: result?.fetch?.finalUrl || result?.fetch?.url || requestedUrl,
    title: result?.fetch?.title || null,
    markdownPreview: markdown.slice(0, 240),
    indexPath: index.path,
    fetchedPath: fetched.path,
  };
}

async function runYouTubeTranscriptCase(client, requestedUrl) {
  const result = await client.getYouTubeTranscript({ url: requestedUrl });
  const text = String(result?.transcript?.text || "");
  if (text.length < 1000) {
    throw new Error(`YouTube transcript was unexpectedly short (${text.length} chars).`);
  }
  return {
    requestedUrl,
    lang: result?.transcript?.lang || null,
    excerpt: text.slice(0, 240),
    textLength: text.length,
  };
}

export async function runReloadStressCase(client, options = {}) {
  const before = await collectHealthyStatusSnapshot(client, "Before reload");
  const previousStartedAt =
    String(before.bridge.startedAt || client?.record?.startedAt || "").trim() || null;

  const reloadResponse = await client.reloadPlugin();
  const waitForStableClient =
    typeof options.waitForStableClient === "function"
      ? options.waitForStableClient
      : waitForStableDesktopAutomationClient;
  const nextClient = await waitForStableClient({
    vaultName: options.vaultName,
    vaultPath: options.vaultPath,
    pluginId: options.pluginId,
    timeoutMs: options.reloadTimeoutMs || DEFAULT_RELOAD_TIMEOUT_MS,
    intervalMs: options.reloadIntervalMs || 500,
    settleIntervalMs: options.reloadSettleIntervalMs || DEFAULT_RELOAD_SETTLE_INTERVAL_MS,
    stableForMs: options.reloadStableForMs || DEFAULT_RELOAD_STABLE_FOR_MS,
    excludeStartedAt: previousStartedAt || undefined,
  });

  const afterReload = await collectHealthyStatusSnapshot(nextClient, "After reload");
  if (previousStartedAt && afterReload.bridge.startedAt === previousStartedAt) {
    throw new Error(
      `Reload stress expected a new bridge generation after reload, but bridge startedAt stayed "${previousStartedAt}".`
    );
  }

  const runModelSwitch =
    typeof options.runModelSwitchCase === "function" ? options.runModelSwitchCase : runModelSwitchCase;
  const runChatExact =
    typeof options.runChatExactCase === "function" ? options.runChatExactCase : runChatExactCase;

  const modelSwitch = await runModelSwitch(nextClient, options);
  const afterModelSwitch = await collectHealthyStatusSnapshot(nextClient, "After model switch");

  const chatExact = await runChatExact(nextClient, options);
  const afterChatExact = await collectHealthyStatusSnapshot(nextClient, "After chat exact");

  return {
    client: nextClient,
    result: {
      reload: {
        requestedAt: typeof reloadResponse?.requestedAt === "string" ? reloadResponse.requestedAt : null,
        scheduled: Boolean(reloadResponse?.scheduled),
        alreadyScheduled: Boolean(reloadResponse?.alreadyScheduled),
        previousStartedAt,
        nextStartedAt: afterReload.bridge.startedAt,
        previousBaseUrl: before.bridge.baseUrl,
        nextBaseUrl: afterReload.bridge.baseUrl,
        previousDiscoveryFilePath: before.bridge.discoveryFilePath,
        nextDiscoveryFilePath: afterReload.bridge.discoveryFilePath,
      },
      health: {
        before,
        afterReload,
        afterModelSwitch,
        afterChatExact,
      },
      modelSwitch,
      chatExact,
    },
  };
}

async function sendTokenTurn(client, token, options = {}) {
  const expectedInput = `Reply with this exact token and nothing else: ${token}`;
  await client.setInput(expectedInput);
  const inputSnapshot = await client.getChatSnapshot();
  assertEqual(String(inputSnapshot?.input?.value || ""), expectedInput, "Chat input before send");
  return await client.sendChat({
    includeContextFiles: false,
    approvalMode: options.approvalMode,
    webSearchEnabled: options.webSearchEnabled,
  });
}

async function runDualModelChatViewStressCase(client, primaryModel, secondaryModel) {
  const initialSnapshot = await client.ensureChatOpen({
    reset: true,
    selectedModelId: primaryModel.value,
  });
  const initialLeafId = initialSnapshot?.leafId;
  assertTruthy(initialLeafId, "Fresh chat leafId");
  assertEqual(initialSnapshot?.messageCount, 0, "Fresh chat message count");
  assertEqual(initialSnapshot?.selectedModelId, primaryModel.value, "Fresh chat selected model");
  assertEqual(
    Boolean(initialSnapshot?.input?.webSearchEnabled),
    false,
    "Fresh chat web search state"
  );
  assertEqual(initialSnapshot?.input?.approvalMode, "interactive", "Fresh chat approval mode");

  await client.setWebSearch(true);
  await client.setApprovalMode("deny");
  const toggledSnapshot = await client.getChatSnapshot();
  assertEqual(toggledSnapshot?.leafId, initialLeafId, "Leaf id after toggle setup");
  assertEqual(Boolean(toggledSnapshot?.input?.webSearchEnabled), true, "Web search after toggle");
  assertEqual(toggledSnapshot?.input?.approvalMode, "deny", "Approval mode after toggle");

  const firstToken = `DESKTOP_CHATVIEW_STRESS_A_${Date.now()}`;
  const firstSnapshot = await sendTokenTurn(client, firstToken, {
    approvalMode: "auto-approve",
    webSearchEnabled: true,
  });
  const firstAssistant = getLastAssistantMessage(firstSnapshot);
  const firstAssistantText = toMessageText(firstAssistant?.content).trim();
  assertIncludes(firstAssistantText, firstToken, `ChatView stress reply from ${primaryModel.label}`);
  assertEqual(firstSnapshot?.leafId, initialLeafId, "Leaf id after first send");
  assertEqual(firstSnapshot?.selectedModelId, primaryModel.value, "Selected model after first send");
  assertEqual(
    Boolean(firstSnapshot?.input?.webSearchEnabled),
    true,
    "Web search after first send"
  );
  assertEqual(
    firstSnapshot?.input?.approvalMode,
    "deny",
    "Approval mode restored after first send"
  );

  const firstChatId = String(firstSnapshot?.chatId || "").trim();
  assertTruthy(firstChatId, "First chat id");
  const firstMessageCount = Number(firstSnapshot?.messageCount || 0);
  assertGreaterThan(firstMessageCount, 1, "First chat message count");

  const resumedSnapshot = await client.ensureChatOpen({});
  assertEqual(resumedSnapshot?.leafId, initialLeafId, "Leaf id on resume");
  assertEqual(String(resumedSnapshot?.chatId || "").trim(), firstChatId, "Resumed chat id");
  assertEqual(resumedSnapshot?.messageCount, firstMessageCount, "Resumed chat message count");

  await ensureChatModelSelection(client, secondaryModel.value, {
    reset: false,
    label: `${secondaryModel.label} chatview stress switch`,
  });
  await client.setWebSearch(false);
  await client.setApprovalMode("interactive");
  const switchedSnapshot = await client.getChatSnapshot();
  assertEqual(switchedSnapshot?.leafId, initialLeafId, "Leaf id after model switch");
  assertEqual(
    switchedSnapshot?.selectedModelId,
    secondaryModel.value,
    "Selected model after switch"
  );
  assertEqual(
    Boolean(switchedSnapshot?.input?.webSearchEnabled),
    false,
    "Web search after disabling"
  );
  assertEqual(
    switchedSnapshot?.input?.approvalMode,
    "interactive",
    "Approval mode after resetting"
  );
  assertEqual(String(switchedSnapshot?.chatId || "").trim(), firstChatId, "Chat id after switch");

  const secondToken = `DESKTOP_CHATVIEW_STRESS_B_${Date.now()}`;
  const secondSnapshot = await sendTokenTurn(client, secondToken);
  const secondAssistant = getLastAssistantMessage(secondSnapshot);
  const secondAssistantText = toMessageText(secondAssistant?.content).trim();
  assertIncludes(secondAssistantText, secondToken, `ChatView stress reply from ${secondaryModel.label}`);
  assertEqual(secondSnapshot?.leafId, initialLeafId, "Leaf id after second send");
  assertEqual(String(secondSnapshot?.chatId || "").trim(), firstChatId, "Second turn chat id");
  assertEqual(
    secondSnapshot?.selectedModelId,
    secondaryModel.value,
    "Selected model after second send"
  );
  const secondMessageCount = Number(secondSnapshot?.messageCount || 0);
  assertGreaterThan(secondMessageCount, 1, "Second chat message count");
  const transcriptPreservedAcrossModelSwitch = secondMessageCount > firstMessageCount;

  const resetSnapshot = await client.ensureChatOpen({
    reset: true,
    selectedModelId: primaryModel.value,
  });
  assertEqual(resetSnapshot?.leafId, initialLeafId, "Leaf id after reset");
  assertEqual(resetSnapshot?.messageCount, 0, "Reset chat message count");
  assertEqual(resetSnapshot?.selectedModelId, primaryModel.value, "Selected model after reset");
  assertEqual(String(resetSnapshot?.chatId || "").trim(), "", "Reset chat id");

  const thirdToken = `DESKTOP_CHATVIEW_STRESS_C_${Date.now()}`;
  const freshSnapshot = await sendTokenTurn(client, thirdToken, {
    approvalMode: "interactive",
    webSearchEnabled: false,
  });
  const thirdAssistant = getLastAssistantMessage(freshSnapshot);
  const thirdAssistantText = toMessageText(thirdAssistant?.content).trim();
  assertIncludes(thirdAssistantText, thirdToken, `Fresh chat reply from ${primaryModel.label}`);

  const freshChatId = String(freshSnapshot?.chatId || "").trim();
  assertTruthy(freshChatId, "Fresh chat id");
  assertEqual(freshSnapshot?.leafId, initialLeafId, "Leaf id after fresh chat send");
  assertEqual(freshSnapshot?.selectedModelId, primaryModel.value, "Fresh chat selected model");
  assertEqual(
    Boolean(freshSnapshot?.input?.webSearchEnabled),
    false,
    "Fresh chat web search state"
  );
  assertEqual(
    freshSnapshot?.input?.approvalMode,
    "interactive",
    "Fresh chat approval mode"
  );

  return {
    leafId: initialLeafId,
    firstChatId,
    freshChatId,
    primaryModel: {
      modelId: primaryModel.value,
      label: primaryModel.label,
      providerLabel: primaryModel.providerLabel,
      section: primaryModel.section,
    },
    secondaryModel: {
      modelId: secondaryModel.value,
      label: secondaryModel.label,
      providerLabel: secondaryModel.providerLabel,
      section: secondaryModel.section,
    },
    tokens: {
      first: firstToken,
      second: secondToken,
      fresh: thirdToken,
    },
    transcriptPreservedAcrossModelSwitch,
    messageCounts: {
      first: firstMessageCount,
      second: secondMessageCount,
      fresh: Number(freshSnapshot?.messageCount || 0),
    },
  };
}

async function runSingleModelChatViewStressCase(client, primaryModel, fallbackModel) {
  const initialSnapshot = await client.ensureChatOpen({
    reset: true,
    selectedModelId: primaryModel.value,
  });
  const initialLeafId = initialSnapshot?.leafId;
  assertTruthy(initialLeafId, "Fresh chat leafId");
  assertEqual(initialSnapshot?.messageCount, 0, "Fresh chat message count");
  assertEqual(initialSnapshot?.selectedModelId, primaryModel.value, "Fresh chat selected model");
  assertEqual(Boolean(initialSnapshot?.input?.webSearchEnabled), false, "Fresh chat web search state");
  assertEqual(initialSnapshot?.input?.approvalMode, "interactive", "Fresh chat approval mode");

  await client.setWebSearch(true);
  await client.setApprovalMode("deny");
  const toggledSnapshot = await client.getChatSnapshot();
  assertEqual(toggledSnapshot?.leafId, initialLeafId, "Leaf id after toggle setup");
  assertEqual(Boolean(toggledSnapshot?.input?.webSearchEnabled), true, "Web search after toggle");
  assertEqual(toggledSnapshot?.input?.approvalMode, "deny", "Approval mode after toggle");

  const firstToken = `DESKTOP_CHATVIEW_STRESS_A_${Date.now()}`;
  const firstSnapshot = await sendTokenTurn(client, firstToken, {
    approvalMode: "auto-approve",
    webSearchEnabled: true,
  });
  const firstAssistant = getLastAssistantMessage(firstSnapshot);
  const firstAssistantText = toMessageText(firstAssistant?.content).trim();
  assertIncludes(firstAssistantText, firstToken, `ChatView stress reply from ${primaryModel.label}`);
  assertEqual(firstSnapshot?.leafId, initialLeafId, "Leaf id after first send");
  assertEqual(firstSnapshot?.selectedModelId, primaryModel.value, "Selected model after first send");
  assertEqual(Boolean(firstSnapshot?.input?.webSearchEnabled), true, "Web search after first send");
  assertEqual(firstSnapshot?.input?.approvalMode, "deny", "Approval mode restored after first send");

  const firstChatId = String(firstSnapshot?.chatId || "").trim();
  assertTruthy(firstChatId, "First chat id");
  const firstMessageCount = Number(firstSnapshot?.messageCount || 0);
  assertGreaterThan(firstMessageCount, 1, "First chat message count");

  const resumedSnapshot = await client.ensureChatOpen({});
  assertEqual(resumedSnapshot?.leafId, initialLeafId, "Leaf id on resume");
  assertEqual(String(resumedSnapshot?.chatId || "").trim(), firstChatId, "Resumed chat id");
  assertEqual(resumedSnapshot?.messageCount, firstMessageCount, "Resumed chat message count");

  await ensureChatModelSelection(client, fallbackModel.value, {
    reset: false,
    label: `${fallbackModel.label} chatview stress fallback switch`,
  });
  await client.setWebSearch(false);
  await client.setApprovalMode("interactive");
  const switchedSnapshot = await client.getChatSnapshot();
  assertEqual(switchedSnapshot?.leafId, initialLeafId, "Leaf id after fallback switch");
  assertEqual(switchedSnapshot?.selectedModelId, fallbackModel.value, "Selected model after fallback switch");
  assertEqual(Boolean(switchedSnapshot?.input?.webSearchEnabled), false, "Web search after disabling");
  assertEqual(switchedSnapshot?.input?.approvalMode, "interactive", "Approval mode after resetting");
  assertEqual(String(switchedSnapshot?.chatId || "").trim(), firstChatId, "Chat id after fallback switch");

  const blockedFallback = await expectChatSendFailure(
    client,
    {
      text: "Reply with OK.",
      includeContextFiles: false,
      webSearchEnabled: false,
      approvalMode: "interactive",
    },
    {
      label: "ChatView stress unavailable local-Pi send",
      expectedTarget: "providers",
    }
  );
  const blockedSnapshot = await client.getChatSnapshot();
  assertEqual(blockedSnapshot?.leafId, initialLeafId, "Leaf id after blocked fallback send");
  assertEqual(String(blockedSnapshot?.chatId || "").trim(), firstChatId, "Chat id after blocked fallback send");
  assertEqual(
    blockedSnapshot?.selectedModelId,
    fallbackModel.value,
    "Selected model after blocked fallback send"
  );

  await ensureChatModelSelection(client, primaryModel.value, {
    reset: false,
    label: `${primaryModel.label} chatview stress recovery switch`,
  });
  const secondToken = `DESKTOP_CHATVIEW_STRESS_B_${Date.now()}`;
  const secondSnapshot = await sendTokenTurn(client, secondToken);
  const secondAssistant = getLastAssistantMessage(secondSnapshot);
  const secondAssistantText = toMessageText(secondAssistant?.content).trim();
  assertIncludes(secondAssistantText, secondToken, `ChatView stress recovery reply from ${primaryModel.label}`);
  assertEqual(secondSnapshot?.leafId, initialLeafId, "Leaf id after recovery send");
  assertEqual(String(secondSnapshot?.chatId || "").trim(), firstChatId, "Recovery turn chat id");
  assertEqual(secondSnapshot?.selectedModelId, primaryModel.value, "Selected model after recovery send");
  const secondMessageCount = Number(secondSnapshot?.messageCount || 0);
  assertGreaterThan(secondMessageCount, firstMessageCount, "Recovery chat message count");

  const resetSnapshot = await client.ensureChatOpen({
    reset: true,
    selectedModelId: primaryModel.value,
  });
  assertEqual(resetSnapshot?.leafId, initialLeafId, "Leaf id after reset");
  assertEqual(resetSnapshot?.messageCount, 0, "Reset chat message count");
  assertEqual(resetSnapshot?.selectedModelId, primaryModel.value, "Selected model after reset");
  assertEqual(String(resetSnapshot?.chatId || "").trim(), "", "Reset chat id");

  const thirdToken = `DESKTOP_CHATVIEW_STRESS_C_${Date.now()}`;
  const freshSnapshot = await sendTokenTurn(client, thirdToken, {
    approvalMode: "interactive",
    webSearchEnabled: false,
  });
  const thirdAssistant = getLastAssistantMessage(freshSnapshot);
  const thirdAssistantText = toMessageText(thirdAssistant?.content).trim();
  assertIncludes(thirdAssistantText, thirdToken, `Fresh chat reply from ${primaryModel.label}`);

  const freshChatId = String(freshSnapshot?.chatId || "").trim();
  assertTruthy(freshChatId, "Fresh chat id");
  assertEqual(freshSnapshot?.leafId, initialLeafId, "Leaf id after fresh chat send");
  assertEqual(freshSnapshot?.selectedModelId, primaryModel.value, "Fresh chat selected model");
  assertEqual(Boolean(freshSnapshot?.input?.webSearchEnabled), false, "Fresh chat web search state");
  assertEqual(freshSnapshot?.input?.approvalMode, "interactive", "Fresh chat approval mode");

  return {
    leafId: initialLeafId,
    firstChatId,
    freshChatId,
    primaryModel: {
      modelId: primaryModel.value,
      label: primaryModel.label,
      providerLabel: primaryModel.providerLabel,
      section: primaryModel.section,
    },
    secondaryModel: {
      modelId: fallbackModel.value,
      label: fallbackModel.label,
      providerLabel: fallbackModel.providerLabel,
      section: fallbackModel.section,
      providerAuthenticated: Boolean(fallbackModel.providerAuthenticated),
    },
    singleModelFallback: true,
    blockedFallback: {
      modelId: fallbackModel.value,
      error: blockedFallback,
    },
    tokens: {
      first: firstToken,
      second: secondToken,
      fresh: thirdToken,
    },
    transcriptPreservedAcrossModelSwitch: secondMessageCount > firstMessageCount,
    messageCounts: {
      first: firstMessageCount,
      blocked: Number(blockedSnapshot?.messageCount || 0),
      second: secondMessageCount,
      fresh: Number(freshSnapshot?.messageCount || 0),
    },
  };
}

export async function runChatViewStressCase(client, options = {}) {
  const models = await pickReadyModels(client, {
    minimumReady: 1,
    allowLocalPi: options.allowLocalPi,
  });
  const transientSkips = [];

  if (models.ready.length < 2) {
    if (!options.allowSingleModelFallback) {
      throw new Error(
        `Desktop automation needs at least two authenticated chat models, but only found ${models.ready.length}.`
      );
    }

    const primaryModel = models.selected[0];
    const fallbackModel = models.fallbackLocalOption;
    if (!fallbackModel) {
      throw new Error(
        "Desktop automation only found one authenticated model and could not find the Windows local-Pi fallback option."
      );
    }

    const result = await retryTransientOperation(
      async () => await runSingleModelChatViewStressCase(client, primaryModel, fallbackModel),
      {
        attempts: 3,
        pauseMs: 1500,
        onTransientError: (error, attempt) => {
          transientSkips.push({
            attempt,
            primaryModelId: primaryModel.value,
            primaryLabel: primaryModel.label,
            secondaryModelId: fallbackModel.value,
            secondaryLabel: fallbackModel.label,
            error: errorMessage(error),
          });
        },
      }
    );
    return {
      readyModelCount: models.ready.length,
      availableModelCount: models.all.length,
      candidateModelCount: models.candidates.length,
      transientSkips,
      ...result,
    };
  }

  for (const [primaryModel, secondaryModel] of buildDistinctModelPairs(models)) {
    try {
      const result = await runDualModelChatViewStressCase(client, primaryModel, secondaryModel);
      return {
        readyModelCount: models.ready.length,
        availableModelCount: models.all.length,
        candidateModelCount: models.candidates.length,
        transientSkips,
        ...result,
      };
    } catch (error) {
      if (!isTransientModelExecutionError(error)) {
        throw error;
      }

      transientSkips.push({
        primaryModelId: primaryModel.value,
        primaryLabel: primaryModel.label,
        secondaryModelId: secondaryModel.value,
        secondaryLabel: secondaryModel.label,
        error: errorMessage(error),
      });
    }
  }

  throw new Error(
    `Desktop automation could not complete the chatview stress case with any authenticated model pair. Transient skips: ${transientSkips
      .map((entry) => `${entry.primaryLabel} -> ${entry.secondaryLabel}: ${entry.error}`)
      .join(" | ")}`
  );
}

export async function runCase(client, options, caseName) {
  switch (caseName) {
    case SETUP_BASELINE_CASE:
      return { client, result: await runSetupBaselineCase(client) };
    case MANAGED_BASELINE_CASE:
      return { client, result: await runManagedBaselineCase(client) };
    case PROVIDER_CONNECTED_BASELINE_CASE:
      return { client, result: await runProviderConnectedBaselineCase(client, options) };
    case "model-switch":
      return { client, result: await runModelSwitchCase(client, options) };
    case "chat-exact":
      return { client, result: await runChatExactCase(client, options) };
    case "file-read":
      return { client, result: await runFileReadCase(client, options.fixtureDir) };
    case "file-write":
      return { client, result: await runFileWriteCase(client, options.fixtureDir) };
    case "web-fetch":
      return { client, result: await runWebFetchCase(client, options.webFetchUrl) };
    case "youtube-transcript":
      return { client, result: await runYouTubeTranscriptCase(client, options.youtubeUrl) };
    case DEFAULT_STRESS_CASE:
      return await runReloadStressCase(client, options);
    case CHATVIEW_STRESS_CASE:
      return { client, result: await runChatViewStressCase(client, options) };
    default:
      throw new Error(`Unsupported desktop automation case: ${caseName}`);
  }
}

export async function runDesktopAutomation(options, dependencies = {}) {
  const selectedCases = caseList(options.caseName || "all");
  const repeat = Number.isFinite(options.repeat) ? Number(options.repeat) : DEFAULT_REPEAT;
  const pauseMs = Number.isFinite(options.pauseMs) ? Number(options.pauseMs) : DEFAULT_PAUSE_MS;
  const fixtureDir = typeof options.fixtureDir === "string" && options.fixtureDir.trim()
    ? options.fixtureDir
    : DEFAULT_FIXTURE_DIR;
  const webFetchUrl = typeof options.webFetchUrl === "string" && options.webFetchUrl.trim()
    ? options.webFetchUrl
    : DEFAULT_WEB_FETCH_URL;
  const youtubeUrl = typeof options.youtubeUrl === "string" && options.youtubeUrl.trim()
    ? options.youtubeUrl
    : DEFAULT_YOUTUBE_URL;
  const bootstrap =
    typeof dependencies.bootstrapDesktopAutomationClient === "function"
      ? dependencies.bootstrapDesktopAutomationClient
      : bootstrapDesktopAutomationClient;
  const log = typeof dependencies.log === "function" ? dependencies.log : console.log.bind(console);

  const bootstrapResult = await bootstrap({
    syncConfigPath: options.syncConfigPath,
    targetIndex: options.targetIndex,
    vaultName: options.vaultName,
    vaultPath: options.vaultPath,
    reload: resolveBootstrapReload(options),
  });
  let client = bootstrapResult.client;

  log(
    `[desktop-automation] Connected to ${bootstrapResult.target.vaultName} via ${bootstrapResult.reload.method} ` +
      `(${bootstrapResult.client.baseUrl})`
  );

  const seededFixtures = await seedTextFixtures(client, fixtureDir, {
    loadFixtureBundle: dependencies.loadFixtureBundle,
  });
  const iterations = [];
  const caseOptions = {
    ...options,
    fixtureDir,
    webFetchUrl,
    youtubeUrl,
    vaultName: bootstrapResult.target.vaultName,
    vaultPath: bootstrapResult.target.vaultRoot,
  };

  for (let iteration = 0; iteration < repeat; iteration += 1) {
    const results = {};
    for (const caseName of selectedCases) {
      const startedAt = Date.now();
      log(`[desktop-automation] Running ${caseName} (${iteration + 1}/${repeat})`);
      const outcome = await runCase(client, caseOptions, caseName);
      client = outcome.client;
      const durationMs = Date.now() - startedAt;
      results[caseName] = {
        ...outcome.result,
        durationMs,
      };
      log(`[desktop-automation] Completed ${caseName} in ${durationMs}ms`);
    }
    iterations.push({
      iteration: iteration + 1,
      results,
    });
    if (iteration + 1 < repeat && pauseMs > 0) {
      await sleep(pauseMs);
    }
  }

  const status = await client.status();
  const payload = {
    bridge: {
      baseUrl: client.baseUrl,
      host: client.record.host,
      port: client.record.port,
      discoveryFilePath: client.record.discoveryFilePath || null,
      startedAt: client.record.startedAt || null,
    },
    bootstrap: {
      target: bootstrapResult.target,
      ensured: sanitizeEnsuredForReport(bootstrapResult.ensured),
      reload: bootstrapResult.reload,
    },
    fixtureDir,
    seededFixtures,
    status,
    statusSummary: summarizeStatusForReport(status, client),
    repeat,
    iterations,
  };

  if (options.jsonOutput) {
    await fs.mkdir(path.dirname(options.jsonOutput), { recursive: true });
    await fs.writeFile(options.jsonOutput, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  return payload;
}
