import { SystemSculptModel } from "../../types/llm";
import SystemSculptPlugin from "../../main";

/**
 * Base interface for all provider services
 * Ensures consistent behavior across provider types
 */
export interface ProviderServiceInterface {
  getModels(): Promise<SystemSculptModel[]>;
  testConnection(): Promise<boolean>;
  clearCache(): void;
  getProviderType(): string;
}

/**
 * Base class for provider-specific services
 * Provides common functionality while maintaining isolation
 */
export abstract class BaseProviderService implements ProviderServiceInterface {
  protected plugin: SystemSculptPlugin;
  protected models: SystemSculptModel[] | null = null;
  protected lastFetchTime: number = 0;
  protected readonly CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
  protected loadingPromise: Promise<SystemSculptModel[]> | null = null;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  abstract getModels(): Promise<SystemSculptModel[]>;
  abstract testConnection(): Promise<boolean>;
  abstract getProviderType(): string;

  /**
   * Clear the provider's cache
   */
  public clearCache(): void {
    this.models = null;
    this.lastFetchTime = 0;
    this.loadingPromise = null;
  }

  /**
   * Check if cache is expired
   */
  protected isCacheExpired(): boolean {
    return Date.now() - this.lastFetchTime >= this.CACHE_DURATION;
  }

  /**
   * Get cached models if available and not expired
   */
  protected getCachedModels(): SystemSculptModel[] | null {
    if (this.models && !this.isCacheExpired()) {
      return this.models;
    }
    return null;
  }

  /**
   * Cache models with timestamp
   */
  protected cacheModels(models: SystemSculptModel[]): void {
    this.models = models;
    this.lastFetchTime = Date.now();
  }

  public peekCachedModels(): SystemSculptModel[] | null {
    return this.getCachedModels();
  }
}
