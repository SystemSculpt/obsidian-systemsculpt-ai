import { App } from "obsidian";
import { CustomProvider } from "src/types/llm";
import SystemSculptPlugin from "src/main";
import { ProviderAdapterFactory } from "./providers/adapters/ProviderAdapterFactory";
import { ProviderModel } from "./providers/adapters/BaseProviderAdapter";
import { isMiniMaxEndpoint, MINIMAX_FALLBACK_MODEL_IDS } from "../constants/minimax";

interface TestConnectionResult {
  success: boolean;
  error?: string;
  models?: (ProviderModel | string)[];
  timestamp: number;
}

interface TestConnectionOptions {
  force?: boolean;
  reason?: string;
}

// Deprecated: use ProviderModel from adapters instead
interface OpenRouterModel {
  id: string;
  pricing: {
    prompt: string;
    completion: string;
  };
}

export class CustomProviderService {
  private static readonly HEALTHY_PERSISTENCE_MS = 6 * 60 * 60 * 1000; // 6 hours
  private static readonly MAX_CONCURRENT_TESTS = 1;
  private static activeConnectionTests = 0;
  private static pendingTestQueue: Array<() => void> = [];
  private app: App;
  private plugin: SystemSculptPlugin;
  private logger: Console;
  // Isolated static caches by provider type to prevent cross-contamination
  private static customProviderConnectionCache: Map<
    string,
    {
      result: TestConnectionResult;
      timestamp: number;
    }
  > = new Map();
  private static customProviderTestPromises: Map<
    string,
    Promise<TestConnectionResult>
  > = new Map();
  private readonly CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
  private readonly idleTimeoutMs = 250;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.logger = console;
  }

  // Add method to clear custom provider cache only
  public clearCache(): void {
    CustomProviderService.customProviderConnectionCache.clear();
    CustomProviderService.customProviderTestPromises.clear();
  }

  /**
   * Clear static caches for custom providers only
   * This should be called when the plugin is unloaded
   */
  public static clearStaticCaches(): void {
    CustomProviderService.customProviderConnectionCache.clear();
    CustomProviderService.customProviderTestPromises.clear();
  }

  /**
   * Test connection to a provider by attempting to fetch available models
   * For OpenRouter, we also validate the API key by making a minimal completion request
   */
  async testConnection(
    provider: CustomProvider,
    options: TestConnectionOptions = {}
  ): Promise<TestConnectionResult> {
    const cacheKey = this.getProviderCacheKey(provider);
    const signature = this.computeProviderSignature(provider);

    if (options.force) {
      CustomProviderService.customProviderConnectionCache.delete(cacheKey);
    }

    const persisted = this.getPersistedHealthyResult(provider, signature, options);
    if (persisted) {
      return persisted;
    }

    // Check custom provider cache first
    if (!options.force) {
      const cached = CustomProviderService.customProviderConnectionCache.get(cacheKey);
      if (cached && Date.now() - cached.result.timestamp < this.CACHE_DURATION) {
        return cached.result;
      }
    }

    // Check if already testing this custom provider
    const existingPromise = CustomProviderService.customProviderTestPromises.get(
      cacheKey
    );
    if (existingPromise) {
      return existingPromise;
    }

    // Start new test for custom provider
    const testPromise = this.enqueueDeferredTest(() => this.performConnectionTest(provider));
    CustomProviderService.customProviderTestPromises.set(cacheKey, testPromise);

    try {
      const result = await testPromise;
      // Cache successful custom provider results
      if (result.success) {
        CustomProviderService.customProviderConnectionCache.set(cacheKey, {
          result,
          timestamp: Date.now(),
        });
        await this.persistProviderHealth(provider, signature, result.models);
      } else if (!result.success) {
        await this.clearPersistedHealth(provider.id);
      }
      return result;
    } finally {
      CustomProviderService.customProviderTestPromises.delete(cacheKey);
    }
  }

  /**
   * Internal method to actually perform the connection test
   */
  private async performConnectionTest(
    provider: CustomProvider
  ): Promise<TestConnectionResult> {
    try {
      const adapter = ProviderAdapterFactory.createAdapter(provider, this.plugin);
      const endpoint = provider.endpoint || '';

      // Get available models (keep full metadata, including contextWindow). Avoid double-hitting the endpoint.
      const models = await adapter.getModels();

      // High-signal debug: summarize result without spamming
      try {
        const { errorLogger } = await import('../utils/errorLogger');
        errorLogger.debug('Custom provider connection test', {
          source: 'CustomProviderService',
          method: 'performConnectionTest',
          metadata: { providerId: provider.id, endpoint, models: models.length }
        });
      } catch {}

      // For OpenRouter, explicitly validate API key path as it uses a different check
      if (endpoint.includes('openrouter.ai')) {
        await adapter.validateApiKey();
      }

      // Consider localhost with zero models as a connection failure (common setup case)
      if (endpoint.includes('localhost') && models.length === 0) {
        return {
          success: false,
          error: `Cannot reach local provider at ${endpoint}. Is the server running?`,
          timestamp: Date.now(),
        };
      }

      return {
        success: true,
        models, // Preserve full ProviderModel objects
        timestamp: Date.now(),
      };
    } catch (error) {
      try {
        const { errorLogger } = await import('../utils/errorLogger');
        errorLogger.debug('Custom provider test failed', {
          source: 'CustomProviderService',
          method: 'performConnectionTest',
          metadata: { providerId: provider.id, endpoint: provider.endpoint }
        });
      } catch {}

      return {
        success: false,
        error: this.getErrorMessage(error),
        timestamp: Date.now(),
      };
    }
  }

  private getPersistedHealthyResult(
    provider: CustomProvider,
    signature: string,
    options: TestConnectionOptions
  ): TestConnectionResult | null {
    if (options.force) {
      return null;
    }
    const stored = this.findProviderRecord(provider.id);
    if (!stored || !stored.lastHealthyAt || stored.lastHealthyConfigHash !== signature) {
      return null;
    }
    const withinWindow =
      Date.now() - stored.lastHealthyAt < CustomProviderService.HEALTHY_PERSISTENCE_MS;
    if (!withinWindow) {
      return null;
    }
    const cachedModels = (stored.cachedModels ?? []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    );
    const mergedModels = this.mergeMiniMaxFallback(provider, cachedModels);
    return {
      success: true,
      models: mergedModels,
      timestamp: stored.lastHealthyAt,
    };
  }

  private computeProviderSignature(provider: CustomProvider): string {
    const endpoint = (provider.endpoint || "").trim().toLowerCase();
    const apiKey = (provider.apiKey || "").trim();
    return `${provider.id}::${endpoint}::${apiKey}`;
  }

  private findProviderRecord(providerId: string): CustomProvider | undefined {
    const settings = this.plugin.getSettingsManager().getSettings();
    return settings.customProviders.find((p) => p.id === providerId);
  }

  private async persistProviderHealth(
    provider: CustomProvider,
    signature: string,
    models?: (ProviderModel | string)[]
  ): Promise<void> {
    try {
      const settingsManager = this.plugin.getSettingsManager();
      const currentSettings = settingsManager.getSettings();
      const providers = [...(currentSettings.customProviders || [])];
      const index = providers.findIndex((p) => p.id === provider.id);
      if (index === -1) {
        return;
      }

      const normalizedModels = this.normalizeModelsForCache(models);
      providers[index] = {
        ...providers[index],
        cachedModels: normalizedModels,
        lastHealthyAt: Date.now(),
        lastHealthyConfigHash: signature,
        lastTested: Date.now(),
        failureCount: 0,
        lastFailureTime: undefined,
      };

      await settingsManager.updateSettings({ customProviders: providers });
    } catch (error) {
      this.logger.warn("Failed to persist custom provider health metadata", error);
    }
  }

  private async clearPersistedHealth(providerId: string): Promise<void> {
    try {
      const settingsManager = this.plugin.getSettingsManager();
      const currentSettings = settingsManager.getSettings();
      const providers = [...(currentSettings.customProviders || [])];
      const index = providers.findIndex((p) => p.id === providerId);
      if (index === -1) {
        return;
      }

      if (
        providers[index].lastHealthyAt === undefined &&
        providers[index].lastHealthyConfigHash === undefined
      ) {
        return;
      }

      const { cachedModels, lastHealthyAt, lastHealthyConfigHash, ...rest } = providers[index];
      providers[index] = {
        ...rest,
        cachedModels: undefined,
        lastHealthyAt: undefined,
        lastHealthyConfigHash: undefined,
      } as CustomProvider;

      await settingsManager.updateSettings({ customProviders: providers });
    } catch (error) {
      this.logger.warn("Failed to clear persisted provider health metadata", error);
    }
  }

  private normalizeModelsForCache(models?: (ProviderModel | string)[]): string[] {
    if (!models) {
      return [];
    }
    return models
      .map((model) => (typeof model === "string" ? model : model.id))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  private mergeMiniMaxFallback(provider: CustomProvider, cachedModels: string[]): string[] {
    if (!isMiniMaxEndpoint(provider.endpoint)) {
      return cachedModels;
    }
    const seen = new Set(cachedModels);
    const merged = [...cachedModels];
    for (const modelId of MINIMAX_FALLBACK_MODEL_IDS) {
      if (!seen.has(modelId)) {
        seen.add(modelId);
        merged.push(modelId);
      }
    }
    return merged;
  }

  private enqueueDeferredTest<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        CustomProviderService.activeConnectionTests += 1;
        this.runOffMainThread(work)
          .then(resolve)
          .catch(reject)
          .finally(() => {
            CustomProviderService.activeConnectionTests = Math.max(
              0,
              CustomProviderService.activeConnectionTests - 1
            );
            CustomProviderService.drainTestQueue();
          });
      };

      CustomProviderService.pendingTestQueue.push(execute);
      CustomProviderService.drainTestQueue();
    });
  }

  private static drainTestQueue(): void {
    if (this.activeConnectionTests >= this.MAX_CONCURRENT_TESTS) {
      return;
    }
    const next = this.pendingTestQueue.shift();
    if (!next) {
      return;
    }
    next();
  }

  private runOffMainThread<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const runner = () => {
        work().then(resolve).catch(reject);
      };

      const idle =
        typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function"
          ? (window as any).requestIdleCallback
          : null;

      if (idle) {
        idle(() => runner(), { timeout: this.idleTimeoutMs });
      } else if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
        window.setTimeout(runner, 0);
      } else {
        setTimeout(runner, 0);
      }
    });
  }

  /**
   * Get a provider adapter for the given custom provider
   */
  public getProviderAdapter(provider: CustomProvider) {
    return ProviderAdapterFactory.createAdapter(provider, this.plugin);
  }

  /**
   * Get a user-friendly error message from an error object
   */
  private getErrorMessage(error: any): string {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return "Connection timed out. Please check your internet connection and try again.";
      }

      // Return the error message directly since we've already made it user-friendly
      // in validateOpenRouterKey and getModels methods
      return error.message;
    }

    return "An unexpected error occurred. Please try again or contact support if the issue persists.";
  }

  private getProviderCacheKey(provider: CustomProvider): string {
    const endpoint = (provider.endpoint || '').toLowerCase();
    const apiKey = provider.apiKey || '';
    return `${endpoint}::${apiKey}`;
  }
}
