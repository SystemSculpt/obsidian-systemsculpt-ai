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

export const CORE_CASES = ["model-switch", "chat-exact", "file-read", "file-write", "web-fetch"];
export const EXTENDED_CASES = [...CORE_CASES, "youtube-transcript"];
export const STRESS_CASES = ["reload-stress"];
export const DEFAULT_STRESS_CASE = STRESS_CASES[0];
export const CHATVIEW_STRESS_CASE = "chatview-stress";
export const SOAK_CASES = [DEFAULT_STRESS_CASE, CHATVIEW_STRESS_CASE];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return (
    /\b429\b/.test(message) ||
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

async function pickReadyModels(client) {
  const models = await client.listModels();
  const options = Array.isArray(models?.options) ? models.options : [];
  const ready = options.filter((option) => option && option.providerAuthenticated);
  if (ready.length < 2) {
    throw new Error(
      `Desktop automation needs at least two authenticated chat models, but only found ${ready.length}.`
    );
  }

  const preferredFirst =
    ready.find((option) => option.value === models.selectedModelId) || ready[0];
  const preferredSecond =
    ready.find(
      (option) =>
        option.value !== preferredFirst.value &&
        (option.providerId !== preferredFirst.providerId || option.section !== preferredFirst.section)
    ) || ready.find((option) => option.value !== preferredFirst.value);

  if (!preferredSecond) {
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
  appendCandidate(preferredSecond);
  ready.forEach(appendCandidate);

  return {
    all: options,
    ready,
    candidates,
    selected: [preferredFirst, preferredSecond],
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

export async function runModelSwitchCase(client) {
  const models = await pickReadyModels(client);
  const switches = [];
  const transientSkips = [];

  for (const model of models.candidates) {
    if (switches.length >= 2) {
      break;
    }

    const index = switches.length;
    const token = `DESKTOP_MODEL_SWITCH_${index + 1}_${Date.now()}`;
    try {
      await client.ensureChatOpen({
        reset: true,
        selectedModelId: model.value,
      });
      await client.setModel(model.value);
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

export async function runChatExactCase(client) {
  const models = await pickReadyModels(client);
  const transientSkips = [];

  for (const model of models.candidates) {
    const token = `DESKTOP_CHAT_EXACT_${Date.now()}`;

    try {
      await client.ensureChatOpen({
        reset: true,
        selectedModelId: model.value,
      });
      await client.setModel(model.value);

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

async function runSingleChatViewStressCase(client, primaryModel, secondaryModel) {
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

  await client.setModel(secondaryModel.value);
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

export async function runChatViewStressCase(client) {
  const models = await pickReadyModels(client);
  const transientSkips = [];

  for (const [primaryModel, secondaryModel] of buildDistinctModelPairs(models)) {
    try {
      const result = await runSingleChatViewStressCase(client, primaryModel, secondaryModel);
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
    case "model-switch":
      return { client, result: await runModelSwitchCase(client) };
    case "chat-exact":
      return { client, result: await runChatExactCase(client) };
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
