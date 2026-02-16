import YAML from "yaml";

export type PromptNoteParseResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      frontmatter: Record<string, unknown>;
      frontmatterText: string | null;
      body: string;
    };

export type CanvasFlowPromptConfig = {
  kind: "prompt";
  backend: "openrouter";
  imageModelId: string | null;
  imageCount: number;
  aspectRatio: string | null;
  seed: number | null;
};

export type CanvasFlowPromptParseResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      config: CanvasFlowPromptConfig;
      frontmatter: Record<string, unknown>;
      frontmatterText: string | null;
      body: string;
    };

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function parseMarkdownFrontmatter(markdown: string): PromptNoteParseResult {
  const src = String(markdown ?? "");
  const match = src.match(FRONTMATTER_RE);
  if (!match) {
    return {
      ok: true,
      frontmatter: {},
      frontmatterText: null,
      body: src,
    };
  }

  const frontmatterText = match[1] ?? "";
  const body = src.slice(match[0].length);

  try {
    const parsed = YAML.parse(frontmatterText);
    return {
      ok: true,
      frontmatter: isRecord(parsed) ? parsed : {},
      frontmatterText,
      body,
    };
  } catch (error: any) {
    return { ok: false, reason: `Invalid frontmatter YAML: ${error?.message || error}` };
  }
}

export function isCanvasFlowPromptFrontmatter(frontmatter: Record<string, unknown>): boolean {
  const kind = String(frontmatter["ss_flow_kind"] || "").trim().toLowerCase();
  return kind === "prompt";
}

export function parseCanvasFlowPromptNote(markdown: string): CanvasFlowPromptParseResult {
  const parsed = parseMarkdownFrontmatter(markdown);
  if (!parsed.ok) {
    return parsed;
  }

  if (!isCanvasFlowPromptFrontmatter(parsed.frontmatter)) {
    return { ok: false, reason: "not-canvasflow-prompt" };
  }

  const backendRaw = String(parsed.frontmatter["ss_flow_backend"] || "openrouter").trim().toLowerCase();
  const allowedBackends = new Set(["openrouter", "systemsculpt"]);
  if (!allowedBackends.has(backendRaw)) {
    return { ok: false, reason: `unsupported backend: ${backendRaw || "(empty)"}` };
  }

  const imageOptions = isRecord(parsed.frontmatter["ss_image_options"])
    ? (parsed.frontmatter["ss_image_options"] as Record<string, unknown>)
    : {};

  const imageModelId = readString(parsed.frontmatter["ss_image_model"])?.trim() || null;

  const imageCountRaw = readNumber(parsed.frontmatter["ss_image_count"]) ?? readNumber(imageOptions["count"]);
  const imageCount = imageCountRaw === null ? 1 : Math.max(1, Math.min(4, Math.floor(imageCountRaw)));

  const aspectRatio =
    readString(parsed.frontmatter["ss_image_aspect_ratio"])?.trim() ||
    readString(imageOptions["aspect_ratio"])?.trim() ||
    readString(imageOptions["aspectRatio"])?.trim() ||
    null;

  const seedRaw = readNumber(parsed.frontmatter["ss_seed"]) ?? readNumber(imageOptions["seed"]);
  const seed = seedRaw === null ? null : Math.max(0, Math.floor(seedRaw));

  return {
    ok: true,
    config: {
      kind: "prompt",
      backend: "openrouter",
      imageModelId,
      imageCount,
      aspectRatio,
      seed,
    },
    frontmatter: parsed.frontmatter,
    frontmatterText: parsed.frontmatterText,
    body: parsed.body,
  };
}

export function replaceMarkdownBodyPreservingFrontmatter(markdown: string, nextBody: string): string {
  const src = String(markdown ?? "");
  const match = src.match(FRONTMATTER_RE);
  const body = String(nextBody ?? "");

  if (!match) {
    return body.endsWith("\n") ? body : `${body}\n`;
  }

  const frontmatterBlock = match[0];
  const trimmedBody = body.replace(/^\n+/, "");
  const out = `${frontmatterBlock}${trimmedBody}`;
  return out.endsWith("\n") ? out : `${out}\n`;
}

export function replaceMarkdownFrontmatterAndBody(
  markdown: string,
  nextFrontmatter: Record<string, unknown>,
  nextBody: string
): string {
  const body = String(nextBody ?? "");

  const yamlText = String(YAML.stringify(nextFrontmatter) || "").trimEnd();
  const fmBlock = yamlText.trim().length ? `---\n${yamlText}\n---\n` : `---\n---\n`;

  const trimmedBody = body.replace(/^\n+/, "");
  const out = `${fmBlock}${trimmedBody}`;
  return out.endsWith("\n") ? out : `${out}\n`;
}
