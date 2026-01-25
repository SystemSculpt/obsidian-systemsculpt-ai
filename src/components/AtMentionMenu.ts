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

  private fileCache: CachedFile[] = [];
  private recentFiles: CachedFile[] = [];

  private renderScheduled = false;
  private readonly MAX_RESULTS = 12;

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
      this.refreshFileCache();
    }

    this.scheduleRender(true);
    this.menuEl.style.display = "block";
    this.positionMenu();
  }

  public updateQuery(atIndex: number, tokenEnd: number, query: string): void {
    if (!this.isVisible) {
      this.show(atIndex, tokenEnd, query);
      return;
    }

    this.triggerIndex = atIndex;
    this.tokenEndIndex = tokenEnd;
    this.query = query;
    this.scheduleRender(false);
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

  private scheduleRender(resetSelection: boolean): void {
    if (resetSelection) {
      this.selectedIndex = 0;
    }

    if (this.renderScheduled) return;
    this.renderScheduled = true;

    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (!this.isVisible) return;
      this.rebuildSuggestions();
      this.render();
      this.positionMenu();
    });
  }

  private refreshFileCache(): void {
    const plugin: any = (this.chatView as any).plugin;
    const files: TFile[] = plugin?.vaultFileCache?.getAllFiles?.() || this.chatView.app.vault.getFiles();

    const next: CachedFile[] = [];
    for (const file of files) {
      const pathLower = file.path.toLowerCase();
      const nameLower = file.basename.toLowerCase();
      next.push({
        file,
        pathLower,
        nameLower,
        mtime: typeof file.stat?.mtime === "number" ? file.stat.mtime : 0,
      });
    }

    this.fileCache = next;
    this.recentFiles = [...next].sort((a, b) => b.mtime - a.mtime);
  }

  private rebuildSuggestions(): void {
    const q = this.query.trim().toLowerCase();
    const cm: any = this.chatView.contextManager;

    const items: SuggestionItem[] = [];

    const results: Array<{ entry: CachedFile; score: number; attached: boolean }> = [];
    const limit = this.MAX_RESULTS;

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

    if (!q) {
      for (const entry of this.recentFiles) {
        const attached = !!cm?.hasContextFile?.(`[[${entry.file.path}]]`);
        if (attached) continue;
        consider(entry, 1, attached);
      }
    } else {
      for (const entry of this.fileCache) {
        const attached = !!cm?.hasContextFile?.(`[[${entry.file.path}]]`);
        const score = this.score(q, entry);
        consider(entry, score, attached);
      }
    }

    results.sort((a, b) => {
      if (a.attached !== b.attached) return a.attached ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.file.basename.localeCompare(b.entry.file.basename);
    });

    for (const r of results) {
      items.push({
        kind: "file",
        file: r.entry.file,
        title: r.entry.file.basename,
        description: r.entry.file.path,
        icon: this.iconForFile(r.entry.file),
        attached: r.attached,
      });
    }

    this.suggestions = items;
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = Math.max(0, items.length - 1);
    }
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
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
    if (["mp3", "wav", "ogg", "m4a", "webm"].includes(ext)) return "file-audio";
    return "file-text";
  }

  private render(): void {
    this.listEl.empty();

    if (this.suggestions.length === 0) {
      const empty = this.listEl.createDiv({ cls: "suggestion-item is-selected systemsculpt-at-mention-empty" });
      empty.setText("No files found");
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

    const cm: any = this.chatView.contextManager;

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
    this.menuEl.remove();
    super.onunload();
  }
}
