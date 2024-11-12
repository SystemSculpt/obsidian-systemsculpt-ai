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
        defaultHeaders: {
          "Content-Type": "application/json",
        },
      },
    });

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

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
    try {
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
    } catch (error) {
      console.error("LocalAIProvider streaming error:", error);
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

  protected async getModelsImpl(): Promise<Model[]> {
    try {
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
    } catch (error) {
      console.warn("Failed to fetch local models:", error);
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
      const response = await requestUrl({
        url: `${endpoint}/models`,
        method: "GET",
      });
      return response.status === 200;
    } catch (error) {
      console.warn("Failed to validate local endpoint:", error);
      return false;
    }
  }
}
