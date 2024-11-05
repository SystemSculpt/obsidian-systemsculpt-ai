import { requestUrl } from "obsidian";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model, AIProvider } from "../Model";

export class GroqAIProvider extends BaseAIProvider {
  constructor(
    apiKey: string,
    _endpoint: string, // Ignored since Groq endpoint is fixed
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.groq.com/openai/v1", "groq", settings);
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
        Authorization: `Bearer ${this.apiKey}`,
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
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestData),
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
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestData),
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
    if (!this.hasValidApiKey()) {
      return [];
    }

    const response = await requestUrl({
      url: `${this.endpoint}/models`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    return response.json.data
      .filter(
        (model: any) =>
          model.id !== "whisper-large-v3" &&
          !model.id.toLowerCase().includes("tool-use") &&
          !model.id.toLowerCase().includes("whisper") &&
          !model.id.toLowerCase().includes("llava")
      )
      .map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: "groq" as AIProvider,
        contextLength: model.context_window || undefined,
        pricing: model.pricing
          ? {
              prompt: parseFloat(model.pricing.prompt),
              completion: parseFloat(model.pricing.completion),
            }
          : { prompt: 0, completion: 0 },
      }));
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;

    try {
      const response = await requestUrl({
        url: "https://api.groq.com/openai/v1/models",
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.status === 200;
    } catch (error) {
      console.error("Failed to validate Groq API key:", error);
      return false;
    }
  }
}
