import type { App, Editor } from "obsidian";
import { TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { getHostDeviceType } from "../../platform/hostCapabilities";
import { sha256HexFromArrayBuffer, sha256HexFromBytesPortable } from "../../studio/hash";
import { DEFAULT_SETTINGS } from "../../types";
import { MAX_FILE_SIZE, formatFileSize } from "../../utils/FileValidator";
import { logError } from "../../utils/errorHandling";
import { PostProcessingService } from "../PostProcessingService";
import { ManagedJobClient } from "../managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "../managed/ManagedJobRecoveryStore";
import { ObsidianManagedRecoveryAdapter } from "../managed/adapters/ObsidianManagedRecoveryAdapter";
import {
  ManagedTranscriptionAdapter,
  ManagedTranscriptionInterruptedError,
  ManagedTranscriptionRetryError,
  TranscriptionResumeRequiredError,
  type ManagedTranscriptionContext,
  type ManagedTranscriptionSource,
} from "./ManagedTranscriptionAdapter";
import type { ManagedLocalCommitReceipt } from "../managed/ManagedTypes";
import {
  createLocalCommitReceipt,
  LocalCommitReceiptMismatchError,
  stripLocalCommitMarker,
  verifyLocalCommitReceipt,
} from "./LocalCommitReceipt";
import type { TranscriptionInsertionValidator } from "./NoteInsertionTarget";
import { TranscriptionTitleService } from "./TranscriptionTitleService";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  flac: "audio/flac",
});

// Obsidian exposes portable binary vault reads as whole ArrayBuffers. These
// limits bound hashing + multipart-upload peak memory until host streaming is
// available across both desktop and mobile.
export const DESKTOP_TRANSCRIPTION_MAX_FILE_SIZE = 128 * 1024 * 1024;
export const MOBILE_TRANSCRIPTION_MAX_FILE_SIZE = 32 * 1024 * 1024;

export function getTranscriptionMaxFileSize(): number {
  return getHostDeviceType() === "Mobile"
    ? MOBILE_TRANSCRIPTION_MAX_FILE_SIZE
    : Math.min(MAX_FILE_SIZE, DESKTOP_TRANSCRIPTION_MAX_FILE_SIZE);
}

const UTF8 = new TextEncoder();
const MAX_TRANSCRIPTION_TITLE_COLLISION_ATTEMPTS = 50;

function normalizeLanguage(value?: string): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function buildOpaqueSourceIdentity(input: {
  callerScope: string;
  destination: "note" | "chat";
  logicalSource: string;
  timestamped: boolean;
  language?: string;
  recoveryVariant?: string;
}): string {
  const logicalSourceHash = sha256HexFromBytesPortable(UTF8.encode(input.logicalSource));
  const recoveryVariantHash = sha256HexFromBytesPortable(
    UTF8.encode(input.recoveryVariant ?? "default"),
  );
  const descriptor = JSON.stringify({
    schema: "transcription-source-v2",
    callerScope: input.callerScope,
    destination: input.destination,
    timestamped: input.timestamped,
    language: normalizeLanguage(input.language),
    logicalSourceHash,
    recoveryVariantHash,
  });
  return `transcription:${sha256HexFromBytesPortable(UTF8.encode(descriptor))}`;
}

export interface TranscriptionContext {
  type: "note" | "chat";
  callerScope?: string;
  language?: string;
  logicalSource?: string;
  timestamped?: boolean;
  /** Stable description of caller-owned local output semantics for crash deduplication. */
  recoveryVariant?: string;
  onProgress?: (progress: number, status: string) => void;
  signal?: AbortSignal;
}

export type TranscriptionPhase =
  | "preparing"
  | "uploading"
  | "transcribing"
  | "cleaning"
  | "saving"
  | "complete";

export interface TranscriptionProgressEvent {
  phase: TranscriptionPhase;
  progress: number;
  message: string;
}

export interface TranscriptionRequest {
  filePath: string;
  destination: "note" | "chat";
  callerScope?: string;
  language?: string;
  logicalSource?: string;
  /** Only recorder-owned captures may follow the recorder retention setting. */
  sourceOwnership?: "recorder-capture" | "user-file";
  targetEditor?: Editor | null;
  validateInsertionTarget?: TranscriptionInsertionValidator;
  timestamped?: boolean;
  resumeOperationId?: string;
  /** Persist a replacement recovery ID before a completed-but-edited output is retried. */
  onOperationIdChange?: (operationId: string) => Promise<void> | void;
  signal?: AbortSignal;
  onProgress?: (event: TranscriptionProgressEvent) => void;
}

export interface TranscriptionResult {
  operationId: string;
  text: string;
  outputPath: string;
  insertedIntoOrigin: boolean;
  sourceDisposition: "kept" | "trashed" | "cleanup-failed";
  warning?: string;
  acknowledgeCompletion?: () => Promise<void>;
}

type PlannedTranscriptionOutput = Readonly<{
  outputPath: string;
  storedContent: string;
  receipt: ManagedLocalCommitReceipt;
  existing: boolean;
}>;

export type TranscriptionCommitResult<T> =
  | T
  | Readonly<{
      value: T;
      receipt?: ManagedLocalCommitReceipt;
    }>;

type RecoveredTranscriptionOutput = Readonly<{
  outputPath: string;
  text: string;
}>;

type TranscriptionOutputPolicy = Readonly<{
  cleanOutput: boolean;
  postProcessingEnabled: boolean;
  postProcessingPrompt: string;
  keepRecorderSource: boolean;
  autoPasteAtOrigin: boolean;
}>;

function abortError(): DOMException {
  return new DOMException("Transcription was cancelled locally.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { name?: unknown }).name === "AbortError";
}

function createOperationId(ownerWindow: Window): string {
  const random = ownerWindow.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `transcription-${random}`.slice(0, 128);
}

/**
 * Runs one transcription and owns its remote-to-local commit boundary. UI,
 * notices, and chat delivery remain caller concerns.
 */
export class TranscriptionCoordinator {
  private readonly postProcessing: PostProcessingService;
  private managedAdapter: ManagedTranscriptionAdapter | null;
  private activeController: AbortController | null = null;
  private removeParentAbortListener: (() => void) | null = null;
  private activeOperationId: string | null = null;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    managedAdapter?: ManagedTranscriptionAdapter,
  ) {
    this.managedAdapter = managedAdapter ?? null;
    this.postProcessing = PostProcessingService.getInstance(plugin);
  }

  public abort(): void {
    this.activeController?.abort();
  }

  public getActiveOperationId(): string | null {
    return this.activeOperationId;
  }

  public async acknowledgeCompleted(operationId: string): Promise<void> {
    await this.adapter().acknowledgeCompleted(operationId);
  }

  public async transcribeFile<T>(
    file: TFile,
    context: TranscriptionContext & {
      recoverLocalCommit?: (receipt: ManagedLocalCommitReceipt, operationId: string) => Promise<T>;
    },
    commit: (text: string, operationId: string) => Promise<TranscriptionCommitResult<T>>,
  ): Promise<T> {
    const controller = this.createController(context.signal);
    const operationId = createOperationId(this.ownerWindow);
    const sourceIdentity = buildOpaqueSourceIdentity({
      callerScope: context.callerScope ?? "transcription/generic-commit",
      destination: context.type,
      logicalSource: context.logicalSource ?? file.path,
      timestamped: context.timestamped === true,
      language: context.language,
      recoveryVariant: context.recoveryVariant,
    });
    this.activeOperationId = operationId;
    let retryOperationId = operationId;
    let remoteReady = false;
    this.assertTranscribableSize(file);
    const source = this.createManagedSource(file, controller.signal, sourceIdentity);
    const managedContext: ManagedTranscriptionContext = {
      timestamped: context.timestamped,
      language: context.language,
      signal: controller.signal,
      onProgress: context.onProgress,
      maxAudioBytes: getTranscriptionMaxFileSize(),
    };

    try {
      let remote = await this.adapter().transcribe(source, {
        ...managedContext,
        operationId,
      });
      retryOperationId = remote.operationId;
      remoteReady = true;
      if (remote.kind === "local_receipt") {
        if (context.recoverLocalCommit) {
          try {
            const recovered = await context.recoverLocalCommit(remote.receipt, remote.operationId);
            if (remote.recoveryPhase === "local_commit_pending") {
              await this.adapter().completeLocalCommit(remote.operationId);
            }
            await this.acknowledgeCompletionBestEffort(remote.operationId);
            return recovered;
          } catch (error) {
            if (
              remote.recoveryPhase === "completed"
              && error instanceof LocalCommitReceiptMismatchError
            ) {
              await this.acknowledgeCompleted(remote.operationId);
              const replacementOperationId = createOperationId(this.ownerWindow);
              retryOperationId = replacementOperationId;
              remote = await this.adapter().transcribe(source, {
                ...managedContext,
                operationId: replacementOperationId,
              });
              remoteReady = true;
            } else if (remote.recoveryPhase !== "local_commit_pending") {
              throw error;
            }
          }
        }
        if (remote.kind === "local_receipt") {
          try {
            remote = await this.adapter().resume(remote.operationId, source, {
              ...managedContext,
              allowPendingLocalReceipt: false,
            });
          } catch (error) {
            if (
              error instanceof ManagedTranscriptionRetryError
              && error.retryDisposition === "restart"
            ) {
              const replacementOperationId = createOperationId(this.ownerWindow);
              retryOperationId = replacementOperationId;
              remote = await this.adapter().transcribe(source, {
                ...managedContext,
                operationId: replacementOperationId,
              });
            } else {
              throw error;
            }
          }
        }
        retryOperationId = remote.operationId;
        if (remote.kind === "local_receipt") {
          if (!context.recoverLocalCommit) {
            throw new Error("The completed local transcription output was preserved, but this caller cannot recover it.");
          }
          const recovered = await context.recoverLocalCommit(remote.receipt, remote.operationId);
          await this.acknowledgeCompletionBestEffort(remote.operationId);
          return recovered;
        }
      }
      throwIfAborted(controller.signal);
      await this.adapter().beginLocalCommit(remote.operationId, controller.signal);
      throwIfAborted(controller.signal);
      const committed = await commit(remote.text, remote.operationId);
      const resolved = this.unwrapCommitResult(committed);
      if (resolved.receipt) {
        await this.adapter().recordLocalCommitReceipt(remote.operationId, resolved.receipt);
      }
      await this.adapter().completeLocalCommit(remote.operationId);
      await this.acknowledgeCompletionBestEffort(remote.operationId);
      return resolved.value;
    } catch (error) {
      if (isAbortError(error) && !(error instanceof ManagedTranscriptionInterruptedError)) {
        throw new ManagedTranscriptionInterruptedError(
          retryOperationId,
          remoteReady,
          undefined,
          remoteReady ? "resume" : "restart",
        );
      }
      if (error instanceof ManagedTranscriptionRetryError) throw error;
      if (remoteReady && !(error instanceof ManagedTranscriptionInterruptedError)) {
        throw new TranscriptionResumeRequiredError(retryOperationId, error);
      }
      throw error;
    } finally {
      this.releaseController(controller);
    }
  }

  public async start(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const controller = this.createController(request.signal);
    const operationId = request.resumeOperationId ?? createOperationId(this.ownerWindow);
    const outputPolicy = this.snapshotOutputPolicy(request);
    const sourceIdentity = buildOpaqueSourceIdentity({
      callerScope: request.callerScope ?? "transcription/ui",
      destination: request.destination,
      logicalSource: request.logicalSource ?? request.filePath,
      timestamped: request.timestamped === true,
      language: request.language,
      recoveryVariant: this.buildRequestRecoveryVariant(request, outputPolicy),
    });
    this.activeOperationId = operationId;
    let retryOperationId = operationId;
    let remoteReady = false;
    const adoptRemoteOperationId = async (adoptedOperationId: string): Promise<void> => {
      const changed = adoptedOperationId !== retryOperationId;
      retryOperationId = adoptedOperationId;
      this.activeOperationId = adoptedOperationId;
      remoteReady = true;
      if (changed) {
        await request.onOperationIdChange?.(adoptedOperationId);
      }
    };
    const report = (
      phase: TranscriptionPhase,
      progress: number,
      message: string,
    ) => request.onProgress?.({ phase, progress, message });

    try {
      throwIfAborted(controller.signal);
      report("preparing", 1, "Preparing audio…");
      const file = this.resolveAudioFile(request.filePath);
      this.assertTranscribableSize(file);
      const source = this.createManagedSource(file, controller.signal, sourceIdentity);
      const managedContext: ManagedTranscriptionContext = {
        timestamped: request.timestamped,
        language: request.language,
        signal: controller.signal,
        maxAudioBytes: getTranscriptionMaxFileSize(),
        onOperationIdAdopted: adoptRemoteOperationId,
        onProgress: (progress, message) => {
          report(progress < 72 ? "uploading" : "transcribing", progress, message);
        },
      };
      try {
        await request.onOperationIdChange?.(operationId);
      } catch (error) {
        if (request.resumeOperationId) {
          throw new TranscriptionResumeRequiredError(operationId, error);
        }
        throw error;
      }
      throwIfAborted(controller.signal);
      let remote;
      if (request.resumeOperationId) {
        let recoveryAvailable: boolean;
        try {
          recoveryAvailable = await this.adapter().hasRecoveryOperation(request.resumeOperationId);
        } catch (error) {
          throw new TranscriptionResumeRequiredError(request.resumeOperationId, error);
        }
        if (recoveryAvailable) {
          try {
            remote = await this.adapter().resume(request.resumeOperationId, source, managedContext);
          } catch (error) {
            if (
              isAbortError(error)
              || error instanceof ManagedTranscriptionRetryError
              || error instanceof TranscriptionResumeRequiredError
            ) throw error;
            throw new TranscriptionResumeRequiredError(request.resumeOperationId, error);
          }
        } else {
          const replacementOperationId = createOperationId(this.ownerWindow);
          retryOperationId = replacementOperationId;
          await request.onOperationIdChange?.(replacementOperationId);
          remote = await this.adapter().transcribe(source, {
            ...managedContext,
            operationId: replacementOperationId,
          });
        }
      } else {
        remote = await this.adapter().transcribe(source, {
          ...managedContext,
          operationId,
        });
      }
      await adoptRemoteOperationId(remote.operationId);
      throwIfAborted(controller.signal);
      const timestamped = request.timestamped === true;
      let recoveredOutput: RecoveredTranscriptionOutput | null = null;
      let recoveryWarning: string | undefined;
      if (remote.kind === "local_receipt") {
        try {
          recoveredOutput = await this.recoverReceiptOutput(remote.receipt, controller.signal);
          if (remote.recoveryPhase === "local_commit_pending") {
            await this.adapter().completeLocalCommit(remote.operationId);
          }
        } catch (error) {
          if (
            remote.recoveryPhase === "completed"
            && error instanceof LocalCommitReceiptMismatchError
          ) {
            const replacementOperationId = createOperationId(this.ownerWindow);
            retryOperationId = replacementOperationId;
            await request.onOperationIdChange?.(replacementOperationId);
            await this.acknowledgeCompleted(remote.operationId);
            remote = await this.adapter().transcribe(source, {
              ...managedContext,
              operationId: replacementOperationId,
            });
            recoveryWarning = "The previous transcript was changed or removed, so SystemSculpt preserved that local state and created a fresh transcript.";
          } else if (remote.recoveryPhase === "local_commit_pending") {
            try {
              remote = await this.adapter().resume(remote.operationId, source, {
                ...managedContext,
                allowPendingLocalReceipt: false,
              });
            } catch (resumeError) {
              if (
                resumeError instanceof ManagedTranscriptionRetryError
                && resumeError.retryDisposition === "restart"
              ) {
                const replacementOperationId = createOperationId(this.ownerWindow);
                retryOperationId = replacementOperationId;
                await request.onOperationIdChange?.(replacementOperationId);
                remote = await this.adapter().transcribe(source, {
                  ...managedContext,
                  operationId: replacementOperationId,
                });
                recoveryWarning = "The previous server result expired before local recovery finished, so SystemSculpt safely started a fresh transcription.";
              } else {
                throw resumeError;
              }
            }
          } else {
            throw error;
          }
          await adoptRemoteOperationId(remote.operationId);
          if (remote.kind === "local_receipt") {
            recoveredOutput = await this.recoverReceiptOutput(remote.receipt, controller.signal);
          }
        }
      }

      let finalText: string;
      let outputPath: string;
      let warning: string | undefined;
      let insertionText = "";
      if (remote.kind === "local_receipt") {
        if (!recoveredOutput) {
          throw new Error("The completed local transcription output could not be recovered.");
        }
        finalText = recoveredOutput.text;
        outputPath = recoveredOutput.outputPath;
      } else {
        const committed = await this.commitTranscriptionOutput(
          file,
          remote,
          request,
          outputPolicy,
          report,
          controller.signal,
        );
        finalText = committed.finalText;
        insertionText = committed.insertionText;
        outputPath = committed.outputPath;
        warning = this.joinWarnings(recoveryWarning, committed.warning);
      }

      let insertedIntoOrigin = false;
      if (
        remote.kind === "transcript"
        && request.destination === "note"
        && !timestamped
        && outputPolicy.autoPasteAtOrigin
        && request.targetEditor
      ) {
        let targetIsCurrent = false;
        try {
          targetIsCurrent = request.validateInsertionTarget?.() === true;
        } catch {
          targetIsCurrent = false;
        }

        if (!targetIsCurrent) {
          warning = this.joinWarnings(
            warning,
            "The transcript was saved, but the note where transcription started changed or closed, so no text was inserted.",
          );
        } else {
          try {
            request.targetEditor.replaceSelection(insertionText);
            insertedIntoOrigin = true;
          } catch {
            warning = this.joinWarnings(
              warning,
              "The transcript was saved, but the note where transcription started could not accept the text.",
            );
          }
        }
      }

      let sourceDisposition: TranscriptionResult["sourceDisposition"] = "kept";
      if (
        request.sourceOwnership === "recorder-capture"
        && !outputPolicy.keepRecorderSource
      ) {
        try {
          await this.app.fileManager.trashFile(file);
          sourceDisposition = "trashed";
        } catch {
          sourceDisposition = "cleanup-failed";
          warning = this.joinWarnings(
            warning,
            "The transcript was saved, but the source audio could not be moved to trash.",
          );
        }
      }

      const acknowledgeCompletion = this.buildCompletionAcknowledgement(remote.operationId);
      if (request.sourceOwnership !== "recorder-capture") {
        await this.acknowledgeCompletionBestEffort(remote.operationId);
      }
      report("complete", 100, "Transcript saved");
      return {
        operationId: remote.operationId,
        text: finalText,
        outputPath,
        insertedIntoOrigin,
        sourceDisposition,
        ...(warning ? { warning } : {}),
        ...(request.sourceOwnership === "recorder-capture"
          ? { acknowledgeCompletion }
          : {}),
      };
    } catch (error) {
      if (isAbortError(error) && !(error instanceof ManagedTranscriptionInterruptedError)) {
        const resumeAvailable = Boolean(request.resumeOperationId) || remoteReady;
        throw new ManagedTranscriptionInterruptedError(
          retryOperationId,
          resumeAvailable,
          undefined,
          resumeAvailable ? "resume" : "restart",
        );
      }
      if (error instanceof ManagedTranscriptionRetryError) throw error;
      if (remoteReady && !(error instanceof ManagedTranscriptionInterruptedError)) {
        throw new TranscriptionResumeRequiredError(retryOperationId, error);
      }
      throw error;
    } finally {
      this.releaseController(controller);
    }
  }

  private adapter(): ManagedTranscriptionAdapter {
    if (this.managedAdapter) return this.managedAdapter;
    const graph = this.plugin.getManagedCapabilityGraph();
    this.managedAdapter = new ManagedTranscriptionAdapter({
      admission: graph.admission,
      jobs: new ManagedJobClient(graph.transport).transcription,
      recovery: new ManagedJobRecoveryStore(new ObsidianManagedRecoveryAdapter(this.app)),
    });
    return this.managedAdapter;
  }

  private createController(parentSignal?: AbortSignal): AbortController {
    this.activeController?.abort();
    this.removeParentAbortListener?.();
    this.removeParentAbortListener = null;

    const Controller = (this.ownerWindow as Window & { AbortController?: typeof AbortController }).AbortController
      ?? AbortController;
    const controller = new Controller();
    if (parentSignal) {
      const abort = () => controller.abort();
      if (parentSignal.aborted) abort();
      else {
        parentSignal.addEventListener("abort", abort, { once: true });
        this.removeParentAbortListener = () => parentSignal.removeEventListener("abort", abort);
      }
    }
    this.activeController = controller;
    return controller;
  }

  private releaseController(controller: AbortController): void {
    if (this.activeController !== controller) return;
    this.removeParentAbortListener?.();
    this.removeParentAbortListener = null;
    this.activeController = null;
    this.activeOperationId = null;
  }

  private resolveAudioFile(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error("Audio file not found.");
    return file;
  }

  private assertTranscribableSize(file: TFile): void {
    const size = file.stat.size;
    const isMobile = getHostDeviceType() === "Mobile";
    const maxFileSize = getTranscriptionMaxFileSize();
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error("Audio file is empty.");
    }
    if (size > maxFileSize) {
      throw new Error(
        `Audio file is too large (${formatFileSize(size)}). The ${isMobile ? "mobile " : ""}transcription limit is ${formatFileSize(maxFileSize)}.`,
      );
    }
  }

  private snapshotOutputPolicy(request: TranscriptionRequest): TranscriptionOutputPolicy {
    const postProcessingEnabled = request.timestamped !== true
      && this.plugin.settings.postProcessingEnabled;
    const configuredPrompt = String(this.plugin.settings.postProcessingPrompt || "").trim();
    return Object.freeze({
      cleanOutput: request.destination === "chat"
        || this.plugin.settings.cleanTranscriptionOutput,
      postProcessingEnabled,
      postProcessingPrompt: configuredPrompt || DEFAULT_SETTINGS.postProcessingPrompt,
      keepRecorderSource: request.sourceOwnership !== "recorder-capture"
        || this.plugin.settings.keepRecordingsAfterTranscription,
      autoPasteAtOrigin: this.plugin.settings.autoPasteTranscription,
    });
  }

  private buildRequestRecoveryVariant(
    request: TranscriptionRequest,
    outputPolicy: TranscriptionOutputPolicy,
  ): string {
    return JSON.stringify({
      schema: "transcription-output-v2",
      cleanOutput: outputPolicy.cleanOutput,
      postProcessingEnabled: outputPolicy.postProcessingEnabled,
      postProcessingPromptHash: outputPolicy.postProcessingEnabled
        ? sha256HexFromBytesPortable(UTF8.encode(outputPolicy.postProcessingPrompt))
        : null,
      sourceOwnership: request.sourceOwnership ?? null,
      keepRecorderSource: outputPolicy.keepRecorderSource,
    });
  }

  private async commitTranscriptionOutput(
    file: TFile,
    remote: Readonly<{ kind: "transcript"; operationId: string; text: string }>,
    request: TranscriptionRequest,
    outputPolicy: TranscriptionOutputPolicy,
    report: (phase: TranscriptionPhase, progress: number, message: string) => void,
    signal: AbortSignal,
  ): Promise<Readonly<{
    finalText: string;
    insertionText: string;
    outputPath: string;
    warning?: string;
  }>> {
    const timestamped = request.timestamped === true;
    let processedText = remote.text;
    let warning: string | undefined;
    if (outputPolicy.postProcessingEnabled) {
      report("cleaning", 96, "Cleaning up transcript…");
      const postProcessed = await this.postProcessing.processTranscription(remote.text, {
        operationId: `${remote.operationId}:postprocess`,
        signal,
        enabled: true,
        prompt: outputPolicy.postProcessingPrompt,
      });
      processedText = postProcessed.text;
      warning = postProcessed.warning;
    }
    throwIfAborted(signal);

    const finalText = timestamped
      ? remote.text.trim()
      : this.composeFinalText(
        file,
        remote.text,
        processedText,
        request.destination,
        request.sourceOwnership,
        outputPolicy,
        outputPolicy.postProcessingEnabled && !warning,
      );
    const insertionText = timestamped ? finalText : processedText;

    await this.adapter().beginLocalCommit(remote.operationId, signal);
    throwIfAborted(signal);
    const planned = await this.planTranscriptionOutput(
      file,
      finalText,
      processedText,
      timestamped,
      signal,
      remote.operationId,
      outputPolicy.cleanOutput,
    );
    await this.adapter().recordLocalCommitReceipt(remote.operationId, planned.receipt, signal);
    throwIfAborted(signal);
    report("saving", 98, "Saving transcript…");
    await this.writePlannedTranscriptionOutput(planned, signal);
    // The vault write is an irreversible local side effect. Once it returns,
    // cancellation only means "stop waiting"; always close the recovery
    // transaction so a real adapter cannot strand a committed output.
    await this.adapter().completeLocalCommit(remote.operationId);
    return {
      finalText,
      insertionText,
      outputPath: planned.outputPath,
      ...(warning ? { warning } : {}),
    };
  }

  private composeFinalText(
    file: TFile,
    rawText: string,
    processedText: string,
    destination: "note" | "chat",
    sourceOwnership: "recorder-capture" | "user-file" | undefined,
    outputPolicy: TranscriptionOutputPolicy,
    postProcessingApplied: boolean,
  ): string {
    if (outputPolicy.cleanOutput || destination === "chat") {
      return processedText;
    }
    const includeAudio = sourceOwnership === "user-file"
      || outputPolicy.keepRecorderSource;
    const audioSection = includeAudio
      ? `\n## Audio recording\n![[${file.path}]]\n\n`
      : "";
    const header = `# Audio transcription\nSource: ${file.basename}\nTranscribed: ${new Date().toISOString()}\n\n`;
    if (postProcessingApplied) {
      return `${header}${audioSection}## Raw transcript\n${rawText}\n\n## Cleaned transcript\n${processedText}`;
    }
    return `${header}${audioSection}## Transcript\n${rawText}`;
  }

  private buildCompletionAcknowledgement(operationId: string): () => Promise<void> {
    let acknowledged = false;
    return async () => {
      if (acknowledged) return;
      await this.acknowledgeCompleted(operationId);
      acknowledged = true;
    };
  }

  private async acknowledgeCompletionBestEffort(operationId: string): Promise<void> {
    try {
      await this.acknowledgeCompleted(operationId);
    } catch (error) {
      logError(
        "TranscriptionCoordinator",
        "Could not acknowledge completed transcription recovery",
        error,
      );
    }
  }

  private async planTranscriptionOutput(
    file: TFile,
    content: string,
    titleSourceText: string,
    timestamped: boolean,
    signal: AbortSignal,
    operationId: string,
    cleanOutput: boolean,
  ): Promise<PlannedTranscriptionOutput> {
    throwIfAborted(signal);
    const titleService = TranscriptionTitleService.getInstance(this.plugin);
    const folderPath = file.path.split("/").slice(0, -1).join("/");
    const extension = timestamped ? "srt" : "md";
    const fallbackBasename = timestamped
      ? file.basename
      : titleService.buildFallbackBasename(file.basename);
    // Recovery markers are useful metadata for the rich transcript format, but
    // the clean-output contract must remain literal: only the processed text is
    // written to the note. Clean Markdown and SRT recover by exact content
    // matching instead.
    const marker = timestamped || cleanOutput
      ? null
      : `<!-- systemsculpt-transcription:${operationId} -->`;
    const storedContent = marker ? `${content.trimEnd()}\n\n${marker}\n` : content;
    const owned = marker
      ? await this.findCommittedOutput(
        folderPath,
        fallbackBasename,
        extension,
        marker,
        signal,
      )
      : await this.findExactCommittedOutput(
        folderPath,
        fallbackBasename,
        extension,
        storedContent,
        signal,
      );
    if (owned) {
      return {
        outputPath: owned.path,
        storedContent,
        receipt: createLocalCommitReceipt(owned.path, storedContent, marker),
        existing: true,
      };
    }
    const predictedBasename = timestamped
      ? fallbackBasename
      : await this.predictOutputBasename(titleService, file.basename, fallbackBasename, titleSourceText);
    const outputPath = this.findAvailableOutputPath(folderPath, predictedBasename, extension);
    return {
      outputPath,
      storedContent,
      receipt: createLocalCommitReceipt(outputPath, storedContent, marker),
      existing: false,
    };
  }

  private async findCommittedOutput(
    folderPath: string,
    fallbackBasename: string,
    extension: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<TFile | null> {
    const candidates = this.app.vault.getFiles().filter((candidate) => (
      candidate.extension === extension
      && (candidate.parent?.path ?? "") === folderPath
      && candidate.basename.startsWith(fallbackBasename)
    ));
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const existing = await this.app.vault.read(candidate);
      if (existing.includes(marker)) return candidate;
    }
    return null;
  }

  private async findExactCommittedOutput(
    folderPath: string,
    fallbackBasename: string,
    extension: string,
    content: string,
    signal: AbortSignal,
  ): Promise<TFile | null> {
    const candidates = this.app.vault.getFiles().filter((candidate) => (
      candidate.extension === extension
      && (candidate.parent?.path ?? "") === folderPath
      && candidate.basename.startsWith(fallbackBasename)
    ));
    for (const candidate of candidates) {
      throwIfAborted(signal);
      if (await this.app.vault.read(candidate) === content) return candidate;
    }
    return null;
  }

  private createManagedSource(
    file: TFile,
    signal: AbortSignal,
    sourceIdentity: string,
  ): ManagedTranscriptionSource {
    let bytesPromise: Promise<ArrayBuffer> | null = null;
    const loadBytes = (): Promise<ArrayBuffer> => {
      bytesPromise ??= this.app.vault.readBinary(file);
      return bytesPromise;
    };
    return {
      identity: sourceIdentity,
      fingerprint: async () => {
        const bytes = await loadBytes();
        throwIfAborted(signal);
        return `sha256:${await sha256HexFromArrayBuffer(bytes)}`;
      },
      load: async () => {
        const bytes = await loadBytes();
        throwIfAborted(signal);
        return {
          filename: file.name,
          contentType: MIME_TYPES[file.extension.toLowerCase()] ?? "application/octet-stream",
          bytes,
        };
      },
      release: () => {
        bytesPromise = null;
      },
    };
  }

  private unwrapCommitResult<T>(value: TranscriptionCommitResult<T>): Readonly<{ value: T; receipt?: ManagedLocalCommitReceipt }> {
    if (
      typeof value === "object"
      && value !== null
      && "value" in value
      && "receipt" in value
    ) {
      return value as Readonly<{ value: T; receipt?: ManagedLocalCommitReceipt }>;
    }
    return { value: value as T };
  }

  private async writePlannedTranscriptionOutput(
    planned: PlannedTranscriptionOutput,
    signal: AbortSignal,
  ): Promise<void> {
    if (planned.existing) return;
    throwIfAborted(signal);
    const existing = this.app.vault.getAbstractFileByPath(planned.outputPath);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (current === planned.storedContent) return;
      throw new Error("A different file claimed the transcript output path before save completed.");
    }
    await this.app.vault.create(planned.outputPath, planned.storedContent);
  }

  private async predictOutputBasename(
    titleService: TranscriptionTitleService,
    prefix: string,
    fallbackBasename: string,
    transcriptText: string,
  ): Promise<string> {
    const title = await titleService.tryGenerateTitle(transcriptText);
    return title ? titleService.buildTitledBasename(prefix, title) : fallbackBasename;
  }

  private findAvailableOutputPath(
    folderPath: string,
    basename: string,
    extension: string,
  ): string {
    const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
    const desired = join(folderPath, `${basename}.${extension}`);
    if (!this.app.vault.getAbstractFileByPath(desired)) return desired;
    for (let attempt = 2; attempt <= MAX_TRANSCRIPTION_TITLE_COLLISION_ATTEMPTS; attempt += 1) {
      const candidate = join(folderPath, `${basename} (${attempt}).${extension}`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    throw new Error("Could not allocate a unique transcript output path.");
  }

  private async recoverReceiptOutput(
    receipt: ManagedLocalCommitReceipt,
    signal: AbortSignal,
  ): Promise<RecoveredTranscriptionOutput> {
    const { file, storedContent } = await verifyLocalCommitReceipt(this.app, receipt, signal);
    return {
      outputPath: file.path,
      text: stripLocalCommitMarker(storedContent, receipt),
    };
  }

  private joinWarnings(...warnings: Array<string | undefined>): string | undefined {
    const joined = warnings
      .map((warning) => String(warning || "").trim())
      .filter((warning) => warning.length > 0);
    return joined.length > 0 ? joined.join(" ") : undefined;
  }

  private get ownerWindow(): Window {
    return window.activeDocument?.defaultView ?? window;
  }
}
