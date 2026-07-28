#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inspectPluginArtifacts, REQUIRED_PLUGIN_ARTIFACTS } from "./plugin-artifacts.mjs";
import { replaceFileAtomically } from "./platform-portability.mjs";

export { replaceFileAtomically } from "./platform-portability.mjs";

export const DEFAULT_SYNC_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.config.json");
export const DEVELOPMENT_BUILD_MANIFEST_KEY = "systemsculptDevBuild";
export const OBSOLETE_PLUGIN_FILES = [
  "README.md",
  "LICENSE",
  "versions.json",
  "studio-terminal-sidecar.cjs",
  "studio-terminal-server.cjs",
  "node_modules",
  ".systemsculpt-runtime-sync.json",
];

function booleanFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

export function resolveSyncConfigPath(
  configPath = process.env.SYSTEMSCULPT_SYNC_CONFIG || DEFAULT_SYNC_CONFIG_PATH,
) {
  return path.resolve(String(configPath || DEFAULT_SYNC_CONFIG_PATH));
}

export function loadConfiguredTargets(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const configPath = resolveSyncConfigPath(options.configPath);
  if (!fs.existsSync(configPath)) return { configExists: false, configPath, targets: [] };

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const entries = Array.isArray(config?.pluginTargets) ? config.pluginTargets : [];
  const targets = entries.flatMap((entry) => {
    const configuredPath = String(entry?.path || "").trim();
    if (!configuredPath) return [];
    return [{
      path: path.isAbsolute(configuredPath) ? configuredPath : path.resolve(root, configuredPath),
      label: String(entry?.label || "").trim(),
      vault: String(entry?.vault || "").trim(),
    }];
  });
  return { configExists: true, configPath, targets };
}

export function countConfiguredTargets(options = {}) {
  return loadConfiguredTargets(options).targets.length;
}

export function formatSyncTarget(target) {
  return `plugin: ${target.label || target.path}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitValue(root, args, fallback) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 ? String(result.stdout || "").trim() || fallback : fallback;
}

export function createDevelopmentBuildIdentity(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const syncedAt = options.syncedAt || new Date().toISOString();
  const revision = options.revision
    || gitValue(root, ["rev-parse", "HEAD"], "0000000");
  const branch = options.branch
    || gitValue(root, ["branch", "--show-current"], "detached");
  const dirty = options.dirty ?? Boolean(
    gitValue(root, ["status", "--porcelain", "--untracked-files=no"], ""),
  );
  const compactTime = syncedAt.replace(/[-:.]/g, "");
  const artifacts = Object.fromEntries(
    REQUIRED_PLUGIN_ARTIFACTS.map((fileName) => [
      fileName,
      sha256(fs.readFileSync(path.join(root, fileName))),
    ]),
  );
  return Object.freeze({
    schemaVersion: 1,
    id: `${revision.slice(0, 8)}${dirty ? "-dirty" : ""}-${compactTime}`,
    revision,
    branch,
    dirty,
    syncedAt,
    sourcePath: root,
    artifacts: Object.freeze(artifacts),
  });
}

function developmentManifest(root, buildIdentity) {
  const source = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("manifest.json must contain an object");
  }
  return Buffer.from(`${JSON.stringify({
    ...source,
    [DEVELOPMENT_BUILD_MANIFEST_KEY]: buildIdentity,
  }, null, 2)}\n`);
}

function copyPluginArtifacts(root, target, buildIdentity, replaceFile) {
  fs.mkdirSync(target.path, { recursive: true });
  const artifactBytes = new Map(
    REQUIRED_PLUGIN_ARTIFACTS.map((fileName) => [
      fileName,
      fileName === "manifest.json"
        ? developmentManifest(root, buildIdentity)
        : fs.readFileSync(path.join(root, fileName)),
    ]),
  );
  // Replace executable and style bytes first. The manifest is the final
  // transaction marker and identifies the exact source artifact hashes.
  for (const fileName of ["main.js", "styles.css", "manifest.json"]) {
    const sourcePath = path.join(root, fileName);
    if (!fs.existsSync(sourcePath)) throw new Error(`Required file missing: ${sourcePath}`);
    replaceFile(path.join(target.path, fileName), artifactBytes.get(fileName));
  }
  for (const relativePath of OBSOLETE_PLUGIN_FILES) {
    fs.rmSync(path.join(target.path, relativePath), {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150,
    });
  }
}

export function syncConfiguredTargets(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const logger = options.logger || console;
  const loaded = loadConfiguredTargets({ root, configPath: options.configPath });
  const inspection = inspectPluginArtifacts({ root });
  if (inspection.missingFiles.length > 0) {
    throw new Error(`Missing plugin artifacts: ${inspection.missingFiles.join(", ")}`);
  }
  if (!loaded.configExists && options.failWhenNoTargets !== false) {
    throw new Error(`[sync] Config file not found at ${loaded.configPath}.`);
  }

  const buildIdentity = options.buildIdentity
    || createDevelopmentBuildIdentity({ root });
  const replaceFile = options.replaceFile || replaceFileAtomically;
  for (const target of loaded.targets) {
    copyPluginArtifacts(root, target, buildIdentity, replaceFile);
    logger.info?.(`[sync] Updated ${formatSyncTarget(target)} (${buildIdentity.id})`);
  }
  return { ...loaded, succeeded: loaded.targets, buildIdentity };
}

function inferVaultName(pluginPath) {
  const marker = `${path.sep}.obsidian${path.sep}plugins${path.sep}`;
  const markerIndex = pluginPath.lastIndexOf(marker);
  const vaultPath = markerIndex >= 0
    ? pluginPath.slice(0, markerIndex)
    : path.dirname(pluginPath);
  return path.basename(vaultPath);
}

/** Reloads freshly copied plugin artifacts through Obsidian's official CLI. */
export function reloadConfiguredTargets(options = {}) {
  const env = options.env || process.env;
  if (!booleanFlag(env.SYSTEMSCULPT_AUTO_RELOAD, true)) return { reloaded: [] };

  const root = path.resolve(String(options.root || process.cwd()));
  const logger = options.logger || console;
  const runCommand = options.runCommand || spawnSync;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const pluginId = String(manifest?.id || "").trim();
  if (!pluginId) throw new Error("manifest.json is missing the plugin id");

  const reloaded = [];
  for (const target of options.targets || []) {
    const vault = target.vault || inferVaultName(target.path);
    const result = runCommand(
      "obsidian",
      ["plugin:reload", `id=${pluginId}`, `vault=${vault}`],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (result?.error || result?.status !== 0) {
      const reason = result?.error?.message || result?.stderr || `exit ${result?.status}`;
      logger.warn?.(`[sync] Obsidian reload skipped for ${vault}: ${String(reason).trim()}`);
      continue;
    }
    reloaded.push({ target, vault });
    logger.info?.(`[sync] Reloaded ${pluginId} in ${vault}`);
  }
  return { reloaded };
}

export function createBuildSyncController(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(String(options.root || process.cwd()));
  const configPath = resolveSyncConfigPath(options.configPath);
  const logger = options.logger || console;
  const reloadTargets = options.reloadTargets || reloadConfiguredTargets;
  let inFlight = false;
  let rerunRequested = false;

  const syncOnce = async () => {
    if (!booleanFlag(env.SYSTEMSCULPT_AUTO_SYNC, true)) return;
    try {
      const result = syncConfiguredTargets({
        root,
        configPath,
        failWhenNoTargets: false,
        logger,
      });
      reloadTargets({ root, targets: result.succeeded, env, logger });
    } catch (error) {
      logger.warn?.(`[sync] Auto-sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
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
        await syncOnce();
      } while (rerunRequested);
    } finally {
      inFlight = false;
    }
  };

  return {
    isEnabled() {
      return booleanFlag(env.SYSTEMSCULPT_AUTO_SYNC, true) &&
        countConfiguredTargets({ root, configPath }) > 0;
    },
    schedule() {
      void pump();
    },
  };
}
