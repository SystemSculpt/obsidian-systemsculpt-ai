/**
 * Utility functions for handling chat titles
 */

/**
 * Generates a default chat title using the current date and time
 * @returns A formatted chat title string
 */
export function generateDefaultChatTitle(): string {
  const now = new Date();
  return `Chat ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
}

/**
 * Sanitizes a title to ensure it doesn't contain characters that are invalid in filenames
 * @param title The title to sanitize
 * @returns A sanitized title safe for use as a filename
 */
export function sanitizeChatTitle(title: string): string {
  // Remove characters that are invalid in filenames: \ / : * ? " < > |
  return title.replace(/[\\/:*?"<>|]/g, "");
} 