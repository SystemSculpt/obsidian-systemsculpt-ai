import { App, setIcon, DropdownComponent, Notice, ButtonComponent } from "obsidian";
import { ListItem, ListSelectionModal } from "../core/ui/modals/standard";
import { SystemSculptModel } from "../types/llm";
import SystemSculptPlugin from "../main";
import { SearchService, SearchableField } from "../services/SearchService";
import {
  ensureCanonicalId,
  getCanonicalId,
  parseCanonicalId,
  MODEL_ID_SEPARATOR,
  filterChatModels
} from "../utils/modelUtils";
import { FavoritesService } from "../services/FavoritesService";
import { FavoritesFilter } from "../components/FavoritesFilter";
import { FavoriteToggle } from "../components/FavoriteToggle";
import { EmptyFavoritesState } from "../components/EmptyFavoritesState";
// Define the result type for the onSelect callback
export interface ModelSelectionResult {
  modelId: string;
}

// Define options for the modal constructor
export interface ModelSelectionOptions {
  app: App;
  plugin: SystemSculptPlugin;
  currentModelId: string;
  onSelect: (result: ModelSelectionResult) => void;
  title?: string; // Optional custom title
  description?: string; // Optional custom description
}

/**
 * StandardModelSelectionModal provides a standardized model selection experience
 * using the new modal system.
 */
export class StandardModelSelectionModal {
  private allModels: SystemSculptModel[] = [];
  private filteredModels: SystemSculptModel[] = [];
  private selectedModelId: string;
  // Updated onSelect type
  private onSelect: (result: ModelSelectionResult) => void;
  private plugin: SystemSculptPlugin;
  private app: App;
  private searchService: SearchService;
  private favoritesService: FavoritesService;
  private modalInstance: ListSelectionModal | null = null; // Store modal instance reference
  private listeners: { element: HTMLElement; type: string; listener: EventListener }[] = [];
  private favoritesFilter: FavoritesFilter | null = null;
  private emptyState: EmptyFavoritesState | null = null;
  private modalTitle: string; // Custom title for the modal
  private modalDescription: string; // Custom description for the modal
  private isLoadingModels: boolean = true; // Track loading state for lazy UI

  // Cache for provider name lookups
  private static providerNameCache: Record<string, string> = {};

  // Updated constructor to use options object
  constructor(options: ModelSelectionOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.selectedModelId = options.currentModelId;
    this.onSelect = options.onSelect;
    this.modalTitle = options.title || "Select AI Model";
    this.modalDescription = options.description || "Choose a model for your conversation";

    // Initialize services
    this.searchService = SearchService.getInstance();
    this.favoritesService = FavoritesService.getInstance(this.plugin);

    // Load all models from the model service
    this.plugin.modelService.getModels().then(models => {
      // Filter out embedding models - only show chat models
      this.allModels = filterChatModels(models);

      // Process favorites to ensure they're marked correctly
      this.favoritesService.processFavorites(this.allModels);

      this.filteredModels = this.applyAllFilters(this.allModels);
    }).catch(error => {
      this.allModels = [];
      this.filteredModels = [];
    });

  }

  /**
   * Register an event listener and track it for cleanup
   * (Ensure this is only used for listeners we *know* we need to clean up)
   */
  private registerListener(element: HTMLElement, type: string, listener: EventListener) {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  /**
   * Remove all registered event listeners
   */
  private removeAllListeners() {
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
    // Also remove emitter listeners if any were registered
    this.removeAllEmitterListeners();
  }

  // Track emitter unsubscribers for cleanup
  private emitterUnsubscribers: Array<() => void> = [];

  private registerEmitterListener(unsub: () => void) {
    this.emitterUnsubscribers.push(unsub);
  }

  private removeAllEmitterListeners() {
    this.emitterUnsubscribers.forEach((off) => {
      try { off(); } catch {}
    });
    this.emitterUnsubscribers = [];
  }

  /**
   * Apply modal filters (favorites, current selection pinning, sorting)
   */
  private applyAllFilters(models: SystemSculptModel[]): SystemSculptModel[] {
    // No longer restrict models based on agent prompt - agent mode is now independent of model selection
    let filteredModels = models;

    // Then filter by favorites if needed
    filteredModels = this.favoritesService.filterModelsByFavorites(filteredModels);

    // Always include the current model if it exists and isn't already in the filtered list
    const currentModel = models.find(m => this.isModelSelected(m.id));
    if (currentModel && !filteredModels.some(m => this.isModelSelected(m.id))) {
      filteredModels.unshift(currentModel); // Add to beginning
    }

    // Then sort with favorites first
    filteredModels = this.favoritesService.sortModelsByFavorites(filteredModels);

    // Store the filtered models for reference
    this.filteredModels = filteredModels;

    return filteredModels;
  }

  /**
   * Search models based on query
   */
  private searchModels(models: SystemSculptModel[], query: string): ListItem[] {
    if (!query || query.trim() === '') {
      return this.convertModelsToListItems(models);
    }

    const results = this.searchService.search(
      models,
      query,
      (model) => this.getSearchableFields(model),
      {
        initialResultsLimit: 25,
        maxFilteredResults: 50,
      }
    );

    // Filter out results with no matches or low scores
    let filteredResults = results
      .filter(result => result.matches.length > 0 && result.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(result => result.item);

    // Always include the current model in search results if it exists
    const currentModel = models.find(m => this.isModelSelected(m.id));
    if (currentModel && !filteredResults.some(m => this.isModelSelected(m.id))) {
      filteredResults.unshift(currentModel); // Add to beginning
    }

    return this.convertModelsToListItems(filteredResults);
  }

  /**
   * Create filter controls (providers and favorites)
   */
  private createFilters(containerEl: HTMLElement): void {
    // Create a compact filter bar
    const filterBar = containerEl.createDiv("ss-model-filter-bar");

    // Controls section
    const controlsSection = filterBar.createDiv("ss-model-filter-controls");

    // Favorites toggle (with count integrated)
    const favoritesButton = controlsSection.createDiv("ss-favorites-button");
    this.favoritesFilter = new FavoritesFilter(
      favoritesButton,
      this.favoritesService,
      () => {
        this.updateModelList();
        this.updateFavoritesButtonCount(); // Update favorites count
        this.updateEmptyState();
      }
    );

    // Initialize favorites count
    this.updateFavoritesButtonCount();

    // Simple refresh button
    const refreshButton = controlsSection.createEl("button", {
      cls: "ss-model-refresh-button",
    });
    const refreshIcon = refreshButton.createSpan();
    setIcon(refreshIcon, "refresh-cw");
    const refreshText = refreshButton.createSpan();
    refreshText.textContent = "Refresh";

    refreshButton.addEventListener("click", async () => {
      refreshIcon.addClass("ss-spin");
      refreshText.textContent = "...";

      try {
        this.allModels = await this.plugin.modelService.refreshModels();
        this.favoritesService.processFavorites(this.allModels);
        this.updateModelList();
        this.updateFavoritesButtonCount();
        this.updateEmptyState();
        new Notice("Models refreshed");
      } catch (error) {
        new Notice("Failed to refresh models");
      } finally {
        refreshIcon.removeClass("ss-spin");
        refreshText.textContent = "Refresh";
      }
    });
  }

  /**
   * Handle incremental provider model updates and refresh the UI
   */
  private handleProviderModelsUpdate(providerType: 'systemsculpt' | 'custom', models: SystemSculptModel[]): void {
    try {
      const chatModels = filterChatModels(models);
      // Remove previous models for the provider and append fresh ones
      const keepProvider = (m: SystemSculptModel) => providerType === 'systemsculpt' ? m.provider !== 'systemsculpt' : m.provider === 'systemsculpt';
      this.allModels = [
        ...this.allModels.filter(keepProvider),
        ...chatModels,
      ];

      // Re-process favorites flags and update filtered view
      this.favoritesService.processFavorites(this.allModels);
      this.updateModelList();
      this.updateFavoritesButtonCount();
      this.updateEmptyState();
    } catch {}
  }

  /**
   * Clean up invalid provider preferences on settings load
   * This should be called when the plugin loads to ensure saved preferences are still valid
   */
  public static cleanupProviderPreferences(plugin: SystemSculptPlugin): void {
    try {
      if (plugin.settings.selectedModelProviders?.length) {
        plugin.settings.selectedModelProviders = [];
        plugin.saveSettings();
      }
    } catch (error) {
    }
  }

  /**
   * Update favorites button to show the count
   */
  private updateFavoritesButtonCount(): void {
    if (!this.favoritesFilter) return;

    const favorites = this.filteredModels.filter(m => m.isFavorite).length;

    // Find the favorites filter element and update its count
    const favoritesEl = this.modalInstance?.contentEl.querySelector('.systemsculpt-favorites-filter');
    if (favoritesEl) {
      // Remove existing count if present
      const existingCount = favoritesEl.querySelector('.ss-favorites-count');
      if (existingCount) {
        existingCount.remove();
      }

      // Add count if there are favorites
      if (favorites > 0) {
        const countSpan = favoritesEl.createSpan("ss-favorites-count");
        countSpan.textContent = favorites.toString();
      }
    }
  }




  /**
   * Update the model list with current filters
   */
  private updateModelList(): void {
    if (!this.modalInstance) {
      return;
    }

    // Apply filters and update items
    try {
      // Get filtered models
      this.filteredModels = this.applyAllFilters(this.allModels); // Ensure filteredModels is updated
      const items = this.convertModelsToListItems(this.filteredModels);

      // Update the list with the new items
      this.modalInstance.setItems(items);

      // Update empty state if needed
      this.updateEmptyState();
    } catch (error) {
    }
  }

  /**
   * Show or hide empty state based on current filters
   */
  private updateEmptyState(): void {
    if (!this.modalInstance) return;

    // Use the already filtered list from updateModelList
    const modalContent = this.modalInstance.contentEl;

    // If we have no models to show
    if (this.filteredModels.length === 0) {
      // Create empty state if it doesn't exist
      if (!this.emptyState) {
        this.emptyState = new EmptyFavoritesState(
          modalContent,
          this.favoritesService.getShowFavoritesOnly()
        );
      } else {
        // Update existing empty state
        this.emptyState.updateForFilterState(
          this.favoritesService.getShowFavoritesOnly()
        );

        // Make sure it's visible and in the right place
        modalContent.appendChild(this.emptyState.element);
      }

      // Hide the list - Target the correct list element used by ListSelectionModal
      const listEl = modalContent.querySelector(".ss-modal__list");
      if (listEl) {
        listEl.addClass("systemsculpt-hidden");
      }



    } else {
      // We have models to show

      // Hide empty state if it exists
      if (this.emptyState && this.emptyState.element.parentNode) {
        this.emptyState.element.detach();
      }

      // Show the list - Target the correct list element used by ListSelectionModal
      const listEl = modalContent.querySelector(".ss-modal__list");
      if (listEl) {
        listEl.removeClass("systemsculpt-hidden");
      }
    }
  }

  /**
   * Get searchable fields from a model
   */
  private getSearchableFields(model: SystemSculptModel): SearchableField[] {
    return [
      { field: "name", text: model.name || "", weight: 2.0 },
      { field: "description", text: model.description || "", weight: 0.5 },
      { field: "provider", text: model.provider || "", weight: 0.8 },
      { field: "id", text: model.id || "", weight: 0.6 }
    ];
  }

  /**
   * Convert models to list items for the list selection modal
   */
  private convertModelsToListItems(models: SystemSculptModel[]): ListItem[] {
    // Sort models with selected one first, then favorites, then others
    const sortedModels = models.sort((a, b) => {
      const aSelected = this.isModelSelected(a.id) ? 1 : 0;
      const bSelected = this.isModelSelected(b.id) ? 1 : 0;
      const aFavorite = a.isFavorite ? 1 : 0;
      const bFavorite = b.isFavorite ? 1 : 0;

      // Selected models come first
      if (aSelected !== bSelected) {
        return bSelected - aSelected;
      }


      // Then favorites
      if (aFavorite !== bFavorite) {
        return bFavorite - aFavorite;
      }

      // Then alphabetical by name
      return a.name.localeCompare(b.name);
    });

    return sortedModels.map(model => {
      const isCurrentModel = this.isModelSelected(model.id);

      // Create an enhanced list item for each model
      const item: ListItem = {
        id: model.id,
        title: model.name,
        description: this.getModelDescription(model),
        icon: this.getModelIcon(model),
        selected: isCurrentModel,
        badge: this.getModelBadge(model),
        // Store additional data for enhanced display
        metadata: {
          provider: model.provider,
          contextLength: model.context_length,
          isFavorite: model.isFavorite || false,
          isNew: (model as any).is_new || false,
          isBeta: (model as any).is_beta || false,
          isDeprecated: (model as any).is_deprecated || false,
          capabilities: this.getModelCapabilities(model),
          isCurrentModel: isCurrentModel // Add flag for current model
        }
      } as ListItem;

      // Store a reference to the model for use in rendering
      (item as any)._ssModel = model;

      // Add provider-specific class
      if (model.provider === "systemsculpt") {
        (item as any).providerClass = "provider-systemsculpt";
      } else {
        (item as any).providerClass = "provider-custom";
      }

      // Add special class for current model
      if (isCurrentModel) {
        (item as any).additionalClasses = "ss-current-model";
      }

      return item;
    });
  }

  /**
   * Get model capabilities for display
   */
  private getModelCapabilities(model: SystemSculptModel): string[] {
    const capabilities: string[] = [];

    if ((model as any).supports_vision) capabilities.push("Vision");
    if ((model as any).supports_functions) capabilities.push("Functions");
    if ((model as any).supports_streaming !== false) capabilities.push("Streaming");
    if (model.context_length && model.context_length >= 100000) capabilities.push("Long Context");

    return capabilities;
  }

  /**
   * Check if a model is selected
   */
  private isModelSelected(modelId: string): boolean {
    // Check exact match
    if (this.selectedModelId === modelId) {
      return true;
    }

    // Normalize and compare
    const normalizedSelected = ensureCanonicalId(this.selectedModelId);
    const normalizedCandidate = ensureCanonicalId(modelId);

    return normalizedSelected === normalizedCandidate;
  }

  /**
   * Get a model description for the UI
   */
  private getModelDescription(model: SystemSculptModel): string {
    const parts: string[] = [];

    // Add model context length with better formatting
    if (model.context_length) {
      const tokens = model.context_length;
      let formattedTokens: string;

      if (tokens >= 1000000) {
        formattedTokens = `${(tokens / 1000000).toFixed(1)}M tokens`;
      } else if (tokens >= 1000) {
        formattedTokens = `${(tokens / 1000).toFixed(0)}K tokens`;
      } else {
        formattedTokens = `${tokens} tokens`;
      }

      parts.push(formattedTokens);
    }

    // Add pricing info if available
    if ((model as any).pricing) {
      const pricing = (model as any).pricing;
      if (pricing.input && pricing.output) {
        parts.push(`$${pricing.input}/$${pricing.output} per 1K`);
      }
    }

    // Add model capabilities
    const capabilities: string[] = [];
    if ((model as any).supports_vision) capabilities.push("Vision");
    if ((model as any).supports_functions) capabilities.push("Functions");
    if ((model as any).supports_streaming) capabilities.push("Streaming");

    if (capabilities.length > 0) {
      parts.push(capabilities.join(" · "));
    }

    // Add model description if available and not too long
    if (model.description && model.description.length > 0 && model.description.length < 100) {
      parts.push(model.description);
    }

    return parts.join(' • ');
  }

  /**
   * Get an icon for a model
   */
  private getModelIcon(model: SystemSculptModel): string {
    // Check if this is the Vault Agent model
    const canonicalId = getCanonicalId(model);
    if (canonicalId === "systemsculpt@@vault-agent") {
      return "folder-open"; // Special icon for Vault Agent
    }

    // Use different icons based on provider
    if (model.provider === "systemsculpt") {
      return "bot";
    } else {
      return "server";
    }
  }

  /**
   * Get a badge label for a model
   */
  private getModelBadge(model: SystemSculptModel): string {
    // Check if this is the Vault Agent model
    const canonicalId = getCanonicalId(model);
    if (canonicalId === "systemsculpt@@vault-agent") {
      return "Agent";
    }

    // Check for special model types
    if ((model as any).is_new) {
      return "New";
    }

    if ((model as any).is_beta) {
      return "Beta";
    }

    if ((model as any).is_deprecated) {
      return "Legacy";
    }

    // Show provider name for all providers
    if (model.provider === "systemsculpt") {
      return "SystemSculpt";
    }

    const providerName = (model.provider || "").toLowerCase();

    if (!StandardModelSelectionModal.providerNameCache[providerName]) {
      const matchingProvider = this.plugin.settings.customProviders.find(
        p => p.name.toLowerCase() === providerName || p.id.toLowerCase() === providerName
      );
      StandardModelSelectionModal.providerNameCache[providerName] = matchingProvider
        ? matchingProvider.name
        : (model.provider ? model.provider : "Custom");
    }

    return StandardModelSelectionModal.providerNameCache[providerName];
  }

  /**
   * Register events for updates
   */
  private registerEventsForUpdates(): void {
    // Use the registerListener method to properly track and clean up event listeners
    const favChangedListener = () => this.updateModelList();
    const favFilterChangedListener = () => this.updateModelList();
    // Add listener for when a favorite toggle is clicked in the list item
    const favToggledListener = (event: CustomEvent) => {
      const { modelId, isFavorite } = event.detail;
      const modelIndex = this.filteredModels.findIndex(m => m.id === modelId);
      if (modelIndex !== -1) {
        this.filteredModels[modelIndex].isFavorite = isFavorite;
      }
      this.updateModelList();
      this.updateFavoritesButtonCount();
      this.updateEmptyState();
    };

    this.registerListener(document.body, 'systemsculpt:favorites-changed', favChangedListener);
    this.registerListener(document.body, 'systemsculpt:favorites-filter-changed', favFilterChangedListener);
    this.registerListener(document.body, 'ss-list-item-favorite-toggled', favToggledListener as EventListener);
  }

  /**
   * Open the modal and get selection
   */
  async open() {
    try {
      // Clean up any existing listeners from previous opens
      this.removeAllListeners();

      // Prepare initial, non-blocking UI with an empty list and a loading message
      const initialItems: ListItem[] = [];
      const modal = new ListSelectionModal(this.app, initialItems, {
        title: this.modalTitle,
        description: this.modalDescription,
        emptyText: "Loading models…",
        placeholder: "Search by name, provider, or capabilities...",
        withSearch: true,
        size: "large",
        closeOnSelect: true,
        favoritesService: this.favoritesService,
        customContent: (containerEl: HTMLElement) => {
          // Add native-style filters immediately
          this.createFilters(containerEl);
        }
      });

      // Store the modal instance for later use
      this.modalInstance = modal;

      // Add custom class to modal for native styling
      modal.contentEl.addClass("systemsculpt-model-selection-modal");

      // Custom search handler returns a Promise
      modal.setCustomSearchHandler((query: string) => {
        // Search within the currently filtered models (respecting all active filters)
        return this.searchModelsAsync(this.filteredModels, query);
      });

      // Register event listener for favorite toggle events on the modal element
      modal.contentEl.addEventListener('ss-list-item-favorite-toggled', (_event: Event) => {
        // No additional action required here; FavoriteToggle updates itself
      });

      // Register event listeners for updates (favorites, filters, etc.)
      this.registerEventsForUpdates();

      // Subscribe to provider-specific incremental updates so the list fills progressively
      if (this.plugin?.emitter) {
        const offSystem = this.plugin.emitter.onProvider('modelsUpdated', 'systemsculpt', (models: SystemSculptModel[]) => {
          this.handleProviderModelsUpdate('systemsculpt', models);
        });
        const offCustom = this.plugin.emitter.onProvider('modelsUpdated', 'custom', (models: SystemSculptModel[]) => {
          this.handleProviderModelsUpdate('custom', models);
        });
        this.registerEmitterListener(offSystem);
        this.registerEmitterListener(offCustom);
      }

      // Force a complete model load (not deferred) to ensure all providers are fetched
      this.plugin.modelService.refreshModels().then((models) => {
        this.allModels = filterChatModels(models);
        this.favoritesService.processFavorites(this.allModels);
        this.filteredModels = this.applyAllFilters(this.allModels);
        const items = this.convertModelsToListItems(this.filteredModels);
        this.modalInstance?.setItems(items);
        this.updateFavoritesButtonCount();
        this.updateEmptyState();
      }).catch(() => {
        // Leave the loading/empty state as-is on failure
      });

      // Open the modal immediately and wait only for user selection to resolve
      const selectedItems = await modal.openAndGetSelection();

      // Clean up listeners *after* selection is made or modal is closed
      this.removeAllListeners();

      // Process the selection if an item was chosen
      if (selectedItems && selectedItems.length > 0) {
        const selectedItem = selectedItems[0]; // Single select mode
        const result: ModelSelectionResult = { modelId: selectedItem.id };
        this.onSelect(result);
      }

    } catch (error) {
      // Non-fatal; modal may have been closed early
    }
  }

  // Wrap search methods to return Promises
  private async searchModelsAsync(models: SystemSculptModel[], query: string): Promise<ListItem[]> {
    return Promise.resolve(this.searchModels(models, query));
  }


}
