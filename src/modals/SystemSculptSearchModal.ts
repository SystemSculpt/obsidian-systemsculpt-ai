import { Notice, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type {
  SystemSculptSearchEngine,
  SearchHit,
  SearchResponse,
} from "../services/search/SystemSculptSearchEngine";

export class SystemSculptSearchModal extends StandardModal {
  private engine: SystemSculptSearchEngine;
  private searchInputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;

  private readonly SEARCH_LIMIT = 80;
  private currentQuery = "";
  private debounceHandle: number | null = null;
  private recentPreviewHandle: number | null = null;
  private indexRefreshHandle: number | null = null;
  private searchAbortController: AbortController | null = null;
  private previewAbortController: AbortController | null = null;
  private querySerial = 0;

  constructor(plugin: SystemSculptPlugin) {
    super(plugin.app);
    this.engine = plugin.getSearchEngine();
    this.setSize("fullwidth");
  }

  onOpen() {
    super.onOpen();
    this.contentEl.addClass("ss-search__content");
    this.footerEl.style.display = "none";

    this.addTitle("SystemSculpt Search");

    const shell = this.contentEl.createDiv({ cls: "ss-search" });
    this.searchInputEl = this.buildSearchBar(shell, "Search your vault...", (value) => this.onSearchChange(value));

    this.listEl = shell.createDiv({ cls: "ss-modal__list ss-search__list" });
    this.listEl.setAttr("role", "listbox");
    this.listEl.setAttr("aria-label", "Search results");
    this.registerDomEvent(this.listEl, "click", (event) => void this.handleResultClick(event));
    this.registerDomEvent(this.listEl, "keydown", (event) => void this.handleResultKeydown(event as KeyboardEvent));

    setTimeout(() => this.searchInputEl?.focus(), 0);
    void this.renderRecents();
  }

  onClose() {
    this.querySerial += 1;
    this.cancelSearch();
    this.cancelRecentPreviewHydration();
    this.cancelIndexRefresh();
    if (this.debounceHandle) {
      window.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    super.onClose();
    this.searchInputEl = null;
    this.listEl = null;
  }

  private buildSearchBar(parent: HTMLElement, placeholder: string, onInput: (value: string) => void): HTMLInputElement {
    const wrapper = parent.createDiv({ cls: "ss-search__input-row" });
    const icon = wrapper.createDiv({ cls: "ss-search__icon" });
    icon.setAttr("aria-hidden", "true");
    setIcon(icon, "search");

    const input = wrapper.createEl("input", {
      type: "text",
      placeholder,
      cls: "ss-search__input",
    });

    const clear = wrapper.createEl("button", {
      type: "button",
      cls: "ss-search__clear",
      attr: {
        "aria-label": "Clear search",
      },
    });
    setIcon(clear, "x");
    clear.style.display = "none";

    this.registerDomEvent(input, "input", () => {
      clear.style.display = input.value ? "flex" : "none";
      onInput(input.value);
    });

    this.registerDomEvent(input, "keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "ArrowDown") return;
      const firstItem = this.getResultItems()[0];
      if (!firstItem) return;
      keyboardEvent.preventDefault();
      firstItem.focus();
    });

    this.registerDomEvent(clear, "click", () => {
      input.value = "";
      clear.style.display = "none";
      onInput("");
      input.focus();
    });

    return input;
  }

  private onSearchChange(query: string) {
    this.currentQuery = query;
    if (query.trim()) {
      this.cancelRecentPreviewHydration();
    }
    if (this.debounceHandle) {
      window.clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = window.setTimeout(() => {
      void this.executeSearch(query);
    }, 180);
  }

  private async executeSearch(query: string) {
    this.currentQuery = query;
    const trimmed = query.trim();
    const serial = ++this.querySerial;

    if (!trimmed) {
      this.cancelSearch();
      this.cancelIndexRefresh();
      await this.renderRecents();
      return;
    }

    this.cancelRecentPreviewHydration();
    this.cancelIndexRefresh();
    this.cancelSearch();

    const controller = new AbortController();
    this.searchAbortController = controller;
    if (!this.hasRenderedResults()) {
      this.renderLoading("Searching...");
    }

    try {
      const response = await this.engine.search(trimmed, {
        mode: "smart",
        sort: "relevance",
        limit: this.SEARCH_LIMIT,
        signal: controller.signal,
      });

      if (serial < this.querySerial || controller.signal.aborted) return;
      this.renderResponse(response);

      if (response.stats.indexingPending && response.stats.metadataOnly) {
        this.scheduleIndexRefresh(trimmed, serial);
      }
    } catch (error) {
      if (this.isAbortError(error) || serial < this.querySerial) return;
      this.renderEmpty("Search failed. Try again.");
    } finally {
      if (this.searchAbortController === controller) {
        this.searchAbortController = null;
      }
    }
  }

  private scheduleIndexRefresh(query: string, serial: number) {
    this.cancelIndexRefresh();
    this.indexRefreshHandle = window.setTimeout(() => {
      this.indexRefreshHandle = null;
      void this.refreshAfterIndexReady(query, serial);
    }, 0);
  }

  private cancelIndexRefresh() {
    if (this.indexRefreshHandle !== null) {
      window.clearTimeout(this.indexRefreshHandle);
      this.indexRefreshHandle = null;
    }
  }

  private async refreshAfterIndexReady(query: string, serial: number) {
    let controller: AbortController | null = null;
    try {
      await this.engine.whenIndexReady();
      if (serial !== this.querySerial || this.currentQuery.trim() !== query || !this.listEl) return;

      controller = new AbortController();
      this.searchAbortController = controller;
      const response = await this.engine.search(query, {
        mode: "smart",
        sort: "relevance",
        limit: this.SEARCH_LIMIT,
        signal: controller.signal,
      });

      if (serial === this.querySerial && !controller.signal.aborted) {
        this.renderResponse(response);
      }
    } catch (error) {
      if (!this.isAbortError(error) && serial === this.querySerial) {
        this.renderEmpty("Search failed. Try again.");
      }
    } finally {
      if (controller && this.searchAbortController === controller) {
        this.searchAbortController = null;
      }
    }
  }

  private async renderRecents() {
    const serial = ++this.querySerial;
    this.cancelRecentPreviewHydration();
    const recents = await this.engine.getRecent(25);
    if (serial < this.querySerial) return;
    this.renderResults(recents);
    this.scheduleRecentPreviewHydration(recents, serial);
  }

  private renderResponse(response: SearchResponse) {
    this.renderResults(response.results);
  }

  private renderResults(results: SearchHit[]) {
    if (!this.listEl) return;
    this.listEl.empty();

    if (results.length === 0) {
      this.renderEmpty("No matches yet. Try fewer words.");
      return;
    }

    results.forEach((result) => {
      const item = document.createElement("div");
      item.className = "ss-search__item";
      item.setAttr("data-path", result.path);
      item.setAttr("role", "option");
      item.setAttr("tabindex", "0");
      item.setAttr("aria-label", `${result.title}, ${result.path}`);

      const header = item.createDiv({ cls: "ss-search__item-top" });
      const titleEl = header.createDiv({ cls: "ss-search__title" });
      this.appendHighlightedText(titleEl, result.title, this.currentQuery);

      const meta = item.createDiv({ cls: "ss-search__meta" });
      const metaParts = [result.path, this.formatUpdated(result.updatedAt)];
      if (result.size) metaParts.push(this.formatSize(result.size));
      meta.setText(metaParts.join(" - "));

      if (result.excerpt) {
        const excerpt = item.createDiv({ cls: "ss-search__excerpt" });
        this.appendHighlightedText(excerpt, result.excerpt, this.currentQuery);
      }

      this.listEl!.appendChild(item);
    });
  }

  private scheduleRecentPreviewHydration(results: SearchHit[], serial: number) {
    this.cancelRecentPreviewHydration();
    const paths = results
      .filter((result) => result.origin === "recent" && !result.excerpt)
      .map((result) => result.path);
    if (paths.length === 0) return;

    this.recentPreviewHandle = window.setTimeout(() => {
      this.recentPreviewHandle = null;
      void this.hydrateRecentPreviews(paths, serial);
    }, 30);
  }

  private cancelRecentPreviewHydration() {
    if (this.recentPreviewHandle) {
      window.clearTimeout(this.recentPreviewHandle);
      this.recentPreviewHandle = null;
    }
    this.previewAbortController?.abort();
    this.previewAbortController = null;
  }

  private async hydrateRecentPreviews(paths: string[], serial: number) {
    const controller = new AbortController();
    this.previewAbortController = controller;
    const previews = await this.engine.getRecentPreviews(paths, 25, controller.signal);
    if (
      controller.signal.aborted ||
      serial !== this.querySerial ||
      this.currentQuery.trim().length > 0 ||
      !this.listEl
    ) {
      return;
    }

    const items = Array.from(this.listEl.querySelectorAll<HTMLElement>(".ss-search__item"));
    items.forEach((item) => {
      const path = item.getAttribute("data-path");
      if (!path || item.querySelector(".ss-search__excerpt")) return;
      const preview = previews.get(path);
      if (!preview) return;
      const excerpt = item.createDiv({ cls: "ss-search__excerpt" });
      this.appendHighlightedText(excerpt, preview, "");
    });
  }

  private renderLoading(text: string) {
    if (!this.listEl) return;
    this.listEl.empty();
    const loading = this.listEl.createDiv("ss-modal__loading ss-search__loading");
    loading.createDiv({ text });
  }

  private renderEmpty(text: string) {
    if (!this.listEl) return;
    this.listEl.empty();
    const empty = this.listEl.createDiv("ss-modal__empty-state ss-search__empty");
    empty.createDiv({ text });
  }

  private async handleResultClick(event: Event) {
    const item = this.findResultItem(event.target);
    if (!item) return;
    await this.openResult(item.getAttribute("data-path"));
  }

  private async handleResultKeydown(event: KeyboardEvent) {
    const item = this.findResultItem(event.target);
    if (!item) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      await this.openResult(item.getAttribute("data-path"));
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = this.getResultItems();
    const currentIndex = items.indexOf(item);
    const nextIndex = event.key === "ArrowDown"
      ? Math.min(items.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
    items[nextIndex]?.focus();
  }

  private async openResult(path: string | null) {
    if (!path) return;
    try {
      await this.app.workspace.openLinkText(path, "");
      this.close();
    } catch {
      new Notice(`Failed to open: ${path}`);
    }
  }

  private findResultItem(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest<HTMLElement>(".ss-search__item");
  }

  private getResultItems(): HTMLElement[] {
    return Array.from(this.listEl?.querySelectorAll<HTMLElement>(".ss-search__item") ?? []);
  }

  private hasRenderedResults(): boolean {
    return this.getResultItems().length > 0;
  }

  private cancelSearch() {
    this.searchAbortController?.abort();
    this.searchAbortController = null;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  private appendHighlightedText(parent: HTMLElement, text: string, query: string) {
    const matches = this.getHighlightRanges(text, query);
    if (matches.length === 0) {
      parent.setText(text);
      return;
    }

    let last = 0;
    for (const match of matches) {
      if (match.start > last) {
        parent.appendText(text.slice(last, match.start));
      }
      const mark = parent.createEl("mark", { cls: "ss-hl" });
      mark.setText(text.slice(match.start, match.end));
      last = match.end;
    }
    if (last < text.length) {
      parent.appendText(text.slice(last));
    }
  }

  private getHighlightRanges(text: string, query: string): Array<{ start: number; end: number }> {
    if (!query || !query.trim()) return [];

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lowerText = text.toLowerCase();
    const rawMatches: Array<{ start: number; end: number }> = [];

    terms.forEach((term) => {
      let idx = 0;
      while ((idx = lowerText.indexOf(term, idx)) > -1) {
        rawMatches.push({ start: idx, end: idx + term.length });
        idx += term.length;
      }
    });

    if (rawMatches.length === 0) return [];
    rawMatches.sort((a, b) => a.start - b.start || b.end - a.end);

    const merged: Array<{ start: number; end: number }> = [];
    for (const match of rawMatches) {
      const previous = merged[merged.length - 1];
      if (!previous || match.start > previous.end) {
        merged.push({ ...match });
      } else {
        previous.end = Math.max(previous.end, match.end);
      }
    }
    return merged;
  }

  private formatUpdated(ts?: number): string {
    if (!ts) return "No date";
    const date = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    const day = 1000 * 60 * 60 * 24;
    if (diff < day) return "Updated today";
    if (diff < 7 * day) return `${Math.round(diff / day)}d ago`;
    return date.toLocaleDateString();
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
