import type { StudioJsonValue, StudioNodeDefinition, StudioNodeExecutionContext } from "../types";
import { getText } from "./shared";
import { extname, isAbsolute } from "node:path";

const MANAGED_MEDIA_OWNER_KEY = "__studio_managed_by";
const MANAGED_MEDIA_OWNER = "studio.image_generation_output.v1";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pathFromAssetLike(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  return typeof record.path === "string" ? record.path.trim() : "";
}

function resolvePathFromMediaInput(context: StudioNodeExecutionContext): string {
  const mediaInput = context.inputs.media;
  const sourceIndexRaw = Number(
    context.node.config.__studio_source_output_index as StudioJsonValue
  );
  const sourceIndex = Number.isInteger(sourceIndexRaw) && sourceIndexRaw >= 0 ? sourceIndexRaw : 0;

  if (Array.isArray(mediaInput)) {
    const indexed = pathFromAssetLike(mediaInput[sourceIndex]);
    if (indexed) {
      return indexed;
    }
    for (const entry of mediaInput) {
      const candidate = pathFromAssetLike(entry);
      if (candidate) {
        return candidate;
      }
    }
  }

  const directPath = pathFromAssetLike(mediaInput);
  if (directPath) {
    return directPath;
  }

  return getText(mediaInput).trim();
}

function isPinnedGeneratedMediaNode(context: StudioNodeExecutionContext): boolean {
  const owner = getText(context.node.config[MANAGED_MEDIA_OWNER_KEY] as StudioJsonValue).trim();
  return owner === MANAGED_MEDIA_OWNER;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpeg", ".mpg"]);

function inferPreviewMimeType(path: string): string {
  const extension = extname(String(path || "").trim()).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    if (extension === ".jpg") {
      return "image/jpeg";
    }
    return `image/${extension.slice(1)}`;
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    if (extension === ".mpg") {
      return "video/mpeg";
    }
    return `video/${extension.slice(1)}`;
  }
  return "";
}

async function buildPreviewAssetPath(
  context: StudioNodeExecutionContext,
  sourcePath: string
): Promise<{ previewPath: string; previewError: string }> {
  if (!isAbsolute(sourcePath)) {
    return { previewPath: "", previewError: "" };
  }

  const mimeType = inferPreviewMimeType(sourcePath);
  if (!mimeType) {
    return { previewPath: "", previewError: "" };
  }

  try {
    const bytes = await context.services.readLocalFileBinary(sourcePath);
    const stored = await context.services.storeAsset(bytes, mimeType);
    const previewPath = String(stored.path || "").trim();
    if (!previewPath) {
      throw new Error(
        `Media ingest preview staging produced an empty asset path for "${sourcePath}".`
      );
    }
    return { previewPath, previewError: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log(
      `[studio.media_ingest] Preview staging skipped for "${sourcePath}": ${message.slice(0, 320)}`
    );
    return {
      previewPath: "",
      previewError: message,
    };
  }
}

export const mediaIngestNode: StudioNodeDefinition = {
  kind: "studio.media_ingest",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "media", type: "any", required: false }],
  outputPorts: [{ id: "path", type: "text" }],
  configDefaults: {
    sourcePath: "",
  },
  configSchema: {
    fields: [
      {
        key: "sourcePath",
        label: "Source Path",
        type: "media_path",
        required: true,
        allowOutsideVault: true,
        mediaKinds: ["image", "video", "audio"],
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const pathFromInput = resolvePathFromMediaInput(context);
    const configuredPath =
      getText(context.node.config.sourcePath as StudioJsonValue).trim() ||
      getText(context.node.config.vaultPath as StudioJsonValue).trim();
    const sourcePath = isPinnedGeneratedMediaNode(context)
      ? configuredPath || pathFromInput
      : pathFromInput || configuredPath;
    if (!sourcePath) {
      throw new Error(
        `Media ingest node "${context.node.id}" requires a media input or config.sourcePath.`
      );
    }
    context.services.assertFilesystemPath(sourcePath);
    const { previewPath, previewError } = await buildPreviewAssetPath(context, sourcePath);

    return {
      outputs: {
        path: sourcePath,
        preview_path: previewPath as StudioJsonValue,
        preview_error: previewError as StudioJsonValue,
      },
    };
  },
};
