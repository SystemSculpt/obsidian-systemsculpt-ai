import { OpenAIProvider } from "./providers/OpenAIProvider";
import { GroqAIProvider } from "./providers/GroqAIProvider";
import { OpenRouterAIProvider } from "./providers/OpenRouterAIProvider";
import { LocalAIProvider } from "./providers/LocalAIProvider";
import { AnthropicAIProvider } from "./providers/AnthropicAIProvider";
import { Model, AIProvider, AIServiceInterface } from "./Model";
import { BaseAIProvider } from "./providers/BaseAIProvider";
import { AIProviderKey, AIProviderServices, providerKeyMap } from "./types";

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
  private services: AIProviderServices = {};
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
    for (const [providerKey, provider] of Object.entries(this.services)) {
      if (provider) {
        try {
          const models = await provider.getModels();
          allModels.push(...models);
        } catch (error) {
          console.warn(`Failed to fetch models from ${providerKey}:`, error);
          // Continue with other providers instead of failing completely
        }
      }
    }
    return allModels;
  }

  async updateSettings(settings: Partial<AIServiceSettings>): Promise<void> {
    Object.entries(settings).forEach(([key, value]) => {
      if (typeof value !== "string" || !(key in providerKeyMap)) return;

      const providerKey = providerKeyMap[key as keyof typeof providerKeyMap];
      const provider = this.services[providerKey];

      if (provider) {
        if (key === "localEndpoint") {
          provider.updateEndpoint(value);
        } else {
          provider.updateApiKey(value);
        }
        provider.clearModelCache();
        provider.getModels().catch(() => []);
      }
    });

    // Reinitialize model cache if temperature changed
    if ("temperature" in settings) {
      await this.initializeModelCache();
    }
  }

  getProvider(providerKey: AIProviderKey): AIProviderType | undefined {
    return this.services[providerKey];
  }

  public async initializeModelCache(
    provider?: AIProviderKey,
    force: boolean = false
  ): Promise<void> {
    if (force || !this.modelCacheInitialized) {
      try {
        if (provider && provider !== "all") {
          const providerInstance = this.services[provider];
          if (providerInstance) {
            await providerInstance.getModels().catch(() => []);
          }
        } else {
          await Promise.all(
            Object.values(this.services).map((provider) =>
              provider?.getModels().catch(() => [])
            )
          );
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
    modelId: string
  ): Promise<string> {
    const provider = await this.getProviderForModel(modelId);
    return provider.createChatCompletion(systemPrompt, userMessage, modelId);
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    onData: (chunk: string) => void,
    abortSignal: AbortSignal
  ): Promise<void> {
    const provider = await this.getProviderForModel(modelId);
    return provider.createStreamingChatCompletionWithCallback(
      systemPrompt,
      userMessage,
      modelId,
      onData,
      abortSignal
    );
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const provider = await this.getProviderForModel(modelId);
    return provider.createStreamingConversationWithCallback(
      systemPrompt,
      messages,
      modelId,
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

  async reinitializeProvider(provider: string, value: string): Promise<void> {
    if (this.services[provider]) {
      this.services[provider].updateApiKey(value);
      this.services[provider].clearModelCache();
      // Reinitialize model cache for this provider only
      await this.services[provider].initializeModelCache();
    }
  }

  updateApiKey(apiKey: string): void {
    // This is a no-op since we handle API keys per provider
  }
}
