import type { App, DataAdapter } from "obsidian";
import { logError } from "../../utils/errorHandling";
import {
  recorderFormatForMimeType,
  type RecorderFormat,
} from "./RecorderFormats";
import type { RecorderHostContext } from "./RecorderHostContext";
import {
  RECORDINGS_IN_PROGRESS_DIRECTORY,
  availableRecordingPath,
  ensureAdapterDirectory,
  inProgressRecordingPath,
  moveRecordingIntoVault,
} from "./RecordingInProgressFiles";

export type RecorderStopReason =
  | "manual"
  | "background-hidden"
  | "background-pagehide"
  | "interrupted"
  | "size-limit";

export interface RecordingResult {
  filePath: string;
  startedAt: number;
  durationMs: number;
  sizeBytes: number;
  stopReason: RecorderStopReason;
}

/** The hidden in-progress file, reported once its first audio is on disk. */
export interface RecordingCaptureFile {
  filePath: string;
  startedAt: number;
  sizeBytes: number;
}

export interface RecordingStartInfo {
  filePath: string;
  startedAt: number;
  microphoneLabel: string;
}

export interface RecordingSessionOptions {
  app: App;
  directoryPath: string;
  ensureDirectory: (path: string) => Promise<void>;
  format: RecorderFormat;
  preferredMicrophoneId?: string | null;
  hostContext: RecorderHostContext;
  onStatus?: (status: string) => void;
  /**
   * Bounds the audio held in memory. Production uses MAX_ENCODED_CAPTURE_BYTES
   * or the mobile bound; tests and hosts may override it.
   */
  maxEncodedBytes?: number;
  /** Test override for the bound on a capture streamed to disk. */
  maxStreamedBytes?: number;
  /**
   * Called once, when a streamed capture first reaches its hidden in-progress
   * file, so the caller can register that file for recovery after a crash.
   */
  onCaptureFileCreated?: (capture: RecordingCaptureFile) => void;
}

type CaptureState =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "finalizing"
  | "save-failed"
  | "finished"
  | "disposed";
type RecorderCaptureWindow = Window & {
  MediaRecorder?: typeof MediaRecorder;
  Blob?: typeof Blob;
};
type RecorderWakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<RecorderWakeLockSentinel> };
};
type RecorderWakeLockSentinel = {
  released?: boolean;
  release?: () => Promise<void>;
  addEventListener?: (
    type: "release",
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
};

const SPEECH_BITRATE = 96_000;
const CHUNK_INTERVAL_MS = 1_000;
export const RECORDER_STOP_WATCHDOG_MS = 2_000;
/** Desktop capture remains bounded even for long meetings. */
export const MAX_ENCODED_CAPTURE_BYTES = 64 * 1024 * 1024;
/**
 * Mobile WebViews must materialize the final Blob once to persist it through
 * Obsidian's portable vault API. Keep the peak comfortably below the desktop
 * bound instead of risking an out-of-memory failure during background save.
 */
export const MOBILE_MAX_ENCODED_CAPTURE_BYTES = 24 * 1024 * 1024;
/**
 * A capture streamed to disk holds only its unflushed tail in memory, so this
 * bound only stops a forgotten recorder: about 12 hours at the speech bitrate.
 */
export const STREAMED_MAX_ENCODED_CAPTURE_BYTES = 512 * 1024 * 1024;
/**
 * Streamed audio is appended at most this often, or sooner once this much is
 * buffered. That bounds the audio a crash can lose and the writes a long
 * recording makes.
 */
const STREAM_FLUSH_INTERVAL_MS = 5_000;
const STREAM_FLUSH_BYTES = 256 * 1024;

type BinaryAppendAdapter = DataAdapter & {
  appendBinary?: (normalizedPath: string, data: ArrayBuffer) => Promise<void>;
};

/**
 * Obsidian 1.12.3 added binary appends. Older hosts keep the in-memory capture
 * and its bounds. Capture streams into a hidden in-progress file through the
 * adapter, because the vault API does not reach dot-folders.
 */
export function canStreamRecordingToDisk(app: App): boolean {
  return typeof (app.vault.adapter as BinaryAppendAdapter).appendBinary === "function";
}

interface PreparedRecordingSave {
  /** Audio not yet on disk, or null once it is. */
  bytes: ArrayBuffer | null;
  result: RecordingResult;
  /**
   * The capture streamed into the hidden in-progress file: write any tail
   * there, then move the file to the result's path.
   */
  streamed: boolean;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
}

function isPermissionError(error: unknown): boolean {
  const value = `${errorName(error)} ${errorMessage(error)}`.toLowerCase();
  return value.includes("notallowed") || value.includes("permission") || value.includes("denied");
}

function isMissingDeviceError(error: unknown): boolean {
  const value = `${errorName(error)} ${errorMessage(error)}`.toLowerCase();
  return value.includes("notfound") || value.includes("overconstrained") || value.includes("not found");
}

function isConstraintError(error: unknown): boolean {
  const value = `${errorName(error)} ${errorMessage(error)}`.toLowerCase();
  return value.includes("overconstrained") || value.includes("constraint") || value.includes("typeerror");
}

function abortError(message = "Recording was cancelled."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Owns one microphone capture from permission request through durable vault
 * persistence. The public promise settles once, so callers never have to
 * coordinate MediaRecorder callbacks, track events, and vault writes.
 */
export class RecordingSession {
  private readonly app: App;
  private readonly options: RecordingSessionOptions;
  private readonly hostDocument: Document;
  private readonly hostWindow: RecorderCaptureWindow;
  private readonly hostNavigator: RecorderWakeLockNavigator;
  private readonly mediaDevices: MediaDevices | null;
  private readonly maxEncodedBytes: number;
  private readonly maxStreamedBytes: number;
  private readonly streamToDisk: boolean;

  private state: CaptureState = "idle";
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  /** Captured audio not yet on disk: all of it unless streaming to disk. */
  private chunks: Blob[] = [];
  private bufferedBytes = 0;
  private encodedBytes = 0;
  private persistedBytes = 0;
  private captureLimitReached = false;
  /** The hidden in-progress file, once its first audio is written. */
  private streamPath: string | null = null;
  /**
   * An append failed, so the file may hold part of that buffer beyond
   * `persistedBytes`, the length known to be good.
   */
  private streamUncertain = false;
  private streamFailed = false;
  private streamWrite: Promise<void> | null = null;
  private lastStreamFlushAt = 0;
  /** The container and path are fixed once audio is headed for disk. */
  private outputLocked = false;
  private outputStem: string | null = null;
  private outputPath: string | null = null;
  private recordingMimeType: string;
  private startedAt = 0;
  private stoppedAt = 0;
  private stopReason: RecorderStopReason = "manual";
  private finalizePromise: Promise<void> | null = null;
  private retrySavePromise: Promise<RecordingResult> | null = null;
  private pendingSave: PreparedRecordingSave | null = null;
  private completionSettled = false;
  private disposeRequested = false;
  private pendingMicrophoneReject: ((error: Error) => void) | null = null;
  private startCancellation: Error | null = null;

  private trackEndedListener: (() => void) | null = null;
  private visibilityListener: (() => void) | null = null;
  private pageHideListener: (() => void) | null = null;
  private wakeLockSentinel: RecorderWakeLockSentinel | null = null;
  private wakeLockRequestPending = false;
  private stopWatchdogId: number | null = null;

  private readonly resolveCompletion: (result: RecordingResult) => void;
  private readonly rejectCompletion: (error: Error) => void;
  public readonly completion: Promise<RecordingResult>;

  constructor(options: RecordingSessionOptions) {
    this.options = options;
    this.app = options.app;
    this.hostDocument = options.hostContext.hostDocument;
    this.hostWindow = options.hostContext.hostWindow;
    this.hostNavigator = options.hostContext.hostWindow.navigator;
    this.mediaDevices = this.hostNavigator.mediaDevices ?? null;
    this.maxEncodedBytes = Number.isFinite(options.maxEncodedBytes)
      && (options.maxEncodedBytes ?? 0) > 0
      ? Math.floor(options.maxEncodedBytes as number)
      : MAX_ENCODED_CAPTURE_BYTES;
    this.maxStreamedBytes = Number.isFinite(options.maxStreamedBytes)
      && (options.maxStreamedBytes ?? 0) > 0
      ? Math.floor(options.maxStreamedBytes as number)
      : STREAMED_MAX_ENCODED_CAPTURE_BYTES;
    this.streamToDisk = canStreamRecordingToDisk(this.app);
    this.recordingMimeType = options.format.mimeType;

    let resolve!: (result: RecordingResult) => void;
    let reject!: (error: Error) => void;
    this.completion = new Promise<RecordingResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.resolveCompletion = resolve;
    this.rejectCompletion = reject;
  }

  public async start(): Promise<RecordingStartInfo> {
    if (this.state !== "idle") {
      throw new Error("This recording session has already been used.");
    }
    this.state = "starting";
    this.attachLifecycleListeners();
    if (this.hostDocument.hidden) {
      this.cancelStartForBackground();
    }

    try {
      this.assertStartActive();
      await this.options.ensureDirectory(this.options.directoryPath);
      this.assertStartActive();
      if (!(await this.app.vault.adapter.exists(this.options.directoryPath))) {
        throw new Error(`Failed to create recordings directory: ${this.options.directoryPath}`);
      }
      this.assertStartActive();

      this.options.onStatus?.("Waiting for microphone access…");
      this.mediaStream = await this.acquireMicrophoneStream();
      this.assertStartActive();
      if (this.hostDocument.hidden) {
        throw abortError("Recording did not start because Obsidian moved to the background.");
      }
      this.attachTrackListener();

      const recorder = this.createMediaRecorder(this.mediaStream);
      this.mediaRecorder = recorder;
      recorder.ondataavailable = (event: BlobEvent) => {
        this.handleDataAvailable(event.data);
      };
      recorder.onstop = () => {
        this.markCaptureStopped();
        void this.finalize();
      };
      recorder.onerror = (event: Event) => {
        if (this.state !== "recording") return;
        logError(
          "RecordingSession",
          "MediaRecorder interrupted capture",
          (event as { error?: unknown }).error ?? event,
        );
        this.requestStop("interrupted");
      };

      recorder.start(CHUNK_INTERVAL_MS);
      this.updateActualFormat(recorder.mimeType);
      if (!this.outputPath) {
        throw new Error("Recording output path was not prepared.");
      }
      this.startedAt = Date.now();
      this.state = "recording";
      void this.acquireWakeLock();

      const microphoneLabel = this.mediaStream.getAudioTracks()[0]?.label || "Default microphone";
      this.options.onStatus?.(`Recording with ${microphoneLabel}`);
      return {
        filePath: this.outputPath,
        startedAt: this.startedAt,
        microphoneLabel,
      };
    } catch (error) {
      const normalized = this.normalizeStartError(error);
      this.releaseResources();
      this.state = "finished";
      this.settleFailure(normalized);
      throw normalized;
    }
  }

  public stop(reason: RecorderStopReason = "manual"): Promise<RecordingResult> {
    this.requestStop(reason);
    return this.completion;
  }

  public isRecording(): boolean {
    return this.state === "recording";
  }

  /** The hidden file this capture streams into, once it exists. */
  public get inProgressPath(): string | null {
    return this.streamPath;
  }

  /** The capture bound in force: disk-backed while streaming, memory otherwise. */
  public get captureLimitBytes(): number {
    return this.isStreaming() ? this.maxStreamedBytes : this.maxEncodedBytes;
  }

  public hasPendingSave(): boolean {
    return this.state === "save-failed" && this.pendingSave !== null;
  }

  public getPendingSaveResult(): RecordingResult | null {
    return this.pendingSave ? { ...this.pendingSave.result } : null;
  }

  public retrySave(): Promise<RecordingResult> {
    if (this.retrySavePromise) return this.retrySavePromise;
    if (!this.pendingSave || this.state !== "save-failed") {
      return Promise.reject(new Error("There is no captured audio waiting to be saved."));
    }

    this.state = "finalizing";
    this.retrySavePromise = this.persistPendingSave(true).finally(() => {
      this.retrySavePromise = null;
      this.finishDeferredDispose();
    });
    return this.retrySavePromise;
  }

  public dispose(): void {
    if (this.state === "disposed" || this.state === "finished") return;
    if (this.state === "stopping" || this.state === "finalizing") {
      this.disposeRequested = true;
      return;
    }
    if (this.state === "recording") {
      this.disposeRequested = true;
      this.requestStop("interrupted");
      return;
    }

    if (this.state === "save-failed") {
      this.pendingSave = null;
      this.chunks = [];
      this.bufferedBytes = 0;
      this.encodedBytes = 0;
      this.releaseResources();
      this.state = "disposed";
      return;
    }

    const cancellation = abortError();
    this.state = "disposed";
    this.pendingMicrophoneReject?.(cancellation);
    this.pendingMicrophoneReject = null;

    const recorder = this.mediaRecorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // The host may already have torn down the recorder realm.
      }
    }

    this.releaseResources();
    this.chunks = [];
    this.bufferedBytes = 0;
    this.settleFailure(cancellation);
  }

  private requestStop(reason: RecorderStopReason): void {
    if (this.state === "stopping" || this.state === "finished" || this.state === "disposed") return;
    if (this.state !== "recording") return;

    this.state = "stopping";
    this.stopReason = reason;
    this.markCaptureStopped();
    this.options.onStatus?.(
      reason === "manual"
        ? "Saving recording…"
        : reason === "size-limit"
          ? `Recording reached the ${this.captureLimitLabel()} safety limit. Saving captured audio…`
        : reason === "interrupted"
          ? "Microphone interrupted. Saving captured audio…"
          : "App moved to the background. Saving captured audio…",
    );

    const recorder = this.mediaRecorder;
    try {
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.requestData?.();
        } catch {
          // Some WebViews reject requestData immediately before stop.
        }
        this.armStopWatchdog();
        recorder.stop();
      } else {
        void this.finalize();
      }
    } catch (error) {
      logError("RecordingSession", "MediaRecorder stop failed; saving captured chunks", error);
      void this.finalize();
    }
  }

  private async finalize(): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise;
    this.clearStopWatchdog();
    this.markCaptureStopped();
    this.state = "finalizing";
    this.finalizePromise = this.finalizeOnce();
    return this.finalizePromise;
  }

  private async finalizeOnce(): Promise<void> {
    try {
      if (!this.outputPath) throw new Error("Recording output path was not prepared.");
      await this.drainStreamWrites();
      const streamed = this.streamPath !== null;
      if (!streamed && this.chunks.length === 0) throw new Error("No audio was captured.");

      // Streaming leaves only a tail here, if an append failed, and then moves
      // the in-progress file into place. Otherwise this is the whole
      // recording, materialized once.
      const bytes = this.chunks.length > 0 ? await this.encodeChunks(this.chunks) : null;
      const result: RecordingResult = {
        filePath: this.outputPath,
        startedAt: this.startedAt,
        durationMs: Math.max(0, this.stoppedAt - this.startedAt),
        sizeBytes: this.persistedBytes + (bytes?.byteLength ?? 0),
        stopReason: this.stopReason,
      };

      this.chunks = [];
      this.bufferedBytes = 0;
      this.encodedBytes = 0;
      if (bytes || streamed) {
        this.pendingSave = { bytes, result, streamed };
        await this.persistPendingSave();
      }
      this.settleSuccess(result);
    } catch (error) {
      this.settleFailure(
        error instanceof Error
          ? error
          : new Error(`Could not save recording: ${errorMessage(error)}`),
      );
    } finally {
      this.chunks = [];
      this.bufferedBytes = 0;
      this.encodedBytes = 0;
      this.releaseResources();
      this.finishDeferredDispose();
      if (this.state === "finalizing") this.state = "finished";
    }
  }

  private finishDeferredDispose(): void {
    if (!this.disposeRequested || this.state !== "save-failed") return;
    this.pendingSave = null;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.encodedBytes = 0;
    this.state = "disposed";
  }

  private isStreaming(): boolean {
    return this.streamToDisk && !this.streamFailed;
  }

  private async encodeChunks(chunks: readonly Blob[]): Promise<ArrayBuffer> {
    const BlobConstructor = this.hostWindow.Blob ?? Blob;
    return new BlobConstructor([...chunks], { type: this.recordingMimeType }).arrayBuffer();
  }

  /**
   * Start one append of everything buffered, unless one is already running.
   * The first write creates the hidden in-progress file as soon as audio
   * arrives; later writes wait for the flush interval so a long recording
   * stays cheap.
   */
  private flushToDisk(force: boolean): void {
    if (!this.isStreaming() || this.streamWrite || this.chunks.length === 0 || !this.outputPath) return;
    if (
      !force
      && this.streamPath
      && this.bufferedBytes < STREAM_FLUSH_BYTES
      && Date.now() - this.lastStreamFlushAt < STREAM_FLUSH_INTERVAL_MS
    ) return;

    this.outputLocked = true;
    const path = inProgressRecordingPath(this.outputPath);
    const chunks = this.chunks;
    const count = chunks.length;
    this.streamWrite = this.writeStreamBatch(path, chunks.slice(0, count))
      .then((written) => {
        // Chunks stay buffered until they are on disk, so a failed append
        // keeps them in order for the in-memory fallback.
        if (this.chunks === chunks) chunks.splice(0, count);
        this.bufferedBytes = Math.max(0, this.bufferedBytes - written);
      })
      .catch((error: unknown) => {
        this.streamFailed = true;
        logError("RecordingSession", "Streaming capture to disk failed; keeping the rest in memory", error);
      })
      .finally(() => {
        this.streamWrite = null;
        this.lastStreamFlushAt = Date.now();
      });
  }

  private async writeStreamBatch(path: string, batch: readonly Blob[]): Promise<number> {
    const bytes = await this.encodeChunks(batch);
    if (this.streamPath) {
      await this.appendToStream(bytes);
      return bytes.byteLength;
    }
    const adapter = this.app.vault.adapter;
    await ensureAdapterDirectory(adapter, RECORDINGS_IN_PROGRESS_DIRECTORY);
    try {
      await adapter.writeBinary(path, bytes);
    } catch (error) {
      // The capture falls back to memory; a fragment must not be recovered later.
      await adapter.remove(path).catch(() => undefined);
      throw error;
    }
    this.streamPath = path;
    this.persistedBytes = bytes.byteLength;
    try {
      this.options.onCaptureFileCreated?.({
        filePath: path,
        startedAt: this.startedAt,
        sizeBytes: bytes.byteLength,
      });
    } catch (error) {
      logError("RecordingSession", "Could not register the partial recording", error);
    }
    return bytes.byteLength;
  }

  /**
   * Append `bytes` after the audio known to be on disk. After a failed append
   * the file may already hold a prefix of these bytes, so its size decides
   * where to resume and no audio is written twice.
   */
  private async appendToStream(bytes: ArrayBuffer): Promise<void> {
    const adapter = this.app.vault.adapter as BinaryAppendAdapter;
    if (!this.streamPath || typeof adapter.appendBinary !== "function") {
      throw new Error("The recording file is no longer available for appending.");
    }
    let written = 0;
    if (this.streamUncertain) {
      const stat = typeof adapter.stat === "function" ? await adapter.stat(this.streamPath) : null;
      const onDisk = stat ? stat.size : this.persistedBytes;
      if (onDisk < this.persistedBytes || onDisk > this.persistedBytes + bytes.byteLength) {
        throw new Error("The in-progress recording changed unexpectedly, so nothing more was appended.");
      }
      written = onDisk - this.persistedBytes;
    }
    if (written < bytes.byteLength) {
      this.streamUncertain = true;
      await adapter.appendBinary(this.streamPath, written > 0 ? bytes.slice(written) : bytes);
    }
    this.streamUncertain = false;
    this.persistedBytes += bytes.byteLength;
  }

  /** Wait for in-flight appends, then write whatever is still buffered. */
  private async drainStreamWrites(): Promise<void> {
    await this.settleStreamWrite();
    if (this.isStreaming() && this.chunks.length > 0) {
      this.flushToDisk(true);
      await this.settleStreamWrite();
    }
  }

  private async settleStreamWrite(): Promise<void> {
    while (this.streamWrite) await this.streamWrite;
  }

  private async persistPendingSave(resolveCollision = false): Promise<RecordingResult> {
    const pending = this.pendingSave;
    if (!pending) throw new Error("There is no captured audio waiting to be saved.");

    try {
      if (pending.streamed) {
        if (pending.bytes) {
          await this.appendToStream(pending.bytes);
          pending.bytes = null;
        }
        pending.result.filePath = await moveRecordingIntoVault(
          this.app,
          this.streamPath as string,
          pending.result.filePath,
          this.hostWindow,
        );
      } else {
        if (resolveCollision) {
          pending.result.filePath = await availableRecordingPath(
            this.app.vault.adapter,
            pending.result.filePath,
          );
        }
        await this.app.vault.createBinary(pending.result.filePath, pending.bytes as ArrayBuffer);
      }
      this.outputPath = pending.result.filePath;
      this.pendingSave = null;
      this.state = "finished";
      return pending.result;
    } catch (error) {
      this.state = "save-failed";
      const detail = errorMessage(error).trim();
      if (pending.streamed && !pending.bytes) {
        throw new Error(
          `The recording is saved in ${RECORDINGS_IN_PROGRESS_DIRECTORY}, but it could not be moved to your recordings folder${detail ? `: ${detail}` : "."}`,
        );
      }
      throw new Error(
        detail
          ? `Audio is still in memory, but it could not be saved: ${detail}`
          : "Audio is still in memory, but it could not be saved.",
      );
    }
  }

  private async acquireMicrophoneStream(): Promise<MediaStream> {
    if (!this.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is unavailable in this Obsidian window.");
    }

    const preferredId = this.options.preferredMicrophoneId?.trim();
    const baseConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    if (preferredId && preferredId !== "default") {
      try {
        return await this.getUserMediaCancellable({
          audio: { ...baseConstraints, deviceId: { exact: preferredId } },
        });
      } catch (error) {
        if (isPermissionError(error)) throw error;
        if (!isMissingDeviceError(error) && !isConstraintError(error)) throw error;
        this.options.onStatus?.("Saved microphone unavailable. Trying the default microphone…");
      }
    }

    try {
      return await this.getUserMediaCancellable({ audio: baseConstraints });
    } catch (error) {
      if (isPermissionError(error) || !isConstraintError(error)) throw error;
      this.options.onStatus?.("Trying basic microphone settings…");
      return this.getUserMediaCancellable({ audio: true });
    }
  }

  private async getUserMediaCancellable(constraints: MediaStreamConstraints): Promise<MediaStream> {
    const mediaDevices = this.mediaDevices;
    if (!mediaDevices) throw new Error("Microphone capture is unavailable.");

    let rejectCancellation!: (error: Error) => void;
    const pending = Promise.resolve().then(() => mediaDevices.getUserMedia(constraints));
    const guarded = pending.then((stream) => {
      if (this.startCancellation || this.state !== "starting") {
        this.stopStream(stream);
        throw this.startCancellation
          ?? abortError("Microphone access completed after recording was cancelled.");
      }
      return stream;
    });
    const cancellation = new Promise<MediaStream>((_, reject) => {
      rejectCancellation = reject;
    });
    this.pendingMicrophoneReject = rejectCancellation;

    try {
      return await Promise.race([guarded, cancellation]);
    } finally {
      if (this.pendingMicrophoneReject === rejectCancellation) {
        this.pendingMicrophoneReject = null;
      }
    }
  }

  private createMediaRecorder(stream: MediaStream): MediaRecorder {
    const RecorderConstructor = this.hostWindow.MediaRecorder;
    if (!RecorderConstructor) {
      throw new Error("Audio recording is unavailable in this Obsidian window.");
    }

    const options: MediaRecorderOptions = {
      mimeType: this.options.format.mimeType,
      audioBitsPerSecond: SPEECH_BITRATE,
    };
    try {
      return new RecorderConstructor(stream, options);
    } catch {
      try {
        return new RecorderConstructor(stream, { mimeType: this.options.format.mimeType });
      } catch {
        return new RecorderConstructor(stream);
      }
    }
  }

  private handleDataAvailable(data: Blob | null | undefined): void {
    if (this.state !== "recording" && this.state !== "stopping") return;
    if (!data || data.size <= 0) return;
    if (!this.outputLocked) this.updateActualFormat(data.type);
    if (this.captureLimitReached) return;

    if (data.size > this.remainingCaptureBytes()) {
      this.captureLimitReached = true;
      if (this.state === "stopping" && this.stopReason === "manual") {
        this.stopReason = "size-limit";
      }
      if (this.state === "recording") this.requestStop("size-limit");
      return;
    }

    this.chunks.push(data);
    this.bufferedBytes += data.size;
    this.encodedBytes += data.size;
    if (this.remainingCaptureBytes() <= 0) {
      this.captureLimitReached = true;
      if (this.state === "recording") this.requestStop("size-limit");
    }
    this.flushToDisk(false);
  }

  /**
   * Memory holds the buffered audio. Streaming adds a disk bound on the whole
   * capture; without it the memory bound covers the whole capture.
   */
  private remainingCaptureBytes(): number {
    const memory = this.maxEncodedBytes - this.bufferedBytes;
    return this.isStreaming()
      ? Math.min(memory, this.maxStreamedBytes - this.encodedBytes)
      : memory;
  }

  private markCaptureStopped(): void {
    if (this.stoppedAt > 0) return;
    this.stoppedAt = Math.max(this.startedAt, Date.now());
  }

  private armStopWatchdog(): void {
    if (this.stopWatchdogId !== null) return;
    this.stopWatchdogId = this.hostWindow.setTimeout(() => {
      this.stopWatchdogId = null;
      void this.finalize();
    }, RECORDER_STOP_WATCHDOG_MS);
  }

  private clearStopWatchdog(): void {
    if (this.stopWatchdogId === null) return;
    this.hostWindow.clearTimeout(this.stopWatchdogId);
    this.stopWatchdogId = null;
  }

  private captureLimitLabel(): string {
    const limit = this.captureLimitBytes;
    const mebibytes = limit / (1024 * 1024);
    if (Number.isInteger(mebibytes)) return `${mebibytes} MiB`;
    return `${limit} bytes`;
  }

  private attachTrackListener(): void {
    const track = this.mediaStream?.getAudioTracks()[0];
    if (!track) return;
    this.trackEndedListener = () => {
      this.requestStop(this.hostDocument.hidden ? "background-hidden" : "interrupted");
    };
    track.addEventListener("ended", this.trackEndedListener, { once: true });
  }

  private attachLifecycleListeners(): void {
    if (this.visibilityListener || this.pageHideListener) return;
    this.visibilityListener = () => {
      if (this.hostDocument.hidden) {
        if (this.state === "starting") this.cancelStartForBackground();
        else this.requestStop("background-hidden");
      } else if (this.state === "recording") {
        void this.acquireWakeLock();
      }
    };
    this.pageHideListener = () => {
      if (this.state === "starting") this.cancelStartForBackground();
      else this.requestStop("background-pagehide");
    };
    this.hostDocument.addEventListener("visibilitychange", this.visibilityListener);
    this.hostWindow.addEventListener("pagehide", this.pageHideListener);
  }

  private detachListeners(): void {
    const track = this.mediaStream?.getAudioTracks()[0];
    if (track && this.trackEndedListener) {
      track.removeEventListener("ended", this.trackEndedListener);
    }
    this.trackEndedListener = null;

    if (this.visibilityListener) {
      this.hostDocument.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }
    if (this.pageHideListener) {
      this.hostWindow.removeEventListener("pagehide", this.pageHideListener);
      this.pageHideListener = null;
    }
  }

  private async acquireWakeLock(): Promise<void> {
    if (this.wakeLockSentinel?.released) this.wakeLockSentinel = null;
    if (
      this.state !== "recording"
      || this.hostDocument.hidden
      || this.wakeLockSentinel
      || this.wakeLockRequestPending
    ) return;
    const wakeLock = this.hostNavigator.wakeLock;
    if (!wakeLock?.request) return;
    this.wakeLockRequestPending = true;
    try {
      const sentinel = await wakeLock.request("screen");
      if (this.state !== "recording" || this.hostDocument.hidden) {
        await sentinel.release?.();
        return;
      }
      this.wakeLockSentinel = sentinel;
      sentinel.addEventListener?.("release", () => {
        if (this.wakeLockSentinel === sentinel) this.wakeLockSentinel = null;
      }, { once: true });
    } catch {
      // Wake locks are an optimization. Background lifecycle handling remains authoritative.
    } finally {
      this.wakeLockRequestPending = false;
    }
  }

  private releaseResources(): void {
    this.clearStopWatchdog();
    this.detachListeners();
    this.stopStream(this.mediaStream);
    this.mediaStream = null;
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.onerror = null;
    }
    this.mediaRecorder = null;

    const sentinel = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    if (sentinel?.release) {
      void Promise.resolve(sentinel.release()).catch(() => undefined);
    }
  }

  private stopStream(stream: MediaStream | null): void {
    if (!stream) return;
    try {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A browser can report a track that has already ended.
        }
      }
    } catch {
      // A malformed host stream is treated as already released.
    }
  }

  private settleSuccess(result: RecordingResult): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    this.resolveCompletion(result);
  }

  private settleFailure(error: Error): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    this.rejectCompletion(error);
  }

  private buildOutputPath(extension: string): string {
    if (!this.outputStem) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.outputStem = `${this.options.directoryPath}/${timestamp}`;
    }
    return `${this.outputStem}.${extension}`;
  }

  private updateActualFormat(mimeType: string | null | undefined): void {
    if (!mimeType?.trim()) {
      if (!this.outputPath) {
        this.outputPath = this.buildOutputPath(this.options.format.extension);
      }
      return;
    }

    const currentFormat = recorderFormatForMimeType(
      this.recordingMimeType,
      this.options.format,
    );
    const format = recorderFormatForMimeType(mimeType, currentFormat);
    this.recordingMimeType = format.mimeType;
    this.outputPath = this.buildOutputPath(format.extension);
  }

  private assertStartActive(): void {
    if (this.startCancellation) throw this.startCancellation;
    if (this.state !== "starting") throw abortError();
  }

  private cancelStartForBackground(): void {
    if (this.startCancellation) return;
    this.startCancellation = abortError(
      "Recording did not start because Obsidian moved to the background.",
    );
    this.pendingMicrophoneReject?.(this.startCancellation);
  }

  private normalizeStartError(error: unknown): Error {
    if (error instanceof Error && error.name === "AbortError") return error;
    const value = `${errorName(error)} ${errorMessage(error)}`.trim();
    if (isPermissionError(error)) {
      return new Error("Microphone access is blocked. Allow it in Obsidian or system settings, then try again.");
    }
    if (isMissingDeviceError(error)) {
      return new Error("No microphone is available. Connect one or choose the default microphone in settings.");
    }
    return new Error(value || "Recording could not start.");
  }
}
