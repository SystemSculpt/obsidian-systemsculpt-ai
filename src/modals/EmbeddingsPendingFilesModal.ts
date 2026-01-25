import { App, Notice, TFile, setIcon } from "obsidian";
import SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
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
  private loadingEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private copyButtons: HTMLButtonElement[] = [];

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    super.onOpen();

    this.setSize("large");
    this.modalEl.addClass("systemsculpt-pending-files-modal");
    this.addTitle("Remaining Embeddings", "Review the files that still need to finish embedding.");

    this.summaryContainerEl = this.contentEl.createDiv({ cls: "ss-modal__summary" });
    this.summaryTextEl = this.summaryContainerEl.createSpan({
      cls: "ss-modal__summary-text",
      text: "Loading pending files…"
    });
    const summaryActionsEl = this.summaryContainerEl.createDiv({ cls: "ss-modal__summary-actions" });
    const summaryCopyButton = summaryActionsEl.createEl("button", {
      cls: "ss-button ss-button--secondary",
      attr: { "aria-label": "Copy pending file paths" }
    });
    const summaryCopyIcon = summaryCopyButton.createSpan("ss-button__icon");
    setIcon(summaryCopyIcon, "copy");
    summaryCopyButton.appendChild(document.createTextNode("Copy file paths"));
    summaryCopyButton.disabled = true;
    this.registerDomEvent(summaryCopyButton, "click", () => {
      void this.copyPaths();
    });
    this.copyButtons.push(summaryCopyButton);

    this.searchInput = this.addSearchBar("Filter by file or folder…", (query) => {
      this.applyFilter(query);
    });
    this.searchInput.disabled = true;

    this.listEl = this.contentEl.createDiv({ cls: "ss-modal__list" });
    this.loadingEl = this.listEl.createDiv({
      cls: "ss-modal__loading",
      text: "Collecting pending files…"
    });

    const footerCopyButton = this.addActionButton("Copy file paths", () => {
      void this.copyPaths();
    }, false, "copy");
    footerCopyButton.disabled = true;
    this.copyButtons.push(footerCopyButton);

    this.addActionButton("Close", () => this.close(), true);

    await this.loadPendingFiles();
  }

  private async loadPendingFiles(): Promise<void> {
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      await manager.awaitReady();
      if (typeof manager.listPendingFiles !== "function") {
        throw new Error("Embeddings manager does not support listing pending files yet.");
      }

      this.allFiles = await manager.listPendingFiles();
      this.filteredFiles = [...this.allFiles];

      this.renderList();
      this.setCopyButtonsEnabled(this.allFiles.length > 0);
      if (this.searchInput) {
        this.searchInput.disabled = false;
        this.searchInput.placeholder = "Filter by file or folder…";
      }
      this.updateSummary();
    } catch (error) {
      this.renderError(error);
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    this.loadingEl = null;

    if (this.filteredFiles.length === 0) {
      const emptyState = this.listEl.createDiv({ cls: "ss-modal__empty-state" });
      const iconEl = emptyState.createDiv({ cls: "ss-modal__empty-state-icon" });
      setIcon(iconEl, this.allFiles.length === 0 ? "check" : "search");
      emptyState.createSpan({
        text:
          this.allFiles.length === 0
            ? "All eligible markdown files already have embeddings."
            : "No files match this filter."
      });
      return;
    }

    for (const entry of this.filteredFiles) {
      const itemEl = this.listEl.createDiv({ cls: "ss-modal__item" });
      if (entry.reason === 'failed') {
        itemEl.addClass("ss-modal__item--failed");
      }
      itemEl.tabIndex = 0;
      itemEl.setAttr("role", "button");
      itemEl.setAttr("aria-label", `Open ${entry.path}`);

      const titleEl = itemEl.createDiv({ cls: "ss-modal__item-title" });
      titleEl.setText(this.extractFileName(entry.path));

      const detailEl = itemEl.createDiv({ cls: "ss-modal__item-description" });
      detailEl.setText(this.buildDescription(entry));

      this.registerDomEvent(itemEl, "click", () => {
        void this.openFile(entry.path);
      });
      this.registerDomEvent(itemEl, "keypress", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void this.openFile(entry.path);
        }
      });
    }
  }

  private renderError(error: unknown): void {
    if (!this.listEl) return;
    this.listEl.empty();
    this.loadingEl = null;

    const message =
      error instanceof Error && error.message ? error.message : "Unknown error loading pending files.";

    const errorEl = this.listEl.createDiv({ cls: "ss-modal__error" });
    errorEl.createSpan({ text: message });

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
    this.setCopyButtonsEnabled(this.allFiles.length > 0);
  }

  private updateSummary(): void {
    if (!this.summaryTextEl) return;

    if (this.allFiles.length === 0) {
      this.summaryTextEl.setText("All eligible markdown files already have embeddings.");
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

  private async copyPaths(): Promise<void> {
    const source = this.filteredFiles.length > 0 ? this.filteredFiles : this.allFiles;
    if (source.length === 0) {
      new Notice("No pending files to copy.");
      return;
    }

    const text = source.map((entry) => entry.path).join("\n");
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        this.copyViaFallback(text);
      }

      new Notice(`Copied ${source.length} file path${source.length === 1 ? "" : "s"} to the clipboard.`);
    } catch (err) {
      console.error("EmbeddingsPendingFilesModal: failed to copy paths", err);
      new Notice("Failed to copy paths. Please try again.");
    }
  }

  private copyViaFallback(text: string): void {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
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
        return "Provider/config changed";
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
