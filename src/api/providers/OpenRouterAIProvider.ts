import { ChatOpenAI } from "@langchain/openai";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";

export class OpenRouterAIProvider extends BaseAIProvider {
  private llm: ChatOpenAI;

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://openrouter.ai/api/v1", "openRouter", settings);
    this.llm = new ChatOpenAI({
      openAIApiKey: apiKey,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://SystemSculpt.com",
          "X-Title": "SystemSculpt AI for Obsidian",
        },
      },
      temperature: settings.temperature,
    });
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    try {
      const llm = new ChatOpenAI({
        openAIApiKey: this.apiKey,
        modelName: modelId,
        maxTokens: maxOutputTokens,
        temperature: this.settings.temperature,
        configuration: {
          baseURL: this.endpoint,
          defaultHeaders: {
            "HTTP-Referer": "https://SystemSculpt.com",
            "X-Title": "SystemSculpt AI for Obsidian",
          },
        },
      });

      const response = await llm.invoke([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);

      return response.content.toString();
    } catch (error) {
      console.error(
        "OpenRouterAIProvider Error in createChatCompletion:",
        error
      );
      throw error;
    }
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      const inputTokens = await this.llm.getNumTokens(
        systemPrompt + userMessage
      );
      const maxContextLength = 131072;
      const buffer = 100; // Buffer to ensure we're under the limit
      const availableTokens = maxContextLength - inputTokens - buffer;

      if (availableTokens <= 0) {
        throw new Error(
          `Input is too long. Reduce the input length to fit within the maximum context length of ${maxContextLength} tokens.`
        );
      }

      const llm = new ChatOpenAI({
        openAIApiKey: this.apiKey,
        modelName: modelId,
        maxTokens: Math.min(maxOutputTokens, availableTokens),
        streaming: true,
        temperature: this.settings.temperature,
        configuration: {
          baseURL: this.endpoint,
          defaultHeaders: {
            "HTTP-Referer": "https://SystemSculpt.com",
            "X-Title": "SystemSculpt AI for Obsidian",
          },
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
        { role: "user", content: userMessage },
      ]);
    } catch (error) {
      console.error(
        "OpenRouterAIProvider Error in createStreamingChatCompletionWithCallback:",
        error
      );
      throw error;
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
      const formattedMessages = this.shouldConvertSystemToUser(modelId)
        ? [{ role: "user", content: systemPrompt }, ...messages]
        : [{ role: "system", content: systemPrompt }, ...messages];

      const isO1Model = modelId.includes("o1-");

      const llm = new ChatOpenAI(
        {
          openAIApiKey: this.apiKey,
          modelName: modelId,
          streaming: !isO1Model,
          temperature: isO1Model ? 1 : this.settings.temperature,
          callbacks: !isO1Model
            ? [
                {
                  handleLLMNewToken(token: string) {
                    if (!abortSignal?.aborted) {
                      callback(token);
                    }
                  },
                },
              ]
            : undefined,
        },
        {
          basePath: this.endpoint,
          baseOptions: {
            headers: {
              "HTTP-Referer": "https://SystemSculpt.com",
              "X-Title": "SystemSculpt AI for Obsidian",
            },
          },
        }
      );

      const response = await llm.invoke(formattedMessages);

      // For O1 models, send the complete response at once
      if (isO1Model && response.content) {
        callback(response.content.toString());
      }
    } catch (error) {
      console.error(
        "OpenRouterAIProvider Error in createStreamingConversationWithCallback:",
        error
      );
      throw error;
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "https://SystemSculpt.com",
          "X-Title": "SystemSculpt AI for Obsidian",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();
      return data.data.map((model: any) => ({
        id: model.id,
        name: model.name || model.id,
        provider: "openRouter",
        contextLength: model.context_length,
        maxOutputTokens: model.context_length,
        pricing: {
          prompt: model.pricing?.prompt || 0,
          completion: model.pricing?.completion || 0,
        },
      }));
    } catch (error) {
      console.error("OpenRouterAIProvider Error in getModelsImpl:", error);
      throw error;
    }
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://SystemSculpt.com",
          "X-Title": "SystemSculpt AI for Obsidian",
        },
      });
      return response.status === 200;
    } catch (error) {
      console.error("OpenRouterAIProvider Error in validateApiKey:", error);
      return false;
    }
  }

  async getModelById(modelId: string): Promise<Model> {
    const models = await this.getModelsImpl();
    const model = models.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Model with ID ${modelId} not found.`);
    }
    return model;
  }

  private shouldConvertSystemToUser(modelId: string): boolean {
    return modelId.includes("o1-");
  }

  private shouldDisableStreaming(modelId: string): boolean {
    return modelId.includes("o1-");
  }

  private shouldDisableTemperature(modelId: string): boolean {
    return modelId.includes("o1-");
  }
}

function compressMiddleOut(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const halfLength = Math.floor(maxLength / 2);
  return text.slice(0, halfLength) + "..." + text.slice(-halfLength);
}
