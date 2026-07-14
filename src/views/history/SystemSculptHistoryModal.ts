import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { StandardModal } from "../../core/ui/modals/standard/StandardModal";
import {
  createUiAction,
  createUiState,
  SurfaceCombobox,
} from "../../core/ui/surface";
import type { SystemSculptHistoryEntry } from "./types";

interface SystemSculptHistoryModalOptions {
  loadEntries?: (signal?: AbortSignal) => Promise<SystemSculptHistoryEntry[]>;
}

export class SystemSculptHistoryModal extends StandardModal {
  private entries: SystemSculptHistoryEntry[] = [];
  private listEl!: HTMLElement;
  private stateEl: HTMLElement | null = null;
  private searchInput!: HTMLInputElement;
  private combobox: SurfaceCombobox<SystemSculptHistoryEntry> | null = null;
  private isLoading = false;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly options: SystemSculptHistoryModalOptions = {}
  ) {
    super(plugin.app);
    this.setSize("large");
    this.modalEl.addClass("systemsculpt-history-modal");
  }

  async onOpen(): Promise<void> {
    super.onOpen();

    this.addTitle("Open history", "Search chats and Studio sessions in one place.");
    this.renderSearchBar();
    this.renderContainers();
    this.initializeCombobox();
    this.addActionButton("Close", () => this.close(), false);

    this.registerDomEvent(this.modalEl, "keydown", (event: Event) => {
      this.handleModalKeydown(event as KeyboardEvent);
    });

    await this.reloadEntries();
  }

  private renderSearchBar(): void {
    this.searchInput = this.addSearchBar(
      "Search chats and Studio sessions…",
      (query) => this.combobox?.setQuery(query, { writeInput: false }),
    );
  }

  private renderContainers(): void {
    this.listEl = this.contentEl.createDiv({
      cls: "systemsculpt-history-list",
      attr: {
        id: "systemsculpt-history-results",
      },
    });
  }

  private initializeCombobox(): void {
    this.combobox?.destroy();
    this.combobox = new SurfaceCombobox<SystemSculptHistoryEntry>({
      input: this.searchInput,
      listbox: this.listEl,
      listboxId: "systemsculpt-history-results",
      listboxLabel: "History results",
      initiallyOpen: true,
      bindInputEvents: false,
      activeMode: "none",
      navigation: "wrap",
      selectionFollowsActive: true,
      activeClass: "is-selected",
      scrollBehavior: "smooth",
      getItemKey: (entry) => `${entry.kind}:${entry.id}`,
      filterItems: (entries, query) => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return entries;
        return entries.filter((entry) =>
          entry.searchText.includes(normalizedQuery)
          || entry.title.toLowerCase().includes(normalizedQuery));
      },
      renderOption: ({ item }) => this.renderEntry(item),
      renderEmpty: ({ query }) => {
        if (this.isLoading) return;
        this.showState(
          "empty",
          query.trim() ? "No history matches your search" : "No history yet",
        );
      },
      onResultsChange: (entries) => {
        if (!this.isLoading && entries.length > 0) {
          this.hideState();
        }
      },
      onCommit: ({ item }) => this.openEntry(item),
      onEscape: () => this.close(),
    });
  }

  private async reloadEntries(): Promise<void> {
    const task = this.beginAsyncTask("history-entries");
    this.isLoading = true;
    this.combobox?.setBusy(true);
    this.showState("loading", "Loading history");

    try {
      const entries = await this.loadEntries(task.signal);
      if (!task.isCurrent()) return;
      this.entries = entries;
    } catch (error) {
      if (!task.isCurrent()) return;
      this.entries = [];
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to load history: ${message}`);
      this.combobox?.setItems([]);
      this.showState("error", "Couldn’t load history", message);
      return;
    } finally {
      if (task.isCurrent()) {
        this.isLoading = false;
        this.combobox?.setBusy(false);
      }
    }
    if (task.isCurrent()) {
      this.combobox?.setItems(this.entries);
    }
  }

  private async loadEntries(signal?: AbortSignal): Promise<SystemSculptHistoryEntry[]> {
    if (this.options.loadEntries) {
      return this.options.loadEntries(signal);
    }

    const historyProviders = await import("./historyProviders");
    return historyProviders.loadSystemSculptHistoryEntries(this.plugin);
  }

  private renderEntry(entry: SystemSculptHistoryEntry): HTMLElement {
    const row = this.listEl.createDiv("systemsculpt-history-item");
    row.dataset.kind = entry.kind;
    row.dataset.entryId = entry.id;

    const header = row.createDiv("systemsculpt-history-item-header");

    const left = header.createDiv("systemsculpt-history-item-header-left");
    if (entry.badge) {
      const badge = left.createSpan("systemsculpt-history-item-badge");
      badge.setText(entry.badge);
    }

    const timestamp = header.createDiv("systemsculpt-history-item-time");
    timestamp.setText(this.formatRelativeTime(entry.timestampMs));

    if (typeof entry.toggleFavorite === "function") {
      const favoriteButton = createUiAction(header, {
        label: entry.isFavorite ? "Remove favorite" : "Add favorite",
        icon: entry.isFavorite ? "star" : "star-off",
        size: "icon",
        selected: entry.isFavorite,
      });
      favoriteButton.addClass("systemsculpt-history-item-favorite");
      if (entry.isFavorite) {
        favoriteButton.addClass("is-favorite");
      }

      this.registerDomEvent(favoriteButton, "click", async (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!entry.toggleFavorite) return;
        const nextState = await entry.toggleFavorite();
        entry.isFavorite = nextState;
        this.combobox?.refresh();
      });
    }

    const titleEl = row.createDiv("systemsculpt-history-item-title");
    titleEl.setText(entry.title);

    const subtitle = row.createDiv("systemsculpt-history-item-subtitle");
    subtitle.setText(entry.subtitle || "");

    return row;
  }

  private async openEntry(entry: SystemSculptHistoryEntry): Promise<void> {
    await entry.openPrimary();
    this.close();
  }

  private showState(
    kind: "loading" | "empty" | "error",
    title: string,
    detail?: string,
  ): void {
    this.stateEl?.remove();
    this.listEl.toggleAttribute("hidden", true);
    this.stateEl = createUiState(this.contentEl, {
      kind,
      icon: kind === "empty" ? "history" : undefined,
      title,
      detail,
      action: kind === "error"
        ? { label: "Retry", tone: "primary", onSelect: () => void this.reloadEntries() }
        : undefined,
    });
    this.stateEl.addClass("systemsculpt-history-state");
  }

  private hideState(): void {
    this.stateEl?.remove();
    this.stateEl = null;
    this.listEl.toggleAttribute("hidden", false);
  }

  private handleModalKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  onClose(): void {
    this.combobox?.destroy();
    this.combobox = null;
    this.stateEl = null;
    this.isLoading = false;
    super.onClose();
  }

  private formatRelativeTime(timestampMs: number): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return "Unknown time";
    }

    const elapsedMs = Date.now() - timestampMs;
    if (elapsedMs < 0) {
      return "Just now";
    }

    const seconds = Math.floor(elapsedMs / 1000);
    if (seconds < 60) {
      return `${seconds}s ago`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }

    const days = Math.floor(hours / 24);
    if (days < 7) {
      return `${days}d ago`;
    }

    const date = new Date(timestampMs);
    return date.toLocaleDateString();
  }
}
