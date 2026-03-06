import { App, Notice } from "obsidian";
import { EmptyFavoritesState } from "../components/EmptyFavoritesState";
import { FavoritesFilter } from "../components/FavoritesFilter";
import { ListItem, ListSelectionModal } from "../core/ui/modals/standard";
import SystemSculptPlugin from "../main";
import { FavoritesService } from "../services/FavoritesService";
import { SearchService } from "../services/SearchService";
import type { SearchableField } from "../services/SearchService";
import type { SystemSculptModel } from "../types/llm";
import { resolveProviderLabel } from "../studio/piAuth/StudioPiProviderRegistry";
import { ensureCanonicalId, filterChatModels } from "../utils/modelUtils";
import { buildModelSelectionListItems, getModelSelectionSearchableFields } from "./model-selection/ModelSelectionItems";
import {
  buildModelSelectionProviderSummary, createEmptyModelSelectionProviderSummary, loadModelSelectorProviderAuth,
  normalizeModelSelectorProviderId, resolveModelSelectionAccessStateForModel,
  type ModelSelectionProviderSummarySnapshot, type ModelSelectorProviderAuthRecord,
} from "./model-selection/ModelSelectionProviderAuth";
import { renderModelSelectionSummaryBar, type ModelSelectionSummaryBarHandle } from "./model-selection/ModelSelectionSummaryBar";
import {
  updateModelSelectionEmptyState,
  updateModelSelectionFavoritesButtonCount,
} from "./model-selection/ModelSelectionModalUi";

export { hasAuthenticatedModelSelectorProvider, normalizeModelSelectorProviderId } from "./model-selection/ModelSelectionProviderAuth";

export interface ModelSelectionResult {
  modelId: string;
}

export interface ModelSelectionOptions {
  app: App;
  plugin: SystemSculptPlugin;
  currentModelId: string;
  onSelect: (result: ModelSelectionResult) => void;
  title?: string;
  description?: string;
}

export class StandardModelSelectionModal {
  private allModels: SystemSculptModel[] = [];
  private filteredModels: SystemSculptModel[] = [];
  private selectedModelId: string;
  private onSelect: (result: ModelSelectionResult) => void;
  private plugin: SystemSculptPlugin;
  private app: App;
  private searchService: SearchService;
  private favoritesService: FavoritesService;
  private modalInstance: ListSelectionModal | null = null;
  private listeners: { element: HTMLElement; type: string; listener: EventListener }[] = [];
  private favoritesFilter: FavoritesFilter | null = null;
  private emptyState: EmptyFavoritesState | null = null;
  private modalTitle: string;
  private modalDescription: string;
  private isLoadingModels = true;
  private chromeHandle: ModelSelectionSummaryBarHandle | null = null;
  private providerSummary: ModelSelectionProviderSummarySnapshot =
    createEmptyModelSelectionProviderSummary();
  private emitterUnsubscribers: Array<() => void> = [];
  private providerAuthById = new Map<string, ModelSelectorProviderAuthRecord>();
  private providerAuthRequestId = 0;

  private static providerNameCache: Record<string, string> = {};

  constructor(options: ModelSelectionOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.selectedModelId = options.currentModelId;
    this.onSelect = options.onSelect;
    this.modalTitle = options.title || "Select AI Model";
    this.modalDescription = options.description || "Choose a local Pi model from your connected providers.";
    this.searchService = SearchService.getInstance();
    this.favoritesService = FavoritesService.getInstance(this.plugin);

    void this.loadModels(() => this.plugin.modelService.getModels());
  }

  public static cleanupProviderPreferences(plugin: SystemSculptPlugin): void {
    try {
      if (plugin.settings.selectedModelProviders?.length) {
        plugin.settings.selectedModelProviders = [];
        plugin.saveSettings();
      }
    } catch {
      // Ignore stale preference cleanup failures at startup.
    }
  }

  private registerListener(element: HTMLElement, type: string, listener: EventListener): void {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  private registerEmitterListener(unsub: () => void): void {
    this.emitterUnsubscribers.push(unsub);
  }

  private removeAllEmitterListeners(): void {
    this.emitterUnsubscribers.forEach((off) => {
      try {
        off();
      } catch {
        // Ignore cleanup errors from provider emitters.
      }
    });
    this.emitterUnsubscribers = [];
  }

  private removeAllListeners(): void {
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
    this.removeAllEmitterListeners();
  }

  private async loadModels(
    loader: () => Promise<SystemSculptModel[]>
  ): Promise<boolean> {
    this.isLoadingModels = true;
    this.updateProviderSummaryView();

    try {
      const models = await loader();
      await this.applyLoadedModels(models);
      return true;
    } catch {
      this.allModels = [];
      this.filteredModels = [];
      this.providerAuthById.clear();
      this.providerSummary = createEmptyModelSelectionProviderSummary();
      this.updateDerivedState();
      return false;
    } finally {
      this.isLoadingModels = false;
      this.updateProviderSummaryView();
    }
  }

  private async applyLoadedModels(models: SystemSculptModel[]): Promise<void> {
    this.allModels = filterChatModels(models);
    this.favoritesService.processFavorites(this.allModels);
    await this.refreshProviderAuthState(this.allModels);
    this.updateDerivedState();
  }

  private async refreshAllModels(noticeOnSuccess: boolean = false): Promise<void> {
    const success = await this.loadModels(() => this.plugin.modelService.refreshModels());
    if (success && noticeOnSuccess) {
      new Notice("Models refreshed");
    }
    if (!success) {
      new Notice("Failed to refresh models");
    }
  }

  private applyAllFilters(models: SystemSculptModel[]): SystemSculptModel[] {
    let nextModels = this.favoritesService.filterModelsByFavorites(models);

    const currentModel = models.find((model) => this.isModelSelected(model.id));
    if (currentModel && !nextModels.some((model) => this.isModelSelected(model.id))) {
      nextModels = [currentModel, ...nextModels];
    }

    return this.favoritesService.sortModelsByFavorites(nextModels);
  }

  private updateDerivedState(): void {
    this.filteredModels = this.applyAllFilters(this.allModels);
    this.updateProviderSummaryView();
    this.updateModelList();
    this.updateFavoritesButtonCount();
    this.updateEmptyState();
  }

  private async refreshProviderAuthState(models: SystemSculptModel[]): Promise<void> {
    const requestId = ++this.providerAuthRequestId;
    const next = await loadModelSelectorProviderAuth(models);

    if (requestId !== this.providerAuthRequestId) {
      return;
    }

    this.providerAuthById = next;
    for (const [providerId, record] of next.entries()) {
      const displayName = String(record.displayName || "").trim();
      if (displayName) {
        StandardModelSelectionModal.providerNameCache[providerId] = displayName;
      }
    }
    this.updateProviderSummaryView();
  }

  private updateProviderSummaryView(): void {
    this.providerSummary = buildModelSelectionProviderSummary(this.allModels, this.providerAuthById, {
      selectedModelId: this.selectedModelId,
      resolveProviderLabel: (providerName) => this.resolveCustomProviderDisplayName(providerName),
    });
    this.chromeHandle?.update(this.providerSummary, { loading: this.isLoadingModels });
  }

  private resolveModelAccessState(model: SystemSculptModel) {
    return resolveModelSelectionAccessStateForModel(model, this.providerAuthById);
  }

  private resolveCustomProviderDisplayName(providerName: string): string {
    const providerId = normalizeModelSelectorProviderId(providerName);
    if (!providerId) {
      return "Pi";
    }

    if (!StandardModelSelectionModal.providerNameCache[providerId]) {
      StandardModelSelectionModal.providerNameCache[providerId] =
        resolveProviderLabel(providerId) || (providerName ? providerName : providerId);
    }

    return StandardModelSelectionModal.providerNameCache[providerId];
  }

  private createModalChrome(containerEl: HTMLElement): void {
    this.chromeHandle = renderModelSelectionSummaryBar(containerEl, {
      onOpenSetup: () => this.openProviderSetup(),
      onRefresh: async () => { await this.refreshAllModels(true); },
    });

    this.favoritesFilter = new FavoritesFilter(
      this.chromeHandle.favoritesContainerEl,
      this.favoritesService,
      () => {
        this.updateModelList();
        this.updateFavoritesButtonCount();
        this.updateEmptyState();
      }
    );

    this.updateFavoritesButtonCount();
    this.updateProviderSummaryView();
  }

  private openProviderSetup(): void {
    this.modalInstance?.close();
    this.removeAllListeners();
    window.setTimeout(() => this.plugin.openSettingsTab("overview"), 0);
  }

  private updateFavoritesButtonCount(): void {
    if (!this.favoritesFilter) {
      return;
    }

    updateModelSelectionFavoritesButtonCount(
      this.modalInstance,
      this.filteredModels.filter((model) => model.isFavorite).length
    );
  }

  private getSearchableFields(model: SystemSculptModel): SearchableField[] {
    return getModelSelectionSearchableFields(model, (providerName) =>
      this.resolveCustomProviderDisplayName(providerName)
    );
  }

  private convertModelsToListItems(models: SystemSculptModel[]): ListItem[] {
    return buildModelSelectionListItems(models, {
      selectedModelId: this.selectedModelId,
      resolveProviderLabel: (providerName) => this.resolveCustomProviderDisplayName(providerName),
      resolveModelAccessState: (model) => this.resolveModelAccessState(model),
    });
  }

  private searchModels(models: SystemSculptModel[], query: string): ListItem[] {
    if (!query || query.trim() === "") {
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

    let filteredResults = results
      .filter((result) => result.matches.length > 0 && result.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((result) => result.item);

    const currentModel = models.find((model) => this.isModelSelected(model.id));
    if (currentModel && !filteredResults.some((model) => this.isModelSelected(model.id))) {
      filteredResults = [currentModel, ...filteredResults];
    }

    return this.convertModelsToListItems(filteredResults);
  }

  private async searchModelsAsync(models: SystemSculptModel[], query: string): Promise<ListItem[]> {
    return Promise.resolve(this.searchModels(models, query));
  }

  private isModelSelected(modelId: string): boolean {
    if (this.selectedModelId === modelId) {
      return true;
    }

    const selectedCanonicalId = ensureCanonicalId(this.selectedModelId || "");
    const candidateCanonicalId = ensureCanonicalId(modelId || "");
    return selectedCanonicalId.length > 0 && selectedCanonicalId === candidateCanonicalId;
  }

  private updateModelList(): void {
    if (!this.modalInstance) {
      return;
    }

    try {
      this.filteredModels = this.applyAllFilters(this.allModels);
      this.modalInstance.setItems(this.convertModelsToListItems(this.filteredModels));
      this.updateEmptyState();
    } catch {
      // Keep the modal interactive even if one provider item fails to shape.
    }
  }

  private updateEmptyState(): void {
    this.emptyState = updateModelSelectionEmptyState({
      modalInstance: this.modalInstance,
      emptyState: this.emptyState,
      favoritesService: this.favoritesService,
      filteredCount: this.filteredModels.length,
    });
  }

  private async applyProviderModelsUpdate(
    _providerType: "systemsculpt" | "custom" | "local-pi",
    _models: SystemSculptModel[]
  ): Promise<void> {
    try {
      await this.refreshAllModels();
    } catch {
      // Ignore incremental refresh failures and keep the last rendered list.
    }
  }

  private registerEventsForUpdates(): void {
    const favoritesChanged = () => this.updateModelList();
    const favoritesFilterChanged = () => this.updateModelList();
    const favoriteToggled = (event: CustomEvent) => {
      const { modelId, isFavorite } = event.detail;
      const modelIndex = this.filteredModels.findIndex((model) => model.id === modelId);
      if (modelIndex !== -1) {
        this.filteredModels[modelIndex].isFavorite = isFavorite;
      }
      this.updateModelList();
      this.updateFavoritesButtonCount();
      this.updateEmptyState();
    };

    this.registerListener(document.body, "systemsculpt:favorites-changed", favoritesChanged);
    this.registerListener(document.body, "systemsculpt:favorites-filter-changed", favoritesFilterChanged);
    this.registerListener(document.body, "ss-list-item-favorite-toggled", favoriteToggled as EventListener);
  }

  async open(): Promise<void> {
    try {
      this.removeAllListeners();
      this.chromeHandle = null;

      const modal = new ListSelectionModal(this.app, [], {
        title: this.modalTitle,
        description: this.modalDescription,
        emptyText: "Loading models…",
        placeholder: "Search by name, provider, or capabilities...",
        withSearch: true,
        size: "large",
        closeOnSelect: true,
        favoritesService: this.favoritesService,
        customContent: (containerEl: HTMLElement) => {
          this.createModalChrome(containerEl);
        },
      });

      this.modalInstance = modal;
      modal.contentEl.addClass("systemsculpt-model-selection-modal");
      modal.setCustomSearchHandler((query: string) => this.searchModelsAsync(this.filteredModels, query));

      this.registerEventsForUpdates();

      if (this.plugin?.emitter) {
        const offSystem = this.plugin.emitter.onProvider(
          "modelsUpdated",
          "systemsculpt",
          (models: SystemSculptModel[]) => {
            void this.applyProviderModelsUpdate("systemsculpt", models);
          }
        );
        const offCustom = this.plugin.emitter.onProvider(
          "modelsUpdated",
          "custom",
          (models: SystemSculptModel[]) => {
            void this.applyProviderModelsUpdate("custom", models);
          }
        );
        const offLocalPi = this.plugin.emitter.onProvider(
          "modelsUpdated",
          "local-pi",
          (models: SystemSculptModel[]) => {
            void this.applyProviderModelsUpdate("local-pi", models);
          }
        );
        this.registerEmitterListener(offSystem);
        this.registerEmitterListener(offCustom);
        this.registerEmitterListener(offLocalPi);
      }

      void this.refreshAllModels();

      const selectedItems = await modal.openAndGetSelection();
      this.removeAllListeners();
      this.chromeHandle = null;
      this.modalInstance = null;

      if (selectedItems && selectedItems.length > 0) {
        this.onSelect({ modelId: selectedItems[0].id });
      }
    } catch {
      // Keep modal failures non-fatal for callers that offer a selector fallback.
    }
  }
}
