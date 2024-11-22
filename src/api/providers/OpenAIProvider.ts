import { ChatOpenAI } from "@langchain/openai";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";
import { Notice } from "obsidian";
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
      ...(this.shouldDisableTemperature(modelId)
        ? {}
        : {
            maxTokens: maxOutputTokens,
            temperature: this.settings.temperature,
          }),
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
      streaming: true,
      ...(this.shouldDisableTemperature(modelId)
        ? {}
        : {
            maxTokens: maxOutputTokens,
            temperature: this.settings.temperature,
          }),
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
      const filteredWords = [
        "dall-e",
        "tts",
        "whisper",
        "embedding",
        "davinci",
        "babbage",
        "gpt-4-turbo-2024-04-09",
        "gpt-4-1106-preview",
        "gpt-4o-mini-2024-07-18",
        "gpt-4-turbo-preview",
        "gpt-4-0125-preview",
        "gpt-4o-2024-05-13",
        "gpt-3.5-turbo-instruct",
        "gpt-3.5-turbo-instruct-0914",
        "gpt-3.5-turbo-16k",
        "gpt-3.5-turbo-0125",
        "gpt-3.5-turbo-1106",
        "gpt-4-0613",
        "gpt-3.5-turbo",
        "gpt-4o-2024-08-06",
        "gpt-4o-realtime-preview",
        "o1-mini-2024-09-12",
        "o1-preview-2024-09-12",
        "audio-preview",
      ];

      const filteredModels = models.data.filter(
        (model: any) =>
          !filteredWords.some((word) => model.id.toLowerCase().includes(word))
      );

      const sortedModels = filteredModels.sort((a: any, b: any) =>
        a.id.localeCompare(b.id)
      );

      const contextLengths: { [key: string]: number } = {
        "gpt-4o": 128000,
        "gpt-4o-2024-11-20": 128000,
        "gpt-4o-mini": 128000,
        "chatgpt-4o-latest": 128000,
        "o1-preview": 128000,
        "o1-mini": 128000,
        "gpt-4-turbo": 128000,
        "gpt-4": 8192,
      };

      const maxOutputTokens: { [key: string]: number } = {
        "gpt-4o": 16384,
        "gpt-4o-mini": 16384,
        "chatgpt-4o-latest": 16384,
        "o1-preview": 32768,
        "o1-mini": 65536,
        "gpt-4-turbo": 4096,
        "gpt-4": 8192,
      };

      return sortedModels.map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: "openai",
        contextLength: contextLengths[model.id] || model.context_length,
        maxOutputTokens:
          maxOutputTokens[model.id] || model.context_length || 4096,
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

  protected shouldDisableTemperature(modelId: string): boolean {
    return modelId.includes("o1-");
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
      const formattedMessages = this.shouldConvertSystemToUser(modelId)
        ? [{ role: "user", content: systemPrompt }, ...messages]
        : [{ role: "system", content: systemPrompt }, ...messages];

      const llm = new ChatOpenAI({
        openAIApiKey: this.apiKey,
        modelName: modelId,
        streaming: true,
        ...(this.shouldDisableTemperature(modelId)
          ? {}
          : { temperature: this.settings.temperature }),
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

      await llm.invoke(formattedMessages);
    } catch (error) {
      console.error(
        "OpenAIProvider Error in createStreamingConversationWithCallback:",
        error
      );
      if (
        error instanceof Error &&
        (error.message?.includes("image_url is only supported") ||
          error.message?.includes("Invalid content type"))
      ) {
        new Notice(
          "This model does not support image analysis. Please use GPT-4o, GPT-4o-mini, or ChatGPT-4o-latest (to name a few) or another vision-capable model.",
          15000
        );
      }
      throw error;
    }
  }
}
