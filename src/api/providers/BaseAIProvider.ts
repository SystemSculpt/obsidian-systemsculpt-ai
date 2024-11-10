import { Model, AIProvider } from "../Model";

export abstract class BaseAIProvider {
  protected apiKey: string;
  protected endpoint: string;
  protected settings: { temperature: number };
  protected provider: AIProvider;
  protected cachedModels: Model[] | null = null;
  protected modelLoadPromise: Promise<Model[]> | null = null;

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

  protected abstract getModelsImpl(): Promise<Model[]>;

  protected async loadModelsInBackground(): Promise<Model[]> {
    try {
      if (this.cachedModels) return this.cachedModels;
      if (this.modelLoadPromise) return this.modelLoadPromise;

      this.modelLoadPromise = this.getModelsImpl();
      const models = await this.modelLoadPromise;
      this.cachedModels = models;
      this.modelLoadPromise = null;
      return models;
    } catch (error) {
      console.error("Failed to load models:", error);
      return [];
    }
  }

  async getModels(): Promise<Model[]> {
    if (this.cachedModels) return this.cachedModels;
    return this.loadModelsInBackground();
  }

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

  clearModelCache(): void {
    this.cachedModels = null;
    this.modelLoadPromise = null;
  }

  protected async getTokenCount(text: string): Promise<number> {
    // Simple approximation: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}
