import { requestUrl } from "obsidian";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model, AIProvider } from "../Model";

export class LocalAIProvider extends BaseAIProvider {
  constructor(
    _apiKey: string, // Not used for local
    endpoint: string,
    settings: { temperature: number }
  ) {
    super("", endpoint, "local", settings);
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const requestData = {
      model: modelId,
      messages,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
    };

    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const requestData = {
      model: modelId,
      messages,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
      stream: true,
    };

    const req = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestData),
      signal: abortSignal,
    });

    if (!req.ok || !req.body) {
      throw new Error(`API request failed with status ${req.status}`);
    }

    const reader = req.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let lastContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices && data.choices[0].delta.content) {
              const newContent = data.choices[0].delta.content;
              if (newContent !== lastContent) {
                callback(line);
                lastContent = newContent;
              }
            } else {
              callback(line);
            }
          } catch (error) {
            console.warn("Error parsing SSE message:", error);
          }
        }
      }
    }
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const allMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const requestData = {
      model: modelId,
      messages: allMessages,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
      stream: true,
    };

    const req = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestData),
      signal: abortSignal,
    });

    if (!req.ok || !req.body) {
      throw new Error(`API request failed with status ${req.status}`);
    }

    const reader = req.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let lastContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices && data.choices[0].delta.content) {
              const newContent = data.choices[0].delta.content;
              if (newContent !== lastContent) {
                callback(line);
                lastContent = newContent;
              }
            } else {
              callback(line);
            }
          } catch (error) {
            console.warn("Error parsing SSE message:", error);
          }
        }
      }
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    try {
      // Try Ollama endpoint first
      const ollamaResponse = await requestUrl({
        url: `${this.endpoint}/api/tags`,
        method: "GET",
      });

      if (ollamaResponse.status === 200) {
        return ollamaResponse.json.models.map((model: any) => ({
          id: model.name,
          name: model.name,
          provider: "local" as AIProvider,
          pricing: { prompt: 0, completion: 0 },
        }));
      }
    } catch {
      // If Ollama fails, try OpenAI-compatible endpoint
      try {
        const openAIResponse = await requestUrl({
          url: `${this.endpoint}/models`,
          method: "GET",
        });

        if (openAIResponse.status === 200) {
          return openAIResponse.json.data.map((model: any) => ({
            id: model.id,
            name: model.id,
            provider: "local" as AIProvider,
            contextLength: model.context_window || undefined,
            pricing: { prompt: 0, completion: 0 },
          }));
        }
      } catch (error) {
        console.warn("Failed to fetch local models:", error);
      }
    }
    return [];
  }

  hasValidApiKey(): boolean {
    return true; // Local provider doesn't need an API key
  }

  static async validateApiKey(
    _apiKey: string,
    endpoint: string
  ): Promise<boolean> {
    try {
      // Try Ollama endpoint first
      const ollamaResponse = await requestUrl({
        url: `${endpoint}/api/tags`,
        method: "GET",
      });
      if (ollamaResponse.status === 200) {
        return true;
      }
    } catch {
      // If Ollama fails, try OpenAI-compatible endpoint
      try {
        const openAIResponse = await requestUrl({
          url: `${endpoint}/models`,
          method: "GET",
        });
        return openAIResponse.status === 200;
      } catch (error) {
        console.warn("Failed to validate local endpoint:", error);
        return false;
      }
    }
    return false;
  }
}
