import { ChatGroq } from "@langchain/groq";
import { BaseAIProvider } from "./BaseAIProvider";
import { Model } from "../Model";
import { requestUrl } from "obsidian";

export class GroqAIProvider extends BaseAIProvider {
  private llm: ChatGroq;

  constructor(
    apiKey: string,
    _endpoint: string,
    settings: { temperature: number }
  ) {
    super(apiKey, "https://api.groq.com/openai/v1", "groq", settings);
    this.llm = new ChatGroq({
      apiKey: apiKey,
      temperature: settings.temperature,
    });
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const llm = new ChatGroq({
      apiKey: this.apiKey,
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
    const llm = new ChatGroq({
      apiKey: this.apiKey,
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
    const llm = new ChatGroq({
      apiKey: this.apiKey,
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

  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const llm = new ChatGroq({ apiKey });
      await llm.invoke([{ role: "user", content: "test" }]);
      return true;
    } catch {
      return false;
    }
  }

  protected async getModelsImpl(): Promise<Model[]> {
    if (!this.hasValidApiKey()) return [];

    const response = await requestUrl({
      url: `${this.endpoint}/models`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    return response.json.data
      .filter(
        (model: any) =>
          !model.id.toLowerCase().includes("whisper") &&
          !model.id.toLowerCase().includes("llava")
      )
      .map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: "groq",
        contextLength: model.context_window,
        pricing: {
          prompt: 0.0001,
          completion: 0.0002,
        },
      }));
  }
}
