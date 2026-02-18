import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { createHoverShell, type HoverShellHandle, type HoverShellLayout } from "../../components/HoverShell";
import { openRecorderAdvancedModal } from "../../modals/RecorderAdvancedModal";
import { PlatformContext } from "../PlatformContext";

export interface RecorderUIManagerOptions {
  app: App;
  plugin: SystemSculptPlugin;
  platform?: PlatformContext;
  recorderType?: "audio" | "video";
}

/**
 * Handles recorder hover UI (shared shell for audio/video), timers, and optional visualization.
 */
export class RecorderUIManager {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly platform: PlatformContext;
  private readonly recorderType: "audio" | "video";

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
    this.platform = options.platform ?? PlatformContext.get();
    this.recorderType = options.recorderType ?? "audio";
  }

  public open(onStop: () => void): void {
    this.close();
    this.clearCloseTimer();
    this.stopRequested = false;
    this.stopCallback = onStop;

    const variant = this.platform.uiVariant();
    this.createHover(variant);
    this.visible = true;
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

    this.timerInterval = window.setInterval(() => {
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
    if (this.timerInterval) {
      window.clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  public closeAfter(delayMs: number): void {
    this.clearCloseTimer();
    this.closeTimeout = window.setTimeout(() => this.close(), delayMs);
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

  private createHover(variant: HoverShellLayout): void {
    const title = this.recorderType === "video" ? "Video Recorder" : "Audio Recorder";
    const icon = this.recorderType === "video" ? "video" : "mic";

    this.hoverShell = createHoverShell({
      title,
      subtitle: "In progress",
      icon,
      statusText: "Preparing recorder...",
      className: "ss-recorder-hover",
      width: variant === "mobile" ? "min(420px, calc(100vw - 24px))" : "300px",
      layout: variant,
      draggable: variant === "desktop",
      defaultPosition: variant === "desktop" ? { top: "72px", right: "24px" } : { bottom: "18px", left: "12px" },
      positionKey: `recorder-hover:${this.recorderType}`,
      showStatusRow: true,
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

    if (this.recorderType === "audio") {
      const visualizerWrap = contentEl.createDiv("ss-recorder-hover__visualizer-wrap");
      const canvas = visualizerWrap.createEl("canvas", {
        cls: "ss-recorder-hover__visualizer",
        attr: { width: "260", height: "52" },
      });
      this.visualizerCanvas = canvas;
      this.visualizerCtx = canvas.getContext("2d");
      if (this.visualizerCtx) {
        this.visualizerCtx.fillStyle = getComputedStyle(document.body).getPropertyValue("--background-secondary");
        this.visualizerCtx.fillRect(0, 0, canvas.width, canvas.height);
      }
    } else {
      this.visualizerCanvas = null;
      this.visualizerCtx = null;
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
          openRecorderAdvancedModal(this.app, this.plugin, { context: this.recorderType });
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

    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.analyser);
    this.renderVisualization();
  }

  private renderVisualization(): void {
    if (!this.analyser || !this.visualizerCtx || !this.visualizerCanvas) {
      return;
    }

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);

    const background = getComputedStyle(document.body).getPropertyValue("--background-secondary");
    this.visualizerCtx.fillStyle = background;
    this.visualizerCtx.fillRect(0, 0, this.visualizerCanvas.width, this.visualizerCanvas.height);

    const barWidth = (this.visualizerCanvas.width / bufferLength) * 2.2;
    const barSpacing = 1;
    let x = 0;

    const accentColor = getComputedStyle(document.body).getPropertyValue("--text-accent");
    const mutedAccent = getComputedStyle(document.body).getPropertyValue("--text-muted");

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

    this.animationId = requestAnimationFrame(() => this.renderVisualization());
  }

  private stopVisualization(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.analyser = null;
  }

  private clearCloseTimer(): void {
    if (this.closeTimeout) {
      window.clearTimeout(this.closeTimeout);
      this.closeTimeout = null;
    }
  }
}
