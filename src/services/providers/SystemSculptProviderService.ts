import { SystemSculptModel } from "../../types/llm";
import { BaseProviderService } from "./BaseProviderService";
import { filterChatModels } from "../../utils/modelUtils";
import { AGENT_CONFIG } from "../../constants/agent";
import { ProviderErrorManager } from "./ProviderErrorManager";
import SystemSculptPlugin from "../../main";

/**
 * Service for managing SystemSculpt provider models
 * Completely isolated from custom provider logic
 */
export class SystemSculptProviderService extends BaseProviderService {
  private static instance: SystemSculptProviderService | null = null;
  private modelDetailsCache = new Map<string, SystemSculptModel>();
  private errorManager: ProviderErrorManager;

  private constructor(plugin: SystemSculptPlugin) {
    super(plugin);
    this.errorManager = new ProviderErrorManager(plugin, plugin.app);
  }

  public static getInstance(plugin: SystemSculptPlugin): SystemSculptProviderService {
    if (!this.instance) {
      this.instance = new SystemSculptProviderService(plugin);
    }
    return this.instance;
  }

  public static clearInstance(): void {
    if (this.instance) {
      this.instance.clearCache();
      this.instance.modelDetailsCache.clear();
      this.instance = null;
    }
  }

  public getProviderType(): string {
    return "systemsculpt";
  }

  /**
   * Test connection to SystemSculpt services
   */
  public async testConnection(): Promise<boolean> {
    try {
      // Skip if SystemSculpt provider is disabled
      if (!this.plugin.settings.enableSystemSculptProvider) {
        return false;
      }

      const models = await this.getModels();
      return models.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get SystemSculpt models with isolated caching
   */
  public async getModels(): Promise<SystemSculptModel[]> {
    // Return empty array if SystemSculpt provider is disabled
    if (!this.plugin.settings.enableSystemSculptProvider) {
      return [];
    }

    // Check cache first
    const cachedModels = this.getCachedModels();
    if (cachedModels) {
      return cachedModels;
    }

    // Return existing loading promise if one is in progress
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this.loadSystemSculptModels()
      .then(models => {
        // Update the model details cache
        models.forEach(model => {
          this.modelDetailsCache.set(model.id, model);
        });

        this.cacheModels(models);
        this.loadingPromise = null;
        
        // Emit namespaced event for SystemSculpt models update
        this.plugin.emitter.emitWithProvider('modelsUpdated', 'systemsculpt', models);
        
        return models;
      })
      .catch(error => {
        this.loadingPromise = null;
        // Return empty array instead of throwing to prevent cascade failures
        return [];
      });

    return this.loadingPromise;
  }

  /**
   * Load models from SystemSculpt API
   */
  private async loadSystemSculptModels(): Promise<SystemSculptModel[]> {
    try {
      const systemModels = await this.loadWithRetry(
        () => this.plugin.aiService.getModels(),
        3, // max retries
        1000 // delay between retries
      );

      return systemModels;
    } catch (error) {
      // Report the error using provider-specific error handling
      this.errorManager.reportSystemSculptError({
        providerId: 'systemsculpt-api',
        errorCode: 'MODEL_LOAD_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error loading models',
        licenseRelated: error.message?.includes('license') || error.message?.includes('unauthorized'),
        apiEndpoint: 'models',
        context: {
          licenseValid: this.plugin.settings.licenseValid,
          hasLicenseKey: !!this.plugin.settings.licenseKey
        }
      });

      return [];
    }
  }

  /**
   * Load with retry logic
   */
  private async loadWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number,
    delay: number
  ): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error("Operation timeout")), 5000)
          )
        ]);
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error("Max retries exceeded");
  }

  /**
   * Find the best SystemSculpt alternative model
   */
  public findBestAlternativeModel(unavailableModelId: string): SystemSculptModel | undefined {
    if (!this.models || this.models.length === 0) {
      return undefined;
    }

    try {
      // Filter out embedding models and the unavailable model
      const chatModels = filterChatModels(this.models).filter(m => m.id !== unavailableModelId);

      if (chatModels.length === 0) {
        return undefined;
      }

      // Do not prefer a specific agent model by license; return first available chat model

      // Return the first available chat model
      return chatModels[0];
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Get cached model by ID
   */
  public getCachedModelById(modelId: string): SystemSculptModel | undefined {
    return this.modelDetailsCache.get(modelId);
  }

  /**
   * Get provider health status
   */
  public getProviderHealth(): {
    status: 'healthy' | 'warning' | 'error';
    recentErrorCount: number;
    lastErrorTime?: number;
  } {
    return this.errorManager.getProviderHealth('systemsculpt-api', 'systemsculpt');
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    super.clearCache();
    this.modelDetailsCache.clear();
  }
}