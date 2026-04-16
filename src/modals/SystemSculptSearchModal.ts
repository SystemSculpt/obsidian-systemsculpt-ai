import { Notice, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type {
  SystemSculptSearchEngine,
  SearchHit,
  SearchResponse,
} from "../services/search/SystemSculptSearchEngine";

export class SystemSculptSearchModal extends StandardModal {
  private static nextListId = 0;
  private engine: SystemSculptSearchEngine;
  private searchInputEl: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private activeResultEl: HTMLElement | null = null;

  private readonly SEARCH_LIMIT = 30;
  private readonly RECENT_LIMIT = 25;
  private readonly STABLE_TOP_COUNT = 14;
  private readonly listId = `ss-search-results-${++SystemSculptSearchModal.nextListId}`;
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
    this.setSize("large");
    this.modalEl.addClass("ss-search-modal");
  }

  onOpen() {
    super.onOpen();
    document.body.classList.add("ss-search-open");
    this.contentEl.addClass("ss-search__content");
    this.footerEl.addClass("ss-search__footer");
    this.footerEl.createDiv({ text: "↑/↓ Navigate · Enter Open · Esc Close", cls: "ss-search__hint" });

    const shell = this.contentEl.createDiv({ cls: "ss-search" });
    this.searchInputEl = this.buildSearchBar(shell, "Search your vault...", (value) => this.onSearchChange(value));

    this.statusEl = shell.createDiv({ cls: "ss-search__status" });
    this.statusEl.setAttr("aria-live", "polite");

    this.listEl = shell.createDiv({ cls: "ss-search__list" });
    this.listEl.id = this.listId;
    this.listEl.setAttr("role", "listbox");
    this.listEl.setAttr("aria-label", "Search results");
    this.registerDomEvent(this.listEl, "click", (event) => void this.handleResultClick(event));
    this.registerDomEvent(this.listEl, "keydown", (event) => void this.handleResultKeydown(event as KeyboardEvent));
    this.registerDomEvent(this.listEl, "focusin", (event) => this.handleResultFocus(event));

    setTimeout(() => this.searchInputEl?.focus(), 0);
    void this.renderRecents();
  }

  onClose() {
    document.body.classList.remove("ss-search-open");
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
    this.statusEl = null;
    this.listEl = null;
    this.activeResultEl = null;
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
      attr: {
        role: "combobox",
        autocomplete: "off",
        "aria-label": "Search your vault",
        "aria-autocomplete": "list",
        "aria-controls": this.listId,
        "aria-expanded": "false",
      },
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
      this.focusResult(firstItem);
    });

    this.registerDomEvent(clear, "click", () => {
      input.value = "";
      clear.style.display = "none";
      onInput("");
      this.focusSearchInput();
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
        this.renderResponse(response, { stabilize: true });
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
    try {
      const recents = await this.engine.getRecent(this.RECENT_LIMIT);
      if (serial < this.querySerial) return;
      this.renderResults(recents, { label: "Recent", context: "recent" });
      this.scheduleRecentPreviewHydration(recents, serial);
    } catch {
      if (serial < this.querySerial) return;
      this.setStatus("Recent");
      this.renderEmpty("Could not load recent notes.");
    }
  }

  private renderResponse(response: SearchResponse, options: { stabilize?: boolean } = {}) {
    const count = response.results.length;
    const label = `${count} ${count === 1 ? "result" : "results"}`;
    this.renderResults(response.results, {
      label,
      context: "search",
      stabilize: options.stabilize,
    });
  }

  private renderResults(
    results: SearchHit[],
    options: { label: string; context: "recent" | "search"; stabilize?: boolean }
  ) {
    if (!this.listEl) return;
    const previousState = this.captureListState();
    const orderedResults = options.stabilize
      ? this.stabilizeResults(results, previousState.renderedPaths, previousState.focusedPath)
      : results;

    this.setStatus(options.label);
    this.clearActiveResult();
    this.listEl.empty();
    this.setComboboxExpanded(orderedResults.length > 0);

    if (orderedResults.length === 0) {
      this.renderEmpty(options.context === "recent" ? "No recent notes yet." : "No matches yet. Try fewer words.");
      return;
    }

    orderedResults.forEach((result, index) => {
      const item = document.createElement("div");
      item.className = "ss-search__item";
      item.id = this.resultId(index);
      item.setAttr("data-path", result.path);
      item.setAttr("role", "option");
      item.setAttr("tabindex", "-1");
      item.setAttr("aria-selected", "false");

      const header = item.createDiv({ cls: "ss-search__item-top" });
      const titleEl = header.createDiv({ cls: "ss-search__title" });
      this.appendHighlightedText(titleEl, result.title, this.currentQuery);

      const meta = item.createDiv({ cls: "ss-search__meta" });
      meta.setText([result.path, this.formatUpdated(result.updatedAt)].join(" · "));

      if (result.excerpt) {
        const excerpt = item.createDiv({ cls: "ss-search__excerpt" });
        this.appendHighlightedText(excerpt, result.excerpt, this.currentQuery);
      }

      this.listEl!.appendChild(item);
    });

    this.restoreListState(previousState, options.stabilize === true);
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
      excerpt.setText(preview);
    });
  }

  private renderLoading(text: string) {
    if (!this.listEl) return;
    this.setStatus(text);
    this.listEl.empty();
    this.setComboboxExpanded(false);
    const loading = this.listEl.createDiv("ss-modal__loading ss-search__loading");
    loading.createDiv({ text });
  }

  private renderEmpty(text: string) {
    if (!this.listEl) return;
    this.listEl.empty();
    this.setComboboxExpanded(false);
    this.clearActiveResult();
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

    if (event.key === "Enter") {
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
    const nextItem = items[nextIndex];
    if (nextItem === item && event.key === "ArrowUp") {
      this.focusSearchInput();
      this.clearActiveResult();
      return;
    }
    if (nextItem) this.focusResult(nextItem);
  }

  private handleResultFocus(event: Event) {
    const item = this.findResultItem(event.target);
    if (!item) return;
    this.setActiveResult(item);
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

  private captureListState(): {
    renderedPaths: string[];
    focusedPath: string | null;
    focusedIndex: number;
    hadListFocus: boolean;
    scrollTop: number;
  } {
    const items = this.getResultItems();
    const activeItem = this.findResultItem(document.activeElement);
    const focusedIndex = activeItem ? items.indexOf(activeItem) : -1;
    return {
      renderedPaths: items.map((item) => item.getAttribute("data-path") ?? "").filter(Boolean),
      focusedPath: activeItem?.getAttribute("data-path") ?? null,
      focusedIndex,
      hadListFocus: !!activeItem,
      scrollTop: this.listEl?.scrollTop ?? 0,
    };
  }

  private stabilizeResults(results: SearchHit[], renderedPaths: string[], focusedPath: string | null): SearchHit[] {
    if (renderedPaths.length === 0 || results.length === 0) return results;

    const nextByPath = new Map(results.map((result) => [result.path, result]));
    const preservedPaths = new Set(renderedPaths.slice(0, this.STABLE_TOP_COUNT));
    if (focusedPath) preservedPaths.add(focusedPath);

    const preserved: SearchHit[] = [];
    for (const path of renderedPaths) {
      if (!preservedPaths.has(path)) continue;
      const next = nextByPath.get(path);
      if (next) preserved.push(next);
    }

    if (preserved.length === 0) return results;
    const preservedSet = new Set(preserved.map((result) => result.path));
    const additions = results.filter((result) => !preservedSet.has(result.path));
    return [...preserved, ...additions].slice(0, results.length);
  }

  private restoreListState(state: ReturnType<SystemSculptSearchModal["captureListState"]>, stabilized: boolean) {
    if (!this.listEl) return;

    const focusTarget = state.focusedPath
      ? this.getResultItems().find((item) => item.getAttribute("data-path") === state.focusedPath)
      : null;

    if (!stabilized) {
      if (state.hadListFocus) {
        this.focusSearchInput();
      }
      return;
    }

    this.listEl.scrollTop = state.scrollTop;

    if (state.hadListFocus && state.focusedPath && !focusTarget) {
      this.focusSearchInput(true);
      this.clearActiveResult();
      return;
    }

    const fallback = state.hadListFocus && state.focusedIndex >= 0
      ? this.getResultItems()[Math.min(state.focusedIndex, this.getResultItems().length - 1)]
      : null;
    const item = focusTarget ?? fallback;
    if (item) this.focusResult(item, true);
  }

  private focusSearchInput(preventScroll = false) {
    if (!this.searchInputEl) return;
    try {
      this.searchInputEl.focus({ preventScroll });
    } catch {
      this.searchInputEl.focus();
    }
  }

  private focusResult(item: HTMLElement, preventScroll = false) {
    try {
      item.focus({ preventScroll });
    } catch {
      item.focus();
    }
    this.setActiveResult(item);
  }

  private setActiveResult(activeItem: HTMLElement) {
    if (this.activeResultEl && this.activeResultEl !== activeItem && this.activeResultEl.isConnected) {
      this.activeResultEl.setAttr("aria-selected", "false");
    }
    activeItem.setAttr("aria-selected", "true");
    this.activeResultEl = activeItem;
    this.searchInputEl?.setAttr("aria-activedescendant", activeItem.id);
  }

  private clearActiveResult() {
    if (this.activeResultEl?.isConnected) {
      this.activeResultEl.setAttr("aria-selected", "false");
    }
    this.activeResultEl = null;
    this.searchInputEl?.removeAttribute("aria-activedescendant");
  }

  private setComboboxExpanded(expanded: boolean) {
    this.searchInputEl?.setAttr("aria-expanded", expanded ? "true" : "false");
  }

  private setStatus(text: string) {
    this.statusEl?.setText(text);
  }

  private resultId(index: number): string {
    return `${this.listId}-option-${index}`;
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
}
