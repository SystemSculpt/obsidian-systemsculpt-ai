import { OpenAIProvider } from "./providers/OpenAIProvider";
import { GroqAIProvider } from "./providers/GroqAIProvider";
import { OpenRouterAIProvider } from "./providers/OpenRouterAIProvider";
import { LocalAIProvider } from "./providers/LocalAIProvider";
import { AnthropicAIProvider } from "./providers/AnthropicAIProvider";
import { Model, AIProvider, AIServiceInterface } from "./Model";
import { BaseAIProvider } from "./providers/BaseAIProvider";
import { OpenAI } from "@langchain/openai";
import { ChatOpenAI } from "@langchain/openai";
import { BrainSettings } from "../modules/brain/settings/BrainSettings";

type AIProviderType =
  | OpenAIProvider
  | GroqAIProvider
  | OpenRouterAIProvider
  | LocalAIProvider
  | AnthropicAIProvider;

interface AIServiceSettings {
  openAIApiKey: string;
  groqAPIKey: string;
  openRouterAPIKey: string;
  localEndpoint: string;
  anthropicApiKey: string;
  temperature: number;
  showopenAISetting?: boolean;
  showgroqSetting?: boolean;
  showlocalEndpointSetting?: boolean;
  showopenRouterSetting?: boolean;
  showAnthropicSetting?: boolean;
}

export class AIService implements AIServiceInterface {
  private static instance: AIService | null = null;
  private services: {
    [key in AIProvider]?: AIProviderType;
  } = {};
  private modelCacheInitialized: boolean = false;

  static async getInstance(
    settings: AIServiceSettings,
    forceNew: boolean = false
  ): Promise<AIService> {
    if (forceNew || !this.instance) {
      this.instance = new AIService(settings);
    } else {
      this.instance.updateSettings(settings);
    }
    return this.instance;
  }

  public static destroyInstance(): void {
    this.instance = null;
  }

  private constructor(settings: AIServiceSettings) {
    this.services = {
      openai: new OpenAIProvider(
        settings.openAIApiKey,
        "https://api.openai.com",
        { temperature: settings.temperature }
      ),
      groq: new GroqAIProvider(
        settings.groqAPIKey,
        "", // GroqAIProvider sets its own endpoint
        { temperature: settings.temperature }
      ),
      openRouter: new OpenRouterAIProvider(
        settings.openRouterAPIKey,
        "", // OpenRouterAIProvider sets its own endpoint
        { temperature: settings.temperature }
      ),
      local: new LocalAIProvider(
        "", // LocalAIProvider doesn't use API key
        settings.localEndpoint,
        { temperature: settings.temperature }
      ),
      anthropic: new AnthropicAIProvider(
        settings.anthropicApiKey,
        "", // AnthropicAIProvider sets its own endpoint
        { temperature: settings.temperature }
      ),
    };
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

  public async initializeModelCache(
    provider?: string,
    force: boolean = false
  ): Promise<void> {
    if (force || !this.modelCacheInitialized) {
      try {
        if (provider) {
          const providerInstance =
            this.services[provider as keyof typeof this.services];
          if (providerInstance) {
            await providerInstance.getModels().catch(() => []);
          }
        } else {
          const promises = [
            this.services.openai?.getModels().catch(() => []),
            this.services.anthropic?.getModels().catch(() => []),
            this.services.groq?.getModels().catch(() => []),
            this.services.openRouter?.getModels().catch(() => []),
            this.services.local?.getModels().catch(() => []),
          ];
          await Promise.all(promises);
        }
      } catch (error) {
        console.warn("Error initializing model cache:", error);
      }
      this.modelCacheInitialized = true;
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
    onData: (chunk: string) => void,
    abortSignal: AbortSignal
  ): Promise<void> {
    const provider = await this.getProviderForModel(modelId);
    return provider.createStreamingChatCompletionWithCallback(
      systemPrompt,
      userMessage,
      modelId,
      maxOutputTokens,
      onData,
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

  public getProvider(provider: string): BaseAIProvider | undefined {
    const providerKey = provider.toLowerCase() as keyof typeof this.services;
    return this.services[providerKey];
  }
}
