import { App, Notice, TFile, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";

export interface PendingAutomationFile {
  file: TFile;
  automationType: "transcription" | "automation";
  automationId?: string;
  automationTitle?: string;
}

export interface BulkAutomationConfirmModalOptions {
  app: App;
  plugin: SystemSculptPlugin;
  pendingFiles: PendingAutomationFile[];
  onConfirm: (files: PendingAutomationFile[]) => void;
  onCancel: () => void;
}

export class BulkAutomationConfirmModal {
  private app: App;
  private plugin: SystemSculptPlugin;
  private pendingFiles: PendingAutomationFile[];
  private onConfirm: (files: PendingAutomationFile[]) => void;
  private onCancel: () => void;
  private container: HTMLElement | null = null;
  private destroyed = false;

  constructor(options: BulkAutomationConfirmModalOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.pendingFiles = options.pendingFiles;
    this.onConfirm = options.onConfirm;
    this.onCancel = options.onCancel;
  }

  open(): void {
    this.render();
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.container?.parentElement) {
      this.container.remove();
    }
  }

  private render(): void {
    this.container = document.body.createDiv({ cls: "systemsculpt-bulk-confirm-widget" });

    const header = this.container.createDiv({ cls: "systemsculpt-bulk-widget-header" });
    const iconEl = header.createDiv({ cls: "systemsculpt-bulk-widget-icon" });
    setIcon(iconEl, "alert-triangle");
    header.createDiv({ cls: "systemsculpt-bulk-widget-title", text: "Bulk Workflow Detected" });

    const closeBtn = header.createDiv({ cls: "systemsculpt-bulk-widget-close" });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => {
      this.onCancel();
      this.close();
    };

    const body = this.container.createDiv({ cls: "systemsculpt-bulk-widget-body" });

    const transcriptionCount = this.pendingFiles.filter(f => f.automationType === "transcription").length;
    const automationCount = this.pendingFiles.filter(f => f.automationType === "automation").length;

    const parts: string[] = [];
    if (transcriptionCount > 0) {
      parts.push(`${transcriptionCount} transcription${transcriptionCount > 1 ? "s" : ""}`);
    }
    if (automationCount > 0) {
      parts.push(`${automationCount} automation${automationCount > 1 ? "s" : ""}`);
    }

    body.createDiv({
      cls: "systemsculpt-bulk-widget-description",
      text: `${this.pendingFiles.length} files detected (${parts.join(", ")})`
    });

    body.createDiv({
      cls: "systemsculpt-bulk-widget-info",
      text: "Files will be processed in batches of 3 and stop on the first error"
    });

    body.createDiv({
      cls: "systemsculpt-bulk-widget-info",
      text: "Skip All will mark these files as skipped so they do not auto-process. Clear skips in Settings -> Automations."
    });

    const buttons = this.container.createDiv({ cls: "systemsculpt-bulk-widget-buttons" });

    const skipBtn = buttons.createEl("button", { text: "Skip All (mark skipped)" });
    skipBtn.onclick = () => {
      this.onCancel();
      this.close();
    };

    const processBtn = buttons.createEl("button", { text: `Process ${this.pendingFiles.length}`, cls: "mod-cta" });
    processBtn.onclick = () => {
      this.close();
      this.onConfirm(this.pendingFiles);
    };
  }
}

export interface BulkProgressWidgetOptions {
  plugin: SystemSculptPlugin;
  totalFiles: number;
  onStop?: () => void;
}

type BulkProgressAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "danger" | "default";
};

export class BulkProgressWidget {
  private plugin: SystemSculptPlugin;
  private totalFiles: number;
  private onStop?: () => void;
  private container: HTMLElement | null = null;
  private progressFill: HTMLElement | null = null;
  private statusLabel: HTMLElement | null = null;
  private countLabel: HTMLElement | null = null;
  private currentBatchContainer: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private actionsContainer: HTMLElement | null = null;
  private destroyed = false;
  private completedCount = 0;
  private failedCount = 0;
  private skippedCount = 0;
  private state: "running" | "complete" | "error" | "stopped" = "running";

  constructor(options: BulkProgressWidgetOptions) {
    this.plugin = options.plugin;
    this.totalFiles = options.totalFiles;
    this.onStop = options.onStop;
    this.render();
  }

  private render(): void {
    this.container = document.body.createDiv({ cls: "systemsculpt-bulk-progress-widget" });

    const header = this.container.createDiv({ cls: "systemsculpt-bulk-widget-header" });
    const iconEl = header.createDiv({ cls: "systemsculpt-bulk-widget-icon processing" });
    setIcon(iconEl, "loader");
    header.createDiv({ cls: "systemsculpt-bulk-widget-title", text: "Processing Workflows" });

    const hideBtn = header.createDiv({ cls: "systemsculpt-bulk-widget-close" });
    setIcon(hideBtn, "minus");
    hideBtn.setAttribute("aria-label", "Minimize");
    hideBtn.onclick = () => this.toggleMinimize();

    const body = this.container.createDiv({ cls: "systemsculpt-bulk-widget-body" });

    this.statusLabel = body.createDiv({ cls: "systemsculpt-bulk-widget-status" });
    this.statusLabel.setText("Starting...");

    this.countLabel = body.createDiv({ cls: "systemsculpt-bulk-widget-count" });
    this.updateCountLabel();

    const progressTrack = body.createDiv({ cls: "systemsculpt-bulk-widget-progress-track" });
    this.progressFill = progressTrack.createDiv({ cls: "systemsculpt-bulk-widget-progress-fill" });

    this.currentBatchContainer = body.createDiv({ cls: "systemsculpt-bulk-widget-batch" });

    this.detailEl = body.createDiv({
      cls: "systemsculpt-bulk-widget-detail is-hidden",
    });

    this.actionsContainer = this.container.createDiv({ cls: "systemsculpt-bulk-widget-buttons" });
    this.setActions(this.buildRunningActions());

    this.plugin.register(() => this.close());
  }

  private toggleMinimize(): void {
    this.container?.toggleClass("is-minimized", !this.container.hasClass("is-minimized"));
  }

  private updateCountLabel(): void {
    if (!this.countLabel) return;
    const remaining = this.totalFiles - this.completedCount - this.failedCount - this.skippedCount;
    let text = `${this.completedCount} / ${this.totalFiles} complete`;
    const extras: string[] = [];
    if (this.failedCount > 0) {
      extras.push(`${this.failedCount} failed`);
    }
    if (this.skippedCount > 0) {
      extras.push(`${this.skippedCount} skipped`);
    }
    if (extras.length > 0) {
      text += ` (${extras.join(", ")})`;
    }
    if (remaining > 0) {
      text += ` • ${remaining} remaining`;
    }
    this.countLabel.setText(text);
  }

  updateStatus(status: string): void {
    if (this.destroyed || this.state !== "running") return;
    this.statusLabel?.setText(status);
  }

  updateProgress(completed: number, failed: number, skipped: number = 0): void {
    if (this.destroyed || this.state === "complete") return;
    this.completedCount = completed;
    this.failedCount = failed;
    this.skippedCount = skipped;
    this.updateCountLabel();

    const total = this.totalFiles;
    const processed = completed + failed + skipped;
    const pct = total > 0 ? (processed / total) * 100 : 0;
    if (this.progressFill) {
      this.progressFill.style.width = `${pct}%`;
    }
  }

  showCurrentBatch(files: PendingAutomationFile[]): void {
    if (this.destroyed || !this.currentBatchContainer || this.state !== "running") return;
    this.currentBatchContainer.empty();

    for (const f of files) {
      const row = this.currentBatchContainer.createDiv({ cls: "systemsculpt-bulk-batch-item" });
      const icon = row.createSpan({ cls: "systemsculpt-bulk-batch-icon" });
      setIcon(icon, f.automationType === "transcription" ? "mic" : "sparkles");
      row.createSpan({ cls: "systemsculpt-bulk-batch-name", text: f.file.basename });
      const status = row.createSpan({ cls: "systemsculpt-bulk-batch-status" });
      setIcon(status, "loader");
      row.dataset.path = f.file.path;
    }
  }

  markBatchItemComplete(file: TFile): void {
    if (this.destroyed || !this.currentBatchContainer) return;
    const item = this.currentBatchContainer.querySelector(`[data-path="${CSS.escape(file.path)}"]`);
    if (item) {
      item.addClass("is-complete");
      const status = item.querySelector(".systemsculpt-bulk-batch-status");
      if (status) {
        status.empty();
        setIcon(status as HTMLElement, "check");
      }
    }
  }

  markBatchItemError(file: TFile, message?: string): void {
    if (this.destroyed || !this.currentBatchContainer) return;
    const item = this.currentBatchContainer.querySelector(`[data-path="${CSS.escape(file.path)}"]`);
    if (item) {
      item.addClass("is-error");
      const status = item.querySelector(".systemsculpt-bulk-batch-status");
      if (status) {
        status.empty();
        setIcon(status as HTMLElement, "x");
      }
      if (message) {
        item.setAttribute("title", message);
      }
    }
  }

  markBatchItemSkipped(file: TFile, message?: string): void {
    if (this.destroyed || !this.currentBatchContainer) return;
    const item = this.currentBatchContainer.querySelector(`[data-path="${CSS.escape(file.path)}"]`);
    if (item) {
      item.addClass("is-skipped");
      const status = item.querySelector(".systemsculpt-bulk-batch-status");
      if (status) {
        status.empty();
        setIcon(status as HTMLElement, "minus");
      }
      if (message) {
        item.setAttribute("title", message);
      }
    }
  }

  markComplete(): void {
    if (this.destroyed) return;
    this.state = "complete";
    this.container?.addClass("is-complete");
    this.statusLabel?.setText("All workflows complete!");

    const iconEl = this.container?.querySelector(".systemsculpt-bulk-widget-icon");
    if (iconEl) {
      iconEl.empty();
      iconEl.removeClass("processing");
      setIcon(iconEl as HTMLElement, "check-circle");
    }

    this.setDetail([]);
    this.setActions([
      {
        label: "Close",
        variant: "primary",
        onClick: () => this.close(),
      },
    ]);

    setTimeout(() => this.close(), 5000);
  }

  markFailed(options: { status: string; detailLines?: string[]; copyText?: string }): void {
    this.setFinalState("error", options.status, options.detailLines, options.copyText);
  }

  markStopped(options: { status: string; detailLines?: string[]; copyText?: string }): void {
    this.setFinalState("stopped", options.status, options.detailLines, options.copyText);
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.container?.parentElement) {
      this.container.remove();
    }
  }

  private setFinalState(
    state: "error" | "stopped",
    status: string,
    detailLines?: string[],
    copyText?: string
  ): void {
    if (this.destroyed) return;
    this.state = state;
    this.container?.addClass(state === "error" ? "is-error" : "is-stopped");
    this.statusLabel?.setText(status);

    const iconEl = this.container?.querySelector(".systemsculpt-bulk-widget-icon");
    if (iconEl) {
      iconEl.empty();
      iconEl.removeClass("processing");
      setIcon(iconEl as HTMLElement, state === "error" ? "x-circle" : "slash");
    }

    this.setDetail(detailLines ?? [], copyText);

    const actions: BulkProgressAction[] = [];
    if (copyText) {
      const copyAction = this.buildCopyAction(copyText);
      if (copyAction) actions.push(copyAction);
    }
    actions.push({
      label: "Close",
      variant: "primary",
      onClick: () => this.close(),
    });
    this.setActions(actions);
  }

  private buildRunningActions(): BulkProgressAction[] {
    if (!this.onStop) return [];
    return [
      {
        label: "Stop",
        variant: "danger",
        onClick: () => this.handleStopClick(),
      },
    ];
  }

  private handleStopClick(): void {
    if (!this.onStop || this.state !== "running") return;
    this.statusLabel?.setText("Stopping...");
    this.setActions([
      {
        label: "Stopping...",
        variant: "danger",
        onClick: () => {},
      },
    ]);
    this.onStop();
  }

  private setDetail(lines: string[], copyText?: string): void {
    if (!this.detailEl) return;
    this.detailEl.empty();
    if (!lines.length) {
      this.detailEl.addClass("is-hidden");
      return;
    }
    this.detailEl.removeClass("is-hidden");
    lines.forEach((line, index) => {
      this.detailEl?.createDiv({
        text: line,
        cls: index === 0
          ? "systemsculpt-bulk-widget-detail-primary"
          : "systemsculpt-bulk-widget-detail-secondary",
      });
    });
  }

  private setActions(actions: BulkProgressAction[]): void {
    if (!this.actionsContainer) return;
    this.actionsContainer.empty();
    if (actions.length === 0) {
      this.actionsContainer.style.display = "none";
      return;
    }
    this.actionsContainer.style.display = "flex";
    actions.forEach((action) => {
      const classes = ["systemsculpt-bulk-widget-button"];
      if (action.variant === "primary") {
        classes.push("mod-cta");
      } else if (action.variant === "danger") {
        classes.push("mod-danger");
      }
      const button = this.actionsContainer?.createEl("button", {
        text: action.label,
        cls: classes.join(" "),
      });
      button?.addEventListener("click", action.onClick);
    });
  }

  private buildCopyAction(copyText: string): BulkProgressAction | null {
    const supportsClipboard = typeof navigator !== "undefined" && Boolean(navigator.clipboard);
    if (!supportsClipboard) return null;
    return {
      label: "Copy error",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(copyText);
          new Notice("Error copied to clipboard", 2500);
        } catch (error) {
          console.error(error);
        }
      },
    };
  }
}
