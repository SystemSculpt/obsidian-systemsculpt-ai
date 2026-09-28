import type { Editor, WorkspaceLeaf } from "obsidian";
import { App, normalizePath, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { PendingRecorderCapture } from "../types";
import { CHAT_VIEW_TYPE } from "../core/plugin/viewTypes";
import { logDebug, logError, logInfo } from "../utils/errorHandling";
import { PLAN_REQUIRED_MESSAGE } from "../utils/errors";
import { hasActivePlan, UpgradePlanModal } from "../modals/UpgradePlanModal";
import { TranscriptionService, type TranscriptionTask } from "./TranscriptionService";
import {
  ManagedTranscriptionInterruptedError,
  ManagedTranscriptionRetryError,
  TranscriptionResumeRequiredError,
} from "./transcription/ManagedTranscriptionAdapter";
import { pickRecorderFormat } from "./recorder/RecorderFormats";
import {
  MAX_ENCODED_CAPTURE_BYTES,
  MOBILE_MAX_ENCODED_CAPTURE_BYTES,
  RecordingSession,
  type RecordingCaptureFile,
  type RecordingResult,
} from "./recorder/RecordingSession";
import { getCurrentHostPreferredMicrophoneId } from "./recorder/RecorderPreferenceStore";
import {
  RECORDINGS_IN_PROGRESS_DIRECTORY,
  ensureAdapterDirectory,
  isDiscardedRecordingPath,
  isInProgressRecordingPath,
  moveRecordingIntoVault,
  recordingPathIn,
} from "./recorder/RecordingInProgressFiles";
import { getHostDeviceType } from "../platform/hostCapabilities";
import {
  RecorderUIManager,
  type RecorderUiModel,
} from "./recorder/RecorderUIManager";
import {
  captureNoteInsertionTarget,
  type TranscriptionInsertionValidator,
} from "./transcription/NoteInsertionTarget";

type RecorderLifecycleState =
  | "idle"
  | "starting"
  | "recording"
  | "saving"
  | "saved"
  | "transcribing"
  | "complete"
  | "warning"
  | "error";

interface RecordingOrigin {
  leaf: WorkspaceLeaf | null;
  destination: "note" | "chat";
  editor: Editor | null;
  validateInsertionTarget?: TranscriptionInsertionValidator;
  conversationOriginToken: string | null;
  hostDocument: Document | null;
}

interface CompletedCapture {
  result: RecordingResult;
  origin: RecordingOrigin;
  microphoneLabel: string;
}

interface QueuedTranscription {
  capture: CompletedCapture;
  resumeOperationId: string | null;
  intent: TranscriptionIntent;
}

type TranscriptionIntent = "automatic" | "manual";

/** Bounds the audio a capture holds in memory; streaming to disk adds its own bound. */
function memoryCaptureLimitBytes(): number {
  return getHostDeviceType() === "Mobile"
    ? MOBILE_MAX_ENCODED_CAPTURE_BYTES
    : MAX_ENCODED_CAPTURE_BYTES;
}

function captureLimitLabel(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

export type RecorderTranscriptionListener = (
  text: string,
  originLeaf: WorkspaceLeaf | null,
  conversationOriginToken: string | null,
  outputPath: string,
) => boolean | void;

/**
 * One explicit recorder workflow: capture, durable save, optional managed
 * transcription, and delivery back to the initiating surface.
 */
export class RecorderService {
  private static instance: RecorderService | null = null;

  private readonly ui: RecorderUIManager;
  private readonly recordingListeners = new Set<(recording: boolean) => void>();
  private readonly transcriptionListeners = new Set<RecorderTranscriptionListener>();

  private state: RecorderLifecycleState = "idle";
  private session: RecordingSession | null = null;
  private captureTask: Promise<void> | null = null;
  private transcriptionTask: TranscriptionTask | null = null;
  private readonly transcriptionTasks = new Set<TranscriptionTask>();
  private readonly queuedTranscriptions: QueuedTranscription[] = [];
  private readonly queuedTranscriptionPaths = new Set<string>();
  private queueDrainRunning = false;
  private queueVisibilityDocument: Document | null = null;
  private queueVisibilityListener: (() => void) | null = null;
  private transcriptionCancellationPending = false;
  private transcriptionResumeOperationId: string | null = null;
  private cancelledStart: RecordingSession | null = null;
  private transitionQueue: Promise<void> = Promise.resolve();
  private startQueued = false;
  private stopQueued = false;
  private unloaded = false;
  private visibilityDocument: Document | null = null;
  private visibilityWindow: Window | null = null;
  private visibilityListener: (() => void) | null = null;
  private pendingCapturePersistence: Promise<void> = Promise.resolve();
  private pendingRecoveryRunning = false;
  private pendingRecoveryVisibilityDocument: Document | null = null;
  private pendingRecoveryVisibilityListener: (() => void) | null = null;
  private readonly activePendingPaths = new Set<string>();
  /** The hidden file the current capture is streaming into, if any. */
  private captureInProgressPath: string | null = null;
  private interruptedCapturesRecovered = false;

  private origin: RecordingOrigin | null = null;
  private microphoneLabel = "";
  private completedCapture: CompletedCapture | null = null;
  private outputPath: string | null = null;
  private recordingStartedAt = 0;
  private pendingSaveStatus = "";

  private constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
  ) {
    this.ui = new RecorderUIManager({ app, plugin });
  }

  public static getInstance(app?: App, plugin?: SystemSculptPlugin): RecorderService {
    if (RecorderService.instance && plugin && RecorderService.instance.plugin !== plugin) {
      RecorderService.instance.unload();
    }
    if (!RecorderService.instance) {
      if (!app || !plugin) throw new Error("RecorderService has not been initialized");
      RecorderService.instance = new RecorderService(app, plugin);
    }
    return RecorderService.instance;
  }

  public onToggle(callback: (recording: boolean) => void): () => void {
    this.recordingListeners.add(callback);
    return () => this.recordingListeners.delete(callback);
  }

  public onTranscription(callback: RecorderTranscriptionListener): () => void {
    this.transcriptionListeners.add(callback);
    return () => this.transcriptionListeners.delete(callback);
  }

  /**
   * Resume recorder-owned work that survived an app/process restart.
   * Origins are intentionally not reconstructed: recovered text is saved to a
   * transcript file and reported, never inserted into a guessed note or chat.
   */
  public recoverPendingCaptures(): void {
    if (this.unloaded || this.pendingRecoveryRunning) return;
    if (!this.interruptedCapturesRecovered) {
      // Once per session: bring audio from a capture that Obsidian quit or
      // crashed during out of hiding. A capture running now is left alone.
      this.interruptedCapturesRecovered = true;
      this.pendingRecoveryRunning = true;
      void this.recoverInterruptedCaptures()
        .catch((error) => logError("RecorderService", "Could not recover an interrupted recording", error))
        .finally(() => {
          this.pendingRecoveryRunning = false;
          this.recoverPendingCaptures();
        });
      return;
    }
    if (this.plugin.settings.autoTranscribeRecordings) {
      void this.drainQueuedTranscriptions();
    }
    const pending = (this.plugin.settings.pendingRecorderCaptures ?? [])
      .filter((capture) => capture.filePath !== this.captureInProgressPath);
    if (!pending.length) return;

    const hostDocument = this.app.workspace.containerEl?.ownerDocument;
    if (hostDocument?.visibilityState === "hidden") {
      this.deferPendingRecoveryUntilVisible(hostDocument);
      return;
    }
    this.clearPendingRecoveryVisibilityResume();

    const settled = pending.filter((capture) => !capture.captureInProgress && !capture.discarded);
    if (!settled.length) return;
    const recoverable = settled.filter((capture) => this.shouldRecoverPendingCapture(capture));
    if (!recoverable.length) {
      new Notice("A saved recording is waiting for transcription. Turn on automatic transcription in settings, or run \"transcribe an audio file\".", 7000);
      return;
    }

    this.pendingRecoveryRunning = true;
    void this.recoverPendingCapturesSequentially(recoverable)
      .finally(() => { this.pendingRecoveryRunning = false; });
  }

  public isCurrentlyRecording(): boolean {
    return this.state === "starting" || this.state === "recording";
  }

  public toggleRecording(): Promise<void> {
    if (this.unloaded) return Promise.resolve();
    if (this.transcriptionCancellationPending) {
      const capture = this.completedCapture;
      if (capture) {
        this.render({
          phase: "warning",
          status: "Still finishing safe cancellation. The saved audio and recovery operation are preserved.",
          durationMs: capture.result.durationMs,
          sourcePath: capture.result.filePath,
          canRetry: false,
        });
      }
      return Promise.resolve();
    }
    if (this.state === "starting") {
      return this.cancelStartingRecording();
    }
    if (this.state === "recording") {
      return this.enqueueStop();
    }
    if (this.state === "saving") {
      return Promise.resolve();
    }
    if (this.state === "transcribing") {
      this.detachDisplayedTranscription();
      new Notice("The previous recording is still transcribing. Starting a new recording…", 4500);
    }
    if (this.state === "warning" && this.transcriptionResumeOperationId && this.completedCapture) {
      this.showPreservedTranscriptionRecovery();
      return Promise.resolve();
    }
    if (this.session?.hasPendingSave()) {
      this.showPendingSaveRecovery();
      return Promise.resolve();
    }
    if (this.startQueued) {
      this.startQueued = false;
      return this.transitionQueue;
    }
    this.startQueued = true;
    return this.enqueue(async () => {
      if (!this.startQueued) return;
      this.startQueued = false;
      await this.startRecording();
    });
  }

  public unload(): void {
    if (this.unloaded) return;
    this.unloaded = true;
    for (const task of this.transcriptionTasks) task.cancel();
    this.transcriptionTasks.clear();
    this.queuedTranscriptions.length = 0;
    this.queuedTranscriptionPaths.clear();
    this.clearQueueVisibilityResume();
    this.transcriptionTask = null;
    this.transcriptionCancellationPending = false;
    this.pendingRecoveryRunning = false;
    this.clearPendingRecoveryVisibilityResume();
    this.activePendingPaths.clear();
    this.captureInProgressPath = null;
    this.startQueued = false;
    this.clearVisibilityResume();

    const activeSession = this.session;
    if (activeSession?.isRecording()) {
      void activeSession.stop("interrupted").catch(() => undefined);
    } else {
      activeSession?.dispose();
    }
    this.session = null;
    this.ui.close();
    this.recordingListeners.clear();
    this.transcriptionListeners.clear();
    this.state = "idle";
    if (RecorderService.instance === this) RecorderService.instance = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transitionQueue.then(operation);
    this.transitionQueue = next.catch(() => undefined);
    return next;
  }

  private enqueueStop(): Promise<void> {
    if (this.stopQueued) return this.transitionQueue;
    this.stopQueued = true;
    if (this.state === "starting") {
      this.render({
        phase: "starting",
        status: "Stopping as soon as microphone access finishes…",
      });
    }
    return this.enqueue(() => this.stopRecording()).finally(() => {
      this.stopQueued = false;
    });
  }

  private cancelStartingRecording(): Promise<void> {
    if (this.stopQueued) return this.captureTask ?? Promise.resolve();
    this.stopQueued = true;
    const session = this.session;
    if (session) {
      this.cancelledStart = session;
      this.render({
        phase: "starting",
        status: "Cancelling microphone request…",
      });
      session.dispose();
    }
    const pending = this.captureTask ?? Promise.resolve();
    return pending.catch(() => undefined).finally(() => {
      this.stopQueued = false;
    });
  }

  private async startRecording(): Promise<void> {
    if (this.unloaded || this.state === "starting" || this.state === "recording") return;
    if (this.state === "saving") return;
    if (this.session?.hasPendingSave()) {
      this.showPendingSaveRecovery();
      return;
    }

    this.resetCompletedWork();
    this.state = "starting";
    this.origin = this.captureOrigin();
    this.notifyRecordingListeners();

    const hostContext = this.ui.open(this.uiActions(), {
      phase: "starting",
      status: "Waiting for microphone access…",
    });
    if (this.origin) this.origin.hostDocument = hostContext.hostDocument;
    const directoryPath = this.recordingsDirectory();
    const directoryManager = this.plugin.directoryManager;
    if (!directoryManager) {
      this.handleCaptureFailure(new Error("Recording folders are still loading. Try again in a moment."));
      return;
    }

    const session = new RecordingSession({
      app: this.app,
      directoryPath,
      ensureDirectory: (path) => directoryManager.ensureDirectoryByPath(path),
      format: pickRecorderFormat(hostContext.hostWindow),
      preferredMicrophoneId: getCurrentHostPreferredMicrophoneId(
        hostContext.hostWindow,
        this.plugin.settings.vaultInstanceId || this.app.vault.getName(),
      ) || null,
      hostContext,
      maxEncodedBytes: memoryCaptureLimitBytes(),
      onCaptureFileCreated: (capture) => this.rememberCaptureInProgress(session, capture),
      onCaptureFileDiscarded: (filePath) => this.rememberDiscardedFragment(filePath),
      onStatus: (status) => {
        if (this.session !== session) return;
        if (this.state === "recording" && !session.isRecording()) {
          this.state = "saving";
          this.notifyRecordingListeners();
        }
        const phase = this.state === "saving"
          ? "saving"
          : this.state === "recording"
            ? "recording"
            : "starting";
        this.render({
          phase,
          status,
          ...(phase === "recording"
            ? {
              startedAt: this.recordingStartedAt,
              microphoneLabel: this.microphoneLabel,
            }
            : {}),
        });
      },
    });
    this.session = session;
    this.captureTask = session.completion.then(
      (result) => this.handleCaptureComplete(session, result),
      (error) => this.handleCaptureFailure(error, session),
    );

    try {
      const started = await session.start();
      if (this.unloaded || this.session !== session) {
        session.dispose();
        return;
      }
      this.microphoneLabel = started.microphoneLabel;
      this.recordingStartedAt = started.startedAt;
      this.state = "recording";
      this.render({
        phase: "recording",
        status: `Recording with ${started.microphoneLabel}`,
        startedAt: started.startedAt,
        microphoneLabel: started.microphoneLabel,
      });
      this.notifyRecordingListeners();
      logInfo("RecorderService", "Recording started", { filePath: started.filePath });
    } catch {
      await this.captureTask.catch(() => undefined);
    }
  }

  private async stopRecording(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (!session.isRecording()) {
      await this.captureTask?.catch(() => undefined);
      return;
    }

    this.state = "saving";
    this.render({
      phase: "saving",
      status: "Saving recording…",
      microphoneLabel: this.microphoneLabel,
    });
    this.notifyRecordingListeners();
    await session.stop("manual").catch(() => undefined);
    await this.captureTask?.catch(() => undefined);
  }

  private async handleCaptureComplete(
    session: RecordingSession,
    result: RecordingResult,
  ): Promise<void> {
    if (this.session !== session) return;
    const origin = this.origin ?? this.captureOrigin();
    this.session = null;
    this.captureTask = null;
    this.pendingSaveStatus = "";
    this.state = "saved";
    this.recordingStartedAt = 0;
    this.completedCapture = {
      result,
      origin,
      microphoneLabel: this.microphoneLabel,
    };
    this.notifyRecordingListeners();
    // A streamed capture was moved out of its hidden in-progress file.
    const streamedPath = this.captureInProgressPath;
    this.captureInProgressPath = null;
    if (this.plugin.settings.autoTranscribeRecordings) {
      await this.rememberPendingCapture(this.completedCapture, "automatic", streamedPath).catch((error) => {
        logError("RecorderService", "Could not persist pending recorder transcription", error);
      });
    } else if (streamedPath) {
      await this.forgetPendingCapture(streamedPath).catch((error) => {
        logError("RecorderService", "Could not clear the finished recording's recovery entry", error);
      });
    }

    const status = result.stopReason === "size-limit"
      ? `Recording reached the ${captureLimitLabel(session.captureLimitBytes)} safety limit. The captured audio is saved.`
      : result.stopReason === "background-hidden" || result.stopReason === "background-pagehide"
        ? "Obsidian moved to the background, so recording stopped and the captured audio was saved."
        : result.stopReason === "interrupted"
          ? "Microphone capture was interrupted. The captured audio is saved."
          : "Recording saved.";
    this.render({
      phase: "saved",
      status,
      durationMs: result.durationMs,
      microphoneLabel: this.microphoneLabel,
      sourcePath: result.filePath,
    });
    logInfo("RecorderService", "Recording saved", {
      filePath: result.filePath,
      sizeBytes: result.sizeBytes,
      stopReason: result.stopReason,
    });

    if (this.unloaded) return;
    if (this.plugin.settings.autoTranscribeRecordings) {
      const capture = this.completedCapture;
      if (!capture) return;
      const backgroundStop = capture.result.stopReason === "background-hidden"
        || capture.result.stopReason === "background-pagehide";
      if (backgroundStop || capture.origin.hostDocument?.visibilityState === "hidden") {
        this.deferTranscriptionUntilVisible(capture);
      } else {
        await this.transcribeSavedRecording("automatic");
      }
    }
  }

  private handleCaptureFailure(error: unknown, session?: RecordingSession): void {
    if (session && this.session !== session) return;
    if (session && this.cancelledStart === session) {
      this.cancelledStart = null;
      this.session = null;
      this.captureTask = null;
      this.state = "idle";
      this.notifyRecordingListeners();
      this.ui.close();
      return;
    }
    if (error instanceof Error && error.name === "AbortError" && this.unloaded) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (session?.hasPendingSave()) {
      this.captureTask = null;
      this.pendingSaveStatus = this.buildPendingSaveStatus(normalized);
      this.state = "warning";
      this.recordingStartedAt = 0;
      this.notifyRecordingListeners();
      this.showPendingSaveRecovery();
      logError("RecorderService", "Recording save failed; audio retained in memory", normalized);
      return;
    }
    // Audio already streamed stays registered; the next launch moves it into place.
    this.captureInProgressPath = null;
    this.session = null;
    this.captureTask = null;
    this.state = "error";
    this.notifyRecordingListeners();
    this.render({
      phase: "error",
      status: normalized.message,
    });
    logError("RecorderService", "Recording failed", normalized);
  }

  private async transcribeSavedRecording(
    intent: TranscriptionIntent = "automatic",
  ): Promise<void> {
    this.clearVisibilityResume();
    const capture = this.completedCapture;
    if (!capture || this.transcriptionTask || this.unloaded) return;

    // The recording itself is local and already saved; only transcription is
    // a managed AI feature. Gate here so the failure is guidance, not silence.
    if (!hasActivePlan(this.plugin)) {
      this.state = "warning";
      this.renderRecovery({
        phase: "warning",
        status: `Audio saved. Transcription needs an active SystemSculpt plan. ${PLAN_REQUIRED_MESSAGE}`,
        durationMs: capture.result.durationMs,
        sourcePath: capture.result.filePath,
        canRetry: true,
      });
      if (intent === "manual") {
        UpgradePlanModal.openOnce(this.plugin, { feature: "Transcription" });
      }
      return;
    }

    try {
      // Persist intent before any remote dispatch. This closes the restart
      // window for user-requested transcription when the automatic setting is
      // off, and also retries a failed automatic pending-state write.
      await this.ensurePendingCapture(capture, intent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = "warning";
      this.renderRecovery({
        phase: "warning",
        status: `Audio saved, but transcription could not be made restart-safe: ${message}`,
        durationMs: capture.result.durationMs,
        sourcePath: capture.result.filePath,
        canRetry: true,
      });
      logError("RecorderService", "Could not persist recorder transcription intent", error);
      return;
    }

    if (this.transcriptionTasks.size > 0) {
      this.enqueueTranscription(capture, this.transcriptionResumeOperationId, intent);
      return;
    }

    await this.runTranscription(
      capture,
      true,
      this.transcriptionResumeOperationId,
    );
  }

  private async runTranscription(
    capture: CompletedCapture,
    displayInRecorder: boolean,
    resumeOperationId: string | null,
  ): Promise<void> {
    if (this.unloaded) return;

    if (displayInRecorder) {
      this.state = "transcribing";
      this.render({
        phase: "transcribing",
        status: resumeOperationId
          ? "Resuming preserved transcription…"
          : "Preparing transcript…",
        progress: 1,
        durationMs: capture.result.durationMs,
        microphoneLabel: capture.microphoneLabel,
        sourcePath: capture.result.filePath,
      });
    }

    let activeTask: TranscriptionTask | null = null;
    const task = TranscriptionService.getInstance(this.plugin).start({
      filePath: capture.result.filePath,
      destination: capture.origin.destination,
      callerScope: capture.origin.destination === "chat"
        ? "recorder/chat-dictation"
        : "recorder/note-dictation",
      sourceOwnership: "recorder-capture",
      targetEditor: capture.origin.editor,
      validateInsertionTarget: capture.origin.validateInsertionTarget,
      ...(resumeOperationId
        ? { resumeOperationId }
        : {}),
      onOperationIdChange: (operationId) => (
        this.updatePendingOperation(capture.result.filePath, operationId)
      ),
      onProgress: (event) => {
        if (!displayInRecorder || (activeTask && this.transcriptionTask !== activeTask)) return;
        this.render({
          phase: "transcribing",
          status: event.message,
          progress: event.progress,
          durationMs: capture.result.durationMs,
          microphoneLabel: capture.microphoneLabel,
          sourcePath: capture.result.filePath,
        });
      },
    });
    activeTask = task;
    if (displayInRecorder) this.transcriptionTask = task;
    this.transcriptionTasks.add(task);
    this.activePendingPaths.add(capture.result.filePath);

    try {
      const result = await task.promise;
      this.transcriptionTasks.delete(task);
      let pendingCaptureCleared = false;
      try {
        await this.forgetPendingCapture(capture.result.filePath);
        pendingCaptureCleared = true;
      } catch (error) {
        logError("RecorderService", "Could not clear completed recorder recovery", error);
      }
      if (pendingCaptureCleared && result.acknowledgeCompletion) {
        await result.acknowledgeCompletion().catch((error) => {
          logError("RecorderService", "Could not acknowledge completed recorder transcription", error);
        });
      }
      const isDisplayed = this.transcriptionTask === task
        && this.completedCapture === capture;
      if (isDisplayed) {
        this.transcriptionCancellationPending = false;
        this.transcriptionTask = null;
        this.transcriptionResumeOperationId = null;
        this.outputPath = result.outputPath;
      }

      let warning = result.warning;
      if (
        capture.origin.destination === "chat"
        && this.plugin.settings.autoPasteTranscription
      ) {
        const insertedIntoOrigin = this.notifyTranscriptionListeners(
          result.text,
          capture.origin.leaf,
          capture.origin.conversationOriginToken,
          result.outputPath,
        );
        if (!insertedIntoOrigin) {
          const chatWarning = "The transcript was saved, but the chat where recording started changed or closed, so no text was inserted.";
          warning = warning ? `${warning} ${chatWarning}` : chatWarning;
        }
      }

      if (isDisplayed) {
        this.state = warning ? "warning" : "complete";
        this.render({
          phase: warning ? "warning" : "complete",
          status: warning ?? "Transcript saved.",
          durationMs: capture.result.durationMs,
          outputPath: result.outputPath,
        });
      }
      if (!isDisplayed || !this.ui.isVisible()) {
        new Notice(`Transcript saved to ${result.outputPath}.`, 6000);
      } else if (!warning) {
        this.ui.closeAfter(5_000);
      }
    } catch (error) {
      this.transcriptionTasks.delete(task);
      const persistedOperationId = this.recoveryOperationId(error);
      await this.updatePendingOperation(capture.result.filePath, persistedOperationId)
        .catch((persistError) => logError("RecorderService", "Could not update recorder recovery", persistError));
      const isDisplayed = this.transcriptionTask === task
        && this.completedCapture === capture;
      if (!isDisplayed) {
        if (!this.unloaded) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`The earlier recording is saved, but transcription needs attention: ${message}`, 8000);
          logError("RecorderService", "Detached transcription needs attention", error);
        }
        return;
      }
      this.transcriptionCancellationPending = false;
      this.transcriptionTask = null;
      if (error instanceof Error && error.name === "AbortError") {
        const interruption = error instanceof ManagedTranscriptionInterruptedError
          ? error
          : null;
        this.transcriptionResumeOperationId = interruption?.retryDisposition === "resume"
          ? interruption.operationId
          : null;
        this.state = "warning";
        this.renderRecovery({
          phase: "warning",
          status: interruption?.retryDisposition === "blocked"
            ? `Stopped waiting locally. Operation ${interruption.operationId} is preserved, but its dispatch state is ambiguous, so automatic retry is disabled to prevent duplicate work.`
            : this.transcriptionResumeOperationId
              ? "Stopped waiting locally. Server transcription is preserved; Retry resumes the same operation."
              : "Stopped waiting locally. The unfinished upload was cancelled; your saved audio is unchanged.",
          durationMs: capture.result.durationMs,
          sourcePath: capture.result.filePath,
          canRetry: interruption?.retryDisposition !== "blocked",
        });
        return;
      }

      if (error instanceof ManagedTranscriptionRetryError) {
        this.transcriptionResumeOperationId = error.retryDisposition === "resume"
          ? error.operationId
          : null;
        this.state = "warning";
        this.renderRecovery({
          phase: "warning",
          status: error.retryDisposition === "blocked"
            ? `Audio saved. Operation ${error.operationId} is preserved in ${error.recoveryPhase ?? "an unknown phase"}, but automatic retry is disabled to prevent duplicate server work: ${error.message}`
            : error.retryDisposition === "resume"
              ? `Audio saved. Server transcription is preserved after an interruption: ${error.message} Retry resumes the same operation.`
              : `Audio saved. Transcription stopped: ${error.message} Retry starts a fresh operation.`,
          durationMs: capture.result.durationMs,
          sourcePath: capture.result.filePath,
          canRetry: error.retryDisposition !== "blocked",
        });
        return;
      }

      const normalized = error instanceof Error ? error : new Error(String(error));
      if (error instanceof TranscriptionResumeRequiredError) {
        this.transcriptionResumeOperationId = error.operationId;
      }
      this.state = "warning";
      this.renderRecovery({
        phase: "warning",
        status: this.transcriptionResumeOperationId
          ? `Audio saved. Local transcript finishing failed: ${normalized.message} Retry resumes the same server operation.`
          : `Audio saved. Transcription failed: ${normalized.message}`,
        durationMs: capture.result.durationMs,
        sourcePath: capture.result.filePath,
        canRetry: true,
      });
      if (!this.ui.isVisible()) {
        new Notice(`Transcription failed: ${normalized.message}`, 7000);
      }
      logError("RecorderService", "Transcription failed", normalized);
    } finally {
      this.activePendingPaths.delete(capture.result.filePath);
      void this.drainQueuedTranscriptions();
    }
  }

  /**
   * Recorder capture stays independent from upload work, but recorder-owned
   * uploads are serialized so repeated stop/start cycles cannot materialize
   * several large audio files in a mobile WebView at once.
   */
  private enqueueTranscription(
    capture: CompletedCapture,
    resumeOperationId: string | null,
    intent: TranscriptionIntent,
  ): void {
    const filePath = capture.result.filePath;
    if (this.activePendingPaths.has(filePath) || this.queuedTranscriptionPaths.has(filePath)) {
      return;
    }
    this.queuedTranscriptionPaths.add(filePath);
    this.queuedTranscriptions.push({ capture, resumeOperationId, intent });

    if (this.completedCapture === capture && !this.isCurrentlyRecording()) {
      this.state = "saved";
      this.render({
        phase: "saved",
        status: "Recording saved. Waiting for the previous transcription; you can start another recording.",
        durationMs: capture.result.durationMs,
        microphoneLabel: capture.microphoneLabel,
        sourcePath: filePath,
      });
    }
  }

  private async drainQueuedTranscriptions(): Promise<void> {
    if (
      this.queueDrainRunning
      || this.unloaded
      || this.transcriptionTasks.size > 0
      || !this.hasEligibleQueuedTranscription()
    ) return;

    const hostDocument = this.app.workspace.containerEl?.ownerDocument;
    if (hostDocument?.visibilityState === "hidden") {
      this.deferQueueUntilVisible(hostDocument);
      return;
    }
    this.clearQueueVisibilityResume();

    this.queueDrainRunning = true;
    try {
      while (
        !this.unloaded
        && this.transcriptionTasks.size === 0
        && this.hasEligibleQueuedTranscription()
      ) {
        const nextIndex = this.queuedTranscriptions.findIndex(
          (queued) => queued.intent === "manual"
            || this.plugin.settings.autoTranscribeRecordings,
        );
        const [queued] = nextIndex >= 0
          ? this.queuedTranscriptions.splice(nextIndex, 1)
          : [];
        if (!queued) break;
        this.queuedTranscriptionPaths.delete(queued.capture.result.filePath);
        const displayInRecorder = this.completedCapture === queued.capture
          && !this.isCurrentlyRecording()
          && this.state !== "saving";
        await this.runTranscription(
          queued.capture,
          displayInRecorder,
          queued.resumeOperationId,
        );
      }
    } finally {
      this.queueDrainRunning = false;
    }
  }

  private hasEligibleQueuedTranscription(): boolean {
    return this.queuedTranscriptions.some(
      (queued) => queued.intent === "manual"
        || this.plugin.settings.autoTranscribeRecordings,
    );
  }

  private deferQueueUntilVisible(hostDocument: Document): void {
    if (this.queueVisibilityDocument === hostDocument && this.queueVisibilityListener) return;
    this.clearQueueVisibilityResume();
    const resume = () => {
      if (hostDocument.visibilityState === "hidden") return;
      this.clearQueueVisibilityResume();
      void this.drainQueuedTranscriptions();
    };
    this.queueVisibilityDocument = hostDocument;
    this.queueVisibilityListener = resume;
    hostDocument.addEventListener("visibilitychange", resume);
  }

  private clearQueueVisibilityResume(): void {
    if (this.queueVisibilityDocument && this.queueVisibilityListener) {
      this.queueVisibilityDocument.removeEventListener(
        "visibilitychange",
        this.queueVisibilityListener,
      );
    }
    this.queueVisibilityDocument = null;
    this.queueVisibilityListener = null;
  }

  private deferPendingRecoveryUntilVisible(hostDocument: Document): void {
    if (
      this.pendingRecoveryVisibilityDocument === hostDocument
      && this.pendingRecoveryVisibilityListener
    ) return;
    this.clearPendingRecoveryVisibilityResume();
    const resume = () => {
      if (hostDocument.visibilityState === "hidden") return;
      this.clearPendingRecoveryVisibilityResume();
      this.recoverPendingCaptures();
    };
    this.pendingRecoveryVisibilityDocument = hostDocument;
    this.pendingRecoveryVisibilityListener = resume;
    hostDocument.addEventListener("visibilitychange", resume);
  }

  private clearPendingRecoveryVisibilityResume(): void {
    if (this.pendingRecoveryVisibilityDocument && this.pendingRecoveryVisibilityListener) {
      this.pendingRecoveryVisibilityDocument.removeEventListener(
        "visibilitychange",
        this.pendingRecoveryVisibilityListener,
      );
    }
    this.pendingRecoveryVisibilityDocument = null;
    this.pendingRecoveryVisibilityListener = null;
  }

  private mutatePendingCaptures(
    mutate: (current: PendingRecorderCapture[]) => PendingRecorderCapture[],
  ): Promise<void> {
    const next = this.pendingCapturePersistence.then(async () => {
      const current = (this.plugin.settings.pendingRecorderCaptures ?? [])
        .map((entry) => ({ ...entry }));
      const pendingRecorderCaptures = mutate(current).slice(-20);
      await this.plugin.getSettingsManager().updateSettings({ pendingRecorderCaptures });
    });
    this.pendingCapturePersistence = next.catch(() => undefined);
    return next;
  }

  /**
   * Register a streamed capture's partial file as soon as its first audio is
   * on disk. If Obsidian quits or crashes before Stop, the next launch finds
   * this entry and recovers the audio instead of losing the whole recording.
   */
  private rememberCaptureInProgress(
    session: RecordingSession,
    capture: RecordingCaptureFile,
  ): void {
    if (this.unloaded || this.session !== session) return;
    this.captureInProgressPath = capture.filePath;
    const entry: PendingRecorderCapture = {
      filePath: capture.filePath,
      startedAt: capture.startedAt,
      durationMs: 0,
      sizeBytes: capture.sizeBytes,
      stopReason: "interrupted",
      destination: this.origin?.destination ?? "note",
      captureInProgress: true,
    };
    void this.mutatePendingCaptures((current) => [
      ...current.filter((existing) => existing.filePath !== entry.filePath),
      entry,
    ]).catch((error) => {
      logError("RecorderService", "Could not register the recording for crash recovery", error);
    });
  }

  /**
   * A capture that was streaming when Obsidian quit or crashed left its audio
   * in the hidden in-progress folder, usually with an in-progress entry.
   * Move each such file into the recordings folder and report it. It is
   * transcribed only when automatic transcription is on, as for any
   * recording that stops. A file whose entry was lost is still recovered.
   */
  private async recoverInterruptedCaptures(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const pending = this.plugin.settings.pendingRecorderCaptures ?? [];
    const discarded = pending.filter((capture) => capture.discarded);
    const entries = pending.filter((capture) => capture.captureInProgress && !capture.discarded);
    const known = new Set([...entries, ...discarded].map((capture) => capture.filePath));
    for (const capture of discarded) {
      if (this.unloaded) return;
      await this.deleteDiscardedFragment(capture.filePath);
    }
    const orphans: PendingRecorderCapture[] = [];
    if (await adapter.exists(RECORDINGS_IN_PROGRESS_DIRECTORY)) {
      for (const filePath of (await adapter.list(RECORDINGS_IN_PROGRESS_DIRECTORY)).files) {
        if (known.has(filePath)) continue;
        if (isDiscardedRecordingPath(filePath)) {
          await adapter.remove(filePath).catch(() => undefined);
          continue;
        }
        orphans.push({
          filePath,
          startedAt: 0,
          durationMs: 0,
          sizeBytes: 0,
          stopReason: "interrupted",
          destination: "note",
          captureInProgress: true,
        });
      }
    }
    for (const capture of [...entries, ...orphans]) {
      if (this.unloaded) return;
      if (this.isActiveCaptureFile(capture.filePath)) continue;
      await this.recoverInterruptedCapture(capture);
    }
  }

  /**
   * A capture that fell back to memory could neither delete nor rename the
   * fragment of its in-progress file. Record it so recovery deletes it
   * instead of presenting it as an interrupted recording.
   */
  private rememberDiscardedFragment(filePath: string): void {
    if (this.unloaded) return;
    const entry: PendingRecorderCapture = {
      filePath,
      startedAt: Date.now(),
      durationMs: 0,
      sizeBytes: 0,
      stopReason: "interrupted",
      destination: "note",
      discarded: true,
    };
    void this.mutatePendingCaptures((current) => [
      ...current.filter((existing) => existing.filePath !== filePath),
      entry,
    ]).catch((error) => {
      logError("RecorderService", "Could not record an abandoned recording fragment", error);
    });
  }

  private async deleteDiscardedFragment(filePath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(filePath)) await adapter.remove(filePath);
    } catch {
      return; // Kept, and skipped again, until it can be deleted.
    }
    await this.forgetPendingCapture(filePath);
  }

  /** The in-progress file of the capture running now, which recovery must not move. */
  private isActiveCaptureFile(filePath: string): boolean {
    return filePath === this.captureInProgressPath
      || (this.session !== null && filePath === this.session.inProgressPath);
  }

  private async recoverInterruptedCapture(capture: PendingRecorderCapture): Promise<void> {
    const adapter = this.app.vault.adapter;
    const stat = await adapter.stat(capture.filePath).catch(() => null);
    if (!stat || stat.type !== "file" || !(stat.size > 0)) {
      if (stat?.type === "file") await adapter.remove(capture.filePath).catch(() => undefined);
      await this.forgetPendingCapture(capture.filePath);
      return;
    }
    let filePath = capture.filePath;
    if (isInProgressRecordingPath(filePath)) {
      const directory = this.recordingsDirectory();
      try {
        if (this.plugin.directoryManager) await this.plugin.directoryManager.ensureDirectoryByPath(directory);
        else await ensureAdapterDirectory(adapter, directory);
        filePath = await moveRecordingIntoVault(this.app, capture.filePath, recordingPathIn(directory, capture.filePath));
      } catch (error) {
        logError("RecorderService", "Could not move an interrupted recording into place", error);
        new Notice(
          `An interrupted recording is saved at ${capture.filePath}, but it could not be moved to ${directory}. SystemSculpt will try again when Obsidian restarts.`,
          9000,
        );
        return;
      }
    }
    const startedAt = capture.startedAt > 0 ? capture.startedAt : Number(stat.ctime) || 0;
    const lastWrite = Number(stat.mtime);
    const recovered: PendingRecorderCapture = {
      filePath,
      startedAt,
      durationMs: Number.isFinite(lastWrite) ? Math.max(0, lastWrite - startedAt) : 0,
      sizeBytes: stat.size,
      stopReason: "interrupted",
      destination: capture.destination,
      transcriptionIntent: "automatic",
    };
    const transcribe = this.plugin.settings.autoTranscribeRecordings;
    await this.mutatePendingCaptures((current) => [
      ...current.filter((entry) => entry.filePath !== capture.filePath && entry.filePath !== filePath),
      ...(transcribe ? [recovered] : []),
    ]);
    new Notice(`Recovered an interrupted recording: ${filePath}.`, 7000);
  }

  private recordingsDirectory(): string {
    const configuredDirectory = this.plugin.settings.recordingsDirectory?.trim()
      || "SystemSculpt/Recordings";
    return normalizePath(configuredDirectory).replace(/\/+$/, "")
      || "SystemSculpt/Recordings";
  }

  private rememberPendingCapture(
    capture: CompletedCapture,
    transcriptionIntent: TranscriptionIntent,
    replacedPath: string | null = null,
  ): Promise<void> {
    const pending: PendingRecorderCapture = {
      filePath: capture.result.filePath,
      startedAt: capture.result.startedAt,
      durationMs: capture.result.durationMs,
      sizeBytes: capture.result.sizeBytes,
      stopReason: capture.result.stopReason,
      destination: capture.origin.destination,
      transcriptionIntent,
    };
    return this.mutatePendingCaptures((current) => {
      const existing = current.find((entry) => entry.filePath === pending.filePath);
      return [
        ...current.filter((entry) => entry.filePath !== pending.filePath && entry.filePath !== replacedPath),
        {
          ...pending,
          ...(existing?.transcriptionIntent === "manual"
            ? { transcriptionIntent: "manual" }
            : {}),
          ...(existing?.operationId ? { operationId: existing.operationId } : {}),
        },
      ];
    });
  }

  private ensurePendingCapture(
    capture: CompletedCapture,
    transcriptionIntent: TranscriptionIntent,
  ): Promise<void> {
    const existing = (this.plugin.settings.pendingRecorderCaptures ?? [])
      .find((entry) => entry.filePath === capture.result.filePath);
    const matchingCapture = existing
      && existing.startedAt === capture.result.startedAt
      && existing.durationMs === capture.result.durationMs
      && existing.sizeBytes === capture.result.sizeBytes
      && existing.stopReason === capture.result.stopReason
      && existing.destination === capture.origin.destination;
    const matchingIntent = existing?.transcriptionIntent === "manual"
      || existing?.transcriptionIntent === transcriptionIntent;
    return matchingCapture && matchingIntent
      ? Promise.resolve()
      : this.rememberPendingCapture(capture, transcriptionIntent);
  }

  private updatePendingOperation(
    filePath: string,
    operationId: string | null,
  ): Promise<void> {
    return this.mutatePendingCaptures((current) => current.map((entry) => {
      if (entry.filePath !== filePath) return entry;
      if (operationId) return { ...entry, operationId };
      const { operationId: _discarded, ...withoutOperation } = entry;
      return withoutOperation;
    }));
  }

  private forgetPendingCapture(filePath: string): Promise<void> {
    return this.mutatePendingCaptures(
      (current) => current.filter((entry) => entry.filePath !== filePath),
    );
  }

  private recoveryOperationId(error: unknown): string | null {
    if (error instanceof TranscriptionResumeRequiredError) return error.operationId;
    if (error instanceof ManagedTranscriptionInterruptedError) {
      return error.retryDisposition === "restart" ? null : error.operationId;
    }
    if (error instanceof ManagedTranscriptionRetryError) {
      return error.retryDisposition === "restart" ? null : error.operationId;
    }
    return null;
  }

  private shouldRecoverPendingCapture(capture: PendingRecorderCapture): boolean {
    return this.plugin.settings.autoTranscribeRecordings
      || capture.transcriptionIntent === "manual";
  }

  private async recoverPendingCapturesSequentially(
    pending: readonly PendingRecorderCapture[],
  ): Promise<void> {
    for (const capture of pending) {
      if (this.unloaded) return;
      if (!this.shouldRecoverPendingCapture(capture)) continue;
      if (capture.recoveryBlocked === "conflicting-operation-ids") {
        new Notice(
          `Saved recording ${capture.filePath} has conflicting recovery state. The audio was left unchanged; transcribe it manually after checking existing transcript files.`,
          9000,
        );
        continue;
      }
      if (
        this.activePendingPaths.has(capture.filePath)
        || this.queuedTranscriptionPaths.has(capture.filePath)
      ) continue;
      const source = this.app.vault.getAbstractFileByPath(capture.filePath);
      if (!(source instanceof TFile)) {
        if (capture.operationId) {
          try {
            await TranscriptionService.getInstance(this.plugin)
              .acknowledgeCompleted(capture.operationId);
          } catch (error) {
            logError(
              "RecorderService",
              "Could not acknowledge completed transcription for missing recorder source",
              error,
            );
            new Notice(
              `The saved audio ${capture.filePath} is missing, but its recovery record could not be cleared. SystemSculpt will retry cleanup later.`,
              8000,
            );
            continue;
          }
        }
        await this.forgetPendingCapture(capture.filePath).catch(() => undefined);
        continue;
      }

      let task: TranscriptionTask | null = null;
      try {
        task = TranscriptionService.getInstance(this.plugin).start({
          filePath: capture.filePath,
          destination: capture.destination,
          callerScope: capture.destination === "chat"
            ? "recorder/chat-dictation"
            : "recorder/note-dictation",
          sourceOwnership: "recorder-capture",
          ...(capture.operationId ? { resumeOperationId: capture.operationId } : {}),
          onOperationIdChange: (operationId) => (
            this.updatePendingOperation(capture.filePath, operationId)
          ),
        });
        this.transcriptionTasks.add(task);
        this.activePendingPaths.add(capture.filePath);

        const result = await task.promise;
        await this.forgetPendingCapture(capture.filePath);
        if (result.acknowledgeCompletion) {
          await result.acknowledgeCompletion().catch((error) => {
            logError("RecorderService", "Could not acknowledge recovered recorder transcription", error);
          });
        }
        new Notice(`Recovered transcript saved to ${result.outputPath}.`, 7000);
      } catch (error) {
        await this.updatePendingOperation(
          capture.filePath,
          this.recoveryOperationId(error),
        ).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Saved recording still needs transcription: ${message}`, 8000);
        logError("RecorderService", "Pending recorder recovery did not finish", error);
      } finally {
        if (task) this.transcriptionTasks.delete(task);
        this.activePendingPaths.delete(capture.filePath);
        await this.drainQueuedTranscriptions();
      }
    }
  }

  private captureOrigin(): RecordingOrigin {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const isChat = leaf?.view?.getViewType?.() === CHAT_VIEW_TYPE;
    const noteTarget = isChat ? null : captureNoteInsertionTarget(this.app);
    const conversationOriginToken = isChat
      ? (leaf?.view as { getConversationOriginToken?: () => string } | undefined)
        ?.getConversationOriginToken?.() ?? null
      : null;
    return {
      leaf,
      destination: isChat ? "chat" : "note",
      editor: noteTarget?.editor ?? null,
      ...(noteTarget ? { validateInsertionTarget: noteTarget.validate } : {}),
      conversationOriginToken,
      hostDocument: this.app.workspace.containerEl?.ownerDocument ?? null,
    };
  }

  private deferTranscriptionUntilVisible(capture: CompletedCapture): void {
    this.clearVisibilityResume();
    const hostDocument = capture.origin.hostDocument;
    if (!hostDocument) {
      void this.transcribeSavedRecording("automatic");
      return;
    }
    this.state = "saved";
    this.render({
      phase: "saved",
      status: "Recording saved. Transcription will start when Obsidian returns.",
      durationMs: capture.result.durationMs,
      microphoneLabel: capture.microphoneLabel,
      sourcePath: capture.result.filePath,
    });
    let pageShown = capture.result.stopReason !== "background-pagehide";
    const resume = (event?: Event) => {
      if (event?.type === "pageshow") pageShown = true;
      if (!pageShown) return;
      if (hostDocument.visibilityState === "hidden") return;
      this.clearVisibilityResume();
      if (this.unloaded || this.completedCapture !== capture || this.state !== "saved") return;
      void this.transcribeSavedRecording("automatic");
    };
    this.visibilityDocument = hostDocument;
    this.visibilityWindow = hostDocument.defaultView;
    this.visibilityListener = resume;
    hostDocument.addEventListener("visibilitychange", resume);
    this.visibilityWindow?.addEventListener("pageshow", resume);
    // A hidden app can return while the Blob is still being persisted. Recheck
    // after listeners are installed so that transition cannot strand the
    // saved capture until an unrelated second background/foreground cycle.
    // pagehide is different: WebKit can still report a visible document during
    // teardown, so it must observe a real pageshow before network work starts.
    if (pageShown) resume();
  }

  private clearVisibilityResume(): void {
    if (this.visibilityDocument && this.visibilityListener) {
      this.visibilityDocument.removeEventListener("visibilitychange", this.visibilityListener);
    }
    if (this.visibilityWindow && this.visibilityListener) {
      this.visibilityWindow.removeEventListener("pageshow", this.visibilityListener);
    }
    this.visibilityDocument = null;
    this.visibilityWindow = null;
    this.visibilityListener = null;
  }

  private stopWaitingForTranscription(): void {
    const task = this.transcriptionTask;
    const capture = this.completedCapture;
    if (!task || !capture) return;
    this.transcriptionCancellationPending = true;
    this.state = "warning";
    this.render({
      phase: "warning",
      status: "Stopped waiting locally. Finishing safe cancellation; your saved audio is unchanged.",
      durationMs: capture.result.durationMs,
      sourcePath: capture.result.filePath,
      canRetry: false,
    });
    task.cancel();
  }

  private uiActions() {
    return {
      onStop: () => { void this.toggleRecording(); },
      onClose: () => this.ui.close(),
      onTranscribe: () => { void this.transcribeSavedRecording("manual"); },
      onRetry: () => { void this.transcribeSavedRecording("manual"); },
      onRetrySave: () => { void this.retryPendingSave(); },
      onCancelTranscription: () => this.stopWaitingForTranscription(),
      onOpenOutput: () => { void this.openOutput(); },
      onOpenSettings: () => {
        this.ui.close();
        this.plugin.openSettingsTab("workflow");
      },
    };
  }

  private async retryPendingSave(): Promise<void> {
    const session = this.session;
    const pending = session?.getPendingSaveResult();
    if (!session?.hasPendingSave() || !pending || this.state === "saving") return;

    this.state = "saving";
    this.render({
      phase: "saving",
      status: "Saving captured audio…",
      durationMs: pending.durationMs,
      microphoneLabel: this.microphoneLabel,
      sourcePath: pending.filePath,
    });

    try {
      const result = await session.retrySave();
      if (this.unloaded || this.session !== session) return;
      await this.handleCaptureComplete(session, result);
    } catch (error) {
      if (this.unloaded || this.session !== session) return;
      this.handleCaptureFailure(error, session);
    }
  }

  private showPendingSaveRecovery(): void {
    const pending = this.session?.getPendingSaveResult();
    if (!pending) return;
    const model: RecorderUiModel = {
      phase: "warning",
      status: this.pendingSaveStatus
        || "Audio is still in memory because it could not be saved. Retry save before closing Obsidian.",
      durationMs: pending.durationMs,
      microphoneLabel: this.microphoneLabel,
      sourcePath: pending.filePath,
      canRetrySave: true,
    };
    if (this.ui.isVisible()) this.render(model);
    else this.ui.open(this.uiActions(), model);
  }

  private showPreservedTranscriptionRecovery(): void {
    const capture = this.completedCapture;
    const operationId = this.transcriptionResumeOperationId;
    if (!capture || !operationId) return;
    this.renderRecovery({
      phase: "warning",
      status: `Audio saved. Server transcription ${operationId} is preserved; Retry resumes the same operation before starting another recording.`,
      durationMs: capture.result.durationMs,
      sourcePath: capture.result.filePath,
      canRetry: true,
    });
  }

  private renderRecovery(model: RecorderUiModel): void {
    if (this.ui.isVisible()) this.render(model);
    else this.ui.open(this.uiActions(), model);
  }

  private buildPendingSaveStatus(error: Error): string {
    if (!/^Audio is still in memory/i.test(error.message)) {
      return `${error.message} Retry save to finish saving it.`;
    }
    const detail = error.message
      .replace(/^Audio is still in memory, but it could not be saved:?\s*/i, "")
      .trim();
    return detail
      ? `Audio is still in memory because it could not be saved: ${detail} Retry save before closing Obsidian.`
      : "Audio is still in memory because it could not be saved. Retry save before closing Obsidian.";
  }

  private async openOutput(): Promise<void> {
    if (!this.outputPath) return;
    const output = this.app.vault.getAbstractFileByPath(this.outputPath);
    if (!(output instanceof TFile)) {
      new Notice("The transcript file is no longer in the vault.", 4500);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(output);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private render(model: RecorderUiModel): void {
    if (this.unloaded) return;
    this.ui.render(model);
  }

  private notifyRecordingListeners(): void {
    const recording = this.isCurrentlyRecording();
    for (const listener of this.recordingListeners) {
      try {
        listener(recording);
      } catch {
        // Presentation observers cannot change recorder state.
      }
    }
  }

  private notifyTranscriptionListeners(
    text: string,
    originLeaf: WorkspaceLeaf | null,
    conversationOriginToken: string | null,
    outputPath: string,
  ): boolean {
    let insertedIntoOrigin = false;
    for (const listener of this.transcriptionListeners) {
      try {
        if (listener(text, originLeaf, conversationOriginToken, outputPath) === true) {
          insertedIntoOrigin = true;
        }
      } catch (error) {
        logDebug("RecorderService", "Transcript observer failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return insertedIntoOrigin;
  }

  private resetCompletedWork(): void {
    this.clearVisibilityResume();
    this.transcriptionTask = null;
    this.transcriptionCancellationPending = false;
    this.transcriptionResumeOperationId = null;
    this.completedCapture = null;
    this.cancelledStart = null;
    this.origin = null;
    this.outputPath = null;
    this.microphoneLabel = "";
    this.recordingStartedAt = 0;
    this.pendingSaveStatus = "";
    this.state = "idle";
    this.ui.close();
  }

  /**
   * Leave an already-uploading transcript in the shared task registry while
   * the recorder card is reused for another capture. Completion still inserts
   * into its pinned origin and reports through a notice.
   */
  private detachDisplayedTranscription(): void {
    if (!this.transcriptionTask) return;
    this.transcriptionTask = null;
    this.transcriptionResumeOperationId = null;
    this.completedCapture = null;
    this.origin = null;
    this.outputPath = null;
    this.microphoneLabel = "";
    this.recordingStartedAt = 0;
    this.state = "idle";
    this.ui.close();
  }
}
