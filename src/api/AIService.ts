import { LocalAIService } from './LocalAIService';
import { OpenAIService } from './OpenAIService';
import { GroqService } from './GroqService';
import { Model } from './Model';

export class AIService {
  private static instance: AIService;
  private settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    apiEndpoint: string;
    localEndpoint?: string;
  };
  private localAIService: LocalAIService;
  private openAIService: OpenAIService;
  private groqService: GroqService;

  private constructor(
    openAIApiKey: string,
    groqAPIKey: string,
    settings: {
      openAIApiKey: string;
      groqAPIKey: string;
      apiEndpoint: string;
      localEndpoint?: string;
    }
  ) {
    this.settings = settings;
    this.localAIService = new LocalAIService(settings.localEndpoint);
    this.openAIService = new OpenAIService(openAIApiKey, settings.apiEndpoint);
    this.groqService = new GroqService(groqAPIKey);
  }

  public static getInstance(
    openAIApiKey: string,
    groqAPIKey: string,
    settings: {
      openAIApiKey: string;
      groqAPIKey: string;
      apiEndpoint: string;
      localEndpoint?: string;
    }
  ): AIService {
    if (!AIService.instance) {
      AIService.instance = new AIService(openAIApiKey, groqAPIKey, settings);
    } else {
      AIService.instance.openAIService.updateApiKey(openAIApiKey);
      AIService.instance.groqService.updateApiKey(groqAPIKey);
      AIService.instance.settings = settings;
    }
    return AIService.instance;
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number
  ): Promise<string> {
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
        maxTokens
      );
    } else if (model?.provider === 'groq') {
      console.log('model is groq');
      return await this.groqService.createChatCompletion(
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
        abortSignal
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
        abortSignal
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
    } else {
      throw new Error(`Unsupported model provider: ${model?.provider}`);
    }
  }

  async getModels(
    includeOpenAI: boolean = true,
    includeGroq: boolean = true
  ): Promise<Model[]> {
    const models: Model[] = [];

    if (this.settings.localEndpoint) {
      const localModels = await this.localAIService.getModels();
      models.push(...localModels);
    }

    if (includeOpenAI && this.settings.openAIApiKey) {
      const openAIModels = await this.openAIService.getModels();
      models.push(...openAIModels);
    }

    if (includeGroq && this.settings.groqAPIKey) {
      const groqModels = await this.groqService.getModels();
      models.push(...groqModels);
    }

    return models;
  }

  async getModelById(modelId: string): Promise<Model | undefined> {
    const models = await this.getModels(true, true);
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
    return LocalAIService.validateEndpoint(endpoint);
  }
}
