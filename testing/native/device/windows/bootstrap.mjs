#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WINDOWS_VAULT_NAME,
  WINDOWS_LOCAL_PI_ENV_KEYS,
  prepareWindowsDesktopVault,
  readJsonIfExists,
  resolveDefaultWindowsPiAgentDir,
  resolveDefaultWindowsSyncConfigPath,
  resolveDefaultWindowsVaultPath,
  resolveWindowsInteractiveTempRoot,
  upsertObsidianVaultRegistry,
  writeJson,
} from "./common.mjs";
import { runInteractiveWindowsPowerShell } from "./interactive-task.mjs";

function toPowerShellArrayLiteral(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "@()";
  }
  return `@(${values.map((value) => JSON.stringify(String(value))).join(", ")})`;
}

export function buildWindowsLaunchScript(options = {}) {
  const obsidianExe = JSON.stringify(String(options.obsidianExe || "").trim());
  const piAgentDir = JSON.stringify(String(options.piAgentDir || "").trim());
  const resultPath = JSON.stringify(String(options.resultPath || "").trim());
  const clearedEnvKeys = toPowerShellArrayLiteral(
    Array.isArray(options.clearedEnvKeys) ? options.clearedEnvKeys : []
  );
  const vaultPath = JSON.stringify(String(options.vaultPath || "").trim());

  return [
    "$ErrorActionPreference = 'Stop'",
    `$resultPath = ${resultPath}`,
    `$obsidianExe = ${obsidianExe}`,
    `$piAgentDir = ${piAgentDir}`,
    `$vaultPath = ${vaultPath}`,
    "$cleared = @()",
    `foreach ($name in ${clearedEnvKeys}) {`,
    "  if (Test-Path (\"Env:\" + $name)) {",
    "    Remove-Item (\"Env:\" + $name) -ErrorAction SilentlyContinue",
    "    $cleared += $name",
    "  }",
    "}",
    "$env:PI_CODING_AGENT_DIR = $piAgentDir",
    "if (!(Test-Path $obsidianExe)) { throw ('Obsidian executable not found: ' + $obsidianExe) }",
    "if (!(Test-Path $vaultPath)) { throw ('Prepared vault path not found: ' + $vaultPath) }",
    "$process = Start-Process -FilePath $obsidianExe -ArgumentList @($vaultPath) -PassThru",
    "Start-Sleep -Seconds 2",
    "$result = [ordered]@{",
    "  ok = $true",
    "  sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId",
    "  obsidianPid = $process.Id",
    "  obsidianExe = $obsidianExe",
    "  vaultPath = $vaultPath",
    "  piAgentDir = $piAgentDir",
    "  clearedEnvKeys = $cleared",
    "  startedAt = (Get-Date).ToString('o')",
    "}",
    "$result | ConvertTo-Json -Depth 5 | Set-Content -Path $resultPath -Encoding UTF8",
    "",
  ].join("\n");
}

export function resolveWindowsBootstrapOptions(argv, env = process.env) {
  const repoRoot = path.resolve(process.cwd());
  const options = {
    vaultName: DEFAULT_WINDOWS_VAULT_NAME,
    vaultPath: "",
    syncConfigPath: resolveDefaultWindowsSyncConfigPath({ repoRoot }),
    piAgentDir: "",
    obsidianExe: path.join(String(env.LOCALAPPDATA || ""), "Programs", "Obsidian", "Obsidian.exe"),
    appDataPath: path.join(String(env.APPDATA || ""), "Obsidian"),
    resetVault: false,
    launch: false,
    keepExistingObsidian: false,
    timeoutMs: 90_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--vault-name") {
      options.vaultName = String(argv[index + 1] || "").trim() || options.vaultName;
      index += 1;
      continue;
    }
    if (arg === "--vault-path") {
      options.vaultPath = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--sync-config") {
      options.syncConfigPath = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--pi-agent-dir") {
      options.piAgentDir = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--obsidian-exe") {
      options.obsidianExe = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--appdata") {
      options.appDataPath = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--reset-vault") {
      options.resetVault = true;
      continue;
    }
    if (arg === "--launch") {
      options.launch = true;
      continue;
    }
    if (arg === "--keep-existing-obsidian") {
      options.keepExistingObsidian = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Math.max(1000, Number(argv[index + 1]) || options.timeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const vaultPath = options.vaultPath || resolveDefaultWindowsVaultPath({ vaultName: options.vaultName, env });
  return {
    ...options,
    repoRoot,
    vaultPath,
    piAgentDir: options.piAgentDir || resolveDefaultWindowsPiAgentDir(vaultPath),
  };
}

function usage() {
  console.log(`Usage: node testing/native/device/windows/bootstrap.mjs [options]

Prepare the canonical Windows clean-install vault for desktop validation and,
optionally, relaunch Obsidian in the active interactive session with a clean
local-Pi environment override.

Options:
  --vault-name <name>        Vault name under %USERPROFILE%\\Documents. Default: ${DEFAULT_WINDOWS_VAULT_NAME}
  --vault-path <path>        Absolute vault path to prepare instead of the default Documents path
  --sync-config <path>       Output sync config path. Default: ./systemsculpt-sync.windows.generated.json
  --pi-agent-dir <path>      Empty Pi agent dir for the clean-install launch
  --obsidian-exe <path>      Obsidian executable path
  --appdata <path>           Obsidian app-data directory
  --reset-vault              Delete and recreate the target vault before copying artifacts
  --launch                   Relaunch Obsidian through an interactive scheduled task after prep
  --keep-existing-obsidian   Skip the pre-launch Obsidian shutdown step
  --timeout-ms <n>           Interactive launch timeout. Default: 90000
  --help, -h                 Show this help
`);
}

async function syncVaultIntoObsidianRegistry({ appDataPath, vaultPath, vaultName }) {
  const obsidianJsonPath = path.join(appDataPath, "obsidian.json");
  const existing = await readJsonIfExists(obsidianJsonPath);
  const next = upsertObsidianVaultRegistry(existing, {
    vaultPath,
    vaultName,
    open: true,
  });
  await writeJson(obsidianJsonPath, next);
  return { obsidianJsonPath, state: next };
}

function runWindowsCommand(script) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      stdio: "pipe",
    }
  );
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Windows command failed with exit code ${result.status ?? "unknown"}.${output ? `\n${output}` : ""}`
    );
  }
  return result;
}

async function launchPreparedVault(options) {
  if (!options.keepExistingObsidian) {
    runWindowsCommand(
      "try { $obsidianProcess = [System.Diagnostics.Process]::GetProcessesByName('Obsidian'); if ($obsidianProcess) { $obsidianProcess | Stop-Process -Force -ErrorAction SilentlyContinue } } catch {}; exit 0"
    );
  }

  const resultPath = path.join(
    resolveWindowsInteractiveTempRoot(process.env),
    `systemsculpt-obsidian-launch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`
  );
  const taskResult = await runInteractiveWindowsPowerShell({
    taskNamePrefix: "SystemSculptObsidianLaunch",
    timeoutMs: options.timeoutMs,
    resultPath,
    scriptContent: buildWindowsLaunchScript({
      obsidianExe: options.obsidianExe,
      piAgentDir: options.piAgentDir,
      vaultPath: options.vaultPath,
      resultPath,
      clearedEnvKeys: WINDOWS_LOCAL_PI_ENV_KEYS,
    }),
  });

  return {
    resultPath,
    launch: taskResult.parsed || null,
  };
}

export async function runWindowsBootstrap(options) {
  if (process.platform !== "win32") {
    throw new Error("Windows desktop bootstrap must run on the Windows host.");
  }

  const prepared = await prepareWindowsDesktopVault({
    repoRoot: options.repoRoot,
    vaultPath: options.vaultPath,
    vaultName: options.vaultName,
    syncConfigPath: options.syncConfigPath,
    piAgentDir: options.piAgentDir,
    resetVault: options.resetVault,
    env: process.env,
  });

  const registry = await syncVaultIntoObsidianRegistry({
    appDataPath: options.appDataPath,
    vaultPath: prepared.vaultPath,
    vaultName: prepared.vaultName,
  });

  const result = {
    ...prepared,
    obsidianExe: options.obsidianExe,
    appDataPath: options.appDataPath,
    obsidianJsonPath: registry.obsidianJsonPath,
    launch: null,
  };

  if (options.launch) {
    const launchResult = await launchPreparedVault(options);
    result.launch = launchResult.launch;
    result.launchResultPath = launchResult.resultPath;
  }

  return result;
}

async function main() {
  const options = resolveWindowsBootstrapOptions(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const result = await runWindowsBootstrap(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[windows-bootstrap] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
