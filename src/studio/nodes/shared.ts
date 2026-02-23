import type { StudioJsonValue, StudioNodeExecutionContext } from "../types";
import { isRecord } from "../utils";

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
    out[key] = getText(value);
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

export function parseStructuredPromptInput(value: StudioJsonValue | undefined): {
  prompt: string;
  systemPrompt: string;
} {
  if (isRecord(value)) {
    const payload = value as Record<string, StudioJsonValue>;
    const prompt =
      getText(payload.userMessage).trim() ||
      getText(payload.user_message).trim() ||
      getText(payload.prompt).trim() ||
      getText(payload.text).trim() ||
      getText(payload.message).trim();
    const systemPrompt =
      getText(payload.systemPrompt).trim() ||
      getText(payload.system_prompt).trim() ||
      getText(payload.system).trim() ||
      getText(payload.instructions).trim();
    return { prompt, systemPrompt };
  }

  const text = getText(value).trim();
  if (!text) {
    return { prompt: "", systemPrompt: "" };
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

  return { prompt: text, systemPrompt: "" };
}
