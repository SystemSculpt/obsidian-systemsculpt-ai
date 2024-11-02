import { RecorderModule } from "../RecorderModule";

async function transcribeChunk(
  plugin: RecorderModule,
  chunk: Blob
): Promise<string> {
  const formData = new FormData();
  formData.append("file", chunk, "recording.mp3");
  formData.append("model", plugin.settings.whisperModel);
  formData.append("language", plugin.settings.language); // Add language parameter

  if (
    plugin.settings.enableCustomWhisperPrompt &&
    plugin.settings.customWhisperPrompt
  ) {
    console.log("Adding custom prompt to transcription...");
    formData.append("prompt", plugin.settings.customWhisperPrompt);
  }

  const currentOpenAIApiKey = plugin.plugin.brainModule.settings.openAIApiKey;

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentOpenAIApiKey}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error("Transcription failed with response: " + errorBody);
  }

  const data = await response.json();
  return data.text;
}

export async function transcribeRecording(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  updateProgress: (current: number, total: number) => void
): Promise<string> {
  switch (plugin.settings.whisperProvider) {
    case "groq":
      return transcribeWithGroq(plugin, arrayBuffer, updateProgress);
    case "local":
      return transcribeWithLocal(plugin, arrayBuffer, updateProgress);
    default:
      return transcribeWithOpenAI(plugin, arrayBuffer, updateProgress);
  }
}

async function transcribeWithOpenAI(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  updateProgress: (current: number, total: number) => void
): Promise<string> {
  let CHUNK_SIZE = 23 * 1024 * 1024;
  const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
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
      if (error.message.includes("Maximum content size limit")) {
        CHUNK_SIZE = Math.floor(CHUNK_SIZE / 2);
        return await transcribeRecording(plugin, arrayBuffer, updateProgress);
      } else {
        throw error;
      }
    }
  }

  return transcriptions.join(" ");
}

async function transcribeWithGroq(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  updateProgress: (current: number, total: number) => void
): Promise<string> {
  const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
  const formData = new FormData();
  formData.append("file", blob, "recording.mp3");
  formData.append("model", "whisper-large-v3");
  formData.append("language", plugin.settings.language); // Add language parameter

  const currentGroqApiKey = plugin.plugin.brainModule.settings.groqAPIKey;

  const response = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentGroqApiKey}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error("Transcription failed with response: " + errorBody);
  }

  const data = await response.json();
  return data.text;
}

async function transcribeWithLocal(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer,
  updateProgress: (current: number, total: number) => void
): Promise<string> {
  try {
    updateProgress(0, 1);
    const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
    const formData = new FormData();
    formData.append("file", blob, "recording.mp3");
    formData.append("model", "mlx-community/whisper-large-v3-turbo");
    formData.append("language", plugin.settings.language);

    if (
      plugin.settings.enableCustomWhisperPrompt &&
      plugin.settings.customWhisperPrompt
    ) {
      formData.append("prompt", plugin.settings.customWhisperPrompt);
    }

    let endpoint = plugin.settings.localWhisperEndpoint;
    if (!endpoint.startsWith("http")) {
      endpoint = `http://${endpoint}`;
    }
    endpoint = endpoint.replace("0.0.0.0", "127.0.0.1");

    console.log("Sending request to local endpoint:", endpoint);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const response = await fetch(`${endpoint}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      console.log("Response status:", response.status);
      console.log("Response headers:", Object.fromEntries(response.headers));

      const responseText = await response.text();
      console.log("Raw response:", responseText);

      if (!response.ok) {
        throw new Error(`Local transcription failed: ${responseText}`);
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        console.error("JSON parse error:", e);
        throw new Error(`Invalid JSON response: ${responseText}`);
      }

      if (!data.text) {
        console.error("Invalid response structure:", data);
        throw new Error(`Missing text in response: ${JSON.stringify(data)}`);
      }

      updateProgress(1, 1);
      return data.text;
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === "AbortError") {
        throw new Error("Request timed out after 30 seconds");
      }
      throw fetchError;
    }
  } catch (error) {
    console.error("Local transcription error:", error);
    throw error;
  }
}
