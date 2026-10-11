import { TFile, TFolder, type TAbstractFile } from "obsidian";
import { yieldToEventLoop } from "../../../utils/yieldToEventLoop";
import {
  parsePathReferencesFromText,
  resolveVaultItemFromReference,
} from "./StudioVaultReferenceResolver";

const MEDIA_MIME_PREFIXES = ["image/", "video/", "audio/"] as const;

const IMAGE_EXTENSIONS_FOR_INGEST = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tiff",
  "avif",
  "svg",
]);
const VIDEO_EXTENSIONS_FOR_INGEST = new Set([
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "mpeg",
  "mpg",
]);
const AUDIO_EXTENSIONS_FOR_INGEST = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "flac",
  "opus",
  "weba",
]);

function isMediaMimeType(rawMimeType: string): boolean {
  const normalized = String(rawMimeType || "").trim().toLowerCase();
  return MEDIA_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isMediaIngestableExtension(extension: string): boolean {
  const normalized = String(extension || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  return (
    IMAGE_EXTENSIONS_FOR_INGEST.has(normalized) ||
    VIDEO_EXTENSIONS_FOR_INGEST.has(normalized) ||
    AUDIO_EXTENSIONS_FOR_INGEST.has(normalized)
  );
}

export function normalizePastedMediaMimeType(rawMimeType: string): string {
  const normalized = String(rawMimeType || "").trim().toLowerCase();
  if (isMediaMimeType(normalized)) {
    return normalized;
  }
  return "image/png";
}

export function extractClipboardMediaFiles(event: ClipboardEvent): File[] {
  const clipboard = event.clipboardData;
  if (!clipboard) {
    return [];
  }

  const files: File[] = [];
  const seenKeys = new Set<string>();
  if (clipboard.items && clipboard.items.length > 0) {
    for (const item of Array.from(clipboard.items)) {
      if (!item || item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (!file || !isMediaMimeType(file.type)) {
        continue;
      }
      const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      files.push(file);
    }
  }

  if (files.length > 0) {
    return files;
  }

  if (clipboard.files && clipboard.files.length > 0) {
    for (const file of Array.from(clipboard.files)) {
      if (!file || !isMediaMimeType(file.type)) {
        continue;
      }
      const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      files.push(file);
    }
  }

  return files;
}

/** How far a channel may move through the clipboard: rounding, never an edit. */
const PICTURE_TOLERANCE = 4;
/** Pixels read back at a time: a large picture is never held twice over, nor compared in one go. */
const PICTURE_BAND_PIXELS = 1 << 20;

/**
 * Whether two rows of RGBA pixels show the same thing. Colour is weighed by
 * its alpha: what lies under near-zero alpha does not survive a round trip.
 */
export function isSameClipboardPixels(first: ArrayLike<number>, second: ArrayLike<number>): boolean {
  if (first.length !== second.length) {
    return false;
  }
  const colourTolerance = PICTURE_TOLERANCE * 255;
  for (let offset = 0; offset < first.length; offset += 4) {
    const firstAlpha = first[offset + 3];
    const secondAlpha = second[offset + 3];
    if (Math.abs(firstAlpha - secondAlpha) > PICTURE_TOLERANCE) {
      return false;
    }
    for (let channel = offset; channel < offset + 3; channel += 1) {
      if (Math.abs(first[channel] * firstAlpha - second[channel] * secondAlpha) > colourTolerance) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Whether two pictures are the same size and alike in every pixel. The system
 * clipboard re-encodes whatever is written to it, so bytes cannot tell whether
 * a pasted picture is one this view copied; its pixels can. All of them are
 * compared: a picture touched up elsewhere is another picture, however small
 * the change.
 */
export async function isSameClipboardImage(first: Blob, second: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== "function") {
    return false;
  }
  const decoded = await Promise.allSettled([createImageBitmap(first), createImageBitmap(second)]);
  const bitmaps = decoded.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  try {
    if (bitmaps.length !== 2) {
      return false;
    }
    const [ours, theirs] = bitmaps;
    const { width, height } = ours;
    if (width < 1 || height < 1 || theirs.width !== width || theirs.height !== height) {
      return false;
    }
    const band = Math.min(height, Math.max(1, Math.floor(PICTURE_BAND_PIXELS / width)));
    const canvas = createEl("canvas");
    canvas.width = width;
    canvas.height = band;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return false;
    }
    context.globalCompositeOperation = "copy";
    for (let top = 0; top < height; top += band) {
      if (top > 0) {
        // A large picture is many bands; the canvas stays responsive between them.
        await yieldToEventLoop();
      }
      const rows = Math.min(band, height - top);
      const read = (bitmap: ImageBitmap): Uint8ClampedArray => {
        context.drawImage(bitmap, 0, top, width, rows, 0, 0, width, rows);
        return context.getImageData(0, 0, width, rows).data;
      };
      if (!isSameClipboardPixels(read(ours), read(theirs))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    for (const bitmap of bitmaps) {
      bitmap.close();
    }
  }
}

export function extractClipboardText(event: ClipboardEvent): string {
  const clipboard = event.clipboardData;
  if (!clipboard) {
    return "";
  }
  const text = clipboard.getData("text/plain");
  return typeof text === "string" ? text : "";
}

export type StudioDroppedItems = {
  notePaths: string[];
  folderPaths: string[];
  unsupportedPaths: string[];
  vaultMediaPaths: string[];
  externalMediaFiles: File[];
};

export type StudioDropDataResolver = {
  getAbstractFileByPath(path: string): TAbstractFile | null;
  resolveVaultPathFromAbsoluteFilePath(absolutePath: string): string | null;
};

function readDataTransferStringItem(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => {
    try {
      item.getAsString((value) => {
        resolve(typeof value === "string" ? value : "");
      });
    } catch {
      resolve("");
    }
  });
}

/**
 * Classifies every browser and Obsidian drag payload without mutating Studio.
 * The controller decides how each bucket should materialize in the graph.
 */
export async function collectStudioDroppedItems(
  dataTransfer: DataTransfer,
  resolver: StudioDropDataResolver,
): Promise<StudioDroppedItems> {
  const references = new Set<string>();
  const pushReference = (value: string): void => {
    const next = String(value || "").trim();
    if (next) references.add(next);
  };

  const payloads = new Set<string>();
  const pushPayload = (value: string): void => {
    const next = String(value || "").trim();
    if (next) payloads.add(next);
  };

  const vaultMediaPaths = new Set<string>();
  const externalMediaFiles: File[] = [];
  const externalMediaSeenKeys = new Set<string>();
  const pushExternalMediaFile = (file: File): void => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (externalMediaSeenKeys.has(key)) return;
    externalMediaSeenKeys.add(key);
    externalMediaFiles.push(file);
  };

  for (const preferredType of ["text/plain", "text/uri-list", "application/json"]) {
    try {
      pushPayload(dataTransfer.getData(preferredType));
    } catch {
      // Continue through best-effort fallbacks.
    }
  }
  for (const type of Array.from(dataTransfer.types || [])) {
    const normalizedType = String(type || "").toLowerCase();
    if (
      !normalizedType.startsWith("text/") &&
      !normalizedType.includes("json") &&
      !normalizedType.includes("uri")
    ) {
      continue;
    }
    try {
      pushPayload(dataTransfer.getData(type));
    } catch {
      // Continue through best-effort fallbacks.
    }
  }
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind === "string") {
      pushPayload(await readDataTransferStringItem(item));
    }
  }
  for (const payload of payloads) {
    for (const reference of parsePathReferencesFromText(payload)) {
      pushReference(reference);
    }
  }

  for (const file of Array.from(dataTransfer.files || [])) {
    const absolutePath =
      typeof (file as unknown as { path?: unknown }).path === "string"
        ? String((file as unknown as { path?: string }).path)
        : "";
    if (isMediaMimeType(file.type)) {
      const vaultPath = absolutePath
        ? resolver.resolveVaultPathFromAbsoluteFilePath(absolutePath)
        : "";
      if (vaultPath) {
        vaultMediaPaths.add(vaultPath);
      } else {
        pushExternalMediaFile(file);
      }
      continue;
    }
    if (!absolutePath) continue;
    const vaultPath = resolver.resolveVaultPathFromAbsoluteFilePath(absolutePath);
    if (vaultPath) pushReference(vaultPath);
  }

  const notePaths = new Set<string>();
  const folderPaths = new Set<string>();
  const unsupportedPaths = new Set<string>();
  for (const reference of references) {
    const item = resolveVaultItemFromReference({
      reference,
      getAbstractFileByPath: (path) => resolver.getAbstractFileByPath(path),
      resolveVaultPathFromAbsoluteFilePath: (absolutePath) =>
        resolver.resolveVaultPathFromAbsoluteFilePath(absolutePath),
    });
    if (item instanceof TFile && item.extension.toLowerCase() === "md") {
      notePaths.add(item.path);
      continue;
    }
    if (item instanceof TFolder) {
      folderPaths.add(item.path);
      continue;
    }
    if (item instanceof TFile) {
      if (isMediaIngestableExtension(item.extension)) {
        vaultMediaPaths.add(item.path);
      } else {
        unsupportedPaths.add(item.path);
      }
    }
  }

  return {
    notePaths: Array.from(notePaths),
    folderPaths: Array.from(folderPaths),
    unsupportedPaths: Array.from(unsupportedPaths),
    vaultMediaPaths: Array.from(vaultMediaPaths),
    externalMediaFiles,
  };
}
