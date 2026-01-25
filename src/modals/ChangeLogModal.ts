import { App, setIcon, MarkdownRenderer, Component } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard";
import { ChangeLogService, ChangeLogEntry } from "../services/ChangeLogService";

export interface ChangeLogModalOptions {
  startVersion?: string;
}

export class ChangeLogModal extends StandardModal {
  private options: ChangeLogModalOptions;
  private entries: ChangeLogEntry[] = [];
  private currentIndex: number = 0;
  private notesContainer: HTMLElement | null = null;
  private headerMetaEl: HTMLElement | null = null;
  private prevButton: HTMLButtonElement | null = null;
  private nextButton: HTMLButtonElement | null = null;
  private viewOnGitHubButton: HTMLButtonElement | null = null;
  private component: Component;
  private versionSelectEl: HTMLSelectElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private touchStartX: number | null = null;
  private touchStartY: number | null = null;
  private touchStartTime: number | null = null;

  constructor(app: App, options: ChangeLogModalOptions = {}) {
    super(app);
    this.options = options;
    this.setSize("large");
    this.component = new Component();
    this.modalEl.addClass("ss-changelog-modal");
  }

  async onOpen() {
    super.onOpen();

    this.addTitle("What's New", "Plugin change log");

    // Custom header content: version + date
    const headerMeta = this.headerEl.createDiv({ cls: "ss-modal__subtitle" });
    this.headerMetaEl = headerMeta;

    const controlsRow = this.headerEl.createDiv({ cls: "ss-changelog-header-controls" });
    const versionSelect = controlsRow.createEl("select", { cls: "ss-changelog-version-select" });
    this.registerDomEvent(versionSelect, "change", () => {
      const idx = parseInt(versionSelect.value, 10);
      if (!Number.isNaN(idx)) {
        this.currentIndex = Math.min(Math.max(idx, 0), this.entries.length - 1);
        this.renderCurrent();
      }
    });
    this.versionSelectEl = versionSelect as HTMLSelectElement;

    const container = this.contentEl.createDiv({ cls: "systemsculpt-changelog-modal" });
    this.scrollContainer = container;

    // Notes markdown container
    const notesContainer = container.createDiv({ cls: "markdown-preview-view systemsculpt-changelog-notes" });
    this.notesContainer = notesContainer;

    // Footer actions
    const leftGroup = this.footerEl.createDiv({ cls: "ss-modal__footer-group" });
    const rightGroup = this.footerEl.createDiv({ cls: "ss-modal__footer-group" });

    // Prev/Next navigation
    const prevBtn = leftGroup.createEl("button", { cls: "ss-button ss-button--secondary" });
    setIcon(prevBtn.createSpan("ss-button__icon"), "chevron-left");
    prevBtn.appendChild(document.createTextNode("Previous"));
    prevBtn.addEventListener("click", () => this.goPrevious());
    this.prevButton = prevBtn as HTMLButtonElement;

    const nextBtn = leftGroup.createEl("button", { cls: "ss-button ss-button--secondary" });
    nextBtn.appendChild(document.createTextNode("Next"));
    setIcon(nextBtn.createSpan("ss-button__icon"), "chevron-right");
    nextBtn.addEventListener("click", () => this.goNext());
    this.nextButton = nextBtn as HTMLButtonElement;

    // View on GitHub
    const githubBtn = rightGroup.createEl("button", { cls: "ss-button ss-button--secondary" });
    setIcon(githubBtn.createSpan("ss-button__icon"), "external-link");
    githubBtn.appendChild(document.createTextNode("View on GitHub"));
    githubBtn.addEventListener("click", () => this.openOnGitHub());
    this.viewOnGitHubButton = githubBtn as HTMLButtonElement;

    // Close button
    this.addActionButton("Close", () => this.close(), true);

    this.modalEl.setAttr("tabindex", "-1");
    (this.modalEl as HTMLElement).focus();
    this.registerDomEvent(this.modalEl, "keydown", (e: Event) => {
      const ke = e as KeyboardEvent;
      const target = ke.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (ke.key === "ArrowLeft") this.goPrevious();
      if (ke.key === "ArrowRight") this.goNext();
      if (ke.key === "Home") {
        this.currentIndex = 0;
        this.renderCurrent();
      }
      if (ke.key === "End") {
        this.currentIndex = Math.max(0, this.entries.length - 1);
        this.renderCurrent();
      }
    });

    // Basic swipe navigation for mobile
    this.registerDomEvent(this.modalEl, "touchstart", (e: Event) => {
      const te = e as TouchEvent;
      if (te.touches.length !== 1) return;
      const t = te.touches[0];
      this.touchStartX = t.clientX;
      this.touchStartY = t.clientY;
      this.touchStartTime = Date.now();
    });

    this.registerDomEvent(this.modalEl, "touchend", (e: Event) => {
      const te = e as TouchEvent;
      if (this.touchStartX == null || this.touchStartY == null || this.touchStartTime == null) return;
      const t = te.changedTouches && te.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - this.touchStartX;
      const dy = t.clientY - this.touchStartY;
      const dt = Date.now() - this.touchStartTime;
      this.touchStartX = this.touchStartY = this.touchStartTime = null;
      if (dt > 600) return; // too slow
      if (Math.abs(dx) > 60 && Math.abs(dy) < 40) {
        if (dx < 0) this.goNext();
        else this.goPrevious();
      }
    });

    await this.loadEntries();
    this.populateVersionSelect();
    await this.renderCurrent();
  }

  private async loadEntries(): Promise<void> {
    this.entries = await ChangeLogService.getReleases();
    this.currentIndex = ChangeLogService.findIndexByVersion(this.entries, this.options.startVersion);
    if (this.currentIndex < 0 || this.currentIndex >= this.entries.length) {
      this.currentIndex = 0;
    }
  }

  private async renderCurrent(): Promise<void> {
    if (!this.notesContainer || !this.headerMetaEl) return;
    const entry = this.entries[this.currentIndex];

    // Header meta: Version + date
    this.headerMetaEl.empty();
    const versionEl = this.headerMetaEl.createSpan({ cls: "systemsculpt-changelog-version", text: entry ? `Version ${entry.version}` : "Version" });
    const dotEl = this.headerMetaEl.createSpan({ text: " • " });
    const dateEl = this.headerMetaEl.createSpan({ cls: "systemsculpt-changelog-date", text: entry?.date || "" });

    // Render notes
    this.notesContainer.empty();
    const notesHost = this.notesContainer.createDiv({ cls: "systemsculpt-changelog-notes-inner" });
    const markdown = entry?.notes || "No release notes available.";
    await MarkdownRenderer.renderMarkdown(
      markdown,
      notesHost,
      "systemsculpt-changelog.md",
      this.component
    );

    // Update controls
    this.updateControls();

    // Reset scroll to top on each entry change
    if (this.scrollContainer) {
      this.scrollContainer.scrollTop = 0;
    }
  }

  private updateControls(): void {
    if (!this.prevButton || !this.nextButton || !this.viewOnGitHubButton) return;
    const atStart = this.currentIndex <= 0;
    const atEnd = this.currentIndex >= this.entries.length - 1;
    this.prevButton.disabled = atStart;
    this.nextButton.disabled = atEnd;
    if (this.versionSelectEl) {
      this.versionSelectEl.value = String(this.currentIndex);
    }
  }

  private goPrevious(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.renderCurrent();
    }
  }

  private goNext(): void {
    if (this.currentIndex < this.entries.length - 1) {
      this.currentIndex++;
      this.renderCurrent();
    }
  }

  private openOnGitHub(): void {
    const entry = this.entries[this.currentIndex];
    if (entry?.url) {
      window.open(entry.url, "_blank");
    } else {
      window.open(ChangeLogService.getReleasesPageUrl(), "_blank");
    }
  }

  private populateVersionSelect(): void {
    if (!this.versionSelectEl) return;
    const select = this.versionSelectEl;
    select.empty();
    this.entries.forEach((e, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.text = `${e.version} — ${e.date}`;
      select.appendChild(option);
    });
    select.value = String(this.currentIndex);
  }

  onClose() {
    super.onClose();
    try {
      this.component.unload();
    } catch {}
  }
}


