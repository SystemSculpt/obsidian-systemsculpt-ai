import { ChatOpenAI } from "@langchain/openai";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";
import { requestUrl } from "obsidian";

export class GroqAIProvider extends BaseAIProvider {
  private llm: ChatOpenAI;

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.groq.com", "groq", settings);
    this.llm = new ChatOpenAI({
      openAIApiKey: apiKey,
      configuration: {
        baseURL: "https://api.groq.com/openai/v1",
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
    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      maxTokens: maxOutputTokens,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: "https://api.groq.com/openai/v1",
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
    console.log("Groq API Request Data (Single Message):", {
      systemPrompt,
      userMessage,
      modelId,
      maxOutputTokens,
    });

    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      streaming: true,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: "https://api.groq.com/openai/v1",
      },
      callbacks: [
        {
          handleLLMNewToken(token: string) {
            console.log("Groq Streaming Token:", token);
            if (!abortSignal?.aborted) {
              callback(token);
            }
          },
        },
      ],
    });

    const response = await llm.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);
    console.log("Groq Full Response:", response);
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    console.log("Groq API Request Data (Conversation):", {
      systemPrompt,
      messages,
      modelId,
      maxOutputTokens,
    });

    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
      streaming: true,
      temperature: this.settings.temperature,
      configuration: {
        baseURL: "https://api.groq.com/openai/v1",
      },
      callbacks: [
        {
          handleLLMNewToken(token: string) {
            console.log("Groq Streaming Token:", token);
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

    console.log("Groq Formatted Messages:", formattedMessages);

    const response = await llm.invoke(formattedMessages);
    console.log("Groq Full Response:", response);
  }

  protected async getModelsImpl(): Promise<Model[]> {
    try {
      const response = await requestUrl({
        url: "https://api.groq.com/openai/v1/models",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      return response.json.data.map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: "groq",
      }));
    } catch (error) {
      console.error("GroqAIProvider Error in getModelsImpl:", error);
      return [];
    }
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: "https://api.groq.com/openai/v1/models",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
