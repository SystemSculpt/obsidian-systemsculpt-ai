import Anthropic from "@anthropic-ai/sdk";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";

export class AnthropicAIProvider extends BaseAIProvider {
  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const anthropic = new Anthropic({
        apiKey,
        dangerouslyAllowBrowser: true,
      });
      await anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  private client: Anthropic;

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.anthropic.com", "anthropic", settings);
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: modelId,
      messages: [{ role: "user", content: userMessage }],
      system: systemPrompt,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
    });

    return response.content[0].type === "text" ? response.content[0].text : "";
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const stream = await this.client.messages.create({
      model: modelId,
      messages: [{ role: "user", content: userMessage }],
      system: systemPrompt,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
      stream: true,
    });

    for await (const chunk of stream) {
      if (abortSignal?.aborted) break;
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        callback(chunk.delta.text);
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
    const stream = await this.client.messages.create({
      model: modelId,
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      system: systemPrompt,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
      stream: true,
    });

    for await (const chunk of stream) {
      if (abortSignal?.aborted) break;
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        callback(chunk.delta.text);
      }
    }
  }

  async getModelsImpl(): Promise<Model[]> {
    return [
      {
        id: "claude-3-5-haiku-latest",
        name: "Claude 3.5 Haiku (Latest)",
        provider: "anthropic",
        contextLength: 200000,
        maxOutputTokens: 4096,
        pricing: {
          prompt: 0.003,
          completion: 0.015,
        },
      },
      {
        id: "claude-3-5-sonnet-latest",
        name: "Claude 3.5 Sonnet (Latest)",
        provider: "anthropic",
        contextLength: 200000,
        maxOutputTokens: 4096,
        pricing: {
          prompt: 0.003,
          completion: 0.015,
        },
      },
      {
        id: "claude-3-opus-latest",
        name: "Claude 3 Opus (Latest)",
        provider: "anthropic",
        contextLength: 200000,
        maxOutputTokens: 4096,
        pricing: {
          prompt: 0.015,
          completion: 0.075,
        },
      },
    ];
  }
}
