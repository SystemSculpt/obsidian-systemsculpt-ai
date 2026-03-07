#!/usr/bin/env node

import dotenv from "dotenv";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_LIVE_SERVER_URL = "https://api.systemsculpt.com/api/v1";
const DEFAULT_MOCK_PORT = 43111;
const DEFAULT_FRESH_DESKTOP_SPEC = "testing/e2e/specs-mock/desktop.fresh-install.bootstrap.mock.e2e.ts";

let cleanupStarted = false;
const trackedChildren = new Set();
let mockServerChild = null;

function printHelp() {
  console.log(
    [
      "Usage: node testing/e2e/run.mjs <live|emu|mock|fresh-desktop> [options]",
      "",
      "Options:",
      "  --spec <path>      Run a single WDIO spec file.",
      "  --skip-build       Skip npm build steps inside the runner.",
      "  -h, --help         Show this help message.",
      "",
      "The runner is cross-platform and auto-loads repo-local .env.local and .env files.",
    ].join("\n")
  );
}

function fail(message) {
  throw new Error(message);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function expandHome(value) {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith("~/")) {
    return normalized;
  }
  return path.join(os.homedir(), normalized.slice(2));
}

function resolveSettingsJsonPath() {
  const explicitSettingsPath = expandHome(process.env.SYSTEMSCULPT_E2E_SETTINGS_JSON || "");
  if (explicitSettingsPath) {
    return explicitSettingsPath;
  }

  const vaultPath = expandHome(process.env.SYSTEMSCULPT_E2E_VAULT || "");
  if (vaultPath) {
    return path.join(vaultPath, ".obsidian", "plugins", "systemsculpt-ai", "data.json");
  }

  const fallbackDisabled = String(process.env.SYSTEMSCULPT_E2E_DISABLE_PRIVATE_VAULT_FALLBACK || "0").trim() === "1";
  if (fallbackDisabled) {
    return "";
  }

  const fallbackPath = expandHome(
    process.env.SYSTEMSCULPT_E2E_PRIVATE_VAULT_FALLBACK
      || path.join(os.homedir(), "gits", "private-vault", ".obsidian", "plugins", "systemsculpt-ai", "data.json")
  );
  return fallbackPath;
}

async function readSettingsJson() {
  const settingsPath = resolveSettingsJsonPath();
  if (!settingsPath || !existsSync(settingsPath)) {
    return null;
  }

  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function hydrateEnvFromSettings() {
  const settings = await readSettingsJson();
  if (!settings || typeof settings !== "object") {
    return;
  }

  if (!String(process.env.SYSTEMSCULPT_E2E_LICENSE_KEY || "").trim()) {
    const value = String(settings.licenseKey || "").trim();
    if (value) {
      process.env.SYSTEMSCULPT_E2E_LICENSE_KEY = value;
    }
  }

  if (!String(process.env.SYSTEMSCULPT_E2E_SERVER_URL || "").trim()) {
    const value = String(settings.serverUrl || "").trim();
    if (value) {
      process.env.SYSTEMSCULPT_E2E_SERVER_URL = value;
    }
  }

  if (!String(process.env.SYSTEMSCULPT_E2E_MODEL_ID || "").trim()) {
    const value = String(settings.selectedModelId || "").trim();
    if (value) {
      process.env.SYSTEMSCULPT_E2E_MODEL_ID = value;
    }
  }
}

function requireE2ELicenseKey() {
  if (String(process.env.SYSTEMSCULPT_E2E_LICENSE_KEY || "").trim()) {
    return;
  }

  fail(
    [
      "Missing SYSTEMSCULPT_E2E_LICENSE_KEY.",
      "Set it in .env.local or provide SYSTEMSCULPT_E2E_SETTINGS_JSON / SYSTEMSCULPT_E2E_VAULT for auto-loading.",
    ].join(" ")
  );
}

function requireLiveSpendConfirmation() {
  if (String(process.env.SYSTEMSCULPT_E2E_ALLOW_PAID_LIVE_TESTS || "0").trim() === "1") {
    return;
  }

  fail(
    [
      "Refusing to run paid live E2E image generation without explicit opt-in.",
      "Set SYSTEMSCULPT_E2E_ALLOW_PAID_LIVE_TESTS=1 for an intentional live run.",
    ].join(" ")
  );
}

function normalizeApiUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return DEFAULT_LIVE_SERVER_URL;
  }

  try {
    const parsed = new URL(raw);
    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    if (/\/api\/v1$/i.test(trimmedPath)) {
      parsed.pathname = trimmedPath || "/api/v1";
    } else if (/\/api$/i.test(trimmedPath)) {
      parsed.pathname = `${trimmedPath}/v1`;
    } else {
      const basePath = trimmedPath === "" || trimmedPath === "/" ? "" : trimmedPath;
      parsed.pathname = `${basePath}/api/v1`.replace(/\/{2,}/g, "/");
    }

    if (parsed.hostname === "systemsculpt.com" || parsed.hostname === "www.systemsculpt.com") {
      parsed.hostname = "api.systemsculpt.com";
      parsed.port = "";
    }

    return parsed.toString();
  } catch {
    const withoutTrailing = raw.replace(/\/+$/, "");
    if (withoutTrailing.endsWith("/api/v1")) return withoutTrailing;
    if (withoutTrailing.endsWith("/api")) return `${withoutTrailing}/v1`;
    return `${withoutTrailing}/api/v1`;
  }
}

function ensureLiveServerUrl() {
  const configured = String(process.env.SYSTEMSCULPT_E2E_SERVER_URL || "").trim();
  process.env.SYSTEMSCULPT_E2E_SERVER_URL = normalizeApiUrl(configured || DEFAULT_LIVE_SERVER_URL);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function preflightLiveImageApi() {
  const serverUrl = String(process.env.SYSTEMSCULPT_E2E_SERVER_URL || "").trim();
  const licenseKey = String(process.env.SYSTEMSCULPT_E2E_LICENSE_KEY || "").trim();
  if (!serverUrl) {
    fail("[e2e-live] Missing SYSTEMSCULPT_E2E_SERVER_URL for live API preflight.");
  }
  if (!licenseKey) {
    fail("[e2e-live] Missing SYSTEMSCULPT_E2E_LICENSE_KEY for live API preflight.");
  }

  const base = serverUrl.replace(/\/+$/, "");
  const headers = {
    "x-license-key": licenseKey,
    "content-type": "application/json",
    accept: "application/json",
  };

  const modelsUrl = `${base}/images/models`;
  const modelsResponse = await fetch(modelsUrl, { method: "GET", headers });
  if (!modelsResponse.ok) {
    const payload = await readJsonResponse(modelsResponse);
    fail(`[e2e-live] Image models preflight failed (${modelsResponse.status}) at ${modelsUrl}. body=${JSON.stringify(payload)}`);
  }

  const jobsUrl = `${base}/images/generations/jobs`;
  const invalidResponse = await fetch(jobsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (invalidResponse.status === 404) {
    const payload = await readJsonResponse(invalidResponse);
    fail(
      `[e2e-live] Image jobs endpoint returned 404 at ${jobsUrl}. This usually means image generation is disabled/unavailable on the target API. body=${JSON.stringify(payload)}`
    );
  }
  if (invalidResponse.status === 401 || invalidResponse.status === 403) {
    const payload = await readJsonResponse(invalidResponse);
    fail(`[e2e-live] Image jobs endpoint auth failed (${invalidResponse.status}) at ${jobsUrl}. body=${JSON.stringify(payload)}`);
  }
  if (invalidResponse.status >= 500) {
    const payload = await readJsonResponse(invalidResponse);
    fail(`[e2e-live] Image jobs endpoint server error (${invalidResponse.status}) at ${jobsUrl}. body=${JSON.stringify(payload)}`);
  }
  if (!(invalidResponse.status === 400 || invalidResponse.status === 422)) {
    const payload = await readJsonResponse(invalidResponse);
    fail(`[e2e-live] Image jobs route preflight returned unexpected status ${invalidResponse.status} at ${jobsUrl}. body=${JSON.stringify(payload)}`);
  }

  console.log(`[e2e-live] API preflight passed for ${base}`);
}

function shouldSkipBuild() {
  return String(process.env.SYSTEMSCULPT_E2E_SKIP_BUILD || "0").trim() === "1";
}

function isReleaseAssetInstallMode() {
  const normalized = String(process.env.SYSTEMSCULPT_E2E_PLUGIN_INSTALL_MODE || "").trim().toLowerCase();
  return normalized === "release-assets" || normalized === "fresh-desktop";
}

async function terminateProcessTree(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-Number(pid), "SIGTERM");
  } catch {}
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {}
}

async function cleanup() {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;

  const children = Array.from(trackedChildren.values()).reverse();
  for (const child of children) {
    try {
      await terminateProcessTree(child.pid);
    } catch {}
  }
  trackedChildren.clear();
  mockServerChild = null;
}

function trackChild(child) {
  trackedChildren.add(child);
  child.once("exit", () => {
    trackedChildren.delete(child);
    if (mockServerChild === child) {
      mockServerChild = null;
    }
  });
}

function spawnTracked(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: REPO_ROOT,
    env: options.env || process.env,
    stdio: options.stdio || "inherit",
    shell: false,
    detached: options.detached ?? (process.platform !== "win32"),
  });
  trackChild(child);
  return child;
}

async function runCommand(command, commandArgs, options = {}) {
  const child = spawnTracked(command, commandArgs, options);
  return await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${commandArgs.join(" ")} failed with code ${code ?? "null"}${signal ? ` (signal: ${signal})` : ""}.`));
    });
  });
}

async function runBuildIfNeeded() {
  if (shouldSkipBuild()) {
    return;
  }

  await runCommand(npmCommand(), ["run", "build"]);
  if (isReleaseAssetInstallMode()) {
    await runCommand(npmCommand(), ["run", "build:pi-runtime"]);
    await runCommand(npmCommand(), ["run", "build:terminal-runtime"]);
  }
}

function getMockPort() {
  const parsed = Number(process.env.SYSTEMSCULPT_E2E_MOCK_PORT || DEFAULT_MOCK_PORT);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return DEFAULT_MOCK_PORT;
}

function configureMockReleaseAssetEnv() {
  if (!isReleaseAssetInstallMode()) {
    return;
  }

  const assetBase = `http://127.0.0.1:${getMockPort()}/_e2e/release-assets`;
  process.env.SYSTEMSCULPT_PI_RUNTIME_BASE_URL = `${assetBase}/pi-runtime`;
  process.env.SYSTEMSCULPT_PI_RUNTIME_MANIFEST_URL = `${assetBase}/pi-runtime/studio-pi-runtime-manifest.json`;
  process.env.SYSTEMSCULPT_STUDIO_TERMINAL_RUNTIME_BASE_URL = `${assetBase}/terminal-runtime`;
  process.env.SYSTEMSCULPT_STUDIO_TERMINAL_RUNTIME_MANIFEST_URL = `${assetBase}/terminal-runtime/studio-terminal-runtime-manifest.json`;
}

function configureMockServerEnv() {
  if (String(process.env.SYSTEMSCULPT_E2E_ALLOW_EXTERNAL_SERVER_IN_MOCK || "0").trim() !== "1") {
    process.env.SYSTEMSCULPT_E2E_SERVER_URL = `http://127.0.0.1:${getMockPort()}/api/v1`;
  } else if (!String(process.env.SYSTEMSCULPT_E2E_SERVER_URL || "").trim()) {
    process.env.SYSTEMSCULPT_E2E_SERVER_URL = `http://127.0.0.1:${getMockPort()}/api/v1`;
  }

  if (!String(process.env.SYSTEMSCULPT_E2E_MODEL_ID || "").trim()) {
    process.env.SYSTEMSCULPT_E2E_MODEL_ID = "systemsculpt@@systemsculpt/ai-agent";
  }
}

async function waitForMockServerHealthy() {
  const port = getMockPort();
  const url = `http://127.0.0.1:${port}/healthz`;
  const startedAt = Date.now();
  const timeoutMs = 5000;

  while (Date.now() - startedAt < timeoutMs) {
    if (mockServerChild && mockServerChild.exitCode !== null) {
      fail(`[e2e-mock] server exited before becoming healthy (code ${mockServerChild.exitCode}).`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  fail(`[e2e-mock] server not healthy: ${url}`);
}

async function startMockServer() {
  process.env.SYSTEMSCULPT_E2E_MOCK_PORT = String(getMockPort());
  mockServerChild = spawnTracked(process.execPath, [path.join(REPO_ROOT, "testing/e2e/mock-server.mjs")], {
    env: process.env,
  });
  await waitForMockServerHealthy();
}

async function runWdio(mode) {
  const configFileByMode = {
    live: "testing/e2e/wdio.live.conf.mjs",
    emu: "testing/e2e/wdio.emu.conf.mjs",
    mock: "testing/e2e/wdio.mock.conf.mjs",
  };

  const configFile = configFileByMode[mode];
  if (!configFile) {
    fail(`Unknown mode: ${mode} (use: live | emu | mock | fresh-desktop)`);
  }

  const args = ["wdio", configFile];
  const spec = String(process.env.SYSTEMSCULPT_E2E_SPEC || "").trim();
  if (spec) {
    args.push("--spec", spec);
  }

  await runCommand(npxCommand(), args, {
    env: process.env,
  });
}

function applyFreshDesktopDefaults() {
  process.env.SYSTEMSCULPT_E2E_DISABLE_PRIVATE_VAULT_FALLBACK = "1";
  process.env.SYSTEMSCULPT_E2E_PLUGIN_INSTALL_MODE = "release-assets";
  process.env.SYSTEMSCULPT_E2E_LICENSE_KEY = String(process.env.SYSTEMSCULPT_E2E_LICENSE_KEY || "").trim() || "fake-license";
  process.env.SYSTEMSCULPT_E2E_INSTANCES = String(process.env.SYSTEMSCULPT_E2E_INSTANCES || "").trim() || "1";
  process.env.SYSTEMSCULPT_E2E_SPEC = String(process.env.SYSTEMSCULPT_E2E_SPEC || "").trim() || DEFAULT_FRESH_DESKTOP_SPEC;
}

function loadEnvFiles() {
  dotenv.config({
    path: path.join(REPO_ROOT, ".env.local"),
    override: true,
  });
  dotenv.config({
    path: path.join(REPO_ROOT, ".env"),
    override: true,
  });
}

function parseCli(argv) {
  const options = {
    mode: "live",
    freshDesktop: false,
    help: false,
  };
  let sawMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      process.env.SYSTEMSCULPT_E2E_SKIP_BUILD = "1";
      continue;
    }
    if (arg === "--spec") {
      const value = argv[index + 1];
      if (!value) {
        fail("Missing value for --spec.");
      }
      process.env.SYSTEMSCULPT_E2E_SPEC = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`Unknown argument: ${arg}`);
    }
    if (!sawMode) {
      sawMode = true;
      if (arg === "fresh-desktop") {
        options.mode = "mock";
        options.freshDesktop = true;
      } else {
        options.mode = arg;
      }
      continue;
    }
    fail(`Unexpected positional argument: ${arg}`);
  }

  return options;
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void cleanup().finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    });
  }
}

async function main() {
  loadEnvFiles();
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.freshDesktop) {
    applyFreshDesktopDefaults();
  }

  installSignalHandlers();

  try {
    if (options.mode === "live" || options.mode === "emu") {
      requireLiveSpendConfirmation();
      await hydrateEnvFromSettings();
      requireE2ELicenseKey();
      ensureLiveServerUrl();
      await preflightLiveImageApi();
      await runBuildIfNeeded();
      await runWdio(options.mode);
      return;
    }

    if (options.mode === "mock") {
      configureMockReleaseAssetEnv();
      await hydrateEnvFromSettings();
      requireE2ELicenseKey();
      configureMockServerEnv();
      await runBuildIfNeeded();
      await startMockServer();
      await runWdio("mock");
      return;
    }

    fail(`Unknown mode: ${options.mode} (use: live | emu | mock | fresh-desktop)`);
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message) {
    console.error(message);
  }
  await cleanup();
  process.exit(1);
});
