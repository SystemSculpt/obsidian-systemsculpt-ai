import { ChatAnthropic } from "@langchain/anthropic";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";

export class AnthropicAIProvider extends BaseAIProvider {
  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const llm = new ChatAnthropic({ anthropicApiKey: apiKey });
      await llm.invoke([{ role: "user", content: "test" }]);
      return true;
    } catch {
      return false;
    }
  }
  private llm: ChatAnthropic;

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.anthropic.com", "anthropic", settings);
    this.llm = new ChatAnthropic({
      anthropicApiKey: apiKey,
      temperature: settings.temperature,
    });
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const llm = new ChatAnthropic({
      anthropicApiKey: this.apiKey,
      modelName: modelId,
      maxTokens: maxOutputTokens,
      temperature: this.settings.temperature,
    });

    const response = await llm.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);

    return response.content.toString();
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const llm = new ChatAnthropic({
      anthropicApiKey: this.apiKey,
      modelName: modelId,
      maxTokens: maxOutputTokens,
      streaming: true,
      temperature: this.settings.temperature,
      callbacks: [
        {
          handleLLMNewToken(token: string) {
            if (!abortSignal?.aborted) {
              callback(token);
            }
          },
        },
      ],
    });

    await llm.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const llm = new ChatAnthropic({
      anthropicApiKey: this.apiKey,
      modelName: modelId,
      maxTokens: maxOutputTokens,
      streaming: true,
      temperature: this.settings.temperature,
      callbacks: [
        {
          handleLLMNewToken(token: string) {
            if (!abortSignal?.aborted) {
              callback(token);
            }
          },
        },
      ],
    });

    await llm.invoke([{ role: "system", content: systemPrompt }, ...messages]);
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
