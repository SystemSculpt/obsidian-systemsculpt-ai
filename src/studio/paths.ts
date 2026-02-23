import { normalizePath } from "obsidian";
import { STUDIO_PROJECT_EXTENSION } from "./types";

export const DEFAULT_STUDIO_PROJECTS_DIR = "SystemSculpt/Studio" as const;
const DEFAULT_STUDIO_PROJECT_NAME = "Untitled Studio Project" as const;

function trimSlashes(input: string): string {
  return input.replace(/^\/+|\/+$/g, "");
}

export function sanitizeStudioProjectName(name: string): string {
  const raw = String(name || "").trim();
  if (!raw) {
    return DEFAULT_STUDIO_PROJECT_NAME;
  }

  const safe = raw
    // Block path separators and filesystem-reserved characters.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  return safe || DEFAULT_STUDIO_PROJECT_NAME;
}

export function normalizeStudioProjectPath(path: string): string {
  const normalized = normalizePath(trimSlashes(String(path || "").trim()));
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
  return normalizePath(`${baseName}.systemsculpt-assets`);
}

export function deriveStudioPolicyPath(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizePath(`${assetsDir}/policy/grants.json`);
}

export function deriveStudioRunsDir(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizePath(`${assetsDir}/runs`);
}

export function deriveStudioAssetBlobDir(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizePath(`${assetsDir}/assets/sha256`);
}

export function deriveStudioNodeCachePath(projectPath: string): string {
  const assetsDir = deriveStudioAssetsDir(projectPath);
  return normalizePath(`${assetsDir}/cache/node-results.json`);
}
