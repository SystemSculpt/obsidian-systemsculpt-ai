import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_DISCOVERY_DIR = path.join(os.homedir(), ".systemsculpt", "obsidian-automation");
export const DEFAULT_PLUGIN_ID = "systemsculpt-ai";

function matchesFilter(actual, expected) {
  if (!expected) {
    return true;
  }
  return String(actual || "").trim() === String(expected || "").trim();
}

export async function loadDiscoveryEntries(options = {}) {
  const discoveryDir = options.discoveryDir || DEFAULT_DISCOVERY_DIR;
  const pluginId = options.pluginId || DEFAULT_PLUGIN_ID;
  const discoveryFile = options.discoveryFile ? path.resolve(String(options.discoveryFile)) : null;

  let filePaths = [];
  if (discoveryFile) {
    filePaths = [discoveryFile];
  } else {
    let names = [];
    try {
      names = await fs.readdir(discoveryDir);
    } catch {
      return [];
    }
    filePaths = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(discoveryDir, name));
  }

  const entries = [];
  for (const filePath of filePaths) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      if (pluginId && String(parsed.pluginId || "").trim() !== String(pluginId)) {
        continue;
      }
      entries.push({
        ...parsed,
        discoveryFilePath: filePath,
      });
    } catch {
      // Ignore malformed or transient discovery files.
    }
  }

  return entries
    .filter((entry) => matchesDiscoveryEntry(entry, options))
    .sort((left, right) => String(right.startedAt || "").localeCompare(String(left.startedAt || "")));
}

export function matchesDiscoveryEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  if (!matchesFilter(entry.pluginId, options.pluginId || DEFAULT_PLUGIN_ID)) {
    return false;
  }
  if (!matchesFilter(entry.vaultName, options.vaultName)) {
    return false;
  }
  if (!matchesFilter(entry.vaultPath, options.vaultPath)) {
    return false;
  }
  if (!matchesFilter(entry.vaultInstanceId, options.vaultInstanceId)) {
    return false;
  }
  if (options.port && Number(entry.port) !== Number(options.port)) {
    return false;
  }
  if (options.excludeStartedAt && String(entry.startedAt || "") === String(options.excludeStartedAt)) {
    return false;
  }

  return true;
}

export async function inferVaultNameFromSyncConfig(configPath) {
  if (!configPath) {
    return null;
  }

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const firstTarget = Array.isArray(parsed?.pluginTargets) ? parsed.pluginTargets[0] : null;
    const pluginPath = firstTarget?.path ? path.resolve(String(firstTarget.path)) : "";
    if (!pluginPath) {
      return null;
    }
    const vaultRoot = path.resolve(pluginPath, "..", "..", "..");
    return path.basename(vaultRoot);
  } catch {
    return null;
  }
}
