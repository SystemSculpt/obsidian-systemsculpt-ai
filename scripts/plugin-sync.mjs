#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { inspectPluginArtifacts, REQUIRED_PLUGIN_ARTIFACTS } from "./plugin-artifacts.mjs";

export const DEFAULT_SYNC_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.config.json");
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

function copyPluginArtifacts(root, target) {
  fs.mkdirSync(target.path, { recursive: true });
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    const sourcePath = path.join(root, fileName);
    if (!fs.existsSync(sourcePath)) throw new Error(`Required file missing: ${sourcePath}`);
    fs.copyFileSync(sourcePath, path.join(target.path, fileName));
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

  for (const target of loaded.targets) {
    copyPluginArtifacts(root, target);
    logger.info?.(`[sync] Updated ${formatSyncTarget(target)}`);
  }
  return { ...loaded, succeeded: loaded.targets };
}

export function createBuildSyncController(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(String(options.root || process.cwd()));
  const configPath = resolveSyncConfigPath(options.configPath);
  const logger = options.logger || console;
  let inFlight = false;
  let rerunRequested = false;

  const syncOnce = async () => {
    if (!booleanFlag(env.SYSTEMSCULPT_AUTO_SYNC, true)) return;
    try {
      syncConfiguredTargets({
        root,
        configPath,
        failWhenNoTargets: false,
        logger,
      });
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
