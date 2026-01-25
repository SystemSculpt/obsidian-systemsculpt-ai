/**
 * Trim only outer blank lines (lines that contain only whitespace) from a string.
 * Preserves internal newlines and leading spaces on the first/last non-blank line.
 */
export function trimOuterBlankLines(input: string | null | undefined): string {
  if (input == null) return '';
  let text = String(input);
  // Remove leading blank lines (optionally containing spaces/tabs)
  text = text.replace(/^(?:[ \t]*\r?\n)+/, '');
  // Remove trailing blank lines (optionally containing spaces/tabs)
  text = text.replace(/(?:\r?\n[ \t]*)+$/, '');
  return text;
}

