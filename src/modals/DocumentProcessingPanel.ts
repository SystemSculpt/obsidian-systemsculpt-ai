import { Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { OperationProgressPanel } from "../core/ui/progress/OperationProgressPanel";
import {
  DocumentProcessingProgressEvent,
  DocumentProcessingStage,
} from "../types/documentProcessing";
import { formatFileSize } from "../utils/FileValidator";
import { tryCopyToClipboard } from "../utils/clipboard";

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

export function describeDocumentProcessingFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  const messages: Record<string, string> = {
    license_required: "An active SystemSculpt Pro license is required.",
    license_rejected: "Your SystemSculpt license could not be verified.",
    capability_unavailable: "Document conversion is temporarily unavailable.",
    temporarily_unavailable: "Document conversion is temporarily unavailable. Try again shortly.",
    rate_limited: "Too many document conversions. Try again shortly.",
    document_processing_failed: "The document could not be converted.",
    malformed_response: "The document service returned an invalid response.",
    blocked_ambiguous: "Conversion state could not be verified. Retry from recovery.",
    local_staging_corrupt: "Downloaded conversion data could not be verified.",
    local_output_conflict: "Existing output conflicts with this conversion.",
    ephemeral_download_failed: "The converted document could not be downloaded. Try again.",
    cleanup_pending: "Conversion completed; private temporary files will be cleaned up later.",
    local_abort: "Conversion cancelled.",
  };
  if (messages[code]) return messages[code];
  if (error instanceof DOMException && error.name === "AbortError") return messages.local_abort;
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

export interface DocumentProcessingPanelHandle {
  updateProgress(event: DocumentProcessingProgressEvent): void;
  markSuccess(payload: DocumentProcessingSuccessPayload): void;
  markFailure(payload: DocumentProcessingFailurePayload): void;
  close(): void;
}

export interface DocumentProcessingPanelOptions {
  plugin: SystemSculptPlugin;
  file: TFile;
  onCancel?: () => void;
}

export type DocumentProcessingPanelLauncher = (
  options: DocumentProcessingPanelOptions
) => DocumentProcessingPanelHandle;

class DocumentProcessingPanel implements DocumentProcessingPanelHandle {
  private readonly file: TFile;
  private readonly onCancel?: () => void;
  private readonly panel: OperationProgressPanel;
  private autoCloseTimer: number | null = null;
  private destroyed = false;

  constructor(options: DocumentProcessingPanelOptions) {
    this.file = options.file;
    this.onCancel = options.onCancel;

    const metaParts: string[] = [options.file.name];
    if (typeof options.file.stat?.size === "number") {
      metaParts.push(formatFileSize(options.file.stat.size));
    }

    this.panel = new OperationProgressPanel({
      title: "Convert to Markdown",
      icon: "file-text",
      metaText: metaParts.join(" · "),
      metaIcon: "file",
      dismissLabel: "Hide conversion progress",
      steps: TIMELINE_ORDER.map((step) => ({ id: step, label: STEP_LABEL[step] })),
    });

    this.setButtons([
      {
        label: "Hide",
        onClick: () => this.close(),
      },
      ...(this.onCancel
        ? [
            {
              label: "Cancel",
              onClick: () => {
                this.onCancel?.();
                this.close();
              },
            },
          ]
        : []),
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
    const icon = event.icon || STAGE_ICON[event.stage] || "loader";
    this.panel.setStatus({
      label: event.label ?? "Working…",
      icon,
      progress,
      state: "running",
    });
    this.panel.setTimelineState(STAGE_TO_TIMELINE[event.stage] ?? "processing", "running");
  }

  markSuccess(payload: DocumentProcessingSuccessPayload): void {
    if (this.destroyed) {
      return;
    }

    const seconds = payload.durationMs / 1000;
    this.panel.setStatus({
      label: "Conversion complete",
      icon: STAGE_ICON.complete ?? "check-circle",
      progress: 100,
      details: `Saved to ${payload.extractionPath} in ${seconds.toFixed(seconds < 10 ? 1 : 0)}s.`,
      state: "complete",
    });
    this.panel.setTimelineState("ready", "complete");

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

    const message = describeDocumentProcessingFailure(payload.error);
    const failedStep = resolveFailedTimelineStep(payload.error);

    this.panel.setStatus({
      label: "Conversion failed",
      icon: STAGE_ICON.error ?? "x-circle",
      progress: 100,
      details: message,
      state: "error",
    });
    this.panel.setTimelineState(failedStep, "error");

    const supportsClipboard = typeof navigator !== "undefined" && Boolean(navigator.clipboard);
    this.setButtons(
      supportsClipboard
        ? [
            {
              label: "Copy error",
              onClick: async () => {
                try {
                  const copied = await tryCopyToClipboard(message);
                  if (copied) {
                    new Notice("Error copied to clipboard", 2500);
                  }
                } catch (error) {
                  console.error(error);
                }
                this.close();
              },
            },
            {
              label: "Close",
              variant: "primary",
              onClick: () => this.close(),
            },
          ]
        : [
            {
              label: "Close",
              variant: "primary",
              onClick: () => this.close(),
            },
          ]
    );
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
    this.panel.close();
  }

  private setButtons(
    descriptors: Array<{ label: string; onClick: () => void; variant?: "primary" | "default" }>
  ): void {
    this.panel.setActions(descriptors);
  }

  private scheduleAutoClose(): void {
    if (this.autoCloseTimer !== null) {
      window.clearTimeout(this.autoCloseTimer);
    }
    this.autoCloseTimer = window.setTimeout(() => this.close(), 6000);
  }
}

export const launchDocumentProcessingPanel: DocumentProcessingPanelLauncher = (options) => {
  const panel = new DocumentProcessingPanel(options);
  options.plugin.register(() => panel.close());
  return panel;
};

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  return Math.min(100, Math.max(0, value));
}

function resolveFailedTimelineStep(error: unknown): TimelineStep {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";

  if (code === "license_required" || code === "license_rejected" || code === "local_abort") {
    return "queued";
  }
  if (code === "ephemeral_download_failed" || code === "local_staging_corrupt") {
    return "processing";
  }
  if (code === "blocked_ambiguous" || code === "local_output_conflict") {
    return "contextualizing";
  }
  return "processing";
}
