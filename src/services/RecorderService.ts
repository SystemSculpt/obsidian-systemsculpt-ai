import { App } from "obsidian";
import type SystemSculptPlugin from "../main";
import { PlatformContext } from "./PlatformContext";
import { RecorderUIManager } from "./recorder/RecorderUIManager";
import { pickRecorderFormat } from "./recorder/RecorderFormats";
import { RecordingSession, RecordingResult } from "./recorder/RecordingSession";
import { TranscriptionCoordinator } from "./transcription/TranscriptionCoordinator";
import { logDebug, logInfo, logWarning, logError } from "../utils/errorHandling";

interface RecorderOptions {
  onTranscriptionComplete?: (text: string) => void;
}

type RecorderLifecycleState = "idle" | "starting" | "recording" | "stopping";

/**
 * Public facade that orchestrates audio recording + transcription automation.
 */
export class RecorderService {
  private static instance: RecorderService | null = null;

  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly platform: PlatformContext;
  private readonly ui: RecorderUIManager;
  private readonly transcriptionCoordinator: TranscriptionCoordinator;

  private session: RecordingSession | null = null;
  private isRecording = false;
  private lifecycleState: RecorderLifecycleState = "idle";
  private onTranscriptionDone: ((text: string) => void) | null = null;

  private lastRecordingPath: string | null = null;
  private offlineRecordings: Map<string, Blob> = new Map();
  private listeners: Set<(recording: boolean) => void> = new Set();
  private sessionCompletionPromise: Promise<void> | null = null;
  private sessionCompletionResolver: (() => void) | null = null;
  private toggleQueue: Promise<void> = Promise.resolve();
  private stopRequestedDuringStart = false;

  private constructor(app: App, plugin: SystemSculptPlugin, options: RecorderOptions) {
    this.app = app;
    this.plugin = plugin;
    this.platform = PlatformContext.get();
    this.ui = new RecorderUIManager({ app, plugin, platform: this.platform });
    this.transcriptionCoordinator = new TranscriptionCoordinator(app, plugin, this.platform);

    this.onTranscriptionDone = options.onTranscriptionComplete ?? null;
  }

  public static getInstance(
    app?: App,
    plugin?: SystemSculptPlugin,
    options: RecorderOptions = {}
  ): RecorderService {
    if (!RecorderService.instance) {
      if (!app || !plugin) {
        throw new Error("RecorderService has not been initialized");
      }
      RecorderService.instance = new RecorderService(app, plugin, options);
    } else if (options) {
      RecorderService.instance.onTranscriptionDone =
        options.onTranscriptionComplete ?? RecorderService.instance.onTranscriptionDone;
    }

    return RecorderService.instance;
  }

  public onToggle(callback: (recording: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  public unload(): void {
    if (this.isRecording) {
      void this.stopRecording();
    }
    this.cleanup(true);
    this.listeners.clear();
  }

  public toggleRecording(): Promise<void> {
    this.debug("toggleRecording invoked");
    const next = this.toggleQueue.then(() => this.performToggle());
    this.toggleQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async performToggle(): Promise<void> {
    this.debug("performToggle running", { currentlyRecording: this.isRecording });
    if (this.isRecording) {
      await this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    this.debug("startRecording requested");
    if (this.isRecording || this.lifecycleState === "starting") {
      this.debug("startRecording aborted due to active state");
      return;
    }

    this.stopRequestedDuringStart = false;
    await this.waitForSessionLifecycle();
    this.lifecycleState = "starting";
    this.debug("startRecording transitioning to starting state");

    try {
      const directoryPath = this.plugin.settings.recordingsDirectory || "SystemSculpt/Recordings";
      const format = pickRecorderFormat();
      const directoryManager = this.plugin.directoryManager;
      if (!directoryManager) {
        throw new Error("Recorder directories are not initialized yet. Please wait and try again.");
      }

      this.debug("opening recorder UI", { directoryPath, format: format.extension });
      this.ui.open(() => {
        this.requestStop();
      });
      this.ui.setStatus("Preparing recorder...");

      this.beginSessionLifecycle();

      const session = new RecordingSession({
        app: this.app,
        directoryPath,
        ensureDirectory: async (path) => {
          await directoryManager.ensureDirectoryByPath(path);
        },
        format,
        preferredMicrophoneId: this.plugin.settings.preferredMicrophoneId,
        onStatus: (status) => this.updateStatus(status),
        onError: (error) => this.handleError(error),
        onStreamChanged: (stream) => this.handleStreamChanged(stream),
        onComplete: (result) => {
          void this.handleRecordingComplete(result);
        }
      });

      this.session = session;
      this.debug("recording session created", {
        directoryPath,
        format: format.extension
      });

      await session.start();
      if (this.stopRequestedDuringStart) {
        this.debug("stop requested during start; stopping immediately");
        this.stopRequestedDuringStart = false;
        this.isRecording = true;
        this.lifecycleState = "recording";
        await this.stopRecording();
        return;
      }
      this.info("Recording started", {
        preferredMicrophone: this.plugin.settings.preferredMicrophoneId ?? null
      });
      this.isRecording = true;
      this.lifecycleState = "recording";
      this.ui.setRecordingState(true);
      this.ui.startTimer();
      this.notifyListeners();

      const mediaStream = this.session?.getMediaStream?.();
      if (mediaStream) {
        this.debug("attaching visualizer stream");
        void this.ui.attachStream(mediaStream);
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.session?.dispose();
      this.session = null;
      this.lifecycleState = "idle";
      this.stopRequestedDuringStart = false;
      this.resolveSessionLifecycle();
      this.error("startRecording failed", normalized);
      this.handleError(normalized);
    }
  }

  private requestStop(): void {
    this.debug("requestStop invoked");
    if (!this.isRecording && this.lifecycleState === "starting") {
      this.stopRequestedDuringStart = true;
      this.lifecycleState = "stopping";
      this.updateStatus("Stopping recording...");
      this.ui.setRecordingState(false);
      this.ui.stopTimer();
      this.notifyListeners();
      return;
    }

    void this.stopRecording();
  }

  private async stopRecording(): Promise<void> {
    this.debug("stopRecording requested");
    if (!this.session || !this.isRecording) {
      this.debug("stopRecording aborted - nothing active");
      return;
    }

    try {
      this.lifecycleState = "stopping";
      this.debug("stopRecording transitioning to stopping state");
      this.updateStatus("Stopping recording...");
      this.session.stop();
      this.isRecording = false;
      this.ui.setRecordingState(false);
      this.ui.stopTimer();
      this.notifyListeners();
      await this.waitForSessionLifecycle();
      this.info("Recording stopped");
    } catch (error) {
      this.lifecycleState = "idle";
      this.resolveSessionLifecycle();
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.error("stopRecording failed", normalized);
      this.handleError(normalized);
      this.cleanup(true);
    }
  }

  private async handleRecordingComplete(result: RecordingResult): Promise<void> {
    this.info("Recording session completed", {
      filePath: result.filePath,
      durationMs: result.durationMs
    });
    this.lastRecordingPath = result.filePath;
    this.session = null;
    this.lifecycleState = "idle";
    this.resolveSessionLifecycle();
    this.storeRecordingInMemory(result);

    const fileName = result.filePath.split("/").pop();
    const autoTranscribe = this.plugin.settings.autoTranscribeRecordings;
    if (autoTranscribe) {
      this.ui.setStatus("Saved. Transcribing…");
      await this.transcribeRecording(result.filePath);
    } else {
      const savedMessage = fileName ? `Saved to ${fileName}` : "Recording saved.";
      this.ui.linger(savedMessage, 2400);
    }
  }

  private async transcribeRecording(filePath: string): Promise<void> {
    this.debug("starting transcription for recording", { filePath });
    try {
      await this.transcriptionCoordinator.start({
        filePath,
        onStatus: (status) => this.updateStatus(status),
        onTranscriptionComplete: (text: string) => this.handleTranscriptionComplete(text),
        suppressNotices: true,
        useModal: false
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.updateStatus(`Transcription failed: ${normalized.message}`);
      this.ui.linger("Transcription failed", 3200);
    }
  }

  private handleTranscriptionComplete(text: string): void {
    try {
      this.info("transcription complete callback received", { receivedChars: text.length });
      if (this.onTranscriptionDone) {
        this.onTranscriptionDone(text);
        this.ui.closeAfter(800);
      } else {
        const postProcessingEnabled = this.plugin.settings.postProcessingEnabled;
        const finishMessage = postProcessingEnabled
          ? "Transcription ready. Post-processing complete."
          : "Transcription ready.";
        this.ui.linger(finishMessage, 2600);
      }
    } catch (error) {
      this.updateStatus(`Failed to process transcription: ${error instanceof Error ? error.message : String(error)}`);
      this.ui.linger("Transcription failed", 3000);
    }
  }

  private handleStreamChanged(stream: MediaStream): void {
    this.debug("microphone stream updated", { hasStream: !!stream });
    void this.ui.attachStream(stream);
  }

  private updateStatus(status: string): void {
    this.ui.setStatus(status);
  }

  private storeRecordingInMemory(result: RecordingResult): void {
    try {
      this.offlineRecordings.set(result.filePath, result.blob);
      this.debug("offline recording cached", { inMemoryCount: this.offlineRecordings.size });
    } catch (_) {
      // noop - storing in-memory backups is a best-effort operation
    }
  }

  private handleError(error: Error): void {
    this.error("Recorder failure encountered", error);
    const isMobile = this.platform.isMobile();
    const hasBackup = this.lastRecordingPath && this.offlineRecordings.has(this.lastRecordingPath);

    const errorMessage = hasBackup
      ? isMobile
        ? "Recording saved, but processing failed. Your audio is safe."
        : `Recording saved to ${this.lastRecordingPath?.split("/").pop()}, but processing failed`
      : `Recording error: ${error.message}`;

    this.updateStatus(errorMessage);
    this.ui.linger(errorMessage, hasBackup ? 3200 : 2600);

    this.lifecycleState = "idle";
    this.session = null;
    this.resolveSessionLifecycle();

    setTimeout(() => {
      this.cleanup(true);
    }, hasBackup ? 3000 : 2000);
  }

  private notifyListeners(): void {
    this.debug("notifyListeners firing", { listenerCount: this.listeners.size, recording: this.isRecording });
    for (const listener of this.listeners) {
      try {
        listener(this.isRecording);
      } catch (_) {
        // ignore listener errors
      }
    }
  }

  private cleanup(hideUI: boolean = false): void {
    this.debug("cleanup invoked", { hideUI });
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }

    this.isRecording = false;
    this.lifecycleState = "idle";
    this.stopRequestedDuringStart = false;
    this.ui.stopTimer();
    this.ui.detachStream();
    this.resolveSessionLifecycle();

    if (hideUI) {
      this.ui.close();
    }

    this.notifyListeners();
  }

  private getStateSnapshot(): Record<string, unknown> {
    return {
      lifecycleState: this.lifecycleState,
      isRecording: this.isRecording,
      hasSession: this.session !== null,
      sessionActive: this.session?.isActive() ?? false,
      uiVisible: this.ui.isVisible(),
      listeners: this.listeners.size,
      pendingLifecyclePromise: this.sessionCompletionPromise !== null
    };
  }

  private debug(message: string, data: Record<string, unknown> = {}): void {
    logDebug("RecorderService", message, { ...this.getStateSnapshot(), ...data });
  }

  private info(message: string, data: Record<string, unknown> = {}): void {
    logInfo("RecorderService", message, { ...this.getStateSnapshot(), ...data });
  }

  private warn(message: string, data: Record<string, unknown> = {}): void {
    logWarning("RecorderService", message, { ...this.getStateSnapshot(), ...data });
  }

  private error(message: string, error: Error): void {
    logError("RecorderService", message, error);
  }

  private beginSessionLifecycle(): void {
    if (this.sessionCompletionPromise) {
      this.debug("beginSessionLifecycle skipped - promise already active");
      return;
    }
    this.debug("beginSessionLifecycle started");
    this.sessionCompletionPromise = new Promise<void>((resolve) => {
      this.sessionCompletionResolver = () => {
        resolve();
        this.sessionCompletionPromise = null;
        this.sessionCompletionResolver = null;
      };
    });
  }

  private resolveSessionLifecycle(): void {
    if (this.sessionCompletionResolver) {
      this.debug("resolveSessionLifecycle resolving");
      this.sessionCompletionResolver();
      this.sessionCompletionResolver = null;
      this.sessionCompletionPromise = null;
    } else {
      this.debug("resolveSessionLifecycle noop - nothing pending");
    }
  }

  private async waitForSessionLifecycle(): Promise<void> {
    if (this.sessionCompletionPromise) {
      this.debug("waitForSessionLifecycle awaiting pending promise");
      try {
        await this.sessionCompletionPromise;
      } catch (_) {
        // no-op: lifecycle promise is best-effort
      }
    }
  }
}
