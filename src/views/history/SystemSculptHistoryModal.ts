import { Notice, SearchComponent, setIcon } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { StandardModal } from "../../core/ui/modals/standard/StandardModal";
import type { SystemSculptHistoryEntry } from "./types";

interface SystemSculptHistoryModalOptions {
  loadEntries?: () => Promise<SystemSculptHistoryEntry[]>;
}

export class SystemSculptHistoryModal extends StandardModal {
  private entries: SystemSculptHistoryEntry[] = [];
  private filteredEntries: SystemSculptHistoryEntry[] = [];
  private listEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private searchInput!: SearchComponent;
  private selectedIndex = -1;
  private rowElements: HTMLElement[] = [];
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

    this.addTitle("Open SystemSculpt History", "Search chats and Studio sessions in one place.");
    this.renderSearchBar();
    this.renderContainers();
    this.addActionButton("Close", () => this.close(), false);

    this.registerDomEvent(this.modalEl, "keydown", (event: Event) => {
      this.handleModalKeydown(event as KeyboardEvent);
    });

    await this.reloadEntries();
  }

  private renderSearchBar(): void {
    const searchRow = this.contentEl.createDiv("systemsculpt-history-search");
    this.searchInput = new SearchComponent(searchRow);
    this.searchInput.setPlaceholder("Search chats and Studio sessions...");

    this.searchInput.onChange(() => {
      this.selectedIndex = -1;
      this.applyFilters();
    });

    this.registerDomEvent(this.searchInput.inputEl, "keydown", (event: Event) => {
      this.handleSearchKeydown(event as KeyboardEvent);
    });
  }

  private renderContainers(): void {
    this.listEl = this.contentEl.createDiv("systemsculpt-history-list");
    this.emptyStateEl = this.contentEl.createDiv("systemsculpt-history-empty");
    this.emptyStateEl.style.display = "none";

    const emptyIcon = this.emptyStateEl.createDiv("systemsculpt-history-empty-icon");
    setIcon(emptyIcon, "history");
    this.emptyStateEl.createDiv("systemsculpt-history-empty-text");
  }

  private async reloadEntries(): Promise<void> {
    this.isLoading = true;
    this.showEmptyState("Loading history...");

    try {
      this.entries = await this.loadEntries();
    } catch (error) {
      this.entries = [];
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to load history: ${message}`);
    } finally {
      this.isLoading = false;
      this.applyFilters();
    }
  }

  private async loadEntries(): Promise<SystemSculptHistoryEntry[]> {
    if (this.options.loadEntries) {
      return this.options.loadEntries();
    }

    const historyProviders = await import("./historyProviders");
    return historyProviders.loadSystemSculptHistoryEntries(this.plugin);
  }

  private applyFilters(): void {
    const query = String(this.searchInput?.getValue() || "").trim().toLowerCase();
    if (!query) {
      this.filteredEntries = [...this.entries];
    } else {
      this.filteredEntries = this.entries.filter((entry) => {
        if (entry.searchText.includes(query)) {
          return true;
        }
        return entry.title.toLowerCase().includes(query);
      });
    }

    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();
    this.rowElements = [];

    if (this.isLoading) {
      this.showEmptyState("Loading history...");
      return;
    }

    if (this.filteredEntries.length === 0) {
      const hasQuery = String(this.searchInput?.getValue() || "").trim().length > 0;
      this.showEmptyState(hasQuery ? "No history matches your search." : "No history found.");
      return;
    }

    this.hideEmptyState();

    this.filteredEntries.forEach((entry, index) => {
      const row = this.listEl.createDiv("systemsculpt-history-item");
      row.dataset.kind = entry.kind;
      row.dataset.entryId = entry.id;
      if (index === this.selectedIndex) {
        row.addClass("is-selected");
      }

      const header = row.createDiv("systemsculpt-history-item-header");

      const left = header.createDiv("systemsculpt-history-item-header-left");
      const badge = left.createSpan("systemsculpt-history-item-badge");
      badge.setText(entry.badge);

      const timestamp = header.createDiv("systemsculpt-history-item-time");
      timestamp.setText(this.formatRelativeTime(entry.timestampMs));

      if (typeof entry.toggleFavorite === "function") {
        const favoriteButton = header.createEl("button", {
          cls: "systemsculpt-history-item-favorite",
          attr: {
            type: "button",
            "aria-label": entry.isFavorite ? "Remove favorite" : "Add favorite",
            "aria-pressed": entry.isFavorite ? "true" : "false",
          },
        });
        setIcon(favoriteButton, entry.isFavorite ? "star" : "star-off");
        if (entry.isFavorite) {
          favoriteButton.addClass("is-favorite");
        }

        this.registerDomEvent(favoriteButton, "click", async (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!entry.toggleFavorite) return;
          const nextState = await entry.toggleFavorite();
          entry.isFavorite = nextState;
          this.renderList();
        });
      }

      const titleEl = row.createDiv("systemsculpt-history-item-title");
      titleEl.setText(entry.title);

      const subtitle = row.createDiv("systemsculpt-history-item-subtitle");
      subtitle.setText(entry.subtitle || "");

      this.registerDomEvent(row, "click", async () => {
        await this.openEntry(entry);
      });

      this.rowElements.push(row);
    });
  }

  private async openEntry(entry: SystemSculptHistoryEntry): Promise<void> {
    await entry.openPrimary();
    this.close();
  }

  private showEmptyState(message: string): void {
    this.emptyStateEl.style.display = "flex";
    const textEl = this.emptyStateEl.querySelector(".systemsculpt-history-empty-text");
    if (textEl) {
      textEl.textContent = message;
    }
  }

  private hideEmptyState(): void {
    this.emptyStateEl.style.display = "none";
  }

  private handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.selectNext();
      return;
    }

    if (event.key === "Enter" && this.selectedIndex >= 0) {
      event.preventDefault();
      const entry = this.filteredEntries[this.selectedIndex];
      if (entry) {
        void this.openEntry(entry);
      }
    }
  }

  private handleModalKeydown(event: KeyboardEvent): void {
    const activeEl = document.activeElement;
    if (activeEl === this.searchInput?.inputEl && event.key !== "Escape" && event.key !== "Tab") {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.selectNext();
        break;
      case "ArrowUp":
        event.preventDefault();
        this.selectPrevious();
        break;
      case "Tab":
        event.preventDefault();
        if (event.shiftKey) {
          this.selectPrevious();
        } else {
          this.selectNext();
        }
        break;
      case "Enter":
        event.preventDefault();
        if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredEntries.length) {
          const entry = this.filteredEntries[this.selectedIndex];
          if (entry) {
            void this.openEntry(entry);
          }
        }
        break;
      case "Escape":
        event.preventDefault();
        this.close();
        break;
      default:
        break;
    }
  }

  private selectNext(): void {
    if (this.rowElements.length === 0) return;

    if (this.selectedIndex < 0) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = (this.selectedIndex + 1) % this.rowElements.length;
    }

    this.syncSelection();
  }

  private selectPrevious(): void {
    if (this.rowElements.length === 0) return;

    if (this.selectedIndex < 0) {
      this.selectedIndex = this.rowElements.length - 1;
    } else {
      this.selectedIndex = (this.selectedIndex - 1 + this.rowElements.length) % this.rowElements.length;
    }

    this.syncSelection();
  }

  private syncSelection(): void {
    this.rowElements.forEach((row, index) => {
      row.toggleClass("is-selected", index === this.selectedIndex);
    });

    const active = this.rowElements[this.selectedIndex];
    if (active) {
      active.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
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
