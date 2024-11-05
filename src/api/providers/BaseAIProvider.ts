import { Model, AIProvider } from "../Model";

export abstract class BaseAIProvider {
  protected apiKey: string;
  protected endpoint: string;
  protected settings: { temperature: number };
  protected provider: AIProvider;

  constructor(
    apiKey: string,
    endpoint: string,
    provider: AIProvider,
    settings: { temperature: number }
  ) {
    this.apiKey = apiKey;
    this.endpoint = endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;
    this.provider = provider;
    this.settings = settings;
  }

  abstract createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string>;

  abstract createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void>;

  abstract createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void>;

  abstract getModels(): Promise<Model[]>;

  updateSettings(settings: { temperature: number }) {
    this.settings = settings;
  }

  updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  hasValidApiKey(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  getSettings(): { temperature: number } {
    return this.settings;
  }
}
