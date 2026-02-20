import { App, Notice, Platform } from "obsidian";
import type SystemSculptPlugin from "../main";
import { LicenseChecker } from "../core/license/LicenseChecker";
import { pickVideoRecorderFormat, type VideoRecorderFormat } from "./video/VideoRecorderFormats";
import { VideoRecordingSession, type VideoRecordingResult } from "./video/VideoRecordingSession";
import { hasMacWindowShellRecordingSupport } from "./video/MacShellVideoSupport";
import { isRecorderCanceledError } from "./video/MacWindowShellRecorder";
import { openVideoRecordingPermissionModal } from "../modals/VideoRecordingPermissionModal";
import { RecorderUIManager } from "./recorder/RecorderUIManager";
import { normalizeVideoAudioCaptureConfig } from "./video/VideoAudioCaptureConfig";
import { logDebug, logInfo, logWarning, logError } from "../utils/errorHandling";

type VideoRecorderLifecycleState = "idle" | "starting" | "recording" | "stopping";

/**
 * Public facade that orchestrates Obsidian-window video recording.
 */
export class VideoRecorderService {
  private static instance: VideoRecorderService | null = null;

  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly ui: RecorderUIManager;

  private session: VideoRecordingSession | null = null;
  private isRecording = false;
  private lifecycleState: VideoRecorderLifecycleState = "idle";
  private listeners: Set<(recording: boolean) => void> = new Set();
  private sessionCompletionPromise: Promise<void> | null = null;
  private sessionCompletionResolver: (() => void) | null = null;
  private toggleQueue: Promise<void> = Promise.resolve();
  private stopRequestedDuringStart = false;
  private runtimeUnsupported = false;

  private constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.ui = new RecorderUIManager({ app, plugin, recorderType: "video" });
  }

  public static getInstance(app?: App, plugin?: SystemSculptPlugin): VideoRecorderService {
    if (!VideoRecorderService.instance) {
      if (!app || !plugin) {
        throw new Error("VideoRecorderService has not been initialized");
      }
      VideoRecorderService.instance = new VideoRecorderService(app, plugin);
    }
    return VideoRecorderService.instance;
  }

  public onToggle(callback: (recording: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  public isRuntimeSupported(): boolean {
    return !this.runtimeUnsupported;
  }

  public isRecordingActive(): boolean {
    return this.isRecording;
  }

  public unload(): void {
    if (this.isRecording) {
      void this.stopRecording();
    }
    this.cleanup();
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
    this.debug("performToggle running", {
      currentlyRecording: this.isRecording,
      lifecycleState: this.lifecycleState,
    });

    if (!this.isRecording && this.lifecycleState === "starting") {
      this.stopRequestedDuringStart = true;
      return;
    }

    if (this.isRecording) {
      await this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    this.debug("startRecording requested");
    if (this.isRecording || this.lifecycleState === "starting") {
      return;
    }

    await this.assertRecordingAvailable();
    const shouldContinue = await this.confirmCapturePermissionsIfNeeded();
    if (!shouldContinue) {
      return;
    }

    this.stopRequestedDuringStart = false;
    await this.waitForSessionLifecycle();
    this.lifecycleState = "starting";
    this.ui.open(() => {
      void this.toggleRecording();
    });
    this.ui.setStatus("Preparing video recorder...");
    this.ui.setRecordingState(false);

    try {
      const directoryPath = this.plugin.settings.videoRecordingsDirectory || "SystemSculpt/Video Recordings";
      const preferredFormat = pickVideoRecorderFormat();
      const captureAudio = normalizeVideoAudioCaptureConfig({
        includeSystemAudio: this.plugin.settings.videoCaptureSystemAudio,
        includeMicrophoneAudio: this.plugin.settings.videoCaptureMicrophoneAudio,
        preferredMicrophoneId: this.plugin.settings.preferredMicrophoneId || "default",
      });
      const directoryManager = this.plugin.directoryManager;
      if (!directoryManager) {
        throw new Error("Directory manager is not initialized yet. Please try again.");
      }

      this.beginSessionLifecycle();

      const fallbackWebmFormat: VideoRecorderFormat = {
        mimeType: "video/webm",
        extension: "webm",
      };
      const formatsToTry =
        preferredFormat.extension === "webm"
          ? [preferredFormat]
          : [preferredFormat, fallbackWebmFormat];

      let startedFormat: VideoRecorderFormat | null = null;
      let lastStartError: Error | null = null;

      for (const format of formatsToTry) {
        try {
          const session = new VideoRecordingSession({
            app: this.app,
            directoryPath,
            ensureDirectory: async (path) => {
              await directoryManager.ensureDirectoryByPath(path);
            },
            format,
            onStatus: (status) => this.handleSessionStatus(status),
            onError: (error) => this.handleError(error),
            onComplete: (result) => {
              void this.handleRecordingComplete(result);
            },
            recorderStrategy: "browser",
            captureAudio,
          });
          this.session = session;
          await session.start();
          startedFormat = format;
          break;
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          lastStartError = normalized;
          this.session?.dispose();
          this.session = null;
          const isUnsupported = this.isNotSupportedError(normalized);
          const shouldRetryWithWebm =
            format.extension === "mp4" && isUnsupported;
          if (isUnsupported && hasMacWindowShellRecordingSupport()) {
            const shellFormat: VideoRecorderFormat = {
              mimeType: "video/quicktime",
              extension: "mov",
            };
            try {
              new Notice("Starting macOS video capture fallback...", 3500);
              const shellSession = new VideoRecordingSession({
                app: this.app,
                directoryPath,
                ensureDirectory: async (path) => {
                  await directoryManager.ensureDirectoryByPath(path);
                },
                format: shellFormat,
                onStatus: (status) => this.handleSessionStatus(status),
                onError: (sessionError) => this.handleError(sessionError),
                onComplete: (result) => {
                  void this.handleRecordingComplete(result);
                },
                recorderStrategy: "mac-shell",
                captureAudio,
              });
              this.session = shellSession;
              if (captureAudio.includeSystemAudio) {
                new Notice(
                  "System audio capture is limited in this macOS shell fallback runtime. Default input audio capture will be used where available.",
                  9000
                );
              }
              await shellSession.start();
              startedFormat = shellFormat;
              break;
            } catch (shellError) {
              lastStartError = shellError instanceof Error ? shellError : new Error(String(shellError));
              this.session?.dispose();
              this.session = null;
            }
          }
          if (!shouldRetryWithWebm) {
            throw normalized;
          }
        }
      }

      if (!this.session || !startedFormat) {
        throw lastStartError ?? new Error("Unable to start video recording.");
      }

      if (this.stopRequestedDuringStart) {
        this.stopRequestedDuringStart = false;
        this.isRecording = true;
        this.lifecycleState = "recording";
        await this.stopRecording();
        return;
      }

      this.isRecording = true;
      this.lifecycleState = "recording";
      this.notifyListeners();
      this.ui.setRecordingState(true);
      this.ui.setStatus("Recording in progress...");
      this.ui.startTimer();
      this.info("Video recording started", {
        format: startedFormat.extension,
        directoryPath,
      });
      if (startedFormat.extension !== preferredFormat.extension) {
        new Notice(
          `Preferred ${preferredFormat.extension.toUpperCase()} recording isn't supported here; using ${startedFormat.extension.toUpperCase()} instead.`,
          7000
        );
      }
      new Notice(
        `Recording video capture (${startedFormat.extension.toUpperCase()}). Run the command again to stop.`,
        4500
      );
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.lifecycleState = "idle";
      this.stopRequestedDuringStart = false;
      this.resolveSessionLifecycle();
      this.handleError(normalized);
    }
  }

  private async stopRecording(): Promise<void> {
    this.debug("stopRecording requested", {
      hasSession: !!this.session,
      isRecording: this.isRecording,
    });

    if (!this.session || !this.isRecording) {
      return;
    }

    try {
      this.lifecycleState = "stopping";
      this.ui.setStatus("Stopping recording...");
      this.ui.setRecordingState(false);
      this.ui.stopTimer();
      this.session.stop();
      this.isRecording = false;
      this.notifyListeners();
      await this.waitForSessionLifecycle();
      this.info("Video recording stopped");
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.error("stopRecording failed", normalized);
      this.handleError(normalized);
      this.cleanup();
    }
  }

  private async handleRecordingComplete(result: VideoRecordingResult): Promise<void> {
    this.info("Video recording completed", {
      filePath: result.filePath,
      durationMs: result.durationMs,
      stopReason: result.stopReason,
    });

    this.isRecording = false;
    this.ui.setRecordingState(false);
    this.ui.stopTimer();
    this.notifyListeners();
    this.session = null;
    this.lifecycleState = "idle";
    this.resolveSessionLifecycle();

    const fileName = result.filePath.split("/").pop();
    if (result.stopReason === "source-ended") {
      this.ui.linger(fileName ? `Capture ended. Saved ${fileName}.` : "Capture ended and was saved.", 3000);
      new Notice(fileName ? `Obsidian window capture ended. Saved ${fileName}.` : "Obsidian window capture ended and was saved.", 6000);
    } else if (result.stopReason === "permission-revoked") {
      this.ui.linger(fileName ? `Permission ended. Saved ${fileName}.` : "Permission ended and recording was saved.", 3200);
      new Notice(fileName ? `Screen capture permission ended. Saved ${fileName}.` : "Screen capture permission ended and was saved.", 6000);
    } else {
      this.ui.linger(fileName ? `Saved ${fileName}` : "Video recording saved.", 2400);
      new Notice(fileName ? `Saved video recording: ${fileName}` : "Video recording saved.", 4500);
    }
  }

  private async assertRecordingAvailable(): Promise<void> {
    if (!Platform.isDesktopApp) {
      throw new Error("Video recording is available on Obsidian desktop only.");
    }

    if (this.runtimeUnsupported) {
      if (!hasMacWindowShellRecordingSupport()) {
        throw new Error("Screen capture is unavailable in this Obsidian runtime.");
      }
      this.runtimeUnsupported = false;
    }

    if (!LicenseChecker.hasValidLicense(this.plugin)) {
      await LicenseChecker.showProFeaturePopup(this.app);
      throw new Error("A valid Pro license is required for video recording.");
    }

    const hasMediaRecorder = typeof MediaRecorder !== "undefined";
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const hasCaptureApi = !!mediaDevices?.getDisplayMedia || !!mediaDevices?.getUserMedia;
    const hasShellFallback = hasMacWindowShellRecordingSupport();
    if ((!hasMediaRecorder || !hasCaptureApi) && !hasShellFallback) {
      throw new Error("Screen recording APIs are not available in this runtime.");
    }
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener(this.isRecording);
      } catch {
        this.warn("toggle listener threw");
      }
    });
  }

  private async confirmCapturePermissionsIfNeeded(): Promise<boolean> {
    const shouldShow = this.plugin.settings.showVideoRecordingPermissionPopup !== false;
    if (!shouldShow) {
      return true;
    }

    const result = await openVideoRecordingPermissionModal(this.app);
    if (result.dontShowAgain) {
      try {
        await this.plugin.getSettingsManager().updateSettings({
          showVideoRecordingPermissionPopup: false,
        });
      } catch (error) {
        this.warn("Failed to persist video permission popup preference", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!result.confirmed) {
      new Notice("Video recording canceled before start.", 4000);
      return false;
    }

    return true;
  }

  private beginSessionLifecycle(): void {
    if (!this.sessionCompletionPromise) {
      this.sessionCompletionPromise = new Promise<void>((resolve) => {
        this.sessionCompletionResolver = resolve;
      });
    }
  }

  private resolveSessionLifecycle(): void {
    if (this.sessionCompletionResolver) {
      this.sessionCompletionResolver();
    }
    this.sessionCompletionResolver = null;
    this.sessionCompletionPromise = null;
  }

  private async waitForSessionLifecycle(): Promise<void> {
    if (this.sessionCompletionPromise) {
      await this.sessionCompletionPromise;
    }
  }

  private handleError(error: Error): void {
    const canceled = isRecorderCanceledError(error) || this.isCanceledError(error);
    const unsupported = this.isNotSupportedError(error);
    const hasShellFallback = hasMacWindowShellRecordingSupport();
    if (canceled) {
      this.info("Video recording canceled", {
        message: error.message,
      });
    } else if (unsupported) {
      if (hasShellFallback) {
        this.runtimeUnsupported = false;
        this.warn("Browser capture unavailable; macOS shell fallback still available", {
          message: error.message,
        });
      } else {
        this.runtimeUnsupported = true;
        this.warn("Video recorder unavailable in current runtime", {
          message: error.message,
        });
      }
    } else {
      this.error("Video recorder error", error);
    }
    this.isRecording = false;
    this.ui.setRecordingState(false);
    this.ui.stopTimer();
    this.notifyListeners();
    this.lifecycleState = "idle";
    this.resolveSessionLifecycle();
    this.cleanup(false, false);
    if (canceled) {
      this.ui.linger(error.message, 2600);
      new Notice(error.message, 7000);
      return;
    }
    if (unsupported) {
      this.ui.linger("Video recorder unavailable in this runtime.", 3000);
      if (hasShellFallback) {
        new Notice("Browser screen capture APIs are unavailable; using macOS shell recording fallback.", 8000);
      } else {
        new Notice(
          "This Obsidian/Electron runtime does not expose screen capture APIs. Use the external SystemSculpt recording workflow for now.",
          10000
        );
      }
      return;
    }
    this.ui.linger(`Recording failed: ${error.message}`, 3200);
    new Notice(`Video recording failed: ${error.message}`, 8000);
  }

  private handleSessionStatus(status: string): void {
    this.debug("Video recording status", { status });
    this.ui.setStatus(status);
    const lowered = status.toLowerCase();
    if (lowered.includes("retrying with window picker")) {
      new Notice("Direct window capture failed; select the Obsidian window in the picker to continue.", 8000);
    }
  }

  private isNotSupportedError(error: Error): boolean {
    const name = String(error.name || "").toLowerCase();
    const message = String(error.message || "").toLowerCase();
    return name.includes("notsupported") || message.includes("not supported");
  }

  private isCanceledError(error: Error): boolean {
    const name = String(error.name || "").toLowerCase();
    const message = String(error.message || "").toLowerCase();
    return name.includes("canceled")
      || message.includes("recording canceled")
      || message.includes("canceled before capture");
  }

  private cleanup(includeSessionDispose: boolean = true, closeUi: boolean = true): void {
    if (includeSessionDispose) {
      this.session?.dispose();
    }
    this.session = null;
    this.isRecording = false;
    this.lifecycleState = "idle";
    this.stopRequestedDuringStart = false;
    this.resolveSessionLifecycle();
    if (closeUi) {
      this.ui.close();
    }
  }

  private debug(message: string, metadata: Record<string, unknown> = {}): void {
    logDebug("VideoRecorderService", message, metadata);
  }

  private info(message: string, metadata: Record<string, unknown> = {}): void {
    logInfo("VideoRecorderService", message, metadata);
  }

  private warn(message: string, metadata: Record<string, unknown> = {}): void {
    logWarning("VideoRecorderService", message, metadata);
  }

  private error(message: string, error: unknown): void {
    logError("VideoRecorderService", message, error);
  }
}
