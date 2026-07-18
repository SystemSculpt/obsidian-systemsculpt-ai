export interface RecorderFormat {
  mimeType: string;
  extension: string;
}

const FALLBACK_FORMAT: RecorderFormat = {
  mimeType: "audio/webm",
  extension: "webm"
};

const STANDARD_PREFERRED_FORMATS: RecorderFormat[] = [
  { mimeType: "audio/webm;codecs=opus", extension: "webm" },
  { mimeType: "audio/webm", extension: "webm" },
  { mimeType: "audio/mp4", extension: "m4a" },
  { mimeType: "audio/ogg;codecs=opus", extension: "ogg" },
  { mimeType: "audio/wav", extension: "wav" },
];

/**
 * Maps the MIME type reported by MediaRecorder to the file extension written
 * to the vault. A recorder may accept one set of constructor options and then
 * select a different native container, especially in mobile WebViews.
 */
export const recorderFormatForMimeType = (
  mimeType: string | null | undefined,
  fallback: RecorderFormat = FALLBACK_FORMAT,
): RecorderFormat => {
  const normalized = mimeType?.trim().toLowerCase() ?? "";
  const container = normalized.split(";", 1)[0]?.trim();

  switch (container) {
    case "audio/webm":
      return { mimeType: normalized || "audio/webm", extension: "webm" };
    case "audio/mp4":
    case "audio/x-m4a":
    case "video/mp4":
      return { mimeType: normalized || "audio/mp4", extension: "m4a" };
    case "audio/ogg":
      return { mimeType: normalized || "audio/ogg", extension: "ogg" };
    case "audio/wav":
    case "audio/x-wav":
      return { mimeType: normalized || "audio/wav", extension: "wav" };
    case "audio/mpeg":
      return { mimeType: normalized || "audio/mpeg", extension: "mp3" };
    default:
      return fallback;
  }
};

const isTypeSupported = (ownerWindow: Window, mimeType: string): boolean => {
  try {
    const RecorderConstructor = (ownerWindow as Window & { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    return RecorderConstructor && typeof RecorderConstructor.isTypeSupported === "function"
      ? RecorderConstructor.isTypeSupported(mimeType)
      : false;
  } catch {
    return false;
  }
};

export const pickRecorderFormat = (
  ownerWindow: Window = window,
): RecorderFormat => {
  for (const format of STANDARD_PREFERRED_FORMATS) {
    if (isTypeSupported(ownerWindow, format.mimeType)) {
      return format;
    }
  }
  return FALLBACK_FORMAT;
};
