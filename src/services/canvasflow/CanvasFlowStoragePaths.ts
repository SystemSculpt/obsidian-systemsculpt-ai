import { normalizePath } from "obsidian";
import { sanitizeChatTitle } from "../../utils/titleUtils";

export const DEFAULT_CANVASFLOW_OUTPUT_DIR = "SystemSculpt/Attachments/Generations" as const;

function isUnsafePathSegment(segment: string): boolean {
  const part = String(segment || "").trim();
  return !part || part === "." || part === ".." || part.includes("\u0000");
}

export function resolveCanvasFlowOutputDirectory(configured: string | null | undefined): string {
  const fallback = normalizePath(DEFAULT_CANVASFLOW_OUTPUT_DIR);
  const raw = normalizePath(String(configured || "").trim() || "");
  const stripped = String(raw || "").replace(/^\/+|\/+$/g, "");
  if (!stripped) return fallback;

  const segments = stripped.split("/").filter(Boolean);
  if (segments.length === 0) return fallback;
  if (segments.some((segment) => isUnsafePathSegment(segment))) return fallback;

  const candidate = normalizePath(segments.join("/"));
  if (candidate === fallback || candidate.startsWith(`${fallback}/`)) {
    return candidate;
  }

  // Security boundary: force all generations under the plugin-owned root.
  return normalizePath(`${fallback}/${candidate}`);
}

export function resolveCanvasFlowSafeFileStem(baseName: string): string {
  const raw = sanitizeChatTitle(String(baseName || ""))
    .replace(/[\\/]+/g, "-")
    .trim();
  const sanitized = raw.replace(/^\.+/, "").replace(/\.+$/, "").trim();
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "generation";
  }
  return sanitized;
}
