import type { ManagedAdmission } from "../managed/ManagedAdmission";
import { ManagedJobClient, ManagedJobError } from "../managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "../managed/ManagedJobRecoveryStore";
import type { ManagedJobRecoveryRecord, ManagedJobStatus, ManagedPendingDispatch } from "../managed/ManagedTypes";

const CAPABILITY = "transcription" as const;
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 900;

export type ManagedTranscriptionContext = Readonly<{
  operationId?: string;
  timestamped?: boolean;
  language?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, status: string) => void;
}>;

export type ManagedTranscriptionSource = Readonly<{
  identity: string;
  fingerprint: () => string | Promise<string>;
  load: () => Promise<Readonly<{
    filename: string;
    contentType: string;
    bytes: ArrayBuffer;
  }>>;
}>;

export type ManagedTranscriptionResult = Readonly<{
  operationId: string;
  text: string;
}>;

type TranscriptionJobs = Pick<ManagedJobClient["transcription"], "create" | "uploadPart" | "complete" | "start" | "status">;
type TranscriptionRecovery = Pick<ManagedJobRecoveryStore,
  "createAdmitted" | "read" | "markContentReady" | "markLocalCommitPending" | "completeLocalCommit" |
  "beginDispatch" | "acknowledgeCreated" | "acknowledgePart" | "acknowledgeComplete" | "acknowledgeStarted" |
  "applyReconciliation"
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
  private readonly createOperationId: () => string;
  private readonly createRequestId: () => string;
  private readonly now: () => string;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly maxPolls: number;

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

    const lease = await this.dependencies.admission.acquireLease({ alias: "systemsculpt/transcription" });
    throwIfAborted(signal);
    if (lease.outcome !== "allowed") throw new Error(`Managed transcription is unavailable (${lease.outcome}).`);

    const fingerprint = await source.fingerprint();
    throwIfAborted(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Managed transcription source fingerprint must be SHA-256.");
    const operationId = context.operationId ?? this.createOperationId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("Managed transcription operation ID is invalid.");
    let record = await this.dependencies.recovery.createAdmitted({
      capability: CAPABILITY,
      operationId,
      source: { identity: source.identity, fingerprint },
    });
    throwIfAborted(signal);

    const loaded = await source.load();
    throwIfAborted(signal);
    if (!(loaded.bytes instanceof ArrayBuffer) || loaded.bytes.byteLength < 1 || loaded.bytes.byteLength > MAX_AUDIO_BYTES) {
      throw new Error("Audio must contain between 1 byte and 500 MB.");
    }
    if (!loaded.filename || loaded.filename.length > 512 || !loaded.contentType) {
      throw new Error("Audio filename or content type is invalid.");
    }
    record = await this.dependencies.recovery.markContentReady(CAPABILITY, operationId, record.revision);
    throwIfAborted(signal);

    context.onProgress?.(2, "Preparing upload…");
    record = await this.beginDispatch(record, "create");
    throwIfAborted(signal);
    const created = await this.dependencies.jobs.create({
      filename: loaded.filename,
      contentType: loaded.contentType,
      contentLengthBytes: loaded.bytes.byteLength,
      ...(context.timestamped === undefined ? {} : { timestamped: context.timestamped }),
      ...(context.language === undefined ? {} : { language: context.language }),
    }, operationId, signal);
    throwIfAborted(signal);
    const jobId = readJobId(created);
    const upload = readUpload(created);
    if (upload.totalParts !== Math.ceil(loaded.bytes.byteLength / upload.partSize)) {
      throw new Error("Managed transcription multipart layout does not match the audio size.");
    }
    record = await this.dependencies.recovery.acknowledgeCreated(CAPABILITY, operationId, record.revision, jobId);
    throwIfAborted(signal);

    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    for (let partNumber = 1; partNumber <= upload.totalParts; partNumber += 1) {
      throwIfAborted(signal);
      const offset = (partNumber - 1) * upload.partSize;
      const length = Math.min(upload.partSize, loaded.bytes.byteLength - offset);
      const bytes = loaded.bytes.slice(offset, offset + length);
      record = await this.beginDispatch(record, "part", partNumber);
      throwIfAborted(signal);
      const part = await this.dependencies.jobs.uploadPart(jobId, partNumber, bytes, signal);
      throwIfAborted(signal);
      record = await this.dependencies.recovery.acknowledgePart(CAPABILITY, operationId, record.revision, part);
      throwIfAborted(signal);
      completedParts.push(part);
      context.onProgress?.(5 + Math.floor((partNumber / upload.totalParts) * 60), `Uploading audio (${partNumber}/${upload.totalParts})…`);
    }

    throwIfAborted(signal);
    record = await this.beginDispatch(record, "complete");
    throwIfAborted(signal);
    await this.dependencies.jobs.complete(jobId, completedParts, operationId, signal);
    throwIfAborted(signal);
    record = await this.dependencies.recovery.acknowledgeComplete(CAPABILITY, operationId, record.revision);
    throwIfAborted(signal);

    context.onProgress?.(72, "Starting transcription…");
    record = await this.beginDispatch(record, "start");
    throwIfAborted(signal);
    await this.dependencies.jobs.start(jobId, operationId, signal);
    throwIfAborted(signal);
    record = await this.dependencies.recovery.acknowledgeStarted(CAPABILITY, operationId, record.revision);
    throwIfAborted(signal);

    return this.pollResult(record, context, signal);
  }

  async resume(operationId: string, context: ManagedTranscriptionContext = {}): Promise<ManagedTranscriptionResult> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    throwIfAborted(signal);
    if (!record.jobId || record.phase === "blocked_ambiguous" || ["create_dispatching", "part_dispatching"].includes(record.phase)) {
      throw new Error("Managed transcription dispatch is ambiguous; retry or abandon it explicitly.");
    }
    if (!["complete_dispatching", "start_dispatching", "processing", "result_ready", "local_commit_pending"].includes(record.phase)) {
      throw new Error(`Managed transcription cannot resume from ${record.phase}.`);
    }
    return this.pollResult(record, context, signal);
  }

  async beginLocalCommit(operationId: string, signal?: AbortSignal): Promise<ManagedJobRecoveryRecord> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    if (record.phase === "local_commit_pending") return record;
    const pending = await this.dependencies.recovery.markLocalCommitPending(CAPABILITY, operationId, record.revision);
    if (signal) throwIfAborted(signal);
    return pending;
  }

  async completeLocalCommit(operationId: string, signal?: AbortSignal): Promise<ManagedJobRecoveryRecord> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    if (record.phase === "completed") return record;
    const completed = await this.dependencies.recovery.completeLocalCommit(CAPABILITY, operationId, record.revision);
    if (signal) throwIfAborted(signal);
    return completed;
  }

  private async beginDispatch(record: ManagedJobRecoveryRecord, operation: ManagedPendingDispatch["operation"], partNumber?: number): Promise<ManagedJobRecoveryRecord> {
    return this.dependencies.recovery.beginDispatch(CAPABILITY, record.operationId, record.revision, {
      operation,
      requestId: this.createRequestId(),
      ...(partNumber === undefined ? {} : { partNumber }),
      ...(["create", "complete", "start"].includes(operation) ? { idempotencyKey: `${record.operationId}:${operation}` } : {}),
      dispatchedAt: this.now(),
    });
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
      }
      context.onProgress?.(75 + Math.floor(Math.min(1, status.progress) * 23), "Transcribing audio…");
      if (status.job.status === "succeeded") {
        if (!["result_ready", "local_commit_pending"].includes(record.phase) || typeof status.transcript !== "string" || !status.transcript.trim()) {
          throw new Error("Managed transcription completed without a transcript.");
        }
        return { operationId: record.operationId, text: status.transcript };
      }
      await this.wait(DEFAULT_POLL_INTERVAL_MS, signal);
      throwIfAborted(signal);
      if (record.phase === "result_ready") throw new Error("Managed transcription reached a terminal state without a result.");
    }
    throw new Error("Managed transcription did not complete before the polling limit.");
  }
}
