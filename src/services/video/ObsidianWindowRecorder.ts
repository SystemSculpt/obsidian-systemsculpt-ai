import { App } from "obsidian";
import {
  type VideoAudioCaptureConfig,
  normalizeVideoAudioCaptureConfig,
} from "./VideoAudioCaptureConfig";

export type VideoRecorderStopReason = "manual" | "source-ended" | "permission-revoked";

export interface ObsidianWindowRecorderOptions {
  mimeType: string;
  extension: string;
  captureAudio?: Partial<VideoAudioCaptureConfig>;
  onError: (error: Error) => void;
  onStatus: (status: string) => void;
  onComplete: (filePath: string, videoBlob: Blob, stopReason?: VideoRecorderStopReason) => void;
  onStreamChanged?: (stream: MediaStream) => void;
}

type RecorderState = "idle" | "starting" | "recording" | "stopping";

type DesktopCapturerSource = {
  id: string;
  name: string;
};

type ElectronDesktopCapturerLike = {
  getSources: (options: { types: Array<"window" | "screen"> }) => Promise<DesktopCapturerSource[]>;
};

type ElectronLike = {
  desktopCapturer?: ElectronDesktopCapturerLike;
};

/**
 * Desktop display recorder with strict source validation:
 * capture must be an Obsidian application window.
 */
export class ObsidianWindowRecorder {
  private readonly app: App;
  private readonly mimeType: string;
  private readonly extension: string;
  private readonly captureAudio: VideoAudioCaptureConfig;
  private readonly onError: (error: Error) => void;
  private readonly onStatus: (status: string) => void;
  private readonly onComplete: (filePath: string, videoBlob: Blob, stopReason?: VideoRecorderStopReason) => void;
  private readonly onStreamChanged: ((stream: MediaStream) => void) | null;

  private state: RecorderState = "idle";
  private mediaRecorder: MediaRecorder | null = null;
  private screenStream: MediaStream | null = null;
  private displayStream: MediaStream | null = null;
  private microphoneStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private outputPath: string | null = null;
  private stopReason: VideoRecorderStopReason = "manual";
  private trackEndListener: (() => void) | null = null;
  private selectedDesktopSourceName: string | null = null;

  constructor(app: App, options: ObsidianWindowRecorderOptions) {
    this.app = app;
    this.mimeType = options.mimeType;
    this.extension = options.extension;
    this.captureAudio = normalizeVideoAudioCaptureConfig(options.captureAudio);
    this.onError = options.onError;
    this.onStatus = options.onStatus;
    this.onComplete = options.onComplete;
    this.onStreamChanged = options.onStreamChanged ?? null;
  }

  public async start(outputPath: string): Promise<void> {
    if (this.state !== "idle") {
      this.onStatus("Video recorder is busy.");
      return;
    }

    this.state = "starting";
    this.outputPath = outputPath;
    this.chunks = [];
    this.stopReason = "manual";
    this.selectedDesktopSourceName = null;

    try {
      const displayStream = await this.acquireScreenStream();
      this.validateSelectedSource(displayStream);
      this.validateSystemAudioTrackSelection(displayStream);
      const microphoneStream = await this.acquireMicrophoneStream();
      const recordingStream = this.composeRecordingStream(displayStream, microphoneStream);
      this.attachStreamListeners(displayStream);
      this.displayStream = displayStream;
      this.microphoneStream = microphoneStream;
      this.screenStream = recordingStream;
      this.mediaRecorder = this.createMediaRecorder(recordingStream);
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      this.mediaRecorder.onstop = async () => {
        await this.finalizeRecording();
      };
      this.mediaRecorder.start(1000);
      this.state = "recording";
      this.onStatus("Recording Obsidian window...");
      if (this.onStreamChanged) {
        try {
          this.onStreamChanged(recordingStream);
        } catch {}
      }
    } catch (error) {
      this.state = "idle";
      this.release();
      throw this.normalizeStartError(error);
    }
  }

  public stop(reason: VideoRecorderStopReason = "manual"): void {
    if (this.state !== "recording") {
      return;
    }
    this.state = "stopping";
    this.stopReason = reason;
    this.onStatus(reason === "manual" ? "Saving video recording..." : "Video source ended. Saving recording...");

    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try {
          if (typeof this.mediaRecorder.requestData === "function") {
            this.mediaRecorder.requestData();
          }
        } catch {}
        this.mediaRecorder.stop();
      } else {
        void this.finalizeRecording();
      }
    } catch (error) {
      this.onError(new Error(`Video stop failed: ${error instanceof Error ? error.message : String(error)}`));
      this.release();
    }
  }

  public cleanup(): void {
    this.release();
  }

  public getMediaStream(): MediaStream | null {
    return this.screenStream;
  }

  private async acquireScreenStream(): Promise<MediaStream> {
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (mediaDevices?.getDisplayMedia) {
      try {
        this.onStatus(this.captureAudio.includeSystemAudio
          ? "Choose the Obsidian window and enable system audio sharing."
          : "Choose the Obsidian window to record...");
        return await mediaDevices.getDisplayMedia({
          video: true,
          audio: this.captureAudio.includeSystemAudio,
        });
      } catch (error) {
        if (!this.isNotSupported(error)) {
          throw error;
        }
        // Fall through to Electron desktopCapturer fallback for older runtimes.
      }
    }

    const fallbackStream = await this.acquireScreenStreamViaDesktopCapturer();
    if (fallbackStream) {
      return fallbackStream;
    }

    throw new Error("Screen recording is not supported in this Obsidian runtime.");
  }

  private validateSystemAudioTrackSelection(stream: MediaStream): void {
    if (!this.captureAudio.includeSystemAudio) {
      return;
    }

    if (stream.getAudioTracks().length > 0) {
      return;
    }

    throw new Error(
      "System audio capture was enabled, but no system audio track was shared. Re-open the source picker and enable audio sharing."
    );
  }

  private async acquireMicrophoneStream(): Promise<MediaStream | null> {
    if (!this.captureAudio.includeMicrophoneAudio) {
      return null;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is unavailable in this runtime.");
    }

    const preferredId = this.captureAudio.preferredMicrophoneId;
    const wantsSpecificMic = preferredId && preferredId !== "default";
    const baseConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    this.onStatus("Requesting microphone access...");
    if (wantsSpecificMic) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            ...baseConstraints,
            deviceId: { exact: preferredId },
          },
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const canFallback = name === "NotFoundError" || name === "OverconstrainedError";
        if (!canFallback) {
          throw error;
        }
      }
    }

    return await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
  }

  private composeRecordingStream(displayStream: MediaStream, microphoneStream: MediaStream | null): MediaStream {
    const tracks: MediaStreamTrack[] = [
      ...displayStream.getVideoTracks(),
      ...displayStream.getAudioTracks(),
    ];

    if (microphoneStream) {
      tracks.push(...microphoneStream.getAudioTracks());
    }

    return new MediaStream(tracks);
  }

  private validateSelectedSource(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error("No video track found. Please choose the Obsidian window.");
    }

    const settings = (typeof track.getSettings === "function" ? track.getSettings() : {}) as MediaTrackSettings & {
      displaySurface?: string;
    };
    const displaySurface = (settings.displaySurface || "").toLowerCase();
    if (displaySurface && displaySurface !== "window") {
      throw new Error("Choose the Obsidian application window (not a full screen or browser tab).");
    }

    const selectedSourceName = (this.selectedDesktopSourceName || "").trim().toLowerCase();
    if (selectedSourceName.includes("obsidian")) {
      return;
    }

    const sourceLabel = (track.label || "").trim().toLowerCase();
    if (sourceLabel && sourceLabel.includes("obsidian")) {
      return;
    }

    if (!sourceLabel) {
      throw new Error("Unable to verify the capture source. Please pick the Obsidian application window.");
    }

    if (!sourceLabel.includes("obsidian")) {
      throw new Error("Choose the Obsidian application window to start recording.");
    }
  }

  private async acquireScreenStreamViaDesktopCapturer(): Promise<MediaStream | null> {
    const desktopCapturer = this.resolveDesktopCapturer();
    if (!desktopCapturer || !navigator.mediaDevices?.getUserMedia) {
      return null;
    }

    this.onStatus("Loading desktop windows...");
    const sources = await desktopCapturer.getSources({ types: ["window"] });
    const source = sources.find((entry) => (entry.name || "").toLowerCase().includes("obsidian"));
    if (!source) {
      throw new Error("Could not find an Obsidian window to capture.");
    }

    this.selectedDesktopSourceName = source.name || null;

    const legacyConstraints = {
      audio: this.captureAudio.includeSystemAudio,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: source.id,
          maxFrameRate: 30,
        },
      },
    } as unknown as MediaStreamConstraints;

    return await navigator.mediaDevices.getUserMedia(legacyConstraints);
  }

  private resolveDesktopCapturer(): ElectronDesktopCapturerLike | null {
    const candidates = [
      (globalThis as any)?.require,
      (globalThis as any)?.window?.require,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== "function") continue;
      try {
        const electron = candidate("electron") as ElectronLike;
        if (electron?.desktopCapturer?.getSources) {
          return electron.desktopCapturer;
        }
      } catch {
        // ignore and continue
      }
    }

    return null;
  }

  private createMediaRecorder(stream: MediaStream): MediaRecorder {
    try {
      return new MediaRecorder(stream, { mimeType: this.mimeType });
    } catch {
      return new MediaRecorder(stream);
    }
  }

  private attachStreamListeners(displayStream: MediaStream): void {
    const track = displayStream.getVideoTracks()[0];
    if (track) {
      this.trackEndListener = () => {
        this.stop("source-ended");
      };
      track.addEventListener("ended", this.trackEndListener, { once: true });
    }
  }

  private detachStreamListeners(): void {
    if (!this.displayStream || !this.trackEndListener) {
      this.trackEndListener = null;
      return;
    }

    const track = this.displayStream.getVideoTracks()[0];
    if (track) {
      track.removeEventListener("ended", this.trackEndListener);
    }
    this.trackEndListener = null;
  }

  private async finalizeRecording(): Promise<void> {
    const filePath = this.outputPath;
    const blob = new Blob(this.chunks, { type: this.mimeType || "video/webm" });

    if (!filePath) {
      this.onError(new Error("Video recording path was not initialized."));
      this.release();
      return;
    }

    try {
      const buffer = await blob.arrayBuffer();
      await this.app.vault.adapter.writeBinary(filePath, buffer);
      this.onComplete(filePath, blob, this.stopReason);
    } catch (error) {
      this.onError(new Error(`Failed to save video recording: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      this.release();
    }
  }

  private normalizeStartError(error: unknown): Error {
    if (error instanceof Error) {
      if (error.name === "NotAllowedError") {
        if (this.captureAudio.includeMicrophoneAudio) {
          return new Error("Screen or microphone permission was denied.");
        }
        return new Error("Screen recording permission was denied.");
      }
      if (error.name === "NotFoundError") {
        return new Error("No display source selected. Please choose the Obsidian window.");
      }
      if (this.isNotSupported(error)) {
        return new Error("Screen capture is not supported by this Obsidian/Electron runtime.");
      }
      return error;
    }
    return new Error(String(error));
  }

  private isNotSupported(error: unknown): boolean {
    const name = error instanceof Error ? (error.name || "") : "";
    const message = error instanceof Error ? (error.message || "") : String(error || "");
    return name.toLowerCase().includes("notsupported")
      || message.toLowerCase().includes("not supported");
  }

  private release(): void {
    this.detachStreamListeners();
    const streams = [this.screenStream, this.displayStream, this.microphoneStream].filter(
      (stream): stream is MediaStream => !!stream
    );
    const seenTrackIds = new Set<string>();
    for (const stream of streams) {
      try {
        for (const track of stream.getTracks()) {
          if (seenTrackIds.has(track.id)) continue;
          seenTrackIds.add(track.id);
          track.stop();
        }
      } catch {}
    }

    this.screenStream = null;
    this.displayStream = null;
    this.microphoneStream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.outputPath = null;
    this.selectedDesktopSourceName = null;
    this.state = "idle";
  }
}
