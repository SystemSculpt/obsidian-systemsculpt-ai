export interface SystemSculptRecorderSettings {
  whisperModel: string;
  recordingsPath: string;
  selectedMicrophone: string;
  autoTranscriptionEnabled: boolean;
  saveAudioClips: boolean;
  pasteIntoActiveNote: boolean; // Changed from pasteOnTranscription
  copyToClipboard: boolean; // Added new feature
  saveTranscriptionToFile: boolean;
  transcriptionsPath: string;
}

export const DEFAULT_RECORDER_SETTINGS: SystemSculptRecorderSettings = {
  whisperModel: 'whisper-1',
  recordingsPath: 'SystemSculpt/Recordings',
  selectedMicrophone: 'default',
  autoTranscriptionEnabled: true,
  saveAudioClips: true,
  pasteIntoActiveNote: true, // Changed from pasteOnTranscription
  copyToClipboard: true, // Added new feature
  saveTranscriptionToFile: true,
  transcriptionsPath: 'SystemSculpt/Recordings/Transcriptions',
};
