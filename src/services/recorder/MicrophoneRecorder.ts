import { App } from "obsidian";

export type RecorderStopReason = "manual" | "background-hidden" | "background-pagehide";

export interface MicrophoneRecorderOptions {
  mimeType: string;
  extension: string;
  preferredMicrophoneId?: string | null;
  onError: (error: Error) => void;
  onStatus: (status: string) => void;
  onComplete: (filePath: string, audioBlob: Blob, stopReason?: RecorderStopReason) => void;
  onStreamChanged?: (stream: MediaStream) => void;
}

type RecorderState = "idle" | "starting" | "recording" | "stopping";

/**
 * Minimal, resilient microphone recorder (no system audio). Handles device
 * changes by reacquiring the mic and keeps MediaRecorder running with the
 * latest stream.
 */
export class MicrophoneRecorder {
  private readonly app: App;
  private readonly mimeType: string;
  private readonly extension: string;
  private readonly onError: (error: Error) => void;
  private readonly onStatus: (status: string) => void;
  private readonly onComplete: (filePath: string, audioBlob: Blob, stopReason?: RecorderStopReason) => void;
  private readonly onStreamChanged: ((stream: MediaStream) => void) | null;
  private readonly preferredMicrophoneId: string | null;

  private state: RecorderState = "idle";
  private micStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  private deviceChangeListener: ((this: MediaDevices, ev: Event) => any) | null = null;
  private micTrackEndListener: (() => void) | null = null;
  private visibilityChangeListener: (() => void) | null = null;
  private pageHideListener: ((event: Event) => void) | null = null;
  private refreshingMic = false;
  private stopReason: RecorderStopReason = "manual";
  private wakeLockSentinel: any = null;
  private wakeLockHintShown = false;

  constructor(app: App, options: MicrophoneRecorderOptions) {
    this.app = app;
    this.mimeType = options.mimeType;
    this.extension = options.extension;
    this.onError = options.onError;
    this.onStatus = options.onStatus;
    this.onComplete = options.onComplete;
    this.onStreamChanged = options.onStreamChanged ?? null;
    this.preferredMicrophoneId = options.preferredMicrophoneId ?? null;
  }

  public async start(outputPath: string): Promise<void> {
    if (this.state !== "idle") {
      this.onStatus("Recorder is busy");
      return;
    }

    this.state = "starting";
    this.chunks = [];
    this.stopReason = "manual";
    this.wakeLockHintShown = false;

    try {
      this.micStream = await this.acquireMicrophoneStream();
      this.attachMicListeners(this.micStream);

      const activeStream = this.micStream;
      this.mediaRecorder = this.createMediaRecorder(activeStream);
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      this.mediaRecorder.onstop = async () => {
        await this.finalizeRecording(outputPath);
      };

      this.mediaRecorder.start(800);
      this.state = "recording";
      this.attachLifecycleListeners();

      const micLabel = this.micStream.getAudioTracks()[0]?.label || "Default microphone";
      this.onStatus(`Recording with: ${micLabel}`);
      void this.ensureWakeLock();

      if (this.onStreamChanged) {
        try {
          this.onStreamChanged(activeStream);
        } catch (_) {}
      }
    } catch (error) {
      this.state = "idle";
      this.releaseStreams();
      this.onError(this.normalizeStartError(error));
    }
  }

  public stop(reason: RecorderStopReason = "manual"): void {
    if (this.state !== "recording") {
      return;
    }
    this.state = "stopping";
    this.stopReason = reason;
    if (reason === "manual") {
      this.onStatus("Processing recording...");
    } else {
      this.onStatus("App moved to background. Saving captured audio...");
    }

    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try {
          if (typeof this.mediaRecorder.requestData === "function") {
            this.mediaRecorder.requestData();
          }
        } catch (_) {}
        this.mediaRecorder.stop();
      } else {
        void this.finalizeRecording();
      }
    } catch (error) {
      this.onError(new Error(`Stop failed: ${error instanceof Error ? error.message : String(error)}`));
      this.release();
    }
  }

  public cleanup(): void {
    this.release();
  }

  public get recording(): boolean {
    return this.state === "recording";
  }

  public getMediaStream(): MediaStream | null {
    return this.micStream;
  }

  private async acquireMicrophoneStream(): Promise<MediaStream> {
    this.onStatus("Requesting microphone access...");

    const baseConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    const constrained: MediaTrackConstraints = this.preferredMicrophoneId
      ? { ...baseConstraints, deviceId: { exact: this.preferredMicrophoneId } }
      : baseConstraints;

    const streamPromise = navigator.mediaDevices.getUserMedia({ audio: constrained });
    const timeoutPromise = new Promise<MediaStream>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              "Browser took too long to grant microphone access. Please check your microphone permissions."
            )
          ),
        10000
      );
    });

    try {
      return await Promise.race([streamPromise, timeoutPromise]);
    } catch (error) {
      if (
        this.preferredMicrophoneId &&
        error instanceof Error &&
        (error.message.includes("NotFoundError") ||
          error.message.includes("not found") ||
          error.message.includes("OverconstrainedError"))
      ) {
        this.onStatus("Preferred microphone not available, using default...");
        const fallback = navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
        return await Promise.race([fallback, timeoutPromise]);
      }

      this.onStatus("Retrying with basic microphone settings...");
      const fallback = navigator.mediaDevices.getUserMedia({ audio: true });
      return await Promise.race([fallback, timeoutPromise]);
    }
  }

  private createMediaRecorder(stream: MediaStream): MediaRecorder {
    try {
      return new MediaRecorder(stream, { mimeType: this.mimeType });
    } catch (_) {
      return new MediaRecorder(stream);
    }
  }

  private attachMicListeners(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (track) {
      this.micTrackEndListener = () => {
        void this.refreshMicStream("Microphone disconnected");
      };
      track.addEventListener("ended", this.micTrackEndListener, { once: true });
    }

    if (!this.deviceChangeListener) {
      this.deviceChangeListener = () => {
        void this.refreshMicStream("Input device changed");
      };
      try {
        navigator.mediaDevices.addEventListener("devicechange", this.deviceChangeListener);
      } catch (_) {}
    }
  }

  private detachMicListeners(): void {
    if (this.micStream) {
      const track = this.micStream.getAudioTracks()[0];
      if (track && this.micTrackEndListener) {
        track.removeEventListener("ended", this.micTrackEndListener);
      }
    }
    this.micTrackEndListener = null;

    if (this.deviceChangeListener) {
      try {
        navigator.mediaDevices.removeEventListener("devicechange", this.deviceChangeListener);
      } catch (_) {}
      this.deviceChangeListener = null;
    }
  }

  private async refreshMicStream(reason: string): Promise<void> {
    if (this.refreshingMic || this.state !== "recording") return;
    this.refreshingMic = true;
    this.onStatus(`${reason}; reconnecting microphone...`);

    try {
      const next = await this.acquireMicrophoneStream();
      this.swapMicStream(next);
      this.onStatus("Microphone reconnected");
    } catch (error) {
      this.onError(new Error(`Microphone lost: ${error instanceof Error ? error.message : String(error)}`));
      this.stop("manual");
    } finally {
      this.refreshingMic = false;
    }
  }

  private attachLifecycleListeners(): void {
    if (typeof document !== "undefined" && !this.visibilityChangeListener) {
      this.visibilityChangeListener = () => {
        if (this.state !== "recording") return;
        if (document.hidden) {
          this.stop("background-hidden");
          return;
        }
        void this.ensureWakeLock();
      };
      document.addEventListener("visibilitychange", this.visibilityChangeListener);
    }

    if (typeof window !== "undefined" && !this.pageHideListener) {
      this.pageHideListener = () => {
        if (this.state !== "recording") return;
        this.stop("background-pagehide");
      };
      window.addEventListener("pagehide", this.pageHideListener);
    }
  }

  private detachLifecycleListeners(): void {
    if (typeof document !== "undefined" && this.visibilityChangeListener) {
      document.removeEventListener("visibilitychange", this.visibilityChangeListener);
      this.visibilityChangeListener = null;
    }

    if (typeof window !== "undefined" && this.pageHideListener) {
      window.removeEventListener("pagehide", this.pageHideListener);
      this.pageHideListener = null;
    }
  }

  private async ensureWakeLock(): Promise<void> {
    if (this.state !== "recording") return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.wakeLockSentinel) return;

    const wakeLockApi = (navigator as any)?.wakeLock;
    if (!wakeLockApi || typeof wakeLockApi.request !== "function") {
      this.notifyWakeLockHint();
      return;
    }

    try {
      const sentinel = await wakeLockApi.request("screen");
      this.wakeLockSentinel = sentinel;
      if (this.wakeLockSentinel && typeof this.wakeLockSentinel.addEventListener === "function") {
        this.wakeLockSentinel.addEventListener("release", this.handleWakeLockReleased);
      }
    } catch (_) {
      this.notifyWakeLockHint();
    }
  }

  private handleWakeLockReleased = (): void => {
    this.wakeLockSentinel = null;
    if (this.state === "recording") {
      void this.ensureWakeLock();
    }
  };

  private notifyWakeLockHint(): void {
    if (this.wakeLockHintShown) return;
    this.wakeLockHintShown = true;
    this.onStatus("Recording started. Keep your screen awake for uninterrupted iOS capture.");
  }

  private async releaseWakeLock(): Promise<void> {
    const sentinel = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    if (!sentinel) return;

    try {
      if (typeof sentinel.removeEventListener === "function") {
        sentinel.removeEventListener("release", this.handleWakeLockReleased);
      }
    } catch (_) {}

    try {
      if (typeof sentinel.release === "function") {
        await sentinel.release();
      }
    } catch (_) {}
  }

  private swapMicStream(next: MediaStream): void {
    this.detachMicListeners();
    this.stopStream(this.micStream);

    this.micStream = next;
    this.attachMicListeners(next);

    if (this.onStreamChanged && this.micStream) {
      try {
        this.onStreamChanged(this.micStream);
      } catch (_) {}
    }
  }

  private stopStream(stream: MediaStream | null): void {
    if (!stream) return;
    try {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_) {}
      });
    } catch (_) {}
  }

  private async finalizeRecording(outputPath?: string): Promise<void> {
    try {
      if (this.chunks.length === 0) {
        if (this.stopReason !== "manual") {
          throw new Error("No audio data captured before app lock/background transition");
        }
        throw new Error("No audio data recorded");
      }

      const blob = new Blob(this.chunks, { type: this.mimeType });
      if (outputPath) {
        const arrayBuffer = await blob.arrayBuffer();
        await this.app.vault.adapter.writeBinary(outputPath, arrayBuffer);
        if (this.stopReason === "manual") {
          this.onStatus("Recording saved");
        } else {
          this.onStatus("Recording saved after app lock/background");
        }
        this.onComplete(outputPath, blob, this.stopReason);
      }
    } catch (error) {
      this.onError(new Error(`Save failed: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      this.release();
    }
  }

  private normalizeStartError(error: unknown): Error {
    if (!(error instanceof Error)) return new Error("Failed to start recording");

    if (
      error.message.includes("Permission denied") ||
      error.message.includes("permission") ||
      error.message.includes("NotAllowedError")
    ) {
      return new Error("Microphone access denied. Please check your system permissions.");
    }
    if (error.message.includes("not found") || error.message.includes("NotFoundError")) {
      return new Error("No microphone detected. Please connect a microphone and try again.");
    }
    if (error.message.includes("timeout")) {
      return new Error("Browser took too long to respond. Try refreshing or check microphone permissions.");
    }

    return new Error(error.message);
  }

  private releaseStreams(): void {
    this.stopStream(this.micStream);
    this.detachMicListeners();
    this.detachLifecycleListeners();
    this.micStream = null;
  }

  private release(): void {
    if (this.mediaRecorder) {
      try {
        if (this.mediaRecorder.state !== "inactive") {
          this.mediaRecorder.stop();
        }
      } catch (_) {}
      this.mediaRecorder = null;
    }

    this.releaseStreams();
    void this.releaseWakeLock();
    this.chunks = [];
    this.stopReason = "manual";
    this.wakeLockHintShown = false;
    this.state = "idle";
  }
}
