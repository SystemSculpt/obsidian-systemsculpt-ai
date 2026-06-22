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

/**
 * Speech-optimized encoder bitrate (bits/second) for mobile recordings.
 *
 * The recorder exists to feed transcription, so high-fidelity audio is wasted —
 * ASR models downsample to 16 kHz mono anyway. Left unset, MediaRecorder uses a
 * high browser-default bitrate, so a typical meeting balloons past the 25 MB
 * direct-upload limit and is force-chunked. On mobile the chunker relies on
 * `AudioContext.decodeAudioData`, which the Android/iOS webview can't run on
 * webm/opus — that is the failure behind #169 ("can't process meeting
 * recordings"). 48 kbps keeps ~70 min of speech under the limit while staying
 * transparent for voice, so mobile recordings upload directly and skip the
 * broken chunk/decode path entirely.
 */
export const MOBILE_RECORDING_AUDIO_BITS_PER_SECOND = 48_000;

export interface RecorderAudioBitrateOptions {
  isMobile?: boolean;
}

/**
 * The encoder bitrate to request for a recording, or `undefined` to let the
 * platform pick its default. Desktop keeps the default (its chunker can decode
 * locally); mobile gets the speech-optimized cap above.
 */
export const pickRecorderAudioBitsPerSecond = (
  options: RecorderAudioBitrateOptions = {}
): number | undefined =>
  options.isMobile ? MOBILE_RECORDING_AUDIO_BITS_PER_SECOND : undefined;
