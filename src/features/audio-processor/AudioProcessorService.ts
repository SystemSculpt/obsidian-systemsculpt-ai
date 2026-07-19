import { TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { PendingAudioProcessorUploadSource } from "../../types";
import {
  AudioProcessorApiClient,
  AudioProcessorApiError,
  type AudioProcessorRemoteUploadState,
} from "./AudioProcessorApiClient";
import { AudioProcessorDelivery } from "./AudioProcessorDelivery";
import { AudioProcessorDeviceStaging } from "./AudioProcessorDeviceStaging";
import { AudioProcessorUploadRecovery } from "./AudioProcessorUploadRecovery";
import { createVaultAudioSource } from "./audioSource";
import { sha256HexFromArrayBuffer } from "../../studio/hash";
import {
  type AudioProcessorAudioSource,
  type AudioProcessorArtifactKind,
  type AudioProcessorCompletedNote,
  type AudioProcessorJob,
  type AudioProcessorProgressEvent,
  type AudioProcessorSavedArtifact,
  type AudioProcessorSource,
} from "./types";
import { requireYouTubeVideoUrl } from "./youtube";

const POLL_INTERVAL_MS = 2_000;
const RESUME_ATTEMPT_INTERVAL_MS = 15_000;
const MAX_POLL_DURATION_MS = 12 * 60 * 60 * 1_000;
const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 750;
const MAX_UPLOAD_COMPLETION_ATTEMPTS = 3;
const UPLOAD_COMPLETION_RETRY_DELAY_MS = 1_000;

export interface AudioProcessorServiceOptions {
  apiClient?: AudioProcessorApiClient;
  deviceStaging?: Pick<AudioProcessorDeviceStaging,
    | "stage"
    | "open"
    | "openForJob"
    | "hasReadyForJob"
    | "cleanupForJob"
    | "cleanupDescriptor"
    | "cleanupStale"
  >;
  pollIntervalMs?: number;
  resumeAttemptIntervalMs?: number;
  maxPollDurationMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ProcessAudioOptions {
  signal: AbortSignal;
  onProgress?: (event: AudioProcessorProgressEvent) => void;
}

export class AudioProcessorService {
  private readonly api: AudioProcessorApiClient;
  private readonly pollIntervalMs: number;
  private readonly maxPollDurationMs: number;
  private readonly resumeAttemptIntervalMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly uploadRecovery: AudioProcessorUploadRecovery;
  private deviceStaging: AudioProcessorServiceOptions["deviceStaging"] | null;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    options: AudioProcessorServiceOptions = {},
  ) {
    this.api = options.apiClient ?? new AudioProcessorApiClient({
      pluginVersion: plugin.manifest.version,
      licenseKey: () => plugin.settings.licenseKey,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.resumeAttemptIntervalMs = options.resumeAttemptIntervalMs ?? RESUME_ATTEMPT_INTERVAL_MS;
    this.maxPollDurationMs = options.maxPollDurationMs ?? MAX_POLL_DURATION_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.uploadRecovery = new AudioProcessorUploadRecovery(plugin);
    this.deviceStaging = options.deviceStaging ?? null;
  }

  async process(
    source: AudioProcessorSource,
    options: ProcessAudioOptions,
  ): Promise<AudioProcessorCompletedNote> {
    const operationId = createOperationId();
    let uploadJobId: string | null = null;
    let abortIncompleteUpload = false;
    let deviceStagingStarted = false;
    let uploadAudio = source.type === "audio" ? source.audio : null;
    const releasedAudio = new Set<AudioProcessorAudioSource>();
    const releaseAudio = (audio: AudioProcessorAudioSource | null): void => {
      if (!audio || releasedAudio.has(audio)) return;
      releasedAudio.add(audio);
      audio.release();
    };
    const releaseOriginalAudio = (): void => {
      if (source.type === "audio") releaseAudio(source.audio);
    };

    try {
      let job: AudioProcessorJob;
      if (source.type === "youtube") {
        const youtube = requireYouTubeVideoUrl(source.url);
        options.onProgress?.({
          stage: "preparing",
          progress: 0.02,
          message: "Checking the YouTube video…",
        });
        const created = await this.api.createYouTubeJob(
          youtube.url,
          `${operationId}:create`,
          options.signal,
        );
        job = created.job;
      } else {
        options.onProgress?.({
          stage: "preparing",
          progress: 0.01,
          message: "Preparing audio…",
        });
        const created = await this.api.createAudioJob({
          filename: source.audio.filename,
          contentType: source.audio.contentType,
          sizeBytes: source.audio.sizeBytes,
        }, `${operationId}:create`, options.signal);
        uploadJobId = created.job.id;
        if (created.upload) {
          abortIncompleteUpload = true;
          if (!uploadAudio?.resumeDescriptor) {
            deviceStagingStarted = true;
            options.onProgress?.({
              stage: "preparing",
              progress: 0.03,
              message: "Preparing a resumable audio upload…",
            });
            uploadAudio = await this.staging().stage(
              created.job.id,
              uploadAudio!,
              options.signal,
              (completedChunks, totalChunks) => options.onProgress?.({
                stage: "preparing",
                progress: 0.03 + (completedChunks / totalChunks) * 0.04,
                message: `Preparing resumable audio… ${completedChunks} of ${totalChunks}`,
              }),
            );
            releaseOriginalAudio();
          }
          await this.uploadRecovery.rememberStarted(created.job.id, uploadAudio, created.upload);
          const uploadedParts = await this.uploadAudio(
            created.job.id,
            uploadAudio,
            created.upload.partSizeBytes,
            created.upload.totalParts,
            options,
          );
          if (options.signal.aborted) throw abortError();
          options.onProgress?.({
            stage: "queued",
            progress: 0.36,
            message: "Handing audio to the audio service…",
          });
          // A completion request can succeed server-side even if its response
          // is lost. From this point, active-job discovery is safer than
          // cancelling work whose outcome is unknown.
          abortIncompleteUpload = false;
          job = await this.completeUploadWithRetry(
            created.job.id,
            uploadedParts,
            `${operationId}:complete`,
            options,
          );
        } else {
          job = created.job;
        }
        // Vault/device handles are no longer needed after upload completion
        // (or an audio cache hit). Release them before hours-long server work.
        releaseAudio(uploadAudio);
        releaseOriginalAudio();
      }

      const completed = job.status === "succeeded"
        ? job
        : await this.pollUntilComplete(job, operationId, options);
      await this.clearUploadRecovery(job.id);
      return await this.persistCompletedJob(completed, operationId, options, {
        recoverMovedFiles: completed.result?.artifactJobId !== completed.id,
      });
    } catch (error) {
      if (uploadJobId && abortIncompleteUpload) {
        await this.api.abortUpload(uploadJobId, `${operationId}:abort`).catch(() => undefined);
        await this.clearUploadRecovery(uploadJobId).catch(() => undefined);
        if (deviceStagingStarted) {
          await this.staging().cleanupForJob(uploadJobId).catch(() => undefined);
        }
      }
      throw normalizeAudioProcessorError(error);
    } finally {
      releaseAudio(uploadAudio);
      releaseOriginalAudio();
    }
  }

  async listActiveJobs(signal?: AbortSignal): Promise<AudioProcessorJob[]> {
    return await this.api.getActiveJobs(signal);
  }

  /**
   * Retrieves a separate artifact from a audio note's durable provenance.
   * This intentionally does not depend on the completion panel or active-job
   * discovery, so the command-palette actions keep working after a restart.
   */
  async saveArtifactForJob(
    deliveryJobId: string,
    artifactJobId: string,
    kind: AudioProcessorArtifactKind,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<AudioProcessorSavedArtifact> {
    const normalizedDeliveryJobId = deliveryJobId.trim();
    const normalizedJobId = artifactJobId.trim();
    if (!normalizedDeliveryJobId || !normalizedJobId) {
      throw new AudioProcessorApiError(
        "This note is missing its Audio Processor job ID.",
        0,
        "artifact_provenance_missing",
      );
    }
    return await this.saveSeparateArtifact(
      normalizedDeliveryJobId,
      normalizedJobId,
      kind,
      signal,
    );
  }

  async abortInterruptedUpload(job: Pick<AudioProcessorJob, "id" | "updatedAt">, signal?: AbortSignal): Promise<void> {
    try {
      await this.api.abortUpload(job.id, `${createOperationId()}:abort`, {
        signal,
        ifUnchangedSince: job.updatedAt,
      });
      await this.clearUploadRecovery(job.id);
      // A crash can leave a fully staged device source before its settings
      // checkpoint is committed. Abort owns deterministic job cleanup too.
      await this.staging().cleanupForJob(job.id);
    } catch (error) {
      throw normalizeAudioProcessorError(error);
    }
  }

  async hasUploadRecovery(jobId: string): Promise<boolean> {
    if (await this.uploadRecovery.get(jobId)) return true;
    if (await this.staging().hasReadyForJob(jobId)) return true;
    try {
      const remote = await this.api.getUploadParts(jobId);
      return remote.objectCompleted;
    } catch {
      return false;
    }
  }

  async clearUploadRecovery(jobId: string): Promise<void> {
    const checkpoint = await this.uploadRecovery.get(jobId);
    await this.uploadRecovery.forget(jobId);
    if (checkpoint?.source.kind === "staged") {
      await this.staging().cleanupDescriptor(checkpoint.source);
    }
  }

  async cleanupStaleStaging(activeUploadJobIds: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.staging().cleanupStale(activeUploadJobIds, signal);
  }

  async resume(
    job: AudioProcessorJob,
    options: ProcessAudioOptions,
    recovery: Readonly<{ resumeAwaitingFundsOnce?: boolean }> = {},
  ): Promise<AudioProcessorCompletedNote> {
    const operationId = createOperationId();
    const completed = job.status === "succeeded"
      ? job
      : await this.pollUntilComplete(job, operationId, options, recovery);
    return await this.persistCompletedJob(completed, operationId, options, {
      recoverMovedFiles: true,
    });
  }

  async resumeUpload(
    job: Pick<AudioProcessorJob, "id">,
    options: ProcessAudioOptions,
  ): Promise<AudioProcessorCompletedNote> {
    const checkpoint = await this.uploadRecovery.get(job.id);
    const operationId = createOperationId();
    const remoteUploadState = await this.loadAuthoritativeUploadState(job.id, options.signal);
    let source: AudioProcessorAudioSource | null = null;
    try {
      if (remoteUploadState) {
        await this.uploadRecovery.rememberAuthoritativeState(job.id, {
          partSizeBytes: remoteUploadState.partSizeBytes,
          totalParts: remoteUploadState.totalParts,
          parts: remoteUploadState.parts,
        });
        if (remoteUploadState.objectCompleted) {
          options.onProgress?.({
            stage: "queued",
            progress: 0.36,
            message: "Confirming uploaded audio…",
          });
          const finalized = await this.completeUploadWithRetry(
            job.id,
            remoteUploadState.parts.map((part) => ({
              part_number: part.part_number,
              etag: part.etag,
            })),
            `${operationId}:complete`,
            options,
          );
          const completed = finalized.status === "succeeded"
            ? finalized
            : await this.pollUntilComplete(finalized, operationId, options);
          return await this.persistCompletedJob(completed, operationId, options, {
            recoverMovedFiles: true,
          });
        }
      }

      try {
        source = checkpoint
          ? await this.restoreUploadSource(checkpoint)
          : await this.staging().openForJob(job.id, options.signal);
      } catch (error) {
        if (checkpoint) await this.uploadRecovery.forget(checkpoint.jobId).catch(() => undefined);
        throw error;
      }
      if (!source) {
        throw new AudioProcessorApiError(
          "This upload cannot resume automatically anymore.",
          0,
          "upload_recovery_missing",
        );
      }
      if (!remoteUploadState && !checkpoint) {
        throw new AudioProcessorApiError(
          "The server upload state is unavailable, so this staged upload cannot resume safely yet.",
          0,
          "upload_recovery_state_unavailable",
        );
      }
      const authoritativeUploadState = remoteUploadState ?? {
        objectCompleted: false,
        partSizeBytes: checkpoint!.partSizeBytes,
        totalParts: checkpoint!.totalParts,
        parts: checkpoint!.uploadedParts.map((part) => ({
          part_number: part.partNumber,
          etag: part.etag,
          size_bytes: checkpoint!.partSizeBytes,
        })),
      };
      if (!checkpoint) {
        await this.uploadRecovery.rememberStarted(job.id, source, authoritativeUploadState);
      }
      const uploadedParts = await this.uploadAudio(
        job.id,
        source,
        authoritativeUploadState.partSizeBytes,
        authoritativeUploadState.totalParts,
        options,
        authoritativeUploadState.parts.map((part) => ({
          part_number: part.part_number,
          etag: part.etag,
        })),
      );
      if (options.signal.aborted) throw abortError();
      options.onProgress?.({
        stage: "queued",
        progress: 0.36,
        message: "Handing audio to the audio service…",
      });
      const resumed = await this.completeUploadWithRetry(
        job.id,
        uploadedParts,
        `${operationId}:complete`,
        options,
      );
      const completed = resumed.status === "succeeded"
        ? resumed
        : await this.pollUntilComplete(resumed, operationId, options);
      return await this.persistCompletedJob(completed, operationId, options, {
        recoverMovedFiles: true,
      });
    } finally {
      // `source` is only created when additional bytes must be uploaded.
      // Completed objects can finalize without reopening the local source.
      source?.release();
    }
  }

  private async loadAuthoritativeUploadState(
    jobId: string,
    signal: AbortSignal,
  ): Promise<AudioProcessorRemoteUploadState | null> {
    try {
      return await this.api.getUploadParts(jobId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      this.plugin.getLogger().warn("Audio upload part reconciliation fell back to local checkpoint", {
        source: "AudioProcessorService",
        metadata: {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  }

  private async uploadAudio(
    jobId: string,
    source: AudioProcessorAudioSource,
    partSizeBytes: number,
    totalParts: number,
    options: ProcessAudioOptions,
    recoveredParts: ReadonlyArray<{ part_number: number; etag: string }> = [],
  ): Promise<Array<{ part_number: number; etag: string }>> {
    const expectedParts = Math.ceil(source.sizeBytes / partSizeBytes);
    if (expectedParts !== totalParts) {
      throw new Error("The audio service returned an inconsistent upload plan.");
    }

    const uploadedPartMap = new Map<number, { part_number: number; etag: string }>();
    for (const part of recoveredParts) uploadedPartMap.set(part.part_number, part);
    for (let index = 0; index < totalParts; index += 1) {
      if (options.signal.aborted) throw abortError();
      const partNumber = index + 1;
      const start = index * partSizeBytes;
      const end = Math.min(source.sizeBytes, start + partSizeBytes);
      if (uploadedPartMap.has(partNumber)) {
        options.onProgress?.({
          stage: "uploading",
          progress: 0.08 + (index / totalParts) * 0.27,
          message: `Resuming audio upload… ${index + 1} of ${totalParts}`,
        });
        continue;
      }
      options.onProgress?.({
        stage: "uploading",
        progress: 0.08 + (index / totalParts) * 0.27,
        message: `Uploading audio… ${index + 1} of ${totalParts}`,
      });
      const bytes = await source.readSlice(start, end);
      if (bytes.byteLength !== end - start) {
        throw new Error("The selected audio changed during upload.");
      }
      const uploadedPart = await this.uploadPartWithRetry(
        jobId,
        partNumber,
        bytes,
        index / totalParts,
        options,
      );
      uploadedPartMap.set(partNumber, uploadedPart);
      await this.uploadRecovery.rememberPart(jobId, uploadedPart);
    }
    options.onProgress?.({ stage: "uploading", progress: 0.35, message: "Audio uploaded" });
    return Array.from(uploadedPartMap.values()).sort(
      (left, right) => left.part_number - right.part_number,
    );
  }

  private async uploadPartWithRetry(
    jobId: string,
    partNumber: number,
    bytes: ArrayBuffer,
    uploadProgress: number,
    options: ProcessAudioOptions,
  ): Promise<{ part_number: number; etag: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      if (options.signal.aborted) throw abortError();
      try {
        const signed = await this.api.getPartUrl(jobId, partNumber, options.signal);
        return await this.api.uploadPart(signed, bytes, options.signal);
      } catch (error) {
        if (options.signal.aborted) throw error;
        lastError = error;
        if (attempt === MAX_UPLOAD_ATTEMPTS) break;
        options.onProgress?.({
          stage: "uploading",
          progress: 0.08 + uploadProgress * 0.27,
          message: `Retrying audio upload… part ${partNumber}`,
        });
        await this.sleep(UPLOAD_RETRY_DELAY_MS * attempt, options.signal);
      }
    }
    throw normalizeAudioProcessorError(lastError);
  }

  private async completeUploadWithRetry(
    jobId: string,
    parts: ReadonlyArray<{ part_number: number; etag: string }>,
    operationId: string,
    options: ProcessAudioOptions,
  ): Promise<AudioProcessorJob> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_UPLOAD_COMPLETION_ATTEMPTS; attempt += 1) {
      if (options.signal.aborted) throw abortError();
      try {
        const completed = await this.api.completeUpload(jobId, parts, operationId, options.signal);
        if (completed.status !== "uploading") {
          await this.clearUploadRecovery(jobId);
        }
        return completed;
      } catch (error) {
        if (options.signal.aborted) throw error;
        lastError = error;

        // Completion is idempotent, but a lost response may mean the server
        // already advanced the job. Read back authoritative state before
        // replaying the same completion operation.
        try {
          const observed = await this.api.getJob(jobId, options.signal);
          if (observed.status !== "uploading") {
            await this.clearUploadRecovery(jobId);
            return observed;
          }
        } catch (readError) {
          if (options.signal.aborted) throw readError;
          lastError = readError;
        }

        if (attempt === MAX_UPLOAD_COMPLETION_ATTEMPTS) break;
        options.onProgress?.({
          stage: "queued",
          progress: 0.36,
          message: "Confirming audio upload…",
        });
        await this.sleep(UPLOAD_COMPLETION_RETRY_DELAY_MS * attempt, options.signal);
      }
    }
    throw normalizeAudioProcessorError(lastError);
  }

  private async pollUntilComplete(
    initial: AudioProcessorJob,
    operationId: string,
    options: ProcessAudioOptions,
    recovery: Readonly<{ resumeAwaitingFundsOnce?: boolean }> = {},
  ): Promise<AudioProcessorJob> {
    const startedAt = Date.now();
    let job = initial;
    let previousStateKey: string | null = null;
    let stablePolls = 0;
    let attemptedAwaitingFundsResume = false;
    while (true) {
      if (job.status === "succeeded") {
        this.reportServerProgress(job, options);
        return job;
      }
      if (job.status === "failed") {
        if (job.transcriptArtifact) {
          this.reportServerProgress(job, options);
          return job;
        }
        throw new AudioProcessorApiError(
          job.error ?? "Audio processing failed.",
          0,
          "processing_failed",
        );
      }
      if (job.status === "expired") {
        throw new AudioProcessorApiError(
          "The audio job expired before it finished.",
          0,
          "job_expired",
        );
      }
      this.reportServerProgress(job, options);
      if (Date.now() - startedAt >= this.maxPollDurationMs) {
        throw new AudioProcessorApiError(
          "The audio is still processing. Reopen Audio Processor to resume the active job.",
          0,
          "poll_timeout",
        );
      }
      if (
        job.status === "awaiting_funds"
        && recovery.resumeAwaitingFundsOnce
        && job.resumeRequired
        && !attemptedAwaitingFundsResume
      ) {
        attemptedAwaitingFundsResume = true;
        job = await this.api.resumeJob(
          job.id,
          `${operationId}:resume`,
          options.signal,
        );
        previousStateKey = null;
        stablePolls = 0;
        continue;
      }
      const stateKey = `${job.status}:${job.stage}`;
      stablePolls = stateKey === previousStateKey ? stablePolls + 1 : 0;
      previousStateKey = stateKey;
      const delay = this.nextPollDelay(job, stablePolls);
      await this.sleep(delay, options.signal);
      job = await this.api.getJob(job.id, options.signal);
    }
  }

  private nextPollDelay(job: AudioProcessorJob, stablePolls: number): number {
    const base = job.status === "awaiting_funds"
      ? this.resumeAttemptIntervalMs
      : this.pollIntervalMs;
    const multiplier = job.status === "awaiting_funds" ? 2 : 1.75;
    const maxDelay = job.status === "awaiting_funds"
      ? Math.max(base, 120_000)
      : job.stage === "queued"
        ? Math.max(base, 15_000)
        : Math.max(base, 30_000);
    const growth = base * Math.pow(multiplier, stablePolls);
    return Math.max(0, Math.min(maxDelay, Math.round(growth)));
  }

  private reportServerProgress(
    job: AudioProcessorJob,
    options: ProcessAudioOptions,
  ): void {
    const messages: Record<AudioProcessorJob["stage"], string> = {
      uploading: "Receiving audio…",
      queued: "Audio queued…",
      awaiting_funds: "More credits are needed to continue",
      transcribing: "Transcribing the audio…",
      summarizing: "Writing the audio summary…",
      rendering: "Building the audio note…",
      complete: "Audio note ready",
    };
    const availableTranscript = job.transcriptArtifact
      && ["queued", "processing", "awaiting_funds"].includes(job.status)
      ? {
          filename: job.transcriptArtifact.filename,
          save: async (): Promise<AudioProcessorSavedArtifact> => await this.persistAvailableTranscript(
            job,
            options.signal,
          ),
        }
      : undefined;
    options.onProgress?.({
      stage: job.stage,
      progress: Math.max(0.36, Math.min(0.98, job.progress)),
      message: job.status === "failed" && job.transcriptArtifact
        ? "Transcript ready; summary unavailable"
        : messages[job.stage],
      serverOwned: true,
      quotedCredits: job.quotedCredits,
      chargedCredits: job.chargedCredits,
      resumeRequired: job.resumeRequired,
      availableTranscript,
    });
  }

  private async persistCompletedJob(
    job: AudioProcessorJob,
    operationId: string,
    options: ProcessAudioOptions,
    persistence: Readonly<{ recoverMovedFiles: boolean }>,
  ): Promise<AudioProcessorCompletedNote> {
    if (!job.result) {
      if (job.transcriptArtifact) {
        return await this.persistTranscriptOnlyJob(job, operationId, options, persistence);
      }
      throw new Error("The audio service completed without a note.");
    }
    options.onProgress?.({
      stage: "saving",
      progress: 0.99,
      message: "Saving audio note and transcript…",
    });

    const artifactJobId = job.result.artifactJobId;
    const delivery = new AudioProcessorDelivery(this.plugin);
    const plan = await delivery.resolvePlan(
      artifactJobId,
      job.result.filename,
      persistence,
    );
    const [note, transcript] = await Promise.all([
      plan.note.file
        ? Promise.resolve(null)
        : this.api.downloadNote(job.result.noteUrl, options.signal),
      plan.transcript.file
        ? Promise.resolve(null)
        : this.api.downloadNote(job.result.transcriptUrl, options.signal),
    ]);
    if (note != null && job.result.artifactManifest) {
      await verifyArtifactDigest(
        note,
        job.result.artifactManifest.note.sha256,
        "audio note",
      );
    }
    if (transcript != null && job.result.artifactManifest) {
      await verifyArtifactDigest(
        transcript,
        job.result.artifactManifest.transcript.sha256,
        "audio transcript",
      );
    }
    const files = await delivery.persist(
      plan,
      artifactJobId,
      { note, transcript },
      options.signal,
      { deliveryJobId: job.id },
    );

    // Delivery acknowledgement is intentionally after both Vault.create
    // promises resolve. A partial local write remains recoverable and keeps
    // the server result available for a later resume.
    await this.acknowledgeAfterLocalCommit(job.id, operationId, options.signal);
    const open = async (): Promise<void> => await this.openNote(files.note);
    let summarySave: Promise<AudioProcessorSavedArtifact> | null = null;
    const saveArtifact = async (
      kind: AudioProcessorArtifactKind,
    ): Promise<AudioProcessorSavedArtifact> => {
      if (kind === "summary") {
        summarySave ??= this.saveSeparateArtifact(
          job.id,
          artifactJobId,
          kind,
          new AbortController().signal,
        );
        try {
          return await summarySave;
        } catch (error) {
          summarySave = null;
          throw error;
        }
      }
      return {
        notePath: files.transcript.path,
        open: async (): Promise<void> => await this.openNote(files.transcript),
      };
    };
    await open();
    options.onProgress?.({
      stage: "saving",
      progress: 1,
      message: "Audio note and transcript ready",
    });
    return {
      jobId: job.id,
      notePath: files.note.path,
      transcriptPath: files.transcript.path,
      summaryAvailable: true,
      open,
      saveArtifact,
    };
  }

  private async persistTranscriptOnlyJob(
    job: AudioProcessorJob,
    operationId: string,
    options: ProcessAudioOptions,
    persistence: Readonly<{ recoverMovedFiles: boolean }>,
  ): Promise<AudioProcessorCompletedNote> {
    const artifact = job.transcriptArtifact;
    if (!artifact) throw new Error("The audio transcript is unavailable.");
    options.onProgress?.({
      stage: "saving",
      progress: 0.99,
      message: "Saving the recovered transcript…",
    });

    const delivery = new AudioProcessorDelivery(this.plugin);
    const plan = await delivery.resolvePlan(
      artifact.artifactJobId,
      stripTranscriptFilenameSuffix(artifact.filename),
      persistence,
      ["transcript"],
    );
    const markdown = plan.transcript.file
      ? null
      : await this.api.downloadNote(artifact.transcriptUrl, options.signal);
    if (markdown != null) {
      await verifyArtifactDigest(markdown, artifact.sha256, "audio transcript");
    }
    const transcript = plan.transcript.file ?? await delivery.persistOne(
      plan,
      artifact.artifactJobId,
      "transcript",
      markdown!,
      options.signal,
      { deliveryJobId: job.id, linkedArtifactAvailable: false },
    );

    await this.acknowledgeAfterLocalCommit(job.id, operationId, options.signal);
    const open = async (): Promise<void> => await this.openNote(transcript);
    const saveArtifact = async (
      kind: AudioProcessorArtifactKind,
    ): Promise<AudioProcessorSavedArtifact> => {
      if (kind === "summary") {
        throw new AudioProcessorApiError(
          "The transcript was saved, but a audio summary could not be produced.",
          0,
          "summary_unavailable",
        );
      }
      return { notePath: transcript.path, open };
    };
    await open();
    options.onProgress?.({
      stage: "saving",
      progress: 1,
      message: "Transcript saved; summary unavailable",
    });
    return {
      jobId: job.id,
      notePath: transcript.path,
      transcriptPath: transcript.path,
      summaryAvailable: false,
      open,
      saveArtifact,
    };
  }

  private async acknowledgeAfterLocalCommit(
    jobId: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.api.acknowledgeJob(jobId, `${operationId}:acknowledge`, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      this.plugin.getLogger().warn("Audio job acknowledgement deferred", {
        source: "AudioProcessorService",
        metadata: {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async persistAvailableTranscript(
    job: AudioProcessorJob,
    signal: AbortSignal,
  ): Promise<AudioProcessorSavedArtifact> {
    if (signal.aborted) throw abortError();
    const artifact = job.transcriptArtifact;
    if (!artifact) {
      throw new AudioProcessorApiError(
        "The audio transcript is not available yet.",
        0,
        "artifact_unavailable",
      );
    }
    const delivery = new AudioProcessorDelivery(this.plugin);
    const existing = delivery.findArtifact(artifact.artifactJobId, "transcript");
    if (existing) {
      return {
        notePath: existing.path,
        open: async (): Promise<void> => await this.openNote(existing),
      };
    }
    const plan = await delivery.resolvePlan(
      artifact.artifactJobId,
      stripTranscriptFilenameSuffix(artifact.filename),
      { recoverMovedFiles: true },
      ["transcript"],
    );
    const markdown = await this.api.downloadNote(artifact.transcriptUrl, signal);
    await verifyArtifactDigest(markdown, artifact.sha256, "audio transcript");
    const transcript = await delivery.persistOne(
      plan,
      artifact.artifactJobId,
      "transcript",
      markdown,
      signal,
      { deliveryJobId: job.id, linkedArtifactAvailable: false },
    );
    return {
      notePath: transcript.path,
      open: async (): Promise<void> => await this.openNote(transcript),
    };
  }

  private async saveSeparateArtifact(
    deliveryJobId: string,
    artifactJobId: string,
    kind: AudioProcessorArtifactKind,
    signal: AbortSignal,
  ): Promise<AudioProcessorSavedArtifact> {
    if (signal.aborted) throw abortError();
    const delivery = new AudioProcessorDelivery(this.plugin);
    const existing = delivery.findArtifact(artifactJobId, kind);
    if (existing) {
      return {
        notePath: existing.path,
        open: async (): Promise<void> => await this.openNote(existing),
      };
    }
    const refreshed = await this.api.getJob(deliveryJobId, signal);
    if (refreshed.status !== "succeeded" || !refreshed.result) {
      throw new AudioProcessorApiError(
        "The completed audio artifacts are not available yet.",
        0,
        "artifact_unavailable",
      );
    }
    if (refreshed.result.artifactJobId !== artifactJobId) {
      throw new AudioProcessorApiError(
        "The completed audio artifact provenance changed unexpectedly.",
        0,
        "artifact_provenance_changed",
      );
    }
    const plan = await delivery.resolvePlan(
      artifactJobId,
      refreshed.result.filename,
      { recoverMovedFiles: true },
      [kind],
    );
    const slot = kind === "summary" ? plan.summary : plan.transcript;
    if (slot.file) {
      return {
        notePath: slot.file.path,
        open: async (): Promise<void> => await this.openNote(slot.file!),
      };
    }
    const url = kind === "summary" ? refreshed.result.summaryUrl : refreshed.result.transcriptUrl;
    const markdown = await this.api.downloadNote(url, signal);
    const manifestArtifact = refreshed.result.artifactManifest?.[kind];
    if (manifestArtifact) {
      await verifyArtifactDigest(markdown, manifestArtifact.sha256, `audio ${kind}`);
    }
    const file = await delivery.persistOne(
      plan,
      artifactJobId,
      kind,
      markdown,
      signal,
      {
        deliveryJobId,
        linkedArtifactAvailable: kind === "summary"
          ? Boolean(plan.transcript.file)
          : Boolean(plan.note.file),
      },
    );
    return {
      notePath: file.path,
      open: async (): Promise<void> => await this.openNote(file),
    };
  }

  private async restoreUploadSource(
    checkpoint: Readonly<{
      source: PendingAudioProcessorUploadSource;
      sizeBytes: number;
    }>,
  ): Promise<AudioProcessorAudioSource> {
    if (checkpoint.source.kind === "staged") {
      return await this.staging().open(checkpoint.source);
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(checkpoint.source.filePath);
    if (!(file instanceof TFile)) {
      throw new AudioProcessorApiError(
        "The original vault recording is no longer available, so this upload cannot resume automatically.",
        0,
        "upload_recovery_source_missing",
      );
    }
    if (
      file.stat.size !== checkpoint.sizeBytes
      || file.stat.mtime !== checkpoint.source.modifiedAt
    ) {
      throw new AudioProcessorApiError(
        "The original vault recording changed after upload started, so automatic upload recovery was cancelled.",
        0,
        "upload_recovery_source_changed",
      );
    }
    return createVaultAudioSource(this.plugin.app, file);
  }

  private staging(): NonNullable<AudioProcessorServiceOptions["deviceStaging"]> {
    this.deviceStaging ??= new AudioProcessorDeviceStaging(this.plugin);
    return this.deviceStaging;
  }

  private async openNote(file: TFile): Promise<void> {
    const leaf = this.plugin.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}

function stripTranscriptFilenameSuffix(filename: string): string {
  return filename.replace(/\s+—\s+Transcript\.md$/i, ".md");
}

async function verifyArtifactDigest(
  markdown: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(markdown);
  const actualSha256 = await sha256HexFromArrayBuffer(bytes.buffer);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new AudioProcessorApiError(
      `The downloaded ${label} failed its integrity check. Please retry the download.`,
      0,
      "artifact_integrity_failed",
    );
  }
}

function createOperationId(): string {
  const value = window.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `audio-${value}`.slice(0, 96);
}

function normalizeAudioProcessorError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error ?? "Audio processing failed."));
}

function abortError(): DOMException {
  return new DOMException("Audio processing was cancelled.", "AbortError");
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timeout = 0;
    const abort = (): void => {
      window.clearTimeout(timeout);
      reject(abortError());
    };
    timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
