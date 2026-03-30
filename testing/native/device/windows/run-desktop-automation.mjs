#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runDesktopAutomation } from "../../desktop-automation/runner.mjs";
import { waitForStableDesktopAutomationClient } from "../../desktop-automation/client.mjs";
import {
  DEFAULT_PLUGIN_ID,
  matchesDiscoveryEntry,
} from "../../desktop-automation/discovery.mjs";
import {
  DEFAULT_FIXTURE_DIR,
  DEFAULT_PAUSE_MS,
  DEFAULT_REPEAT,
  DEFAULT_WEB_FETCH_URL,
  DEFAULT_YOUTUBE_URL,
} from "../../runtime-smoke/constants.mjs";
import {
  DEFAULT_WINDOWS_SSH_HOST,
  runRemotePowerShellScript,
  startSshLocalPortForward,
  stopChildProcess,
} from "./remote-run.mjs";
import {
  assertNoLocalPiInstalled,
  readLatestWindowsLocalPiStatus,
} from "./run-clean-install-parity.mjs";
import { ensureFreshRemoteWindowsPluginVersion } from "./runtime-version.mjs";

const DEFAULT_DISCOVERY_CACHE_TTL_MS = 250;

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const options = {
    caseName: "all",
    syncConfigPath: "",
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
    allowSingleModelFallback: false,
    sshHost: String(process.env.SYSTEMSCULPT_WINDOWS_SSH_HOST || "").trim() || DEFAULT_WINDOWS_SSH_HOST,
    allowLocalPi: false,
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
      const parsedRepeat = Number.parseInt(String(argv[index + 1] || ""), 10);
      options.repeat = Math.max(1, Number.isFinite(parsedRepeat) ? parsedRepeat : options.repeat);
      index += 1;
      continue;
    }
    if (arg === "--pause-ms") {
      const parsedPauseMs = Number.parseInt(String(argv[index + 1] || ""), 10);
      options.pauseMs = Math.max(0, Number.isFinite(parsedPauseMs) ? parsedPauseMs : options.pauseMs);
      index += 1;
      continue;
    }
    if (arg === "--json-output") {
      options.jsonOutput = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--host") {
      options.sshHost = String(argv[index + 1] || "").trim() || options.sshHost;
      index += 1;
      continue;
    }
    if (arg === "--no-reload") {
      options.reload = false;
      continue;
    }
    if (arg === "--allow-single-model-fallback") {
      options.allowSingleModelFallback = true;
      continue;
    }
    if (arg === "--allow-local-pi") {
      options.allowLocalPi = true;
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
  console.log(`Usage: node testing/native/device/windows/run-desktop-automation.mjs [options]

Run no-focus desktop automation against the already-open Windows Obsidian vault
by reading the live Windows bridge discovery over SSH and forwarding the bridge
locally on demand.

Options:
  --case <name|all|extended|stress|soak>   Same cases as testing/native/desktop-automation/run.mjs
  --host <alias>                           SSH host alias. Default: ${DEFAULT_WINDOWS_SSH_HOST}
  --vault-name <name>                      Filter to one Windows vault name
  --vault-path <path>                      Filter to one Windows vault path
  --fixture-dir <path>                     Vault-relative fixture folder. Default: ${DEFAULT_FIXTURE_DIR}
  --web-fetch-url <url>                    URL for the direct web-fetch bridge case. Default: ${DEFAULT_WEB_FETCH_URL}
  --youtube-url <url>                      URL for the direct YouTube transcript bridge case. Default: ${DEFAULT_YOUTUBE_URL}
  --repeat <n>                             Repeat count. Default: ${DEFAULT_REPEAT}
  --pause-ms <n>                           Delay between iterations. Default: ${DEFAULT_PAUSE_MS}
  --json-output <path>                     Write the final JSON report to this path as well as stdout
  --no-reload                              Reuse the live bridge instead of forcing a bootstrap reload
  --allow-single-model-fallback            Allow fresh-install fallback coverage when only one authenticated model exists
  --allow-local-pi                         Skip the default no-local-Pi preflight
`);
}

export function buildListWindowsBridgeRecordsScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$discoveryDir = Join-Path $HOME '.systemsculpt/obsidian-automation'",
    "if (!(Test-Path $discoveryDir)) { '[]'; exit 0 }",
    "$records = Get-ChildItem -Path $discoveryDir -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try {",
    "    $parsed = Get-Content -Raw $_.FullName | ConvertFrom-Json",
    "  } catch {",
    "    $parsed = $null",
    "  }",
    "  if ($parsed -and $parsed.pluginId -eq 'systemsculpt-ai') {",
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
    "$records | Sort-Object startedAt -Descending | ConvertTo-Json -Compress -Depth 5",
    "",
  ].join("\n");
}

export function parseJsonPayloadText(rawText, label) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    fail(`${label} returned no data.`);
  }

  const candidateTexts = [trimmed];
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidateTexts.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidateTexts.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  let lastError = null;
  for (const candidate of candidateTexts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to parse ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export function parseRemoteBridgeRecords(rawText) {
  const parsed = parseJsonPayloadText(rawText, "the Windows bridge discovery list");
  const records = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return records
    .filter((record) => record && typeof record === "object")
    .sort((left, right) => String(right.startedAt || "").localeCompare(String(left.startedAt || "")));
}

export function selectLatestRemoteBridgeRecord(records, filters = {}) {
  const normalizedFilters = {
    pluginId: String(filters.pluginId || DEFAULT_PLUGIN_ID).trim() || DEFAULT_PLUGIN_ID,
    vaultName: String(filters.vaultName || "").trim(),
    vaultPath: String(filters.vaultPath || "").trim(),
    vaultInstanceId: String(filters.vaultInstanceId || "").trim(),
    excludeStartedAt: String(filters.excludeStartedAt || "").trim(),
  };

  for (const record of Array.isArray(records) ? records : []) {
    if (
      matchesDiscoveryEntry(record, {
        pluginId: normalizedFilters.pluginId,
        vaultName: normalizedFilters.vaultName || undefined,
        vaultPath: normalizedFilters.vaultPath || undefined,
        vaultInstanceId: normalizedFilters.vaultInstanceId || undefined,
        excludeStartedAt: normalizedFilters.excludeStartedAt || undefined,
      })
    ) {
      return record;
    }
  }

  return null;
}

function discoveryCacheKey(filters = {}) {
  return JSON.stringify({
    pluginId: String(filters.pluginId || DEFAULT_PLUGIN_ID).trim() || DEFAULT_PLUGIN_ID,
    vaultName: String(filters.vaultName || "").trim(),
    vaultPath: String(filters.vaultPath || "").trim(),
    vaultInstanceId: String(filters.vaultInstanceId || "").trim(),
    excludeStartedAt: String(filters.excludeStartedAt || "").trim(),
  });
}

export class WindowsForwardedBridgeDiscovery {
  constructor(options = {}) {
    this.sshHost = String(options.sshHost || DEFAULT_WINDOWS_SSH_HOST).trim() || DEFAULT_WINDOWS_SSH_HOST;
    this.cacheTtlMs = Math.max(0, Number(options.cacheTtlMs) || DEFAULT_DISCOVERY_CACHE_TTL_MS);
    this.forward = null;
    this.cachedAt = 0;
    this.cachedEntries = [];
    this.cachedKey = "";
  }

  matchesForward(record) {
    if (!this.forward || !record) {
      return false;
    }
    return (
      this.forward.process &&
      this.forward.process.exitCode === null &&
      !this.forward.process.killed &&
      String(this.forward.remoteRecord?.startedAt || "").trim() ===
        String(record.startedAt || "").trim() &&
      Number(this.forward.remoteRecord?.port) === Number(record.port) &&
      String(this.forward.remoteRecord?.token || "").trim() ===
        String(record.token || "").trim()
    );
  }

  async fetchRemoteRecords() {
    const stdout = await runRemotePowerShellScript(buildListWindowsBridgeRecordsScript(), {
      sshHost: this.sshHost,
    });
    return parseRemoteBridgeRecords(stdout);
  }

  async ensureForward(record) {
    if (this.matchesForward(record)) {
      return {
        ...record,
        host: "127.0.0.1",
        port: this.forward.localPort,
        forwardedHost: String(record.host || "127.0.0.1"),
        forwardedPort: Number(record.port),
      };
    }

    await this.closeForward();
    const forward = await startSshLocalPortForward({
      sshHost: this.sshHost,
      remoteHost: String(record.host || "127.0.0.1"),
      remotePort: Number(record.port),
    });
    this.forward = {
      ...forward,
      remoteRecord: { ...record },
    };

    return {
      ...record,
      host: "127.0.0.1",
      port: forward.localPort,
      forwardedHost: String(record.host || "127.0.0.1"),
      forwardedPort: Number(record.port),
    };
  }

  async loadEntries(filters = {}) {
    const cacheKey = discoveryCacheKey(filters);
    if (
      this.cachedKey === cacheKey &&
      Date.now() - this.cachedAt <= this.cacheTtlMs &&
      (this.cachedEntries.length === 0 || this.matchesForward(this.cachedEntries[0]))
    ) {
      return this.cachedEntries;
    }

    const remoteRecord = selectLatestRemoteBridgeRecord(await this.fetchRemoteRecords(), filters);
    if (!remoteRecord) {
      this.cachedKey = cacheKey;
      this.cachedAt = Date.now();
      this.cachedEntries = [];
      return [];
    }

    const forwardedRecord = await this.ensureForward(remoteRecord);
    this.cachedKey = cacheKey;
    this.cachedAt = Date.now();
    this.cachedEntries = [forwardedRecord];
    return this.cachedEntries;
  }

  async closeForward() {
    if (this.forward?.process) {
      await stopChildProcess(this.forward.process);
    }
    this.forward = null;
  }

  async close() {
    this.cachedEntries = [];
    this.cachedKey = "";
    this.cachedAt = 0;
    await this.closeForward();
  }
}

function buildDiscoveryFilters(baseOptions, dynamicOptions = {}) {
  return {
    pluginId: DEFAULT_PLUGIN_ID,
    vaultName: String(dynamicOptions.vaultName || baseOptions.vaultName || "").trim(),
    vaultPath: String(dynamicOptions.vaultPath || baseOptions.vaultPath || "").trim(),
    vaultInstanceId: String(dynamicOptions.vaultInstanceId || "").trim(),
    excludeStartedAt: String(dynamicOptions.excludeStartedAt || "").trim(),
  };
}

async function waitForWindowsClient(discovery, baseOptions, dynamicOptions = {}) {
  const filters = buildDiscoveryFilters(baseOptions, dynamicOptions);
  return await waitForStableDesktopAutomationClient({
    ...dynamicOptions,
    ...filters,
    loadEntries: async (options = {}) => {
      return await discovery.loadEntries(buildDiscoveryFilters(baseOptions, options));
    },
  });
}

function buildSyntheticTarget(baseOptions, ping) {
  const vaultPath = String(ping?.vaultPath || baseOptions.vaultPath || "").trim();
  const vaultName =
    String(ping?.vaultName || baseOptions.vaultName || "").trim() || "SystemSculptWindowsQA";

  return {
    index: 0,
    configPath: null,
    pluginDir: null,
    dataFilePath: null,
    manifestFilePath: null,
    mainFilePath: null,
    vaultRoot: vaultPath,
    vaultName,
    sshHost: baseOptions.sshHost,
    remote: true,
  };
}

function summarizeRuntimeVersionRefresh(refresh) {
  if (!refresh) {
    return null;
  }
  return {
    expectedPluginVersion: String(refresh.expectedPluginVersion || "").trim() || null,
    relaunched: Boolean(refresh.relaunched),
    beforePluginVersion: String(refresh.before?.pluginVersion || "").trim() || null,
    afterPluginVersion: String(refresh.after?.pluginVersion || "").trim() || null,
    beforeStartedAt: String(refresh.before?.startedAt || "").trim() || null,
    afterStartedAt: String(refresh.after?.startedAt || "").trim() || null,
    remoteManifestVersion: String(refresh.remoteManifestVersion || "").trim() || null,
  };
}

export async function runWindowsDesktopAutomation(options, dependencies = {}) {
  const discovery =
    dependencies.discovery instanceof WindowsForwardedBridgeDiscovery
      ? dependencies.discovery
      : new WindowsForwardedBridgeDiscovery({
          sshHost: options.sshHost,
          cacheTtlMs: dependencies.cacheTtlMs,
        });

  if (!options.allowLocalPi) {
    assertNoLocalPiInstalled(
      await readLatestWindowsLocalPiStatus({
        sshHost: options.sshHost,
      })
    );
  }

  const runtimeVersionRefresh = await ensureFreshRemoteWindowsPluginVersion(
    {
      sshHost: options.sshHost,
      vaultName: options.vaultName,
      vaultPath: options.vaultPath,
      artifactRoot: process.cwd(),
    },
    dependencies.runtimeVersionDependencies
  );
  if (runtimeVersionRefresh.relaunched) {
    console.log(
      `[windows-desktop-automation] Relaunched Windows Obsidian to refresh plugin version ${runtimeVersionRefresh.before.pluginVersion || "missing"} -> ${runtimeVersionRefresh.after.pluginVersion || "missing"}`
    );
  }

  try {
    const payload = await runDesktopAutomation(
      {
        ...options,
        waitForStableClient: async (waitOptions) => {
          return await waitForWindowsClient(discovery, options, waitOptions);
        },
      },
      {
        ...dependencies,
        bootstrapDesktopAutomationClient: async (bootstrapOptions = {}) => {
          let client = await waitForWindowsClient(discovery, options, bootstrapOptions);
          let reload = {
            method: "none",
            focusPreserved: true,
          };

          if (bootstrapOptions.reload !== false) {
            const previous = await client.ping().catch(() => client.record || {});
            const previousStartedAt = String(previous?.startedAt || "").trim() || undefined;
            await client.reloadPlugin();
            client = await waitForWindowsClient(discovery, options, {
              ...bootstrapOptions,
              excludeStartedAt: previousStartedAt,
            });
            reload = {
              method: "bridge",
              previousStartedAt: previousStartedAt || null,
              focusPreserved: true,
            };
          }

          const ping = await client.ping();
          return {
            client,
            target: buildSyntheticTarget(options, ping),
            ensured: {
              dataFilePath: null,
              existed: true,
              wrote: false,
              seedSource: "remote-bridge",
              seedVaultName: null,
              vaultInstanceId:
                String(ping?.vaultInstanceId || client?.record?.vaultInstanceId || "").trim() ||
                null,
              desktopAutomationBridgeEnabled: true,
              settings: {
                selectedModelId:
                  typeof ping?.selectedModelId === "string" ? ping.selectedModelId : null,
                settingsMode: "advanced",
              },
            },
            reload,
          };
        },
      }
    );
    return {
      ...payload,
      runtimeVersionRefresh: summarizeRuntimeVersionRefresh(runtimeVersionRefresh),
    };
  } finally {
    await discovery.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const payload = await runWindowsDesktopAutomation(options);
  console.log(JSON.stringify(payload, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      `[windows-desktop-automation] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
