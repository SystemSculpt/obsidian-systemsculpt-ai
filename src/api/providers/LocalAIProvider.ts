import { requestUrl } from "obsidian";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model, AIProvider } from "../Model";
import { ChatOpenAI } from "@langchain/openai";

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
    const llm = new ChatOpenAI({
      openAIApiKey: "not-needed",
      modelName: modelId,
      maxTokens: maxOutputTokens,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: this.endpoint,
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
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const llm = new ChatOpenAI({
      openAIApiKey: "not-needed",
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
    const llm = new ChatOpenAI({
      openAIApiKey: "not-needed",
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

    await llm.invoke([{ role: "system", content: systemPrompt }, ...messages]);
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
