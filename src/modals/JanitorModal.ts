import { App, Notice, TFile, TFolder, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { createUiAction, createUiState } from "../core/ui/surface";
import {
  applyVaultCleanup,
  scanVaultCleanup,
  type VaultCleanupGroup,
  type VaultCleanupKind,
  type VaultCleanupPlan,
} from "../services/VaultCleanup";
import {
  JanitorConfirmationListModal,
  formatJanitorFileSize,
  janitorFileIcon,
} from "./JanitorConfirmationListModal";

const SECTIONS: Record<VaultCleanupKind, {
  title: string;
  description: string;
  countLabel: string;
  noun: string;
  emptyLabel: string;
  icon: string;
}> = {
  empty: { title: "Empty content", description: "Empty files and folders.", countLabel: "Files", noun: "items", emptyLabel: "Nothing to remove", icon: "file-text" },
  chat: { title: "Chat history", description: "Saved conversations.", countLabel: "Chats", noun: "chats", emptyLabel: "No chat history", icon: "message-circle" },
  extraction: { title: "Document extractions", description: "Cached document content.", countLabel: "Files", noun: "files", emptyLabel: "No extractions", icon: "file-text" },
  recording: { title: "Audio recordings", description: "Audio files; transcripts stay in your vault.", countLabel: "Files", noun: "files", emptyLabel: "No recordings", icon: "audio-lines" },
};

export class JanitorModal extends StandardModal {
  private isScanning = false;
  private mainContainer!: HTMLElement;
  private loadingState!: HTMLElement;

  constructor(app: App, private readonly plugin: SystemSculptPlugin) {
    super(app);
    this.setSize("large");
  }

  onOpen(): void {
    super.onOpen();
    this.modalEl.addClass("ss-janitor-modal");
    this.addTitle("Janitor", "Review vault cleanup before moving anything to Trash.");
    this.mainContainer = this.contentEl.createDiv({ cls: "ss-janitor-main" });
    this.loadingState = createUiState(this.contentEl, {
      kind: "loading",
      title: "Scanning vault",
      detail: "Checking files and folders.",
    });
    this.loadingState.addClass("ss-janitor-loading");
    this.addActionButton("janitor.refresh", "Refresh", () => void this.loadJanitorData(), false, "refresh-cw");
    this.addActionButton("janitor.close", "Close", () => this.close(), false);
    void this.loadJanitorData();
  }

  private async loadJanitorData(): Promise<void> {
    if (this.isScanning) return;
    const task = this.beginAsyncTask("janitor-scan");
    this.isScanning = true;
    this.showLoading(true);
    try {
      const plan = await scanVaultCleanup(this.app, this.plugin.settings);
      if (!task.isCurrent()) return;
      this.showLoading(false);
      this.renderPlan(plan);
    } catch {
      if (!task.isCurrent()) return;
      this.showLoading(false);
      this.mainContainer.empty();
      createUiState(this.mainContainer, {
        kind: "error",
        title: "Couldn’t scan vault",
        detail: "Failed to scan vault. Please try refreshing.",
        action: { label: "Retry", testId: "janitor.retry", tone: "primary", onSelect: () => void this.loadJanitorData() },
      }).addClass("ss-janitor-error");
    } finally {
      if (task.isCurrent()) this.isScanning = false;
    }
  }

  private renderPlan(plan: VaultCleanupPlan): void {
    this.mainContainer.empty();
    const sections = this.mainContainer.createDiv({ cls: "ss-janitor-sections" });
    for (const group of Object.values(plan)) {
      const definition = SECTIONS[group.kind];
      const section = sections.createDiv({ cls: "ss-janitor-section" });
      const header = section.createDiv({ cls: "ss-janitor-section-header" });
      header.createDiv({ cls: "ss-janitor-section-title", text: definition.title });
      header.createDiv({ cls: "ss-janitor-section-description", text: definition.description });
      const content = section.createDiv({ cls: "ss-janitor-section-content" });
      const stats = content.createDiv({ cls: "ss-janitor-stats" });
      const files = group.items.flatMap((item) => item.file instanceof TFile ? [item.file] : []);
      this.createStatCard(stats, definition.countLabel, files.length, definition.icon);
      if (group.kind === "empty") {
        this.createStatCard(stats, "Folders", group.items.length - files.length, "folder");
      } else {
        this.createStatCard(stats, "Size", formatJanitorFileSize(files), "hard-drive");
      }
      const actions = content.createDiv({ cls: "ss-janitor-actions" });
      createUiAction(actions, {
        label: group.items.length ? `Move ${group.items.length} ${definition.noun} to Trash` : definition.emptyLabel,
        testId: "janitor.move-to-trash",
        tone: group.items.length ? "danger" : "default",
        disabled: group.items.length === 0,
        onSelect: () => void this.confirmCleanup(group),
      }).addClass("ss-janitor-action");
    }
  }

  private async confirmCleanup(group: VaultCleanupGroup): Promise<void> {
    const definition = SECTIONS[group.kind];
    const fileItems = group.items.filter((item) => item.file instanceof TFile);
    const folderItems = group.items.filter((item) => item.file instanceof TFolder);
    const previewItems = (items: typeof group.items) => items.map((item) => ({
      path: item.path,
      icon: item.file instanceof TFile ? janitorFileIcon(item.file.extension) : "folder",
      ...(group.kind !== "empty" ? { detail: formatJanitorFileSize([{ stat: { size: item.size } }]) } : {}),
    }));
    const confirmation = new JanitorConfirmationListModal(this.app, {
      title: `Move ${definition.title} to Trash`,
      description: `${group.items.length} ${group.kind === "empty" ? "empty items" : `files from ${group.directory}`} will move to Obsidian Trash. You can restore them later.`,
      ...(group.kind !== "empty" ? { summary: `${group.items.length} files (${formatJanitorFileSize(group.items.map((item) => ({ stat: { size: item.size } })))})` } : {}),
      groups: group.kind === "empty" ? [
        { title: "Empty Files", icon: "file-text", items: previewItems(fileItems), previewLimit: 5, moreLabel: "files" },
        { title: "Empty Folders", icon: "folder", items: previewItems(folderItems), previewLimit: 5, moreLabel: "folders" },
      ] : [{ items: previewItems(group.items), previewLimit: 10, moreLabel: "files" }],
    });
    const task = this.beginAsyncTask("janitor-confirmation");
    if (!await confirmation.openAndWait() || !task.isCurrent()) return;
    try {
      const { trashed, skipped } = await applyVaultCleanup(this.app, group);
      new Notice(`Moved ${trashed} ${definition.noun} to trash.${skipped ? ` Kept ${skipped} items that changed since review.` : ""}`);
      if (task.isCurrent()) void this.loadJanitorData();
    } catch {
      new Notice(`Couldn’t clear ${definition.title.toLowerCase()}.`);
    }
  }

  private createStatCard(container: HTMLElement, label: string, value: string | number, icon: string): void {
    const card = container.createDiv({ cls: "ss-janitor-stat-card" });
    setIcon(card.createDiv({ cls: "ss-janitor-stat-icon" }), icon);
    const content = card.createDiv({ cls: "ss-janitor-stat-content" });
    content.createDiv({ cls: "ss-janitor-stat-value", text: value.toString() });
    content.createDiv({ cls: "ss-janitor-stat-label", text: label });
  }

  private showLoading(show: boolean): void {
    this.loadingState.toggleAttribute("hidden", !show);
    this.mainContainer.toggleAttribute("hidden", show);
  }

  onClose(): void {
    this.isScanning = false;
    super.onClose();
  }
}
