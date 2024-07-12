import { LocalAIService } from './LocalAIService';
import { OpenAIService } from './OpenAIService';
import { GroqService } from './GroqService';
import { OpenRouterService } from './OpenRouterService';
import { Model, AIProvider } from './Model';
import { AIServiceInterface } from './AIServiceInterface';
import { logger } from '../utils/logger';

export class AIService {
  private services: Map<AIProvider, AIServiceInterface>;
  private static instance: AIService;
  private settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    openRouterAPIKey: string;
    apiEndpoint: string;
    localEndpoint?: string;
    temperature: number;
  };
  private localAIService: LocalAIService;
  private openAIService: OpenAIService;
  private groqService: GroqService;
  private openRouterService: OpenRouterService;
  private cachedModels: Map<AIProvider, Model[]> = new Map();

  private constructor(
    openAIApiKey: string,
    groqAPIKey: string,
    openRouterAPIKey: string,
    settings: {
      openAIApiKey: string;
      groqAPIKey: string;
      openRouterAPIKey: string;
      apiEndpoint: string;
      localEndpoint?: string;
      temperature: number;
    }
  ) {
    this.settings = settings;
    this.services = new Map<AIProvider, AIServiceInterface>([
      ['local', new LocalAIService({ temperature: settings.temperature }, settings.localEndpoint)],
      ['openai', new OpenAIService(openAIApiKey, settings.apiEndpoint)],
      ['groq', new GroqService(groqAPIKey, { temperature: settings.temperature })],
      ['openRouter', new OpenRouterService(openRouterAPIKey, { temperature: settings.temperature })]
    ]);

    this.services.forEach(service => service.updateSettings({ temperature: settings.temperature }));
  }

  public async initializeModelCache(): Promise<void> {
    if (this.cachedModels.size > 0) return;

    const providers: AIProvider[] = ['local', 'openai', 'groq', 'openRouter'];

    await Promise.all(providers.map(async provider => {
      const service = this.services.get(provider);
      if (service) {
        try {
          this.cachedModels.set(provider, await service.getModels());
        } catch (error) {
          logger.error(`Error fetching ${provider} models:`, error);
          this.cachedModels.set(provider, []);
        }
      }
    }));
  }

  public static getInstance(
    openAIApiKey: string,
    groqAPIKey: string,
    openRouterAPIKey: string,
    settings: {
      openAIApiKey: string;
      groqAPIKey: string;
      openRouterAPIKey: string;
      apiEndpoint: string;
      localEndpoint?: string;
      temperature: number;
    },
    forceReinitialization: boolean = false
  ): AIService {
    if (!AIService.instance || forceReinitialization) {
      AIService.instance = new AIService(
        openAIApiKey,
        groqAPIKey,
        openRouterAPIKey,
        settings
      );
    } else {
      AIService.instance.updateSettings(settings);
    }
    return AIService.instance;
  }

  public async ensureModelCacheInitialized(): Promise<void> {
    if (this.cachedModels.size === 0) {
      await this.initializeModelCache();
    }
  }

  private updateSettings(settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    openRouterAPIKey: string;
    apiEndpoint: string;
    localEndpoint?: string;
    temperature: number;
  }) {
    this.settings = settings;
    if (this.openAIService) {
      this.openAIService.updateSettings({ temperature: settings.temperature });
    }
    if (this.groqService) {
      this.groqService.updateSettings({ temperature: settings.temperature });
    }
    if (this.localAIService) {
      this.localAIService.updateSettings({ temperature: settings.temperature });
    }
    if (this.openRouterService) {
      this.openRouterService.updateSettings({
        temperature: settings.temperature,
      });
    }
  }

  clearModelCache() {
    this.cachedModels.clear();
    this.initializeModelCache();
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number
  ): Promise<string> {
    const model = await this.getModelById(modelId);
    return this.executeModelOperation(
      model,
      'createChatCompletion',
      systemPrompt,
      userMessage,
      modelId,
      maxTokens
    );
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const model = await this.getModelById(modelId);
    return this.executeModelOperation(
      model,
      'createStreamingChatCompletionWithCallback',
      systemPrompt,
      userMessage,
      modelId,
      maxTokens,
      callback,
      abortSignal
    );
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const model = await this.getModelById(modelId);
    return this.executeModelOperation(
      model,
      'createStreamingConversationWithCallback',
      systemPrompt,
      messages,
      modelId,
      maxTokens,
      callback,
      abortSignal
    );
  }

  private async executeModelOperation(
    model: Model | undefined,
    operation: string,
    ...args: any[]
  ): Promise<any> {
    if (!model) {
      throw new Error(`Model not found: ${args[2]}`);
    }
    logger.log('model found: ', model);
    const service = this.services.get(model.provider);
    if (!service) {
      throw new Error(`Unsupported model provider: ${model.provider}`);
    }
    return service[operation](...args);
  }

  async getModels(
    includeOpenAI: boolean,
    includeGroq: boolean,
    includeLocal: boolean,
    includeOpenRouter: boolean
  ): Promise<Model[]> {
    const providers: AIProvider[] = ['openai', 'groq', 'local', 'openRouter']
      .filter((_, index) => [includeOpenAI, includeGroq, includeLocal, includeOpenRouter][index]) as AIProvider[];

    return providers.flatMap(provider => this.cachedModels.get(provider) || []);
  }

  async getModelById(modelId: string): Promise<Model | undefined> {
    for (const models of this.cachedModels.values()) {
      const model = models.find(m => m.id === modelId);
      if (model) {
        return model;
      }
    }
    return undefined;
  }

  static async validateOpenAIApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;
    return OpenAIService.validateApiKey(apiKey);
  }

  static async validateGroqAPIKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;
    return GroqService.validateApiKey(apiKey);
  }

  static async validateLocalEndpoint(endpoint: string): Promise<boolean> {
    if (!endpoint) return false;
    try {
      const url = new URL(endpoint);
      if (url.port && parseInt(url.port) < 1024) {
        logger.warn('Local endpoint is using an unsafe port (< 1024)');
        return false;
      }
      return await LocalAIService.validateEndpoint(endpoint);
    } catch (error) {
      logger.error('Error validating local endpoint:', error);
      return false;
    }
  }

  static async validateOpenRouterApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;
    return OpenRouterService.validateApiKey(apiKey);
  }
}
