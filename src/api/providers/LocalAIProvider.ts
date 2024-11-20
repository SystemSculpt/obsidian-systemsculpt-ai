import { requestUrl } from "obsidian";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model, AIProvider } from "../Model";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";

export class LocalAIProvider extends BaseAIProvider {
  private isOllama: boolean = false;

  constructor(
    _apiKey: string,
    endpoint: string,
    settings: { temperature: number }
  ) {
    super("", endpoint, "local", settings);
    this.detectEndpointType();
  }

  private async detectEndpointType(): Promise<void> {
    try {
      const baseEndpoint = this.endpoint.replace("/v1", "");
      const response = await requestUrl({
        url: `${baseEndpoint}/api/tags`,
        method: "GET",
      });

      // Check if it's a valid Ollama response with data
      if (response.status === 200 && response.json?.models) {
        this.isOllama = true;
        this.endpoint = baseEndpoint;
      } else {
        // If we get 200 but no data, it's likely LM Studio
        this.isOllama = false;
        this.endpoint = this.endpoint.endsWith("/v1")
          ? this.endpoint
          : `${this.endpoint}/v1`;
      }
    } catch {
      this.isOllama = false;
      this.endpoint = this.endpoint.endsWith("/v1")
        ? this.endpoint
        : `${this.endpoint}/v1`;
    }
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    if (this.isOllama) {
      const llm = new ChatOllama({
        model: modelId,
        baseUrl: this.endpoint,
      });
      const response = await llm.invoke([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    } else {
      const llm = new ChatOpenAI({
        openAIApiKey: "not-needed",
        modelName: modelId,
        maxTokens: maxOutputTokens,
        temperature: this.settings.temperature,
        configuration: {
          baseURL: this.endpoint,
          defaultHeaders: {
            "Content-Type": "application/json",
          },
        },
      });
      const response = await llm.invoke([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);
      return response.content.toString();
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
    if (this.isOllama) {
      const llm = new ChatOllama({
        model: modelId,
        baseUrl: this.endpoint,
        streaming: true,
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
    } else {
      const response = await requestUrl({
        url: `${this.endpoint}/chat/completions`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: maxOutputTokens,
          temperature: this.settings.temperature,
          stream: true,
        }),
      });

      const reader = response.arrayBuffer;
      const decoder = new TextDecoder();
      const lines = decoder.decode(reader).split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          const data = JSON.parse(line.slice(6));
          const content = data.choices[0]?.delta?.content;
          if (content && !abortSignal?.aborted) {
            callback(content);
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
    if (this.isOllama) {
      const llm = new ChatOllama({
        model: modelId,
        baseUrl: this.endpoint,
        streaming: true,
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
    } else {
      const llm = new ChatOpenAI({
        openAIApiKey: "not-needed",
        modelName: modelId,
        maxTokens: maxOutputTokens,
        streaming: true,
        temperature: this.settings.temperature,
        configuration: {
          baseURL: this.endpoint,
          defaultHeaders: {
            "Content-Type": "application/json",
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

      const formattedMessages = [
        { role: "system", content: systemPrompt },
        ...messages.map((msg) => ({
          role: msg.role === "ai" ? "assistant" : msg.role,
          content: msg.content,
        })),
      ];

      await llm.invoke(formattedMessages);
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    try {
      // Validate endpoint is reachable first
      const testResponse = await fetch(this.endpoint, {
        method: "HEAD",
      }).catch(() => null);

      if (!testResponse?.ok) {
        console.warn(`Local endpoint ${this.endpoint} not reachable`);
        return [];
      }

      if (this.isOllama) {
        const response = await requestUrl({
          url: `${this.endpoint}/api/tags`,
          method: "GET",
        });
        if (response.status === 200) {
          return response.json.models.map((model: any) => ({
            id: model.name,
            name: model.name,
            provider: "local" as AIProvider,
            contextLength: undefined,
            pricing: { prompt: 0, completion: 0 },
          }));
        }
      } else {
        const response = await requestUrl({
          url: `${this.endpoint}/models`,
          method: "GET",
        });
        if (response.status === 200) {
          return response.json.data.map((model: any) => ({
            id: model.id,
            name: model.id,
            provider: "local" as AIProvider,
            contextLength: model.context_window || undefined,
            pricing: { prompt: 0, completion: 0 },
          }));
        }
      }
    } catch (error) {
      console.warn("Failed to fetch local models:", error);
      return []; // Return empty array instead of throwing
    }
    return [];
  }

  hasValidApiKey(): boolean {
    return true;
  }

  static async validateApiKey(
    _apiKey: string,
    endpoint?: string
  ): Promise<boolean> {
    if (!endpoint) return false;

    try {
      const baseEndpoint = endpoint.replace("/v1", "");
      const ollamaResponse = await requestUrl({
        url: `${baseEndpoint}/api/tags`,
        method: "GET",
      });
      if (ollamaResponse.status === 200) return true;
    } catch {
      try {
        const openAIEndpoint = endpoint.endsWith("/v1")
          ? endpoint
          : `${endpoint}/v1`;
        const openAIResponse = await requestUrl({
          url: `${openAIEndpoint}/models`,
          method: "GET",
        });
        return openAIResponse.status === 200;
      } catch {
        return false;
      }
    }
    return false;
  }

  updateEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
    this.detectEndpointType();
  }
}
