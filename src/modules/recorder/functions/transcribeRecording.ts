import { RecorderModule } from '../RecorderModule';

async function transcribeChunk(
  plugin: RecorderModule,
  chunk: Blob
): Promise<string> {
  const formData = new FormData();
  formData.append('file', chunk, 'recording.mp3');
  formData.append('model', plugin.settings.whisperModel);
  formData.append('language', plugin.settings.language); // Add language parameter

  if (plugin.settings.enableCustomWhisperPrompt && plugin.settings.customWhisperPrompt) {
    console.log('Adding custom prompt to transcription...');
    formData.append('prompt', plugin.settings.customWhisperPrompt);
  }

  const currentOpenAIApiKey = plugin.plugin.brainModule.settings.openAIApiKey;

  const response = await fetch(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${currentOpenAIApiKey}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error('Transcription failed with response: ' + errorBody);
  }

  const data = await response.json();
  return data.text;
}

export async function transcribeRecording(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  updateProgress: (current: number, total: number) => void
): Promise<string> {
  if (plugin.settings.whisperProvider === 'groq') {
    return transcribeWithGroq(plugin, arrayBuffer, updateProgress);
  } else {
    return transcribeWithOpenAI(plugin, arrayBuffer, updateProgress);
  }
}

async function transcribeWithOpenAI(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  updateProgress: (current: number, total: number) => void
): Promise<string> {
  let CHUNK_SIZE = 23 * 1024 * 1024;
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  const totalSize = blob.size;
  const chunks: Blob[] = [];

  for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
    const chunk = blob.slice(start, start + CHUNK_SIZE);
    chunks.push(chunk);
  }

  let transcriptions: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    updateProgress(i + 1, chunks.length);

    try {
      const transcription = await transcribeChunk(plugin, chunks[i]);
      transcriptions.push(transcription);
    } catch (error) {
      // @ts-ignore
      if (error.message.includes('Maximum content size limit')) {
        CHUNK_SIZE = Math.floor(CHUNK_SIZE / 2);
        return await transcribeRecording(plugin, arrayBuffer, updateProgress);
      } else {
        throw error;
      }
    }
  }

  return transcriptions.join(' ');
}

async function transcribeWithGroq(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  updateProgress: (current: number, total: number) => void
): Promise<string> {
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  const formData = new FormData();
  formData.append('file', blob, 'recording.mp3');
  formData.append('model', 'whisper-large-v3');
  formData.append('language', plugin.settings.language); // Add language parameter

  const currentGroqApiKey = plugin.plugin.brainModule.settings.groqAPIKey;

  const response = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${currentGroqApiKey}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error('Transcription failed with response: ' + errorBody);
  }

  const data = await response.json();
  return data.text;
}
