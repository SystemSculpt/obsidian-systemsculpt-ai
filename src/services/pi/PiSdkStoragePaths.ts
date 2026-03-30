import type SystemSculptPlugin from "../../main";
import {
  joinFilesystemPath,
  normalizeVaultRelativePath,
  resolveAbsoluteVaultPath,
} from "../../utils/vaultPathUtils";

const PI_AGENT_DIR_ENV_KEY = "PI_CODING_AGENT_DIR";

export const DEFAULT_PI_AGENT_VAULT_DIR = normalizeVaultRelativePath(".systemsculpt/pi-agent");
export const DEFAULT_PI_MODELS_VAULT_PATH = normalizeVaultRelativePath(
  `${DEFAULT_PI_AGENT_VAULT_DIR}/models.json`,
);
export const DEFAULT_PI_AUTH_VAULT_PATH = normalizeVaultRelativePath(
  `${DEFAULT_PI_AGENT_VAULT_DIR}/auth.json`,
);

function resolveHomeDirFromEnv(): string {
  return String(process?.env?.HOME || process?.env?.USERPROFILE || "").trim();
}

function expandHomePrefix(pathValue: string): string {
  const normalized = String(pathValue || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized === "~") {
    return resolveHomeDirFromEnv();
  }

  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    const homeDir = resolveHomeDirFromEnv();
    if (!homeDir) {
      return normalized.slice(2);
    }
    return joinFilesystemPath(homeDir, normalized.slice(2));
  }

  return normalized;
}

function readPiAgentDirOverride(): string {
  return expandHomePrefix(String(process?.env?.[PI_AGENT_DIR_ENV_KEY] || "").trim());
}

function resolvePluginVaultPath(
  plugin: Pick<SystemSculptPlugin, "app"> | null | undefined,
  vaultPath: string,
): string | null {
  const absolutePath = resolveAbsoluteVaultPath(plugin?.app?.vault?.adapter, vaultPath);
  if (typeof absolutePath === "string" && absolutePath.trim().length > 0) {
    return absolutePath;
  }

  const adapter = plugin?.app?.vault?.adapter as
    | { getBasePath?: () => string; basePath?: string }
    | null
    | undefined;
  const basePath =
    (typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : adapter?.basePath) ||
    "";
  if (typeof basePath !== "string" || basePath.trim().length === 0) {
    return null;
  }

  return joinFilesystemPath(basePath, normalizeVaultRelativePath(vaultPath));
}

export function resolvePiAgentDir(
  plugin?: Pick<SystemSculptPlugin, "app"> | null,
): string | null {
  const overridePath = readPiAgentDirOverride();
  if (overridePath) {
    return overridePath;
  }
  return resolvePluginVaultPath(plugin, DEFAULT_PI_AGENT_VAULT_DIR);
}

export function resolvePiAuthPath(
  plugin?: Pick<SystemSculptPlugin, "app"> | null,
): string | null {
  const overridePath = readPiAgentDirOverride();
  if (overridePath) {
    return joinFilesystemPath(overridePath, "auth.json");
  }
  return resolvePluginVaultPath(plugin, DEFAULT_PI_AUTH_VAULT_PATH);
}

export function resolvePiModelsPath(
  plugin?: Pick<SystemSculptPlugin, "app"> | null,
): string | null {
  const overridePath = readPiAgentDirOverride();
  if (overridePath) {
    return joinFilesystemPath(overridePath, "models.json");
  }
  return resolvePluginVaultPath(plugin, DEFAULT_PI_MODELS_VAULT_PATH);
}

export function getPiModelsDisplayPath(
  plugin?: Pick<SystemSculptPlugin, "app"> | null,
): string {
  const overridePath = readPiAgentDirOverride();
  if (overridePath) {
    return joinFilesystemPath(overridePath, "models.json");
  }
  return DEFAULT_PI_MODELS_VAULT_PATH;
}
