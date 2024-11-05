import { OpenAIProvider } from "./providers/OpenAIProvider";
import { GroqAIProvider } from "./providers/GroqAIProvider";
import { OpenRouterAIProvider } from "./providers/OpenRouterAIProvider";
import { LocalAIProvider } from "./providers/LocalAIProvider";
import { Model, AIProvider, AIServiceInterface } from "./Model";
import { BaseAIProvider } from "./providers/BaseAIProvider";

type AIProviderType =
  | OpenAIProvider
  | GroqAIProvider
  | OpenRouterAIProvider
  | LocalAIProvider;

export class AIService implements AIServiceInterface {
  private static instance: AIService | null = null;
  private services: {
    [key in AIProvider]?: AIProviderType;
  } = {};

  static async getInstance(settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    openRouterAPIKey: string;
    localEndpoint: string;
    temperature: number;
    showopenAISetting?: boolean;
    showgroqSetting?: boolean;
    showlocalEndpointSetting?: boolean;
    showopenRouterSetting?: boolean;
  }): Promise<AIService> {
    if (!this.instance) {
      this.instance = new AIService(settings);
    } else {
      // Update existing instance settings
      this.instance.updateSettings(settings);
    }
    return this.instance;
  }

  private constructor(settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    openRouterAPIKey: string;
    localEndpoint: string;
    temperature: number;
  }) {
    this.services = {
      openai: new OpenAIProvider(settings.openAIApiKey, "", {
        temperature: settings.temperature,
      }),
      groq: new GroqAIProvider(settings.groqAPIKey, "", {
        temperature: settings.temperature,
      }),
      openRouter: new OpenRouterAIProvider(settings.openRouterAPIKey, "", {
        temperature: settings.temperature,
      }),
      local: new LocalAIProvider("", settings.localEndpoint, {
        temperature: settings.temperature,
      }),
    };
  }

  getProvider(provider: AIProvider) {
    return this.services[provider];
  }

  async getModels(): Promise<Model[]> {
    const allModels: Model[] = [];
    for (const provider of Object.values(this.services)) {
      if (provider) {
        const models = await provider.getModels();
        allModels.push(...models);
      }
    }
    return allModels;
  }

  updateSettings(settings: { temperature: number }) {
    Object.values(this.services).forEach((provider) => {
      provider?.updateSettings(settings);
    });
  }

  updateApiKey(apiKey: string): void;
  updateApiKey(providerOrKey: AIProvider | string, apiKey?: string): void {
    if (typeof providerOrKey === "string" && !apiKey) {
      // Interface implementation - update all providers
      Object.values(this.services).forEach((provider) => {
        provider?.updateApiKey(providerOrKey);
      });
    } else if (typeof providerOrKey !== "string" && apiKey) {
      // Original implementation - update specific provider
      this.services[providerOrKey as AIProvider]?.updateApiKey(apiKey);
    }
  }

  updateLocalEndpoint(endpoint: string) {
    if (this.services.local) {
      this.services.local = new LocalAIProvider(
        "",
        endpoint,
        this.services.local.getSettings()
      );
    }
  }

  async initializeModelCache(silent: boolean = false): Promise<void> {
    try {
      const models = await this.getModels();
      if (models.length === 0 && !silent) {
        console.warn("No models found during initialization");
      }
    } catch (error) {
      if (!silent) {
        console.error("Error initializing model cache:", error);
        throw error;
      }
    }
  }

  async ensureModelCacheInitialized(): Promise<void> {
    await this.initializeModelCache();
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const provider = await this.getProviderForModel(modelId);
    return provider.createChatCompletion(
      systemPrompt,
      userMessage,
      modelId,
      maxOutputTokens
    );
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const provider = await this.getProviderForModel(modelId);
    return provider.createStreamingChatCompletionWithCallback(
      systemPrompt,
      userMessage,
      modelId,
      maxOutputTokens,
      callback,
      abortSignal
    );
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const provider = await this.getProviderForModel(modelId);
    return provider.createStreamingConversationWithCallback(
      systemPrompt,
      messages,
      modelId,
      maxOutputTokens,
      callback,
      abortSignal
    );
  }

  private async getProviderForModel(modelId: string): Promise<BaseAIProvider> {
    const models = await this.getModels();
    const model = models.find((model: Model) => model.id === modelId);
    if (!model) throw new Error(`Model ${modelId} not found`);
    const provider = this.services[model.provider];
    if (!provider) throw new Error(`Provider ${model.provider} not found`);
    return provider;
  }

  clearModelCache(): void {
    Object.values(this.services).forEach((provider) => {
      if (provider) {
        provider.clearModelCache();
      }
    });
  }
}
