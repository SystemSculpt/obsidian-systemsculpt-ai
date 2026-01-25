import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { createRecorderWidget, RecorderWidgetHandles } from "../../components/RecorderWidget";
import { PlatformContext } from "../PlatformContext";

export interface RecorderUIManagerOptions {
  app: App;
  plugin: SystemSculptPlugin;
  platform?: PlatformContext;
}

/**
 * Handles recorder UI (desktop widget + mobile modal), timers, and visualizer.
 */
export class RecorderUIManager {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly platform: PlatformContext;

  private recordingModal: HTMLElement | null = null;
  private handles: RecorderWidgetHandles | null = null;

  private timerInterval: number | null = null;
  private recordingStartTime = 0;

  private visualizerCanvas: HTMLCanvasElement | null = null;
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
  }

  public open(onStop: () => void): void {
    this.close();
    this.clearCloseTimer();
    const variant = this.platform.uiVariant();
    this.showFloatingRecorder(variant, onStop);
    this.visible = true;
  }

  public close(): void {
    this.clearCloseTimer();
    this.stopVisualization();
    this.stopTimer();

    if (this.recordingModal) {
      this.recordingModal.remove();
      this.recordingModal = null;
    }

    this.bindHandles(null);
    this.visible = false;
  }

  public isVisible(): boolean {
    return this.visible;
  }

  /**
   * Keep the recorder visible a bit longer to surface status instead of spamming notices.
   */
  public linger(status: string, delayMs: number = 2200): void {
    this.setStatus(status);
    this.closeAfter(delayMs);
  }

  public setStatus(status: string): void {
    if (this.handles?.statusTextEl) {
      this.handles.statusTextEl.textContent = status;
    }
  }

  public setRecordingState(recording: boolean): void {
    if (this.handles?.root) {
      this.handles.root.dataset.state = recording ? "recording" : "idle";
    }
    if (this.handles?.liveBadgeEl) {
      this.handles.liveBadgeEl.textContent = recording ? "Listening live" : "Recorder idle";
    }
  }

  public startTimer(): void {
    this.recordingStartTime = Date.now();
    this.stopTimer();

    this.timerInterval = window.setInterval(() => {
      if (!this.handles?.timerValueEl) return;

      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;

      this.handles.timerValueEl.textContent = `${minutes.toString().padStart(2, "0")}:${seconds
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
    if (!stream) {
      this.stopVisualization();
      return;
    }

    if (!this.visualizerCanvas || !this.visualizerCtx) {
      return;
    }

    try {
      await this.startVisualization(stream);
    } catch {
      // Ignore visualization failures to avoid interrupting recording
    }
  }

  public detachStream(): void {
    this.stopVisualization();
  }

  private showFloatingRecorder(variant: string, onStop: () => void): void {
    this.recordingModal = document.createElement("div");
    this.recordingModal.className = "ss-recorder-panel-host";
    this.recordingModal.classList.add(`platform-ui-${variant}`);
    document.body.appendChild(this.recordingModal);

    const handles = createRecorderWidget({
      host: this.recordingModal,
      plugin: this.plugin,
      variant: "desktop",
      onStop,
      useHostAsRoot: true
    });

    this.bindHandles(handles);
    if (handles?.dragHandleEl) {
      this.makeDraggable(this.recordingModal, handles.dragHandleEl);
    }

    requestAnimationFrame(() => {
      if (this.recordingModal) {
        this.recordingModal.classList.add("ss-recorder-panel--visible");
      }
    });
  }

  private bindHandles(handles: RecorderWidgetHandles | null): void {
    this.handles = handles;
    this.visualizerCanvas = handles?.canvasEl ?? null;
    this.visualizerCtx = this.visualizerCanvas ? this.visualizerCanvas.getContext("2d") : null;

    if (this.visualizerCtx && this.visualizerCanvas) {
      try {
        const bg = getComputedStyle(document.body).getPropertyValue("--background-secondary") || "#1f1f1f";
        this.visualizerCtx.fillStyle = bg;
        this.visualizerCtx.fillRect(0, 0, this.visualizerCanvas.width, this.visualizerCanvas.height);
      } catch {
        this.visualizerCtx.fillStyle = "#1f1f1f";
        this.visualizerCtx.fillRect(0, 0, this.visualizerCanvas.width, this.visualizerCanvas.height);
      }
    }
  }

  private makeDraggable(element: HTMLElement, handle: HTMLElement): void {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const startDrag = (clientX: number, clientY: number) => {
      isDragging = true;
      const rect = element.getBoundingClientRect();
      offsetX = clientX - rect.left;
      offsetY = clientY - rect.top;
    };

    const updatePosition = (clientX: number, clientY: number) => {
      if (!isDragging) return;
      const x = Math.max(0, Math.min(clientX - offsetX, window.innerWidth - element.offsetWidth));
      const y = Math.max(0, Math.min(clientY - offsetY, window.innerHeight - element.offsetHeight));
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    };

    const endDrag = () => {
      isDragging = false;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      handle.setPointerCapture(event.pointerId);
      startDrag(event.clientX, event.clientY);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isDragging) return;
      updatePosition(event.clientX, event.clientY);
    };

    const onPointerUp = (event: PointerEvent) => {
      handle.releasePointerCapture(event.pointerId);
      endDrag();
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
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

    const barWidth = (this.visualizerCanvas.width / bufferLength) * 2.5;
    const barSpacing = 1;
    let x = 0;

    const accentColor = getComputedStyle(document.body).getPropertyValue("--text-accent");
    const mutedAccent = getComputedStyle(document.body).getPropertyValue("--text-muted");

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * this.visualizerCanvas.height * 0.8;
      const gradient = this.visualizerCtx.createLinearGradient(0, this.visualizerCanvas.height - barHeight, 0, this.visualizerCanvas.height);
      gradient.addColorStop(0, accentColor);
      gradient.addColorStop(1, mutedAccent);
      this.visualizerCtx.fillStyle = gradient;
      this.visualizerCtx.fillRect(x, this.visualizerCanvas.height - barHeight, barWidth - barSpacing, barHeight);
      x += barWidth;
      if (x > this.visualizerCanvas.width) {
        break;
      }
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
