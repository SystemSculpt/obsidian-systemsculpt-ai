import type { App } from "obsidian";
import type { RecorderFormat } from "./RecorderFormats";
import { MicrophoneRecorder, type RecorderStopReason } from "./MicrophoneRecorder";
import { logDebug, logError } from "../../utils/errorHandling";

export interface RecordingResult {
  filePath: string;
  blob: Blob;
  startedAt: number;
  durationMs: number;
  stopReason: RecorderStopReason;
}

export interface RecordingSessionOptions {
  app: App;
  directoryPath: string;
  ensureDirectory: (path: string) => Promise<void>;
  format: RecorderFormat;
  preferredMicrophoneId?: string | null;
  onStatus: (status: string) => void;
  onError: (error: Error) => void;
  onStreamChanged?: (stream: MediaStream) => void;
  onComplete: (result: RecordingResult) => void;
}

/**
 * Lightweight orchestrator around MicrophoneRecorder.
 */
export class RecordingSession {
  private readonly options: RecordingSessionOptions;
  private recorder: MicrophoneRecorder | null = null;
  private outputPath: string | null = null;
  private startedAt = 0;
  private active = false;

  constructor(options: RecordingSessionOptions) {
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
    this.debug("recorder constructed", {
      outputPath: this.outputPath,
      preferredMicrophone: this.options.preferredMicrophoneId ?? null,
      format: this.options.format.extension
    });

    this.recorder = new MicrophoneRecorder(this.options.app, {
      mimeType: this.options.format.mimeType,
      extension: this.options.format.extension,
      preferredMicrophoneId: this.options.preferredMicrophoneId,
      onError: this.forwardError,
      onStatus: this.options.onStatus,
      onComplete: this.handleRecorderComplete,
      onStreamChanged: this.options.onStreamChanged
    });

    await this.recorder.start(this.outputPath);
    this.active = true;
    this.debug("recorder start resolved");
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
      throw new Error(`Failed to create recordings directory: ${this.options.directoryPath}`);
    }
  }

  private handleRecorderComplete = (
    filePath: string,
    blob: Blob,
    stopReason: RecorderStopReason = "manual"
  ): void => {
    this.debug("recorder onComplete received", {
      filePath,
      durationMs: Date.now() - this.startedAt
    });
    this.active = false;
    const result: RecordingResult = {
      filePath,
      blob,
      startedAt: this.startedAt,
      durationMs: Date.now() - this.startedAt,
      stopReason
    };

    this.options.onComplete(result);
    this.dispose();
  };

  private forwardError = (error: Error): void => {
    logError("RecordingSession", "Recorder emitted error", error);
    this.active = false;
    this.dispose();
    this.options.onError(error);
  };

  private debug(message: string, data: Record<string, unknown> = {}): void {
    logDebug("RecordingSession", message, {
      outputPath: this.outputPath,
      active: this.active,
      ...data
    });
  }
}
