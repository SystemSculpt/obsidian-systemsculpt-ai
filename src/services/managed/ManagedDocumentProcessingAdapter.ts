import type { ManagedAdmission } from "./ManagedAdmission";
import { ManagedJobClient, ManagedJobError } from "./ManagedJobClient";
import { ManagedJobRecoveryStore } from "./ManagedJobRecoveryStore";
import type {
  ManagedJobRecoveryRecord,
  ManagedJobStatus,
  ManagedMultipartCreateRequest,
  ManagedPendingDispatch,
} from "./ManagedTypes";

const CAPABILITY = "document_processing" as const;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 180;

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
  "createAdmitted" | "read" | "markContentReady" | "markLocalCommitPending" | "completeLocalCommit" |
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
  maxPolls?: number;
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

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  throwIfAborted(signal);
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
  private readonly maxPolls: number;

  constructor(private readonly dependencies: ManagedDocumentProcessingDependencies) {
    this.createOperationId = dependencies.createOperationId ?? defaultOperationId;
    this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.wait = dependencies.wait ?? defaultWait;
    this.maxPolls = dependencies.maxPolls ?? DEFAULT_MAX_POLLS;
  }

  async process(source: ManagedDocumentSource, context: ManagedDocumentProcessingContext = {}): Promise<ManagedDocumentProcessingResult> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);

    const lease = await this.dependencies.admission.acquireLease({ alias: "systemsculpt/documents" });
    throwIfAborted(signal);
    if (lease.outcome !== "allowed") throw new Error(`Managed document processing is unavailable (${lease.outcome}).`);

    const fingerprint = await source.fingerprint();
    throwIfAborted(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Managed document source fingerprint must be SHA-256.");
    const operationId = context.operationId ?? this.createOperationId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("Managed document operation ID is invalid.");
    let record = await this.dependencies.recovery.createAdmitted({
      capability: CAPABILITY,
      operationId,
      source: { identity: source.identity, fingerprint },
    });
    throwIfAborted(signal);

    const loaded = await source.load();
    throwIfAborted(signal);
    if (!(loaded.bytes instanceof ArrayBuffer) || loaded.bytes.byteLength < 1 || loaded.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error("Document must contain between 1 byte and 25 MB.");
    }
    if (!loaded.filename || loaded.filename.length > 512 || !loaded.contentType) {
      throw new Error("Document filename or content type is invalid.");
    }
    record = await this.dependencies.recovery.markContentReady(CAPABILITY, operationId, record.revision);
    throwIfAborted(signal);

    context.onProgress?.(5, "Preparing document upload…");
    const createRequest: ManagedMultipartCreateRequest = {
      filename: loaded.filename,
      contentType: loaded.contentType,
      contentLengthBytes: loaded.bytes.byteLength,
    };
    record = await this.beginDispatch(record, "create", undefined, createRequest);
    throwIfAborted(signal);
    const created = await this.dependencies.jobs.create(createRequest, operationId, signal);
    throwIfAborted(signal);
    const documentId = readDocumentId(created);
    const upload = readUpload(created);
    if (upload.totalParts !== Math.ceil(loaded.bytes.byteLength / upload.partSize)) {
      throw new Error("Managed document multipart layout does not match the document size.");
    }
    record = await this.dependencies.recovery.acknowledgeCreated(
      CAPABILITY,
      operationId,
      record.revision,
      documentId,
      {
        createRequest,
        partSizeBytes: upload.partSize,
        totalParts: upload.totalParts,
      },
    );
    throwIfAborted(signal);

    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    for (let partNumber = 1; partNumber <= upload.totalParts; partNumber += 1) {
      throwIfAborted(signal);
      const offset = (partNumber - 1) * upload.partSize;
      const length = Math.min(upload.partSize, loaded.bytes.byteLength - offset);
      const bytes = loaded.bytes.slice(offset, offset + length);
      record = await this.beginDispatch(record, "part", partNumber);
      throwIfAborted(signal);
      const part = await this.dependencies.jobs.uploadPart(documentId, partNumber, bytes, signal);
      throwIfAborted(signal);
      record = await this.dependencies.recovery.acknowledgePart(CAPABILITY, operationId, record.revision, part);
      throwIfAborted(signal);
      completedParts.push(part);
      context.onProgress?.(10 + Math.floor((partNumber / upload.totalParts) * 55), `Uploading document (${partNumber}/${upload.totalParts})…`);
    }

    record = await this.beginDispatch(record, "complete");
    throwIfAborted(signal);
    await this.dependencies.jobs.complete(documentId, completedParts, operationId, signal);
    throwIfAborted(signal);
    record = await this.dependencies.recovery.acknowledgeComplete(CAPABILITY, operationId, record.revision);
    throwIfAborted(signal);

    context.onProgress?.(70, "Starting document processing…");
    record = await this.beginDispatch(record, "start");
    throwIfAborted(signal);
    await this.dependencies.jobs.start(documentId, operationId, signal);
    throwIfAborted(signal);
    record = await this.dependencies.recovery.acknowledgeStarted(CAPABILITY, operationId, record.revision);
    throwIfAborted(signal);

    return this.pollAndDownload(record, context, signal);
  }

  async resume(operationId: string, context: ManagedDocumentProcessingContext = {}): Promise<ManagedDocumentProcessingResult> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    let record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    throwIfAborted(signal);
    if (!record.jobId || ["create_dispatching", "part_dispatching"].includes(record.phase)) {
      throw new Error("Managed document dispatch is ambiguous; retry or abandon it explicitly.");
    }
    const documentId = record.jobId;
    if (!["complete_dispatching", "upload_completed", "start_dispatching", "processing", "result_ready", "local_commit_pending"].includes(record.phase)) {
      throw new Error(`Managed document cannot resume from ${record.phase}; acknowledged processing is required.`);
    }
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

    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      throwIfAborted(signal);
      let status: { document: { id: string; status: ManagedJobStatus; progress: number } };
      try {
        status = await this.dependencies.jobs.status(documentId, signal) as typeof status;
        throwIfAborted(signal);
      } catch (error) {
        if (error instanceof ManagedJobError && error.code === "document_processing_failed" && record.phase === "processing") {
          await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, "failed");
          throwIfAborted(signal);
        }
        throw error;
      }
      if (status.document.id !== documentId) throw new Error("Managed document status returned a different document ID.");
      if (record.phase === "processing") {
        record = await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, status.document.status);
        throwIfAborted(signal);
      }
      context.onProgress?.(75 + Math.floor(Math.min(1, status.document.progress) * 20), "Processing document…");
      if (status.document.status === "completed") {
        if (!["result_ready", "local_commit_pending"].includes(record.phase)) throw new Error("Managed document completion could not be reconciled.");
        const downloaded = await this.dependencies.jobs.download(documentId, signal) as { result: ManagedDocumentDownloadResult };
        throwIfAborted(signal);
        return { operationId: record.operationId, documentId, result: downloaded.result };
      }
      if (record.phase !== "processing") throw new Error("Managed document resume cannot dispatch missing upload or start work.");
      await this.wait(DEFAULT_POLL_INTERVAL_MS, signal);
      throwIfAborted(signal);
    }
    throw new Error("Managed document processing did not complete before the polling limit.");
  }
}
