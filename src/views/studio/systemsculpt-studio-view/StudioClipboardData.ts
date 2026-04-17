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

export function isMediaMimeType(rawMimeType: string): boolean {
  const normalized = String(rawMimeType || "").trim().toLowerCase();
  return MEDIA_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isMediaIngestableExtension(extension: string): boolean {
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

export function extractClipboardText(event: ClipboardEvent): string {
  const clipboard = event.clipboardData;
  if (!clipboard) {
    return "";
  }
  const text = clipboard.getData("text/plain");
  return typeof text === "string" ? text : "";
}
