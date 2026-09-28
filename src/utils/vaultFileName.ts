import { replaceControlCharacters } from "./characterValidation";

/**
 * The one sanitizer for file and folder names the plugin creates in a vault.
 *
 * A name that one device accepts can still be impossible on another. Obsidian
 * Sync then retries it forever, rescanning the vault each time. Every name the
 * plugin generates, and every name an agent asks it to create, passes through
 * here so it works on Windows, macOS, iOS, Android and in Obsidian Sync, and
 * keeps working inside [[wikilinks]].
 */

/**
 * Characters Windows, Android and iOS reject in a name, plus the characters
 * that break Obsidian links (`#`, `^`, `[`, `]`). Line breaks and tabs become
 * spaces and other control characters become `?` first, so they join a run. Whitespace around a run is
 * absorbed so "Meeting: notes" becomes "Meeting notes", not "Meeting  notes".
 */
const UNSAFE_RUN = / *(?:[<>:"/\\|?*#^[\]]+ *)+/g;

/** Windows device names. They stay reserved when followed by any extension. */
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * A trailing extension is kept intact when a name is shortened or its stem is
 * empty. Only plain alphanumeric extensions count, so "v1.2 notes" is a stem.
 */
const TRAILING_EXTENSION = /^(.*[^.\s])(\.[A-Za-z0-9]{1,16})$/s;

/**
 * Filesystems cap one name at 255 bytes. Leave room for the collision and
 * conflict suffixes Obsidian and Obsidian Sync append to a name.
 */
export const MAX_VAULT_FILE_NAME_BYTES = 200;

export type SafeVaultFileNameOptions = {
  /**
   * Returned when nothing safe remains. A name with an extension keeps it.
   * Defaults to "Untitled"; pass "" to let the caller choose its own default.
   */
  fallback?: string;
  /** Replaces each run of unsafe characters. Defaults to a space. */
  replacement?: string;
  /** Maximum UTF-8 length of the whole name. */
  maxBytes?: number;
};

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function replaceUnsafeRuns(value: string, replacement: string): string {
  return value.replace(UNSAFE_RUN, (run) => {
    const spaced = run.startsWith(" ") || run.endsWith(" ");
    if (!replacement.trim()) return spaced ? " " : replacement;
    return `${run.startsWith(" ") ? " " : ""}${replacement}${run.endsWith(" ") ? " " : ""}`;
  });
}

function trimEdges(value: string): string {
  // A leading dot hides a file from Obsidian; Windows drops trailing dots and
  // spaces, so two devices would disagree about the name.
  return value.replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");
}

function avoidReservedStem(value: string): string {
  const dot = value.indexOf(".");
  const stem = dot < 0 ? value : value.slice(0, dot);
  if (!WINDOWS_RESERVED_STEM.test(stem.trimEnd())) return value;
  return `${stem.trimEnd()}_${dot < 0 ? "" : value.slice(dot)}`;
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const size = utf8Length(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

function sanitizeStem(value: string, replacement: string): string {
  const visible = replaceControlCharacters(value.replace(/[\t\n\v\f\r]+/g, " "), "?", true);
  return trimEdges(replaceUnsafeRuns(visible, replacement));
}

/**
 * Return a name that is valid on every platform Obsidian runs on. A name that
 * is already safe is returned unchanged.
 */
export function toSafeVaultFileName(
  name: string,
  options: SafeVaultFileNameOptions = {},
): string {
  const fallback = options.fallback ?? "Untitled";
  const replacement = options.replacement ?? " ";
  const maxBytes = Math.max(16, Math.floor(options.maxBytes ?? MAX_VAULT_FILE_NAME_BYTES));
  const raw = String(name ?? "");

  const extensionMatch = TRAILING_EXTENSION.exec(raw);
  const extension = extensionMatch ? extensionMatch[2] : "";
  let stem = sanitizeStem(extensionMatch ? extensionMatch[1] : raw, replacement);
  if (!stem) {
    if (!fallback) return "";
    stem = fallback;
  }

  let safe = avoidReservedStem(`${stem}${extension}`);
  if (utf8Length(safe) > maxBytes) {
    const room = Math.max(1, maxBytes - utf8Length(extension));
    const shortened = trimEdges(truncateToBytes(safe.slice(0, safe.length - extension.length), room));
    safe = avoidReservedStem(`${shortened || fallback || "Untitled"}${extension}`);
  }
  return safe;
}

/** True when {@link toSafeVaultFileName} would keep this name unchanged. */
export function isSafeVaultFileName(name: string): boolean {
  return name.length > 0 && toSafeVaultFileName(name, { fallback: "" }) === name;
}
