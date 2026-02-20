export interface VideoRecorderFormat {
  mimeType: string;
  extension: "mp4" | "webm" | "mov";
}

const FALLBACK_FORMAT: VideoRecorderFormat = {
  mimeType: "video/webm",
  extension: "webm",
};

const PREFERRED_FORMATS: VideoRecorderFormat[] = [
  { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
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

export const canRecordVideoInRuntime = (): boolean => {
  return typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getDisplayMedia
    && typeof MediaRecorder !== "undefined";
};

export const pickVideoRecorderFormat = (): VideoRecorderFormat => {
  for (const format of PREFERRED_FORMATS) {
    if (isTypeSupported(format.mimeType)) {
      return format;
    }
  }
  return FALLBACK_FORMAT;
};
