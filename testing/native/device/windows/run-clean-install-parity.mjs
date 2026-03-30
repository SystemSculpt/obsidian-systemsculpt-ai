#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseCleanInstallParityArgs,
  runCleanInstallParityAgainstRecord,
  runWindowsCleanInstallParity,
} from "./clean-install-parity.mjs";
import {
  DEFAULT_WINDOWS_SSH_HOST,
  runRemotePowerShellScript,
  startSshLocalPortForward,
  stopChildProcess,
} from "./remote-run.mjs";

const KNOWN_PROVIDER_ENV_VARS = {
  anthropic: ["ANTHROPIC_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  xai: ["XAI_API_KEY"],
};

function fail(message) {
  throw new Error(message);
}

function parseJsonObjectText(rawText, label) {
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

export function parseArgs(argv, env = process.env) {
  const parity = parseCleanInstallParityArgs([], env);
  const options = {
    ...parity,
    sshHost: String(env.SYSTEMSCULPT_WINDOWS_SSH_HOST || "").trim() || DEFAULT_WINDOWS_SSH_HOST,
    apiKeyEnv: "",
    requireProvider: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") {
      options.sshHost = String(argv[index + 1] || "").trim() || options.sshHost;
      index += 1;
      continue;
    }
    if (arg === "--provider-id") {
      options.providerId = String(argv[index + 1] || "").trim().toLowerCase();
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
    if (arg === "--api-key-env") {
      options.apiKeyEnv = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--api-key") {
      options.apiKey = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
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
    if (arg === "--wait-timeout-ms") {
      options.waitTimeoutMs = Number(argv[index + 1]) || options.waitTimeoutMs;
      index += 1;
      continue;
    }
    if (arg === "--send-timeout-ms") {
      options.sendTimeoutMs = Number(argv[index + 1]) || options.sendTimeoutMs;
      index += 1;
      continue;
    }
    if (arg === "--require-provider") {
      options.requireProvider = true;
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
  console.log(`Usage: node testing/native/device/windows/run-clean-install-parity.mjs [options]

Run the Windows clean-install desktop acceptance lane from either:

- Windows directly, against the already-open trusted vault, or
- macOS/Linux by forwarding the Windows bridge locally over SSH and driving the
  same no-focus bridge API from this machine

Options:
  --host <alias>             SSH host alias. Default: ${DEFAULT_WINDOWS_SSH_HOST}
  --provider-id <id>         Optional provider id for Settings -> Providers parity
  --provider-model-id <id>   Optional provider model id or comma list
  --api-key-env <ENV_VAR>    Resolve the provider API key from a host env var
  --api-key <value>          Optional provider API key literal
  --require-provider         Fail if provider credentials are not available
  --managed-model-id <id>    Managed model id override
  --local-pi-model-id <id>   Local Pi model id override
  --wait-timeout-ms <n>      Provider/model wait timeout override
  --send-timeout-ms <n>      Chat send timeout override
`);
}

export function resolveKnownProviderEnvCandidates(providerId) {
  return Array.from(new Set(KNOWN_PROVIDER_ENV_VARS[String(providerId || "").trim().toLowerCase()] || []));
}

export function resolveProviderApiKey(options, env = process.env) {
  if (options.apiKey) {
    return String(options.apiKey).trim();
  }

  const explicitEnv = String(options.apiKeyEnv || "").trim();
  if (explicitEnv) {
    return String(env[explicitEnv] || "").trim();
  }

  const directEnvValue = String(env.SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY || "").trim();
  if (directEnvValue) {
    return directEnvValue;
  }

  const mappingRaw = String(env.SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS || "").trim();
  if (mappingRaw && options.providerId) {
    try {
      const parsed = JSON.parse(mappingRaw);
      const mapped = parsed && typeof parsed === "object" ? parsed[options.providerId] : "";
      const mappedValue = String(mapped || "").trim();
      if (mappedValue) {
        return mappedValue;
      }
    } catch {}
  }

  for (const envName of resolveKnownProviderEnvCandidates(options.providerId)) {
    const candidate = String(env[envName] || "").trim();
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

export function buildLatestWindowsBridgeRecordScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$discoveryDir = Join-Path $HOME '.systemsculpt/obsidian-automation'",
    "$records = Get-ChildItem -Path $discoveryDir -Filter *.json -ErrorAction Stop | ForEach-Object {",
    "  $parsed = Get-Content -Raw $_.FullName | ConvertFrom-Json",
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
    "$record = $records | Sort-Object startedAt -Descending | Select-Object -First 1",
    "if (-not $record) {",
    "  throw 'No Windows bridge discovery files were found.'",
    "}",
    "$record | ConvertTo-Json -Compress -Depth 5",
    "",
  ].join("\n");
}

export function buildWindowsLocalPiStatusScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$modelsPath = Join-Path $HOME '.pi/models.json'",
    "$authPath = Join-Path $HOME '.pi/auth.json'",
    "$piCommand = Get-Command pi -ErrorAction SilentlyContinue",
    "[pscustomobject]@{",
    "  piCommandPath = if ($piCommand) { $piCommand.Source } else { $null }",
    "  modelsFileExists = Test-Path $modelsPath",
    "  authFileExists = Test-Path $authPath",
    "} | ConvertTo-Json -Compress",
    "",
  ].join("\n");
}

export function parseWindowsBridgeRecord(rawText) {
  const parsed = parseJsonObjectText(rawText, "the Windows bridge discovery record");
  if (!String(parsed.token || "").trim()) {
    fail("Windows bridge discovery record is missing its token.");
  }
  if (!Number.isFinite(Number(parsed.port)) || Number(parsed.port) <= 0) {
    fail("Windows bridge discovery record is missing a valid port.");
  }

  return parsed;
}

export function parseWindowsLocalPiStatus(rawText) {
  const parsed = parseJsonObjectText(rawText, "the Windows local Pi probe");
  return {
    piCommandPath: String(parsed.piCommandPath || "").trim() || null,
    modelsFileExists: Boolean(parsed.modelsFileExists),
    authFileExists: Boolean(parsed.authFileExists),
  };
}

export function assertNoLocalPiInstalled(status) {
  const summary = {
    piCommandPath: String(status?.piCommandPath || "").trim() || null,
    modelsFileExists: Boolean(status?.modelsFileExists),
    authFileExists: Boolean(status?.authFileExists),
  };
  const reasons = [];
  if (summary.piCommandPath) {
    reasons.push(`pi command at ${summary.piCommandPath}`);
  }
  if (summary.modelsFileExists) {
    reasons.push("~/.pi/models.json");
  }
  if (reasons.length > 0) {
    fail(
      `Windows clean-install parity requires no local Pi install. Detected ${reasons.join(
        " and "
      )}.`
    );
  }
  return summary;
}

export async function readLatestWindowsBridgeRecord(options = {}) {
  const stdout = await runRemotePowerShellScript(buildLatestWindowsBridgeRecordScript(), {
    sshHost: options.sshHost,
  });
  return parseWindowsBridgeRecord(stdout);
}

export async function readLatestWindowsLocalPiStatus(options = {}) {
  const stdout = await runRemotePowerShellScript(buildWindowsLocalPiStatusScript(), {
    sshHost: options.sshHost,
  });
  return parseWindowsLocalPiStatus(stdout);
}

function readLocalWindowsPiStatus() {
  const homeDir = os.homedir();
  const modelsPath = path.win32.resolve(homeDir, ".pi", "models.json");
  const authPath = path.win32.resolve(homeDir, ".pi", "auth.json");
  const result = spawnSync("where", ["pi"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const piCommandPath = String(result.stdout || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean) || null;

  return {
    piCommandPath,
    modelsFileExists: fs.existsSync(modelsPath),
    authFileExists: fs.existsSync(authPath),
  };
}

export async function withForwardedWindowsBridgeRecord(record, options = {}, operation) {
  const forward = await startSshLocalPortForward({
    ...options,
    sshHost: options.sshHost,
    remoteHost: String(record.host || "127.0.0.1"),
    remotePort: Number(record.port),
  });
  try {
    return await operation({
      ...record,
      host: "127.0.0.1",
      port: forward.localPort,
      forwardedPort: Number(record.port),
      forwardedHost: String(record.host || "127.0.0.1"),
    });
  } finally {
    await stopChildProcess(forward.process);
  }
}

export async function runCleanInstallParity(options, env = process.env) {
  const apiKey = resolveProviderApiKey(options, env);
  const providerRequested = Boolean(options.providerId);

  if (providerRequested && !apiKey) {
    fail(
      `Provider "${options.providerId}" was requested but no API key was resolved. Supply --api-key, --api-key-env, SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEY, SYSTEMSCULPT_DESKTOP_PROVIDER_API_KEYS, or a known provider env var.`
    );
  }
  if (options.requireProvider && !providerRequested) {
    fail("The provider-connected Windows lane requires --provider-id.");
  }

  if (process.platform === "win32") {
    const windowsHost = assertNoLocalPiInstalled(readLocalWindowsPiStatus());
    const result = await runWindowsCleanInstallParity({
      ...options,
      apiKey,
      apiKeyFile: "",
    });
    return {
      ...result,
      windowsHost,
    };
  }

  const windowsHost = assertNoLocalPiInstalled(
    await readLatestWindowsLocalPiStatus({
      sshHost: options.sshHost,
    })
  );
  const remoteRecord = await readLatestWindowsBridgeRecord({
    sshHost: options.sshHost,
  });

  const result = await withForwardedWindowsBridgeRecord(remoteRecord, options, async (forwardedRecord) => {
    return await runCleanInstallParityAgainstRecord(forwardedRecord, {
      ...options,
      apiKey,
      apiKeyFile: "",
    });
  });
  return {
    ...result,
    windowsHost,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const result = await runCleanInstallParity(options, process.env);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[windows-clean-install-runner] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
