/**
 * File-type contracts shared by active managed conversion and local context UI.
 */

const MANAGED_DOCUMENT_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp"] as const;
const AUTO_DOCUMENT_EXTENSIONS = ["pdf"] as const;
const UNSUPPORTED_OFFICE_EXTENSIONS = ["doc", "docx", "ppt", "pptx", "xls", "xlsx"] as const;
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "webm"] as const;

const toReadonlySet = (values: readonly string[]): ReadonlySet<string> => new Set(values);

export const MANAGED_DOCUMENT_CONVERSION_EXTENSIONS = toReadonlySet(MANAGED_DOCUMENT_EXTENSIONS);
export const AUDIO_FILE_EXTENSIONS = toReadonlySet(AUDIO_EXTENSIONS);

export type ManagedDocumentFileExtension = (typeof MANAGED_DOCUMENT_EXTENSIONS)[number];
export type AudioFileExtension = (typeof AUDIO_EXTENSIONS)[number];

export const MANAGED_DOCUMENT_MIME_TYPE_MAP: Readonly<Record<ManagedDocumentFileExtension, string>> = Object.freeze({
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

export const normalizeFileExtension = (extension?: string | null): string =>
  (extension ?? "").trim().toLowerCase();

export const isManagedDocumentConversionFileExtension = (extension?: string | null): boolean =>
  MANAGED_DOCUMENT_CONVERSION_EXTENSIONS.has(normalizeFileExtension(extension));

export const isAutoDocumentConversionFileExtension = (extension?: string | null): boolean =>
  AUTO_DOCUMENT_EXTENSIONS.includes(normalizeFileExtension(extension) as (typeof AUTO_DOCUMENT_EXTENSIONS)[number]);

export const isUnsupportedOfficeFileExtension = (extension?: string | null): boolean =>
  UNSUPPORTED_OFFICE_EXTENSIONS.includes(normalizeFileExtension(extension) as (typeof UNSUPPORTED_OFFICE_EXTENSIONS)[number]);

export const isAudioFileExtension = (extension?: string | null): boolean =>
  AUDIO_FILE_EXTENSIONS.has(normalizeFileExtension(extension));

export const getManagedDocumentMimeType = (extension?: string | null): string | undefined => {
  const normalized = normalizeFileExtension(extension) as ManagedDocumentFileExtension;
  return MANAGED_DOCUMENT_MIME_TYPE_MAP[normalized];
};
