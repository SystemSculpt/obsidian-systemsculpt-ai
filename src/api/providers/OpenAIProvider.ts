import { ChatOpenAI } from "@langchain/openai";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";

export class OpenAIProvider extends BaseAIProvider {
  private llm: ChatOpenAI;

  constructor(
    apiKey: string,
    endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, endpoint, "openai", settings);
    this.llm = new ChatOpenAI({
      openAIApiKey: apiKey,
      temperature: settings.temperature,
    });
  }

  protected shouldConvertSystemToUser(modelId: string): boolean {
    return (
      modelId.includes("gpt-3.5-turbo-0301") ||
      modelId.includes("o1-preview") ||
      modelId.includes("o1-mini")
    );
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const messages = this.shouldConvertSystemToUser(modelId)
      ? [
          { role: "user", content: systemPrompt },
          { role: "user", content: userMessage },
        ]
      : [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ];

    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      maxTokens: maxOutputTokens,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: this.endpoint,
      },
    });

    const response = await llm.invoke(messages);
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
    const messages = this.shouldConvertSystemToUser(modelId)
      ? [
          { role: "user", content: systemPrompt },
          { role: "user", content: userMessage },
        ]
      : [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ];

    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      maxTokens: maxOutputTokens,
      streaming: true,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: this.endpoint,
      },
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

    await llm.invoke(messages);
  }

  protected async getModelsImpl(): Promise<Model[]> {
    try {
      const endpoint = "https://api.openai.com/v1";
      const response = await fetch(`${endpoint}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        console.warn(`OpenAI API error: ${response.status}`);
        return [];
      }

      const models = await response.json();
      return models.data.map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: "openai",
        contextLength: model.context_length,
        maxOutputTokens: model.context_length,
        pricing: {
          prompt: 0.0001,
          completion: 0.0002,
        },
      }));
    } catch (error) {
      console.warn("Failed to fetch OpenAI models:", error);
      return [];
    }
  }

  getApiKey(): string {
    return this.apiKey;
  }

  static async validateApiKey(
    apiKey: string,
    baseUrl?: string
  ): Promise<boolean> {
    try {
      const llm = new ChatOpenAI({
        openAIApiKey: apiKey,
        configuration: baseUrl ? { baseURL: baseUrl } : undefined,
      });
      await llm.invoke([{ role: "user", content: "test" }]);
      return true;
    } catch {
      return false;
    }
  }

  protected async getTokenCount(text: string): Promise<number> {
    try {
      return await this.llm.getNumTokens(text);
    } catch (error) {
      return super.getTokenCount(text);
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
    try {
      const llm = new ChatOpenAI({
        openAIApiKey: this.apiKey,
        modelName: modelId,
        streaming: true,
        temperature: this.settings.temperature,
        configuration: {
          baseURL: this.endpoint,
        },
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
        ...messages,
      ]);
    } catch (error) {
      console.error(
        "OpenAIProvider Error in createStreamingConversationWithCallback:",
        error
      );
      throw error;
    }
  }
}
