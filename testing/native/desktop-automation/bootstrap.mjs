import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createDesktopAutomationClient, waitForDesktopAutomationClient } from "./client.mjs";
import { DEFAULT_PLUGIN_ID } from "./discovery.mjs";

export const DEFAULT_SYNC_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.config.json");
export const DEFAULT_RELOAD_TIMEOUT_MS = 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateVaultInstanceId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sanitizeSeedSettings(rawSettings) {
  const settings = rawSettings && typeof rawSettings === "object" ? { ...rawSettings } : {};
  delete settings.verifiedDirectories;
  settings.favoriteChats = Array.isArray(settings.favoriteChats) ? [] : settings.favoriteChats;
  settings.favoriteStudioSessions = Array.isArray(settings.favoriteStudioSessions)
    ? []
    : settings.favoriteStudioSessions;
  return settings;
}

function createMinimalSettings() {
  return {
    settingsMode: "advanced",
    selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
  };
}

export async function loadPluginTargetsFromSyncConfig(configPath = DEFAULT_SYNC_CONFIG_PATH) {
  const resolvedConfigPath = path.resolve(String(configPath || DEFAULT_SYNC_CONFIG_PATH));
  const raw = await fs.readFile(resolvedConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const pluginTargets = Array.isArray(parsed?.pluginTargets) ? parsed.pluginTargets : [];

  return pluginTargets
    .map((entry, index) => {
      const pluginDir = path.resolve(String(entry?.path || ""));
      if (!pluginDir) {
        return null;
      }

      const vaultRoot = path.resolve(pluginDir, "..", "..", "..");
      return {
        index,
        configPath: resolvedConfigPath,
        pluginDir,
        dataFilePath: path.join(pluginDir, "data.json"),
        manifestFilePath: path.join(pluginDir, "manifest.json"),
        mainFilePath: path.join(pluginDir, "main.js"),
        vaultRoot,
        vaultName: path.basename(vaultRoot),
      };
    })
    .filter(Boolean);
}

function formatAvailableTargets(targets) {
  return targets
    .map((target) => `[${target.index}] ${target.vaultName} -> ${target.vaultRoot}`)
    .join(", ");
}

export function selectPluginTarget(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("No plugin targets were found in the sync config.");
  }

  const vaultPath = String(options.vaultPath || "").trim();
  if (vaultPath) {
    const resolvedVaultPath = path.resolve(vaultPath);
    const match = targets.find((target) => target.vaultRoot === resolvedVaultPath);
    if (match) {
      return match;
    }
    throw new Error(
      `No plugin target matched vault path ${resolvedVaultPath}. Available targets: ${formatAvailableTargets(targets)}`
    );
  }

  const vaultName = String(options.vaultName || "").trim();
  if (vaultName) {
    const match = targets.find((target) => target.vaultName === vaultName);
    if (match) {
      return match;
    }
    throw new Error(
      `No plugin target matched vault name ${vaultName}. Available targets: ${formatAvailableTargets(targets)}`
    );
  }

  if (options.targetIndex !== undefined && options.targetIndex !== null) {
    const numericTargetIndex = Number(options.targetIndex);
    if (!Number.isFinite(numericTargetIndex)) {
      throw new Error(`Invalid plugin target index: ${String(options.targetIndex)}`);
    }

    const byIndex = targets.find((target) => Number(target.index) === numericTargetIndex);
    if (byIndex) {
      return byIndex;
    }

    throw new Error(
      `No plugin target matched index ${numericTargetIndex}. Available targets: ${formatAvailableTargets(targets)}`
    );
  }

  return targets[0];
}

async function chooseSeedTarget(targets, selectedTarget) {
  for (const candidate of targets) {
    if (!candidate || candidate.pluginDir === selectedTarget.pluginDir) {
      continue;
    }
    const seedSettings = await readJsonIfExists(candidate.dataFilePath);
    if (seedSettings && typeof seedSettings === "object") {
      return {
        target: candidate,
        settings: seedSettings,
      };
    }
  }
  return null;
}

export async function ensureDesktopAutomationSettings(target, options = {}) {
  const existingSettings = await readJsonIfExists(target.dataFilePath);
  const targets = Array.isArray(options.targets) ? options.targets : [];
  let nextSettings = existingSettings && typeof existingSettings === "object" ? { ...existingSettings } : null;
  let seedSource = existingSettings ? "existing" : "minimal";
  let seedTarget = null;

  if (!nextSettings && options.seedFromOtherTargets !== false) {
    const seed = await chooseSeedTarget(targets, target);
    if (seed) {
      nextSettings = sanitizeSeedSettings(seed.settings);
      seedSource = "synced-target";
      seedTarget = seed.target;
    }
  }

  if (!nextSettings) {
    nextSettings = createMinimalSettings();
  }

  const previousVaultInstanceId =
    typeof nextSettings.vaultInstanceId === "string" && nextSettings.vaultInstanceId.trim().length > 0
      ? nextSettings.vaultInstanceId.trim()
      : null;

  if (!previousVaultInstanceId || seedSource !== "existing") {
    nextSettings.vaultInstanceId = generateVaultInstanceId();
  }

  nextSettings.desktopAutomationBridgeEnabled = true;
  if (typeof nextSettings.settingsMode !== "string" || nextSettings.settingsMode.trim().length === 0) {
    nextSettings.settingsMode = "advanced";
  }

  const needsWrite =
    !existingSettings || JSON.stringify(existingSettings) !== JSON.stringify(nextSettings);
  if (needsWrite) {
    await writeJson(target.dataFilePath, nextSettings);
  }

  return {
    target,
    dataFilePath: target.dataFilePath,
    settings: nextSettings,
    existed: !!existingSettings,
    wrote: needsWrite,
    seedSource,
    seedVaultName: seedTarget?.vaultName || null,
    vaultInstanceId: String(nextSettings.vaultInstanceId || "").trim() || null,
    desktopAutomationBridgeEnabled: Boolean(nextSettings.desktopAutomationBridgeEnabled),
  };
}

export async function signalDesktopAutomationSettingsChange(target, ensured) {
  const nextSettings =
    ensured?.settings && typeof ensured.settings === "object"
      ? ensured.settings
      : await readJsonIfExists(target.dataFilePath);
  if (!nextSettings || typeof nextSettings !== "object") {
    throw new Error(`Desktop automation settings were not found at ${target.dataFilePath}.`);
  }

  await writeJson(target.dataFilePath, nextSettings);
  return {
    method: "settings-file-touch",
    focusPreserved: true,
  };
}

async function keepDesktopAutomationSettingsAsserted(target, ensured) {
  const latestSettings = await readJsonIfExists(target.dataFilePath);
  const nextSettings =
    latestSettings && typeof latestSettings === "object"
      ? { ...latestSettings }
      : ensured?.settings && typeof ensured.settings === "object"
        ? { ...ensured.settings }
        : createMinimalSettings();

  nextSettings.desktopAutomationBridgeEnabled = true;
  if (
    (!nextSettings.vaultInstanceId || String(nextSettings.vaultInstanceId).trim().length === 0) &&
    ensured?.vaultInstanceId
  ) {
    nextSettings.vaultInstanceId = ensured.vaultInstanceId;
  }
  if (typeof nextSettings.settingsMode !== "string" || nextSettings.settingsMode.trim().length === 0) {
    nextSettings.settingsMode = "advanced";
  }

  await writeJson(target.dataFilePath, nextSettings);
}

async function waitForTargetClientWithSettingsKeepalive(target, ensured, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_RELOAD_TIMEOUT_MS;
  const intervalMs = Math.max(100, options.intervalMs || 500);
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    await keepDesktopAutomationSettingsAsserted(target, ensured);
    try {
      return await tryCreateTargetClient(target, options);
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw lastError || new Error("Timed out waiting for a live desktop automation bridge.");
}

function buildClientFilter(target, options = {}) {
  return {
    pluginId: String(options.pluginId || DEFAULT_PLUGIN_ID).trim() || DEFAULT_PLUGIN_ID,
    vaultName: target.vaultName,
    vaultPath: target.vaultRoot,
  };
}

async function tryCreateTargetClient(target, options = {}) {
  return await createDesktopAutomationClient(buildClientFilter(target, options));
}

async function waitForTargetClient(target, options = {}) {
  return await waitForDesktopAutomationClient({
    ...buildClientFilter(target, options),
    timeoutMs: options.timeoutMs || DEFAULT_RELOAD_TIMEOUT_MS,
    intervalMs: options.intervalMs || 500,
    excludeStartedAt: options.excludeStartedAt,
  });
}

export async function bootstrapDesktopAutomationClient(options = {}) {
  const targets =
    Array.isArray(options.targets) && options.targets.length > 0
      ? options.targets
      : await loadPluginTargetsFromSyncConfig(options.syncConfigPath);
  const target = selectPluginTarget(targets, options);
  const ensured = await ensureDesktopAutomationSettings(target, {
    targets,
    seedFromOtherTargets: options.seedFromOtherTargets,
  });

  let existingClient = null;
  try {
    existingClient = await tryCreateTargetClient(target, options);
  } catch {}

  if (existingClient && options.reload !== false) {
    const previousRecord = await existingClient.ping().catch(() => existingClient.record || {});
    await existingClient.reloadPlugin();
    const client = await waitForTargetClient(target, {
      ...options,
      excludeStartedAt: String(previousRecord?.startedAt || "").trim() || undefined,
    });
    return {
      client,
      target,
      ensured,
      reload: {
        method: "bridge",
        previousStartedAt: String(previousRecord?.startedAt || "").trim() || null,
        focusPreserved: true,
      },
    };
  }

  if (existingClient) {
    return {
      client: existingClient,
      target,
      ensured,
      reload: {
        method: "none",
        focusPreserved: true,
      },
    };
  }

  let reload = {
    method: ensured.wrote ? "settings-file" : "settings-file-touch",
    focusPreserved: true,
  };

  if (!ensured.wrote) {
    reload = await signalDesktopAutomationSettingsChange(target, ensured);
  }

  let client;
  try {
    client = await waitForTargetClientWithSettingsKeepalive(target, ensured, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    throw new Error(
      `No live desktop automation bridge was found after updating ${path.basename(target.dataFilePath)}. ` +
        "This runner only attaches to an already-running Obsidian vault and will not launch or focus the app for you. " +
        "The running plugin must support external settings sync for no-focus bootstrap. " +
        "If the currently open vault is still on an older runtime, do one manual plugin reload once in that vault; " +
        "after that, desktop automation bootstraps stay no-focus. " +
        `Details: ${message}.`
    );
  }

  return {
    client,
    target,
    ensured,
    reload,
  };
}
