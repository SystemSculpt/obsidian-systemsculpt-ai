/**
 * Centralized file type metadata shared across the plugin.
 * Keep this list in sync with supported document and audio flows in
 * DocumentProcessingService and related UI entry points.
 */

const DOCUMENT_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
] as const;

const DOCUMENT_MIME_TYPES: Record<DocumentFileExtension, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "webm"] as const;

const toReadonlySet = (values: readonly string[]): ReadonlySet<string> =>
  new Set(values);

export const DOCUMENT_FILE_EXTENSIONS: ReadonlySet<string> = toReadonlySet(
  DOCUMENT_EXTENSIONS
);

export const AUDIO_FILE_EXTENSIONS: ReadonlySet<string> = toReadonlySet(
  AUDIO_EXTENSIONS
);

export const DOCUMENT_MIME_TYPE_MAP: Readonly<Record<DocumentFileExtension, string>> =
  DOCUMENT_MIME_TYPES;

/**
 * Normalize an extension string for consistent membership checks.
 */
export const normalizeFileExtension = (
  extension?: string | null
): string => (extension ?? "").trim().toLowerCase();

export const isDocumentFileExtension = (
  extension?: string | null
): boolean => {
  const normalized = normalizeFileExtension(extension);
  return normalized !== "" && DOCUMENT_FILE_EXTENSIONS.has(normalized);
};

export const isAudioFileExtension = (
  extension?: string | null
): boolean => {
  const normalized = normalizeFileExtension(extension);
  return normalized !== "" && AUDIO_FILE_EXTENSIONS.has(normalized);
};

export const getDocumentMimeType = (
  extension?: string | null
): string | undefined => {
  const normalized = normalizeFileExtension(extension);
  if (normalized === "") {
    return undefined;
  }
  return DOCUMENT_MIME_TYPE_MAP[normalized as DocumentFileExtension];
};

export type DocumentFileExtension = (typeof DOCUMENT_EXTENSIONS)[number];
export type AudioFileExtension = (typeof AUDIO_EXTENSIONS)[number];
