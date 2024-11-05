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
    const response = await requestUrl({
      url: `${this.endpoint}/messages`,
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxOutputTokens,
        messages: [
          {
            role: "user",
            content: `${systemPrompt}\n\n${userMessage}`,
          },
        ],
      }),
    });

    return response.json.content[0].text;
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.endpoint}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: [
          {
            role: "user",
            content: `${systemPrompt}\n\n${userMessage}`,
          },
        ],
      }),
      signal: abortSignal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "content_block_delta" && data.delta?.text) {
              callback(data.delta.text);
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
    const anthropicMessages = [
      {
        role: "user",
        content: systemPrompt,
      },
      ...messages.map((msg) => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      })),
    ];

    const response = await fetch(`${this.endpoint}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: anthropicMessages,
      }),
      signal: abortSignal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "content_block_delta" && data.delta?.text) {
              callback(data.delta.text);
            }
          } catch (error) {
            console.warn("Error parsing SSE message:", error);
          }
        }
      }
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    // if (!this.apiKey) {
    //   console.debug("Anthropic: No API key");
    //   return [];
    // }

    // try {
    //   const isValid = await AnthropicAIProvider.validateApiKey(this.apiKey);
    //   if (!isValid) {
    //     console.debug("Anthropic: Invalid API key");
    //     return [];
    //   }
    // } catch (error) {
    //   console.warn(
    //     "Anthropic: Unable to validate API key, proceeding to load models"
    //   );
    //   // Proceed to return models even if validation fails (e.g., no network)
    // }

    return [
      {
        id: "claude-3-5-haiku-latest",
        name: "Claude 3.5 Haiku (Latest)",
        provider: "anthropic" as AIProvider,
        contextLength: 200000,
        maxOutputTokens: 8192,
        pricing: {
          prompt: 0.0000002,
          completion: 0.000001,
        },
      },
      {
        id: "claude-3-5-sonnet-latest",
        name: "Claude 3.5 Sonnet (Latest)",
        provider: "anthropic" as AIProvider,
        contextLength: 200000,
        maxOutputTokens: 8192,
        pricing: {
          prompt: 0.000003,
          completion: 0.000015,
        },
      },
      {
        id: "claude-3-opus-latest",
        name: "Claude 3 Opus",
        provider: "anthropic" as AIProvider,
        contextLength: 200000,
        maxOutputTokens: 4096,
        pricing: {
          prompt: 0.000015,
          completion: 0.000075,
        },
      },
    ];
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
