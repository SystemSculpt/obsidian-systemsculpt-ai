import { App, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
  OperationProgressPanel,
  type OperationProgressButton,
} from "../core/ui/progress/OperationProgressPanel";
import { registerRunTeardown } from "../core/plugin/lifecycle/RunTeardown";
import { tryCopyToClipboard } from "../utils/clipboard";
import { flashButtonResult } from "../core/ui/notifications";

export interface PendingTranscriptionFile {
  file: TFile;
}

export interface BulkTranscriptionConfirmModalOptions {
  app: App;
  pendingFiles: PendingTranscriptionFile[];
  onConfirm: (files: PendingTranscriptionFile[]) => void;
  /** Not now, Escape, or closing: the files stay waiting and nothing is recorded. */
  onDefer: () => void;
}

/** Asks once before a batch of inbox audio is uploaded for transcription. */
export class BulkTranscriptionConfirmModal extends StandardModal {
  private readonly pendingFiles: PendingTranscriptionFile[];
  private readonly onConfirm: (files: PendingTranscriptionFile[]) => void;
  private readonly onDefer: () => void;
  private settled = false;

  constructor(options: BulkTranscriptionConfirmModalOptions) {
    super(options.app);
    this.pendingFiles = options.pendingFiles;
    this.onConfirm = options.onConfirm;
    this.onDefer = options.onDefer;
    this.setSize("small");
    this.modalEl.addClass("ss-bulk-transcription-modal");
  }

  onOpen(): void {
    super.onOpen();
    const count = this.pendingFiles.length;

    this.addTitle(
      "Bulk transcription detected",
      `Transcribe ${count} audio files with SystemSculpt? Processing stops at the first error. Closing this window leaves the files waiting.`,
    );

    this.addActionButton("bulk-transcribe.not-now", "Not now", () => this.close(), false);
    this.addActionButton(
      "bulk-transcribe.confirm",
      `Transcribe ${count} files`,
      () => this.handleConfirm(),
      true,
    );
  }

  onClose(): void {
    const shouldDefer = !this.settled;
    super.onClose();
    if (shouldDefer) {
      this.settled = true;
      this.onDefer();
    }
  }

  private handleConfirm(): void {
    if (this.settled) return;
    this.settled = true;
    this.onConfirm(this.pendingFiles);
    this.close();
  }

}

export interface BulkTranscriptionProgressWidgetOptions {
  plugin: SystemSculptPlugin;
  totalFiles: number;
  onStop?: () => void;
  host?: HTMLElement;
}

/** Feature adapter over the one canonical long-running operation panel. */
export class BulkTranscriptionProgressWidget {
  private readonly plugin: SystemSculptPlugin;
  private readonly totalFiles: number;
  private readonly onStop?: () => void;
  private readonly panel: OperationProgressPanel;
  private readonly releaseUnload: () => void;
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
      // Close and the auto-close after completion both end here.
      onClose: () => {
        this.destroyed = true;
        this.releaseUnload();
      },
    });
    this.releaseUnload = registerRunTeardown(this.plugin, () => this.close());
    this.syncStatus();
    this.panel.setActions(this.buildRunningActions());
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
    this.panel.setActions([{
      label: "Close",
      testId: "bulk-transcribe.progress.close",
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
      state: this.state === "stopped" ? "warning" : this.state,
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
    this.panel.setActions([
      ...(copyText ? [this.buildCopyAction(copyText)] : []),
      {
        label: "Close",
        testId: "bulk-transcribe.progress.close",
        variant: "primary" as const,
        onClick: () => this.close(),
      },
    ]);
  }

  private buildRunningActions(): OperationProgressButton[] {
    if (!this.onStop) return [];
    return [{
      label: "Stop",
      testId: "bulk-transcribe.progress.stop",
      variant: "danger",
      onClick: () => this.handleStopClick(),
    }];
  }

  private handleStopClick(): void {
    if (!this.onStop || this.state !== "running") return;
    this.status = "Stopping…";
    this.syncStatus();
    this.panel.setActions([{
      label: "Stopping…",
      testId: "bulk-transcribe.progress.stop",
      variant: "danger",
      disabled: true,
      onClick: () => {},
    }]);
    this.onStop();
  }

  private buildCopyAction(copyText: string): OperationProgressButton {
    return {
      label: "Copy error",
      testId: "bulk-transcribe.progress.copy-error",
      onClick: (button) => {
        void tryCopyToClipboard(copyText, this.panel.element).then((copied) => {
          flashButtonResult(button, copied ? "Copied" : "Couldn't copy");
        });
      },
    };
  }
}
