import { App, setIcon, Notice } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { EmbeddingsPendingFilesModal } from "./EmbeddingsPendingFilesModal";

interface EmbeddingsStats {
  total: number;
  processed: number;
  present: number;
  needsProcessing: number;
  failed: number;
}

export class EmbeddingsStatusModal extends StandardModal {
  private readonly plugin: SystemSculptPlugin;
  private unsubscribes: Array<() => void> = [];
  private updateIntervalId: number | null = null;

  private statusContainerEl: HTMLElement | null = null;
  private providerInfoEl: HTMLElement | null = null;
  private statsGridEl: HTMLElement | null = null;
  private progressSectionEl: HTMLElement | null = null;
  private progressBarEl: HTMLProgressElement | null = null;
  private progressTextEl: HTMLElement | null = null;
  private errorSectionEl: HTMLElement | null = null;
  private errorTextEl: HTMLElement | null = null;
  private actionsContainerEl: HTMLElement | null = null;

  private processButton: HTMLButtonElement | null = null;
  private stopButton: HTMLButtonElement | null = null;
  private retryButton: HTMLButtonElement | null = null;

  private isInErrorState = false;
  private currentErrorMessage: string | null = null;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    super.onOpen();

    this.setSize("medium");
    this.modalEl.addClass("systemsculpt-embeddings-status-modal");
    this.addTitle("Embeddings Status", "Your managed semantic index");

    this.buildModalContent();
    this.setupEventListeners();
    this.startPeriodicUpdates();
    await this.updateDisplay();
  }

  onClose(): void {
    this.stopPeriodicUpdates();
    this.cleanupEventListeners();
    super.onClose();
  }

  private buildModalContent(): void {
    this.statusContainerEl = this.contentEl.createDiv({ cls: "ss-embeddings-status" });

    this.providerInfoEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-provider-card" });

    this.statsGridEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-stats-grid" });

    this.progressSectionEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-progress-section" });
    this.progressSectionEl.addClass("is-hidden");

    const progressHeader = this.progressSectionEl.createDiv({ cls: "ss-embeddings-progress-header" });
    const progressIcon = progressHeader.createSpan({ cls: "ss-embeddings-progress-icon" });
    setIcon(progressIcon, "loader");
    this.progressTextEl = progressHeader.createSpan({ cls: "ss-embeddings-progress-text", text: "Processing..." });

    this.progressBarEl = this.progressSectionEl.createEl("progress", { cls: "ss-embeddings-progress-bar" });
    this.progressBarEl.max = 100;
    this.progressBarEl.value = 0;

    this.errorSectionEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-error-section" });
    this.errorSectionEl.addClass("is-hidden");
    const errorIcon = this.errorSectionEl.createSpan({ cls: "ss-embeddings-error-icon" });
    setIcon(errorIcon, "alert-triangle");
    this.errorTextEl = this.errorSectionEl.createSpan({ cls: "ss-embeddings-error-text" });

    this.actionsContainerEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-actions" });
    this.buildActionButtons();

    this.addActionButton("View Pending Files", () => this.openPendingFiles(), false, "list");
    this.addActionButton("Settings", () => this.openSettings(), false, "settings");
    this.addActionButton("Close", () => this.close(), true);
  }

  private buildActionButtons(): void {
    if (!this.actionsContainerEl) return;
    this.actionsContainerEl.empty();

    this.processButton = this.actionsContainerEl.createEl("button", {
      cls: "ss-embeddings-action-button ss-embeddings-action-button--primary"
    });
    const processIcon = this.processButton.createSpan({ cls: "ss-embeddings-action-icon" });
    setIcon(processIcon, "play");
    this.processButton.appendText("Process Vault");
    this.processButton.addEventListener("click", () => this.startProcessing());

    this.retryButton = this.actionsContainerEl.createEl("button", {
      cls: "ss-embeddings-action-button ss-embeddings-action-button--warning"
    });
    const retryIcon = this.retryButton.createSpan({ cls: "ss-embeddings-action-icon" });
    setIcon(retryIcon, "refresh-cw");
    this.retryButton.appendText("Retry Failed");
    this.retryButton.addClass("is-hidden");
    this.retryButton.addEventListener("click", () => this.retryFailedFiles());

    this.stopButton = this.actionsContainerEl.createEl("button", {
      cls: "ss-embeddings-action-button ss-embeddings-action-button--danger"
    });
    const stopIcon = this.stopButton.createSpan({ cls: "ss-embeddings-action-icon" });
    setIcon(stopIcon, "square");
    this.stopButton.appendText("Stop");
    this.stopButton.addClass("is-hidden");
    this.stopButton.addEventListener("click", () => this.stopProcessing());
  }

  private setupEventListeners(): void {
    try {
      const emitter = this.plugin.emitter;

      this.unsubscribes.push(
        emitter.on("embeddings:processing-start", () => {
          this.clearErrorState();
          void this.updateDisplay();
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:processing-progress", () => {
          void this.updateDisplay();
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:processing-complete", () => {
          void this.updateDisplay();
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:error", (payload: unknown) => {
          const message = this.readErrorMessage(payload);
          this.displayError(message);
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:recovered", () => {
          this.clearErrorState();
          void this.updateDisplay();
        })
      );
    } catch {
    }
  }

  private cleanupEventListeners(): void {
    for (const off of this.unsubscribes) {
      try {
        off();
      } catch {
      }
    }
    this.unsubscribes = [];
  }

  private startPeriodicUpdates(): void {
    this.updateIntervalId = window.setInterval(() => {
      void this.updateDisplay();
    }, 2000);
  }

  private stopPeriodicUpdates(): void {
    if (this.updateIntervalId !== null) {
      window.clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
  }

  private async updateDisplay(): Promise<void> {
    const manager = this.plugin.embeddingsManager;

    if (!manager) {
      this.renderNotInitialized();
      return;
    }

    try {
      await manager.awaitReady();
    } catch {
    }

    const isProcessing = manager.isCurrentlyProcessing();
    const stats = manager.getStats();

    this.renderManagedInfo(isProcessing);
    this.renderStats(stats, isProcessing);
    this.renderProgress(stats, isProcessing);
    this.updateActionButtons(isProcessing, stats);
  }

  private renderNotInitialized(): void {
    const isEnabled = this.plugin.settings.embeddingsEnabled;

    if (this.providerInfoEl) {
      this.providerInfoEl.empty();
      const noticeEl = this.providerInfoEl.createDiv({ cls: "ss-embeddings-notice" });
      const icon = noticeEl.createSpan({ cls: "ss-embeddings-notice-icon" });
      setIcon(icon, isEnabled ? "loader" : "info");
      noticeEl.createSpan({
        text: isEnabled
          ? "Embeddings initializing. Please wait..."
          : "Embeddings not enabled. Enable in settings to start."
      });
    }

    if (this.statsGridEl) {
      this.statsGridEl.empty();
    }

    if (this.progressSectionEl) {
      this.progressSectionEl.addClass("is-hidden");
    }

    if (this.processButton) {
      this.processButton.disabled = true;
    }
  }

  private renderManagedInfo(isProcessing: boolean): void {
    if (!this.providerInfoEl) return;
    this.providerInfoEl.empty();

    const headerRow = this.providerInfoEl.createDiv({ cls: "ss-embeddings-provider-header" });

    headerRow.createDiv({
      cls: `ss-embeddings-status-indicator ${isProcessing ? "ss-embeddings-status-indicator--active" : "ss-embeddings-status-indicator--idle"}`
    });

    const titleEl = headerRow.createDiv({ cls: "ss-embeddings-provider-title" });
    titleEl.createSpan({ text: isProcessing ? "Processing" : "Ready", cls: "ss-embeddings-provider-status" });

    const detailsGrid = this.providerInfoEl.createDiv({ cls: "ss-embeddings-provider-details" });

    this.createDetailItem(detailsGrid, "cpu", "Index", "SystemSculpt managed");
    this.createDetailItem(detailsGrid, "tag", "Schema", "v1");
  }

  private createDetailItem(parent: HTMLElement, icon: string, label: string, value: string): void {
    const item = parent.createDiv({ cls: "ss-embeddings-detail-item" });
    const iconEl = item.createSpan({ cls: "ss-embeddings-detail-icon" });
    setIcon(iconEl, icon);
    item.createSpan({ text: label, cls: "ss-embeddings-detail-label" });
    item.createSpan({ text: value, cls: "ss-embeddings-detail-value" });
  }

  private renderStats(stats: EmbeddingsStats, isProcessing: boolean): void {
    if (!this.statsGridEl) return;
    this.statsGridEl.empty();

    const percentage = stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : 0;

    this.createStatCard(this.statsGridEl, "files", "Total Files", stats.total.toLocaleString(), "Eligible markdown files");
    this.createStatCard(this.statsGridEl, "check-circle", "Processed", stats.processed.toLocaleString(), `${percentage}% complete`);
    this.createStatCard(this.statsGridEl, "clock", "Pending", stats.needsProcessing.toLocaleString(), isProcessing ? "In queue" : "Waiting");

    if (stats.failed > 0) {
      this.createStatCard(this.statsGridEl, "alert-circle", "Failed", stats.failed.toLocaleString(), "Needs retry");
    }
  }

  private createStatCard(parent: HTMLElement, icon: string, label: string, value: string, subtext: string): void {
    const card = parent.createDiv({ cls: "ss-embeddings-stat-card" });
    const iconEl = card.createSpan({ cls: "ss-embeddings-stat-icon" });
    setIcon(iconEl, icon);
    card.createDiv({ text: value, cls: "ss-embeddings-stat-value" });
    card.createDiv({ text: label, cls: "ss-embeddings-stat-label" });
    card.createDiv({ text: subtext, cls: "ss-embeddings-stat-subtext" });
  }

  private renderProgress(stats: EmbeddingsStats, isProcessing: boolean): void {
    if (!this.progressSectionEl || !this.progressBarEl || !this.progressTextEl) return;

    if (!isProcessing) {
      this.progressSectionEl.addClass("is-hidden");
      return;
    }

    this.progressSectionEl.removeClass("is-hidden");

    const percentage = stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : 0;
    this.progressBarEl.value = percentage;
    this.progressTextEl.setText(`Processing ${stats.processed} of ${stats.total} files (${percentage}%)`);
  }

  private displayError(message: string): void {
    this.isInErrorState = true;
    this.currentErrorMessage = message;

    if (this.errorSectionEl && this.errorTextEl) {
      this.errorSectionEl.removeClass("is-hidden");
      this.errorTextEl.setText(message);
    }
  }

  private clearErrorState(): void {
    this.isInErrorState = false;
    this.currentErrorMessage = null;

    if (this.errorSectionEl) {
      this.errorSectionEl.addClass("is-hidden");
    }
  }

  private updateActionButtons(isProcessing: boolean, stats: EmbeddingsStats): void {
    if (this.processButton) {
      this.processButton.toggleClass("is-hidden", isProcessing);
      this.processButton.disabled = stats.needsProcessing === 0;
    }

    if (this.retryButton) {
      const showRetry = !isProcessing && stats.failed > 0;
      this.retryButton.toggleClass("is-hidden", !showRetry);
    }

    if (this.stopButton) {
      this.stopButton.toggleClass("is-hidden", !isProcessing);
    }
  }

  private async startProcessing(): Promise<void> {
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      await manager.processVault();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start processing";
      new Notice(message);
    }
  }

  private async retryFailedFiles(): Promise<void> {
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      await manager.retryFailedFiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to retry";
      new Notice(message);
    }
  }

  private stopProcessing(): void {
    try {
      const manager = this.plugin.embeddingsManager;
      if (manager) {
        manager.suspendProcessing();
        new Notice("Processing stopped");
      }
    } catch {
      new Notice("Failed to stop processing");
    }
  }

  private readErrorMessage(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "An error occurred";
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== "object") return "An error occurred";
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.length > 0 ? message : "An error occurred";
  }

  private openPendingFiles(): void {
    const modal = new EmbeddingsPendingFilesModal(this.app, this.plugin);
    modal.open();
  }

  private openSettings(): void {
    try {
      this.plugin.openSettingsTab("knowledge");
      this.close();
    } catch {
    }
  }
}
