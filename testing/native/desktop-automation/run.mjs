#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { bootstrapDesktopAutomationClient } from "./bootstrap.mjs";
import { loadFixtureBundle } from "../runtime-smoke/fixtures.mjs";
import {
  DEFAULT_FIXTURE_DIR,
  DEFAULT_PAUSE_MS,
  DEFAULT_REPEAT,
  DEFAULT_WEB_FETCH_URL,
  DEFAULT_YOUTUBE_URL,
} from "../runtime-smoke/constants.mjs";

const CORE_CASES = ["model-switch", "chat-exact", "file-read", "file-write", "web-fetch"];
const EXTENDED_CASES = [...CORE_CASES, "youtube-transcript"];

function usage() {
  console.log(`Usage: node testing/native/desktop-automation/run.mjs [options]

Run no-focus desktop automation against the already-running Obsidian vault by
talking to the plugin's localhost bridge instead of driving the renderer.

Options:
  --case <name|all|extended>   Case list: model-switch, chat-exact, file-read, file-write, web-fetch, youtube-transcript, all, or extended. Default: all
  --sync-config <path>         Sync config used to resolve the desktop plugin target. Default: ./systemsculpt-sync.config.json
  --target-index <n>           pluginTargets index from the sync config when no explicit vault selector is provided
  --vault-name <name>          Resolve a specific sync target by vault name
  --vault-path <path>          Resolve a specific sync target by absolute vault path
  --fixture-dir <path>         Vault-relative fixture folder. Default: ${DEFAULT_FIXTURE_DIR}
  --web-fetch-url <url>        URL for the direct web-fetch bridge case. Default: ${DEFAULT_WEB_FETCH_URL}
  --youtube-url <url>          URL for the direct YouTube transcript bridge case. Default: ${DEFAULT_YOUTUBE_URL}
  --repeat <n>                 Repeat the selected cases. Default: ${DEFAULT_REPEAT}
  --pause-ms <n>               Delay between iterations. Default: ${DEFAULT_PAUSE_MS}
  --json-output <path>         Write the final JSON report to this path as well as stdout
  --no-reload                  Reuse a live bridge if one already exists instead of forcing a plugin reload
  --help, -h                   Show this help
`);
}

function fail(message) {
  console.error(`[desktop-automation] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    caseName: "all",
    syncConfigPath: path.resolve(process.cwd(), "systemsculpt-sync.config.json"),
    targetIndex: null,
    vaultName: "",
    vaultPath: "",
    fixtureDir: DEFAULT_FIXTURE_DIR,
    webFetchUrl: DEFAULT_WEB_FETCH_URL,
    youtubeUrl: DEFAULT_YOUTUBE_URL,
    repeat: DEFAULT_REPEAT,
    pauseMs: DEFAULT_PAUSE_MS,
    jsonOutput: "",
    reload: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--case") {
      options.caseName = String(argv[index + 1] || "").trim() || options.caseName;
      index += 1;
      continue;
    }
    if (arg === "--sync-config") {
      options.syncConfigPath = path.resolve(String(argv[index + 1] || "") || options.syncConfigPath);
      index += 1;
      continue;
    }
    if (arg === "--target-index") {
      const parsedTargetIndex = Number.parseInt(String(argv[index + 1] || ""), 10);
      if (!Number.isFinite(parsedTargetIndex)) {
        fail(`Invalid value for --target-index: ${String(argv[index + 1] || "")}`);
      }
      options.targetIndex = parsedTargetIndex;
      index += 1;
      continue;
    }
    if (arg === "--vault-name") {
      options.vaultName = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--vault-path") {
      options.vaultPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--fixture-dir") {
      options.fixtureDir = String(argv[index + 1] || "").trim() || options.fixtureDir;
      index += 1;
      continue;
    }
    if (arg === "--web-fetch-url") {
      options.webFetchUrl = String(argv[index + 1] || "").trim() || options.webFetchUrl;
      index += 1;
      continue;
    }
    if (arg === "--youtube-url") {
      options.youtubeUrl = String(argv[index + 1] || "").trim() || options.youtubeUrl;
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      options.repeat = Math.max(1, Number.parseInt(String(argv[index + 1] || ""), 10) || options.repeat);
      index += 1;
      continue;
    }
    if (arg === "--pause-ms") {
      options.pauseMs = Math.max(0, Number.parseInt(String(argv[index + 1] || ""), 10) || options.pauseMs);
      index += 1;
      continue;
    }
    if (arg === "--json-output") {
      options.jsonOutput = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--no-reload") {
      options.reload = false;
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

function caseList(caseName) {
  if (caseName === "all") {
    return CORE_CASES;
  }
  if (caseName === "extended") {
    return EXTENDED_CASES;
  }
  return [caseName];
}

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

function isTransientModelExecutionError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    /\b429\b/.test(message) ||
    [
      "http 429",
      "status 429",
      "too many requests",
      "rate-limited",
      "rate limited",
      "retry shortly",
      "retry after",
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

async function seedTextFixtures(client, fixtureDir) {
  const bundle = await loadFixtureBundle();
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

async function runModelSwitchCase(client) {
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

async function runChatExactCase(client) {
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

async function runCase(client, options, caseName) {
  switch (caseName) {
    case "model-switch":
      return await runModelSwitchCase(client);
    case "chat-exact":
      return await runChatExactCase(client);
    case "file-read":
      return await runFileReadCase(client, options.fixtureDir);
    case "file-write":
      return await runFileWriteCase(client, options.fixtureDir);
    case "web-fetch":
      return await runWebFetchCase(client, options.webFetchUrl);
    case "youtube-transcript":
      return await runYouTubeTranscriptCase(client, options.youtubeUrl);
    default:
      throw new Error(`Unsupported desktop automation case: ${caseName}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bootstrap = await bootstrapDesktopAutomationClient({
    syncConfigPath: options.syncConfigPath,
    targetIndex: options.targetIndex,
    vaultName: options.vaultName,
    vaultPath: options.vaultPath,
    reload: options.reload,
  });
  const client = bootstrap.client;

  console.log(
    `[desktop-automation] Connected to ${bootstrap.target.vaultName} via ${bootstrap.reload.method} ` +
      `(${bootstrap.client.baseUrl})`
  );

  const seededFixtures = await seedTextFixtures(client, options.fixtureDir);
  const iterations = [];

  for (let iteration = 0; iteration < options.repeat; iteration += 1) {
    const results = {};
    for (const caseName of caseList(options.caseName)) {
      const startedAt = Date.now();
      console.log(
        `[desktop-automation] Running ${caseName} (${iteration + 1}/${options.repeat})`
      );
      const result = await runCase(client, options, caseName);
      results[caseName] = {
        ...result,
        durationMs: Date.now() - startedAt,
      };
    }
    iterations.push({
      iteration: iteration + 1,
      results,
    });
    if (iteration + 1 < options.repeat && options.pauseMs > 0) {
      await sleep(options.pauseMs);
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
      target: bootstrap.target,
      ensured: sanitizeEnsuredForReport(bootstrap.ensured),
      reload: bootstrap.reload,
    },
    fixtureDir: options.fixtureDir,
    seededFixtures,
    status,
    repeat: options.repeat,
    iterations,
  };

  if (options.jsonOutput) {
    await fs.mkdir(path.dirname(options.jsonOutput), { recursive: true });
    await fs.writeFile(options.jsonOutput, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
