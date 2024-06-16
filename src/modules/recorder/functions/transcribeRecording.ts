import { RecorderModule } from '../RecorderModule';

async function transcribeChunk(
  plugin: RecorderModule,
  chunk: Blob
): Promise<string> {
  const formData = new FormData();
  formData.append('file', chunk, 'recording.mp3');
  formData.append('model', plugin.settings.whisperModel);

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
    console.error(
      'Failed to transcribe chunk:',
      response.statusText,
      errorBody
    );
    throw new Error('Transcription failed with response: ' + errorBody);
  }

  const data = await response.json();
  return data.text;
}

export async function transcribeRecording(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<string> {
  let CHUNK_SIZE = 23 * 1024 * 1024; // 25MB is max, do in 23MB chunks to be safe
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  const totalSize = blob.size;
  const chunks: Blob[] = [];

  for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
    const chunk = blob.slice(start, start + CHUNK_SIZE);
    chunks.push(chunk);
  }

  let transcriptions: string[] = [];
  for (const chunk of chunks) {
    try {
      const transcription = await transcribeChunk(plugin, chunk);
      transcriptions.push(transcription);
    } catch (error) {
      if (error.message.includes('Maximum content size limit')) {
        // Reduce chunk size and retry
        CHUNK_SIZE = Math.floor(CHUNK_SIZE / 2);
        console.warn(`Chunk size reduced to ${CHUNK_SIZE} bytes. Retrying...`);
        return await transcribeRecording(plugin, arrayBuffer); // Retry with smaller chunks
      } else {
        throw error;
      }
    }
  }

  return transcriptions.join(' ');
}
