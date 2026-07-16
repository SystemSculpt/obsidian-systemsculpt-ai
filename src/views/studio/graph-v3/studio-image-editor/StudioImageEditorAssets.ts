import { desktopHost } from "../../../../platform/desktopOnly";
import {
  boardStateHasRenderableEdits,
  type StudioCaptionBoardState,
} from "../../../../studio/StudioCaptionBoardState";
import { renderStudioCaptionBoardImageFromBytes } from "../../../../studio/StudioCaptionBoardComposition";
import { inferMimeTypeFromPath, isLikelyAbsolutePath } from "../../../../studio/nodes/shared";
import type { StudioAssetRef } from "../../../../studio/types";
import type { StudioImageEditorModalOptions } from "./StudioImageEditorTypes";

export type StudioImageEditorSource = {
  asset: StudioAssetRef | null;
  bytes: ArrayBuffer | null;
  path: string;
  src: string;
  width: number;
  height: number;
  statusMessage: string;
};

export async function loadStudioImageEditorSource(
  options: Pick<
    StudioImageEditorModalOptions,
    "app" | "node" | "nodeRunState" | "resolveAssetPreviewSrc" | "readAsset" | "storeAsset"
  >,
  ownerWindow: Window
): Promise<StudioImageEditorSource> {
  const outputs = asRecord(options.nodeRunState.outputs);
  const sourceAsset = normalizeAssetRef(outputs?.source_preview_asset);
  const sourcePath = readString(outputs?.source_preview_path).trim() ||
    readString(options.node.config.sourcePath).trim();
  const path = sourceAsset?.path || sourcePath;
  const mimeType = sourceAsset?.mimeType || inferMimeTypeFromPath(path);
  let asset = sourceAsset;
  let bytes: ArrayBuffer | null = null;
  let statusMessage = "";
  let src = (path && options.resolveAssetPreviewSrc?.(path)) ||
    (isLikelyAbsolutePath(path) ? buildFilePreviewSrc(path) : "");

  if (asset) {
    try {
      bytes = await options.readAsset(asset);
    } catch (error) {
      statusMessage = `Unable to load source image: ${errorMessage(error)}`;
    }
  } else if (path && mimeType.startsWith("image/")) {
    try {
      const loaded = isLikelyAbsolutePath(path)
        ? await desktopHost.fs().readFile(path)
        : await readVaultBinary(options.app, path);
      bytes = normalizeBinary(loaded);
      asset = await options.storeAsset(bytes, mimeType);
      src ||= options.resolveAssetPreviewSrc?.(asset.path) ||
        (isLikelyAbsolutePath(path) ? buildFilePreviewSrc(path) : "");
    } catch (error) {
      statusMessage = `Unable to load source image: ${errorMessage(error)}`;
    }
  }

  if (!src) {
    return { asset, bytes, path, src, width: 0, height: 0, statusMessage };
  }
  try {
    const dimensions = await measureImage(ownerWindow, src);
    return { asset, bytes, path, src, ...dimensions, statusMessage: "" };
  } catch (error) {
    return {
      asset,
      bytes,
      path,
      src,
      width: 0,
      height: 0,
      statusMessage: `Unable to render image preview: ${errorMessage(error)}`,
    };
  }
}

export async function renderStudioImageEditorPreview(
  source: StudioImageEditorSource,
  boardState: StudioCaptionBoardState
): Promise<string> {
  if (!source.bytes || !source.asset || !source.src || !boardStateHasRenderableEdits(boardState)) {
    return "";
  }
  const rendered = await renderStudioCaptionBoardImageFromBytes({
    baseBytes: source.bytes,
    baseMimeType: source.asset.mimeType,
    boardState,
    mode: "editor",
  });
  return rendered.dataUrl;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function normalizeAssetRef(value: unknown): StudioAssetRef | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const hash = readString(record.hash).trim();
  const path = readString(record.path).trim();
  const mimeType = readString(record.mimeType || record.mime_type).trim();
  const size = Number(record.sizeBytes ?? record.size_bytes);
  if (!hash || !path || !mimeType || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  return { hash, path, mimeType, sizeBytes: Math.floor(size) };
}

function normalizeBinary(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  return bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer;
}

function buildFilePreviewSrc(path: string): string {
  return encodeURI(`file://${path}`);
}

async function readVaultBinary(
  app: StudioImageEditorModalOptions["app"],
  path: string
): Promise<ArrayBuffer> {
  const adapter = app.vault.adapter as { readBinary?: (path: string) => Promise<ArrayBuffer> };
  if (typeof adapter.readBinary !== "function") {
    throw new Error("Binary vault reads are unavailable on this adapter.");
  }
  return adapter.readBinary(path);
}

function measureImage(ownerWindow: Window, src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const ImageCtor = (ownerWindow as Window & { Image: new () => HTMLImageElement }).Image;
    const image = new ImageCtor();
    image.onload = () => resolve({
      width: image.naturalWidth || 1600,
      height: image.naturalHeight || 900,
    });
    image.onerror = () => reject(new Error("Preview image failed to load."));
    image.src = src;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
