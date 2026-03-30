import path from "node:path";
import { normalizePath } from "obsidian";

type VaultAdapterLike = {
  getFullPath?: (path: string) => string;
  basePath?: string;
};

export function normalizeVaultRelativePath(value: string): string {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  const normalized =
    typeof normalizePath === "function" ? normalizePath(raw) : raw.replace(/\/{2,}/g, "/");
  return normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function joinFilesystemPath(basePath: string, ...segments: string[]): string {
  const normalizedBasePath = String(basePath || "").trim();
  if (!normalizedBasePath) {
    return "";
  }

  const pathApi =
    normalizedBasePath.includes("\\") || /^[a-zA-Z]:/.test(normalizedBasePath)
      ? path.win32
      : path.posix;
  const normalizedSegments = segments
    .flatMap((segment) => normalizeVaultRelativePath(segment).split("/"))
    .filter(Boolean);
  return normalizedSegments.length > 0
    ? pathApi.join(normalizedBasePath, ...normalizedSegments)
    : normalizedBasePath;
}

export function resolveAbsoluteVaultPath(adapterLike: unknown, vaultPath: string): string | null {
  const normalizedVaultPath = normalizeVaultRelativePath(vaultPath);
  if (!normalizedVaultPath) {
    return null;
  }

  const adapter = adapterLike as VaultAdapterLike | null;
  if (adapter && typeof adapter.getFullPath === "function") {
    try {
      const fullPath = adapter.getFullPath(normalizedVaultPath);
      if (typeof fullPath === "string" && fullPath.trim().length > 0) {
        return fullPath;
      }
    } catch {
      // Fall through to base path fallback.
    }
  }

  if (adapter && typeof adapter.basePath === "string" && adapter.basePath.trim().length > 0) {
    return joinFilesystemPath(adapter.basePath.replace(/[\\/]+$/, ""), normalizedVaultPath);
  }

  return null;
}

export function isAbsoluteFilesystemPath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}
