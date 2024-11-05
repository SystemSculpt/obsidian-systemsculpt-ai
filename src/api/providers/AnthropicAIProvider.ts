import { requestUrl } from "obsidian";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model, AIProvider } from "../Model";

export class AnthropicAIProvider extends BaseAIProvider {
  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.anthropic.com", "anthropic", settings);
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

    const response = await fetch(`${this.endpoint}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.content[0].text;
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

    const req = await fetch(`${this.endpoint}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
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

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          callback(line);
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

    const req = await fetch(`${this.endpoint}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
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

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          callback(line);
        }
      }
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    if (!this.hasValidApiKey()) {
      return [];
    }

    const response = await requestUrl({
      url: `${this.endpoint}/v1/models`,
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    return response.json.models
      .filter((model: any) => model.id.startsWith("claude"))
      .map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: "anthropic" as AIProvider,
        contextLength: model.context_window || undefined,
        maxOutputTokens: model.max_tokens || 4096,
        pricing: {
          prompt: model.pricing?.prompt || 0,
          completion: model.pricing?.completion || 0,
        },
      }));
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;

    try {
      const response = await requestUrl({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          max_tokens: 1,
          messages: [
            {
              role: "user",
              content: "Hi",
            },
          ],
        }),
      });

      return response.status === 200;
    } catch (error) {
      console.error("Failed to validate Anthropic API key:", error);
      // Special case: if we get a 401, the key is definitely invalid
      if (error instanceof Error && "status" in error && error.status === 401) {
        return false;
      }
      // For other errors, we might want to be more lenient as it could be a temporary API issue
      return false;
    }
  }
}
