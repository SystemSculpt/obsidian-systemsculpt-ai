export interface RecorderFormat {
  mimeType: string;
  extension: string;
}

export interface RecorderFormatSelectionOptions {
  preferM4a?: boolean;
}

const FALLBACK_FORMAT: RecorderFormat = {
  mimeType: "audio/webm",
  extension: "webm"
};

const MOBILE_PREFERRED_FORMATS: RecorderFormat[] = [
  { mimeType: "audio/mp4;codecs=mp4a.40.2", extension: "m4a" },
  { mimeType: "audio/mp4", extension: "m4a" },
];

const STANDARD_PREFERRED_FORMATS: RecorderFormat[] = [
  { mimeType: "audio/webm;codecs=opus", extension: "webm" },
  { mimeType: "audio/webm", extension: "webm" },
  { mimeType: "audio/ogg;codecs=opus", extension: "ogg" },
  { mimeType: "audio/wav", extension: "wav" }
];

const isTypeSupported = (mimeType: string): boolean => {
  try {
    return typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
      ? MediaRecorder.isTypeSupported(mimeType)
      : false;
  } catch {
    return false;
  }
};

export const pickRecorderFormat = (
  options: RecorderFormatSelectionOptions = {}
): RecorderFormat => {
  const preferredFormats = options.preferM4a
    ? [...MOBILE_PREFERRED_FORMATS, ...STANDARD_PREFERRED_FORMATS]
    : STANDARD_PREFERRED_FORMATS;

  for (const format of preferredFormats) {
    if (isTypeSupported(format.mimeType)) {
      return format;
    }
  }
  return FALLBACK_FORMAT;
};
