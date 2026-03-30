#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WINDOWS_SSH_HOST,
  runRemotePowerShellScript,
  runWindowsNodeModuleRemotely,
} from "./remote-run.mjs";

export const DEFAULT_WINDOWS_PLUGIN_ID = "systemsculpt-ai";
export const DEFAULT_WINDOWS_RUNTIME_REFRESH_TIMEOUT_MS = 120_000;
export const DEFAULT_WINDOWS_RUNTIME_REFRESH_POLL_MS = 2_000;

function fail(message) {
  throw new Error(message);
}

function psSingleQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

export function parseJsonObjectText(rawText, label) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    fail(`${label} returned no data.`);
  }

  const candidateTexts = [trimmed];
  const objectStart = trimmed.lastIndexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidateTexts.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  let parsed = null;
  let lastError = null;
  for (const candidate of candidateTexts) {
    try {
      parsed = JSON.parse(candidate);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!parsed) {
    throw new Error(
      `Failed to parse ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    fail(`${label} did not return an object.`);
  }

  return parsed;
}

export function buildLatestWindowsBridgeRecordScript(options = {}) {
  const pluginId = String(options.pluginId || DEFAULT_WINDOWS_PLUGIN_ID).trim() || DEFAULT_WINDOWS_PLUGIN_ID;
  const vaultName = String(options.vaultName || "").trim();
  const vaultPath = String(options.vaultPath || "").trim();

  return [
    "$ErrorActionPreference = 'Stop'",
    "$discoveryDir = Join-Path $HOME '.systemsculpt/obsidian-automation'",
    "if (!(Test-Path $discoveryDir)) { throw 'No Windows bridge discovery files were found.' }",
    `$pluginId = ${psSingleQuote(pluginId)}`,
    `$vaultName = ${psSingleQuote(vaultName)}`,
    `$vaultPath = ${psSingleQuote(vaultPath)}`,
    "$records = Get-ChildItem -Path $discoveryDir -Filter *.json -ErrorAction Stop | ForEach-Object {",
    "  try {",
    "    $parsed = Get-Content -Raw $_.FullName | ConvertFrom-Json",
    "  } catch {",
    "    $parsed = $null",
    "  }",
    "  if (",
    "    $parsed -and",
    "    $parsed.pluginId -eq $pluginId -and",
    "    ((-not $vaultName) -or $parsed.vaultName -eq $vaultName) -and",
    "    ((-not $vaultPath) -or $parsed.vaultPath -eq $vaultPath)",
    "  ) {",
    "    [pscustomobject]@{",
    "      version = $parsed.version",
    "      bridge = $parsed.bridge",
    "      pluginId = $parsed.pluginId",
    "      pluginVersion = $parsed.pluginVersion",
    "      vaultName = $parsed.vaultName",
    "      vaultPath = $parsed.vaultPath",
    "      vaultConfigDir = $parsed.vaultConfigDir",
    "      vaultInstanceId = $parsed.vaultInstanceId",
    "      pid = $parsed.pid",
    "      host = $parsed.host",
    "      port = $parsed.port",
    "      token = $parsed.token",
    "      startedAt = $parsed.startedAt",
    "      discoveryFilePath = $_.FullName",
    "    }",
    "  }",
    "}",
    "$record = $records | Sort-Object startedAt -Descending | Select-Object -First 1",
    "if (-not $record) { throw 'No Windows bridge discovery files were found.' }",
    "$record | ConvertTo-Json -Compress -Depth 5",
    "",
  ].join("\n");
}

export function buildWindowsPluginManifestVersionScript(options = {}) {
  const pluginId = String(options.pluginId || DEFAULT_WINDOWS_PLUGIN_ID).trim() || DEFAULT_WINDOWS_PLUGIN_ID;
  const vaultPath = String(options.vaultPath || "").trim();

  return [
    "$ErrorActionPreference = 'Stop'",
    `$pluginId = ${psSingleQuote(pluginId)}`,
    `$vaultPath = ${psSingleQuote(vaultPath)}`,
    "if (-not $vaultPath) { throw 'Missing Windows vault path.' }",
    "$pluginDir = Join-Path (Join-Path $vaultPath '.obsidian/plugins') $pluginId",
    "$manifestPath = Join-Path $pluginDir 'manifest.json'",
    "if (!(Test-Path $manifestPath)) { throw ('Remote plugin manifest not found: ' + $manifestPath) }",
    "$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json",
    "[pscustomobject]@{ manifestPath = $manifestPath; version = $manifest.version } | ConvertTo-Json -Compress",
    "",
  ].join("\n");
}

export async function readExpectedLocalPluginVersion(options = {}) {
  const artifactRoot = path.resolve(String(options.artifactRoot || process.cwd()));
  const manifestPath = path.join(artifactRoot, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const version = String(manifest?.version || "").trim();
  if (!version) {
    fail(`manifest.json is missing a version: ${manifestPath}`);
  }
  return version;
}

export async function readLatestRemoteWindowsBridgeRecord(options = {}, dependencies = {}) {
  const runRemotePowerShellScriptImpl =
    dependencies.runRemotePowerShellScriptImpl || runRemotePowerShellScript;
  const stdout = await runRemotePowerShellScriptImpl(buildLatestWindowsBridgeRecordScript(options), {
    sshHost: String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST,
  });
  return parseJsonObjectText(stdout, "the latest Windows bridge record");
}

export async function readRemoteWindowsPluginManifestVersion(options = {}, dependencies = {}) {
  const runRemotePowerShellScriptImpl =
    dependencies.runRemotePowerShellScriptImpl || runRemotePowerShellScript;
  const stdout = await runRemotePowerShellScriptImpl(buildWindowsPluginManifestVersionScript(options), {
    sshHost: String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST,
  });
  return parseJsonObjectText(stdout, "the remote Windows plugin manifest");
}

export function buildWindowsBootstrapArgs(options = {}) {
  const args = [];
  const vaultName = String(options.vaultName || "").trim();
  const vaultPath = String(options.vaultPath || "").trim();
  const timeoutMs = Number(options.launchTimeoutMs || options.timeoutMs) || 0;

  if (vaultName) {
    args.push("--vault-name", vaultName);
  }
  if (vaultPath) {
    args.push("--vault-path", vaultPath);
  }
  if (timeoutMs > 0) {
    args.push("--timeout-ms", String(Math.max(1000, timeoutMs)));
  }
  args.push("--launch");
  return args;
}

function summarizeRecord(record) {
  if (!record || typeof record !== "object") {
    return {
      pluginVersion: null,
      startedAt: null,
      vaultName: null,
      vaultPath: null,
    };
  }
  return {
    pluginVersion: String(record.pluginVersion || "").trim() || null,
    startedAt: String(record.startedAt || "").trim() || null,
    vaultName: String(record.vaultName || "").trim() || null,
    vaultPath: String(record.vaultPath || "").trim() || null,
  };
}

export async function ensureFreshRemoteWindowsPluginVersion(options = {}, dependencies = {}) {
  const readExpectedLocalPluginVersionImpl =
    dependencies.readExpectedLocalPluginVersionImpl || readExpectedLocalPluginVersion;
  const readLatestRemoteWindowsBridgeRecordImpl =
    dependencies.readLatestRemoteWindowsBridgeRecordImpl ||
    ((runtimeOptions) =>
      readLatestRemoteWindowsBridgeRecord(runtimeOptions, {
        runRemotePowerShellScriptImpl: dependencies.runRemotePowerShellScriptImpl,
      }));
  const readRemoteWindowsPluginManifestVersionImpl =
    dependencies.readRemoteWindowsPluginManifestVersionImpl ||
    ((runtimeOptions) =>
      readRemoteWindowsPluginManifestVersion(runtimeOptions, {
        runRemotePowerShellScriptImpl: dependencies.runRemotePowerShellScriptImpl,
      }));
  const runWindowsNodeModuleRemotelyImpl =
    dependencies.runWindowsNodeModuleRemotelyImpl || runWindowsNodeModuleRemotely;
  const sleepImpl = dependencies.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowImpl = dependencies.nowImpl || (() => Date.now());

  const runtimeOptions = {
    sshHost: String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST,
    vaultName: String(options.vaultName || "").trim(),
    vaultPath: String(options.vaultPath || "").trim(),
    pluginId: String(options.pluginId || DEFAULT_WINDOWS_PLUGIN_ID).trim() || DEFAULT_WINDOWS_PLUGIN_ID,
  };
  const artifactRoot = path.resolve(String(options.artifactRoot || process.cwd()));
  const expectedPluginVersion =
    String(options.expectedPluginVersion || "").trim() ||
    (await readExpectedLocalPluginVersionImpl({ artifactRoot }));

  let beforeRecord = null;
  try {
    beforeRecord = await readLatestRemoteWindowsBridgeRecordImpl(runtimeOptions);
  } catch {}

  if (String(beforeRecord?.pluginVersion || "").trim() === expectedPluginVersion) {
    return {
      expectedPluginVersion,
      relaunched: false,
      before: summarizeRecord(beforeRecord),
      after: summarizeRecord(beforeRecord),
      bootstrap: null,
      remoteManifestVersion: null,
    };
  }

  let remoteManifestVersion = null;
  const manifestVaultPath = runtimeOptions.vaultPath || String(beforeRecord?.vaultPath || "").trim();
  if (manifestVaultPath) {
    try {
      const remoteManifest = await readRemoteWindowsPluginManifestVersionImpl({
        ...runtimeOptions,
        vaultPath: manifestVaultPath,
      });
      remoteManifestVersion = String(remoteManifest?.version || "").trim() || null;
    } catch {}
  }

  const bootstrapEntryPath =
    String(options.bootstrapEntryPath || "").trim() ||
    fileURLToPath(new URL("./bootstrap.mjs", import.meta.url));
  const bootstrapArgs = buildWindowsBootstrapArgs({
    vaultName: runtimeOptions.vaultName || String(beforeRecord?.vaultName || "").trim(),
    vaultPath: runtimeOptions.vaultPath || String(beforeRecord?.vaultPath || "").trim(),
    launchTimeoutMs: options.launchTimeoutMs,
  });
  const bootstrapStdout = await runWindowsNodeModuleRemotelyImpl(bootstrapEntryPath, {
    sshHost: runtimeOptions.sshHost,
    args: bootstrapArgs,
    artifactRoot,
  });

  let bootstrap = null;
  try {
    bootstrap = parseJsonObjectText(bootstrapStdout, "the Windows bootstrap result");
  } catch {}

  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_WINDOWS_RUNTIME_REFRESH_TIMEOUT_MS);
  const pollMs = Math.max(250, Number(options.pollMs) || DEFAULT_WINDOWS_RUNTIME_REFRESH_POLL_MS);
  const deadline = nowImpl() + timeoutMs;

  let afterRecord = null;
  let lastError = null;
  while (nowImpl() <= deadline) {
    try {
      afterRecord = await readLatestRemoteWindowsBridgeRecordImpl({
        ...runtimeOptions,
        vaultName: runtimeOptions.vaultName || String(beforeRecord?.vaultName || "").trim(),
        vaultPath: runtimeOptions.vaultPath || String(beforeRecord?.vaultPath || "").trim(),
      });
      if (String(afterRecord?.pluginVersion || "").trim() === expectedPluginVersion) {
        return {
          expectedPluginVersion,
          relaunched: true,
          before: summarizeRecord(beforeRecord),
          after: summarizeRecord(afterRecord),
          bootstrap,
          remoteManifestVersion,
        };
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleepImpl(pollMs);
  }

  const observedVersion = String(afterRecord?.pluginVersion || "").trim() || "unavailable";
  const manifestSummary = remoteManifestVersion ? ` Remote manifest=${remoteManifestVersion}.` : "";
  const detail = lastError
    ? ` Last probe failed: ${lastError instanceof Error ? lastError.message : String(lastError)}.`
    : "";
  fail(
    `Windows bridge plugin version stayed at ${observedVersion} after bootstrap relaunch; expected ${expectedPluginVersion}.${manifestSummary}${detail}`
  );
}
