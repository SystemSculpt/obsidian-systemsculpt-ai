/**
 * Note text as a search result shows it: the words a person wrote, without
 * the Markdown around them. "## Where the ferry crossed" and "**Time:**" read
 * as "Where the ferry crossed" and "Time:", and a heading or list item no
 * longer runs straight into the next line's sentence.
 */
export function markdownExcerptText(text: string): string {
  let out = "";
  // How the next line joins the text so far: a space inside a paragraph, a
  // separator after a heading, list item or paragraph end.
  let join: "space" | "block" = "space";
  let fenced = false;

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      join = "block";
      continue;
    }
    if (!line) {
      join = "block";
      continue;
    }
    if (!fenced && /^([-*_])(\s*\1){2,}$/.test(line)) {
      join = "block";
      continue;
    }

    let block = false;
    if (!fenced) {
      const quote = line.replace(/^(>\s?)+/, "");
      if (quote !== line) {
        line = quote.replace(/^\[![^\]]*\][+-]?\s*/, "");
        block = true;
      }
      const heading = line.replace(/^#{1,6}\s+/, "");
      if (heading !== line) {
        line = heading.replace(/\s+#+\s*$/, "");
        block = true;
      }
      const item = line.replace(/^([-*+]|\d+[.)])\s+(\[[^\]]\]\s+)?/, "");
      if (item !== line) {
        line = item;
        block = true;
      }
      if (/^\|.*\|$/.test(line)) {
        if (/^\|[\s:|-]+\|$/.test(line)) continue;
        line = line.slice(1, -1).split("|").map((cell) => cell.trim()).filter(Boolean).join(" · ");
        block = true;
      }
      line = inlineText(line);
    }
    if (!line) continue;

    if (out) {
      out += join === "block" && !/[.!?:;,…·—–-]$/.test(out) ? " · " : " ";
    }
    out += line;
    join = block ? "block" : "space";
  }
  return out;
}

function inlineText(line: string): string {
  return line
    // Embedded images and files show nothing of their own.
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]|#]*)(?:#([^\]|]*))?\]\]/g, (_, target: string, heading?: string) => target || heading || "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~|==)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}*_])([*_])(?=\S)([^*_]*?\S)\2(?![\p{L}\p{N}])/gu, "$1$3")
    // Block references ("^audio-seg-000007") are anchors, not words.
    .replace(/\s\^[\w-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
