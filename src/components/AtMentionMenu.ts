import { Component, Notice, TFile, setIcon } from "obsidian";
import type { ChatView } from "../views/chatview/ChatView";

type CachedFile = {
  file: TFile;
  nameLower: string;
  pathLower: string;
  mtime: number;
};

type SuggestionItem =
  | {
      kind: "file";
      file: TFile;
      title: string;
      description: string;
      icon: string;
      attached: boolean;
    };

type ScheduledTask =
  | {
      kind: "timeout";
      id: number;
    }
  | {
      kind: "idle";
      id: number;
    };

export class AtMentionMenu extends Component {
  private readonly chatView: ChatView;
  private readonly inputElement: HTMLTextAreaElement;

  private menuEl: HTMLElement;
  private listEl: HTMLElement;

  private isVisible = false;
  private triggerIndex = -1;
  private tokenEndIndex = -1;
  private query = "";

  private selectedIndex = 0;
  private suggestions: SuggestionItem[] = [];

  private cachedFilesByPath: Map<string, CachedFile> = new Map();

  private readonly MAX_RESULTS = 12;
  private readonly SEARCH_CHUNK_BUDGET_MS = 10;
  private readonly SEARCH_DEBOUNCE_MS = 50;
  private readonly RENDER_THROTTLE_MS = 50;

  private searchRunId = 0;
  private searchStartTimeoutId: number | null = null;
  private scheduledChunk: ScheduledTask | null = null;
  private isSearching = false;
  private lastRenderAt = 0;

  constructor(chatView: ChatView, inputElement: HTMLTextAreaElement) {
    super();
    this.chatView = chatView;
    this.inputElement = inputElement;

    this.menuEl = document.createElement("div");
    this.menuEl.addClass("suggestion-container", "systemsculpt-at-mention-suggest");
    this.menuEl.style.display = "none";

    this.listEl = this.menuEl.createDiv({ cls: "suggestion" });
    document.body.appendChild(this.menuEl);

    this.registerDomEvent(document, "mousedown", (e: MouseEvent) => {
      if (!this.isVisible) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (this.menuEl.contains(target)) return;
      if (this.inputElement.contains(target)) return;
      this.hide();
    });

    this.registerDomEvent(window, "resize", () => {
      if (this.isVisible) this.positionMenu();
    });
  }

  public isOpen(): boolean {
    return this.isVisible;
  }

  public show(atIndex: number, tokenEnd: number, query: string): void {
    const wasVisible = this.isVisible;
    const triggerChanged = atIndex !== this.triggerIndex;

    this.isVisible = true;
    this.triggerIndex = atIndex;
    this.tokenEndIndex = tokenEnd;
    this.query = query;

    if (!wasVisible || triggerChanged) {
      this.selectedIndex = 0;
    }

    this.menuEl.style.display = "block";
    this.positionMenu();
    this.scheduleSearch({ resetSelection: !wasVisible || triggerChanged, immediate: true });
  }

  public updateQuery(atIndex: number, tokenEnd: number, query: string): void {
    if (!this.isVisible) {
      this.show(atIndex, tokenEnd, query);
      return;
    }

    this.triggerIndex = atIndex;
    this.tokenEndIndex = tokenEnd;
    this.query = query;
    this.scheduleSearch({ resetSelection: false, immediate: false });
  }

  public hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.menuEl.style.display = "none";
    this.triggerIndex = -1;
    this.tokenEndIndex = -1;
    this.query = "";
    this.suggestions = [];
    this.selectedIndex = 0;
    this.isSearching = false;
    this.searchRunId++;
    this.cancelScheduledWork();
    this.listEl.empty();
  }

  public handleKeydown(e: KeyboardEvent): boolean {
    if (!this.isVisible) return false;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.selectedIndex = Math.min(this.suggestions.length - 1, this.selectedIndex + 1);
        this.updateSelection();
        return true;
      case "ArrowUp":
        e.preventDefault();
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.updateSelection();
        return true;
      case "Enter":
        e.preventDefault();
        void this.chooseSelected();
        return true;
      case "Escape":
        e.preventDefault();
        this.hide();
        return true;
      default:
        return false;
    }
  }

  private scheduleSearch(options: { resetSelection: boolean; immediate: boolean }): void {
    if (options.resetSelection) {
      this.selectedIndex = 0;
    }

    this.isSearching = true;
    this.searchRunId++;
    const runId = this.searchRunId;

    this.cancelScheduledWork();

    if (this.suggestions.length === 0) {
      this.render();
      this.positionMenu();
    }

    const delay = options.immediate ? 0 : this.SEARCH_DEBOUNCE_MS;
    this.searchStartTimeoutId = window.setTimeout(() => {
      this.searchStartTimeoutId = null;
      this.startSearch(runId);
    }, delay);
  }

  private cancelScheduledWork(): void {
    if (this.searchStartTimeoutId !== null) {
      window.clearTimeout(this.searchStartTimeoutId);
      this.searchStartTimeoutId = null;
    }

    if (!this.scheduledChunk) {
      return;
    }

    const anyWindow = window as any;
    if (this.scheduledChunk.kind === "idle" && typeof anyWindow.cancelIdleCallback === "function") {
      anyWindow.cancelIdleCallback(this.scheduledChunk.id);
    } else if (this.scheduledChunk.kind === "timeout") {
      window.clearTimeout(this.scheduledChunk.id);
    }

    this.scheduledChunk = null;
  }

  private scheduleNextChunk(fn: (deadline?: any) => void): void {
    this.cancelScheduledWork();

    const anyWindow = window as any;
    if (typeof anyWindow.requestIdleCallback === "function") {
      const id = anyWindow.requestIdleCallback(fn, { timeout: 50 });
      this.scheduledChunk = { kind: "idle", id };
      return;
    }

    const id = window.setTimeout(() => fn(), 0);
    this.scheduledChunk = { kind: "timeout", id };
  }

  private now(): number {
    try {
      if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
      }
    } catch {}
    return Date.now();
  }

  private getCachedFile(file: TFile): CachedFile {
    const key = file.path;
    const mtime = typeof file.stat?.mtime === "number" ? file.stat.mtime : 0;
    const cached = this.cachedFilesByPath.get(key);
    if (cached && cached.file === file && cached.mtime === mtime) {
      return cached;
    }

    const entry: CachedFile = {
      file,
      pathLower: file.path.toLowerCase(),
      nameLower: file.basename.toLowerCase(),
      mtime,
    };
    this.cachedFilesByPath.set(key, entry);
    return entry;
  }

  private startSearch(runId: number): void {
    if (!this.isVisible || runId !== this.searchRunId) {
      return;
    }

    const plugin: any = (this.chatView as any).plugin;
    const vaultFileCache: any = plugin?.vaultFileCache;
    const files: ReadonlyArray<TFile> =
      vaultFileCache?.getAllFilesView?.() ||
      vaultFileCache?.getAllFiles?.() ||
      this.chatView.app.vault.getFiles();
    const q = this.query.trim().toLowerCase();
    const cm: any = this.chatView.contextManager;

    const limit = this.MAX_RESULTS;
    const results: Array<{ entry: CachedFile; score: number; attached: boolean }> = [];

    const consider = (entry: CachedFile, score: number, attached: boolean) => {
      if (score <= 0) return;
      if (results.length < limit) {
        results.push({ entry, score, attached });
        return;
      }

      let minIndex = 0;
      let minScore = results[0].score;
      for (let i = 1; i < results.length; i++) {
        if (results[i].score < minScore) {
          minScore = results[i].score;
          minIndex = i;
        }
      }

      if (score <= minScore) return;
      results[minIndex] = { entry, score, attached };
    };

    let index = 0;

    const shouldYield = (deadline: any, start: number) => {
      if (deadline && typeof deadline.timeRemaining === "function") {
        return deadline.timeRemaining() <= 1;
      }
      return this.now() - start >= this.SEARCH_CHUNK_BUDGET_MS;
    };

    const applyAndMaybeRender = (isFinal: boolean) => {
      if (!this.isVisible || runId !== this.searchRunId) return;

      const now = this.now();
      const shouldRender = isFinal || now - this.lastRenderAt >= this.RENDER_THROTTLE_MS;
      if (!shouldRender) return;

      this.lastRenderAt = now;
      this.applyResults(results);
    };

    const runChunk = (deadline?: any) => {
      if (!this.isVisible || runId !== this.searchRunId) {
        return;
      }

      const startedAt = this.now();
      for (; index < files.length; index++) {
        const file = files[index];
        const entry = this.getCachedFile(file);
        const attached = !!cm?.hasContextFile?.(`[[${file.path}]]`);

        if (!q) {
          if (attached) continue;
          consider(entry, entry.mtime + 1, attached);
        } else {
          const score = this.score(q, entry);
          consider(entry, score, attached);
        }

        if (shouldYield(deadline, startedAt)) {
          index++;
          break;
        }
      }

      const finished = index >= files.length;
      applyAndMaybeRender(finished);

      if (!finished) {
        this.scheduleNextChunk(runChunk);
        return;
      }

      this.isSearching = false;
      this.scheduledChunk = null;

      // Ensure the final render + positioning happens even if throttled.
      this.applyResults(results);
    };

    // First chunk: run via idle callback/timeout so we don't block the keypress handler.
    this.scheduleNextChunk(runChunk);
  }

  private applyResults(results: Array<{ entry: CachedFile; score: number; attached: boolean }>): void {
    const items: SuggestionItem[] = [];

    results
      .slice()
      .sort((a, b) => {
        if (a.attached !== b.attached) return a.attached ? 1 : -1;
        if (b.score !== a.score) return b.score - a.score;
        return a.entry.file.basename.localeCompare(b.entry.file.basename);
      })
      .forEach((r) => {
        items.push({
          kind: "file",
          file: r.entry.file,
          title: r.entry.file.basename,
          description: r.entry.file.path,
          icon: this.iconForFile(r.entry.file),
          attached: r.attached,
        });
      });

    this.suggestions = items;
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = Math.max(0, items.length - 1);
    }

    this.render();
    this.positionMenu();
  }

  private score(queryLower: string, entry: CachedFile): number {
    if (!queryLower) return 0;

    if (entry.nameLower === queryLower) return 2000;
    if (entry.pathLower === queryLower) return 1900;

    const nameIndex = entry.nameLower.indexOf(queryLower);
    if (nameIndex !== -1) return 1600 - nameIndex;

    const pathIndex = entry.pathLower.indexOf(queryLower);
    if (pathIndex !== -1) return 1200 - pathIndex;

    return this.fuzzyScore(queryLower, entry.pathLower);
  }

  private fuzzyScore(queryLower: string, targetLower: string): number {
    let score = 0;
    let qi = 0;

    for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
      if (queryLower[qi] === targetLower[ti]) {
        score += 10;
        qi++;
      }
    }

    if (qi !== queryLower.length) return 0;
    return score + Math.max(0, 100 - targetLower.length);
  }

  private iconForFile(file: TFile): string {
    const ext = (file.extension || "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "svg"].includes(ext)) return "image";
    if (["mp3", "wav", "ogg", "m4a", "webm"].includes(ext)) return "file-audio";
    return "file-text";
  }

  private render(): void {
    this.listEl.empty();

    if (this.suggestions.length === 0) {
      const empty = this.listEl.createDiv({ cls: "suggestion-item is-selected systemsculpt-at-mention-empty" });
      empty.setText(this.isSearching ? "Searching…" : "No files found");
      return;
    }

    this.suggestions.forEach((item, index) => {
      const row = this.listEl.createDiv({
        cls: `suggestion-item systemsculpt-at-mention-item ${index === this.selectedIndex ? "is-selected" : ""}${item.attached ? " is-attached" : ""}`,
      });

      const iconEl = row.createSpan({ cls: "systemsculpt-at-mention-item__icon" });
      setIcon(iconEl, item.icon);

      const text = row.createDiv({ cls: "systemsculpt-at-mention-item__text" });
      const title = text.createDiv({ cls: "systemsculpt-at-mention-item__title" });
      title.setText(item.title);

      const desc = text.createDiv({ cls: "systemsculpt-at-mention-item__desc" });
      desc.setText(item.description);

      if (item.attached) {
        const badge = row.createSpan({ cls: "systemsculpt-at-mention-item__badge", attr: { "aria-hidden": "true" } });
        setIcon(badge, "check");
      }

      // NOTE: avoid registerDomEvent here to prevent accumulating handlers across re-renders.
      row.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.updateSelection();
      });

      row.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = index;
        void this.chooseSelected();
      });
    });
  }

  private updateSelection(): void {
    const items = this.listEl.querySelectorAll(".suggestion-item.systemsculpt-at-mention-item");
    items.forEach((el, idx) => {
      el.classList.toggle("is-selected", idx === this.selectedIndex);
    });

    const selected = items[this.selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }

  private positionMenu(): void {
    const inputRect = this.inputElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;

    const width = Math.min(inputRect.width, 520, viewportWidth - 16);
    const left = Math.max(8, Math.min(inputRect.left, viewportWidth - width - 8));

    const spaceAbove = inputRect.top;
    const spaceBelow = window.innerHeight - inputRect.bottom;
    const preferAbove = spaceAbove > spaceBelow;

    this.menuEl.style.position = "fixed";
    this.menuEl.style.left = `${left}px`;
    this.menuEl.style.width = `${width}px`;
    this.menuEl.style.zIndex = "1000";

    if (preferAbove && spaceAbove >= 200) {
      this.menuEl.style.top = "auto";
      this.menuEl.style.bottom = `${window.innerHeight - inputRect.top + 8}px`;
    } else {
      this.menuEl.style.bottom = "auto";
      this.menuEl.style.top = `${inputRect.bottom + 8}px`;
    }
  }

  private removeAtTokenFromInput(): void {
    const value = this.inputElement.value;
    const start = this.triggerIndex;

    if (start < 0 || start >= value.length || value[start] !== "@") {
      return;
    }

    let end = this.tokenEndIndex;
    if (end <= start) {
      end = start + 1;
      while (end < value.length && !/\s/.test(value[end])) {
        end++;
      }
    }

    const before = value.substring(0, start);
    const after = value.substring(end);
    this.inputElement.value = before + after;
    this.inputElement.selectionStart = this.inputElement.selectionEnd = start;
    this.inputElement.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private async chooseSelected(): Promise<void> {
    const item = this.suggestions[this.selectedIndex];
    if (!item) return;

    this.removeAtTokenFromInput();
    this.hide();

    try {
      if (item.attached) {
        this.chatView.app.workspace.openLinkText(item.file.path, "", true);
        this.inputElement.focus();
        return;
      }

      void this.chatView.addFileToContext(item.file);
      this.inputElement.focus();
    } catch (error) {
      new Notice(`Failed to attach: ${error instanceof Error ? error.message : String(error)}`, 5000);
      this.inputElement.focus();
    }
  }

  public onunload(): void {
    this.cancelScheduledWork();
    this.menuEl.remove();
    super.onunload();
  }
}
