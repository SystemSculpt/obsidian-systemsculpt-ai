import type { StudioJsonValue, StudioNodeInstance } from "../../../studio/types";

export function coercePromptBundleText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return "";
  }
}

export function coerceNotePreviewText(value: unknown, pathValue?: StudioJsonValue | undefined): string {
  const readPathAtIndex = (index: number): string => {
    if (typeof pathValue === "string") {
      return pathValue.trim();
    }
    if (Array.isArray(pathValue)) {
      const entry = pathValue[index];
      return typeof entry === "string" ? entry.trim() : "";
    }
    return "";
  };

  const formatNoteBlock = (text: string, index: number): string => {
    const body = text.trim();
    if (!body) {
      return "";
    }
    const path = readPathAtIndex(index);
    if (!path) {
      return body;
    }
    return `Path: ${path}\n${body}`;
  };

  if (typeof value === "string") {
    return formatNoteBlock(value, 0);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry, index) => (typeof entry === "string" ? formatNoteBlock(entry, index) : ""))
      .filter((entry) => entry.length > 0);
    if (parts.length > 0) {
      return parts.join("\n\n---\n\n");
    }
  }
  return "";
}

export function readFirstTextValue(value: StudioJsonValue | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return "";
}

export function isTextGenerationOutputLocked(node: StudioNodeInstance | null): boolean {
  if (!node || node.kind !== "studio.text_generation") {
    return false;
  }
  return node.config.lockOutput === true;
}

export function resolveTextGenerationOutputSnapshot(options: {
  node: StudioNodeInstance;
  runtimeText: string;
}): string {
  const { node, runtimeText } = options;
  if (node.kind !== "studio.text_generation") {
    return "";
  }
  const configuredValueRaw =
    typeof node.config.value === "string"
      ? node.config.value
      : typeof node.config.value === "number" || typeof node.config.value === "boolean"
        ? String(node.config.value)
        : "";
  if (configuredValueRaw.trim().length > 0) {
    return configuredValueRaw;
  }
  return runtimeText;
}

export function wrapPromptBundleFence(language: string, content: string): string {
  const normalized = String(content || "");
  const fence = normalized.includes("```") ? "~~~~" : "```";
  const info = String(language || "").trim();
  return `${fence}${info}\n${normalized}\n${fence}`;
}
