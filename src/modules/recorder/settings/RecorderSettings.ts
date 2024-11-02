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
  whisperProvider: "openai" | "groq" | "local";
  localWhisperEndpoint: string;
  enableCustomWhisperPrompt: boolean;
  customWhisperPrompt: string;
  enablePostProcessingPrompt: boolean;
  postProcessingPrompt: string;
  language: string;
  includeLinkToRecording: boolean;
}

export const DEFAULT_RECORDER_SETTINGS: SystemSculptRecorderSettings = {
  whisperModel: "whisper-1",
  recordingsPath: "SystemSculpt/Recordings",
  selectedMicrophone: "default",
  autoTranscriptionEnabled: true,
  saveAudioClips: true,
  pasteIntoActiveNote: true,
  copyToClipboard: true,
  saveTranscriptionToFile: true,
  transcriptionsPath: "SystemSculpt/Transcriptions",
  showRecorderButtonOnStatusBar: true,
  whisperProvider: "openai",
  localWhisperEndpoint: "http://127.0.0.1:8000",
  enableCustomWhisperPrompt: true,
  customWhisperPrompt:
    "SystemSculpt AI, GPT, GPT-4, GPT-4o, GPT-4o-mini, o1-preview, o1-mini, Anthropic, Claude, Claude Sonnet 3.5, Claude Opus, Claude Haiku, LLaMA, GPT-3.5-Turbo, GPT-4-Turbo, PaLM, Gemini, DALL-E, Midjourney, Stable Diffusion, Mixtral, Mistral, CodeLlama, Alpaca, Vicuna, DeepMind, OpenAI, Hugging Face, Meta AI, Microsoft Copilot, Google Bard, Perplexity, Cohere, Large Language Model, LLM, Neural Network, Machine Learning, ML, NLP, AGI, RAG, API, JSON, YAML, GraphQL, PyTorch, TensorFlow, AI/ML, DL, RL, CV, OCR, GPU, TPU",
  enablePostProcessingPrompt: false,
  postProcessingPrompt:
    "Take the following transcript and summarize it in markdown format, with a main summary, a list of key points, and actionable takeaways.",
  language: "en",
  includeLinkToRecording: true,
};
