import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { createHoverShell, type HoverShellHandle } from "../../components/HoverShell";
import { openRecorderAdvancedModal } from "../../modals/RecorderAdvancedModal";
import {
  resolveRecorderHostContext,
  type RecorderHostContext,
} from "./RecorderHostContext";

export interface RecorderUIManagerOptions {
  app: App;
  plugin: SystemSculptPlugin;
  host?: HTMLElement;
}

type RecorderAudioContextConstructor = new () => AudioContext;
type RecorderHostWindow = Window & {
  AudioContext?: RecorderAudioContextConstructor;
  webkitAudioContext?: RecorderAudioContextConstructor;
};

/**
 * Handles recorder hover UI, timers, and visualization for audio capture.
 */
export class RecorderUIManager {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly configuredHost: HTMLElement | null;
  private hostContext: RecorderHostContext | null = null;
  private hoverShell: HoverShellHandle | null = null;
  private statusTextEl: HTMLElement | null = null;
  private timerValueEl: HTMLElement | null = null;
  private liveBadgeEl: HTMLElement | null = null;
  private visualizerCanvas: HTMLCanvasElement | null = null;
  private stopCallback: (() => void) | null = null;
  private stopRequested = false;

  private timerInterval: number | null = null;
  private recordingStartTime = 0;

  private visualizerCtx: CanvasRenderingContext2D | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationId: number | null = null;

  private visible = false;
  private closeTimeout: number | null = null;

  constructor(options: RecorderUIManagerOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.configuredHost = options.host ?? null;
  }

  public open(onStop: () => void): RecorderHostContext {
    this.close();
    this.clearCloseTimer();
    this.stopRequested = false;
    this.stopCallback = onStop;
    this.selectInitiatingHost();

    this.createHover();
    this.visible = true;
    return this.ensureHostContext();
  }

  public close(): void {
    this.clearCloseTimer();
    this.stopTimer();
    this.stopVisualization();

    this.hoverShell?.destroy();
    this.hoverShell = null;
    this.statusTextEl = null;
    this.timerValueEl = null;
    this.liveBadgeEl = null;
    this.visualizerCanvas = null;
    this.visualizerCtx = null;
    this.stopCallback = null;
    this.stopRequested = false;
    this.visible = false;
    this.hostContext = null;
  }

  public isVisible(): boolean {
    return this.visible;
  }

  /**
   * Keep the recorder visible briefly to surface completion state.
   */
  public linger(status: string, delayMs: number = 2200): void {
    this.setStatus(status);
    this.closeAfter(delayMs);
  }

  public setStatus(status: string): void {
    if (this.statusTextEl) {
      this.statusTextEl.textContent = status;
    }
    this.hoverShell?.setStatus(status);
  }

  public setRecordingState(recording: boolean): void {
    this.hoverShell?.setState(recording ? "recording" : "idle");
    if (this.liveBadgeEl) {
      this.liveBadgeEl.textContent = recording ? "Recording live" : "Recorder idle";
    }
  }

  public startTimer(): void {
    this.recordingStartTime = Date.now();
    this.stopTimer();
    const { hostWindow } = this.ensureHostContext();

    this.timerInterval = hostWindow.setInterval(() => {
      if (!this.timerValueEl) return;
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      this.timerValueEl.textContent = `${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}`;
    }, 1000);
  }

  public stopTimer(): void {
    if (this.timerInterval !== null) {
      this.hostContext?.hostWindow.clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  public closeAfter(delayMs: number): void {
    this.clearCloseTimer();
    const { hostWindow } = this.ensureHostContext();
    this.closeTimeout = hostWindow.setTimeout(() => this.close(), delayMs);
  }

  public async attachStream(stream: MediaStream | null): Promise<void> {
    if (!stream || !this.visualizerCanvas || !this.visualizerCtx) {
      this.stopVisualization();
      return;
    }

    try {
      await this.startVisualization(stream);
    } catch {
      // Visualization failures should never block recording.
    }
  }

  public detachStream(): void {
    this.stopVisualization();
  }

  private createHover(): void {
    const { host } = this.ensureHostContext();
    this.hoverShell = createHoverShell({
      title: "Audio Recorder",
      subtitle: "In progress",
      icon: "mic",
      statusText: "Preparing recorder...",
      className: "ss-recorder-hover",
      width: "300px",
      draggable: true,
      defaultPosition: { top: "72px", right: "24px" },
      positionKey: "recorder-hover:audio",
      showStatusRow: true,
      host,
    });

    this.statusTextEl = this.hoverShell.statusEl;
    this.buildContent(this.hoverShell.contentEl);
    this.renderActions();
    this.hoverShell.show();
  }

  private buildContent(contentEl: HTMLElement): void {
    contentEl.replaceChildren();

    const badgeRow = contentEl.createDiv("ss-recorder-hover__badge-row");
    const liveBadge = badgeRow.createSpan("ss-recorder-hover__live");
    liveBadge.textContent = "Recorder idle";
    this.liveBadgeEl = liveBadge;

    const timer = contentEl.createDiv("ss-recorder-hover__timer");
    timer.createSpan({ cls: "ss-recorder-hover__timer-label", text: "Live" });
    const timerValue = timer.createSpan({ cls: "ss-recorder-hover__timer-value", text: "00:00" });
    this.timerValueEl = timerValue;

    const visualizerWrap = contentEl.createDiv("ss-recorder-hover__visualizer-wrap");
    const canvas = visualizerWrap.createEl("canvas", {
      cls: "ss-recorder-hover__visualizer",
      attr: { width: "260", height: "52" },
    });
    this.visualizerCanvas = canvas;
    this.visualizerCtx = canvas.getContext("2d");
    if (this.visualizerCtx) {
      const { hostDocument, hostWindow } = this.ensureHostContext();
      this.visualizerCtx.fillStyle = hostWindow
        .getComputedStyle(hostDocument.body)
        .getPropertyValue("--background-secondary");
      this.visualizerCtx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  private renderActions(): void {
    if (!this.hoverShell) return;
    const stopLabel = this.stopRequested ? "Stopping..." : "Stop";

    this.hoverShell.setFooterActions([
      {
        id: "advanced",
        label: "Advanced",
        icon: "sliders-horizontal",
        onClick: () => {
          openRecorderAdvancedModal(this.app, this.plugin);
        },
      },
      {
        id: "stop",
        label: stopLabel,
        icon: "square",
        variant: "primary",
        disabled: this.stopRequested,
        onClick: () => this.requestStop(),
      },
    ]);
  }

  // Stop must be one tap. The first tap latches `stopRequested` and disables
  // the button; any further taps are ignored here so a laggy webview that
  // delivers several taps before the disabled state paints can't fire stop
  // more than once (#148). Reset by open(): the next recording stops in one tap.
  private requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.renderActions();
    this.stopCallback?.();
  }

  private async startVisualization(stream: MediaStream): Promise<void> {
    if (!this.visualizerCanvas || !this.visualizerCtx) {
      return;
    }

    this.stopVisualization();

    const { hostWindow } = this.ensureHostContext();
    const AudioContextConstructor = hostWindow.AudioContext ?? hostWindow.webkitAudioContext;
    if (!AudioContextConstructor) {
      return;
    }
    const audioContext = new AudioContextConstructor();
    const analyser = audioContext.createAnalyser();
    this.audioContext = audioContext;
    this.analyser = analyser;
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    this.renderVisualization();
  }

  private renderVisualization(): void {
    if (!this.analyser || !this.visualizerCtx || !this.visualizerCanvas) {
      return;
    }

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);

    const { hostDocument, hostWindow } = this.ensureHostContext();
    const themeStyles = hostWindow.getComputedStyle(hostDocument.body);
    const background = themeStyles.getPropertyValue("--background-secondary");
    this.visualizerCtx.fillStyle = background;
    this.visualizerCtx.fillRect(0, 0, this.visualizerCanvas.width, this.visualizerCanvas.height);

    const barWidth = (this.visualizerCanvas.width / bufferLength) * 2.2;
    const barSpacing = 1;
    let x = 0;

    const accentColor = themeStyles.getPropertyValue("--text-accent");
    const mutedAccent = themeStyles.getPropertyValue("--text-muted");

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * this.visualizerCanvas.height * 0.8;
      const gradient = this.visualizerCtx.createLinearGradient(
        0,
        this.visualizerCanvas.height - barHeight,
        0,
        this.visualizerCanvas.height
      );
      gradient.addColorStop(0, accentColor);
      gradient.addColorStop(1, mutedAccent);
      this.visualizerCtx.fillStyle = gradient;
      this.visualizerCtx.fillRect(x, this.visualizerCanvas.height - barHeight, barWidth - barSpacing, barHeight);
      x += barWidth;
      if (x > this.visualizerCanvas.width) break;
    }

    this.animationId = hostWindow.requestAnimationFrame(() => this.renderVisualization());
  }

  private stopVisualization(): void {
    if (this.animationId !== null) {
      this.hostContext?.hostWindow.cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.analyser = null;
  }

  private clearCloseTimer(): void {
    if (this.closeTimeout !== null) {
      this.hostContext?.hostWindow.clearTimeout(this.closeTimeout);
      this.closeTimeout = null;
    }
  }

  private selectInitiatingHost(): void {
    this.hostContext = resolveRecorderHostContext(this.configuredHost);
  }

  private ensureHostContext(): {
    host: HTMLElement;
    hostDocument: Document;
    hostWindow: RecorderHostWindow;
  } {
    if (!this.hostContext) {
      this.selectInitiatingHost();
    }
    return {
      host: this.hostContext!.host,
      hostDocument: this.hostContext!.hostDocument,
      hostWindow: this.hostContext!.hostWindow as RecorderHostWindow,
    };
  }
}
