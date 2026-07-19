import { App, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
  OperationProgressPanel,
  type OperationProgressState,
} from "../core/ui/progress/OperationProgressPanel";
import { tryCopyToClipboard } from "../utils/clipboard";

export interface PendingTranscriptionFile {
  file: TFile;
}

export interface BulkTranscriptionConfirmModalOptions {
  app: App;
  pendingFiles: PendingTranscriptionFile[];
  onConfirm: (files: PendingTranscriptionFile[]) => void;
  onCancel: () => void;
}

export class BulkTranscriptionConfirmModal extends StandardModal {
  private readonly pendingFiles: PendingTranscriptionFile[];
  private readonly onConfirm: (files: PendingTranscriptionFile[]) => void;
  private readonly onCancel: () => void;
  private settled = false;

  constructor(options: BulkTranscriptionConfirmModalOptions) {
    super(options.app);
    this.pendingFiles = options.pendingFiles;
    this.onConfirm = options.onConfirm;
    this.onCancel = options.onCancel;
    this.setSize("small");
    this.modalEl.addClass("ss-bulk-transcription-modal");
  }

  onOpen(): void {
    super.onOpen();
    const count = this.pendingFiles.length;

    this.addTitle(
      "Bulk transcription detected",
      `${count} audio file${count === 1 ? " is" : "s are"} ready for transcription.`,
    );

    const body = this.contentEl.createDiv({
      cls: "ss-modal__custom-content ss-bulk-transcription-modal__body",
    });
    body.createEl("p", {
      cls: "ss-bulk-transcription-modal__summary",
      text: `${count} transcription${count === 1 ? "" : "s"}`,
    });

    const notes = body.createEl("ul", { cls: "ss-bulk-transcription-modal__notes" });
    notes.createEl("li", { text: "Runs in batches of 3 and stops on the first error." });
    notes.createEl("li", {
      text: "Skip all marks these files as skipped until you clear them in settings > workflow.",
    });

    this.addActionButton("Skip all", () => this.handleCancel(), false);
    this.addActionButton(
      `Transcribe ${count} file${count === 1 ? "" : "s"}`,
      () => this.handleConfirm(),
      true,
    );
  }

  onClose(): void {
    const shouldCancel = !this.settled;
    super.onClose();
    if (shouldCancel) {
      this.settled = true;
      this.onCancel();
    }
  }

  private handleConfirm(): void {
    if (this.settled) return;
    this.settled = true;
    this.onConfirm(this.pendingFiles);
    this.close();
  }

  private handleCancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.onCancel();
    this.close();
  }
}

export interface BulkTranscriptionProgressWidgetOptions {
  plugin: SystemSculptPlugin;
  totalFiles: number;
  onStop?: () => void;
  host?: HTMLElement;
}

type BulkProgressAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "danger" | "default";
  disabled?: boolean;
};

/** Feature adapter over the one canonical long-running operation panel. */
export class BulkTranscriptionProgressWidget {
  private readonly plugin: SystemSculptPlugin;
  private readonly totalFiles: number;
  private readonly onStop?: () => void;
  private readonly panel: OperationProgressPanel;
  private destroyed = false;
  private completedCount = 0;
  private failedCount = 0;
  private skippedCount = 0;
  private status = "Starting…";
  private state: "running" | "complete" | "error" | "stopped" = "running";

  constructor(options: BulkTranscriptionProgressWidgetOptions) {
    this.plugin = options.plugin;
    this.totalFiles = options.totalFiles;
    this.onStop = options.onStop;
    this.panel = new OperationProgressPanel({
      title: "Transcribing inbox audio",
      icon: "loader",
      className: "systemsculpt-bulk-progress-widget",
      collapsible: true,
      host: options.host,
    });
    this.syncStatus();
    this.setActions(this.buildRunningActions());
    this.plugin.register(() => this.close());
  }

  updateStatus(status: string): void {
    if (this.destroyed || this.state !== "running") return;
    this.status = status;
    this.syncStatus();
  }

  updateProgress(completed: number, failed: number, skipped = 0): void {
    if (this.destroyed || this.state !== "running") return;
    this.completedCount = completed;
    this.failedCount = failed;
    this.skippedCount = skipped;
    this.syncStatus();
  }

  showCurrentBatch(files: PendingTranscriptionFile[]): void {
    if (this.destroyed || this.state !== "running") return;
    this.panel.setItems(files.map((file) => ({
      id: file.file.path,
      label: file.file.basename,
      icon: "mic",
    })));
  }

  markBatchItemComplete(file: TFile): void {
    this.panel.setItemState(file.path, "complete");
  }

  markBatchItemError(file: TFile, message?: string): void {
    this.panel.setItemState(file.path, "error", message);
  }

  markBatchItemSkipped(file: TFile, message?: string): void {
    this.panel.setItemState(file.path, "skipped", message);
  }

  markComplete(): void {
    if (this.destroyed || this.state !== "running") return;
    this.state = "complete";
    this.status = "All transcriptions complete";
    this.syncStatus();
    this.setActions([{
      label: "Close",
      variant: "primary",
      onClick: () => this.close(),
    }]);
    this.panel.closeAfter(5000);
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
    this.panel.close();
  }

  private syncStatus(extraDetails: string[] = []): void {
    const processed = this.completedCount + this.failedCount + this.skippedCount;
    const progress = this.totalFiles > 0 ? (processed / this.totalFiles) * 100 : 0;
    this.panel.setStatus({
      label: this.status,
      icon: this.state === "complete"
        ? "check-circle"
        : this.state === "error"
          ? "x-circle"
          : this.state === "stopped"
            ? "slash"
            : "loader",
      progress,
      details: [this.buildCountLabel(), ...extraDetails].filter(Boolean).join("\n"),
      state: this.toPanelState(),
    });
  }

  private buildCountLabel(): string {
    const remaining = Math.max(
      0,
      this.totalFiles - this.completedCount - this.failedCount - this.skippedCount,
    );
    const extras: string[] = [];
    if (this.failedCount > 0) extras.push(`${this.failedCount} failed`);
    if (this.skippedCount > 0) extras.push(`${this.skippedCount} skipped`);
    if (remaining > 0) extras.push(`${remaining} remaining`);
    const suffix = extras.length > 0 ? ` • ${extras.join(" • ")}` : "";
    return `${this.completedCount} / ${this.totalFiles} complete${suffix}`;
  }

  private toPanelState(): OperationProgressState {
    if (this.state === "stopped") return "warning";
    return this.state;
  }

  private setFinalState(
    state: "error" | "stopped",
    status: string,
    detailLines: string[] = [],
    copyText?: string,
  ): void {
    if (this.destroyed) return;
    this.state = state;
    this.status = status;
    this.syncStatus(detailLines);
    this.setActions([
      ...(copyText ? [this.buildCopyAction(copyText)] : []),
      {
        label: "Close",
        variant: "primary" as const,
        onClick: () => this.close(),
      },
    ]);
  }

  private buildRunningActions(): BulkProgressAction[] {
    if (!this.onStop) return [];
    return [{
      label: "Stop",
      variant: "danger",
      onClick: () => this.handleStopClick(),
    }];
  }

  private handleStopClick(): void {
    if (!this.onStop || this.state !== "running") return;
    this.status = "Stopping…";
    this.syncStatus();
    this.setActions([{
      label: "Stopping…",
      variant: "danger",
      disabled: true,
      onClick: () => {},
    }]);
    this.onStop();
  }

  private setActions(actions: BulkProgressAction[]): void {
    this.panel.setActions(actions.map((action) => ({
      label: action.label,
      onClick: action.onClick,
      variant: action.variant,
      disabled: action.disabled,
    })));
  }

  private buildCopyAction(copyText: string): BulkProgressAction {
    return {
      label: "Copy error",
      onClick: async () => {
        const copied = await tryCopyToClipboard(copyText);
        new Notice(copied ? "Error copied to clipboard" : "Unable to copy error", 2500);
      },
    };
  }
}
