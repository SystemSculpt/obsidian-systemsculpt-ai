const FUSED_BOLD_HEADING = /([^\s])(\*\*[^*\n]+?\*\*(?=\s*(?:\r?\n)))/g;

/**
 * Ensures bold reasoning headings are displayed on their own line without mutating stored text.
 */
export function formatReasoningForDisplay(markdown: string): string {
  if (!markdown) return markdown;

  return markdown.replace(FUSED_BOLD_HEADING, (_match, precedingChar, heading) => {
    return `${precedingChar}\n\n${heading}`;
  });
}
