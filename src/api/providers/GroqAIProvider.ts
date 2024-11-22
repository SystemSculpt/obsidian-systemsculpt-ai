import { ChatOpenAI } from "@langchain/openai";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";
import { requestUrl } from "obsidian";
import { Notice } from "obsidian";
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
    modelId: string
  ): Promise<string> {
    const llm = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: modelId,
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
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    console.log("Groq API Request Data (Single Message):", {
      systemPrompt,
      userMessage,
      modelId,
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

    if (hasImages && !modelId.toLowerCase().includes("vision")) {
      new Notice(
        "This Groq model does not support image analysis. Please use a model with vision capabilities.",
        15000
      );
      return;
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

    console.log("Groq Formatted Messages:", formattedMessages);

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
            if (!abortSignal?.aborted) {
              callback(token);
            }
          },
        },
      ],
    });

    try {
      const response = await llm.invoke(formattedMessages);
      console.log("Groq Full Response:", response);
    } catch (error) {
      console.error("Error in Groq streaming conversation:", error);
      if (
        error instanceof Error &&
        error.message?.includes("content must be a string")
      ) {
        new Notice(
          "This Groq model does not support image analysis. Please use a model with vision capabilities.",
          15000
        );
      }
      throw error;
    }
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

      return response.json.data
        .filter((model: any) => {
          const modelId = model.id.toLowerCase();
          return (
            !modelId.includes("whisper") &&
            !modelId.includes("tool-use") &&
            !modelId.includes("llava") &&
            !modelId.includes("guard")
          );
        })
        .map((model: any) => ({
          id: model.id,
          name: model.id,
          contextLength: model.context_window,
          provider: "groq",
        }))
        .sort((a: Model, b: Model) => a.id.localeCompare(b.id));
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
