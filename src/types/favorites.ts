/**
 * Types related to the model favorites system.
 */

/**
 * Represents a favorited model in the settings.
 * Contains only the minimal information needed to identify a model.
 */
export interface FavoriteModel {
  /**
   * The provider ID (e.g., "systemsculpt", "openai", "anthropic")
   */
  provider: string;
  
  /**
   * The canonical model ID, which should be in the format "provider@@modelId"
   */
  modelId: string;
  
  /**
   * Optional timestamp when the model was added to favorites
   * Can be used for custom sorting of favorites
   */
  addedAt?: number;
}

/**
 * Settings for the favorites filter feature
 */
export interface FavoritesFilterSettings {
  /**
   * Whether to show only favorited models
   */
  showFavoritesOnly: boolean;
  
  /**
   * Whether to always show favorites at the top of lists
   */
  favoritesFirst: boolean;
  
  /**
   * The sort order for the model list ('default' preserves API order, 'alphabetical' sorts by name)
   */
  modelSortOrder: 'default' | 'alphabetical';
}

/**
 * Default favorites filter settings
 */
export const DEFAULT_FAVORITES_FILTER_SETTINGS: FavoritesFilterSettings = {
  showFavoritesOnly: false,
  favoritesFirst: true,
  modelSortOrder: 'default', // Default to natural order
};