import type { ManagedAdmission } from "../managed/ManagedAdmission";
import { ManagedJobClient, ManagedJobError } from "../managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "../managed/ManagedJobRecoveryStore";
import type {
  ManagedJobRecoveryRecord,
  ManagedJobStatus,
  ManagedLocalCommitReceipt,
  ManagedMultipartCreateRequest,
  ManagedMultipartUploadDescriptor,
  ManagedPendingDispatch,
} from "../managed/ManagedTypes";

const CAPABILITY = "transcription" as const;
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 900;

export type ManagedTranscriptionContext = Readonly<{
  operationId?: string;
  timestamped?: boolean;
  language?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, status: string) => void;
  /** Persist an exact-source operation adopted from recovery before resuming it. */
  onOperationIdAdopted?: (operationId: string) => void | Promise<void>;
  maxAudioBytes?: number;
  allowPendingLocalReceipt?: boolean;
}>;

export type ManagedTranscriptionSource = Readonly<{
  /** Opaque hashed invocation identity. Must not include raw paths or filenames. */
  identity: string;
  fingerprint: () => string | Promise<string>;
  load: () => Promise<Readonly<{
    filename: string;
    contentType: string;
    bytes: ArrayBuffer;
  }>>;
  /** Drop caller-owned references as soon as multipart upload no longer needs them. */
  release?: () => void;
}>;

export type ManagedTranscriptionResult =
  | Readonly<{
      kind: "transcript";
      operationId: string;
      text: string;
    }>
  | Readonly<{
      kind: "local_receipt";
      operationId: string;
      recoveryPhase: "local_commit_pending" | "completed";
      receipt: ManagedLocalCommitReceipt;
    }>;

export type ManagedTranscriptionRetryDisposition = "restart" | "resume" | "blocked";

type TranscriptionJobs = Pick<ManagedJobClient["transcription"], "create" | "uploadPart" | "abortUpload" | "complete" | "start" | "status">;
type TranscriptionRecovery = Pick<ManagedJobRecoveryStore,
  "storageDomain" | "initialize" | "readOptional" | "findSourceIdentityMatches" | "findExactSourceMatches" |
  "createAdmitted" | "read" | "markContentReady" | "markLocalCommitPending" | "recordLocalCommitReceipt" | "recordMultipartUpload" | "completeLocalCommit" |
  "beginDispatch" | "acknowledgeCreated" | "acknowledgePart" | "acknowledgeComplete" | "acknowledgeStarted" |
  "applyReconciliation" | "abandon" | "delete"
>;

export type ManagedTranscriptionDependencies = Readonly<{
  admission: Pick<ManagedAdmission, "acquireLease">;
  jobs: TranscriptionJobs;
  recovery: TranscriptionRecovery;
  createOperationId?: () => string;
  createRequestId?: () => string;
  now?: () => string;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxPolls?: number;
}>;

function defaultOperationId(): string {
  const random = window.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `transcription-${random}`.slice(0, 128);
}

function defaultRequestId(): string {
  return window.crypto?.randomUUID?.() ?? `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

export class ManagedTranscriptionInterruptedError extends Error {
  readonly name = "AbortError";

  constructor(
    public readonly operationId: string,
    public readonly resumeAvailable: boolean,
    public readonly recoveryPhase?: ManagedJobRecoveryRecord["phase"],
    public readonly retryDisposition: ManagedTranscriptionRetryDisposition = resumeAvailable
      ? "resume"
      : "restart",
  ) {
    super(retryDisposition === "blocked"
      ? "Stopped waiting locally. The server operation was preserved, but its dispatch state is ambiguous and cannot be retried safely."
      : retryDisposition === "resume"
        ? "Stopped waiting locally. Acknowledged server work was preserved for resume."
        : "Stopped waiting locally. The unfinished upload was cancelled.");
  }
}

export class ManagedTranscriptionRetryError extends Error {
  readonly name = "ManagedTranscriptionRetryError";
  readonly resumeAvailable: boolean;

  constructor(
    public readonly operationId: string,
    public readonly retryDisposition: ManagedTranscriptionRetryDisposition,
    public readonly recoveryPhase: ManagedJobRecoveryRecord["phase"] | undefined,
    public readonly originalError: unknown,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.resumeAvailable = retryDisposition === "resume";
  }
}

class ManagedTranscriptionSourceValidationError extends Error {
  readonly name = "ManagedTranscriptionSourceValidationError";
}

export class TranscriptionResumeRequiredError extends Error {
  readonly name = "TranscriptionResumeRequiredError";
  readonly resumeAvailable = true;
  readonly retryDisposition = "resume" as const;

  constructor(
    public readonly operationId: string,
    public readonly originalError: unknown,
  ) {
    super(originalError instanceof Error
      ? originalError.message
      : String(originalError));
  }
}

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  throwIfAborted(signal);
}

function readJobId(value: unknown): string {
  const jobId = (value as { job?: { id?: unknown } })?.job?.id;
  if (typeof jobId !== "string" || !jobId) throw new Error("Managed transcription create response did not include a job ID.");
  return jobId;
}

function readUpload(value: unknown): { partSize: number; totalParts: number } {
  const upload = (value as { upload?: { part_size_bytes?: unknown; total_parts?: unknown } })?.upload;
  const partSize = upload?.part_size_bytes;
  const totalParts = upload?.total_parts;
  if (!Number.isInteger(partSize) || (partSize as number) < 1 || !Number.isInteger(totalParts) || (totalParts as number) < 1 || (totalParts as number) > 50) {
    throw new Error("Managed transcription create response included invalid multipart metadata.");
  }
  return { partSize: partSize as number, totalParts: totalParts as number };
}

export class ManagedTranscriptionAdapter {
  private static readonly activeSourceClaims = new Set<string>();
  private readonly createOperationId: () => string;
  private readonly createRequestId: () => string;
  private readonly now: () => string;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly maxPolls: number;
  private initialization: Promise<void> | null = null;

  constructor(private readonly dependencies: ManagedTranscriptionDependencies) {
    this.createOperationId = dependencies.createOperationId ?? defaultOperationId;
    this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.wait = dependencies.wait ?? defaultWait;
    this.maxPolls = dependencies.maxPolls ?? DEFAULT_MAX_POLLS;
  }

  async transcribe(source: ManagedTranscriptionSource, context: ManagedTranscriptionContext = {}): Promise<ManagedTranscriptionResult> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    await this.ensureInitialized();
    this.validateSourceIdentity(source.identity);

    const operationId = context.operationId ?? this.createOperationId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("Managed transcription operation ID is invalid.");
    let record: ManagedJobRecoveryRecord | null = null;
    let releaseSourceClaim: (() => void) | null = null;
    const releaseSource = this.createReleaseOnce(source);

    try {
      releaseSourceClaim = this.acquireSourceClaim(this.claimKey(source.identity));
      const preserved = await this.findPreservedMatch(source, signal);
      if (preserved) {
        record = preserved;
        try {
          await context.onOperationIdAdopted?.(preserved.operationId);
        } catch (error) {
          throw new ManagedTranscriptionRetryError(
            preserved.operationId,
            "resume",
            preserved.phase,
            error,
          );
        }
        throwIfAborted(signal);
        return await this.resumeRecord(preserved, source, context, signal, releaseSource);
      }

      const lease = await this.dependencies.admission.acquireLease({ alias: "systemsculpt/transcription" });
      throwIfAborted(signal);
      if (lease.outcome !== "allowed") throw new Error(`Managed transcription is unavailable (${lease.outcome}).`);
      const freshFingerprint = await this.readFingerprint(source, signal);
      record = await this.dependencies.recovery.createAdmitted({
        capability: CAPABILITY,
        operationId,
        source: { identity: source.identity, fingerprint: freshFingerprint },
      });
      throwIfAborted(signal);
      return await this.resumeRecord(record, source, context, signal, releaseSource);
    } catch (error) {
      if (!isAbortError(error)) {
        if (error instanceof ManagedTranscriptionSourceValidationError) throw error;
        if (error instanceof ManagedTranscriptionRetryError) throw error;
        throw await this.failure(record?.operationId ?? operationId, record, error);
      }
      if (error instanceof ManagedTranscriptionInterruptedError) throw error;
      throw await this.interruption(
        record?.operationId ?? operationId,
        await this.readLatestRecord(record?.operationId ?? operationId, record),
      );
    } finally {
      releaseSourceClaim?.();
      releaseSource();
    }
  }

  async resume(
    operationId: string,
    source: ManagedTranscriptionSource,
    context: ManagedTranscriptionContext = {},
  ): Promise<ManagedTranscriptionResult> {
    const signal = context.signal ?? new AbortController().signal;
    let record: ManagedJobRecoveryRecord | null = null;
    let releaseSourceClaim: (() => void) | null = null;
    const releaseSource = this.createReleaseOnce(source);
    try {
      await this.ensureInitialized();
      throwIfAborted(signal);
      record = await this.dependencies.recovery.read(CAPABILITY, operationId);
      throwIfAborted(signal);
      releaseSourceClaim = this.acquireSourceClaim(this.claimKey(record.source.identity));
      await this.validateResumeSource(record, source, signal);
      const operationBoundSource = source.identity === record.source.identity
        ? source
        : {
            identity: record.source.identity,
            fingerprint: () => source.fingerprint(),
            load: () => source.load(),
            ...(source.release ? { release: () => source.release?.() } : {}),
          };
      return await this.resumeRecord(record, operationBoundSource, context, signal, releaseSource);
    } catch (error) {
      if (!isAbortError(error)) {
        if (error instanceof ManagedTranscriptionSourceValidationError) throw error;
        if (error instanceof ManagedTranscriptionRetryError) throw error;
        throw await this.failure(operationId, record, error);
      }
      if (error instanceof ManagedTranscriptionInterruptedError) throw error;
      throw await this.interruption(
        operationId,
        await this.readLatestRecord(operationId, record),
      );
    } finally {
      releaseSourceClaim?.();
      releaseSource();
    }
  }

  async hasRecoveryOperation(operationId: string): Promise<boolean> {
    await this.ensureInitialized();
    return (await this.dependencies.recovery.readOptional(CAPABILITY, operationId)) !== null;
  }

  async beginLocalCommit(operationId: string, signal?: AbortSignal): Promise<ManagedJobRecoveryRecord> {
    await this.ensureInitialized();
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    if (record.phase === "local_commit_pending") return record;
    const pending = await this.dependencies.recovery.markLocalCommitPending(CAPABILITY, operationId, record.revision);
    if (signal) throwIfAborted(signal);
    return pending;
  }

  async recordLocalCommitReceipt(
    operationId: string,
    receipt: ManagedLocalCommitReceipt,
    signal?: AbortSignal,
  ): Promise<ManagedJobRecoveryRecord> {
    await this.ensureInitialized();
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    if (
      record.localCommitReceipt?.kind === receipt.kind
      && record.localCommitReceipt.outputPath === receipt.outputPath
      && record.localCommitReceipt.contentSha256 === receipt.contentSha256
      && record.localCommitReceipt.marker === receipt.marker
    ) {
      return record;
    }
    return this.dependencies.recovery.recordLocalCommitReceipt(
      CAPABILITY,
      operationId,
      record.revision,
      receipt,
    );
  }

  async completeLocalCommit(operationId: string, signal?: AbortSignal): Promise<ManagedJobRecoveryRecord> {
    await this.ensureInitialized();
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    return record.phase === "completed"
      ? record
      : await this.dependencies.recovery.completeLocalCommit(CAPABILITY, operationId, record.revision);
  }

  async acknowledgeCompleted(operationId: string, signal?: AbortSignal): Promise<void> {
    await this.ensureInitialized();
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.readOptional(CAPABILITY, operationId);
    if (!record) return;
    if (signal) throwIfAborted(signal);
    if (record.phase !== "completed") {
      throw new Error("Managed transcription completion can only be acknowledged after the local commit is fully complete.");
    }
    await this.dependencies.recovery.delete(CAPABILITY, operationId, record.revision);
  }

  /**
   * Studio publishes its local output atomically before cleanup. This method
   * makes the post-publication cleanup retryable across restarts and
   * idempotent when retained run logs are scanned more than once.
   */
  async finalizePublishedLocalCommit(operationId: string, signal?: AbortSignal): Promise<void> {
    await this.ensureInitialized();
    if (signal) throwIfAborted(signal);
    let record = await this.dependencies.recovery.readOptional(CAPABILITY, operationId);
    if (!record) return;
    if (signal) throwIfAborted(signal);
    if (record.phase === "local_commit_pending") {
      record = await this.dependencies.recovery.completeLocalCommit(
        CAPABILITY,
        operationId,
        record.revision,
      );
    }
    if (record.phase !== "completed") {
      throw new Error("Published Studio transcription cleanup requires a completed local commit.");
    }
    await this.dependencies.recovery.delete(CAPABILITY, operationId, record.revision);
  }

  private async beginDispatch(
    record: ManagedJobRecoveryRecord,
    operation: ManagedPendingDispatch["operation"],
    partNumber?: number,
    createRequest?: ManagedMultipartCreateRequest,
  ): Promise<ManagedJobRecoveryRecord> {
    return this.dependencies.recovery.beginDispatch(CAPABILITY, record.operationId, record.revision, {
      operation,
      requestId: this.createRequestId(),
      ...(partNumber === undefined ? {} : { partNumber }),
      ...(createRequest === undefined ? {} : { createRequest }),
      ...(["create", "complete", "start"].includes(operation) ? { idempotencyKey: `${record.operationId}:${operation}` } : {}),
      dispatchedAt: this.now(),
    });
  }

  private async interruption(
    operationId: string,
    record: ManagedJobRecoveryRecord | null,
  ): Promise<ManagedTranscriptionInterruptedError> {
    if (!record) return new ManagedTranscriptionInterruptedError(operationId, false);

    if (["admitted", "content_ready"].includes(record.phase)) {
      try {
        const abandoned = await this.dependencies.recovery.abandon(CAPABILITY, operationId, record.revision);
        await this.dependencies.recovery.delete(CAPABILITY, operationId, abandoned.revision);
      } catch {
        // No server job was acknowledged, so a new operation remains safe.
      }
      return new ManagedTranscriptionInterruptedError(operationId, false, record.phase);
    }

    if (record.phase === "upload_aborted") {
      try {
        await this.dependencies.recovery.delete(CAPABILITY, operationId, record.revision);
      } catch {
        // Best-effort pruning; the upload is already terminal.
      }
      return new ManagedTranscriptionInterruptedError(operationId, false, record.phase);
    }

    if (
      record.jobId
      && ["created", "part_dispatching", "uploading", "complete_dispatching"].includes(record.phase)
    ) {
      try {
        let aborted = await this.beginDispatch(record, "abort");
        await this.dependencies.jobs.abortUpload(record.jobId);
        aborted = await this.dependencies.recovery.applyReconciliation(
          CAPABILITY,
          operationId,
          aborted.revision,
          "failed",
        );
        try {
          await this.dependencies.recovery.delete(CAPABILITY, operationId, aborted.revision);
        } catch {
          // Best-effort pruning; a later initialization can remove it.
        }
        return new ManagedTranscriptionInterruptedError(operationId, false, aborted.phase);
      } catch {
        let preserved = record;
        try {
          preserved = await this.dependencies.recovery.read(CAPABILITY, operationId);
        } catch {
          // The last acknowledged in-memory phase is still the safest available classification.
        }
        const retryDisposition: ManagedTranscriptionRetryDisposition = [
          "complete_dispatching",
          "start_dispatching",
          "upload_completed",
          "processing",
          "result_ready",
          "local_commit_pending",
        ].includes(preserved.phase)
          ? "resume"
          : "blocked";
        return new ManagedTranscriptionInterruptedError(
          operationId,
          retryDisposition === "resume",
          preserved.phase,
          retryDisposition,
        );
      }
    }

    if (record.phase === "create_dispatching") {
      return new ManagedTranscriptionInterruptedError(operationId, true, record.phase, "resume");
    }

    if (["abort_dispatching", "blocked_ambiguous"].includes(record.phase)) {
      return new ManagedTranscriptionInterruptedError(operationId, false, record.phase, "blocked");
    }
    return new ManagedTranscriptionInterruptedError(operationId, true, record.phase, "resume");
  }

  private async failure(
    operationId: string,
    record: ManagedJobRecoveryRecord | null,
    error: unknown,
  ): Promise<Error> {
    let current = record;
    if (current) {
      try {
        current = await this.dependencies.recovery.read(CAPABILITY, operationId);
      } catch {
        // Classify from the most recent acknowledged in-memory phase.
      }
    }
    if (!current) return error instanceof Error ? error : new Error(String(error));

    const terminal = error instanceof ManagedJobError
      && (error.code === "transcription_failed" || error.code === "job_expired");
    const localCommitDurable = ["local_commit_pending", "completed"].includes(current.phase)
      || ["local_commit_pending", "completed"].includes(record?.phase ?? "");
    if (current.phase === "upload_aborted") {
      try {
        await this.dependencies.recovery.delete(CAPABILITY, operationId, current.revision);
      } catch {
        // Best-effort cleanup; the upload is already terminal.
      }
      return new ManagedTranscriptionRetryError(operationId, "restart", current.phase, error);
    }
    if ((terminal && !localCommitDurable) || ["admitted", "content_ready"].includes(current.phase)) {
      try {
        const abandoned = await this.dependencies.recovery.abandon(
          CAPABILITY,
          operationId,
          current.revision,
        );
        await this.dependencies.recovery.delete(CAPABILITY, operationId, abandoned.revision);
      } catch {
        // Terminal server work or a pre-dispatch failure is safe to retry with a fresh operation.
      }
      return new ManagedTranscriptionRetryError(
        operationId,
        "restart",
        current.phase,
        error,
      );
    }

    if (current.phase === "create_dispatching") {
      return new ManagedTranscriptionRetryError(operationId, "resume", current.phase, error);
    }

    if (
      current.jobId
      && ["created", "part_dispatching", "uploading", "complete_dispatching"].includes(current.phase)
    ) {
      const restarted = await this.tryAbortAndDelete(current);
      if (restarted) {
        return new ManagedTranscriptionRetryError(operationId, "restart", current.phase, error);
      }
      try {
        current = await this.dependencies.recovery.read(CAPABILITY, operationId);
      } catch {
        // Fall back to the last acknowledged phase below.
      }
    }

    const retryDisposition: ManagedTranscriptionRetryDisposition = [
      "create_dispatching",
      "complete_dispatching",
      "upload_completed",
      "start_dispatching",
      "processing",
      "result_ready",
      "local_commit_pending",
      "completed",
    ].includes(current.phase)
      ? "resume"
      : "blocked";
    return new ManagedTranscriptionRetryError(
      operationId,
      retryDisposition,
      current.phase,
      error,
    );
  }

  private async pollResult(record: ManagedJobRecoveryRecord, context: ManagedTranscriptionContext, signal: AbortSignal): Promise<ManagedTranscriptionResult> {
    const jobId = record.jobId;
    if (!jobId) throw new Error("Managed transcription recovery record has no acknowledged job ID.");

    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      throwIfAborted(signal);
      let status: { job: { id: string; status: ManagedJobStatus }; transcript: string | null; progress: number };
      try {
        status = await this.dependencies.jobs.status(jobId, signal) as typeof status;
        throwIfAborted(signal);
      } catch (error) {
        if (error instanceof ManagedJobError && (error.code === "transcription_failed" || error.code === "job_expired")) {
          throwIfAborted(signal);
          const terminal = error.code === "job_expired" ? "expired" : "failed";
          if (record.phase === "local_commit_pending") {
            try {
              const completed = await this.dependencies.recovery.completeLocalCommit(
                CAPABILITY,
                record.operationId,
                record.revision,
              );
              try {
                await this.dependencies.recovery.delete(
                  CAPABILITY,
                  record.operationId,
                  completed.revision,
                );
              } catch {
                // A completed record without a usable receipt is ignored by
                // exact-source recovery and pruned on initialization.
              }
              throw new ManagedTranscriptionRetryError(
                record.operationId,
                "restart",
                "local_commit_pending",
                error,
              );
            } catch (retirementError) {
              if (retirementError instanceof ManagedTranscriptionRetryError) {
                throw retirementError;
              }
              // If durable retirement itself failed, preserve the old handle
              // and let normal recovery classification require a resume.
            }
          }
          if (["complete_dispatching", "start_dispatching", "processing"].includes(record.phase)) {
            await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, terminal);
            throwIfAborted(signal);
          }
        }
        throw error;
      }
      if (status.job.id !== jobId) throw new Error("Managed transcription status returned a different job ID.");
      if (["complete_dispatching", "start_dispatching", "processing"].includes(record.phase)) {
        record = await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, status.job.status);
        throwIfAborted(signal);
        if (record.phase === "blocked_ambiguous") {
          throw new Error("Managed transcription status could not be reconciled safely.");
        }
      }
      context.onProgress?.(75 + Math.floor(Math.min(1, status.progress) * 23), "Transcribing audio…");
      if (status.job.status === "succeeded") {
        if (!["result_ready", "local_commit_pending"].includes(record.phase) || typeof status.transcript !== "string" || !status.transcript.trim()) {
          throw new Error("Managed transcription completed without a transcript.");
        }
        if (record.phase === "completed" && record.localCommitReceipt) {
          return {
            kind: "local_receipt",
            operationId: record.operationId,
            recoveryPhase: "completed",
            receipt: record.localCommitReceipt,
          };
        }
        return { kind: "transcript", operationId: record.operationId, text: status.transcript };
      }
      await this.wait(DEFAULT_POLL_INTERVAL_MS, signal);
      throwIfAborted(signal);
      if (record.phase === "result_ready") throw new Error("Managed transcription reached a terminal state without a result.");
    }
    throw new Error("Managed transcription did not complete before the polling limit.");
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.dependencies.recovery.initialize();
    await this.initialization;
  }

  private acquireSourceClaim(key: string): () => void {
    if (ManagedTranscriptionAdapter.activeSourceClaims.has(key)) {
      throw new Error("This audio is already being transcribed in the current Obsidian session.");
    }
    ManagedTranscriptionAdapter.activeSourceClaims.add(key);
    return () => {
      ManagedTranscriptionAdapter.activeSourceClaims.delete(key);
    };
  }

  private claimKey(identity: string): string {
    return `${this.dependencies.recovery.storageDomain}:${CAPABILITY}:${identity}`;
  }

  private validateSourceIdentity(identity: string): void {
    if (!/^transcription:[a-f0-9]{64}$/.test(identity)) {
      throw new Error("Managed transcription source identity must be an opaque transcription hash.");
    }
  }

  private async readFingerprint(
    source: ManagedTranscriptionSource,
    signal: AbortSignal,
  ): Promise<string> {
    const fingerprint = await source.fingerprint();
    throwIfAborted(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error("Managed transcription source fingerprint must be SHA-256.");
    }
    return fingerprint;
  }

  private async findPreservedMatch(
    source: ManagedTranscriptionSource,
    signal: AbortSignal,
  ): Promise<ManagedJobRecoveryRecord | null> {
    const identityMatches = await this.dependencies.recovery.findSourceIdentityMatches(CAPABILITY, source.identity);
    const activeIdentityMatches = identityMatches.filter((record) => !["abandoned", "upload_aborted"].includes(record.phase));
    if (!activeIdentityMatches.length) return null;
    const fingerprint = await this.readFingerprint(source, signal);
    const exactMatches = (await this.dependencies.recovery.findExactSourceMatches(CAPABILITY, {
      identity: source.identity,
      fingerprint,
    })).filter((record) => (
      !["abandoned", "upload_aborted"].includes(record.phase)
      && (record.phase !== "completed" || Boolean(record.localCommitReceipt))
    ));
    if (!exactMatches.length) return null;
    if (exactMatches.length > 1) {
      throw new Error("Multiple preserved transcription operations match this exact audio. Safe automatic resume is unavailable.");
    }
    return exactMatches[0] ?? null;
  }

  private async resumeRecord(
    initialRecord: ManagedJobRecoveryRecord,
    source: ManagedTranscriptionSource,
    context: ManagedTranscriptionContext,
    signal: AbortSignal,
    releaseSource: () => void,
  ): Promise<ManagedTranscriptionResult> {
    let record = initialRecord;
    const localReceipt = this.toLocalReceiptResult(record, context);
    if (localReceipt) return localReceipt;

    if (record.phase === "blocked_ambiguous" || record.phase === "abort_dispatching") {
      throw new Error(`Managed transcription cannot safely resume from ${record.phase}; the acknowledged dispatch is ambiguous.`);
    }

    if (record.phase === "admitted") {
      record = await this.dependencies.recovery.markContentReady(CAPABILITY, record.operationId, record.revision);
      throwIfAborted(signal);
    }

    if (
      ["content_ready", "create_dispatching", "created", "part_dispatching", "uploading", "complete_dispatching"].includes(record.phase)
    ) {
      record = await this.ensureUploadCompleted(record, source, context, signal, releaseSource);
      throwIfAborted(signal);
    }

    const localReceiptAfterUpload = this.toLocalReceiptResult(record, context);
    if (localReceiptAfterUpload) return localReceiptAfterUpload;

    if (!record.jobId) {
      throw new Error("Managed transcription recovery record has no acknowledged job ID.");
    }
    const jobId = record.jobId;
    if (record.phase === "upload_completed") {
      context.onProgress?.(72, "Resuming transcription…");
      record = await this.beginDispatch(record, "start");
      throwIfAborted(signal);
    }
    if (record.phase === "start_dispatching") {
      context.onProgress?.(72, "Resuming transcription…");
      await this.dependencies.jobs.start(jobId, record.operationId, signal);
      throwIfAborted(signal);
      record = await this.dependencies.recovery.acknowledgeStarted(CAPABILITY, record.operationId, record.revision);
      throwIfAborted(signal);
    }
    const localReceiptAfterStart = this.toLocalReceiptResult(record, context);
    if (localReceiptAfterStart) return localReceiptAfterStart;
    if (!["processing", "result_ready", "local_commit_pending", "completed"].includes(record.phase)) {
      throw new Error(`Managed transcription cannot resume from ${record.phase}.`);
    }
    return this.pollResult(record, context, signal);
  }

  private async validateResumeSource(
    record: ManagedJobRecoveryRecord,
    source: ManagedTranscriptionSource,
    signal: AbortSignal,
  ): Promise<void> {
    this.validateSourceIdentity(source.identity);
    const fingerprint = await this.readFingerprint(source, signal);
    if (fingerprint !== record.source.fingerprint) {
      throw new ManagedTranscriptionSourceValidationError(
        "This audio changed since the preserved transcription started. Start a new transcription instead of resuming.",
      );
    }
  }

  private async ensureUploadCompleted(
    initialRecord: ManagedJobRecoveryRecord,
    source: ManagedTranscriptionSource,
    context: ManagedTranscriptionContext,
    signal: AbortSignal,
    releaseSource: () => void,
  ): Promise<ManagedJobRecoveryRecord> {
    let record = initialRecord;
    if (record.phase === "upload_completed") return record;
    const loaded = await this.loadSource(source, context, signal);
    throwIfAborted(signal);

    if (record.phase === "content_ready" || record.phase === "create_dispatching") {
      const createRequest = record.pendingDispatch?.createRequest
        ?? this.buildCreateRequest(source.identity, loaded, context);
      if (record.phase === "content_ready") {
        context.onProgress?.(2, "Preparing upload…");
        record = await this.beginDispatch(record, "create", undefined, createRequest);
        throwIfAborted(signal);
      } else {
        context.onProgress?.(2, "Resuming preserved upload…");
      }

      const created = await this.dependencies.jobs.create(createRequest, record.operationId, signal);
      throwIfAborted(signal);
      const jobId = readJobId(created);
      const multipartUpload = this.buildMultipartUploadDescriptor(createRequest, readUpload(created));
      this.assertLoadedBytesMatchUpload(loaded.bytes.byteLength, multipartUpload);
      record = await this.dependencies.recovery.acknowledgeCreated(
        CAPABILITY,
        record.operationId,
        record.revision,
        jobId,
        multipartUpload,
      );
      throwIfAborted(signal);
    }

    if (["created", "part_dispatching", "uploading"].includes(record.phase)) {
      const multipartUpload = await this.requireMultipartUpload(record, loaded.bytes.byteLength);
      const jobId = record.jobId;
      if (!jobId) throw new Error("Managed transcription recovery record has no acknowledged job ID.");
      const completedParts = new Map(
        (record.completedParts ?? []).map((part) => [part.partNumber, part] as const),
      );
      for (let partNumber = 1; partNumber <= multipartUpload.totalParts; partNumber += 1) {
        if (completedParts.has(partNumber)) continue;
        throwIfAborted(signal);
        const offset = (partNumber - 1) * multipartUpload.partSizeBytes;
        const length = Math.min(multipartUpload.partSizeBytes, loaded.bytes.byteLength - offset);
        const bytes = loaded.bytes.slice(offset, offset + length);
        const replayingPendingPart = record.phase === "part_dispatching"
          && record.pendingDispatch?.partNumber === partNumber;
        if (!replayingPendingPart) {
          record = await this.beginDispatch(record, "part", partNumber);
          throwIfAborted(signal);
        }
        const part = await this.dependencies.jobs.uploadPart(jobId, partNumber, bytes, signal);
        throwIfAborted(signal);
        record = await this.dependencies.recovery.acknowledgePart(CAPABILITY, record.operationId, record.revision, part);
        throwIfAborted(signal);
        completedParts.set(part.partNumber, part);
        context.onProgress?.(
          5 + Math.floor((partNumber / multipartUpload.totalParts) * 60),
          `Uploading audio (${partNumber}/${multipartUpload.totalParts})…`,
        );
      }
    }

    if (record.phase === "complete_dispatching") {
      if (!record.completedParts?.length || !record.jobId) {
        throw new Error("Managed transcription upload completion cannot resume without acknowledged parts.");
      }
      context.onProgress?.(68, "Finalizing preserved upload…");
      await this.dependencies.jobs.complete(record.jobId, record.completedParts, record.operationId, signal);
      throwIfAborted(signal);
      record = await this.dependencies.recovery.acknowledgeComplete(CAPABILITY, record.operationId, record.revision);
      throwIfAborted(signal);
    } else if (["created", "part_dispatching", "uploading"].includes(record.phase)) {
      const resumedJobId = record.jobId;
      const completedParts = record.completedParts;
      if (!completedParts?.length || !resumedJobId) {
        throw new Error("Managed transcription upload completion cannot resume without acknowledged parts.");
      }
      throwIfAborted(signal);
      record = await this.beginDispatch(record, "complete");
      throwIfAborted(signal);
      await this.dependencies.jobs.complete(resumedJobId, completedParts, record.operationId, signal);
      throwIfAborted(signal);
      record = await this.dependencies.recovery.acknowledgeComplete(CAPABILITY, record.operationId, record.revision);
      throwIfAborted(signal);
    }

    if (record.phase === "upload_completed") {
      releaseSource();
    }
    return record;
  }

  private loadSource(
    source: ManagedTranscriptionSource,
    context: ManagedTranscriptionContext,
    signal: AbortSignal,
  ): Promise<Readonly<{
    filename: string;
    contentType: string;
    bytes: ArrayBuffer;
  }>> {
    return source.load().then((loaded) => {
      throwIfAborted(signal);
      this.validateLoadedSource(loaded, context.maxAudioBytes ?? MAX_AUDIO_BYTES);
      return loaded;
    });
  }

  private validateLoadedSource(
    loaded: Readonly<{ filename: string; contentType: string; bytes: ArrayBuffer }>,
    maxAudioBytes: number,
  ): void {
    if (!(loaded.bytes instanceof ArrayBuffer) || loaded.bytes.byteLength < 1 || loaded.bytes.byteLength > maxAudioBytes) {
      throw new Error(`Audio must contain between 1 byte and ${Math.floor(maxAudioBytes / (1024 * 1024))} MiB.`);
    }
    if (!loaded.filename || loaded.filename.length > 512 || !loaded.contentType) {
      throw new Error("Audio filename or content type is invalid.");
    }
  }

  private buildCreateRequest(
    sourceIdentity: string,
    loaded: Readonly<{ filename: string; contentType: string; bytes: ArrayBuffer }>,
    context: ManagedTranscriptionContext,
  ): ManagedMultipartCreateRequest {
    return {
      filename: this.buildOpaqueUploadFilename(sourceIdentity, loaded.contentType, loaded.filename),
      contentType: loaded.contentType,
      contentLengthBytes: loaded.bytes.byteLength,
      ...(context.timestamped === undefined ? {} : { timestamped: context.timestamped }),
      ...(context.language === undefined ? {} : { language: context.language }),
    };
  }

  private buildMultipartUploadDescriptor(
    createRequest: ManagedMultipartCreateRequest,
    upload: Readonly<{ partSize: number; totalParts: number }>,
  ): ManagedMultipartUploadDescriptor {
    return {
      createRequest,
      partSizeBytes: upload.partSize,
      totalParts: upload.totalParts,
    };
  }

  private assertLoadedBytesMatchUpload(
    byteLength: number,
    multipartUpload: ManagedMultipartUploadDescriptor,
  ): void {
    if (multipartUpload.createRequest.contentLengthBytes !== byteLength) {
      throw new Error("Managed transcription upload metadata no longer matches the audio size.");
    }
    if (multipartUpload.totalParts !== Math.ceil(byteLength / multipartUpload.partSizeBytes)) {
      throw new Error("Managed transcription multipart layout does not match the audio size.");
    }
  }

  private async requireMultipartUpload(
    record: ManagedJobRecoveryRecord,
    byteLength: number,
  ): Promise<ManagedMultipartUploadDescriptor> {
    if (!record.multipartUpload) {
      throw new Error("Managed transcription cannot safely resume this acknowledged upload because its persisted upload metadata is missing.");
    }
    this.assertLoadedBytesMatchUpload(byteLength, record.multipartUpload);
    return record.multipartUpload;
  }

  private buildOpaqueUploadFilename(
    sourceIdentity: string,
    contentType: string,
    originalFilename: string,
  ): string {
    const extension = this.extensionForContentType(contentType)
      ?? this.extensionFromFilename(originalFilename)
      ?? "bin";
    return `${sourceIdentity.slice("transcription:".length)}.${extension}`.slice(0, 255);
  }

  private extensionForContentType(contentType: string): string | null {
    const normalized = contentType.trim().toLowerCase();
    switch (normalized) {
      case "audio/wav":
      case "audio/x-wav":
        return "wav";
      case "audio/mp4":
        return "mp4";
      case "audio/webm":
        return "webm";
      case "audio/ogg":
        return "ogg";
      case "audio/mpeg":
        return "mp3";
      case "audio/flac":
        return "flac";
      default:
        return null;
    }
  }

  private extensionFromFilename(filename: string): string | null {
    const match = filename.toLowerCase().match(/\.([a-z0-9]{1,16})$/);
    return match?.[1] ?? null;
  }

  private toLocalReceiptResult(
    record: ManagedJobRecoveryRecord,
    context: ManagedTranscriptionContext,
  ): ManagedTranscriptionResult | null {
    if (!record.localCommitReceipt) return null;
    if (record.phase === "local_commit_pending" && context.allowPendingLocalReceipt === false) {
      return null;
    }
    if (record.phase !== "local_commit_pending" && record.phase !== "completed") return null;
    return {
      kind: "local_receipt",
      operationId: record.operationId,
      recoveryPhase: record.phase,
      receipt: record.localCommitReceipt,
    };
  }

  private createReleaseOnce(source: ManagedTranscriptionSource): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.safeReleaseSource(source);
    };
  }

  private safeReleaseSource(source: ManagedTranscriptionSource): void {
    try {
      source.release?.();
    } catch {
      // Releasing caller-owned buffers is best-effort.
    }
  }

  private async tryAbortAndDelete(record: ManagedJobRecoveryRecord): Promise<boolean> {
    if (!record.jobId) return false;
    try {
      let aborted = record;
      if (record.phase !== "abort_dispatching") {
        aborted = await this.beginDispatch(record, "abort");
      }
      await this.dependencies.jobs.abortUpload(record.jobId);
      aborted = await this.dependencies.recovery.applyReconciliation(
        CAPABILITY,
        record.operationId,
        aborted.revision,
        "failed",
      );
      try {
        await this.dependencies.recovery.delete(CAPABILITY, record.operationId, aborted.revision);
      } catch {
        // Best-effort pruning.
      }
      return true;
    } catch {
      return false;
    }
  }

  private async readLatestRecord(
    operationId: string,
    fallback: ManagedJobRecoveryRecord | null,
  ): Promise<ManagedJobRecoveryRecord | null> {
    try {
      return await this.dependencies.recovery.read(CAPABILITY, operationId);
    } catch {
      return fallback;
    }
  }
}
