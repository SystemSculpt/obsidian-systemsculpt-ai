export interface RecorderFormat {
  mimeType: string;
  extension: string;
}

const FALLBACK_FORMAT: RecorderFormat = {
  mimeType: "audio/webm",
  extension: "webm"
};

const PREFERRED_FORMATS: RecorderFormat[] = [
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

export const pickRecorderFormat = (): RecorderFormat => {
  for (const format of PREFERRED_FORMATS) {
    if (isTypeSupported(format.mimeType)) {
      return format;
    }
  }
  return FALLBACK_FORMAT;
};
