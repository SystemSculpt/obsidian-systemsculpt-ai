import type { StudioJsonValue, StudioNodeExecutionContext } from "../types";
import { isRecord } from "../utils";

export type StudioImageInputCandidate = {
  path: string;
  mimeType?: string;
  hash?: string;
  sizeBytes?: number;
};

export function getText(value: StudioJsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function inferMimeTypeFromPath(path: string): string {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  return "application/octet-stream";
}

export function isLikelyAbsolutePath(path: string): boolean {
  const value = String(path || "").trim();
  if (!value) {
    return false;
  }
  if (value.startsWith("/")) {
    return true;
  }
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function resolveTemplateVariables(context: StudioNodeExecutionContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.inputs)) {
    const promptText = readPromptTextFromInput(value);
    out[key] = promptText || getText(value);
  }

  const raw = context.node.config.variables;
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      out[key] = getText(value as StudioJsonValue);
    }
  }
  return out;
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key];
    }
    return "";
  });
}

function asImageInputCandidate(value: Record<string, StudioJsonValue>): StudioImageInputCandidate | null {
  const path = getText(value.path).trim();
  if (!path) {
    return null;
  }
  const mimeType =
    getText(value.mimeType).trim() ||
    getText(value.mime_type).trim() ||
    undefined;
  const hash =
    getText(value.hash).trim() ||
    getText(value.sha256).trim() ||
    undefined;
  const sizeRaw = Number(value.sizeBytes ?? value.size_bytes);
  const sizeBytes = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : undefined;
  return {
    path,
    mimeType,
    hash,
    sizeBytes,
  };
}

function collectPromptTextFragments(value: StudioJsonValue | undefined, out: string[]): void {
  if (value == null) {
    return;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text) {
      out.push(text);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPromptTextFragments(entry as StudioJsonValue, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const payload = value as Record<string, StudioJsonValue>;
  const textCandidateKeys = [
    "userMessage",
    "user_message",
    "prompt",
    "text",
    "message",
  ];
  const baseLength = out.length;
  for (const key of textCandidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      continue;
    }
    collectPromptTextFragments(payload[key], out);
  }
  if (out.length > baseLength) {
    return;
  }

  const serialized = getText(payload).trim();
  if (serialized) {
    out.push(serialized);
  }
}

export function readPromptTextFromInput(value: StudioJsonValue | undefined): string {
  const fragments: string[] = [];
  collectPromptTextFragments(value, fragments);
  return fragments.join("\n\n").trim();
}

function collectImageInputCandidates(value: StudioJsonValue | undefined, out: StudioImageInputCandidate[]): void {
  if (value == null) {
    return;
  }
  if (typeof value === "string") {
    const path = value.trim();
    if (path) {
      out.push({ path });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectImageInputCandidates(entry as StudioJsonValue, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const payload = value as Record<string, StudioJsonValue>;
  const direct = asImageInputCandidate(payload);
  if (direct) {
    out.push(direct);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "input_images")) {
    collectImageInputCandidates(payload.input_images, out);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "images")) {
    collectImageInputCandidates(payload.images, out);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "image")) {
    collectImageInputCandidates(payload.image, out);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "media")) {
    collectImageInputCandidates(payload.media, out);
  }
}

export function extractImageInputCandidates(value: StudioJsonValue | undefined): StudioImageInputCandidate[] {
  const collected: StudioImageInputCandidate[] = [];
  collectImageInputCandidates(value, collected);
  const deduped: StudioImageInputCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of collected) {
    const key = `${candidate.path}::${candidate.hash || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

export function parseStructuredPromptInput(value: StudioJsonValue | undefined): {
  prompt: string;
  systemPrompt: string;
  inputImages: StudioImageInputCandidate[];
} {
  if (isRecord(value)) {
    const payload = value as Record<string, StudioJsonValue>;
    const prompt = readPromptTextFromInput({
      userMessage: payload.userMessage,
      user_message: payload.user_message,
      prompt: payload.prompt,
      text: payload.text,
      message: payload.message,
    } as StudioJsonValue);
    const systemPrompt =
      getText(payload.systemPrompt).trim() ||
      getText(payload.system_prompt).trim() ||
      getText(payload.system).trim() ||
      getText(payload.instructions).trim();
    const inputImages = extractImageInputCandidates(payload.input_images ?? payload.images);
    return { prompt, systemPrompt, inputImages };
  }

  const text = readPromptTextFromInput(value);
  if (!text) {
    return { prompt: "", systemPrompt: "", inputImages: [] };
  }

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) {
        return parseStructuredPromptInput(parsed as StudioJsonValue);
      }
    } catch {
      // Treat non-JSON prompt text as a direct user prompt.
    }
  }

  return { prompt: text, systemPrompt: "", inputImages: [] };
}
