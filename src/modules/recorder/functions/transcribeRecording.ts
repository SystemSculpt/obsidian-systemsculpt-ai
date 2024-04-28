import { RecorderModule } from '../RecorderModule';

export async function transcribeRecording(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<string> {
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  const formData = new FormData();
  formData.append('file', blob, 'recording.mp3');
  formData.append('model', plugin.settings.whisperModel);

  // Fetch the latest OpenAI API key from the brain settings
  const currentOpenAIApiKey = plugin.plugin.brainModule.settings.openAIApiKey;

  const response = await fetch(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${currentOpenAIApiKey}`,
        // 'Content-Type': 'multipart/form-data' is not needed when using FormData
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text(); // Get full response body as text
    console.error(
      'Failed to transcribe recording:',
      response.statusText,
      errorBody,
      JSON.stringify(
        {
          headers: {
            Authorization: `Bearer ${currentOpenAIApiKey}`,
          },
          model: plugin.settings.whisperModel,
          fileDetails: {
            type: blob.type,
            size: blob.size,
          },
        },
        null,
        2
      ) // Log detailed request info for debugging
    );
    throw new Error('Transcription failed with response: ' + errorBody);
  }

  const data = await response.json();
  return data.text;
}
