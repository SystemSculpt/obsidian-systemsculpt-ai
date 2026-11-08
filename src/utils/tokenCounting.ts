const CHARS_PER_TOKEN = 4;

/**
 * Approximate text size for local display and response-budget diagnostics,
 * without retaining disposable strings such as trial tool pages.
 * This estimate never controls managed request admission, batching, or content;
 * the SystemSculpt API remains authoritative for those decisions.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  const urls = (text.match(/https?:\/\/[^\s)]+/gi) ?? []) as string[];
  const urlCharacters = urls.reduce<number>((sum, match) => sum + match.length, 0);
  const cjkCharacters = ((
    text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? []
  ) as string[]).length;
  const emojiCount = ((
    text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []
  ) as string[]).length;
  const ordinaryCharacters = Math.max(0, text.length - urlCharacters - cjkCharacters - emojiCount);

  const characterEstimate =
    urlCharacters / 3.2
    + cjkCharacters
    + emojiCount * 2
    + ordinaryCharacters / CHARS_PER_TOKEN;
  const wordEstimate = words.length * 1.3;
  const estimate = Math.ceil(Math.max(wordEstimate, characterEstimate));

  return estimate;
}
