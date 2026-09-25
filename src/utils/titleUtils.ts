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