import type { Editor } from "obsidian";
import { App, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { OperationProgressPanel } from "../core/ui/progress/OperationProgressPanel";
import { TranscriptionService, type TranscriptionTask } from "../services/TranscriptionService";
import {
  ManagedTranscriptionInterruptedError,
  ManagedTranscriptionRetryError,
  TranscriptionResumeRequiredError,
} from "../services/transcription/ManagedTranscriptionAdapter";
import type {
  TranscriptionPhase,
  TranscriptionProgressEvent,
} from "../services/transcription/TranscriptionCoordinator";
import {
  captureNoteInsertionTarget,
  type TranscriptionInsertionValidator,
} from "../services/transcription/NoteInsertionTarget";
import { formatFileSize } from "../utils/FileValidator";
import { tryCopyToClipboard } from "../utils/clipboard";

export interface AudioTranscriptionPanelOptions {
  file: TFile;
  timestamped?: boolean;
  targetEditor?: Editor | null;
  validateInsertionTarget?: TranscriptionInsertionValidator;
  openOnComplete?: boolean;
  plugin: SystemSculptPlugin;
}

/** One presentation for an active managed transcription task. */
export class AudioTranscriptionPanel {
  private static readonly panelsByOwner = new WeakMap<SystemSculptPlugin, Set<AudioTranscriptionPanel>>();

  private readonly options: AudioTranscriptionPanelOptions;
  private readonly app: App;
  private readonly targetEditor: Editor | null;
  private readonly validateInsertionTarget: TranscriptionInsertionValidator | undefined;

  private panel: OperationProgressPanel | null = null;
  private task: TranscriptionTask | null = null;
  private resumeOperationId: string | null = null;
  private minimized = false;
  private settled = false;
  private disposed = false;
  private registered = false;

  constructor(app: App, options: AudioTranscriptionPanelOptions) {
    this.app = app;
    this.options = options;
    const capturedTarget = captureNoteInsertionTarget(app);
    const hasExplicitTarget = Object.prototype.hasOwnProperty.call(options, "targetEditor");
    this.targetEditor = hasExplicitTarget ? options.targetEditor ?? null : capturedTarget.editor;
    this.validateInsertionTarget = options.validateInsertionTarget
      ?? (this.targetEditor && this.targetEditor === capturedTarget.editor
        ? capturedTarget.validate
        : undefined);
  }

  /**
   * Removes every presentation and local waiter owned by one plugin instance.
   * Owner identity matters during hot reloads: a late unload from the previous
   * plugin must never dispose panels launched by its replacement.
   */
  static disposeOwnedBy(plugin: SystemSculptPlugin): void {
    const panels = this.panelsByOwner.get(plugin);
    if (!panels) return;
    this.panelsByOwner.delete(plugin);
    for (const panel of [...panels]) panel.disposeForPluginUnload();
  }

  open(): void {
    if (this.disposed) return;
    this.registerOwnership();
    this.minimized = false;
    this.render();
    this.startTask();
  }

  private startTask(): void {
    if (this.disposed || this.task) return;
    this.settled = false;
    this.updateStatus({
      label: this.resumeOperationId ? "Resuming preserved transcription…" : "Preparing audio…",
      icon: "loader-2",
      progress: 1,
    });
    this.task = TranscriptionService.getInstance(this.options.plugin).start({
      filePath: this.options.file.path,
      destination: "note",
      callerScope: "audio-transcription-panel/note",
      sourceOwnership: "user-file",
      targetEditor: this.targetEditor,
      validateInsertionTarget: this.validateInsertionTarget,
      timestamped: this.options.timestamped,
      ...(this.resumeOperationId ? { resumeOperationId: this.resumeOperationId } : {}),
      onProgress: (event) => this.handleProgress(event),
    });
    void this.waitForResult(this.task);
  }

  /** Hides presentation only. The managed job keeps its own lifecycle. */
  close(): void {
    this.minimize();
  }

  private render(): void {
    if (this.disposed || this.panel) return;
    const meta = [this.options.file.name];
    if (typeof this.options.file.stat?.size === "number") {
      meta.push(formatFileSize(this.options.file.stat.size));
    }

    this.panel = new OperationProgressPanel({
      title: "Audio transcription",
      icon: "file-audio",
      metaText: meta.join(" · "),
      metaIcon: "file-audio",
      dismissLabel: "Hide transcription progress",
      onDismiss: () => {
        if (this.disposed) return;
        this.minimized = true;
        this.panel = null;
        if (!this.settled) new Notice("Transcription is continuing. You can keep using Obsidian.", 3500);
      },
      steps: [
        { id: "uploading", label: "Upload" },
        { id: "transcribing", label: "Transcribe" },
        { id: "saving", label: "Save" },
      ],
    });

    this.setButtons([
      { label: "Hide", onClick: () => this.minimize() },
      { label: "Stop waiting", onClick: () => this.stopWaiting() },
    ]);
  }

  private minimize(): void {
    if (this.disposed || this.minimized) return;
    this.minimized = true;
    this.panel?.close();
    this.panel = null;
    if (!this.settled) new Notice("Transcription is continuing. You can keep using Obsidian.", 3500);
  }

  private stopWaiting(): void {
    if (this.disposed || !this.task) return;
    this.updateStatus({
      label: "Stopped waiting locally; finishing safe cancellation…",
      icon: "loader-2",
      progress: 1,
      details: "Your source audio is unchanged.",
    });
    this.setButtons([{ label: "Hide", onClick: () => this.minimize() }]);
    this.task.cancel();
  }

  private handleProgress(event: TranscriptionProgressEvent): void {
    if (this.disposed) return;
    this.updateStatus({
      label: event.message,
      icon: this.iconForPhase(event.phase),
      progress: event.progress,
    });
    this.panel?.setTimelineState(this.timelineStep(event.phase), event.phase === "complete" ? "complete" : "running");
  }

  private async waitForResult(task: TranscriptionTask): Promise<void> {
    try {
      const result = await task.promise;
      if (this.disposed || this.task !== task) return;
      this.task = null;
      this.resumeOperationId = null;
      this.settled = true;

      if (this.options.openOnComplete) {
        try {
          await this.openOutput(result.outputPath);
        } catch {
          if (this.disposed) return;
          new Notice(`Transcript saved to ${result.outputPath}, but Obsidian could not open it automatically.`, 6000);
        }
      }
      if (this.disposed) return;
      if (result.warning) new Notice(result.warning, 6000);

      if (this.minimized || !this.panel) {
        new Notice(`Transcript saved to ${result.outputPath}.`, 6000);
        this.finish();
        return;
      }

      this.updateStatus({
        label: result.warning ? "Transcript saved with a warning" : "Transcript saved",
        icon: result.warning ? "alert-triangle" : "check-circle",
        progress: 100,
        details: result.outputPath,
      });
      this.panel.setTimelineState("saving", "complete");
      this.setButtons([
        {
          label: "Open transcript",
          variant: "primary",
          onClick: () => void this.openOutput(result.outputPath),
        },
        { label: "Close", onClick: () => this.finish() },
      ]);
    } catch (error) {
      if (this.disposed || this.task !== task) return;
      this.task = null;
      if (error instanceof Error && error.name === "AbortError") {
        const interruption = error instanceof ManagedTranscriptionInterruptedError
          ? error
          : null;
        this.resumeOperationId = interruption?.retryDisposition === "resume"
          ? interruption.operationId
          : null;
        this.settled = false;
        const blocked = interruption?.retryDisposition === "blocked";
        const label = blocked
          ? "Stopped; automatic retry is unavailable"
          : this.resumeOperationId
            ? "Stopped; server transcription is preserved"
            : "Stopped; unfinished upload was cancelled";
        const details = blocked
          ? `Operation ${interruption.operationId} has an ambiguous dispatch state. It was preserved to prevent duplicate work.`
          : this.resumeOperationId
            ? "Resume continues the same operation without uploading again."
            : "Your source audio is unchanged. Retry starts a fresh operation.";
        if (blocked && (this.minimized || !this.panel)) {
          new Notice(`${label}. ${details}`, 6500);
          this.finish();
          return;
        }
        if (this.minimized || !this.panel) {
          this.minimized = false;
          this.render();
        }
        this.updateStatus({
          label,
          icon: "alert-triangle",
          progress: 100,
          details,
        });
        this.setButtons([
          ...(!blocked ? [{
            label: this.resumeOperationId ? "Resume" : "Retry",
            variant: "primary" as const,
            onClick: () => this.startTask(),
          }] : []),
          { label: "Close", onClick: () => this.finish() },
        ]);
        return;
      }

      if (error instanceof ManagedTranscriptionRetryError) {
        this.resumeOperationId = error.retryDisposition === "resume"
          ? error.operationId
          : null;
        this.settled = false;
        const blocked = error.retryDisposition === "blocked";
        const label = blocked
          ? "Transcription paused in an ambiguous state"
          : error.retryDisposition === "resume"
            ? "Server transcription is preserved"
            : "Transcription stopped safely";
        const details = blocked
          ? `Operation ${error.operationId} was preserved to prevent duplicate work. ${error.message}`
          : error.retryDisposition === "resume"
            ? `${error.message} Retry resumes the same operation.`
            : `${error.message} Retry starts a fresh operation.`;
        if (blocked && (this.minimized || !this.panel)) {
          new Notice(`${label}. ${details}`, 7000);
          this.finish();
          return;
        }
        if (this.minimized || !this.panel) {
          this.minimized = false;
          this.render();
        }
        this.updateStatus({
          label,
          icon: "alert-triangle",
          progress: 100,
          details,
        });
        this.setButtons([
          ...(!blocked ? [{
            label: this.resumeOperationId ? "Resume" : "Retry",
            variant: "primary" as const,
            onClick: () => this.startTask(),
          }] : []),
          { label: "Close", onClick: () => this.finish() },
        ]);
        return;
      }

      if (error instanceof TranscriptionResumeRequiredError) {
        this.resumeOperationId = error.operationId;
      }
      this.settled = true;

      const message = error instanceof Error ? error.message : String(error);
      if (this.resumeOperationId && (this.minimized || !this.panel)) {
        this.minimized = false;
        this.render();
      }
      if (this.minimized || !this.panel) {
        new Notice(`Transcription failed: ${message}`, 7000);
        this.finish();
        return;
      }
      this.updateStatus({
        label: "Transcription failed",
        icon: "x-circle",
        progress: 100,
        details: message,
      });
      this.setButtons([
        ...(this.resumeOperationId ? [{
          label: "Retry save",
          variant: "primary" as const,
          onClick: () => this.startTask(),
        }] : []),
        {
          label: "Copy error",
          onClick: () => void this.copyError(message),
        },
        {
          label: "Close",
          variant: this.resumeOperationId ? "default" : "primary",
          onClick: () => this.finish(),
        },
      ]);
    }
  }

  private setButtons(
    descriptors: Array<{ label: string; onClick: () => void; variant?: "primary" | "default" }>,
  ): void {
    if (this.disposed) return;
    this.panel?.setActions(descriptors);
  }

  private updateStatus(options: {
    label: string;
    icon: string;
    progress: number;
    details?: string;
  }): void {
    if (this.disposed) return;
    this.panel?.setStatus({
      label: options.label,
      icon: options.icon,
      progress: options.progress,
      details: options.details,
      state: options.icon === "x-circle"
        ? "error"
        : options.icon === "alert-triangle"
          ? "warning"
          : options.icon === "check-circle"
            ? "complete"
            : "running",
    });
  }

  private async openOutput(path: string): Promise<void> {
    if (this.disposed) return;
    const output = this.app.vault.getAbstractFileByPath(path);
    if (!(output instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(output);
    if (this.disposed) return;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private async copyError(message: string): Promise<void> {
    const copied = await tryCopyToClipboard(message, this.panel?.element);
    if (this.disposed) return;
    new Notice(copied ? "Error copied." : "Clipboard is unavailable.", copied ? 2500 : 4000);
  }

  private finish(): void {
    if (this.disposed) return;
    this.panel?.close();
    this.panel = null;
    this.minimized = true;
    this.disposed = true;
    this.unregisterOwnership();
  }

  private registerOwnership(): void {
    if (this.registered) return;
    let panels = AudioTranscriptionPanel.panelsByOwner.get(this.options.plugin);
    if (!panels) {
      panels = new Set();
      AudioTranscriptionPanel.panelsByOwner.set(this.options.plugin, panels);
    }
    panels.add(this);
    this.registered = true;
  }

  private unregisterOwnership(): void {
    if (!this.registered) return;
    const panels = AudioTranscriptionPanel.panelsByOwner.get(this.options.plugin);
    panels?.delete(this);
    if (panels?.size === 0) {
      AudioTranscriptionPanel.panelsByOwner.delete(this.options.plugin);
    }
    this.registered = false;
  }

  private disposeForPluginUnload(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registered = false;
    this.settled = true;
    this.minimized = true;
    this.resumeOperationId = null;

    const task = this.task;
    this.task = null;
    this.panel?.close();
    this.panel = null;

    try {
      task?.cancel();
    } catch {
      // The owning TranscriptionService is unloaded next and remains the
      // authoritative fallback for aborting managed work.
    }
  }

  private iconForPhase(phase: TranscriptionPhase): string {
    switch (phase) {
      case "preparing": return "loader-2";
      case "uploading": return "upload";
      case "transcribing": return "file-audio";
      case "cleaning": return "wand-sparkles";
      case "saving": return "hard-drive";
      case "complete": return "check-circle";
    }
  }

  private timelineStep(phase: TranscriptionPhase): "uploading" | "transcribing" | "saving" {
    if (phase === "preparing" || phase === "uploading") return "uploading";
    if (phase === "transcribing" || phase === "cleaning") return "transcribing";
    return "saving";
  }
}

export function launchAudioTranscriptionPanel(
  app: App,
  options: AudioTranscriptionPanelOptions,
): AudioTranscriptionPanel {
  const panel = new AudioTranscriptionPanel(app, options);
  panel.open();
  return panel;
}
