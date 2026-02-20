export interface VideoAudioCaptureConfig {
  includeSystemAudio: boolean;
  includeMicrophoneAudio: boolean;
  preferredMicrophoneId: string;
}

export const DEFAULT_VIDEO_AUDIO_CAPTURE_CONFIG: VideoAudioCaptureConfig = {
  includeSystemAudio: false,
  includeMicrophoneAudio: false,
  preferredMicrophoneId: "default",
};

export const normalizeVideoAudioCaptureConfig = (
  config: Partial<VideoAudioCaptureConfig> | null | undefined
): VideoAudioCaptureConfig => {
  return {
    includeSystemAudio: !!config?.includeSystemAudio,
    includeMicrophoneAudio: !!config?.includeMicrophoneAudio,
    preferredMicrophoneId: config?.preferredMicrophoneId?.trim()
      ? config.preferredMicrophoneId.trim()
      : DEFAULT_VIDEO_AUDIO_CAPTURE_CONFIG.preferredMicrophoneId,
  };
};
