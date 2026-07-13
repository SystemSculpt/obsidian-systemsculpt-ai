import { App, setIcon, Notice } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { EmbeddingsPendingFilesModal } from "./EmbeddingsPendingFilesModal";
import {
  deriveEmbeddingsIndexPresentation,
  readEmbeddingErrorMessage,
  type EmbeddingsIndexPresentation,
  type EmbeddingsIndexStats,
} from "../services/embeddings/EmbeddingsPresentationState";

export class EmbeddingsStatusModal extends StandardModal {
  private readonly plugin: SystemSculptPlugin;
  private unsubscribes: Array<() => void> = [];
  private updateIntervalId: number | null = null;
  private settledUpdateTimerId: number | null = null;

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
    this.cancelSettledUpdate();
    this.cleanupEventListeners();
    super.onClose();
  }

  private buildModalContent(): void {
    this.statusContainerEl = this.contentEl.createDiv({ cls: "ss-embeddings-status" });

    this.providerInfoEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-provider-card" });

    this.statsGridEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-stats-grid" });

    this.progressSectionEl = this.statusContainerEl.createDiv({ cls: "ss-embeddings-progress-section" });
    this.progressSectionEl.hidden = true;

    const progressHeader = this.progressSectionEl.createDiv({ cls: "ss-embeddings-progress-header" });
    const progressIcon = progressHeader.createSpan({ cls: "ss-embeddings-progress-icon" });
    setIcon(progressIcon, "loader");
    this.progressTextEl = progressHeader.createSpan({ cls: "ss-embeddings-progress-text", text: "Processing..." });

    this.progressBarEl = this.progressSectionEl.createEl("progress", { cls: "ss-embeddings-progress-bar" });
    this.progressBarEl.max = 100;
    this.progressBarEl.value = 0;

    this.errorSectionEl = this.statusContainerEl.createDiv({
      cls: "ss-embeddings-error-section",
      attr: { role: "alert", "aria-live": "polite" },
    });
    this.errorSectionEl.hidden = true;
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
    this.retryButton.hidden = true;
    this.retryButton.addEventListener("click", () => this.retryFailedFiles());

    this.stopButton = this.actionsContainerEl.createEl("button", {
      cls: "ss-embeddings-action-button ss-embeddings-action-button--danger"
    });
    const stopIcon = this.stopButton.createSpan({ cls: "ss-embeddings-action-icon" });
    setIcon(stopIcon, "square");
    this.stopButton.appendText("Stop");
    this.stopButton.hidden = true;
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
        emitter.on("embeddings:processing-complete", (payload: unknown) => {
          const status = payload && typeof payload === "object"
            ? (payload as { status?: unknown }).status
            : undefined;
          if (status === "success") this.clearErrorState();
          // The manager emits before its mutex is released. Read the settled
          // lifecycle on the next task so a completed run cannot remain
          // presented as Processing until the polling interval fires.
          this.scheduleSettledUpdate();
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

  private scheduleSettledUpdate(): void {
    this.cancelSettledUpdate();
    this.settledUpdateTimerId = window.setTimeout(() => {
      this.settledUpdateTimerId = null;
      void this.updateDisplay();
    }, 0);
  }

  private cancelSettledUpdate(): void {
    if (this.settledUpdateTimerId === null) return;
    window.clearTimeout(this.settledUpdateTimerId);
    this.settledUpdateTimerId = null;
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
    const presentation = deriveEmbeddingsIndexPresentation(
      stats,
      isProcessing,
      this.currentErrorMessage,
    );

    this.renderManagedInfo(presentation);
    this.renderStats(stats, presentation.state === "processing");
    this.renderProgress(stats, presentation);
    this.renderError(presentation.errorMessage);
    this.updateActionButtons(presentation, isProcessing, stats);
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
      this.progressSectionEl.hidden = true;
    }

    if (this.errorSectionEl) {
      this.errorSectionEl.hidden = true;
    }

    if (this.processButton) {
      this.processButton.hidden = false;
      this.processButton.disabled = true;
    }
    if (this.retryButton) this.retryButton.hidden = true;
    if (this.stopButton) this.stopButton.hidden = true;
  }

  private renderManagedInfo(presentation: EmbeddingsIndexPresentation): void {
    if (!this.providerInfoEl) return;
    this.providerInfoEl.empty();

    const headerRow = this.providerInfoEl.createDiv({ cls: "ss-embeddings-provider-header" });

    headerRow.createDiv({
      cls: `ss-embeddings-status-indicator ss-embeddings-status-indicator--${presentation.indicator}`,
    });

    headerRow.createDiv({
      text: presentation.label,
      cls: "ss-embeddings-provider-status",
      attr: { "aria-live": "polite" },
    });

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

  private renderStats(stats: EmbeddingsIndexStats, isProcessing: boolean): void {
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

  private renderProgress(
    stats: EmbeddingsIndexStats,
    presentation: EmbeddingsIndexPresentation,
  ): void {
    if (!this.progressSectionEl || !this.progressBarEl || !this.progressTextEl) return;

    if (!presentation.showProgress) {
      this.progressSectionEl.hidden = true;
      return;
    }

    this.progressSectionEl.hidden = false;

    const percentage = stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : 0;
    this.progressBarEl.value = percentage;
    this.progressTextEl.setText(`Processing ${stats.processed} of ${stats.total} files (${percentage}%)`);
  }

  private displayError(message: string): void {
    this.currentErrorMessage = readEmbeddingErrorMessage(message);
    this.renderError(this.currentErrorMessage);
  }

  private clearErrorState(): void {
    this.currentErrorMessage = null;

    if (this.errorSectionEl) {
      this.errorSectionEl.hidden = true;
    }
  }

  private renderError(message: string | null): void {
    if (!this.errorSectionEl || !this.errorTextEl) return;
    this.errorSectionEl.hidden = message === null;
    this.errorTextEl.setText(message ?? "");
  }

  private updateActionButtons(
    presentation: EmbeddingsIndexPresentation,
    managerIsProcessing: boolean,
    stats: EmbeddingsIndexStats,
  ): void {
    const isProcessing = presentation.state === "processing";
    const hasFailedFiles = stats.failed > 0;

    if (this.processButton) {
      this.processButton.hidden = isProcessing || hasFailedFiles || managerIsProcessing;
      this.processButton.disabled = stats.needsProcessing === 0;
    }

    if (this.retryButton) {
      this.retryButton.hidden = managerIsProcessing || !hasFailedFiles;
    }

    if (this.stopButton) {
      this.stopButton.hidden = !isProcessing;
    }
  }

  private async startProcessing(): Promise<void> {
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      const result = await manager.processVault();
      if (result.status === "aborted") {
        this.displayError(readEmbeddingErrorMessage(
          result.message ?? result.failure,
          "Embeddings stopped before finishing. Try again.",
        ));
      }
      await this.updateDisplay();
    } catch (error) {
      const message = readEmbeddingErrorMessage(error, "Couldn’t start embeddings. Try again.");
      this.displayError(message);
      new Notice(message);
    }
  }

  private async retryFailedFiles(): Promise<void> {
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      const result = await manager.retryFailedFiles();
      if (result.status === "aborted") {
        this.displayError(readEmbeddingErrorMessage(
          result.message ?? result.failure,
          "Embeddings stopped before finishing. Try again.",
        ));
      } else {
        this.clearErrorState();
      }
      await this.updateDisplay();
    } catch (error) {
      const message = readEmbeddingErrorMessage(error, "Couldn’t retry embeddings. Try again.");
      this.displayError(message);
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
    return readEmbeddingErrorMessage(payload, "Embeddings failed. Try again.");
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
