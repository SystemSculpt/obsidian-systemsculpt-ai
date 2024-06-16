export interface SystemSculptRecorderSettings {
  whisperModel: string;
  recordingsPath: string;
  selectedMicrophone: string;
  autoTranscriptionEnabled: boolean;
  saveAudioClips: boolean;
  pasteIntoActiveNote: boolean;
  copyToClipboard: boolean;
  saveTranscriptionToFile: boolean;
  transcriptionsPath: string;
  showRecorderButtonOnStatusBar: boolean;
}

export const DEFAULT_RECORDER_SETTINGS: SystemSculptRecorderSettings = {
  whisperModel: 'whisper-1',
  recordingsPath: 'SystemSculpt/Recordings',
  selectedMicrophone: 'default',
  autoTranscriptionEnabled: true,
  saveAudioClips: true,
  pasteIntoActiveNote: true,
  copyToClipboard: true,
  saveTranscriptionToFile: true,
  transcriptionsPath: 'SystemSculpt/Transcriptions',
  showRecorderButtonOnStatusBar: true,
};
