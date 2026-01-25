import { Annotation } from "../../../types";

export function extractAnnotationsFromResponse(responseText: string): Annotation[] {
  const annotations: Annotation[] = [];
  try {
    const markdownLinkRegex = /\[([^\]]+)\]\(([^\)]+)\)/g;
    let match: RegExpExecArray | null;

    while ((match = markdownLinkRegex.exec(responseText)) !== null) {
      const domain = match[1];
      const url = match[2];

      const surroundingTextStart = Math.max(0, match.index - 200);
      const surroundingTextEnd = Math.min(responseText.length, match.index + match[0].length + 200);
      const surroundingText = responseText.substring(surroundingTextStart, surroundingTextEnd);

      const sentences = surroundingText.split(/(?<=\.|\?|\!)\s+/);
      const matchText = match[0];
      const sentenceWithCitation = sentences.find(s => s.includes(matchText)) || "";

      annotations.push({
        type: "url_citation",
        url_citation: {
          title: `Source: ${domain}`,
          url: url,
          content: sentenceWithCitation.replace(match[0], "").trim(),
          start_index: match.index,
          end_index: match.index + match[0].length
        }
      } as any);
    }
  } catch (_error) {
    // Swallow errors – annotations are optional and should not break flow
  }
  return annotations;
}


