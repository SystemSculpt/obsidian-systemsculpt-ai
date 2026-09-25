import { Notice } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { StandardModal } from "../../core/ui/modals/standard/StandardModal";
import {
  createUiAction,
  createUiState,
  SurfaceCombobox,
  updateUiAction,
} from "../../core/ui/surface";
import { hasHostCapability } from "../../platform/hostCapabilities";
import type { SystemSculptHistoryEntry } from "./types";

/** Rows rendered at once; "Show more" adds another page. */
const HISTORY_ROW_PAGE = 100;
/** Full-text search starts at this query length, after typing pauses. */
const CONTENT_SEARCH_MIN_CHARACTERS = 2;
const CONTENT_SEARCH_DEBOUNCE_MS = 250;
const DESKTOP_CONTENT_SEARCH_CONCURRENCY = 8;
const PORTABLE_CONTENT_SEARCH_CONCURRENCY = 1;

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

type ContentSearch = Readonly<{
  query: string;
  matches: ReadonlySet<SystemSculptHistoryEntry>;
}>;

interface SystemSculptHistoryModalOptions {
  loadEntries?: (signal?: AbortSignal) => Promise<SystemSculptHistoryEntry[]>;
  /** Chat leaf that launched the modal; chat entries resume into it in place. */
  chatLeaf?: WorkspaceLeaf;
}

export class SystemSculptHistoryModal extends StandardModal {
  private entries: SystemSculptHistoryEntry[] = [];
  private listEl!: HTMLElement;
  private stateEl: HTMLElement | null = null;
  private searchInput!: HTMLInputElement;
  private combobox: SurfaceCombobox<SystemSculptHistoryEntry> | null = null;
  private isLoading = false;
  private showMoreEl!: HTMLButtonElement;
  private rowLimit = HISTORY_ROW_PAGE;
  private matchedCount = 0;
  private activeQuery = "";
  private contentSearch: ContentSearch | null = null;
  private pendingContentQuery: string | null = null;
  private contentSearchTimer: number | null = null;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly options: SystemSculptHistoryModalOptions = {}
  ) {
    super(plugin.app);
    this.setSize("large");
    this.modalEl.addClass("systemsculpt-history-modal");
  }

  onOpen(): void {
    super.onOpen();

    this.addTitle("Open history", "Search chats and Studio sessions in one place.");
    this.renderSearchBar();
    this.renderContainers();
    this.initializeCombobox();
    this.addActionButton("history.close", "Close", () => this.close(), false);

    this.registerDomEvent(this.modalEl, "keydown", (event: Event) => {
      this.handleModalKeydown(event as KeyboardEvent);
    });

    void this.reloadEntries();
  }

  private renderSearchBar(): void {
    this.searchInput = this.addSearchBar(
      "history.search",
      "Search chats and Studio sessions…",
      (query) => this.handleQuery(query),
    );
  }

  private renderContainers(): void {
    this.listEl = this.contentEl.createDiv({
      cls: "systemsculpt-history-list",
      attr: {
        id: "systemsculpt-history-results",
      },
    });
    this.showMoreEl = createUiAction(this.contentEl, {
      label: "Show more",
      testId: "history.show-more",
      size: "small",
    });
    this.showMoreEl.addClass("systemsculpt-history-show-more");
    this.showMoreEl.toggleAttribute("hidden", true);
    this.registerDomEvent(this.showMoreEl, "click", () => {
      this.rowLimit += HISTORY_ROW_PAGE;
      this.combobox?.refresh();
    });
  }

  /**
   * Titles filter on every keystroke. Message text is searched once typing
   * pauses and the query has at least two characters.
   */
  private handleQuery(query: string): void {
    const normalized = normalizeQuery(query);
    if (normalized !== this.activeQuery) {
      this.activeQuery = normalized;
      this.rowLimit = HISTORY_ROW_PAGE;
    }
    this.scheduleContentSearch(normalized);
    this.combobox?.setQuery(query, { writeInput: false });
  }

  private scheduleContentSearch(query: string): void {
    this.cancelContentSearchTimer();
    if (
      query.length < CONTENT_SEARCH_MIN_CHARACTERS
      || this.contentSearch?.query === query
      || !this.entries.some((entry) => entry.loadSearchText)
    ) {
      this.pendingContentQuery = null;
      return;
    }
    this.pendingContentQuery = query;
    const ownerWindow = this.modalEl.ownerDocument.defaultView ?? window;
    this.contentSearchTimer = ownerWindow.setTimeout(() => {
      this.contentSearchTimer = null;
      void this.searchContent(query);
    }, CONTENT_SEARCH_DEBOUNCE_MS);
  }

  private cancelContentSearchTimer(): void {
    if (this.contentSearchTimer === null) return;
    const ownerWindow = this.modalEl.ownerDocument.defaultView ?? window;
    ownerWindow.clearTimeout(this.contentSearchTimer);
    this.contentSearchTimer = null;
  }

  private async searchContent(query: string): Promise<void> {
    const task = this.beginAsyncTask("history-content-search");
    const searchable = this.entries.filter((entry) => entry.loadSearchText);
    const matches = new Set<SystemSculptHistoryEntry>();
    let next = 0;
    const concurrency = hasHostCapability("local-filesystem")
      ? DESKTOP_CONTENT_SEARCH_CONCURRENCY
      : PORTABLE_CONTENT_SEARCH_CONCURRENCY;
    await Promise.all(Array.from(
      { length: Math.min(concurrency, searchable.length) },
      async () => {
        while (next < searchable.length && task.isCurrent()) {
          const entry = searchable[next++];
          try {
            if ((await entry.loadSearchText!()).includes(query)) matches.add(entry);
          } catch {
            // An unreadable chat simply does not match.
          }
        }
      },
    ));
    if (!task.isCurrent()) return;
    this.contentSearch = { query, matches };
    if (this.pendingContentQuery === query) this.pendingContentQuery = null;
    this.combobox?.refresh();
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
        const normalizedQuery = normalizeQuery(query);
        const contentMatches = this.contentSearch?.query === normalizedQuery
          ? this.contentSearch.matches
          : null;
        const matched = normalizedQuery
          ? entries.filter((entry) =>
            entry.searchText.includes(normalizedQuery)
            || entry.title.toLowerCase().includes(normalizedQuery)
            || contentMatches?.has(entry) === true)
          : entries;
        this.matchedCount = matched.length;
        return matched.length > this.rowLimit ? matched.slice(0, this.rowLimit) : matched;
      },
      renderOption: ({ item }) => this.renderEntry(item),
      renderEmpty: ({ query }) => {
        if (this.isLoading) return;
        const normalizedQuery = normalizeQuery(query);
        if (normalizedQuery && this.pendingContentQuery === normalizedQuery) {
          this.showState("loading", "Searching chat text");
          return;
        }
        this.showState(
          "empty",
          normalizedQuery ? "No history matches your search" : "No history yet",
        );
      },
      onRender: () => this.syncShowMore(),
      onResultsChange: (entries) => {
        if (!this.isLoading && entries.length > 0) {
          this.hideState();
        }
      },
      // Row controls are handled here, through the option's own listener,
      // instead of registering a listener per rendered row.
      onCommit: ({ item, event }) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.(".systemsculpt-history-item-favorite")) {
          event.preventDefault();
          event.stopPropagation();
          this.toggleFavorite(item);
          return;
        }
        return this.openEntry(item);
      },
      onEscape: () => this.close(),
    });
  }

  private syncShowMore(): void {
    const remaining = this.matchedCount - this.rowLimit;
    this.showMoreEl.toggleAttribute("hidden", remaining <= 0);
    if (remaining > 0) {
      updateUiAction(this.showMoreEl, {
        label: `Show ${Math.min(remaining, HISTORY_ROW_PAGE)} more`,
      });
    }
  }

  private toggleFavorite(entry: SystemSculptHistoryEntry): void {
    if (!entry.toggleFavorite) return;
    void entry.toggleFavorite().then((nextState) => {
      entry.isFavorite = nextState;
      this.combobox?.refresh();
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
      this.contentSearch = null;
      this.scheduleContentSearch(this.activeQuery);
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
    return historyProviders.loadSystemSculptHistoryEntries(this.plugin, signal);
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
        testId: "history.item.favorite",
        icon: entry.isFavorite ? "star" : "star-off",
        size: "icon",
        selected: entry.isFavorite,
      });
      favoriteButton.addClass("systemsculpt-history-item-favorite");
      if (entry.isFavorite) {
        favoriteButton.addClass("is-favorite");
      }
    }

    const titleEl = row.createDiv("systemsculpt-history-item-title");
    titleEl.setText(entry.title);

    const subtitle = row.createDiv("systemsculpt-history-item-subtitle");
    subtitle.setText(entry.subtitle || "");

    return row;
  }

  private async openEntry(entry: SystemSculptHistoryEntry): Promise<void> {
    await entry.openPrimary(
      entry.kind === "chat" ? this.options.chatLeaf : undefined,
    );
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
        ? { label: "Retry", testId: "history.retry", tone: "primary", onSelect: () => void this.reloadEntries() }
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
    this.cancelContentSearchTimer();
    this.pendingContentQuery = null;
    this.contentSearch = null;
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
