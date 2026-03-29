import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertProductionPluginArtifacts, REQUIRED_PLUGIN_ARTIFACTS } from "../../../../scripts/plugin-artifacts.mjs";
import { DEFAULT_PLUGIN_ID } from "../../desktop-automation/discovery.mjs";
import { parseJsonText } from "../../shared/json.mjs";

export const DEFAULT_WINDOWS_VAULT_NAME = "SystemSculptWindowsQA";
export const DEFAULT_WINDOWS_SYNC_CONFIG_BASENAME = "systemsculpt-sync.windows.generated.json";
export const DEFAULT_WINDOWS_PI_AGENT_DIR_BASENAME = path.join(".systemsculpt", "pi-empty-agent");
export const DEFAULT_WINDOWS_SYSTEMSCULPT_SERVER_URL = "https://api.systemsculpt.com";
export const WINDOWS_LOCAL_PI_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "AZURE_OPENAI_API_KEY",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveRuntimeSmokeLicenseKey(env = process.env) {
  const explicitKey = String(env.SYSTEMSCULPT_RUNTIME_SMOKE_LICENSE_KEY || "").trim();
  if (explicitKey) {
    return explicitKey;
  }

  return String(env.SYSTEMSCULPT_E2E_LICENSE_KEY || "").trim();
}

export function generateVaultInstanceId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vault-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveWindowsHomeDir(env = process.env) {
  return String(env.USERPROFILE || os.homedir() || "").trim();
}

export function resolveDefaultWindowsVaultPath(options = {}) {
  const homeDir = resolveWindowsHomeDir(options.env);
  const vaultName = String(options.vaultName || DEFAULT_WINDOWS_VAULT_NAME).trim() || DEFAULT_WINDOWS_VAULT_NAME;
  return path.join(homeDir, "Documents", vaultName);
}

export function resolveDefaultWindowsSyncConfigPath(options = {}) {
  const repoRoot = path.resolve(String(options.repoRoot || process.cwd()));
  return path.join(repoRoot, DEFAULT_WINDOWS_SYNC_CONFIG_BASENAME);
}

export function resolveDefaultWindowsPiAgentDir(vaultPath) {
  return path.join(path.resolve(String(vaultPath)), DEFAULT_WINDOWS_PI_AGENT_DIR_BASENAME);
}

export function resolveWindowsInteractiveTempRoot(env = process.env) {
  const systemRoot = String(env.SYSTEMROOT || "C:\\Windows").trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "Temp");
}

export async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJsonText(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeVaultRegistryKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized || "systemsculptwindowsqa";
}

export function resolveWindowsHostedAuthSeed(env = process.env) {
  const licenseKey = resolveRuntimeSmokeLicenseKey(env);
  if (!licenseKey) {
    return null;
  }

  const serverUrl =
    String(env.SYSTEMSCULPT_RUNTIME_SMOKE_SERVER_URL || "").trim() ||
    DEFAULT_WINDOWS_SYSTEMSCULPT_SERVER_URL;

  return {
    licenseKey,
    licenseValid: true,
    enableSystemSculptProvider: true,
    serverUrl,
    selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
    transcriptionProvider: "systemsculpt",
    embeddingsProvider: "systemsculpt",
  };
}

export function upsertObsidianVaultRegistry(existingState, options = {}) {
  const state = isObject(existingState) ? { ...existingState } : {};
  const vaults = isObject(state.vaults) ? { ...state.vaults } : {};
  const vaultPath = path.resolve(String(options.vaultPath || ""));
  const vaultName = String(options.vaultName || path.basename(vaultPath)).trim() || DEFAULT_WINDOWS_VAULT_NAME;
  const targetKey = normalizeVaultRegistryKey(options.registryKey || vaultName);
  const timestamp = Number.isFinite(Number(options.timestamp)) ? Number(options.timestamp) : Date.now();
  const markOpen = options.open !== false;

  for (const [key, entry] of Object.entries(vaults)) {
    vaults[key] = {
      ...(isObject(entry) ? entry : {}),
      open: false,
    };
  }

  vaults[targetKey] = {
    path: vaultPath,
    ts: timestamp,
    open: markOpen,
  };

  return {
    ...state,
    vaults,
  };
}

export function createWindowsSeedPluginData(existingSettings, options = {}) {
  const nextSettings = isObject(existingSettings) ? { ...existingSettings } : {};
  const hostedAuthSeed = resolveWindowsHostedAuthSeed(options.env);
  if (!String(nextSettings.settingsMode || "").trim()) {
    nextSettings.settingsMode = "advanced";
  }
  if (!String(nextSettings.selectedModelId || "").trim()) {
    nextSettings.selectedModelId = "systemsculpt@@systemsculpt/ai-agent";
  }
  if (!String(nextSettings.vaultInstanceId || "").trim()) {
    nextSettings.vaultInstanceId = generateVaultInstanceId();
  }
  nextSettings.desktopAutomationBridgeEnabled = true;
  if (hostedAuthSeed) {
    Object.assign(nextSettings, hostedAuthSeed);
  }
  return nextSettings;
}

export async function copyProductionPluginArtifacts({ repoRoot, pluginDir }) {
  const inspection = assertProductionPluginArtifacts({ root: repoRoot });
  await fs.mkdir(pluginDir, { recursive: true });
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    const sourcePath = path.join(inspection.root, fileName);
    const destinationPath = path.join(pluginDir, fileName);
    await fs.copyFile(sourcePath, destinationPath);
  }
  return inspection;
}

export async function prepareWindowsDesktopVault(options = {}) {
  const repoRoot = path.resolve(String(options.repoRoot || process.cwd()));
  const vaultPath = path.resolve(
    String(options.vaultPath || resolveDefaultWindowsVaultPath({ vaultName: options.vaultName, env: options.env }))
  );
  const vaultName = String(options.vaultName || path.basename(vaultPath)).trim() || path.basename(vaultPath);
  const pluginId = String(options.pluginId || DEFAULT_PLUGIN_ID).trim() || DEFAULT_PLUGIN_ID;
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", pluginId);
  const syncConfigPath = path.resolve(
    String(options.syncConfigPath || resolveDefaultWindowsSyncConfigPath({ repoRoot }))
  );
  const piAgentDir = path.resolve(
    String(options.piAgentDir || resolveDefaultWindowsPiAgentDir(vaultPath))
  );

  if (options.resetVault) {
    await fs.rm(vaultPath, { recursive: true, force: true });
  }

  await fs.mkdir(vaultPath, { recursive: true });
  await fs.mkdir(piAgentDir, { recursive: true });
  await copyProductionPluginArtifacts({ repoRoot, pluginDir });

  const obsidianDir = path.join(vaultPath, ".obsidian");
  await fs.mkdir(obsidianDir, { recursive: true });
  const appJsonPath = path.join(obsidianDir, "app.json");
  const appearanceJsonPath = path.join(obsidianDir, "appearance.json");
  const communityPluginsPath = path.join(obsidianDir, "community-plugins.json");
  const pluginDataPath = path.join(pluginDir, "data.json");

  const existingPluginData = await readJsonIfExists(pluginDataPath);
  const nextPluginData = createWindowsSeedPluginData(existingPluginData, {
    env: options.env,
  });
  const existingAppState = await readJsonIfExists(appJsonPath);
  const existingAppearanceState = await readJsonIfExists(appearanceJsonPath);

  await Promise.all([
    writeJson(appJsonPath, isObject(existingAppState) ? existingAppState : {}),
    writeJson(appearanceJsonPath, isObject(existingAppearanceState) ? existingAppearanceState : {}),
    writeJson(communityPluginsPath, [pluginId]),
    writeJson(pluginDataPath, nextPluginData),
    writeJson(syncConfigPath, {
      pluginTargets: [{ path: pluginDir }],
      mirrorTargets: [],
    }),
    fs.writeFile(path.join(vaultPath, "Welcome.md"), "# SystemSculpt Windows QA\n", "utf8"),
  ]);

  return {
    repoRoot,
    vaultName,
    vaultPath,
    pluginId,
    pluginDir,
    pluginDataPath,
    syncConfigPath,
    piAgentDir,
    pluginData: nextPluginData,
  };
}
