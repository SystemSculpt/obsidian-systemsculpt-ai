import { Notice } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type {
  SystemSculptSearchEngine,
  SearchHit,
  SearchResponse,
} from "../services/search/SystemSculptSearchEngine";

export class SystemSculptSearchModal extends StandardModal {
  private plugin: SystemSculptPlugin;
  private engine: SystemSculptSearchEngine;
  private searchInputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private metricsEl: HTMLElement | null = null;
  private stateEl: HTMLElement | null = null;
  private embeddings: SearchResponse["embeddings"] | null = null;

  private readonly SEARCH_LIMIT = 80;
  private currentQuery = "";
  private debounceHandle: number | null = null;
  private querySerial = 0;
  private isModalOpen = false;

  constructor(plugin: SystemSculptPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.engine = plugin.getSearchEngine();
    this.embeddings = this.engine.getEmbeddingsIndicator();
    this.setSize("fullwidth");
  }

  onOpen() {
    super.onOpen();
    this.isModalOpen = true;
    this.contentEl.addClass("ss-search__content");

    this.addTitle(
      "SystemSculpt Search",
      "Search your notes. Embeddings join automatically when they are ready."
    );

    const shell = this.contentEl.createDiv({ cls: "ss-search" });

    this.searchInputEl = this.buildSearchBar(shell, "Search your vault...", (value) => this.onSearchChange(value));

    this.stateEl = shell.createDiv({ cls: "ss-search__state" });
    this.metricsEl = shell.createDiv({ cls: "ss-search__metrics" });

    this.listEl = shell.createDiv({ cls: "ss-modal__list ss-search__list" });

    this.addActionButton("Copy Results", () => this.copyResults(), false, "clipboard");
    this.addActionButton("Close", () => this.close(), false, "x");

    setTimeout(() => this.searchInputEl?.focus(), 0);
    void this.renderRecents();
    void this.refreshRecentsAfterWarmIndex();
  }

  onClose() {
    this.isModalOpen = false;
    if (this.debounceHandle) {
      window.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    super.onClose();
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

    this.renderLoading("Searching...");

    const response = await this.engine.search(trimmed, {
      mode: "smart",
      sort: "relevance",
      limit: this.SEARCH_LIMIT,
    });

    if (serial < this.querySerial) return;

    this.renderResponse(response);
  }

  private async renderRecents(options: { showLoading?: boolean } = {}) {
    const serial = ++this.querySerial;
    if (options.showLoading !== false) {
      this.renderLoading("Opening recent notes...");
    }
    const recents = await this.engine.getRecent(25);
    if (serial < this.querySerial) return;
    const indicator = this.engine.getEmbeddingsIndicator();
    this.embeddings = indicator;
    this.renderResults(recents);
    this.renderMetrics({
      totalMs: 0,
      indexedCount: recents.length,
      inspectedCount: recents.length,
      mode: "smart",
      usedEmbeddings: false,
    });
    this.renderState(this.recentsStateText(indicator));
  }

  private async refreshRecentsAfterWarmIndex() {
    await this.engine.warmIndex();
    if (!this.isModalOpen || this.currentQuery.trim().length > 0) return;
    await this.renderRecents({ showLoading: false });
  }

  private renderResponse(response: SearchResponse) {
    this.embeddings = response.embeddings;
    this.renderMetrics(response.stats);
    this.renderState(this.stateTextFor(response));
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

  private renderMetrics(stats: Partial<SearchResponse["stats"]>) {
    if (!this.metricsEl) return;
    const parts: string[] = [];
    if (typeof stats.totalMs === "number") parts.push(`Total ${Math.round(stats.totalMs)} ms`);
    if (typeof stats.lexMs === "number") parts.push(`Notes ${Math.round(stats.lexMs)} ms`);
    if (typeof stats.semMs === "number") parts.push(`Embeddings ${Math.round(stats.semMs)} ms`);
    if (typeof stats.indexMs === "number") parts.push(`Index ${Math.round(stats.indexMs)} ms`);
    if (typeof stats.indexedCount === "number") parts.push(`${stats.indexedCount} indexed`);
    if (typeof stats.inspectedCount === "number") parts.push(`${stats.inspectedCount} checked`);

    this.metricsEl.setText(parts.join(" • "));
  }

  private renderState(message: string) {
    if (!this.stateEl) return;
    this.stateEl.setText(message);
  }

  private stateTextFor(response: SearchResponse): string {
    const usedEmbeddings = response.stats.usedEmbeddings;
    const emb = response.embeddings;
    if (usedEmbeddings) {
      return "Searching notes and embeddings.";
    }
    if (!emb.enabled) {
      return "Searching notes. Embeddings are off.";
    }
    if (!emb.ready || !emb.available) {
      return emb.reason ? `Searching notes. Embeddings unavailable: ${emb.reason}` : "Searching notes. Embeddings are still preparing.";
    }
    const processed = emb.processed ?? 0;
    const total = emb.total ?? 0;
    if (total > 0 && processed / total < 0.75) {
      return "Searching notes. Embeddings will join when more of the vault is indexed.";
    }
    if (response.stats.embeddingsEligible) {
      return "Searching notes. Embeddings checked in, but note matches won.";
    }
    return "Searching notes.";
  }

  private recentsStateText(indicator: SearchResponse["embeddings"]): string {
    if (!indicator.enabled) {
      return "Recent notes. Search will use note text.";
    }
    const processed = indicator.processed ?? 0;
    const total = indicator.total ?? 0;
    if (!indicator.ready || !indicator.available) {
      return "Recent notes. Embeddings are still preparing.";
    }
    if (total > 0 && processed / total < 0.75) {
      return "Recent notes. Embeddings will join after more of the vault is indexed.";
    }
    return "Recent notes. Embeddings are ready for detailed searches.";
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
