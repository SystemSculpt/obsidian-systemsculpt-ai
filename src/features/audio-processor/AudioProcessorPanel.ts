import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { OperationProgressPanel } from "../../core/ui/progress/OperationProgressPanel";
import type {
  AudioProcessorArtifactKind,
  AudioProcessorAvailableTranscript,
  AudioProcessorCompletedNote,
  AudioProcessorProgressEvent,
} from "./types";

type TimelineStep = "source" | "transcribing" | "summarizing" | "saving";
const TIMELINE_STEPS: readonly TimelineStep[] = [
  "source", "transcribing", "summarizing", "saving",
];

export class AudioProcessorPanel {
  private panel: OperationProgressPanel | null;
  private hidden = false;
  private finished = false;
  private currentStep: TimelineStep = "source";
  private artifactBusy = false;
  private serverOwned = false;
  private availableTranscript: AudioProcessorAvailableTranscript | null = null;
  private lastProgressEvent: AudioProcessorProgressEvent | null = null;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    sourceLabel: string,
    private readonly onCancel: () => void,
    host?: HTMLElement,
  ) {
    this.panel = new OperationProgressPanel({
      title: "Audio Processor",
      icon: "notebook-tabs",
      metaText: sourceLabel,
      metaIcon: "audio-lines",
      dismissLabel: "Hide audio progress",
      host,
      onDismiss: () => {
        this.hidden = true;
        this.panel = null;
        this.notifyHiddenProgress();
      },
      steps: [
        { id: "source", label: "Source" },
        { id: "transcribing", label: "Transcript" },
        { id: "summarizing", label: "Summary" },
        { id: "saving", label: "Save" },
      ],
    });
    this.renderRunningActions("Cancel");
    plugin.register(() => this.close());
  }

  update(event: AudioProcessorProgressEvent): void {
    this.lastProgressEvent = event;
    this.availableTranscript = event.availableTranscript ?? null;
    if (!this.panel) return;
    const step = event.stage === "awaiting_funds"
      ? this.currentStep
      : timelineStep(event);
    this.currentStep = step;
    this.serverOwned = event.serverOwned === true || [
      "queued", "awaiting_funds", "transcribing", "summarizing", "rendering", "complete", "saving",
    ].includes(event.stage);
    this.panel.setStatus({
      label: event.message,
      icon: iconForStage(event.stage),
      progress: Math.round(Math.max(0, Math.min(1, event.progress)) * 100),
      details: event.stage === "awaiting_funds"
        ? fundingDetails(event)
        : undefined,
      state: event.stage === "awaiting_funds" ? "warning" : "running",
    });
    if (event.stage === "awaiting_funds") {
      this.renderAwaitingFundsActions();
    } else {
      this.renderRunningActions(
        this.serverOwned
          ? "Stop watching"
          : event.stage === "uploading"
            ? "Cancel upload"
            : "Cancel",
      );
    }
    const stepIndex = TIMELINE_STEPS.indexOf(step);
    TIMELINE_STEPS.forEach((candidate, index) => {
      if (index < stepIndex) this.panel?.setTimelineState(candidate, "complete");
    });
    this.panel.setTimelineState(step, "running");
  }

  succeed(note: AudioProcessorCompletedNote): void {
    this.finished = true;
    if (!this.panel || this.hidden) {
      new Notice(
        note.summaryAvailable
          ? `Audio note and transcript saved to ${note.notePath}.`
          : `Transcript saved to ${note.transcriptPath}; summary unavailable.`,
        6000,
      );
      return;
    }
    this.renderCompleted(note);
  }

  private renderCompleted(note: AudioProcessorCompletedNote): void {
    if (!this.panel) return;
    if (!note.summaryAvailable) {
      this.panel.setStatus({
        label: "Transcript saved; summary unavailable",
        icon: "file-warning",
        progress: 100,
        details: note.transcriptPath,
        state: "warning",
      });
      this.panel.setTimelineState("summarizing", "error");
      this.panel.setActions([{
        label: "Open transcript",
        variant: "primary",
        disabled: this.artifactBusy,
        onClick: () => void this.openArtifact(note, "transcript"),
      }]);
      return;
    }
    this.panel.setStatus({
      label: "Audio note ready",
      icon: "check-circle",
      progress: 100,
      details: note.notePath,
      state: "complete",
    });
    TIMELINE_STEPS.forEach((step) => this.panel?.setTimelineState(step, "complete"));
    this.panel.setActions([
      {
        label: "Open note",
        variant: "primary",
        disabled: this.artifactBusy,
        onClick: () => void note.open(),
      },
      {
        label: "Open transcript",
        disabled: this.artifactBusy,
        onClick: () => void this.openArtifact(note, "transcript"),
      },
    ]);
  }

  private async openArtifact(
    note: AudioProcessorCompletedNote,
    kind: AudioProcessorArtifactKind,
  ): Promise<void> {
    if (this.artifactBusy || !this.panel) return;
    this.artifactBusy = true;
    const label = kind === "summary" ? "Summary" : "Transcript";
    this.renderCompleted(note);
    this.panel.setStatus({
      label: `Opening ${kind}…`,
      icon: "loader-circle",
      progress: 100,
      state: "running",
    });
    try {
      const saved = await note.saveArtifact(kind);
      await saved.open();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      new Notice(
        error instanceof Error ? error.message : `Unable to open the audio ${label.toLowerCase()}.`,
        7000,
      );
    } finally {
      this.artifactBusy = false;
      this.renderCompleted(note);
    }
  }

  fail(error: unknown): void {
    this.finished = true;
    const message = error instanceof Error ? error.message : String(error ?? "Audio processing failed.");
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    if (!this.panel || this.hidden) {
      if (cancelled) return;
      new Notice(`Audio processing failed: ${message}`, 7000);
      return;
    }
    const stoppedWatching = cancelled && this.serverOwned;
    this.panel.setStatus({
      label: stoppedWatching
        ? "Stopped watching audio progress"
        : cancelled
          ? "Audio processing cancelled"
        : "Audio processing failed",
      icon: stoppedWatching ? "eye-off" : cancelled ? "circle-slash" : "x-circle",
      progress: 100,
      details: stoppedWatching
        ? "Processing is continuing on the server. Reopen Audio Processor to check it."
        : message,
      state: stoppedWatching ? "warning" : "error",
    });
    if (!stoppedWatching) this.panel.setTimelineState(this.currentStep, "error");
    this.panel.setActions([{ label: "Close", variant: "primary", onClick: () => this.close() }]);
  }

  close(): void {
    this.panel?.close();
    this.panel = null;
    this.hidden = true;
  }

  private hide(): void {
    this.hidden = true;
    this.panel?.close();
    this.panel = null;
    this.notifyHiddenProgress();
  }

  private renderRunningActions(cancelLabel: string): void {
    this.panel?.setActions([
      ...(this.availableTranscript ? [{
        label: "Open transcript",
        variant: "primary" as const,
        disabled: this.artifactBusy,
        onClick: () => void this.openAvailableTranscript(),
      }] : []),
      { label: "Hide", onClick: () => this.hide() },
      { label: cancelLabel, onClick: this.onCancel },
    ]);
  }

  private renderAwaitingFundsActions(): void {
    this.panel?.setActions([
      ...(this.availableTranscript ? [{
        label: "Open transcript",
        variant: "primary" as const,
        disabled: this.artifactBusy,
        onClick: () => void this.openAvailableTranscript(),
      }] : []),
      {
        label: "Credits & usage",
        variant: this.availableTranscript ? undefined : "primary",
        onClick: () => void this.plugin.openCreditsBalanceModal(),
      },
      { label: "Hide", onClick: () => this.hide() },
      { label: "Stop watching", onClick: this.onCancel },
    ]);
  }

  private async openAvailableTranscript(): Promise<void> {
    const available = this.availableTranscript;
    if (!available || this.artifactBusy || !this.panel) return;
    this.artifactBusy = true;
    if (this.lastProgressEvent?.stage === "awaiting_funds") {
      this.renderAwaitingFundsActions();
    } else {
      this.renderRunningActions("Stop watching");
    }
    this.panel.setStatus({
      label: "Opening transcript…",
      icon: "loader-circle",
      progress: this.lastProgressEvent
        ? Math.round(Math.max(0, Math.min(1, this.lastProgressEvent.progress)) * 100)
        : 100,
      state: "running",
    });
    try {
      const saved = await available.save();
      await saved.open();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        new Notice(
          error instanceof Error ? error.message : "Unable to open the audio transcript.",
          7000,
        );
      }
    } finally {
      this.artifactBusy = false;
      if (this.lastProgressEvent) this.update(this.lastProgressEvent);
    }
  }

  private notifyHiddenProgress(): void {
    if (this.finished) return;
    new Notice(
      this.serverOwned
        ? "Audio processing is continuing on the server. You can close Obsidian and resume later."
        : "This audio is still being prepared. Keep Obsidian open until server processing begins.",
      5000,
    );
  }
}

function timelineStep(event: AudioProcessorProgressEvent): TimelineStep {
  if (
    event.stage === "preparing"
    || event.stage === "uploading"
    || event.stage === "queued"
    || event.stage === "awaiting_funds"
  ) return "source";
  if (event.stage === "transcribing") return "transcribing";
  if (event.stage === "summarizing" || event.stage === "rendering") return "summarizing";
  return "saving";
}

function iconForStage(stage: AudioProcessorProgressEvent["stage"]): string {
  switch (stage) {
    case "preparing": return "loader-circle";
    case "uploading": return "upload";
    case "queued": return "clock-3";
    case "awaiting_funds": return "circle-dollar-sign";
    case "transcribing": return "audio-lines";
    case "summarizing": return "sparkles";
    case "rendering": return "file-text";
    case "complete": return "check-circle";
    case "saving": return "hard-drive";
  }
}

function fundingDetails(event: AudioProcessorProgressEvent): string {
  const quoted = event.quotedCredits;
  const charged = event.chargedCredits ?? 0;
  const quote = typeof quoted === "number"
    ? `This audio is quoted at ${quoted.toLocaleString()} credits; ${charged.toLocaleString()} charged so far. `
    : "";
  return `${quote}It will resume automatically after credits are added.`;
}
