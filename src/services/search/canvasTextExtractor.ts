export interface CanvasTextExtractionOptions {
  maxChars: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function extractCanvasText(raw: string, options: CanvasTextExtractionOptions): string {
  if (!raw || typeof raw !== "string") return "";
  const maxChars = Math.max(0, options.maxChars);
  if (maxChars === 0) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }

  if (!isRecord(parsed)) return "";

  let output = "";
  let exhausted = false;

  const append = (value: unknown) => {
    if (exhausted) return;
    const asString = readString(value);
    if (!asString) return;
    const trimmed = asString.trim();
    if (!trimmed) return;

    const sep = output.length === 0 ? "" : "\n";
    const remaining = maxChars - output.length;

    if (remaining <= sep.length) {
      exhausted = true;
      return;
    }

    if (sep.length + trimmed.length <= remaining) {
      output += sep + trimmed;
      return;
    }

    const sliceLen = remaining - sep.length;
    const sliced = trimmed.slice(0, sliceLen).trim();
    if (sliced.length === 0) {
      exhausted = true;
      return;
    }
    output += sep + sliced;
    exhausted = true;
  };

  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;

    // Prefer the meaningful, user-visible strings.
    append(node.title);
    append(node.label);
    append(node.text);
    append(node.file);
    append(node.subpath);
    append(node.url);
  }

  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  for (const edge of edges) {
    if (!isRecord(edge)) continue;
    append(edge.label);
  }

  return output;
}

