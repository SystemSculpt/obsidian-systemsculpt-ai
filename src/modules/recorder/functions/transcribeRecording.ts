import { RecorderModule } from '../RecorderModule';
import { logger } from '../../../utils/logger';

async function transcribeChunk(
  plugin: RecorderModule,
  chunk: Blob
): Promise<string> {
  const formData = new FormData();
  formData.append('file', chunk, 'recording.mp3');
  formData.append('model', plugin.settings.whisperModel);

  const currentOpenAIApiKey = plugin.plugin.brainModule.settings.openAIApiKey;

  logger.log(`Sending chunk to OpenAI API (size: ${chunk.size} bytes)`);
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
    logger.error('Failed to transcribe chunk:', response.statusText, errorBody);
    throw new Error('Transcription failed with response: ' + errorBody);
  }

  const data = await response.json();
  logger.log('Chunk transcription successful');
  return data.text;
}

export async function transcribeRecording(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<string> {
  logger.log(
    `Starting transcription with provider: ${plugin.settings.whisperProvider}`
  );
  if (plugin.settings.whisperProvider === 'groq') {
    return transcribeWithGroq(plugin, arrayBuffer);
  } else {
    return transcribeWithOpenAI(plugin, arrayBuffer);
  }
}

async function transcribeWithOpenAI(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<string> {
  logger.log('Transcribing with OpenAI');
  let CHUNK_SIZE = 23 * 1024 * 1024; // 25MB is max, do in 23MB chunks to be safe
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  const totalSize = blob.size;
  logger.log(`Total audio size: ${totalSize} bytes`);
  const chunks: Blob[] = [];

  for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
    const chunk = blob.slice(start, start + CHUNK_SIZE);
    chunks.push(chunk);
  }
  logger.log(`Number of chunks: ${chunks.length}`);

  let transcriptions: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    logger.log(`Transcribing chunk ${i + 1} of ${chunks.length}`);
    try {
      const transcription = await transcribeChunk(plugin, chunks[i]);
      transcriptions.push(transcription);
    } catch (error) {
      logger.error(`Error transcribing chunk ${i + 1}:`, error);
      // @ts-ignore
      if (error.message.includes('Maximum content size limit')) {
        CHUNK_SIZE = Math.floor(CHUNK_SIZE / 2);
        logger.warn(`Chunk size reduced to ${CHUNK_SIZE} bytes. Retrying...`);
        return await transcribeRecording(plugin, arrayBuffer); // Retry with smaller chunks
      } else {
        throw error;
      }
    }
  }

  logger.log('OpenAI transcription completed');
  return transcriptions.join(' ');
}

async function transcribeWithGroq(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<string> {
  logger.log('Transcribing with Groq');
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  const formData = new FormData();
  formData.append('file', blob, 'recording.mp3');
  formData.append('model', 'whisper-large-v3');

  const currentGroqApiKey = plugin.plugin.brainModule.settings.groqAPIKey;

  logger.log(`Sending audio to Groq API (size: ${blob.size} bytes)`);
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
    logger.error(
      'Failed to transcribe with Groq:',
      response.statusText,
      errorBody
    );
    throw new Error('Transcription failed with response: ' + errorBody);
  }

  const data = await response.json();
  logger.log('Groq transcription completed');
  return data.text;
}
