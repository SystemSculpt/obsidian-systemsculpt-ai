import type { StudioNodeInstance } from "../../../studio/types";

export type StudioNodeMediaPreview = {
  kind: "image" | "video";
  path: string;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg"]);

function isAbsoluteFilesystemPath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}

function extractPathExtension(path: string): string {
  const normalized = String(path || "").trim();
  if (!normalized) {
    return "";
  }
  const withoutQuery = normalized.split(/[?#]/, 1)[0];
  const dot = withoutQuery.lastIndexOf(".");
  if (dot < 0) {
    return "";
  }
  return withoutQuery.slice(dot + 1).trim().toLowerCase();
}

function inferMediaKind(value: { mimeType?: unknown; path?: unknown }): "image" | "video" | null {
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.trim().toLowerCase() : "";
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }

  const path = typeof value.path === "string" ? value.path.trim() : "";
  const extension = extractPathExtension(path);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return null;
}

function extractMediaPreviewFromAssetValue(value: unknown): StudioNodeMediaPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!path) {
    return null;
  }
  const kind = inferMediaKind(candidate);
  if (!kind) {
    return null;
  }
  return { kind, path };
}

export function resolveNodeMediaPreview(
  node: StudioNodeInstance,
  outputs: Record<string, unknown> | null
): StudioNodeMediaPreview | null {
  if (node.kind === "studio.image_generation") {
    return null;
  }

  if (node.kind === "studio.media_ingest") {
    const config = (node.config || {}) as Record<string, unknown>;
    const previewPath = typeof outputs?.preview_path === "string" ? outputs.preview_path.trim() : "";
    const configuredPath = typeof config.sourcePath === "string" ? config.sourcePath.trim() : "";
    const outputPath = typeof outputs?.path === "string" ? outputs.path.trim() : "";
    const mediaKindPath = outputPath || configuredPath || previewPath;
    const renderPath = previewPath || outputPath || configuredPath;
    if (!mediaKindPath || !renderPath) {
      return null;
    }
    if (!previewPath && isAbsoluteFilesystemPath(mediaKindPath)) {
      return null;
    }
    const kind = inferMediaKind({ path: mediaKindPath });
    if (!kind) {
      return null;
    }
    return { kind, path: renderPath };
  }

  const pathOutput = typeof outputs?.path === "string" ? outputs.path.trim() : "";
  if (pathOutput) {
    const kind = inferMediaKind({ path: pathOutput });
    if (kind) {
      return { kind, path: pathOutput };
    }
  }

  const images = Array.isArray(outputs?.images) ? outputs.images : [];
  for (const image of images) {
    const preview = extractMediaPreviewFromAssetValue(image);
    if (preview?.kind === "image") {
      return preview;
    }
  }

  return null;
}
