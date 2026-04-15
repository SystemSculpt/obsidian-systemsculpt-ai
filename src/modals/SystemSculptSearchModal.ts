import { Notice } from "obsidian";
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
  private querySerial = 0;

  constructor(plugin: SystemSculptPlugin) {
    super(plugin.app);
    this.engine = plugin.getSearchEngine();
    this.setSize("fullwidth");
  }

  onOpen() {
    super.onOpen();
    this.contentEl.addClass("ss-search__content");

    this.addTitle("SystemSculpt Search");

    const shell = this.contentEl.createDiv({ cls: "ss-search" });

    this.searchInputEl = this.buildSearchBar(shell, "Search your vault...", (value) => this.onSearchChange(value));

    this.listEl = shell.createDiv({ cls: "ss-modal__list ss-search__list" });

    this.addActionButton("Copy Results", () => this.copyResults(), false, "clipboard");
    this.addActionButton("Close", () => this.close(), false, "x");

    setTimeout(() => this.searchInputEl?.focus(), 0);
    void this.renderRecents();
  }

  onClose() {
    this.querySerial += 1;
    this.cancelRecentPreviewHydration();
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

    const input = wrapper.createEl("input", {
      type: "text",
      placeholder,
      cls: "ss-search__input",
    });

    const clear = wrapper.createDiv({ cls: "ss-search__clear" });
    clear.setAttr("aria-label", "Clear search");
    clear.style.display = "none";

    this.registerDomEvent(input, "input", () => {
      clear.style.display = input.value ? "flex" : "none";
      onInput(input.value);
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
      await this.renderRecents();
      return;
    }

    this.cancelRecentPreviewHydration();
    this.renderLoading("Searching...");

    const response = await this.engine.search(trimmed, {
      mode: "smart",
      sort: "relevance",
      limit: this.SEARCH_LIMIT,
    });

    if (serial < this.querySerial) return;

    this.renderResponse(response);
  }

  private async renderRecents() {
    const serial = ++this.querySerial;
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

      const header = item.createDiv({ cls: "ss-search__item-top" });
      const titleEl = header.createDiv({ cls: "ss-search__title" });
      titleEl.innerHTML = this.getHighlightedText(result.title, this.currentQuery);

      const badges = header.createDiv({ cls: "ss-search__badges" });
      if (result.origin !== "recent") {
        badges.createSpan({ cls: "ss-search__score", text: `${Math.round((result.score || 0) * 100)}%` });
      }

      const meta = item.createDiv({ cls: "ss-search__meta" });
      meta.setText(`${result.path} • ${this.formatUpdated(result.updatedAt)}${result.size ? ` • ${this.formatSize(result.size)}` : ""}`);

      if (result.excerpt) {
        const excerpt = item.createDiv({ cls: "ss-search__excerpt" });
        excerpt.innerHTML = this.getHighlightedText(result.excerpt, this.currentQuery);
      }

      this.registerDomEvent(item, "click", async () => {
        try {
          await this.app.workspace.openLinkText(result.path, "");
          this.close();
        } catch {
          new Notice(`Failed to open: ${result.path}`);
        }
      });

      this.listEl!.appendChild(item);
    });

    this.makeDraggable(results);
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
    }, 0);
  }

  private cancelRecentPreviewHydration() {
    if (this.recentPreviewHandle) {
      window.clearTimeout(this.recentPreviewHandle);
      this.recentPreviewHandle = null;
    }
  }

  private async hydrateRecentPreviews(paths: string[], serial: number) {
    const previews = await this.engine.getRecentPreviews(paths, 25);
    if (serial !== this.querySerial || this.currentQuery.trim().length > 0 || !this.listEl) {
      return;
    }

    const items = Array.from(this.listEl.querySelectorAll<HTMLElement>(".ss-search__item"));
    items.forEach((item) => {
      const path = item.getAttribute("data-path");
      if (!path || item.querySelector(".ss-search__excerpt")) return;
      const preview = previews.get(path);
      if (!preview) return;
      item.createDiv({ cls: "ss-search__excerpt", text: preview });
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

  private getHighlightedText(text: string, query: string): string {
    if (!query || !query.trim()) {
      return text;
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lc = text.toLowerCase();
    const matches: Array<{ start: number; end: number }> = [];

    terms.forEach((t) => {
      let idx = 0;
      while ((idx = lc.indexOf(t, idx)) > -1) {
        matches.push({ start: idx, end: idx + t.length });
        idx += t.length;
      }
    });

    if (matches.length === 0) return text;

    matches.sort((a, b) => a.start - b.start);
    let result = "";
    let last = 0;

    matches.forEach((m) => {
      if (m.start > last) {
        result += text.slice(last, m.start);
      }
      result += `<mark class="ss-hl">${text.slice(m.start, m.end)}</mark>`;
      last = m.end;
    });

    if (last < text.length) {
      result += text.slice(last);
    }

    return result;
  }

  private makeDraggable(results: SearchHit[]) {
    if (!this.listEl) return;
    const el = this.listEl;
    el.draggable = true;
    el.addClass("scs-draggable");
    this.registerDomEvent(el, "dragstart", (e: Event) => {
      const ev = e as DragEvent;
      if (!ev.dataTransfer) return;
      const payload = {
        type: "search-results",
        query: this.currentQuery,
        results: results.slice(0, 50).map((r) => ({ path: r.path, score: r.score })),
      };
      const text = results.map((r) => r.path).join("\n");
      ev.dataTransfer.setData("text/plain", JSON.stringify(payload));
      ev.dataTransfer.setData("application/json", JSON.stringify(payload));
      ev.dataTransfer.setData("text/uri-list", text);
    });
  }

  private async copyResults() {
    try {
      const items = Array.from(this.listEl?.querySelectorAll(".ss-search__item") || []);
      if (items.length === 0) {
        new Notice("No results to copy.");
        return;
      }
      const paths = items
        .map((el) => el.getAttribute("data-path") || "")
        .filter(Boolean)
        .join("\n");
      await navigator.clipboard.writeText(paths);
      new Notice("Search results copied to clipboard", 3000);
    } catch {
      new Notice("Failed to copy results", 4000);
    }
  }
}
