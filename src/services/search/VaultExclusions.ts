/**
 * The one exclusion policy shared by embeddings, the search modal, and the
 * agent vault tools.
 *
 * - `patterns` are globs matched without case. `*` stays inside one path
 *   segment, `**` spans segments, and `?` is one character. A pattern without
 *   `/` matches the file name; a pattern with `/` matches the vault path.
 * - Obsidian's "Excluded files" (`userIgnoreFilters`) match exactly as
 *   Obsidian does: `/regex/` entries are case-insensitive regexes, and any
 *   other entry is a case-insensitive path prefix.
 * - Folder rules come from the user's excluded folders and, while chat history
 *   is excluded, the configured chat directories. Chat history also covers
 *   `Chats` and `Saved Chats` folders on any path that mentions SystemSculpt,
 *   so transcripts left behind after a directory change stay excluded.
 * - Search surfaces also hide the configured plugin working folders
 *   (recordings, attachments, extractions), the Obsidian config folder, and
 *   node_modules. Embeddings only index notes the user can exclude directly.
 * - A folder is excluded when its own path matches, or when a rule covers
 *   everything under it: `Daily/**`, Obsidian's `Archive/` entries, and the
 *   SystemSculpt chat-folder rule describe a folder's contents, not the
 *   folder path itself.
 *
 * Rules compile once per distinct settings revision. Every input that changes
 * matching is part of the signature, including Obsidian's filters, which
 * change without a plugin settings event.
 */

export type VaultExclusionSurface = "embeddings" | "search";

export type VaultExclusionSettings = Readonly<{
  folders?: readonly unknown[] | null;
  patterns?: readonly unknown[] | null;
  ignoreChatHistory?: boolean | null;
  respectObsidianExclusions?: boolean | null;
}>;

type VaultDirectorySettings = Readonly<{
  chatsDirectory?: unknown;
  savedChatsDirectory?: unknown;
  recordingsDirectory?: unknown;
  attachmentsDirectory?: unknown;
  extractionsDirectory?: unknown;
}>;

type ExclusionVault = Readonly<{
  configDir?: unknown;
  getConfig?: (key: string) => unknown;
}>;

export type VaultExclusionSources = Readonly<{
  exclusions: VaultExclusionSettings | null | undefined;
  settings: VaultDirectorySettings | null | undefined;
  vault: ExclusionVault | null | undefined;
}>;

type ExclusionHost = Readonly<{
  settings?: (VaultDirectorySettings & Readonly<{
    embeddingsExclusions?: VaultExclusionSettings | null;
  }>) | null;
  app?: Readonly<{ vault?: ExclusionVault | null }> | null;
}>;

export interface VaultExclusions {
  /** Changes whenever an input that affects matching changes. */
  readonly signature: string;
  isExcluded(path: string): boolean;
  isFolderExcluded(path: string): boolean;
}

type CompiledGlob = Readonly<{ regex: RegExp; matchesPath: boolean }>;

const NODE_MODULES_PATTERN = "**/node_modules/**";
const COMPILED_CACHE_LIMIT = 8;
const compiledBySignature = new Map<string, VaultExclusions>();

export function resolveVaultExclusions(
  sources: VaultExclusionSources,
  surface: VaultExclusionSurface,
): VaultExclusions {
  const exclusions = sources.exclusions ?? {};
  const settings = sources.settings ?? {};
  const directories = directoryList(exclusions.folders);
  const patterns = stringList(exclusions.patterns);
  const excludeChatHistory = exclusions.ignoreChatHistory !== false;
  if (excludeChatHistory) {
    directories.push(...directoryList([settings.chatsDirectory, settings.savedChatsDirectory]));
  }
  if (surface === "search") {
    directories.push(...directoryList([
      sources.vault?.configDir,
      settings.recordingsDirectory,
      settings.attachmentsDirectory,
      settings.extractionsDirectory,
    ]));
    patterns.push(NODE_MODULES_PATTERN);
  }
  const ignoreFilters = exclusions.respectObsidianExclusions === false
    ? []
    : readUserIgnoreFilters(sources.vault);

  const signature = JSON.stringify([directories, patterns, ignoreFilters, excludeChatHistory]);
  const cached = compiledBySignature.get(signature);
  if (cached) return cached;
  if (compiledBySignature.size >= COMPILED_CACHE_LIMIT) {
    const oldest = compiledBySignature.keys().next().value;
    if (oldest !== undefined) compiledBySignature.delete(oldest);
  }
  const compiled = compileVaultExclusions(signature, directories, patterns, ignoreFilters, excludeChatHistory);
  compiledBySignature.set(signature, compiled);
  return compiled;
}

/** Search modal and agent vault tool policy for the plugin's current settings. */
export function searchVaultExclusions(plugin: ExclusionHost): VaultExclusions {
  return resolveVaultExclusions({
    exclusions: plugin.settings?.embeddingsExclusions,
    settings: plugin.settings,
    vault: plugin.app?.vault,
  }, "search");
}

function compileVaultExclusions(
  signature: string,
  directories: readonly string[],
  patterns: readonly string[],
  ignoreFilters: readonly string[],
  excludeChatHistory: boolean,
): VaultExclusions {
  const prefixes = [...new Set(directories.map((directory) => directory.toLowerCase()))];
  const globs = patterns.map(compileGlob);
  const filters = ignoreFilters.flatMap(compileUserIgnoreFilter);
  const matches = (normalized: string): boolean => {
    const lower = normalized.toLowerCase();
    for (const prefix of prefixes) {
      if (lower === prefix || lower.startsWith(`${prefix}/`)) return true;
    }
    if (
      excludeChatHistory
      && lower.includes("systemsculpt")
      && (lower.includes("/chats/") || lower.includes("/saved chats/"))
    ) return true;
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    for (const glob of globs) {
      if (glob.regex.test(glob.matchesPath ? normalized : name)) return true;
    }
    for (const filter of filters) {
      if (filter.test(normalized)) return true;
    }
    return false;
  };
  return Object.freeze({
    signature,
    isExcluded(path: string): boolean {
      const normalized = normalizePath(path);
      return normalized.length > 0 && matches(normalized);
    },
    isFolderExcluded(path: string): boolean {
      const normalized = normalizePath(path);
      // The trailing slash asks whether a rule covers the folder's contents.
      return normalized.length > 0 && (matches(normalized) || matches(`${normalized}/`));
    },
  });
}

function compileGlob(pattern: string): CompiledGlob {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*\*\/|\*\*|\*|\?/g, (token) => (
    token === "**/" ? "(?:.*/)?" : token === "**" ? ".*" : token === "*" ? "[^/]*" : "[^/]"
  ));
  return { regex: new RegExp(`^${source}$`, "i"), matchesPath: pattern.includes("/") };
}

/** Mirrors Obsidian's MetadataCache.updateUserIgnoreFilters (1.13). */
function compileUserIgnoreFilter(filter: string): RegExp[] {
  try {
    return [filter.length > 2 && filter.startsWith("/") && filter.endsWith("/")
      ? new RegExp(filter.slice(1, -1), "i")
      : new RegExp(`^${filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")];
  } catch {
    // Obsidian skips filters that are not valid regexes too.
    return [];
  }
}

function readUserIgnoreFilters(vault: ExclusionVault | null | undefined): string[] {
  try {
    return stringList(vault?.getConfig?.("userIgnoreFilters"));
  } catch {
    return [];
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function directoryList(value: unknown): string[] {
  return stringList(value)
    .map(normalizePath)
    .filter((directory) => directory.length > 0);
}

function normalizePath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
