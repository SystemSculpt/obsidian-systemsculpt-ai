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
  whisperProvider: 'openai' | 'groq';
  enableCustomWhisperPrompt: boolean;
  customWhisperPrompt: string;
  enablePostProcessingPrompt: boolean;
  postProcessingPrompt: string;
  language: string;
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
  whisperProvider: 'openai',
  enableCustomWhisperPrompt: true,
  customWhisperPrompt: 'SystemSculpt AI, GPT, GPT-4, GPT-4o, GPT-4o-mini, o1-preview, o1-mini, Anthropic, Claude, Claude Sonnet 3.5, Claude Opus, Claude Haiku, LLaMA',
  enablePostProcessingPrompt: false,
  postProcessingPrompt: 'Take the following transcript and summarize it in markdown format, with a main summary, a list of key points, and actionable takeaways.',
  language: 'en',
};
