import { App, Notice, TFile, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";
import {
  DocumentProcessingProgressEvent,
  DocumentProcessingStage,
} from "../types/documentProcessing";
import { formatFileSize } from "../utils/FileValidator";

type TimelineStep = "queued" | "uploading" | "processing" | "contextualizing" | "ready";

const TIMELINE_ORDER: TimelineStep[] = [
  "queued",
  "uploading",
  "processing",
  "contextualizing",
  "ready",
];

const STEP_LABEL: Record<TimelineStep, string> = {
  queued: "Preparing",
  uploading: "Uploading",
  processing: "Processing",
  contextualizing: "Context",
  ready: "Ready",
};

const STAGE_TO_TIMELINE: Record<DocumentProcessingStage, TimelineStep> = {
  queued: "queued",
  validating: "queued",
  uploading: "uploading",
  processing: "processing",
  downloading: "processing",
  contextualizing: "contextualizing",
  ready: "ready",
  error: "processing",
};

const STAGE_ICON: Partial<Record<DocumentProcessingStage | "complete" | "error", string>> = {
  queued: "inbox",
  validating: "shield-check",
  uploading: "upload",
  processing: "cpu",
  downloading: "download",
  contextualizing: "sparkles",
  ready: "check-circle",
  complete: "check-circle",
  error: "x-circle",
};

export interface DocumentProcessingSuccessPayload {
  extractionPath: string;
  durationMs: number;
  file: TFile;
  openOutput: () => Promise<void> | void;
}

export interface DocumentProcessingFailurePayload {
  error: unknown;
  file: TFile;
}

export interface DocumentProcessingModalHandle {
  updateProgress(event: DocumentProcessingProgressEvent): void;
  markSuccess(payload: DocumentProcessingSuccessPayload): void;
  markFailure(payload: DocumentProcessingFailurePayload): void;
  close(): void;
}

export interface DocumentProcessingModalLauncherOptions {
  app: App;
  plugin: SystemSculptPlugin;
  file: TFile;
  onCancel?: () => void;
  source?: string;
}

export type DocumentProcessingModalLauncher = (
  options: DocumentProcessingModalLauncherOptions
) => DocumentProcessingModalHandle;

interface StepElements {
  wrapper: HTMLElement;
  icon: HTMLElement;
  label: HTMLElement;
}

class DocumentProcessingModal implements DocumentProcessingModalHandle {
  private readonly app: App;
  private readonly file: TFile;
  private readonly onCancel?: () => void;
  private readonly container: HTMLElement;
  private readonly statusIcon: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly percentLabel: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly steps = new Map<TimelineStep, StepElements>();
  private readonly buttonsContainer: HTMLElement;
  private readonly detailEl: HTMLElement;
  private autoCloseTimer: number | null = null;
  private destroyed = false;

  constructor(options: DocumentProcessingModalLauncherOptions) {
    this.app = options.app;
    this.file = options.file;
    this.onCancel = options.onCancel;

    this.container = document.body.createDiv({ cls: "systemsculpt-progress-modal" });

    const header = this.container.createDiv({ cls: "systemsculpt-progress-header" });
    const headerIcon = header.createDiv({ cls: "systemsculpt-progress-icon" });
    setIcon(headerIcon, "file-text");

    const headerContent = header.createDiv({ cls: "systemsculpt-progress-title" });
    headerContent.setText("Convert to Markdown");

    const fileMeta = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    const fileIcon = fileMeta.createSpan({ cls: "systemsculpt-progress-status-icon" });
    setIcon(fileIcon, "file");

    const metaText = fileMeta.createSpan();
    const parts: string[] = [options.file.name];
    if (typeof options.file.stat?.size === "number") {
      parts.push(formatFileSize(options.file.stat.size));
    }
    metaText.setText(parts.join(" · "));

    const statusRow = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    this.statusIcon = statusRow.createSpan({ cls: "systemsculpt-progress-status-icon" });
    this.statusLabel = statusRow.createSpan({ cls: "systemsculpt-progress-status-text" });
    this.percentLabel = statusRow.createSpan({ cls: "systemsculpt-progress-percent" });

    const progressTrack = this.container.createDiv({
      cls: "systemsculpt-progress-bar-track",
    });
    this.progressFill = progressTrack.createDiv({ cls: "systemsculpt-progress-bar" });

    const stepsWrapper = this.container.createDiv({ cls: "systemsculpt-progress-steps" });
    TIMELINE_ORDER.forEach((step) => {
      const wrapper = stepsWrapper.createDiv({ cls: "systemsculpt-progress-step" });
      const icon = wrapper.createDiv({ cls: "systemsculpt-progress-step-icon" });
      setIcon(icon, "circle");
      const label = wrapper.createDiv({
        cls: "systemsculpt-progress-step-text",
        text: STEP_LABEL[step],
      });
      this.steps.set(step, { wrapper, icon, label });
    });

    this.detailEl = this.container.createDiv({
      cls: "systemsculpt-progress-detail is-hidden",
    });

    this.buttonsContainer = this.container.createDiv({
      cls: "systemsculpt-progress-buttons",
    });

    this.setButtons([
      {
        label: "Hide",
        onClick: () => {
          this.onCancel?.();
          this.close();
        },
      },
    ]);

    this.updateProgress({
      stage: "queued",
      progress: 2,
      label: "Preparing conversion…",
      flow: "document",
      icon: STAGE_ICON.validating ?? "inbox",
    });
  }

  updateProgress(event: DocumentProcessingProgressEvent): void {
    if (this.destroyed) {
      return;
    }

    const progress = clampPercentage(event.progress ?? 0);
    this.progressFill.style.width = `${progress}%`;
    this.percentLabel.setText(`${Math.round(progress)}%`);

    const icon = event.icon || STAGE_ICON[event.stage] || "loader";
    this.statusIcon.empty();
    setIcon(this.statusIcon, icon);

    this.statusLabel.setText(event.label ?? "Working…");
    this.container.removeClass("is-error", "is-complete");

    this.updateSteps(event.stage);
  }

  markSuccess(payload: DocumentProcessingSuccessPayload): void {
    if (this.destroyed) {
      return;
    }

    this.updateProgress({
      stage: "ready",
      progress: 100,
      label: "Conversion complete",
      flow: "document",
      icon: STAGE_ICON.complete ?? "check-circle",
    });

    this.container.addClass("is-complete");
    this.detailEl.removeClass("is-hidden");
    const seconds = payload.durationMs / 1000;
    this.detailEl.setText(
      `Saved to ${payload.extractionPath} in ${seconds.toFixed(seconds < 10 ? 1 : 0)}s.`
    );

    this.setButtons([
      {
        label: "Open Markdown",
        variant: "primary",
        onClick: async () => {
          try {
            await payload.openOutput();
          } catch (error) {
            new Notice("Unable to open converted file. See console for details.", 4000);
          }
          this.close();
        },
      },
      {
        label: "Close",
        onClick: () => this.close(),
      },
    ]);

    this.scheduleAutoClose();
  }

  markFailure(payload: DocumentProcessingFailurePayload): void {
    if (this.destroyed) {
      return;
    }

    this.container.addClass("is-error");
    this.statusIcon.empty();
    setIcon(this.statusIcon, STAGE_ICON.error ?? "x-circle");
    const message =
      payload.error instanceof Error ? payload.error.message : String(payload.error ?? "Unknown error");
    this.statusLabel.setText("Conversion failed");
    this.percentLabel.setText("");
    this.detailEl.removeClass("is-hidden");
    this.detailEl.setText(message);

    this.updateSteps("error");

    const supportsClipboard = typeof navigator !== "undefined" && Boolean(navigator.clipboard);

    const buttons = supportsClipboard
      ? [
          {
            label: "Copy error",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(message);
                new Notice("Error copied to clipboard", 2500);
              } catch (error) {
                console.error(error);
              }
              this.close();
            },
          },
          {
            label: "Close",
            variant: "primary" as const,
            onClick: () => this.close(),
          },
        ]
      : [
          {
            label: "Close",
            variant: "primary" as const,
            onClick: () => this.close(),
          },
        ];

    this.setButtons(buttons);
  }

  close(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    if (this.autoCloseTimer !== null) {
      window.clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    } else if (this.container.isConnected) {
      this.container.remove();
    }
  }

  private updateSteps(stage: DocumentProcessingStage | "error"): void {
    const activeStep = stage === "error" ? "processing" : STAGE_TO_TIMELINE[stage] ?? "processing";
    const activeIndex = TIMELINE_ORDER.indexOf(activeStep);

    TIMELINE_ORDER.forEach((step, index) => {
      const elements = this.steps.get(step);
      if (!elements) {
        return;
      }

      elements.wrapper.removeClass("active", "completed", "error");

      if (stage === "error" && index === activeIndex) {
        elements.wrapper.addClass("error");
        elements.icon.empty();
        setIcon(elements.icon, STAGE_ICON.error ?? "x-circle");
        return;
      }

      if (index < activeIndex) {
        elements.wrapper.addClass("completed");
        elements.icon.empty();
        setIcon(elements.icon, "check");
        return;
      }

      if (index === activeIndex) {
        elements.wrapper.addClass("active");
        elements.icon.empty();
        setIcon(elements.icon, STAGE_ICON[stage as DocumentProcessingStage] ?? "loader");
        return;
      }

      elements.icon.empty();
      setIcon(elements.icon, "circle");
    });
  }

  private setButtons(
    descriptors: Array<{ label: string; onClick: () => void; variant?: "primary" | "default" }>
  ): void {
    this.buttonsContainer.empty();
    descriptors.forEach((descriptor) => {
      const button = this.buttonsContainer.createEl("button", {
        cls: "systemsculpt-progress-button" + (descriptor.variant === "primary" ? " primary" : ""),
        text: descriptor.label,
      });
      button.addEventListener("click", descriptor.onClick);
    });
  }

  private scheduleAutoClose(): void {
    if (this.autoCloseTimer !== null) {
      window.clearTimeout(this.autoCloseTimer);
    }
    this.autoCloseTimer = window.setTimeout(() => this.close(), 6000);
  }
}

export const launchDocumentProcessingModal: DocumentProcessingModalLauncher = (options) => {
  const modal = new DocumentProcessingModal(options);
  options.plugin.register(() => modal.close());
  return modal;
};

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  return Math.min(100, Math.max(0, value));
}
