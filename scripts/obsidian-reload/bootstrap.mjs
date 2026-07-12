import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  createObsidianReloadClient,
  waitForObsidianReloadClient,
  waitForStableObsidianReloadClient,
} from "./client.mjs";
import { DEFAULT_PLUGIN_ID, loadDiscoveryEntries } from "./discovery.mjs";
import { parseJsonText } from "./json.mjs";

export const DEFAULT_SYNC_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.config.json");
export const DEFAULT_RELOAD_TIMEOUT_MS = 8000;

async function readJsonIfExists(filePath) {
  try {
    return parseJsonText(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createVaultInstanceId() {
  return crypto.randomUUID();
}

export async function loadPluginTargetsFromSyncConfig(configPath = DEFAULT_SYNC_CONFIG_PATH) {
  const resolvedConfigPath = path.resolve(String(configPath || DEFAULT_SYNC_CONFIG_PATH));
  let raw;
  try {
    raw = await fs.readFile(resolvedConfigPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const parsed = parseJsonText(raw);
  const entries = Array.isArray(parsed?.pluginTargets) ? parsed.pluginTargets : [];

  return entries.flatMap((entry, index) => {
    const configuredPath = String(entry?.path || "").trim();
    if (!configuredPath) return [];
    const pluginDir = path.resolve(configuredPath);
    const vaultRoot = path.resolve(pluginDir, "..", "..", "..");
    return [{
      index,
      pluginDir,
      dataFilePath: path.join(pluginDir, "data.json"),
      vaultRoot,
      vaultName: path.basename(vaultRoot),
    }];
  });
}

function hasExplicitSelector(options) {
  return Boolean(
    String(options.vaultPath || "").trim() ||
      String(options.vaultName || "").trim() ||
      options.targetIndex === 0 ||
      options.targetIndex,
  );
}

export function selectPluginTarget(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("No local Obsidian plugin targets are configured.");
  }

  const vaultPath = String(options.vaultPath || "").trim();
  const vaultName = String(options.vaultName || "").trim();
  const targetIndex = options.targetIndex;
  const match = vaultPath
    ? targets.find((target) => target.vaultRoot === path.resolve(vaultPath))
    : vaultName
      ? targets.find((target) => target.vaultName === vaultName)
      : targetIndex !== undefined && targetIndex !== null
        ? targets.find((target) => target.index === Number(targetIndex))
        : targets[0];

  if (!match) {
    throw new Error("The selected vault is not present in pluginTargets.");
  }
  return match;
}

function targetForRecord(targets, record) {
  const recordPath = String(record?.vaultPath || "").trim();
  const recordName = String(record?.vaultName || "").trim();
  return targets.find((target) =>
    (recordPath && target.vaultRoot === path.resolve(recordPath)) ||
    (recordName && target.vaultName === recordName),
  );
}

export async function resolveObsidianReloadTarget(targets, options = {}) {
  if (hasExplicitSelector(options)) return selectPluginTarget(targets, options);

  const createClient = options.createClient || createObsidianReloadClient;
  try {
    const liveClient = await createClient({
      pluginId: options.pluginId || DEFAULT_PLUGIN_ID,
      loadEntries: options.loadEntries || loadDiscoveryEntries,
    });
    return targetForRecord(targets, liveClient.record) || selectPluginTarget(targets);
  } catch {
    return selectPluginTarget(targets);
  }
}

export async function ensureObsidianReloadSettings(target) {
  const current = await readJsonIfExists(target.dataFilePath);
  const settings = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current }
    : {};
  let wrote = false;

  if (settings.desktopAutomationBridgeEnabled !== true) {
    settings.desktopAutomationBridgeEnabled = true;
    wrote = true;
  }
  if (!String(settings.vaultInstanceId || "").trim()) {
    settings.vaultInstanceId = createVaultInstanceId();
    wrote = true;
  }

  if (wrote) await writeJson(target.dataFilePath, settings);
  return { settings, wrote, vaultInstanceId: settings.vaultInstanceId };
}

function clientOptions(target, options) {
  return {
    pluginId: options.pluginId || DEFAULT_PLUGIN_ID,
    vaultName: target.vaultName,
    vaultPath: target.vaultRoot,
    loadEntries: options.loadEntries || loadDiscoveryEntries,
  };
}

export async function bootstrapObsidianReloadClient(options = {}) {
  const targets = options.targets || await loadPluginTargetsFromSyncConfig(options.syncConfigPath);
  const target = await resolveObsidianReloadTarget(targets, options);
  const ensured = await ensureObsidianReloadSettings(target);
  const timeoutMs = options.timeoutMs || DEFAULT_RELOAD_TIMEOUT_MS;
  const createClient = options.createClient || createObsidianReloadClient;
  const waitForClient = options.waitForClient || waitForObsidianReloadClient;
  const waitForStableClient = options.waitForStableClient || waitForStableObsidianReloadClient;
  const baseOptions = clientOptions(target, options);

  let client;
  try {
    client = await createClient(baseOptions);
  } catch {
    try {
      client = await waitForClient({ ...baseOptions, timeoutMs, intervalMs: 250 });
    } catch {
      throw new Error(
        `Obsidian reload is unavailable for ${target.vaultName}. ` +
        "Keep that vault open and do one manual plugin reload, then retry.",
      );
    }
  }

  const previousStartedAt = String(client.record?.startedAt || "").trim();
  await client.reloadPlugin();
  const stableClient = await waitForStableClient({
    ...baseOptions,
    timeoutMs,
    excludeStartedAt: previousStartedAt || undefined,
  });

  return {
    client: stableClient,
    target,
    ensured,
    reload: { method: "bridge", previousStartedAt: previousStartedAt || null },
  };
}
