import { App, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { createUiAction, createUiState } from "../core/ui/surface";
import { cancelSurfaceAnimationFrame, requestSurfaceAnimationFrame } from "../core/ui/surface/SurfaceDomContext";
import { flashButtonResult } from "../core/ui/notifications";
import { tryCopyToClipboard } from "../utils/clipboard";
import type {
  PendingEmbeddingFile,
  PendingEmbeddingReason
} from "../services/embeddings/EmbeddingsManager";

export class EmbeddingsPendingFilesModal extends StandardModal {
  private readonly plugin: SystemSculptPlugin;
  private allFiles: PendingEmbeddingFile[] = [];
  private filteredFiles: PendingEmbeddingFile[] = [];
  private summaryContainerEl: HTMLElement | null = null;
  private summaryTextEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private listContentEl: HTMLElement | null = null;
  private rowMeasureEl: HTMLElement | null = null;
  private renderedRows = new Map<number, HTMLElement>();
  // Used only until the typography probe has layout (including detached test hosts).
  private rowHeight = 72;
  private listHeight = 0;
  private renderFrame: number | null = null;
  private listResizeObserver: ResizeObserver | null = null;
  private searchInput: HTMLInputElement | null = null;
  private copyButtons: HTMLButtonElement[] = [];
  private pendingLoad: Promise<void> = Promise.resolve();

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    super.onOpen();

    this.allFiles = [];
    this.filteredFiles = [];
    this.copyButtons = [];
    this.listHeight = 0;

    this.setSize("large");
    this.modalEl.addClass("systemsculpt-pending-files-modal");
    this.addTitle("Remaining Embeddings", "Review the files that still need to finish embedding.");

    this.summaryContainerEl = this.contentEl.createDiv({ cls: "ss-modal__summary" });
    this.summaryTextEl = this.summaryContainerEl.createSpan({
      cls: "ss-modal__summary-text",
      text: "Loading pending files…"
    });
    const summaryActionsEl = this.summaryContainerEl.createDiv({ cls: "ss-modal__summary-actions" });
    const summaryCopyButton = createUiAction(summaryActionsEl, {
      label: "Copy file paths",
      testId: "embeddings.pending.copy-paths",
      icon: "copy",
      size: "small",
      disabled: true,
    });
    this.registerDomEvent(summaryCopyButton, "click", () => {
      void this.copyPaths(summaryCopyButton);
    });
    this.copyButtons.push(summaryCopyButton);

    this.searchInput = this.addSearchBar("embeddings.pending.search", "Filter by file or folder…", (query) => {
      this.applyFilter(query);
    });
    this.searchInput.disabled = true;
    this.registerDomEvent(this.searchInput, "keydown", (event) => {
      if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && this.filteredFiles.length > 0) {
        event.preventDefault();
        this.focusFile(0);
      }
    });

    // A noninteractive typography probe stays mounted while rows are recycled.
    this.rowMeasureEl = this.contentEl.createDiv({
      cls: "ss-pending-files__measure", attr: { "aria-hidden": "true" },
    });
    this.listEl = this.contentEl.createDiv({ cls: "ss-modal__list ss-pending-files__list" });
    this.registerDomEvent(this.listEl, "click", (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-file-path]");
      if (button && !button.disabled && button.dataset.filePath) void this.openFile(button.dataset.filePath);
    });
    this.registerDomEvent(this.listEl, "scroll", () => {
      if (this.renderFrame !== null) return;
      this.renderFrame = requestSurfaceAnimationFrame(this.modalEl, () => {
        this.renderFrame = null;
        this.renderVisibleRows();
      });
    });
    this.registerDomEvent(this.listEl, "keydown", (event) => this.navigateFiles(event));
    const ownerWindow = this.modalEl.ownerDocument.defaultView;
    if (ownerWindow?.ResizeObserver) {
      this.listResizeObserver = new ownerWindow.ResizeObserver(() => {
        this.updateListGeometry();
        this.renderVisibleRows();
      });
      this.listResizeObserver.observe(this.listEl);
      this.listResizeObserver.observe(this.rowMeasureEl);
    }
    createUiState(this.listEl, {
      kind: "loading",
      title: "Collecting pending files",
    });

    const footerCopyButton: HTMLButtonElement = this.addActionButton("embeddings.pending.copy-paths", "Copy file paths", () => {
      void this.copyPaths(footerCopyButton);
    }, false, "copy");
    footerCopyButton.disabled = true;
    this.copyButtons.push(footerCopyButton);
    this.registerDomEvent(footerCopyButton, "keydown", (event) => {
      if (event.key === "Tab" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && this.filteredFiles.length > 0) {
        event.preventDefault();
        this.focusFile(this.filteredFiles.length - 1);
      }
    });

    this.addActionButton("embeddings.pending.close", "Close", () => this.close(), true);

    this.startPendingFilesLoad();
  }

  onClose(): void {
    this.listResizeObserver?.disconnect();
    this.listResizeObserver = null;
    if (this.renderFrame !== null) cancelSurfaceAnimationFrame(this.modalEl, this.renderFrame);
    this.renderFrame = null;
    this.renderedRows.clear();
    this.listContentEl = null;
    this.rowMeasureEl = null;
    super.onClose();
  }

  private startPendingFilesLoad(): void {
    this.pendingLoad = this.loadPendingFiles();
    void this.pendingLoad;
  }

  private async loadPendingFiles(): Promise<void> {
    const task = this.beginAsyncTask("pending-embedding-files");
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      await manager.awaitReady();
      if (!task.isCurrent()) return;
      if (typeof manager.listPendingFiles !== "function") {
        throw new Error("Embeddings manager does not support listing pending files yet.");
      }

      const files = await manager.listPendingFiles();
      if (!task.isCurrent()) return;
      this.allFiles = files;
      this.filteredFiles = [...this.allFiles];

      this.renderList();
      this.setCopyButtonsEnabled(this.allFiles.length > 0);
      if (this.searchInput) {
        this.searchInput.disabled = false;
        this.searchInput.placeholder = "Filter by file or folder…";
      }
      this.updateSummary();
    } catch (error) {
      if (!task.isCurrent()) return;
      this.renderError(error);
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    this.listEl.scrollTop = 0;
    this.listContentEl = null;
    this.renderedRows.clear();

    if (this.filteredFiles.length === 0) {
      createUiState(this.listEl, {
        kind: this.allFiles.length === 0 ? "success" : "empty",
        icon: this.allFiles.length === 0 ? "check" : "search",
        title: this.allFiles.length === 0
          ? "All eligible Markdown files have embeddings"
          : "No files match this filter",
      });
      return;
    }

    this.listContentEl = this.listEl.createDiv({
      cls: "ss-pending-files__content",
      attr: { role: "list", "aria-label": "Files still needing embeddings" },
    });
    this.updateListGeometry();
    this.renderVisibleRows();
  }

  private getListHeight(): number {
    return this.listEl?.clientHeight || this.modalEl.ownerDocument.defaultView?.innerHeight || this.rowHeight;
  }

  private updateListGeometry(): void {
    if (!this.listEl || !this.listContentEl) return;
    // offsetHeight is in layout pixels, unaffected by the modal entrance transform.
    const height = this.rowMeasureEl?.offsetHeight || this.rowHeight;
    const count = this.filteredFiles.length;
    const viewport = this.getListHeight();
    const oldTop = this.listEl.scrollTop;
    // Use the previous viewport when it shrinks; growth may already have clamped
    // scrollTop to the new bottom before ResizeObserver is delivered.
    const bottomViewport = Math.max(this.listHeight, viewport);
    const atBottom = oldTop > 0 && oldTop >= count * this.rowHeight - bottomViewport - 1;
    const anchoredTop = atBottom ? Math.max(0, count * height - viewport) : oldTop / this.rowHeight * height;
    this.rowHeight = height;
    this.listHeight = viewport;
    this.listContentEl.setCssProps({
      "--ss-pending-list-height": `${count * height}px`,
      "--ss-pending-row-height": `${height}px`,
    });
    this.listEl.scrollTop = anchoredTop;
  }

  private renderVisibleRows(): void {
    if (!this.listEl || !this.listContentEl) return;
    const count = this.filteredFiles.length;

    // Keep one neighbor on each side for smooth scrolling; every result remains reachable.
    const start = Math.max(0, Math.min(count - 1, Math.floor(this.listEl.scrollTop / this.rowHeight) - 1));
    const end = Math.min(count, Math.ceil((this.listEl.scrollTop + this.getListHeight()) / this.rowHeight) + 1);
    const visible = new Set<number>();
    for (let index = start; index < end; index++) visible.add(index);
    // Scrolling must not detach the focused action, even when it is off screen.
    const activeElement = this.modalEl.ownerDocument.activeElement;
    let focusedIndex: number | undefined;
    for (const [index, row] of this.renderedRows) {
      if (activeElement && row.contains(activeElement)) {
        visible.add(index);
        focusedIndex = index;
      }
    }
    for (const [index, row] of this.renderedRows) {
      if (!visible.has(index)) {
        row.remove();
        this.renderedRows.delete(index);
      }
    }
    for (const index of visible) {
      let row = this.renderedRows.get(index);
      if (!row) {
        const followingRow = Array.from(this.listContentEl.children).find(
          (child) => Number((child as HTMLElement).dataset.fileIndex) > index,
        );
        row = this.createFileRow(index);
        if (followingRow) this.listContentEl.insertBefore(row, followingRow);
        this.renderedRows.set(index, row);
      }
      row.setCssProps({ "--ss-pending-row-top": `${index * this.rowHeight}px` });
      row.querySelector<HTMLButtonElement>("button")!.tabIndex = index === (focusedIndex ?? start) ? 0 : -1;
    }
  }

  private createFileRow(index: number): HTMLElement {
    const entry = this.filteredFiles[index];
    const row = this.listContentEl!.createDiv({
      cls: "ss-pending-files__row",
      attr: { role: "listitem", "aria-posinset": String(index + 1), "aria-setsize": String(this.filteredFiles.length) },
    });
    row.dataset.fileIndex = String(index);
    const description = this.buildDescription(entry);
    const button = row.createEl("button", {
      cls: "ss-modal__item",
      attr: {
        type: "button", "data-testid": "embeddings.pending.open-file",
        "aria-label": `Open ${entry.path}`, "aria-description": description, title: description,
      },
    });
    if (entry.reason === "failed") button.addClass("ss-modal__item--failed");
    button.createDiv({ cls: "ss-modal__item-title", text: this.extractFileName(entry.path) });
    button.createDiv({ cls: "ss-modal__item-description", text: description });
    button.dataset.filePath = entry.path;
    button.dataset.fileIndex = String(index);
    return row;
  }

  private navigateFiles(event: KeyboardEvent): void {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-file-index]");
    if (!button || !this.listEl || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(button.dataset.fileIndex);
    const last = this.filteredFiles.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = Math.min(last, index + 1); break;
      case "ArrowUp": next = Math.max(0, index - 1); break;
      case "Home": next = 0; break;
      case "End": next = last; break;
      case "Tab":
        if (event.shiftKey ? index === 0 : index === last) return;
        next = index + (event.shiftKey ? -1 : 1);
        break;
      default: return;
    }
    event.preventDefault();
    this.focusFile(next);
  }

  private focusFile(index: number): void {
    if (!this.listEl) return;
    // Refresh before computing a destination, even if a resize callback is pending.
    this.updateListGeometry();
    const top = index * this.rowHeight;
    if (top < this.listEl.scrollTop) this.listEl.scrollTop = top;
    else if (top + this.rowHeight > this.listEl.scrollTop + this.getListHeight()) {
      this.listEl.scrollTop = top + this.rowHeight - this.getListHeight();
    }
    this.renderVisibleRows();
    const nextButton = this.renderedRows.get(index)?.querySelector<HTMLButtonElement>("button");
    if (nextButton) {
      nextButton.focus({ preventScroll: true });
      this.renderVisibleRows();
    }
  }

  private renderError(error: unknown): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const message =
      error instanceof Error && error.message ? error.message : "Unknown error loading pending files.";

    createUiState(this.listEl, {
      kind: "error",
      title: "Couldn’t load pending files",
      detail: message,
      action: {
        label: "Retry",
        testId: "embeddings.pending.retry",
        tone: "primary",
        onSelect: () => this.startPendingFilesLoad(),
      },
    });

    if (this.summaryTextEl) {
      this.summaryTextEl.setText("Unable to load pending files.");
    }

    this.setCopyButtonsEnabled(false);
    if (this.searchInput) {
      this.searchInput.disabled = true;
    }
  }

  private applyFilter(rawQuery: string): void {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
      this.filteredFiles = [...this.allFiles];
    } else {
      this.filteredFiles = this.allFiles.filter((entry) => entry.path.toLowerCase().includes(query));
    }

    this.renderList();
    this.updateSummary();
    this.setCopyButtonsEnabled(this.filteredFiles.length > 0);
  }

  private updateSummary(): void {
    if (!this.summaryTextEl) return;

    if (this.allFiles.length === 0) {
      this.summaryTextEl.setText("All eligible Markdown files already have embeddings.");
      return;
    }

    if (this.filteredFiles.length === this.allFiles.length) {
      this.summaryTextEl.setText(`${this.allFiles.length} files still need embeddings.`);
      return;
    }

    this.summaryTextEl.setText(`${this.filteredFiles.length} of ${this.allFiles.length} files match this filter.`);
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("That file no longer exists.");
      return;
    }

    try {
      await this.app.workspace.getLeaf(false).openFile(file);
      this.close();
    } catch (err) {
      console.error("EmbeddingsPendingFilesModal: failed to open file", err);
      new Notice("Failed to open the selected file.");
    }
  }

  private async copyPaths(button: HTMLButtonElement): Promise<void> {
    const source = this.filteredFiles;
    if (source.length === 0) {
      new Notice("No pending files to copy.");
      return;
    }

    const text = source.map((entry) => entry.path).join("\n");
    try {
      const copied = await tryCopyToClipboard(text, this.modalEl);
      if (!copied) throw new Error("Clipboard unavailable");
      flashButtonResult(button, "Copied");
    } catch (err) {
      console.error("EmbeddingsPendingFilesModal: failed to copy paths", err);
      flashButtonResult(button, "Couldn't copy");
    }
  }

  private extractFileName(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  }

  private buildDescription(entry: PendingEmbeddingFile): string {
    const folder = this.extractFolder(entry.path);
    const modified = entry.lastModified ? `Modified ${this.formatRelativeTime(entry.lastModified)}` : "Modified date unknown";
    const reason = this.formatReason(entry.reason);
    const embedded =
      entry.lastEmbedded && entry.reason !== "missing"
        ? `Last embedded ${this.formatRelativeTime(entry.lastEmbedded)}`
        : "No recorded embedding";

    const segments = [folder, modified, reason];
    if (entry.lastEmbedded) {
      segments.push(embedded);
    }

    if (entry.failureInfo) {
      const failedAgo = this.formatRelativeTime(entry.failureInfo.failedAt);
      segments.push(`Error: ${entry.failureInfo.message} (${failedAgo})`);
    }

    return segments.join(" • ");
  }

  private extractFolder(path: string): string {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash === -1) return "Vault root";
    return path.substring(0, lastSlash) || "Vault root";
  }

  private formatReason(reason: PendingEmbeddingReason): string {
    switch (reason) {
      case "missing":
        return "Never embedded";
      case "modified":
        return "Needs refresh after edits";
      case "schema-mismatch":
        return "AI configuration changed";
      case "metadata-missing":
        return "File metadata missing";
      case "incomplete":
        return "Embedding incomplete (needs finish)";
      case "empty":
        return "Empty note (no content)";
      case "failed":
        return "Failed (retryable)";
      default:
        return "Pending";
    }
  }

  private formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 0) {
      return "just now";
    }

    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;

    if (diff < minute) {
      return "just now";
    }
    if (diff < hour) {
      const minutes = Math.round(diff / minute);
      return `${minutes} min ago`;
    }
    if (diff < day) {
      const hours = Math.round(diff / hour);
      return `${hours} hr${hours === 1 ? "" : "s"} ago`;
    }
    if (diff < week) {
      const days = Math.round(diff / day);
      return `${days} day${days === 1 ? "" : "s"} ago`;
    }

    return new Date(timestamp).toLocaleDateString();
  }

  private setCopyButtonsEnabled(enabled: boolean): void {
    this.copyButtons.forEach((button) => {
      button.disabled = !enabled;
    });
  }
}
