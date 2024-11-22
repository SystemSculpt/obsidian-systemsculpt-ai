import { ChatOpenAI } from "@langchain/openai";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";
import { requestUrl } from "obsidian";
import { Notice } from "obsidian";

export class OpenRouterAIProvider extends BaseAIProvider {
  private llm: ChatOpenAI;

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://openrouter.ai/api", "openRouter", settings);
    this.llm = new ChatOpenAI({
      openAIApiKey: apiKey,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://SystemSculpt.com",
          "X-Title": "SystemSculpt",
        },
      },
      temperature: settings.temperature,
    });
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string
  ): Promise<string> {
    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://SystemSculpt.com",
          "X-Title": "SystemSculpt",
        },
      },
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
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      streaming: true,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://SystemSculpt.com",
          "X-Title": "SystemSculpt",
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
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: {
      role: string;
      content:
        | string
        | { type: string; text?: string; image_url?: { url: string } }[];
    }[],
    modelId: string,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const hasImages = messages.some(
      (msg) =>
        Array.isArray(msg.content) &&
        msg.content.some((c) => c.type === "image_url")
    );

    if (hasImages) {
      const model = (await this.getModels()).find((m) => m.id === modelId);
      if (!model?.supportsVision) {
        new Notice(
          "This model does not support image analysis. Please use a model with vision capabilities.",
          15000
        );
        return;
      }
    }

    const formattedMessages = hasImages
      ? [
          { role: "user", content: systemPrompt },
          ...messages.map((msg) => ({
            role: msg.role === "ai" ? "assistant" : msg.role,
            content: msg.content,
          })),
        ]
      : [
          { role: "system", content: systemPrompt },
          ...messages.map((msg) => ({
            role: msg.role === "ai" ? "assistant" : msg.role,
            content: msg.content,
          })),
        ];

    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      streaming: true,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://obsidian.md",
          "X-Title": "Obsidian",
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

    try {
      await llm.invoke(formattedMessages);
    } catch (error) {
      console.error("Error in OpenRouter streaming conversation:", error);
      if (
        error instanceof Error &&
        error.message?.includes("content must be a string")
      ) {
        new Notice(
          "This model does not support image analysis. Please use a model with vision capabilities.",
          15000
        );
      }
      throw error;
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    try {
      const response = await requestUrl({
        url: "https://openrouter.ai/api/v1/models",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "https://obsidian.md",
          "X-Title": "Obsidian",
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      return response.json.data
        .filter((model: any) => model.context_length > 0)
        .map((model: any) => ({
          id: model.id,
          name: model.name || model.id,
          contextLength: model.context_length,
          provider: "openRouter",
          supportsVision: model.architecture?.modality?.includes("image"),
          pricing: {
            prompt: model.pricing?.prompt || 0,
            completion: model.pricing?.completion || 0,
          },
        }))
        .sort(
          (a: Model, b: Model) =>
            (b.contextLength || 0) - (a.contextLength || 0)
        );
    } catch (error) {
      console.error("OpenRouterAIProvider Error in getModelsImpl:", error);
      return [];
    }
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: "https://openrouter.ai/api/v1/models",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://obsidian.md",
          "X-Title": "Obsidian",
        },
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
