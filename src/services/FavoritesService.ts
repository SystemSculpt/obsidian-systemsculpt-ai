import { SystemSculptModel } from "../types/llm";
import { FavoriteModel } from "../types/favorites";
import { ensureCanonicalId } from "../utils/modelUtils";

/**
 * Service for managing favorite models
 */
export class FavoritesService {
  private static instance: FavoritesService | null = null;

  private constructor(private plugin: any) {}

  /**
   * Get the FavoritesService instance
   */
  public static getInstance(plugin: any): FavoritesService {
    if (!FavoritesService.instance) {
      FavoritesService.instance = new FavoritesService(plugin);
    }
    return FavoritesService.instance;
  }

  /**
   * Clear the singleton instance to allow proper cleanup
   */
  public static clearInstance(): void {
    FavoritesService.instance = null;
  }

  /**
   * Add a model to favorites
   */
  public async addFavorite(model: SystemSculptModel): Promise<void> {
    // Skip if model is already a favorite
    if (model.isFavorite === true) {
      return;
    }

    // Mark the model as favorite
    model.isFavorite = true;

    // Create a FavoriteModel entry with canonical ID
    const favorite: FavoriteModel = {
      provider: model.provider,
      modelId: model.id, // Should already be canonical
      addedAt: Date.now()
    };

    // Add to settings with deduplication by canonical id
    const existing = Array.isArray(this.plugin.settings.favoriteModels) ? this.plugin.settings.favoriteModels : [];
    const updatedFavorites = [
      ...existing.filter((f: FavoriteModel) => ensureCanonicalId(f.modelId) !== ensureCanonicalId(model.id)),
      favorite
    ];

    // Save settings using SettingsManager
    await this.plugin.getSettingsManager().updateSettings({ favoriteModels: updatedFavorites });

    // Emit event to notify UI components
    this.emitFavoritesChanged();
  }

  /**
   * Remove a model from favorites
   */
  public async removeFavorite(model: SystemSculptModel): Promise<void> {
    // Skip if model is not a favorite
    if (model.isFavorite !== true) {
      return;
    }

    // Mark the model as not favorite
    model.isFavorite = false;

    // Remove from settings
    const updatedFavorites = (this.plugin.settings.favoriteModels || []).filter(
      (fav: FavoriteModel) => !(fav.modelId === model.id && fav.provider === model.provider)
    );

    // Save settings using SettingsManager
    await this.plugin.getSettingsManager().updateSettings({ favoriteModels: updatedFavorites });

    // Emit event to notify UI components
    this.emitFavoritesChanged();
  }

  /**
   * Toggle favorite status for a model
   */
  public async toggleFavorite(model: SystemSculptModel): Promise<void> {
    if (model.isFavorite === true) {
      await this.removeFavorite(model);
    } else {
      await this.addFavorite(model);
    }

    // Force an additional save to ensure persistence
    await this.forceSaveSettings();
  }

  /**
   * Check if a model is a favorite
   */
  public isFavorite(model: SystemSculptModel): boolean {
    return model.isFavorite === true;
  }

  /**
   * Get all favorited models
   */
  public getFavorites(models: SystemSculptModel[]): SystemSculptModel[] {
    return models.filter(model => model.isFavorite === true);
  }

  /**
   * Clear all favorites
   */
  public async clearAllFavorites(models: SystemSculptModel[]): Promise<void> {
    // Mark all models as not favorite
    models.forEach(model => {
      model.isFavorite = false;
    });

    // Clear settings using SettingsManager
    await this.plugin.getSettingsManager().updateSettings({ favoriteModels: [] });

    // Emit event to notify UI components
    this.emitFavoritesChanged();
  }

  /**
   * Process favorites by marking models as favorites based on settings
   */
  public processFavorites(models: SystemSculptModel[]): void {
    const favoriteModels = this.plugin.settings.favoriteModels || [];

    // Reset all isFavorite flags first
    models.forEach(model => {
      model.isFavorite = false;
    });

    // Update favorites to use canonical IDs and dedupe
    const updatedFavorites: FavoriteModel[] = [];

    // Process each favorite and ensure it has canonical format
    for (const favorite of favoriteModels) {
      // First try to find the model with the existing ID
      const matchingModel = models.find(m => {
        // Try various matching strategies
        const legacyID = `${m.provider}/${m.identifier?.modelId}`;
        const favoriteIDCanonical = ensureCanonicalId(favorite.modelId);

        return (
          // Direct match on ID (already canonical)
          m.id === favorite.modelId ||
          // Match after canonicalization
          m.id === favoriteIDCanonical ||
          // Match with legacy format
          legacyID === favorite.modelId
        );
      });

      if (matchingModel) {
        // Use the canonical ID from the matching model
        updatedFavorites.push({
          provider: matchingModel.provider,
          modelId: matchingModel.id,
          addedAt: favorite.addedAt || Date.now()
        });

        // Mark the model as favorite
        matchingModel.isFavorite = true;

      } else {
        // Can't find model, create canonical version of the favorite
        const canonicalID = ensureCanonicalId(favorite.modelId, favorite.provider);
        updatedFavorites.push({
          provider: favorite.provider,
          modelId: canonicalID,
          addedAt: favorite.addedAt || Date.now()
        });

      }
    }

    // Deduplicate by canonical id
    const seen = new Set<string>();
    const deduped = updatedFavorites.filter((fav) => {
      const key = ensureCanonicalId(fav.modelId);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Always update the settings with the processed favorites
    this.plugin.getSettingsManager().updateSettings({ favoriteModels: deduped }).catch((_error: Error) => {
    });
  }

  /**
   * Sort models with favorites first
   */
  public sortModelsByFavorites(models: SystemSculptModel[]): SystemSculptModel[] {
    const favoritesFirst = this.plugin.settings.favoritesFilterSettings.favoritesFirst;
    const sortOrder = this.plugin.settings.favoritesFilterSettings.modelSortOrder;

    // If neither favoritesFirst nor alphabetical sort is needed, return original order
    if (!favoritesFirst && sortOrder === 'default') {
      return models;
    }

    return [...models].sort((a, b) => {
      // --- Primary Sort: Favorites First (if enabled) ---
      if (favoritesFirst) {
        const aIsFav = a.isFavorite === true;
        const bIsFav = b.isFavorite === true;
        if (aIsFav && !bIsFav) return -1;
        if (!aIsFav && bIsFav) return 1;
      }

      // --- Secondary Sort: Based on Setting ---
      if (sortOrder === 'alphabetical') {
        // Sort by provider first
        const providerCompare = a.provider.localeCompare(b.provider);
        if (providerCompare !== 0) {
          return providerCompare;
        }
        // Then sort by name
        return a.name.localeCompare(b.name);
      } else {
        // 'default' sort order: maintain relative order after favoritesFirst
        return 0;
      }
    });
  }

  /**
   * Filter models to show only favorites if the filter is enabled
   */
  public filterModelsByFavorites(models: SystemSculptModel[]): SystemSculptModel[] {
    // Skip filtering if showFavoritesOnly is disabled
    if (!this.plugin.settings.favoritesFilterSettings.showFavoritesOnly) {
      return models;
    }

    return models.filter(model => model.isFavorite === true);
  }

  /**
   * Toggle showing favorites only
   */
  public async toggleShowFavoritesOnly(): Promise<boolean> {
    const currentValue = this.plugin.settings.favoritesFilterSettings.showFavoritesOnly;
    await this.plugin.getSettingsManager().updateSettings({
      favoritesFilterSettings: {
        ...this.plugin.settings.favoritesFilterSettings,
        showFavoritesOnly: !currentValue
      }
    });

    // Emit event to notify UI components
    this.emitFavoritesFilterChanged();

    return !currentValue;
  }

  /**
   * Get current filter state
   */
  public getShowFavoritesOnly(): boolean {
    return this.plugin.settings.favoritesFilterSettings.showFavoritesOnly;
  }

  /**
   * Set favorites first sorting
   */
  public async setFavoritesFirst(value: boolean): Promise<void> {
    await this.plugin.getSettingsManager().updateSettings({
      favoritesFilterSettings: {
        ...this.plugin.settings.favoritesFilterSettings,
        favoritesFirst: value
      }
    });

    // Emit event to notify UI components
    this.emitFavoritesFilterChanged();
  }

  /**
   * Get favorites first setting
   */
  public getFavoritesFirst(): boolean {
    return this.plugin.settings.favoritesFilterSettings.favoritesFirst;
  }

  /**
   * Emit an event when favorites change
   */
  private emitFavoritesChanged(): void {
    // Use CustomEvent to notify the UI components
    document.dispatchEvent(new CustomEvent('systemsculpt:favorites-changed', {
      detail: {
        favorites: this.plugin.settings.favoriteModels
      }
    }));
  }

  /**
   * Helper to return a Set of canonical favorite IDs for quick checks
   */
  public getFavoriteIds(): Set<string> {
    const list: FavoriteModel[] = this.plugin.settings.favoriteModels || [];
    return new Set(list.map((f) => ensureCanonicalId(f.modelId)));
  }

  /**
   * Emit an event when favorites filter changes
   */
  private emitFavoritesFilterChanged(): void {
    // Use CustomEvent to notify the UI components
    document.dispatchEvent(new CustomEvent('systemsculpt:favorites-filter-changed', {
      detail: {
        showFavoritesOnly: this.plugin.settings.favoritesFilterSettings.showFavoritesOnly,
        favoritesFirst: this.plugin.settings.favoritesFilterSettings.favoritesFirst
      }
    }));
  }

  /**
   * Force save settings to ensure persistence
   * Uses the SettingsManager to ensure consistent settings handling
   */
  private async forceSaveSettings(): Promise<void> {
    try {
      // Use the SettingsManager to save settings
      await this.plugin.getSettingsManager().saveSettings();
    } catch (error) {
    }
  }
}