type VaultAdapterLike = {
  getFullPath?: (path: string) => string;
  basePath?: string;
};

type VaultPathOptions = {
  /** Tool inputs may contain an Obsidian URI path; stored filenames must not be decoded. */
  decodeUri?: boolean;
  /** Trim UI input by default; false preserves whitespace in existing on-disk paths. */
  trim?: boolean;
  /** Keep literal Unicode and nonbreaking spaces instead of Obsidian's character normalization. */
  preserveCharacters?: boolean;
  /** Validate before repairing separators or removing a leading slash. */
  validateRelative?: {
    allowLeadingDot?: boolean;
    allowRepeatedSeparators?: boolean;
  };
};

/**
 * Canonical vault-relative separators, with an empty string representing the root.
 * Does not sanitize filenames or resolve dot segments. Callers that require a
 * nonempty relative directory opt into validation and translate its error locally.
 */
export function normalizeVaultRelativePath(value: string, options: VaultPathOptions = {}): string {
  if (options.validateRelative && typeof value !== "string") {
    throw new Error("Invalid vault-relative directory path.");
  }
  let raw = String(value ?? "");
  if (options.trim !== false) raw = raw.trim();
  if (options.decodeUri) {
    // Preserve the tool contract's two passes and malformed-escape fallback.
    // Do not trim again: encoded spaces can be part of an existing filename.
    for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(raw); i++) {
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded === raw) break;
        raw = decoded;
      } catch {
        break;
      }
    }
  }
  raw = raw.replace(/\\/g, "/");
  if (options.validateRelative?.allowLeadingDot) raw = raw.replace(/^\.\//, "");
  raw = raw.replace(/\/+$/, "");
  if (options.validateRelative) {
    const invalidSegment = raw.split("/").some((part) =>
      part === "." || part === ".." || (!part && !options.validateRelative?.allowRepeatedSeparators),
    );
    if (!raw || raw.startsWith("/") || invalidSegment) {
      throw new Error("Invalid vault-relative directory path.");
    }
  }
  const normalized = raw.replace(/\/{2,}/g, "/").replace(/^\/+/, "");
  // Match Obsidian normalizePath without depending on host mocks or its root "/" sentinel.
  return options.preserveCharacters
    ? normalized
    : normalized.replace(/[\xA0\u{202F}]/gu, " ").normalize("NFC");
}

export function joinFilesystemPath(basePath: string, ...segments: string[]): string {
  const normalizedBasePath = String(basePath || "").trim();
  if (!normalizedBasePath) {
    return "";
  }

  // Windows bases join with "\\", POSIX with "/". The segments are already
  // normalized to clean "/"-split parts, so a pure join is exact here — no
  // node:path dependency needed, which keeps the shared utility deterministic
  // for any Obsidian vault adapter.
  const separator =
    normalizedBasePath.includes("\\") || /^[a-zA-Z]:/.test(normalizedBasePath) ? "\\" : "/";
  const normalizedSegments = segments
    .flatMap((segment) => normalizeVaultRelativePath(segment).split("/"))
    .filter(Boolean);
  if (normalizedSegments.length === 0) {
    return normalizedBasePath;
  }
  // Trim a trailing separator off the base so we never emit a doubled one,
  // matching path.join's boundary behavior.
  const trimmedBase = normalizedBasePath.replace(/[\\/]+$/, "");
  return `${trimmedBase}${separator}${normalizedSegments.join(separator)}`;
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
