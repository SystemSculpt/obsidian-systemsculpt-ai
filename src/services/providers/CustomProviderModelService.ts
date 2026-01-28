import { SystemSculptModel, CustomProvider } from "../../types/llm";
import { BaseProviderService } from "./BaseProviderService";
import { createCanonicalId, getCanonicalId, filterChatModels } from "../../utils/modelUtils";
import { CustomProviderService } from "../CustomProviderService";
import { ProviderErrorManager } from "./ProviderErrorManager";
import SystemSculptPlugin from "../../main";
import { isAnthropicEndpoint, ANTHROPIC_MODELS } from "../../constants/anthropic";
import { ProviderModel } from "./adapters/BaseProviderAdapter";
import { getFunctionProfiler } from "../FunctionProfiler";
import { isAuthFailureMessage } from "../../utils/errors";

/**
 * Service for managing custom provider models
 * Completely isolated from SystemSculpt provider logic
 */
export class CustomProviderModelService extends BaseProviderService {
  private static instance: CustomProviderModelService | null = null;
  private customProviderService: CustomProviderService;
  private errorManager: ProviderErrorManager;
  private providerCaches = new Map<string, {
    models: SystemSculptModel[];
    timestamp: number;
  }>();
  private modelDetailsCache = new Map<string, SystemSculptModel>();
	private readonly profiler = getFunctionProfiler();
	private deferredPrefetchStarted = false;
	private activeFetches: Map<string, Promise<SystemSculptModel[]>> = new Map();
	private concurrencyLimit = 2;
	private fetchQueue: Array<() => Promise<void>> = [];
	private settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(plugin: SystemSculptPlugin) {
    super(plugin);
    this.customProviderService = plugin.customProviderService;
    this.errorManager = new ProviderErrorManager(plugin, plugin.app);
  }

  public static getInstance(plugin: SystemSculptPlugin): CustomProviderModelService {
    if (!this.instance) {
      this.instance = new CustomProviderModelService(plugin);
    }
    return this.instance;
  }

  public static clearInstance(): void {
    if (this.instance) {
      this.instance.clearCache();
      this.instance.providerCaches.clear();
      this.instance.modelDetailsCache.clear();
      this.instance = null;
    }
  }

  public getProviderType(): string {
    return "custom";
  }

  /**
   * Test connection to custom providers
   */
  public async testConnection(): Promise<boolean> {
    try {
      const { customProviders } = this.plugin.settings;
      const enabledProviders = customProviders.filter(p => p.isEnabled);

      if (enabledProviders.length === 0) {
        return true; // No providers to test
      }

      // Test at least one provider successfully
      for (const provider of enabledProviders) {
        try {
          const result = await this.customProviderService.testConnection(provider);
          if (result.success) {
            return true;
          }
        } catch (error) {
          // Continue testing other providers
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all custom provider models with isolated caching
   */
  public async getModels(forceRefresh: boolean = false): Promise<SystemSculptModel[]> {
    if (!forceRefresh) {
      const cachedModels = this.getCachedModels();
      if (cachedModels) {
        return cachedModels;
      }
    } else {
      this.clearCache();
      this.loadingPromise = null;
      this.deferredPrefetchStarted = false;
    }

    this.ensureModelsLoading(forceRefresh);
    return this.loadingPromise ?? [];
  }

  public async getModelsForProviders(
    providers: CustomProvider[],
    forceRefresh: boolean = false
  ): Promise<SystemSculptModel[]> {
    if (!providers.length) {
      return [];
    }
    const tasks = providers.map((provider) => this.enqueueProviderFetch(provider, forceRefresh));
    const results = await Promise.all(tasks);
    return results.flat();
  }

  /**
   * Lightweight accessor that returns cached models immediately and kicks off
   * loading in the background if needed. Used to keep startup responsive.
   */
  public getModelsDeferred(): SystemSculptModel[] {
    const cachedModels = this.getCachedModels();
    if (cachedModels) {
      return cachedModels;
    }

    if (!this.deferredPrefetchStarted) {
      this.deferredPrefetchStarted = true;
      this.ensureModelsLoading();
    }

    return [];
  }

  /**
   * Get models from a specific provider with isolated caching
   */
  public async getModelsFromProvider(
    provider: CustomProvider,
    forceRefresh: boolean = false
  ): Promise<SystemSculptModel[]> {
    // Check provider-specific cache
    if (!forceRefresh) {
      const cached = this.providerCaches.get(provider.id);
      if (cached && !this.isProviderCacheExpired(cached.timestamp)) {
        return cached.models;
      }
    }

    try {
      const profiledTest = this.profiler.profileFunction(
        () =>
          this.customProviderService.testConnection(
            provider,
            forceRefresh ? { force: true } : undefined
          ),
        "performConnectionTest",
        `CustomProviderService[${provider.id}]`
      );

      const result = await profiledTest();
      if (result.success && result.models) {
        // Reset failure count on successful connection
        await this.resetProviderFailureCount(provider.id);
        const models = this.createCustomModels(provider, result.models);

        // Cache for this specific provider
        this.providerCaches.set(provider.id, {
          models,
          timestamp: Date.now()
        });

        return models;
      } else {
        // Only increment failure count for auth-related failures; avoid punishing transient network issues
        const isAuthRelated = isAuthFailureMessage(result.error || "");
        if (isAuthRelated) {
          await this.handleProviderFailure(provider.id, provider.name, result.error);
        } else {
        }
        return [];
      }
    } catch (error) {
      
      // Report the error using provider-specific error handling
      this.errorManager.reportCustomProviderError({
        providerId: provider.id,
        providerName: provider.name,
        errorCode: 'MODEL_LOAD_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error loading models',
        endpoint: provider.endpoint,
        authRelated: isAuthFailureMessage(error instanceof Error ? error.message : String(error)),
        context: {
          hasApiKey: !!provider.apiKey,
          endpoint: provider.endpoint
        }
      });
      
      // Only track failure for auth-related errors; otherwise skip auto-disable
      const msg = error instanceof Error ? error.message : String(error);
      const isAuthRelated = isAuthFailureMessage(msg);
      if (isAuthRelated) {
        await this.handleProviderFailure(provider.id, provider.name, msg);
      } else {
      }
      return [];
    }
  }

  /**
   * Load models from all custom providers
   */
  private async loadCustomProviderModels(forceRefresh: boolean = false): Promise<SystemSculptModel[]> {
    const { customProviders } = this.plugin.settings;
    const enabledProviders = customProviders.filter(p => p.isEnabled);

    if (enabledProviders.length === 0) {
      return [];
    }

    const tasks = enabledProviders.map((provider) =>
      this.enqueueProviderFetch(provider, forceRefresh)
    );
    const results = await Promise.all(tasks);
    return results.flat();
  }

  /**
   * Check if provider-specific cache is expired
   */
  private isProviderCacheExpired(timestamp: number): boolean {
    return Date.now() - timestamp >= this.CACHE_DURATION;
  }

  /**
   * Handle provider connection failure with failure tracking
   */
  private async handleProviderFailure(providerId: string, providerName: string, errorMessage?: string): Promise<void> {
    try {
      const settings = this.plugin.getSettingsManager().getSettings();
      const provider = settings.customProviders.find((p: any) => p.id === providerId);
      
      if (!provider) return;

      // Initialize failure count if not present
      if (!provider.failureCount) {
        provider.failureCount = 0;
      }

      provider.failureCount++;
      provider.lastFailureTime = Date.now();

      // Auto-disable after 3 consecutive failures
      const FAILURE_THRESHOLD = 3;
      if (provider.failureCount >= FAILURE_THRESHOLD && provider.isEnabled) {
        provider.isEnabled = false;
        
        // Show a user-friendly notice for auto-disable
		const { showNoticeWhenReady } = await import("../../core/ui/notifications");
        const message = `Custom provider '${providerName}' has been automatically disabled after ${provider.failureCount} consecutive connection failures. You can re-enable it in settings when the server is available.`;
        showNoticeWhenReady(this.plugin.app, message, { type: "warning", duration: 12000 });
      } else {
        
        // Show a user-friendly notice for ongoing failures
		const { showNoticeWhenReady } = await import("../../core/ui/notifications");
        const remainingAttempts = FAILURE_THRESHOLD - provider.failureCount;
        const message = `Connection to custom provider '${providerName}' failed (attempt ${provider.failureCount} of ${FAILURE_THRESHOLD}). We'll try again when you reload Obsidian. After ${remainingAttempts} more failure${remainingAttempts === 1 ? '' : 's'}, this provider will be automatically disabled.`;
        showNoticeWhenReady(this.plugin.app, message, { type: "warning", duration: 8000 });
      }

		this.scheduleSettingsPersist();
		} catch (error) {
		}
	}

  /**
   * Reset failure count for a provider after successful connection
   */
  private async resetProviderFailureCount(providerId: string): Promise<void> {
    try {
      const settings = this.plugin.getSettingsManager().getSettings();
      const provider = settings.customProviders.find((p: any) => p.id === providerId);
      
		if (provider && (provider.failureCount || 0) > 0) {
			provider.failureCount = 0;
			delete provider.lastFailureTime;
			this.scheduleSettingsPersist();
		}
		} catch (error) {
		}
	}

  /**
   * Creates SystemSculptModel objects for a given custom provider
   */
  private createCustomModels(
    provider: CustomProvider,
    providerModels: (ProviderModel | string)[]
  ): SystemSculptModel[] {
    // Check if this is an Anthropic provider to enrich model data
    const isAnthropic = isAnthropicEndpoint(provider.endpoint);

    return providerModels.map((m) => {
      const modelId = typeof m === 'string' ? m : (m.id || '');
      const contextWindow = typeof m === 'string' ? undefined : m.contextWindow;
      const displayName = typeof m === 'string' ? undefined : m.name;

      // Create a consistent ID format using our utility
      const providerId = provider.name.toLowerCase();
      const canonicalId = createCanonicalId(providerId, modelId);

      // For Anthropic models, use enriched data from constants
      if (isAnthropic) {
        const anthropicModel = ANTHROPIC_MODELS.find(mm => mm.id === modelId);
        if (anthropicModel) {
          return {
            id: canonicalId,
            name: anthropicModel.name,
            provider: providerId,
            isFavorite: false,
            context_length: anthropicModel.contextWindow,
            capabilities: anthropicModel.capabilities,
            pricing: {
              prompt: "0",
              completion: "0",
              image: "0",
              request: "0",
            },
            architecture: {
              modality: anthropicModel.capabilities.includes("vision") ? "text+image->text" : "text->text",
              tokenizer: "claude",
              instruct_type: null,
            },
            description: `${anthropicModel.name} - ${anthropicModel.contextWindow.toLocaleString()} token context`,
            identifier: {
              providerId: providerId,
              modelId: modelId,
              displayName: anthropicModel.name,
            },
            // Add supported parameters for proper tool support detection
            supported_parameters: anthropicModel.supportsTools ? ["tools", "max_tokens", "stream"] : ["max_tokens", "stream"],
          };
        }
      }

      // Default for non-Anthropic or unknown models
      const providerCapabilities = typeof m === "string" ? [] : (m.capabilities ?? []);
      const supportedParameters = typeof m === "string" ? undefined : m.supported_parameters;
      const providerArchitecture = typeof m === "string" ? undefined : m.architecture;
      const providerPricing = typeof m === "string" ? undefined : m.pricing;

      const capabilities = Array.isArray(providerCapabilities) ? [...providerCapabilities] : [];
      if (supportedParameters?.includes("tools") && !capabilities.some((c) => c.toLowerCase() === "tools")) {
        capabilities.push("tools");
      }

      const modalityFromProvider = typeof providerArchitecture?.modality === "string"
        ? providerArchitecture.modality
        : "";
      const hasVisionCapability = capabilities.some((c) => {
        const lc = c.toLowerCase();
        return lc === "vision" || lc === "image" || lc === "images";
      });

      const resolvedModality =
        modalityFromProvider.trim().length > 0
          ? modalityFromProvider
          : hasVisionCapability
            ? "text+image->text"
            : (typeof m === "string" ? "unknown" : "text->text");

      return {
        // Use the canonical ID format
        id: canonicalId,
        name: displayName || modelId,
        provider: providerId,
        isFavorite: false,
        context_length: contextWindow ?? 0,
        capabilities,
        supported_parameters: supportedParameters,
        pricing: {
          prompt: providerPricing?.prompt ?? "0",
          completion: providerPricing?.completion ?? "0",
          image: providerPricing?.image ?? "0",
          request: providerPricing?.request ?? "0",
        },
        architecture: {
          modality: resolvedModality,
          tokenizer: providerArchitecture?.tokenizer ?? "",
          instruct_type: providerArchitecture?.instruct_type ?? null,
        },
        description: `${provider.name} custom model`,
        identifier: {
          providerId: providerId,
          modelId: modelId,
          displayName: displayName || modelId,
        },
      };
    });
  }

  /**
   * Find the best custom provider alternative model
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

      // Try to get the unavailable model's details if we have them cached
      const unavailableModel = this.modelDetailsCache.get(unavailableModelId);

      if (unavailableModel) {
        // Find models from the same provider first
        const sameProviderModels = chatModels.filter(m =>
          m.provider === unavailableModel.provider
        );

        if (sameProviderModels.length > 0) {
          // Return the first model from the same provider
          return sameProviderModels[0];
        }
      }

      // If we can't find a provider match, return the first available chat model
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
   * Clear all caches including provider-specific caches
   */
  public clearCache(): void {
    super.clearCache();
    this.providerCaches.clear();
    this.modelDetailsCache.clear();
  }

  /**
   * Get provider health status for a specific custom provider
   */
  public getProviderHealth(providerId: string): {
    status: 'healthy' | 'warning' | 'error';
    recentErrorCount: number;
    lastErrorTime?: number;
  } {
    return this.errorManager.getProviderHealth(providerId, 'custom');
  }

  /**
   * Clear cache for a specific provider
   */
  public clearProviderCache(providerId: string): void {
    this.providerCaches.delete(providerId);
  }

  private ensureModelsLoading(forceRefresh: boolean = false): void {
    if (this.loadingPromise && !forceRefresh) {
      return;
    }

    this.loadingPromise = this.loadCustomProviderModels(forceRefresh)
      .then(models => {
        models.forEach(model => {
          this.modelDetailsCache.set(model.id, model);
        });
        this.cacheModels(models);
        this.loadingPromise = null;
        this.deferredPrefetchStarted = false;
        this.plugin.emitter.emitWithProvider('modelsUpdated', 'custom', models);
        return models;
      })
      .catch(error => {
        this.loadingPromise = null;
        this.deferredPrefetchStarted = false;
        return [];
      });
  }

  private async enqueueProviderFetch(
    provider: CustomProvider,
    forceRefresh: boolean = false
  ): Promise<SystemSculptModel[]> {
    const cacheKey = forceRefresh ? `${provider.id}::force` : provider.id;
    if (this.activeFetches.has(cacheKey)) {
      return this.activeFetches.get(cacheKey)!;
    }

    return new Promise<SystemSculptModel[]>((resolve) => {
      const task = async () => {
        const promise = this.getModelsFromProvider(provider, forceRefresh)
          .finally(() => {
            this.activeFetches.delete(cacheKey);
            this.dequeueNext();
          });
        this.activeFetches.set(cacheKey, promise);
        resolve(await promise);
      };

      if (this.activeFetches.size < this.concurrencyLimit) {
        void task();
      } else {
        this.fetchQueue.push(task);
      }
    });
  }

	private dequeueNext(): void {
		if (this.fetchQueue.length === 0 || this.activeFetches.size >= this.concurrencyLimit) {
			return;
		}
		const next = this.fetchQueue.shift();
		if (next) {
			void next();
		}
	}

	private scheduleSettingsPersist(): void {
		if (this.settingsSaveTimer) {
			return;
		}
			const run = () => {
				this.settingsSaveTimer = null;
				void this.plugin
					.getSettingsManager()
					.saveSettings()
				.catch(() => {
					// Ignore persistence failures; a later user-initiated save will surface errors.
					});
			};
			if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
				this.settingsSaveTimer = setTimeout(() => (window as any).requestIdleCallback(run), 750);
			} else {
				this.settingsSaveTimer = setTimeout(run, 750);
			}
		}
	}
