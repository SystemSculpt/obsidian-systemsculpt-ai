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
  backend: "replicate";
  replicateModelSlug: string | null;
  replicateVersionId: string | null;
  replicatePromptKey: string;
  replicateImageKey: string;
  replicateInput: Record<string, unknown>;
  imageCount: number;
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

  const backend = String(parsed.frontmatter["ss_flow_backend"] || "replicate").trim().toLowerCase();
  if (backend !== "replicate") {
    return { ok: false, reason: `unsupported backend: ${backend || "(empty)"}` };
  }

  const replicateModelSlug = readString(parsed.frontmatter["ss_replicate_model"])?.trim() || null;
  const replicateVersionId = readString(parsed.frontmatter["ss_replicate_version"])?.trim() || null;
  const replicatePromptKey = readString(parsed.frontmatter["ss_replicate_prompt_key"])?.trim() || "prompt";
  const replicateImageKey = readString(parsed.frontmatter["ss_replicate_image_key"])?.trim() || "image";

  const imageCountRaw = readNumber(parsed.frontmatter["ss_image_count"]);
  const imageCount = imageCountRaw === null ? 1 : Math.max(1, Math.min(4, Math.floor(imageCountRaw)));

  const inputFromYaml = parsed.frontmatter["ss_replicate_input"];
  const replicateInput: Record<string, unknown> = isRecord(inputFromYaml) ? { ...inputFromYaml } : {};

  // Convenience mappings (optional).
  const width = readNumber(parsed.frontmatter["ss_image_width"]);
  if (width !== null && !("width" in replicateInput)) replicateInput.width = Math.max(1, Math.floor(width));
  const height = readNumber(parsed.frontmatter["ss_image_height"]);
  if (height !== null && !("height" in replicateInput)) replicateInput.height = Math.max(1, Math.floor(height));

  const seed = readNumber(parsed.frontmatter["ss_seed"]);
  if (seed !== null && !("seed" in replicateInput)) replicateInput.seed = Math.floor(seed);
  const steps = readNumber(parsed.frontmatter["ss_steps"]);
  if (steps !== null && !("steps" in replicateInput)) replicateInput.steps = Math.max(1, Math.floor(steps));
  const guidance = readNumber(parsed.frontmatter["ss_guidance"]);
  if (guidance !== null && !("guidance" in replicateInput)) replicateInput.guidance = guidance;

  return {
    ok: true,
    config: {
      kind: "prompt",
      backend: "replicate",
      replicateModelSlug,
      replicateVersionId,
      replicatePromptKey,
      replicateImageKey,
      replicateInput,
      imageCount,
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
  const src = String(markdown ?? "");
  const body = String(nextBody ?? "");

  const yamlText = String(YAML.stringify(nextFrontmatter) || "").trimEnd();
  const fmBlock = yamlText.trim().length ? `---\n${yamlText}\n---\n` : `---\n---\n`;

  const trimmedBody = body.replace(/^\n+/, "");
  const out = `${fmBlock}${trimmedBody}`;
  return out.endsWith("\n") ? out : `${out}\n`;
}
