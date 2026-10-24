import { normalizeVaultRelativePath } from "../utils/vaultPathUtils";
import { toSafeVaultFileName } from "../utils/vaultFileName";
import { STUDIO_PROJECT_EXTENSION } from "./types";

export const DEFAULT_STUDIO_PROJECTS_DIR = "SystemSculpt/Studio" as const;
const DEFAULT_STUDIO_PROJECT_NAME = "Untitled Studio Project" as const;

export function sanitizeStudioProjectName(name: string): string {
  const raw = String(name || "").trim();
  if (!raw) {
    return DEFAULT_STUDIO_PROJECT_NAME;
  }

  return toSafeVaultFileName(raw.replace(/\s+/g, " "), { fallback: DEFAULT_STUDIO_PROJECT_NAME });
}

export function normalizeStudioProjectPath(path: string): string {
  const normalized = normalizeVaultRelativePath(path);
  if (!normalized) {
    throw new Error("Studio project path cannot be empty.");
  }

  if (!normalized.toLowerCase().endsWith(STUDIO_PROJECT_EXTENSION)) {
    return `${normalized}${STUDIO_PROJECT_EXTENSION}`;
  }

  return normalized;
}

export function deriveStudioAssetsDir(projectPath: string): string {
  const normalized = normalizeStudioProjectPath(projectPath);
  const baseName = normalized.slice(0, -STUDIO_PROJECT_EXTENSION.length);
  return normalizeVaultRelativePath(`${baseName}.systemsculpt-assets`);
}

export function deriveStudioPolicyPath(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizeVaultRelativePath(`${assetsDir}/policy/grants.json`);
}

export function deriveStudioRunsDir(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizeVaultRelativePath(`${assetsDir}/runs`);
}

export function deriveStudioAssetBlobDir(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizeVaultRelativePath(`${assetsDir}/assets/sha256`);
}

export function deriveStudioImportsDir(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizeVaultRelativePath(`${assetsDir}/imports`);
}

export function deriveStudioNodeCachePath(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizeVaultRelativePath(`${assetsDir}/cache/node-results.json`);
}
