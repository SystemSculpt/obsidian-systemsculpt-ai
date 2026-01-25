import { Notice } from "obsidian";
import SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
  SystemSculptSearchEngine,
  SearchMode,
  SortMode,
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
  private modeButtons: Partial<Record<SearchMode, HTMLButtonElement>> = {};
  private sortButtons: Partial<Record<SortMode, HTMLButtonElement>> = {};
  private embeddings: SearchResponse["embeddings"] | null = null;

  private mode: SearchMode = "smart";
  private sort: SortMode = "relevance";
  private currentQuery = "";
  private debounceHandle: number | null = null;
  private querySerial = 0;

  constructor(plugin: SystemSculptPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.engine = plugin.getSearchEngine();
    this.embeddings = this.engine.getEmbeddingsIndicator();
    this.setSize("fullwidth");
  }

  onOpen() {
    super.onOpen();
    this.contentEl.addClass("ss-search__content");

    this.addTitle(
      "SystemSculpt Search",
      "Fast lexical search with optional semantic lift. Mode indicators show exactly when embeddings are used."
    );

    const shell = this.contentEl.createDiv({ cls: "ss-search" });

    const controlRow = shell.createDiv({ cls: "ss-search__controls" });
    this.buildModeSelector(controlRow);
    this.buildSortToggle(controlRow);

    this.searchInputEl = this.buildSearchBar(shell, "Search your vault...", (value) => this.onSearchChange(value));

    this.stateEl = shell.createDiv({ cls: "ss-search__state" });
    this.metricsEl = shell.createDiv({ cls: "ss-search__metrics" });

    this.listEl = shell.createDiv({ cls: "ss-modal__list ss-search__list" });

    this.addActionButton("Copy Results", () => this.copyResults(), false, "clipboard");
    this.addActionButton("Close", () => this.close(), false, "x");

    setTimeout(() => this.searchInputEl?.focus(), 0);
    void this.renderRecents();
  }

  onClose() {
    if (this.debounceHandle) {
      window.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    super.onClose();
  }

  private buildModeSelector(container: HTMLElement) {
    const group = container.createDiv({ cls: "ss-search__mode-group" });
    const modes: Array<{ id: SearchMode; label: string; desc: string }> = [
      { id: "lexical", label: "Fast", desc: "Pure lexical, zero embeddings" },
      { id: "smart", label: "Smart", desc: "Lexical + embeddings when available" },
      { id: "semantic", label: "Semantic", desc: "Embeddings first" },
    ];

    modes.forEach((mode) => {
      const btn = group.createEl("button", {
        cls: "ss-search__pill ss-search__pill--ghost",
        attr: { "data-mode": mode.id },
      });
      btn.createSpan({ cls: "ss-search__pill-label", text: mode.label });
      btn.createSpan({ cls: "ss-search__pill-desc", text: mode.desc });

      this.registerDomEvent(btn, "click", () => {
        if (btn.disabled) return;
        this.mode = mode.id;
        this.syncModeButtons();
        void this.executeSearch(this.currentQuery);
      });

      this.modeButtons[mode.id] = btn;
    });

    this.syncModeButtons();
    if (this.embeddings) {
      this.syncModeAvailability(this.embeddings);
    }
  }

  private buildSortToggle(container: HTMLElement) {
    const sortWrap = container.createDiv({ cls: "ss-search__sort" });
    const sorts: Array<{ id: SortMode; label: string }> = [
      { id: "relevance", label: "Relevance" },
      { id: "recency", label: "Recency" },
    ];

    sorts.forEach((sort) => {
      const btn = sortWrap.createEl("button", {
        cls: "ss-search__pill ss-search__pill--chip",
        attr: { "data-sort": sort.id },
        text: sort.label,
      });

      this.registerDomEvent(btn, "click", () => {
        this.sort = sort.id;
        this.syncSortButtons();
        void this.executeSearch(this.currentQuery);
      });

      this.sortButtons[sort.id] = btn;
    });

    this.syncSortButtons();
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
    const trimmed = query.trim();
    const serial = ++this.querySerial;

    if (!trimmed) {
      await this.renderRecents();
      return;
    }

    this.renderLoading("Indexing & searching...");

    const response = await this.engine.search(trimmed, {
      mode: this.mode,
      sort: this.sort,
      limit: 80,
    });

    if (serial < this.querySerial) return;

    this.renderResponse(response);
  }

  private async renderRecents() {
    const serial = ++this.querySerial;
    this.renderLoading("Pulling your newest notes...");
    const recents = await this.engine.getRecent(25);
    if (serial < this.querySerial) return;
    const indicator = this.engine.getEmbeddingsIndicator();
    this.embeddings = indicator;
    this.renderResults(recents);
    this.renderMetrics({
      totalMs: 0,
      indexedCount: recents.length,
      inspectedCount: recents.length,
      mode: this.mode,
      usedEmbeddings: false,
    });
    this.syncModeAvailability(indicator);
    this.renderState("Showing your 25 most recent files.");
  }

  private renderResponse(response: SearchResponse) {
    this.embeddings = response.embeddings;
    this.renderMetrics(response.stats);
    this.renderState(this.stateTextFor(response));
    this.syncModeAvailability(response.embeddings);
    this.renderResults(response.results);
  }

  private renderResults(results: SearchHit[]) {
    if (!this.listEl) return;
    this.listEl.empty();

    if (results.length === 0) {
      this.renderEmpty("No matches yet. Try fewer words or switch modes.");
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
      badges.createSpan({
        cls: `ss-search__pill ss-search__pill--${result.origin}`,
        text: this.labelForOrigin(result.origin),
      });
      badges.createSpan({ cls: "ss-search__score", text: `${Math.round((result.score || 0) * 100)}%` });

      const meta = item.createDiv({ cls: "ss-search__meta" });
      meta.setText(`${result.path} • ${this.formatUpdated(result.updatedAt)}${result.size ? ` • ${this.formatSize(result.size)}` : ""}`);

      const excerpt = item.createDiv({ cls: "ss-search__excerpt" });
      if (result.excerpt) {
        excerpt.innerHTML = this.getHighlightedText(result.excerpt, this.currentQuery);
      } else {
        excerpt.setText("No preview available");
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
    if (typeof stats.lexMs === "number") parts.push(`Lex ${Math.round(stats.lexMs)} ms`);
    if (typeof stats.semMs === "number") parts.push(`Semantic ${Math.round(stats.semMs)} ms`);
    if (typeof stats.indexMs === "number") parts.push(`Index ${Math.round(stats.indexMs)} ms`);
    if (typeof stats.indexedCount === "number") parts.push(`${stats.indexedCount} indexed`);
    if (typeof stats.inspectedCount === "number") parts.push(`${stats.inspectedCount} scanned`);

    const modeLabel = stats.mode ? this.labelForMode(stats.mode) : "";
    this.metricsEl.setText(parts.length ? `${modeLabel} • ${parts.join(" • ")}` : modeLabel);
  }

  private renderState(message: string) {
    if (!this.stateEl) return;
    this.stateEl.setText(message);
  }

  private stateTextFor(response: SearchResponse): string {
    const usedEmbeddings = response.stats.usedEmbeddings;
    const emb = response.embeddings;
    if (this.mode === "lexical") {
      return "Fast – fastest path.";
    }
    if (usedEmbeddings) {
      return "Smart blend: embeddings contributed to these results.";
    }
    if (!emb.enabled) {
      return "Embeddings off in settings – running lexical search only.";
    }
    if (!emb.available) {
      return emb.reason ? `Embeddings unavailable: ${emb.reason}` : "Embeddings not ready yet; showing lexical results.";
    }
    return "Embeddings ready but not used for this query (short query or no vectors).";
  }

  private syncModeButtons() {
    Object.entries(this.modeButtons).forEach(([mode, btn]) => {
      if (!btn) return;
      if (mode === this.mode) {
        btn.addClass("is-active");
      } else {
        btn.removeClass("is-active");
      }
    });
  }

  private syncModeAvailability(indicator: SearchResponse["embeddings"]) {
    const embeddingsReady = indicator.enabled && indicator.ready && indicator.available;

    Object.entries(this.modeButtons).forEach(([mode, btn]) => {
      if (!btn) return;
      if (mode === "lexical") {
        btn.disabled = false;
        btn.removeClass("is-disabled");
        return;
      }
      btn.disabled = !embeddingsReady;
      btn.toggleClass("is-disabled", !embeddingsReady);
    });

    if (!embeddingsReady && this.mode !== "lexical") {
      this.mode = "lexical";
      this.syncModeButtons();
    }
  }

  private syncSortButtons() {
    Object.entries(this.sortButtons).forEach(([sort, btn]) => {
      if (!btn) return;
      if (sort === this.sort) {
        btn.addClass("is-active");
      } else {
        btn.removeClass("is-active");
      }
    });
  }

  private labelForOrigin(origin: SearchHit["origin"]): string {
    switch (origin) {
      case "semantic":
        return "Semantic";
      case "blend":
        return "Blended";
      case "recent":
        return "Recent";
      default:
        return "Lexical";
    }
  }

  private labelForMode(mode: SearchMode): string {
    switch (mode) {
      case "lexical":
        return "Fast";
      case "semantic":
        return "Semantic first";
      default:
        return "Smart blend";
    }
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
