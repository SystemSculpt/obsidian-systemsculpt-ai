import { SystemSculptModel } from "../types/llm";

/**
 * Service to track and persist runtime-discovered model incompatibilities.
 * When a model rejects tools or images at runtime, we record this so:
 * 1. We don't send tools/images to that model again
 * 2. The UI can show appropriate warnings
 */
export class RuntimeIncompatibilityService {
  private static instance: RuntimeIncompatibilityService | null = null;
  private plugin: any;

  // In-memory cache for fast lookups (persisted to settings on change)
  private toolIncompatible: Set<string> = new Set();
  private imageIncompatible: Set<string> = new Set();

  private constructor(plugin: any) {
    this.plugin = plugin;
    this.loadFromSettings();
  }

  public static getInstance(plugin: any): RuntimeIncompatibilityService {
    if (!this.instance) {
      this.instance = new RuntimeIncompatibilityService(plugin);
    }
    return this.instance;
  }

  public static clearInstance(): void {
    this.instance = null;
  }

  private loadFromSettings(): void {
    const settings = this.plugin.settings;
    this.toolIncompatible = new Set(
      Object.keys(settings.runtimeToolIncompatibleModels || {})
    );
    this.imageIncompatible = new Set(
      Object.keys(settings.runtimeImageIncompatibleModels || {})
    );
  }

  /**
   * Reload from settings - useful after settings change
   */
  public reload(): void {
    this.loadFromSettings();
  }

  public isToolIncompatible(modelId: string): boolean {
    return this.toolIncompatible.has(modelId);
  }

  public isImageIncompatible(modelId: string): boolean {
    return this.imageIncompatible.has(modelId);
  }

  public async markToolIncompatible(modelId: string): Promise<void> {
    if (this.toolIncompatible.has(modelId)) return;

    this.toolIncompatible.add(modelId);
    const current = this.plugin.settings.runtimeToolIncompatibleModels || {};
    await this.plugin.getSettingsManager().updateSettings({
      runtimeToolIncompatibleModels: {
        ...current,
        [modelId]: Date.now(),
      },
    });
  }

  public async markImageIncompatible(modelId: string): Promise<void> {
    if (this.imageIncompatible.has(modelId)) return;

    this.imageIncompatible.add(modelId);
    const current = this.plugin.settings.runtimeImageIncompatibleModels || {};
    await this.plugin.getSettingsManager().updateSettings({
      runtimeImageIncompatibleModels: {
        ...current,
        [modelId]: Date.now(),
      },
    });
  }

  /**
   * Apply runtime incompatibility flags to a model object.
   * Also modifies supported_parameters to remove "tools" if known incompatible.
   */
  public applyRuntimeFlags(model: SystemSculptModel): SystemSculptModel {
    const isToolIncompat = this.toolIncompatible.has(model.id);
    const isImageIncompat = this.imageIncompatible.has(model.id);

    if (!isToolIncompat && !isImageIncompat) {
      return model;
    }

    const updated = { ...model };

    if (isToolIncompat) {
      updated.runtimeKnownToolIncompatible = true;
      // Remove "tools" from supported_parameters if present
      if (Array.isArray(updated.supported_parameters)) {
        updated.supported_parameters = updated.supported_parameters.filter(
          (p) => p !== "tools"
        );
      }
    }

    if (isImageIncompat) {
      updated.runtimeKnownImageIncompatible = true;
      // Update capabilities to remove vision
      if (Array.isArray(updated.capabilities)) {
        updated.capabilities = updated.capabilities.filter(
          (c) => !["vision", "image", "images"].includes(c.toLowerCase())
        );
      }
    }

    return updated;
  }

  /**
   * Clear a model's incompatibility record (e.g., if user wants to retry)
   */
  public async clearIncompatibility(
    modelId: string,
    type: "tools" | "images" | "both"
  ): Promise<void> {
    if (type === "tools" || type === "both") {
      this.toolIncompatible.delete(modelId);
      const current = {
        ...(this.plugin.settings.runtimeToolIncompatibleModels || {}),
      };
      delete current[modelId];
      await this.plugin.getSettingsManager().updateSettings({
        runtimeToolIncompatibleModels: current,
      });
    }

    if (type === "images" || type === "both") {
      this.imageIncompatible.delete(modelId);
      const current = {
        ...(this.plugin.settings.runtimeImageIncompatibleModels || {}),
      };
      delete current[modelId];
      await this.plugin.getSettingsManager().updateSettings({
        runtimeImageIncompatibleModels: current,
      });
    }
  }

  /**
   * Get all tool-incompatible model IDs
   */
  public getToolIncompatibleModels(): string[] {
    return Array.from(this.toolIncompatible);
  }

  /**
   * Get all image-incompatible model IDs
   */
  public getImageIncompatibleModels(): string[] {
    return Array.from(this.imageIncompatible);
  }
}
