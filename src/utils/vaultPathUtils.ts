import { normalizePath } from "obsidian";

type VaultAdapterLike = {
  getFullPath?: (path: string) => string;
  basePath?: string;
};

export function resolveAbsoluteVaultPath(adapterLike: unknown, vaultPath: string): string | null {
  const normalizedVaultPath = normalizePath(String(vaultPath || "").trim().replace(/\\/g, "/")).replace(/^\/+/, "");
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
    const basePath = adapter.basePath.replace(/[\\/]+$/, "");
    const separator = basePath.includes("\\") ? "\\" : "/";
    const normalizedRelative = normalizedVaultPath.split(/[\\/]+/).filter(Boolean).join(separator);
    return normalizedRelative ? `${basePath}${separator}${normalizedRelative}` : basePath;
  }

  return null;
}

export function isAbsoluteFilesystemPath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}
