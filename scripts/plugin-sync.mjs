#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { inspectPluginArtifacts, REQUIRED_PLUGIN_ARTIFACTS } from "./plugin-artifacts.mjs";

export const DEFAULT_SYNC_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.config.json");
export const LEGACY_ENV_AUTO_SYNC_PATH_KEY = "SYSTEMSCULPT_AUTO_SYNC_PATH";
export const LEGACY_RELEASE_EXTRAS = [
  "README.md",
  "LICENSE",
  "versions.json",
  "studio-terminal-sidecar.cjs",
  "studio-terminal-server.cjs",
  "systemsculpt-pi-provider-extension.mjs",
  "node_modules",
  ".systemsculpt-runtime-sync.json",
];

function resolvePathFromRoot(root, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(root, targetPath);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function clearDestinationPath(targetPath) {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  });
}

function parseBooleanFlag(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

function quotePowerShellLiteral(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function normalizeWindowsRemotePath(remotePath) {
  return String(remotePath || "").trim().replace(/\\/g, "/");
}

function withTrailingForwardSlash(remotePath) {
  const normalized = normalizeWindowsRemotePath(remotePath).replace(/\/+$/, "");
  return `${normalized}/`;
}

function formatScpRemotePath(remotePath) {
  const normalized = withTrailingForwardSlash(remotePath);
  if (/[\s"]/u.test(normalized)) {
    return `"${normalized.replace(/"/g, '\\"')}"`;
  }
  return normalized;
}

function encodePowerShell(scriptContent) {
  return Buffer.from(String(scriptContent || ""), "utf16le").toString("base64");
}

function formatCommandFailure(command, args, result) {
  const output = [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim();
  return `${command} ${args.join(" ")} failed.${output ? `\n${output}` : ""}`;
}

function runCommand(command, args, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    env: options.env || process.env,
  });

  if (result?.error) {
    throw result.error;
  }

  if ((result?.status ?? 1) !== 0) {
    throw new Error(formatCommandFailure(command, args, result));
  }

  return result;
}

function runRemoteWindowsPowerShell(target, scriptContent, options = {}) {
  const shell = String(target.shell || "powershell.exe").trim() || "powershell.exe";
  const encoded = encodePowerShell(scriptContent);
  return runCommand("ssh", [
    target.host,
    `${shell} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
  ], options);
}

function buildRemoteWindowsPrepScript(targetPath) {
  const legacyPaths = LEGACY_RELEASE_EXTRAS.map((value) => quotePowerShellLiteral(value)).join(", ");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$targetPath = ${quotePowerShellLiteral(targetPath)}`,
    "New-Item -ItemType Directory -Path $targetPath -Force | Out-Null",
    `$legacyPaths = @(${legacyPaths})`,
    "foreach ($relativePath in $legacyPaths) {",
    "  $candidate = Join-Path $targetPath $relativePath",
    "  if (Test-Path $candidate) {",
    "    Remove-Item $candidate -Recurse -Force -ErrorAction SilentlyContinue",
    "  }",
    "}",
    "",
  ].join("\n");
}

function copyFile(fileName, { root, destDir }) {
  const sourcePath = path.join(root, fileName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Required file missing: ${sourcePath}`);
  }
  ensureDir(destDir);
  const destPath = path.join(destDir, path.basename(fileName));
  fs.copyFileSync(sourcePath, destPath);
}

function copyDirectory(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source directory missing: ${sourcePath}`);
  }

  const stats = fs.statSync(sourcePath);
  if (!stats.isDirectory()) {
    throw new Error(`Expected directory, got file: ${sourcePath}`);
  }

  ensureDir(destinationPath);
  for (const entry of fs.readdirSync(sourcePath)) {
    if (entry === ".obsidian") {
      continue;
    }
    const entrySourcePath = path.join(sourcePath, entry);
    const entryDestinationPath = path.join(destinationPath, entry);
    const entryStats = fs.statSync(entrySourcePath);
    if (entryStats.isDirectory()) {
      copyDirectory(entrySourcePath, entryDestinationPath);
      continue;
    }
    fs.copyFileSync(entrySourcePath, entryDestinationPath);
  }
}

function copyExtraEntries(target, root) {
  if (!Array.isArray(target.extraCopies)) {
    return;
  }

  for (const extra of target.extraCopies) {
    if (!extra?.source || !extra?.destination) {
      continue;
    }
    const sourcePath = resolvePathFromRoot(root, extra.source);
    const destinationPath = path.join(target.path, extra.destination);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Extra copy source missing: ${sourcePath}`);
    }
    if (fs.statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
      continue;
    }
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function normalizeExtraCopies(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      source: String(entry.source || "").trim(),
      destination: String(entry.destination || "").trim(),
    }))
    .filter((entry) => entry.source && entry.destination);
}

function normalizeLocalTarget(entry, options = {}) {
  const rawPath = String(entry?.path || "").trim();
  if (!rawPath) {
    return null;
  }
  return {
    type: "local",
    group: options.group || "pluginTargets",
    path: resolvePathFromRoot(options.root || process.cwd(), rawPath),
    extraCopies: normalizeExtraCopies(entry?.extraCopies),
    label: String(entry?.label || "").trim(),
  };
}

function normalizeWindowsSshTarget(entry, options = {}) {
  const rawPath = String(entry?.path || "").trim();
  const host = String(entry?.host || "").trim();
  if (!rawPath) {
    return null;
  }
  if (!host) {
    throw new Error(`Windows SSH target ${rawPath} is missing a host.`);
  }
  return {
    type: "windows-ssh",
    group: options.group || "mirrorTargets",
    host,
    path: normalizeWindowsRemotePath(rawPath),
    label: String(entry?.label || "").trim(),
    shell: String(entry?.shell || "powershell.exe").trim() || "powershell.exe",
  };
}

function normalizeConfigTarget(entry, options = {}) {
  const declaredType = String(entry?.type || "").trim().toLowerCase();
  if (declaredType === "windows-ssh") {
    return normalizeWindowsSshTarget(entry, options);
  }
  if (declaredType && declaredType.startsWith("windows-")) {
    throw new Error(`Unsupported Windows sync target type: ${declaredType}`);
  }
  return normalizeLocalTarget(entry, options);
}

function normalizeEnvMirrorTarget(rawPath, options = {}) {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) {
    return null;
  }
  return {
    type: "local",
    group: "mirrorTargets",
    path: resolvePathFromRoot(options.root || process.cwd(), trimmed),
    extraCopies: [],
    label: String(options.label || "").trim(),
  };
}

function readConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      exists: false,
      value: {
        pluginTargets: [],
        mirrorTargets: [],
      },
    };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    configPath,
    exists: true,
    value: parsed && typeof parsed === "object"
      ? parsed
      : {
          pluginTargets: [],
          mirrorTargets: [],
        },
  };
}

function getEnvMirrorTargets(env, root) {
  const explicitTarget = String(env?.[LEGACY_ENV_AUTO_SYNC_PATH_KEY] || "").trim();
  if (!explicitTarget) {
    return [];
  }
  return explicitTarget
    .split(path.delimiter)
    .map((value, index) => normalizeEnvMirrorTarget(value, {
      root,
      label: `env-auto-sync-${index + 1}`,
    }))
    .filter(Boolean);
}

function buildMissingArtifactsError(root) {
  const inspection = inspectPluginArtifacts({ root });
  if (inspection.missingFiles.length === 0) {
    return null;
  }
  return new Error(`Missing plugin artifacts: ${inspection.missingFiles.join(", ")}`);
}

export function resolveSyncConfigPath(configPath = process.env.SYSTEMSCULPT_SYNC_CONFIG || DEFAULT_SYNC_CONFIG_PATH) {
  return path.resolve(String(configPath || DEFAULT_SYNC_CONFIG_PATH));
}

export function loadConfiguredTargets(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const configPath = resolveSyncConfigPath(options.configPath);
  const configFile = readConfigFile(configPath);
  const config = configFile.value;
  const pluginTargets = Array.isArray(config.pluginTargets) ? config.pluginTargets : [];
  const mirrorTargets = Array.isArray(config.mirrorTargets) ? config.mirrorTargets : [];

  const targets = [
    ...pluginTargets.map((entry) =>
      normalizeConfigTarget(entry, { group: "pluginTargets", root, env: options.env || process.env })
    ),
    ...mirrorTargets.map((entry) =>
      normalizeConfigTarget(entry, { group: "mirrorTargets", root, env: options.env || process.env })
    ),
    ...getEnvMirrorTargets(options.env || process.env, root),
  ].filter(Boolean);

  return {
    configExists: configFile.exists,
    configPath,
    targets,
  };
}

export function countConfiguredTargets(options = {}) {
  return loadConfiguredTargets(options).targets.length;
}

export function formatSyncTarget(target) {
  const prefix = target.group === "mirrorTargets" ? "mirror" : "plugin";
  if (target.type === "windows-ssh") {
    const remotePath = `${target.host}:${target.path}`;
    if (target.label) {
      return `${prefix}: ${target.label} -> ${remotePath}`;
    }
    return `${prefix}: ${remotePath}`;
  }
  const label = target.label || target.path;
  return `${prefix}: ${label}`;
}

function syncLocalTarget(target, options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  ensureDir(target.path);
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    copyFile(fileName, {
      root,
      destDir: target.path,
    });
  }

  for (const relativePath of LEGACY_RELEASE_EXTRAS) {
    const extraPath = path.join(target.path, relativePath);
    if (fs.existsSync(extraPath)) {
      clearDestinationPath(extraPath);
    }
  }

  copyExtraEntries(target, root);
}

function syncWindowsSshTarget(target, options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  runRemoteWindowsPowerShell(target, buildRemoteWindowsPrepScript(target.path), options);
  const localFiles = REQUIRED_PLUGIN_ARTIFACTS.map((fileName) => path.join(root, fileName));
  const remoteDestination = `${target.host}:${formatScpRemotePath(target.path)}`;
  runCommand("scp", ["-Cq", ...localFiles, remoteDestination], options);
}

export function syncTarget(target, options = {}) {
  if (target.type === "windows-ssh") {
    syncWindowsSshTarget(target, options);
    return;
  }
  syncLocalTarget(target, options);
}

export function syncConfiguredTargets(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const logger = options.logger || console;
  const allowPartial = options.allowPartial !== false;
  const loaded = loadConfiguredTargets({
    root,
    configPath: options.configPath,
    env: options.env,
  });

  const missingArtifactsError = buildMissingArtifactsError(root);
  if (missingArtifactsError) {
    throw missingArtifactsError;
  }

  if (!loaded.configExists && loaded.targets.length === 0 && options.failWhenNoTargets !== false) {
    throw new Error(`[sync] Config file not found at ${loaded.configPath}. Create one or pass --config.`);
  }

  if (loaded.targets.length === 0) {
    return {
      configExists: loaded.configExists,
      configPath: loaded.configPath,
      targets: [],
      succeeded: [],
      failed: [],
      ok: true,
    };
  }

  const succeeded = [];
  const failed = [];
  for (const target of loaded.targets) {
    const label = formatSyncTarget(target);
    try {
      syncTarget(target, {
        root,
        spawnSyncImpl: options.spawnSyncImpl,
      });
      logger.info?.(`[sync] Updated ${label}`);
      succeeded.push(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      logger.warn?.(`[sync] Failed ${label}: ${message}`);
      failed.push({
        target,
        error,
      });
    }
  }

  if (failed.length === 0) {
    return {
      configExists: loaded.configExists,
      configPath: loaded.configPath,
      targets: loaded.targets,
      succeeded,
      failed,
      ok: true,
    };
  }

  if (allowPartial && succeeded.length > 0) {
    return {
      configExists: loaded.configExists,
      configPath: loaded.configPath,
      targets: loaded.targets,
      succeeded,
      failed,
      ok: true,
    };
  }

  const failedTargets = failed.map((entry) => formatSyncTarget(entry.target)).join(", ");
  throw new Error(`Failed sync targets: ${failedTargets}`);
}

function shouldAutoSync(env = process.env) {
  return parseBooleanFlag(env.SYSTEMSCULPT_AUTO_SYNC, true);
}

function shouldAutoReload(env = process.env) {
  return parseBooleanFlag(env.SYSTEMSCULPT_AUTO_RELOAD, false);
}

function runHotReload(options = {}) {
  const scriptPath = path.join(process.cwd(), "scripts", "reload-local-obsidian-plugin.mjs");
  const args = [
    scriptPath,
    "--plugin-id",
    "systemsculpt-ai",
    "--quiet-unavailable",
    "--timeout-ms",
    "8000",
  ];
  if (options.quiet) {
    args.push("--quiet-success");
  }
  args.push("--sync-config", resolveSyncConfigPath(options.configPath));
  runCommand("node", args, {
    env: options.env,
    spawnSyncImpl: options.spawnSyncImpl,
  });
}

export function createBuildSyncController(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(String(options.root || process.cwd()));
  const configPath = resolveSyncConfigPath(options.configPath);
  const logger = options.logger || console;
  const quiet = Boolean(options.quiet);
  const spawnSyncImpl = options.spawnSyncImpl;

  let inFlight = false;
  let rerunRequested = false;

  const runSyncPass = async () => {
    if (!shouldAutoSync(env)) {
      return;
    }

    let result = null;
    try {
      result = syncConfiguredTargets({
        root,
        configPath,
        env,
        allowPartial: true,
        failWhenNoTargets: false,
        logger,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      logger.warn?.(`[sync] Auto-sync pass failed: ${message}`);
      return;
    }

    if (
      shouldAutoReload(env) &&
      result.succeeded.some((target) => target.group === "pluginTargets" && target.type === "local")
    ) {
      try {
        runHotReload({
          configPath,
          env,
          quiet,
          spawnSyncImpl,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Unknown error");
        logger.warn?.(`[sync] Obsidian plugin reload failed after sync: ${message}`);
      }
    }
  };

  const pump = async () => {
    if (inFlight) {
      rerunRequested = true;
      return;
    }

    inFlight = true;
    try {
      do {
        rerunRequested = false;
        await runSyncPass();
      } while (rerunRequested);
    } finally {
      inFlight = false;
    }
  };

  return {
    isEnabled() {
      if (!shouldAutoSync(env)) {
        return false;
      }
      return countConfiguredTargets({ root, configPath, env }) > 0;
    },
    schedule() {
      void pump();
    },
  };
}
