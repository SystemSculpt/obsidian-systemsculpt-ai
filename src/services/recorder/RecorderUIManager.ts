import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { createHoverShell, type HoverShellHandle } from "../../components/HoverShell";
import {
  resolveRecorderHostContext,
  type RecorderHostContext,
} from "./RecorderHostContext";

export type RecorderUiPhase =
  | "starting"
  | "recording"
  | "saving"
  | "saved"
  | "transcribing"
  | "complete"
  | "warning"
  | "error";

export interface RecorderUiModel {
  phase: RecorderUiPhase;
  status: string;
  startedAt?: number;
  durationMs?: number;
  microphoneLabel?: string;
  progress?: number;
  sourcePath?: string;
  outputPath?: string;
  canRetry?: boolean;
  canRetrySave?: boolean;
}

export interface RecorderUiActions {
  onStop: () => void;
  onClose: () => void;
  onTranscribe: () => void;
  onRetry: () => void;
  onRetrySave: () => void;
  onCancelTranscription: () => void;
  onOpenOutput: () => void;
  onOpenSettings: () => void;
}

export interface RecorderUIManagerOptions {
  app: App;
  plugin: SystemSculptPlugin;
  host?: HTMLElement;
}

/**
 * State-driven recorder presentation. Capture and transcription own the
 * workflow; this class only renders the latest immutable snapshot.
 */
export class RecorderUIManager {
  private readonly configuredHost: HTMLElement | null;
  private hostContext: RecorderHostContext | null = null;
  private shell: HoverShellHandle | null = null;
  private actions: RecorderUiActions | null = null;
  private currentModel: RecorderUiModel | null = null;

  private phaseEl: HTMLElement | null = null;
  private timerEl: HTMLTimeElement | null = null;
  private microphoneEl: HTMLElement | null = null;
  private fileEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private timerInterval: number | null = null;
  private timerStartedAt: number | null = null;
  private closeTimeout: number | null = null;

  constructor(options: RecorderUIManagerOptions) {
    this.configuredHost = options.host ?? null;
  }

  public open(actions: RecorderUiActions, initial: RecorderUiModel): RecorderHostContext {
    this.close();
    this.actions = actions;
    this.hostContext = resolveRecorderHostContext(this.configuredHost);
    this.createShell();
    this.render(initial);
    this.shell?.show();
    return this.hostContext;
  }

  public render(model: RecorderUiModel): void {
    this.currentModel = model;
    if (!this.shell) return;

    this.clearCloseTimer();
    this.shell.setState(model.phase);
    this.shell.setSubtitle(this.subtitleFor(model.phase));
    this.shell.setStatus(model.status);
    if (this.phaseEl) this.phaseEl.setText(this.badgeFor(model.phase));

    this.syncTimer(model);
    this.syncMetadata(model);
    this.syncProgress(model);
    this.syncActions(model);
  }

  public closeAfter(delayMs: number): void {
    this.clearCloseTimer();
    const hostWindow = this.hostContext?.hostWindow;
    if (!hostWindow) return;
    this.closeTimeout = hostWindow.setTimeout(() => this.close(), delayMs);
  }

  public close(): void {
    this.clearCloseTimer();
    this.stopTimer();
    this.shell?.destroy();
    this.shell = null;
    this.actions = null;
    this.currentModel = null;
    this.phaseEl = null;
    this.timerEl = null;
    this.microphoneEl = null;
    this.fileEl = null;
    this.progressEl = null;
    this.progressFillEl = null;
    this.hostContext = null;
  }

  public isVisible(): boolean {
    return this.shell !== null;
  }

  private createShell(): void {
    const context = this.ensureHostContext();
    this.shell = createHoverShell({
      title: "Audio recorder",
      subtitle: "Starting",
      icon: "mic",
      statusText: "Preparing microphone…",
      className: "ss-recorder-hover",
      width: "320px",
      draggable: true,
      defaultPosition: { top: "72px", right: "24px" },
      positionKey: "recorder-hover:audio:v2",
      showStatusRow: true,
      host: context.host,
    });

    const content = this.shell.contentEl;
    const summary = content.createDiv({ cls: "ss-recorder-hover__summary" });
    this.phaseEl = summary.createSpan({
      cls: "ss-recorder-hover__phase",
      text: "Starting",
    });
    this.timerEl = summary.createEl("time", {
      cls: "ss-recorder-hover__timer",
      text: "00:00",
      attr: { "aria-label": "Elapsed time: 0 minutes 0 seconds" },
    });

    const details = content.createDiv({ cls: "ss-recorder-hover__details" });
    this.microphoneEl = details.createDiv({ cls: "ss-recorder-hover__detail is-hidden" });
    this.fileEl = details.createDiv({ cls: "ss-recorder-hover__detail is-hidden" });

    this.progressEl = content.createDiv({
      cls: "ss-recorder-hover__progress is-hidden",
      attr: {
        role: "progressbar",
        "aria-label": "Transcription progress",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": "0",
      },
    });
    this.progressFillEl = this.progressEl.createDiv({ cls: "ss-recorder-hover__progress-fill" });
  }

  private syncTimer(model: RecorderUiModel): void {
    if (!this.timerEl) return;
    if (model.phase === "recording" && typeof model.startedAt === "number") {
      this.startTimer(model.startedAt);
      this.updateTimer(Date.now() - (this.timerStartedAt ?? model.startedAt));
      return;
    }

    this.stopTimer();
    this.updateTimer(model.durationMs ?? 0);
  }

  private startTimer(startedAt: number): void {
    if (this.timerInterval !== null) return;
    this.timerStartedAt = startedAt;
    const hostWindow = this.ensureHostContext().hostWindow;
    this.timerInterval = hostWindow.setInterval(() => {
      if (this.currentModel?.phase !== "recording") return;
      this.updateTimer(Date.now() - (this.timerStartedAt ?? startedAt));
    }, 1_000);
  }

  private stopTimer(): void {
    if (this.timerInterval === null) return;
    this.hostContext?.hostWindow.clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.timerStartedAt = null;
  }

  private updateTimer(durationMs: number): void {
    if (!this.timerEl) return;
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    this.timerEl.setText(`${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`);
    this.timerEl.dateTime = `PT${minutes}M${seconds}S`;
    this.timerEl.setAttr("aria-label", `Elapsed time: ${minutes} minutes ${seconds} seconds`);
  }

  private syncMetadata(model: RecorderUiModel): void {
    this.setDetail(this.microphoneEl, model.microphoneLabel ? `Microphone: ${model.microphoneLabel}` : "");
    const path = model.outputPath ?? model.sourcePath ?? "";
    this.setDetail(this.fileEl, path ? this.basename(path) : "");
  }

  private setDetail(element: HTMLElement | null, value: string): void {
    if (!element) return;
    element.toggleClass("is-hidden", !value);
    element.setText(value);
    if (value) element.setAttr("title", value);
    else element.removeAttribute("title");
  }

  private syncProgress(model: RecorderUiModel): void {
    if (!this.progressEl || !this.progressFillEl) return;
    const visible = model.phase === "transcribing" && typeof model.progress === "number";
    this.progressEl.toggleClass("is-hidden", !visible);
    const value = Math.round(Math.max(0, Math.min(100, model.progress ?? 0)));
    this.progressEl.setAttr("aria-valuenow", String(value));
    this.progressFillEl.style.width = `${value}%`;
  }

  private syncActions(model: RecorderUiModel): void {
    if (!this.shell || !this.actions) return;
    const actions = this.actions;

    if (model.phase === "starting") {
      this.shell.setFooterActions([{
        id: "stop",
        label: "Cancel",
        icon: "x",
        onClick: actions.onStop,
      }]);
      return;
    }
    if (model.phase === "recording") {
      this.shell.setFooterActions([{
        id: "stop",
        label: "Stop recording",
        icon: "square",
        variant: "danger",
        onClick: actions.onStop,
      }]);
      return;
    }
    if (model.phase === "saving") {
      this.shell.setFooterActions([]);
      return;
    }
    if (model.phase === "transcribing") {
      this.shell.setFooterActions([
        {
          id: "hide",
          label: "Hide",
          onClick: actions.onClose,
        },
        {
          id: "cancel-transcription",
          label: "Stop waiting",
          icon: "x",
          onClick: actions.onCancelTranscription,
        },
      ]);
      return;
    }
    if (model.phase === "saved") {
      this.shell.setFooterActions([
        { id: "close", label: "Close", onClick: actions.onClose },
        {
          id: "transcribe",
          label: "Transcribe",
          icon: "file-audio",
          variant: "primary",
          onClick: actions.onTranscribe,
        },
      ]);
      return;
    }
    if (model.phase === "complete") {
      this.shell.setFooterActions([
        { id: "close", label: "Close", onClick: actions.onClose },
        {
          id: "open-output",
          label: "Open transcript",
          icon: "file-text",
          variant: "primary",
          onClick: actions.onOpenOutput,
        },
      ]);
      return;
    }

    if (model.phase === "warning" && model.outputPath) {
      this.shell.setFooterActions([
        { id: "close", label: "Close", onClick: actions.onClose },
        {
          id: "open-output",
          label: "Open transcript",
          icon: "file-text",
          variant: "primary",
          onClick: actions.onOpenOutput,
        },
      ]);
      return;
    }

    if (model.canRetrySave) {
      this.shell.setFooterActions([
        { id: "hide", label: "Hide", onClick: actions.onClose },
        {
          id: "retry-save",
          label: "Retry save",
          icon: "save",
          variant: "primary",
          onClick: actions.onRetrySave,
        },
      ]);
      return;
    }

    const recoveryActions = [
      { id: "settings", label: "Audio settings", icon: "settings", onClick: actions.onOpenSettings },
      ...(model.canRetry
        ? [{ id: "retry", label: "Retry transcription", icon: "rotate-cw", variant: "primary" as const, onClick: actions.onRetry }]
        : [{ id: "close", label: "Close", variant: "primary" as const, onClick: actions.onClose }]),
    ];
    this.shell.setFooterActions(recoveryActions);
  }

  private badgeFor(phase: RecorderUiPhase): string {
    switch (phase) {
      case "starting": return "Starting";
      case "recording": return "Recording";
      case "saving": return "Saving";
      case "saved": return "Saved";
      case "transcribing": return "Transcribing";
      case "complete": return "Ready";
      case "warning": return "Needs attention";
      case "error": return "Could not record";
    }
  }

  private subtitleFor(phase: RecorderUiPhase): string {
    if (phase === "recording") return "Microphone is live";
    if (phase === "transcribing") return "Audio is saved";
    if (phase === "complete") return "Transcript saved";
    return this.badgeFor(phase);
  }

  private basename(path: string): string {
    return path.split("/").filter(Boolean).pop() ?? path;
  }

  private clearCloseTimer(): void {
    if (this.closeTimeout === null) return;
    this.hostContext?.hostWindow.clearTimeout(this.closeTimeout);
    this.closeTimeout = null;
  }

  private ensureHostContext(): RecorderHostContext {
    if (!this.hostContext) {
      this.hostContext = resolveRecorderHostContext(this.configuredHost);
    }
    return this.hostContext;
  }
}
