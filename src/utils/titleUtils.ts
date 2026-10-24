/**
 * Utility functions for handling chat titles
 */

/**
 * Generates a default chat title using the current date and time.
 * The locale format can contain `/` and `:`, so this is a display title only;
 * a file name derived from it must go through `toSafeVaultFileName`.
 * @returns A formatted chat title string
 */
export function generateDefaultChatTitle(): string {
  const now = new Date();
  return `Chat ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
}

/** A title generateDefaultChatTitle made, rather than one a person typed. */
export function isGeneratedChatTitle(title: string): boolean {
  return /^Chat \d/.test(title.trim());
}

/**
 * A chat title as display text: one line, spaces collapsed, every character
 * the person wrote kept (a path such as `/Users/me/notes` stays readable).
 * Chat files are named by chat ID; a file name derived from a title must go
 * through `toSafeVaultFileName`.
 */
export function normalizeChatTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/**
 * The title a chat gets from its first message: the first line, up to 64
 * characters, with [[links]] read as their note names.
 */
export function chatTitleFromMessage(text: string): string {
  // A starter or mention writes [[Note]]; the title reads as plain words.
  const readable = text.replace(
    /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
    (_link, target: string, alias?: string) => alias?.trim() || target.split("/").pop()!.replace(/\.md$/i, ""),
  );
  const firstLine = normalizeChatTitle(readable.replace(/^\s*#+\s*/, "").split("\n")[0]);
  const compact = firstLine.length > 64 ? `${firstLine.slice(0, 61).trimEnd()}…` : firstLine;
  return compact || generateDefaultChatTitle();
}

/**
 * Removes path separators and other filesystem-reserved characters from a
 * chat title. Chat files are named by chat ID, so this title is display text
 * and keeps characters such as `#` ("C#"). Any file or folder name derived
 * from a title must go through `toSafeVaultFileName` instead.
 * @param title The title to sanitize
 * @returns The title without path-breaking characters
 */
export function sanitizeChatTitle(title: string): string {
  // Remove characters that are invalid in filenames: \ / : * ? " < > |
  return title.replace(/[\\/:*?"<>|]/g, "");
} 