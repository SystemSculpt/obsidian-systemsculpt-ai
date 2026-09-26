import type { ManagedAdmission } from "./ManagedAdmission";
import { ManagedJobClient, ManagedJobError } from "./ManagedJobClient";
import { ManagedJobRecoveryStore } from "./ManagedJobRecoveryStore";
import type {
  ManagedJobRecoveryRecord,
  ManagedJobStatus,
  ManagedMultipartCreateRequest,
  ManagedPendingDispatch,
} from "./ManagedTypes";
import {
  isRetryableManagedJobObservationError,
  observeManagedJob,
  waitForManagedJob,
} from "./ManagedJobObservation";

const CAPABILITY = "document_processing" as const;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export type ManagedDocumentProcessingContext = Readonly<{
  operationId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, status: string) => void;
}>;

export type ManagedDocumentSource = Readonly<{
  identity: string;
  fingerprint: () => string | Promise<string>;
  load: () => Promise<Readonly<{
    filename: string;
    contentType: string;
    bytes: ArrayBuffer;
  }>>;
}>;

export type ManagedDocumentDownloadResult = Readonly<{
  content: unknown[];
  text: string;
  markdown: string;
  images: unknown[];
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ManagedDocumentProcessingResult = Readonly<{
  operationId: string;
  documentId: string;
  result: ManagedDocumentDownloadResult;
}>;

type DocumentJobs = Pick<ManagedJobClient["documents"], "create" | "uploadPart" | "complete" | "start" | "status" | "download">;
type DocumentRecovery = Pick<ManagedJobRecoveryStore,
  "createAdmitted" | "read" | "findSourceIdentityMatches" | "markContentReady" | "markLocalCommitPending" | "completeLocalCommit" |
  "beginDispatch" | "acknowledgeCreated" | "acknowledgePart" | "acknowledgeComplete" | "acknowledgeStarted" |
  "applyReconciliation"
>;

export type ManagedDocumentProcessingDependencies = Readonly<{
  admission: Pick<ManagedAdmission, "acquireLease">;
  jobs: DocumentJobs;
  recovery: DocumentRecovery;
  createOperationId?: () => string;
  createRequestId?: () => string;
  now?: () => string;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

function defaultOperationId(): string {
  const random = window.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `document-${random}`.slice(0, 128);
}

function defaultRequestId(): string {
  return window.crypto?.randomUUID?.() ?? `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function abortError(): DOMException {
  return new DOMException("Document conversion was cancelled locally.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function readDocumentId(value: unknown): string {
  const documentId = (value as { document?: { id?: unknown } })?.document?.id;
  if (typeof documentId !== "string" || !documentId) throw new Error("Managed document create response did not include a document ID.");
  return documentId;
}

function readUpload(value: unknown): { partSize: number; totalParts: number } {
  const upload = (value as { upload?: { part_size_bytes?: unknown; total_parts?: unknown } })?.upload;
  const partSize = upload?.part_size_bytes;
  const totalParts = upload?.total_parts;
  if (!Number.isInteger(partSize) || (partSize as number) < 1 || !Number.isInteger(totalParts) || (totalParts as number) < 1 || (totalParts as number) > 3) {
    throw new Error("Managed document create response included invalid multipart metadata.");
  }
  return { partSize: partSize as number, totalParts: totalParts as number };
}

export class ManagedDocumentProcessingAdapter {
  private readonly createOperationId: () => string;
  private readonly createRequestId: () => string;
  private readonly now: () => string;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly dependencies: ManagedDocumentProcessingDependencies) {
    this.createOperationId = dependencies.createOperationId ?? defaultOperationId;
    this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.wait = dependencies.wait ?? waitForManagedJob;
  }

  async process(source: ManagedDocumentSource, context: ManagedDocumentProcessingContext = {}): Promise<ManagedDocumentProcessingResult> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);

    // Vault callers retry by selecting the file again. Recovery selection and
    // phase transitions stay with the managed owner, before another admission.
    if (!context.operationId) {
      const matches = (await this.dependencies.recovery.findSourceIdentityMatches(CAPABILITY, source.identity))
        .filter((record) => !["completed", "abandoned", "upload_aborted"].includes(record.phase));
      throwIfAborted(signal);
      if (matches.length > 1) {
        throw new Error("Multiple preserved document operations match this file; automatic resume is unavailable.");
      }
      if (matches.length === 1) return this.resume(matches[0].operationId, { ...context, source });
    }

    const lease = await this.dependencies.admission.acquireLease({ alias: "systemsculpt/documents" }, signal)
      .catch((error: unknown) => {
        throwIfAborted(signal);
        throw error;
      });
    throwIfAborted(signal);
    if (lease.outcome !== "allowed") {
      const error = new Error(`Managed document processing is unavailable (${lease.outcome}).`);
      (error as Error & { code?: string }).code = lease.outcome;
      throw error;
    }

    const fingerprint = await source.fingerprint();
    throwIfAborted(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Managed document source fingerprint must be SHA-256.");
    const operationId = context.operationId ?? this.createOperationId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("Managed document operation ID is invalid.");
    const record = await this.dependencies.recovery.createAdmitted({
      capability: CAPABILITY,
      operationId,
      source: { identity: source.identity, fingerprint },
    });
    throwIfAborted(signal);

    return this.continueRecord(record, source, context, signal);
  }

  async resume(
    operationId: string,
    context: ManagedDocumentProcessingContext & Readonly<{ source?: ManagedDocumentSource }> = {},
  ): Promise<ManagedDocumentProcessingResult> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    throwIfAborted(signal);
    if (context.source) {
      const fingerprint = await context.source.fingerprint();
      throwIfAborted(signal);
      if (context.source.identity !== record.source.identity || fingerprint !== record.source.fingerprint) {
        throw new Error("The document changed or its preserved source cannot be verified; automatic retry is unavailable.");
      }
    }
    return this.continueRecord(record, context.source, context, signal);
  }

  private async continueRecord(
    record: ManagedJobRecoveryRecord,
    source: ManagedDocumentSource | undefined,
    context: ManagedDocumentProcessingContext,
    signal: AbortSignal,
  ): Promise<ManagedDocumentProcessingResult> {
    const operationId = record.operationId;
    if (["admitted", "content_ready", "create_dispatching", "created", "part_dispatching", "uploading"].includes(record.phase)) {
      if (!source) throw new Error("Managed document dispatch is ambiguous without the original source bytes. Retry with the original document.");
      const loaded = await source.load();
      throwIfAborted(signal);
      if (!(loaded.bytes instanceof ArrayBuffer) || loaded.bytes.byteLength < 1 || loaded.bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new Error("Document must contain between 1 byte and 25 MB.");
      }
      if (!loaded.filename || loaded.filename.length > 512 || !loaded.contentType) {
        throw new Error("Document filename or content type is invalid.");
      }
      if (record.phase === "admitted") {
        record = await this.dependencies.recovery.markContentReady(CAPABILITY, operationId, record.revision);
        throwIfAborted(signal);
      }
      const createRequest = record.pendingDispatch?.createRequest ?? record.multipartUpload?.createRequest ?? {
        filename: loaded.filename,
        contentType: loaded.contentType,
        contentLengthBytes: loaded.bytes.byteLength,
      };
      if (createRequest.filename !== loaded.filename || createRequest.contentType !== loaded.contentType
        || createRequest.contentLengthBytes !== loaded.bytes.byteLength) {
        throw new Error("The original document upload metadata does not match the retained source.");
      }
      if (record.phase === "content_ready" || record.phase === "create_dispatching") {
        context.onProgress?.(5, "Preparing document upload…");
        if (record.phase === "content_ready") {
          record = await this.beginDispatch(record, "create", undefined, createRequest);
          throwIfAborted(signal);
        }
        // Replay the recorded request with the original supported create key.
        const created = await this.dependencies.jobs.create(createRequest, operationId, signal);
        throwIfAborted(signal);
        const documentId = readDocumentId(created);
        const upload = readUpload(created);
        if (upload.totalParts !== Math.ceil(loaded.bytes.byteLength / upload.partSize)) {
          throw new Error("Managed document multipart layout does not match the document size.");
        }
        record = await this.dependencies.recovery.acknowledgeCreated(CAPABILITY, operationId, record.revision, documentId, {
          createRequest, partSizeBytes: upload.partSize, totalParts: upload.totalParts,
        });
        throwIfAborted(signal);
      }
      const upload = record.multipartUpload;
      const documentId = record.jobId;
      if (!upload || !documentId) {
        throw new Error("Managed document cannot resume this upload without its acknowledged multipart metadata.");
      }
      if (upload.totalParts !== Math.ceil(loaded.bytes.byteLength / upload.partSizeBytes)) {
        throw new Error("Managed document multipart layout does not match the document size.");
      }
      const completedParts = new Map((record.completedParts ?? []).map((part) => [part.partNumber, part]));
      for (let partNumber = 1; partNumber <= upload.totalParts; partNumber += 1) {
        if (completedParts.has(partNumber)) continue;
        throwIfAborted(signal);
        const offset = (partNumber - 1) * upload.partSizeBytes;
        const bytes = loaded.bytes.slice(offset, Math.min(offset + upload.partSizeBytes, loaded.bytes.byteLength));
        if (record.phase === "part_dispatching") {
          if (record.pendingDispatch?.partNumber !== partNumber) {
            throw new Error("Managed document pending part does not match the next unacknowledged part.");
          }
        } else {
          record = await this.beginDispatch(record, "part", partNumber);
          throwIfAborted(signal);
        }
        // A fresh signed URL targets the same document/part with the same bytes.
        const part = await this.dependencies.jobs.uploadPart(documentId, partNumber, bytes, signal);
        throwIfAborted(signal);
        record = await this.dependencies.recovery.acknowledgePart(CAPABILITY, operationId, record.revision, part);
        throwIfAborted(signal);
        completedParts.set(part.partNumber, part);
        context.onProgress?.(10 + Math.floor((partNumber / upload.totalParts) * 55), `Uploading document (${partNumber}/${upload.totalParts})…`);
      }
      record = await this.beginDispatch(record, "complete");
      throwIfAborted(signal);
    }
    if (!record.jobId || !["complete_dispatching", "upload_completed", "start_dispatching", "processing", "result_ready", "local_commit_pending"].includes(record.phase)) {
      throw new Error(`Managed document cannot resume from ${record.phase}; acknowledged processing is required.`);
    }
    const documentId = record.jobId;
    if (record.phase === "complete_dispatching") {
      if (!record.completedParts?.length) {
        throw new Error("Managed document upload completion cannot resume without acknowledged parts.");
      }
      await this.dependencies.jobs.complete(documentId, record.completedParts, operationId, signal);
      throwIfAborted(signal);
      record = await this.dependencies.recovery.acknowledgeComplete(CAPABILITY, operationId, record.revision);
      throwIfAborted(signal);
    }
    if (record.phase === "upload_completed") {
      context.onProgress?.(70, "Starting document processing…");
      record = await this.beginDispatch(record, "start");
      throwIfAborted(signal);
    }
    if (record.phase === "start_dispatching") {
      await this.dependencies.jobs.start(documentId, operationId, signal);
      throwIfAborted(signal);
      record = await this.dependencies.recovery.acknowledgeStarted(CAPABILITY, operationId, record.revision);
      throwIfAborted(signal);
    }
    return this.pollAndDownload(record, context, signal);
  }

  async beginLocalCommit(operationId: string, signal?: AbortSignal): Promise<ManagedJobRecoveryRecord> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    if (record.phase === "local_commit_pending") return record;
    return this.dependencies.recovery.markLocalCommitPending(CAPABILITY, operationId, record.revision);
  }

  async completeLocalCommit(operationId: string, signal?: AbortSignal): Promise<ManagedJobRecoveryRecord> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    if (record.phase === "completed") return record;
    return this.dependencies.recovery.completeLocalCommit(CAPABILITY, operationId, record.revision);
  }

  private beginDispatch(
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

  private async pollAndDownload(record: ManagedJobRecoveryRecord, context: ManagedDocumentProcessingContext, signal: AbortSignal): Promise<ManagedDocumentProcessingResult> {
    const documentId = record.jobId;
    if (!documentId) throw new Error("Managed document recovery record has no acknowledged document ID.");

    type DocumentStatus = {
      document: { id: string; status: ManagedJobStatus; progress: number };
      poll_after_ms?: number;
    };
    let lastProgress = 75;
    try {
      for await (const status of observeManagedJob<DocumentStatus>({
        read: async () => await this.dependencies.jobs.status(documentId, signal) as DocumentStatus,
        signal,
        pollAfterMs: value => value.poll_after_ms,
        isRetryableError: isRetryableManagedJobObservationError,
        retryAfterMs: error => (error as Partial<ManagedJobError> | null)?.retryAfterMs,
        onRetrying: () => context.onProgress?.(lastProgress, "Still waiting for the document service. Retrying…"),
        wait: this.wait,
      })) {
        if (status.document.id !== documentId) throw new Error("Managed document status returned a different document ID.");
        if (record.phase === "processing") {
          record = await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, status.document.status);
          throwIfAborted(signal);
        }
        lastProgress = 75 + Math.floor(Math.min(1, status.document.progress) * 20);
        context.onProgress?.(lastProgress, "Processing document…");
        if (status.document.status === "completed") {
          if (!["result_ready", "local_commit_pending"].includes(record.phase)) throw new Error("Managed document completion could not be reconciled.");
          const downloaded = await this.dependencies.jobs.download(documentId, signal) as { result: ManagedDocumentDownloadResult };
          throwIfAborted(signal);
          return { operationId: record.operationId, documentId, result: downloaded.result };
        }
        if (record.phase !== "processing") throw new Error("Managed document resume cannot dispatch missing upload or start work.");
      }
    } catch (error) {
      if (error instanceof ManagedJobError && error.code === "document_processing_failed" && record.phase === "processing") {
        await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, "failed");
      }
      throwIfAborted(signal);
      throw error;
    }
    throw new Error("Managed document processing observation ended without a terminal status.");
  }
}
