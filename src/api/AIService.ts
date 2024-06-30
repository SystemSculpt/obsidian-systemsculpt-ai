import { LocalAIService } from './LocalAIService';
import { OpenAIService } from './OpenAIService';
import { GroqService } from './GroqService';
import { Model } from './Model';
import { OpenRouterService } from './OpenRouterService';

export class AIService {
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
    this.localAIService = new LocalAIService(
      {
        temperature: settings.temperature,
      },
      settings.localEndpoint
    );
    this.openAIService = new OpenAIService(openAIApiKey, settings.apiEndpoint);
    this.openAIService.updateSettings({ temperature: settings.temperature });
    this.groqService = new GroqService(groqAPIKey, {
      temperature: settings.temperature,
    });
    this.openRouterService = new OpenRouterService(openRouterAPIKey, {
      temperature: settings.temperature,
    });
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
    }
  ): AIService {
    if (!AIService.instance) {
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
    this.localAIService = new LocalAIService(
      {
        temperature: this.settings.temperature,
      },
      this.settings.localEndpoint
    );
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number
  ): Promise<string> {
    const temperature = this.settings.temperature || 0.5;
    const model = await this.getModelById(modelId);
    console.log('model found: ', model);
    if (model?.isLocal) {
      console.log('model is local');
      return await this.localAIService.createChatCompletion(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens
      );
    } else if (model?.provider === 'openai') {
      console.log('model is openai');
      return await this.openAIService.createChatCompletion(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens,
        temperature
      );
    } else if (model?.provider === 'groq') {
      console.log('model is groq');
      return await this.groqService.createChatCompletion(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens
      );
    } else if (model?.provider === 'openRouter') {
      console.log('model is openRouter');
      return await this.openRouterService.createChatCompletion(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens
      );
    } else {
      throw new Error(`Unsupported model provider: ${model?.provider}`);
    }
  }
  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const temperature = this.settings.temperature || 0.5;
    const model = await this.getModelById(modelId);
    console.log('model found: ', model);
    if (model?.isLocal) {
      console.log('model is local');
      await this.localAIService.createStreamingChatCompletionWithCallback(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens,
        callback,
        abortSignal
      );
    } else if (model?.provider === 'openai') {
      console.log('model is openai');
      await this.openAIService.createStreamingChatCompletionWithCallback(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens,
        callback,
        abortSignal,
        temperature
      );
    } else if (model?.provider === 'groq') {
      console.log('model is groq');
      await this.groqService.createStreamingChatCompletionWithCallback(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens,
        callback,
        abortSignal
      );
    } else if (model?.provider === 'openRouter') {
      console.log('model is openRouter');
      await this.openRouterService.createStreamingChatCompletionWithCallback(
        systemPrompt,
        userMessage,
        modelId,
        maxTokens,
        callback,
        abortSignal
      );
    } else {
      throw new Error(`Unsupported model provider: ${model?.provider}`);
    }
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const temperature = this.settings.temperature || 0.5;
    const model = await this.getModelById(modelId);
    console.log('model found: ', model);
    if (model?.isLocal) {
      console.log('model is local');
      await this.localAIService.createStreamingConversationWithCallback(
        systemPrompt,
        messages,
        modelId,
        maxTokens,
        callback,
        abortSignal
      );
    } else if (model?.provider === 'openai') {
      console.log('model is openai');
      await this.openAIService.createStreamingConversationWithCallback(
        systemPrompt,
        messages,
        modelId,
        maxTokens,
        callback,
        abortSignal,
        temperature
      );
    } else if (model?.provider === 'groq') {
      console.log('model is groq');
      await this.groqService.createStreamingConversationWithCallback(
        systemPrompt,
        messages,
        modelId,
        maxTokens,
        callback,
        abortSignal
      );
    } else if (model?.provider === 'openRouter') {
      console.log('model is openRouter');
      await this.openRouterService.createStreamingConversationWithCallback(
        systemPrompt,
        messages,
        modelId,
        maxTokens,
        callback,
        abortSignal
      );
    } else {
      throw new Error(`Unsupported model provider: ${model?.provider}`);
    }
  }

  async getModels(
    includeOpenAI: boolean = true,
    includeGroq: boolean = true,
    includeLocal: boolean = true,
    includeOpenRouter: boolean = true
  ): Promise<Model[]> {
    const models: Model[] = [];

    if (includeOpenAI && this.settings.openAIApiKey) {
      try {
        const openAIModels = await this.openAIService.getModels();
        models.push(...openAIModels);
      } catch (error) {
        console.error('Error fetching OpenAI models:', error);
      }
    }

    if (includeGroq && this.settings.groqAPIKey) {
      try {
        const groqModels = await this.groqService.getModels();
        models.push(...groqModels);
      } catch (error) {
        console.error('Error fetching Groq models:', error);
      }
    }

    if (includeLocal && this.settings.localEndpoint) {
      try {
        const localModels = await this.localAIService.getModels();
        models.push(...localModels);
      } catch (error) {
        console.error('Error fetching local models:', error);
      }
    }

    if (includeOpenRouter && this.settings.openRouterAPIKey) {
      try {
        const openRouterModels = await this.openRouterService.getModels();
        models.push(...openRouterModels);
      } catch (error) {
        console.error('Error fetching OpenRouter models:', error);
      }
    }

    return models;
  }

  async getModelById(modelId: string): Promise<Model | undefined> {
    const models = await this.getModels(true, true, true, true);
    return models.find(model => model.id === modelId);
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
        console.warn('Local endpoint is using an unsafe port (< 1024)');
        return false;
      }
      return await LocalAIService.validateEndpoint(endpoint);
    } catch (error) {
      console.error('Error validating local endpoint:', error);
      return false;
    }
  }

  static async validateOpenRouterApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;
    return OpenRouterService.validateApiKey(apiKey);
  }
}
