import { App, Notice, setIcon } from "obsidian";
import { StandardModal } from "../../core/ui/modals/standard/StandardModal";
import { ensureCanonicalId } from "../../utils/modelUtils";
import { rankStudioFuzzyItems } from "../studio/StudioFuzzySearch";
import {
  applyChatModelFavorites,
  compareChatModelPickerOptions,
  getChatModelPickerSearchText,
  getChatModelPickerSectionLabel,
  type ChatModelFavoritesState,
  type ChatModelPickerOption,
  type ChatModelSetupTab,
} from "./modelSelection";

type ChatModelPickerFavoritesConfig = {
  state: ChatModelFavoritesState;
  onToggleFavorite: (modelValue: string) => Promise<void> | void;
  onToggleFavoritesOnly: () => Promise<boolean> | boolean;
};

type ChatModelPickerModalOptions = {
  currentValue: string;
  loadOptions: () => Promise<ChatModelPickerOption[]>;
  onSelect: (value: string) => Promise<void> | void;
  onOpenSetup: (targetTab: ChatModelSetupTab) => void;
  favorites?: ChatModelPickerFavoritesConfig;
};

export class ChatModelPickerModal extends StandardModal {
  private readonly options: ChatModelPickerModalOptions;
  private searchInputEl!: HTMLInputElement;
  private clearButtonEl!: HTMLButtonElement;
  private listEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private summaryValueEl!: HTMLElement;
  private favoritesToggleEl: HTMLButtonElement | null = null;
  private rawOptions: ChatModelPickerOption[] = [];
  private loadedOptions: ChatModelPickerOption[] = [];
  private filteredOptions: ChatModelPickerOption[] = [];
  private readonly favoritesState: { favoriteIds: Set<string>; showFavoritesOnly: boolean; favoritesFirst: boolean };
  private selectedIndex = -1;
  private loading = false;

  constructor(app: App, options: ChatModelPickerModalOptions) {
    super(app);
    this.options = options;
    // Own a mutable copy of the favorite ids so per-row toggles update the modal
    // optimistically without mutating the caller's set. Absent favorites config
    // (the default picker) collapses to an identity reorder via applyChatModelFavorites.
    this.favoritesState = {
      favoriteIds: new Set(options.favorites?.state.favoriteIds ?? []),
      showFavoritesOnly: options.favorites?.state.showFavoritesOnly ?? false,
      favoritesFirst: options.favorites?.state.favoritesFirst ?? false,
    };
    this.setSize("medium");
    this.modalEl.addClass("systemsculpt-chat-model-picker-modal");
  }

  onOpen(): void {
    super.onOpen();
    this.footerEl.empty();
    this.footerEl.style.display = "none";

    this.addTitle("Select Chat Model", "Switch models here so the composer can stay compact.");
    this.renderShell();
    this.registerInteractions();
    this.renderLoadingState();

    window.setTimeout(() => {
      this.searchInputEl?.focus();
    }, 0);
    void this.reloadOptions();
  }

  onClose(): void {
    super.onClose();
    this.rawOptions = [];
    this.loadedOptions = [];
    this.filteredOptions = [];
    this.favoritesToggleEl = null;
  }

  private renderShell(): void {
    const bodyEl = this.contentEl.createDiv({ cls: "systemsculpt-chat-model-modal" });

    const summaryEl = bodyEl.createDiv({ cls: "systemsculpt-chat-model-modal-summary" });
    summaryEl.createDiv({
      cls: "systemsculpt-chat-model-modal-summary-label",
      text: "Current for this chat",
    });
    this.summaryValueEl = summaryEl.createDiv({
      cls: "systemsculpt-chat-model-modal-summary-value",
      text: "Loading models…",
    });

    const searchRowEl = bodyEl.createDiv({ cls: "systemsculpt-chat-model-modal-search" });
    const searchIconEl = searchRowEl.createSpan({ cls: "systemsculpt-chat-model-modal-search-icon" });
    setIcon(searchIconEl, "search");

    this.searchInputEl = searchRowEl.createEl("input", {
      cls: "systemsculpt-chat-model-modal-search-input",
      type: "text",
      attr: {
        placeholder: "Search models…",
        "aria-label": "Search chat models",
      },
    });

    this.clearButtonEl = searchRowEl.createEl("button", {
      cls: "systemsculpt-chat-model-modal-search-clear",
      text: "Clear",
      attr: {
        type: "button",
        "aria-label": "Clear chat model search",
      },
    });
    this.clearButtonEl.style.display = "none";

    if (this.options.favorites) {
      this.favoritesToggleEl = searchRowEl.createEl("button", {
        cls: "systemsculpt-chat-model-modal-favorites-toggle",
        attr: {
          type: "button",
          "aria-label": "Show favorites only",
          "aria-pressed": "false",
        },
      });
      const favoritesIconEl = this.favoritesToggleEl.createSpan({
        cls: "systemsculpt-chat-model-modal-favorites-toggle-icon",
      });
      setIcon(favoritesIconEl, "star");
      this.favoritesToggleEl.createSpan({
        cls: "systemsculpt-chat-model-modal-favorites-toggle-label",
        text: "Favorites",
      });
      this.syncFavoritesToggle();
      this.registerDomEvent(this.favoritesToggleEl, "click", () => {
        void this.handleToggleFavoritesOnly();
      });
    }

    this.listEl = bodyEl.createDiv({
      cls: "systemsculpt-chat-model-modal-list",
      attr: { role: "listbox", "aria-label": "Chat models" },
    });

    this.emptyStateEl = bodyEl.createDiv({
      cls: "systemsculpt-chat-model-modal-empty",
      attr: { role: "status", "aria-live": "polite" },
    });
    this.emptyStateEl.style.display = "none";
  }

  private registerInteractions(): void {
    this.registerDomEvent(this.searchInputEl, "input", () => {
      this.syncSearchControls();
      this.applyFilter(this.searchInputEl.value);
    });

    this.registerDomEvent(this.clearButtonEl, "click", () => {
      this.searchInputEl.value = "";
      this.syncSearchControls();
      this.applyFilter("");
      this.searchInputEl.focus();
    });

    this.registerDomEvent(this.modalEl, "keydown", (event: Event) => {
      this.handleKeydown(event as KeyboardEvent);
    });
  }

  private syncSearchControls(): void {
    const hasQuery = this.searchInputEl.value.trim().length > 0;
    this.clearButtonEl.style.display = hasQuery ? "inline-flex" : "none";
  }

  private renderLoadingState(): void {
    this.loading = true;
    this.listEl.empty();
    this.listEl.style.display = "none";
    this.emptyStateEl.style.display = "flex";
    this.emptyStateEl.empty();

    const spinnerEl = this.emptyStateEl.createDiv({ cls: "systemsculpt-chat-model-modal-empty-icon" });
    setIcon(spinnerEl, "loader-2");
    this.emptyStateEl.createDiv({
      cls: "systemsculpt-chat-model-modal-empty-text",
      text: "Loading models…",
    });
  }

  private showEmptyState(
    message: string,
    options: { icon?: string; showRetry?: boolean } = {},
  ): void {
    this.listEl.style.display = "none";
    this.emptyStateEl.style.display = "flex";
    this.emptyStateEl.empty();

    const iconEl = this.emptyStateEl.createDiv({ cls: "systemsculpt-chat-model-modal-empty-icon" });
    setIcon(iconEl, options.icon || "search-x");
    this.emptyStateEl.createDiv({
      cls: "systemsculpt-chat-model-modal-empty-text",
      text: message,
    });

    // An empty/failed dropdown must never be a dead end — always offer a retry
    // so a transient catalog failure is recoverable in place (#206).
    if (options.showRetry) {
      const retryButtonEl = this.emptyStateEl.createEl("button", {
        cls: "systemsculpt-chat-model-modal-empty-retry",
        text: "Retry",
        attr: { type: "button" },
      });
      this.registerDomEvent(retryButtonEl, "click", () => {
        this.renderLoadingState();
        void this.reloadOptions();
      });
    }
  }

  private hideEmptyState(): void {
    this.emptyStateEl.style.display = "none";
    this.listEl.style.display = "";
  }

  private async reloadOptions(): Promise<void> {
    try {
      const loaded = await this.options.loadOptions();
      this.rawOptions = [...loaded];
      this.loading = false;
      this.recomputeOptions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      this.loading = false;
      this.showEmptyState(`Couldn't load models — ${message}`, {
        icon: "alert-triangle",
        showRetry: true,
      });
    }
  }

  /**
   * Re-derive the visible list from the raw catalog and the current favorites
   * state (annotate, favorites-only filter, favorites-first order), then refilter
   * for the active search query. The single funnel for any favorites change.
   */
  private recomputeOptions(): void {
    this.loadedOptions = applyChatModelFavorites(this.rawOptions, this.favoritesState);
    this.applyFilter(this.searchInputEl.value);
  }

  private syncFavoritesToggle(): void {
    if (!this.favoritesToggleEl) {
      return;
    }
    const active = this.favoritesState.showFavoritesOnly;
    this.favoritesToggleEl.classList.toggle("is-active", active);
    this.favoritesToggleEl.setAttribute("aria-pressed", active ? "true" : "false");
  }

  private async handleToggleFavoritesOnly(): Promise<void> {
    if (!this.options.favorites) {
      return;
    }
    try {
      this.favoritesState.showFavoritesOnly = await this.options.favorites.onToggleFavoritesOnly();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      new Notice(`Unable to update the favorites filter: ${message}`, 6000);
      return;
    }
    this.syncFavoritesToggle();
    this.recomputeOptions();
  }

  private async handleToggleFavorite(option: ChatModelPickerOption): Promise<void> {
    if (!this.options.favorites) {
      return;
    }
    const canonicalId = ensureCanonicalId(option.value);
    // Optimistically flip the local set so the star + ordering respond instantly;
    // recompute re-annotates every row from this set as the source of truth.
    if (this.favoritesState.favoriteIds.has(canonicalId)) {
      this.favoritesState.favoriteIds.delete(canonicalId);
    } else {
      this.favoritesState.favoriteIds.add(canonicalId);
    }
    this.recomputeOptions();
    try {
      await this.options.favorites.onToggleFavorite(option.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      new Notice(`Unable to update favorites: ${message}`, 6000);
    }
  }

  private applyFilter(query: string): void {
    const trimmedQuery = String(query || "").trim();
    if (trimmedQuery.length === 0) {
      this.filteredOptions = [...this.loadedOptions];
    } else {
      this.filteredOptions = rankStudioFuzzyItems({
        items: this.loadedOptions,
        query: trimmedQuery,
        getSearchText: getChatModelPickerSearchText,
        compareWhenEqual: compareChatModelPickerOptions,
      });
    }

    if (trimmedQuery.length > 0) {
      this.selectedIndex = this.filteredOptions.length > 0 ? 0 : -1;
    } else {
      const preferredIndex = this.filteredOptions.findIndex((option) => option.value === this.options.currentValue);
      this.selectedIndex = preferredIndex >= 0 ? preferredIndex : this.filteredOptions.length > 0 ? 0 : -1;
    }
    this.renderList(trimmedQuery);
  }

  private renderList(query: string): void {
    this.listEl.empty();

    const currentOption =
      this.loadedOptions.find((option) => option.value === this.options.currentValue) ||
      this.filteredOptions.find((option) => option.value === this.options.currentValue) ||
      null;
    this.summaryValueEl.setText(
      currentOption
        ? [currentOption.label, currentOption.providerLabel].filter(Boolean).join(" • ")
        : "No model selected"
    );

    if (this.filteredOptions.length === 0) {
      if (this.loading) {
        this.renderLoadingState();
      } else if (query) {
        this.showEmptyState(`No models found matching "${query}".`);
      } else {
        this.showEmptyState("No chat models are available right now.", { showRetry: true });
      }
      return;
    }

    this.hideEmptyState();

    let lastSection: string | null = null;
    for (const [index, option] of this.filteredOptions.entries()) {
      if (option.section !== lastSection) {
        lastSection = option.section;
        this.listEl.createDiv({
          cls: "systemsculpt-chat-model-modal-section",
          text: getChatModelPickerSectionLabel(option.section),
        });
      }

      const optionEl = this.listEl.createDiv({
        cls: "systemsculpt-chat-model-modal-option",
        attr: {
          role: "option",
          "aria-selected": option.value === this.options.currentValue ? "true" : "false",
        },
      });
      optionEl.dataset.modelValue = option.value;
      optionEl.dataset.section = option.section;
      optionEl.classList.toggle("is-active", index === this.selectedIndex);
      optionEl.classList.toggle("is-current", option.value === this.options.currentValue);
      optionEl.classList.toggle("is-setup-required", !option.providerAuthenticated);

      const iconEl = optionEl.createDiv({ cls: "systemsculpt-chat-model-modal-option-icon" });
      setIcon(iconEl, option.icon);

      const bodyEl = optionEl.createDiv({ cls: "systemsculpt-chat-model-modal-option-body" });
      const titleRowEl = bodyEl.createDiv({ cls: "systemsculpt-chat-model-modal-option-title-row" });
      titleRowEl.createDiv({
        cls: "systemsculpt-chat-model-modal-option-title",
        text: option.label,
      });
      if (option.description) {
        bodyEl.createDiv({
          cls: "systemsculpt-chat-model-modal-option-description",
          text: option.description,
        });
      }

      const metaEl = optionEl.createDiv({ cls: "systemsculpt-chat-model-modal-option-meta" });
      metaEl.createDiv({
        cls: "systemsculpt-chat-model-modal-pill",
        text: option.providerLabel,
      });
      if (option.contextLabel) {
        metaEl.createDiv({
          cls: "systemsculpt-chat-model-modal-pill is-context",
          text: option.contextLabel,
        });
      }
      if (option.value === this.options.currentValue) {
        metaEl.createDiv({
          cls: "systemsculpt-chat-model-modal-pill is-current",
          text: "Current",
        });
      } else if (!option.providerAuthenticated) {
        metaEl.createDiv({
          cls: "systemsculpt-chat-model-modal-pill is-setup-required",
          text: "Needs setup",
        });
      }

      if (this.options.favorites) {
        const favoriteButtonEl = optionEl.createEl("button", {
          cls: "systemsculpt-chat-model-modal-option-favorite",
          attr: {
            type: "button",
            "aria-label": option.isFavorite ? "Remove from favorites" : "Add to favorites",
            "aria-pressed": option.isFavorite ? "true" : "false",
          },
        });
        favoriteButtonEl.classList.toggle("is-favorite", Boolean(option.isFavorite));
        setIcon(favoriteButtonEl, "star");
        // Starring is a row-local action — it must not bubble up to select the model.
        this.registerDomEvent(favoriteButtonEl, "click", (event: Event) => {
          event.stopPropagation();
          void this.handleToggleFavorite(option);
        });
      }

      this.registerDomEvent(optionEl, "pointermove", () => {
        this.selectedIndex = index;
        this.updateActiveOptionClasses();
      });
      this.registerDomEvent(optionEl, "click", () => {
        void this.activateOption(option);
      });
    }

    this.updateActiveOptionClasses();
  }

  private updateActiveOptionClasses(): void {
    const optionElements = Array.from(
      this.listEl.querySelectorAll<HTMLElement>(".systemsculpt-chat-model-modal-option")
    );
    optionElements.forEach((element, index) => {
      element.classList.toggle("is-active", index === this.selectedIndex);
    });

    if (this.selectedIndex >= 0) {
      const activeElement = optionElements[this.selectedIndex];
      activeElement?.scrollIntoView?.({ block: "nearest" });
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }

    if (this.filteredOptions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.selectedIndex = Math.min(this.filteredOptions.length - 1, this.selectedIndex + 1);
      this.updateActiveOptionClasses();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.updateActiveOptionClasses();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const option = this.filteredOptions[this.selectedIndex];
      if (option) {
        void this.activateOption(option);
      }
    }
  }

  private async activateOption(option: ChatModelPickerOption): Promise<void> {
    if (!option.providerAuthenticated) {
      this.close();
      this.options.onOpenSetup(option.setupSurface.targetTab);
      return;
    }

    this.close();
    if (option.value === this.options.currentValue) {
      return;
    }

    try {
      await this.options.onSelect(option.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      new Notice(`Unable to switch chat model: ${message}`, 6000);
    }
  }
}
