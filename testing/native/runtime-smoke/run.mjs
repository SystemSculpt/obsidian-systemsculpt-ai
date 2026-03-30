#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { fail, parseArgs } from "./cli.mjs";
import { assertCaseResult, caseList, runCase } from "./cases.mjs";
import { seedFixtureBundle } from "./fixtures.mjs";
import { connectToRuntime, ensureJsonUrl } from "./runtime.mjs";

function loadRuntimeSmokeEnv() {
  for (const relativePath of [".env.local", ".env"]) {
    loadDotEnv({
      path: path.resolve(process.cwd(), relativePath),
      override: false,
      quiet: true,
    });
  }
}

function resolveRuntimeSmokeLicenseKey() {
  const explicitKey = String(process.env.SYSTEMSCULPT_RUNTIME_SMOKE_LICENSE_KEY || "").trim();
  if (explicitKey) {
    return explicitKey;
  }

  const e2eKey = String(process.env.SYSTEMSCULPT_E2E_LICENSE_KEY || "").trim();
  if (!e2eKey) {
    return "";
  }

  process.env.SYSTEMSCULPT_RUNTIME_SMOKE_LICENSE_KEY = e2eKey;
  return e2eKey;
}

loadRuntimeSmokeEnv();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientUpstreamRateLimit(error) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    (message.includes("429") && (message.includes("rate limit") || message.includes("rate-limited"))) ||
    message.includes("temporarily rate-limited") ||
    message.includes("retry shortly")
  );
}

async function runCaseWithRetries(runtime, options, caseName) {
  const maxTransientRateLimitRetries = 2;

  for (let attempt = 0; attempt <= maxTransientRateLimitRetries; attempt += 1) {
    try {
      return {
        result: await runCase(runtime, options, caseName),
        attemptsUsed: attempt + 1,
      };
    } catch (error) {
      if (!isTransientUpstreamRateLimit(error) || attempt >= maxTransientRateLimitRetries) {
        throw error;
      }

      const retryDelayMs = 5000 * (attempt + 1);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[runtime-smoke] ${caseName} hit a transient upstream rate limit ` +
          `(attempt ${attempt + 1}/${maxTransientRateLimitRetries + 1}); retrying in ${retryDelayMs}ms: ${message}`
      );
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`Unreachable retry state for ${caseName}.`);
}

async function waitForObsidianApp(runtime, options) {
  const deadlineMs = options.mode === "ios" ? 90000 : 60000;
  const startedAt = Date.now();
  let lastSnapshot = null;
  while (Date.now() - startedAt < deadlineMs) {
    lastSnapshot = await runtime.evaluate(`(() => ({
      hasApp: typeof globalThis.app !== 'undefined' && !!globalThis.app,
      title: typeof document !== 'undefined' ? (document.title || '') : '',
      readyState: typeof document !== 'undefined' ? (document.readyState || '') : '',
      url: typeof location !== 'undefined' ? (location.href || '') : '',
      hasBody: typeof document !== 'undefined' ? !!document.body : false,
    }))()`, 15000);
    if (lastSnapshot?.hasApp) {
      return lastSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for Obsidian runtime app on ${options.mode}: ${JSON.stringify(lastSnapshot)}`
  );
}

async function waitForSystemSculptPlugin(runtime, options) {
  const deadlineMs = options.mode === "ios" ? 120000 : 90000;
  const startedAt = Date.now();
  let lastSnapshot = null;
  while (Date.now() - startedAt < deadlineMs) {
    lastSnapshot = await runtime.evaluate(`(() => {
      const plugin = app?.plugins?.plugins?.['systemsculpt-ai'] || app?.plugins?.getPlugin?.('systemsculpt-ai');
      return {
        hasPlugin: !!plugin,
        manifestVersion: plugin?.manifest?.version ?? null,
        enabledPlugins:
          app?.plugins?.enabledPlugins instanceof Set
            ? Array.from(app.plugins.enabledPlugins)
            : Array.isArray(app?.plugins?.enabledPlugins)
              ? app.plugins.enabledPlugins
              : [],
      };
    })()`, 15000);
    if (lastSnapshot?.hasPlugin) {
      return lastSnapshot;
    }
    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for systemsculpt-ai to load on ${options.mode}: ${JSON.stringify(lastSnapshot)}`
  );
}

async function prepareRuntime(runtime, options) {
  await waitForObsidianApp(runtime, options);
  await waitForSystemSculptPlugin(runtime, options);
  console.log(
    options.mode === "ios"
      ? "[runtime-smoke] Reloading systemsculpt-ai on iOS to refresh the live plugin instance"
      : `[runtime-smoke] Reloading systemsculpt-ai on ${options.mode} before runtime smoke`
  );
  const state = await runtime.evaluate(`(async () => {
    const pluginId = 'systemsculpt-ai';
    const pauseMs = ${options.mode === "ios" ? 750 : 350};
    const settleMs = ${options.mode === "ios" ? 1500 : 750};
    const snapshot = (plugin) => ({
      hasPlugin: !!plugin,
      hasTranscription: typeof plugin?.getTranscriptionService === 'function',
      hasYouTube: typeof plugin?.getYouTubeTranscriptService === 'function',
      hasWebFetch: typeof plugin?.getWebResearchApiService === 'function',
      hasWebCorpus: typeof plugin?.getWebResearchCorpusService === 'function',
      hasStudio: typeof plugin?.getStudioService === 'function',
      manifestVersion: plugin?.manifest?.version ?? null,
    });

    const before = snapshot(app?.plugins?.plugins?.[pluginId]);
    await app.plugins.disablePlugin(pluginId);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    await app.plugins.enablePlugin(pluginId);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const after = snapshot(app?.plugins?.plugins?.[pluginId]);
    return { before, after };
  })()`, 60000);

  if (!state?.after?.hasPlugin) {
    throw new Error(
      `Failed to reload systemsculpt-ai on ${options.mode} before runtime smoke. ${JSON.stringify(state)}`
    );
  }

  return state;
}

async function bootstrapHostedAuth(runtime) {
  const licenseKey = resolveRuntimeSmokeLicenseKey();
  if (!licenseKey) {
    return null;
  }

  const serverUrl =
    String(process.env.SYSTEMSCULPT_RUNTIME_SMOKE_SERVER_URL || "").trim() ||
    "https://api.systemsculpt.com";

  return await runtime.evaluate(`(async () => {
    const plugin = app?.plugins?.plugins?.['systemsculpt-ai'];
    if (!plugin) throw new Error('SystemSculpt plugin missing during auth bootstrap');
    Object.assign(plugin.settings, {
      licenseKey: ${JSON.stringify(licenseKey)},
      licenseValid: true,
      serverUrl: ${JSON.stringify(serverUrl)},
      transcriptionProvider: 'systemsculpt',
      embeddingsProvider: 'systemsculpt',
      enableSystemSculptProvider: true,
      selectedModelId: 'systemsculpt@@systemsculpt/ai-agent',
    });
    if (typeof plugin.saveSettings === 'function') {
      await plugin.saveSettings();
    }
    const licenseManager =
      typeof plugin.getLicenseManager === 'function'
        ? plugin.getLicenseManager()
        : plugin.licenseManager || null;
    const pendingValidation = licenseManager?.pendingValidation;
    if (pendingValidation && typeof pendingValidation.then === 'function') {
      await pendingValidation;
    }
    let validationResult = null;
    if (licenseManager && typeof licenseManager.validateLicenseKey === 'function') {
      validationResult = await licenseManager.validateLicenseKey(true, false);
      if (validationResult !== true) {
        throw new Error('Hosted auth bootstrap could not validate the configured SystemSculpt license.');
      }
    }
    return {
      licenseKeyLength: String(plugin.settings.licenseKey || '').length,
      licenseValid: !!plugin.settings.licenseValid,
      serverUrl: plugin.settings.serverUrl || null,
      selectedModelId: plugin.settings.selectedModelId || null,
      validationResult,
    };
  })()`, 120000);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "desktop") {
    fail(
      "Desktop runtime smoke now lives in testing/native/desktop-automation/run.mjs. " +
        "Use `npm run test:native:desktop` or `npm run runtime:smoke:desktop`."
    );
  }
  const preparedRuntime = await ensureJsonUrl(options);
  const runtime = await connectToRuntime(preparedRuntime.jsonUrl, options.targetHint);
  const iterations = [];

  try {
    await prepareRuntime(runtime, options);
    const authState = await bootstrapHostedAuth(runtime);
    if (authState) {
      console.log(
        `[runtime-smoke] Bootstrapped hosted auth (${authState.licenseKeyLength} chars, ${authState.serverUrl})`
      );
    }
    console.log(`[runtime-smoke] Seeding fixtures into ${options.fixtureDir}`);
    await seedFixtureBundle(runtime, options.fixtureDir);
    for (let iteration = 0; iteration < options.repeat; iteration += 1) {
      const results = {};
      for (const caseName of caseList(options.caseName)) {
        const startedAt = Date.now();
        console.log(
          `[runtime-smoke] Running ${caseName} via ${options.mode} (iteration ${iteration + 1}/${options.repeat})`
        );
        const { result, attemptsUsed } = await runCaseWithRetries(runtime, options, caseName);
        assertCaseResult(caseName, options, result);
        const durationMs = Date.now() - startedAt;
        results[caseName] = {
          ...result,
          attemptsUsed,
          durationMs,
        };
        console.log(
          `[runtime-smoke] Completed ${caseName} via ${options.mode} in ${durationMs}ms`
        );
      }
      iterations.push({
        iteration: iteration + 1,
        results,
      });
      if (iteration + 1 < options.repeat && options.pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
      }
    }
  } finally {
    await runtime.close();
    await preparedRuntime.close();
  }

  const payload = {
    mode: options.mode,
    jsonUrl: preparedRuntime.jsonUrl,
    targetTitle: runtime.target?.title || "",
    targetUrl: runtime.target?.url || "",
    fixtureDir: options.fixtureDir,
    transcribeAudioPath: options.transcribeAudioPath || `${options.fixtureDir}/audio-phrases.m4a`,
    recordAudioPath: options.recordAudioPath || `${options.fixtureDir}/audio-phrases.m4a`,
    webFetchUrl: options.webFetchUrl,
    youtubeUrl: options.youtubeUrl,
    repeat: options.repeat,
    iterations,
  };

  if (options.jsonOutput) {
    await fs.writeFile(options.jsonOutput, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
