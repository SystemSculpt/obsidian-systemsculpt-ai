import { UnifiedAIService } from "./UnifiedAIService";
import { Model, AIProvider } from "./Model";
import { debounce } from "obsidian";

export class AIService {
  private static instance: AIService;
  private services: { [key in AIProvider]: UnifiedAIService };
  private cachedModels: { [key: string]: Model[] } = {};
  private settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    openRouterAPIKey: string;
    apiEndpoint: string;
    localEndpoint?: string;
    temperature: number;
    showopenAISetting: boolean;
    showgroqSetting: boolean;
    showlocalEndpointSetting: boolean;
    showopenRouterSetting: boolean;
  };

  private constructor(settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    openRouterAPIKey: string;
    apiEndpoint: string;
    localEndpoint?: string;
    temperature: number;
    showopenAISetting: boolean;
    showgroqSetting: boolean;
    showlocalEndpointSetting: boolean;
    showopenRouterSetting: boolean;
  }) {
    this.settings = settings;
    this.services = {
      openai: new UnifiedAIService(
        settings.openAIApiKey,
        "https://api.openai.com/v1",
        "openai",
        { temperature: settings.temperature }
      ),
      groq: new UnifiedAIService(
        settings.groqAPIKey,
        "https://api.groq.com/openai/v1",
        "groq",
        { temperature: settings.temperature }
      ),
      local: new UnifiedAIService("", settings.localEndpoint || "", "local", {
        temperature: settings.temperature,
      }),
      openRouter: new UnifiedAIService(
        settings.openRouterAPIKey,
        "https://openrouter.ai/api/v1",
        "openRouter",
        { temperature: settings.temperature }
      ),
    };
  }

  public static async getInstance(
    settings: {
      openAIApiKey: string;
      groqAPIKey: string;
      openRouterAPIKey: string;
      apiEndpoint: string;
      localEndpoint?: string;
      temperature: number;
      showopenAISetting: boolean;
      showgroqSetting: boolean;
      showlocalEndpointSetting: boolean;
      showopenRouterSetting: boolean;
    },
    forceNewInstance: boolean = false
  ): Promise<AIService> {
    try {
      if (!AIService.instance || forceNewInstance) {
        AIService.instance = new AIService(settings);
        await AIService.instance.initializeModelCache();
      } else {
        AIService.instance.updateSettings(settings);
      }
      return AIService.instance;
    } catch (error) {
      throw error;
    }
  }

  public async ensureModelCacheInitialized(): Promise<void> {
    if (Object.keys(this.cachedModels).length === 0) {
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
    this.updateApiKeysDebounced(settings);
  }

  private updateApiKeysDebounced = debounce(
    this.updateApiKeys.bind(this),
    1000,
    true
  );

  private updateApiKeys(settings: {
    openAIApiKey: string;
    groqAPIKey: string;
    openRouterAPIKey: string;
    apiEndpoint: string;
    localEndpoint?: string;
    temperature: number;
  }) {
    this.services.openai.updateApiKey(settings.openAIApiKey);
    this.services.groq.updateApiKey(settings.groqAPIKey);
    this.services.openRouter.updateApiKey(settings.openRouterAPIKey);
    Object.values(this.services).forEach((service) =>
      service.updateSettings({ temperature: settings.temperature })
    );
  }

  clearModelCache() {
    this.cachedModels = {};
    this.initializeModelCache();
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    await this.ensureModelCacheInitialized();
    const model = await this.getModelById(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }
    return this.services[model.provider].createChatCompletion(
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
    await this.ensureModelCacheInitialized();
    const model = await this.getModelById(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }
    return this.services[
      model.provider
    ].createStreamingChatCompletionWithCallback(
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
    await this.ensureModelCacheInitialized();
    const model = await this.getModelById(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }
    return this.services[
      model.provider
    ].createStreamingConversationWithCallback(
      systemPrompt,
      messages,
      modelId,
      maxOutputTokens,
      callback,
      abortSignal
    );
  }

  async getModels(
    showOpenAI: boolean,
    showGroq: boolean,
    showLocal: boolean,
    showOpenRouter: boolean
  ): Promise<Model[]> {
    await this.ensureModelCacheInitialized();

    let allModels: Model[] = [];

    if (showOpenAI)
      allModels = allModels.concat(this.cachedModels["openai"] || []);
    if (showGroq) allModels = allModels.concat(this.cachedModels["groq"] || []);
    if (showLocal)
      allModels = allModels.concat(this.cachedModels["local"] || []);
    if (showOpenRouter)
      allModels = allModels.concat(this.cachedModels["openRouter"] || []);

    return allModels;
  }

  async getModelById(modelId: string): Promise<Model | undefined> {
    for (const models of Object.values(this.cachedModels)) {
      const model = models.find((m) => m.id === modelId);
      if (model) {
        return model;
      }
    }
    return undefined;
  }

  static async validateOpenAIApiKey(
    apiKey: string,
    baseOpenAIApiUrl?: string
  ): Promise<boolean> {
    return UnifiedAIService.validateApiKey(
      apiKey,
      baseOpenAIApiUrl ?? "https://api.openai.com/v1",
      "openai"
    );
  }

  static async validateGroqAPIKey(apiKey: string): Promise<boolean> {
    return UnifiedAIService.validateApiKey(
      apiKey,
      "https://api.groq.com/openai/v1",
      "groq"
    );
  }

  static async validateLocalEndpoint(endpoint: string): Promise<boolean> {
    if (!endpoint) return false;
    try {
      const url = new URL(endpoint);
      if (url.port && parseInt(url.port) < 1024) {
        return false;
      }
      return UnifiedAIService.validateApiKey("", endpoint, "local");
    } catch (error: unknown) {
      return false;
    }
  }

  static async validateOpenRouterApiKey(apiKey: string): Promise<boolean> {
    return UnifiedAIService.validateApiKey(
      apiKey,
      "https://openrouter.ai/api/v1",
      "openRouter"
    );
  }

  public async initializeModelCache(): Promise<void> {
    if (Object.keys(this.cachedModels).length > 0) {
      return;
    }

    const providers: AIProvider[] = ["local", "openai", "groq", "openRouter"];
    const fetchPromises: Promise<void>[] = [];

    for (const provider of providers) {
      fetchPromises.push(this.fetchModelsForProvider(provider));
    }

    await Promise.all(fetchPromises);
  }

  private async fetchModelsForProvider(provider: AIProvider): Promise<void> {
    try {
      const isEnabled = this.isProviderEnabled(provider);
      const hasValidApiKey = this.services[provider].hasValidApiKey();
      const hasValidEndpoint = this.hasValidEndpoint(provider);

      if (!isEnabled || !hasValidApiKey || !hasValidEndpoint) {
        this.cachedModels[provider] = [];
        return;
      }

      console.log(`Fetching models for provider: ${provider}`);

      const models = await Promise.race([
        this.services[provider].getModels(),
        new Promise<Model[]>(
          (_, reject) => setTimeout(() => reject(new Error("Timeout")), 30000) // Increased timeout to 30 seconds
        ),
      ]);

      console.log(`Successfully fetched models for provider: ${provider}`);
      this.cachedModels[provider] = models;
    } catch (error: unknown) {
      console.error(`Error fetching models for provider ${provider}:`, error);
      this.cachedModels[provider] = [];
    }
  }

  private isProviderEnabled(provider: AIProvider): boolean {
    switch (provider) {
      case "openai":
        return this.settings.showopenAISetting;
      case "groq":
        return this.settings.showgroqSetting;
      case "openRouter":
        return this.settings.showopenRouterSetting;
      case "local":
        return this.settings.showlocalEndpointSetting;
      default:
        return false;
    }
  }

  private hasValidEndpoint(provider: AIProvider): boolean {
    switch (provider) {
      case "openai":
        return !!this.settings.apiEndpoint.trim();
      case "groq":
        return true;
      case "openRouter":
        return true;
      case "local":
        return !!this.settings.localEndpoint?.trim();
      default:
        return false;
    }
  }
}
