import type { App } from "obsidian";
import type { VideoRecorderFormat } from "./VideoRecorderFormats";
import { ObsidianWindowRecorder, type VideoRecorderStopReason } from "./ObsidianWindowRecorder";
import { MacWindowShellRecorder, isRecorderCanceledError } from "./MacWindowShellRecorder";
import {
  type VideoAudioCaptureConfig,
  normalizeVideoAudioCaptureConfig,
} from "./VideoAudioCaptureConfig";
import { logDebug, logError } from "../../utils/errorHandling";

export interface VideoRecordingResult {
  filePath: string;
  blob: Blob;
  startedAt: number;
  durationMs: number;
  stopReason: VideoRecorderStopReason;
}

export interface VideoRecordingSessionOptions {
  app: App;
  directoryPath: string;
  ensureDirectory: (path: string) => Promise<void>;
  format: VideoRecorderFormat;
  onStatus: (status: string) => void;
  onError: (error: Error) => void;
  onStreamChanged?: (stream: MediaStream) => void;
  onComplete: (result: VideoRecordingResult) => void;
  recorderStrategy?: "browser" | "mac-shell";
  captureAudio?: Partial<VideoAudioCaptureConfig>;
}

export class VideoRecordingSession {
  private readonly options: VideoRecordingSessionOptions;
  private recorder:
    | ObsidianWindowRecorder
    | MacWindowShellRecorder
    | null = null;
  private outputPath: string | null = null;
  private startedAt = 0;
  private active = false;

  constructor(options: VideoRecordingSessionOptions) {
    this.options = options;
  }

  public async start(): Promise<void> {
    this.debug("start invoked");
    if (this.active) {
      this.debug("start skipped - already active");
      return;
    }

    await this.prepareDirectory();
    this.outputPath = this.buildOutputPath();
    this.startedAt = Date.now();
    const captureAudio = normalizeVideoAudioCaptureConfig(this.options.captureAudio);

    if (this.options.recorderStrategy === "mac-shell") {
      this.recorder = new MacWindowShellRecorder(this.options.app, {
        onError: this.forwardError,
        onStatus: this.options.onStatus,
        onComplete: this.handleRecorderComplete,
        captureAudio,
      });
    } else {
      this.recorder = new ObsidianWindowRecorder(this.options.app, {
        mimeType: this.options.format.mimeType,
        extension: this.options.format.extension,
        onError: this.forwardError,
        onStatus: this.options.onStatus,
        onComplete: this.handleRecorderComplete,
        onStreamChanged: this.options.onStreamChanged,
        captureAudio,
      });
    }

    try {
      await this.recorder.start(this.outputPath);
      this.active = true;
      this.debug("recorder start resolved", {
        outputPath: this.outputPath,
        format: this.options.format.extension,
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.active = false;
      this.recorder?.cleanup();
      this.recorder = null;
      throw normalized;
    }
  }

  public stop(): void {
    this.debug("stop invoked", { active: this.active });
    this.recorder?.stop();
  }

  public dispose(): void {
    this.debug("dispose invoked");
    this.recorder?.cleanup();
    this.recorder = null;
    this.active = false;
  }

  public getMediaStream(): MediaStream | null {
    return this.recorder?.getMediaStream() ?? null;
  }

  public isActive(): boolean {
    return this.active;
  }

  public getOutputPath(): string | null {
    return this.outputPath;
  }

  private buildOutputPath(): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .split(".")[0];

    return `${this.options.directoryPath}/${timestamp}.${this.options.format.extension}`;
  }

  private async prepareDirectory(): Promise<void> {
    await this.options.ensureDirectory(this.options.directoryPath);
    const exists = await this.options.app.vault.adapter.exists(this.options.directoryPath);
    if (!exists) {
      throw new Error(`Failed to create video recordings directory: ${this.options.directoryPath}`);
    }
  }

  private handleRecorderComplete = (
    filePath: string,
    blob: Blob,
    stopReason: VideoRecorderStopReason = "manual"
  ): void => {
    this.debug("recorder onComplete received", {
      filePath,
      durationMs: Date.now() - this.startedAt,
    });
    this.active = false;
    const result: VideoRecordingResult = {
      filePath,
      blob,
      startedAt: this.startedAt,
      durationMs: Date.now() - this.startedAt,
      stopReason,
    };

    this.options.onComplete(result);
    this.dispose();
  };

  private forwardError = (error: Error): void => {
    if (!isRecorderCanceledError(error)) {
      logError("VideoRecordingSession", "Recorder emitted error", error);
    }
    this.active = false;
    this.dispose();
    this.options.onError(error);
  };

  private debug(message: string, data: Record<string, unknown> = {}): void {
    logDebug("VideoRecordingSession", message, {
      outputPath: this.outputPath,
      active: this.active,
      ...data,
    });
  }
}
