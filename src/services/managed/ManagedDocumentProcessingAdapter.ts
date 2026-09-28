import { sha256HexFromBytesPortable } from "../../utils/sha256";
import type { ManagedAdmission } from "./ManagedAdmission";
import { ManagedJobClient, ManagedJobError } from "./ManagedJobClient";
import { isRetiredManagedRecoveryRecord, ManagedJobRecoveryStore } from "./ManagedJobRecoveryStore";
import type {
  ManagedJobRecoveryRecord,
  ManagedJobStatus,
  ManagedMultipartCreateRequest,
  ManagedPendingDispatch,
  ManagedRecoveryPhase,
} from "./ManagedTypes";
import {
  isRetryableManagedJobObservationError,
  observeManagedJob,
  waitForManagedJob,
} from "./ManagedJobObservation";

const CAPABILITY = "document_processing" as const;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const UNVERIFIABLE_SOURCE_MESSAGE = "The document changed or its preserved source cannot be verified; automatic retry is unavailable.";
const LEGACY_OPERATION_NOTICE = "An unfinished conversion from an earlier SystemSculpt version could not be checked against this file, so a new conversion was started.";
/** How far an operation got; operations that cannot continue rank last. */
const PHASE_PROGRESS: Partial<Record<ManagedRecoveryPhase, number>> = {
  admitted: 0, content_ready: 1, create_dispatching: 2, created: 3, part_dispatching: 4, uploading: 4,
  complete_dispatching: 5, upload_completed: 6, start_dispatching: 7, processing: 8, result_ready: 9, local_commit_pending: 10,
};

export type ManagedDocumentProcessingContext = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: number, status: string) => void;
  /** Explains a recovery decision the caller did not request, such as a replacement conversion. */
  onNotice?: (message: string) => void;
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
  "createAdmitted" | "read" | "readOptional" | "findSourceIdentityMatches" | "markContentReady" |
  "markLocalCommitPending" | "completeLocalCommit" | "beginDispatch" | "acknowledgeCreated" | "acknowledgePart" |
  "acknowledgeComplete" | "acknowledgeStarted" | "applyReconciliation" | "abandon" | "delete"
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

// Records written before byte fingerprints hashed only their path identity,
// so they cannot show which bytes their operation uploaded.
function hasPathOnlyFingerprint(record: ManagedJobRecoveryRecord): boolean {
  return record.source.fingerprint === `sha256:${sha256HexFromBytesPortable(new TextEncoder().encode(record.source.identity))}`;
}

/** The selections of one source that run or wait now, one at a time. */
type SourceQueue = {
  tail: Promise<void>;
  /** Selections running or waiting their turn. The queue ends when none are left. */
  active: number;
  /** The last result a selection of the source delivered, for the selections behind it. */
  delivered?: Readonly<{ fingerprint: string; result: ManagedDocumentProcessingResult }>;
};

/**
 * Source queues per recovery ledger. Adapters are made per chat view, but they
 * share the plugin's one ledger.
 */
const sourceQueues = new WeakMap<object, Map<string, SourceQueue>>();

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function furthestFirst(a: ManagedJobRecoveryRecord, b: ManagedJobRecoveryRecord): number {
  return (PHASE_PROGRESS[b.phase] ?? -1) - (PHASE_PROGRESS[a.phase] ?? -1)
    || (b.completedParts?.length ?? 0) - (a.completedParts?.length ?? 0);
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
    return this.processAndCommit(source, context, async (result) => result);
  }

  /**
   * Selects the conversion of the source's bytes and runs `commit` with its
   * result, both in the source's turn: one selection of a source runs at a
   * time in this Obsidian session. A selection that waited behind one that
   * delivered a result for the same bytes commits that result too, instead of
   * converting again; to find it, that selection reads its fingerprint before
   * any admission. `commit` must not select the same source, since that
   * selection would wait for the turn it runs in.
   */
  async processAndCommit<T>(
    source: ManagedDocumentSource,
    context: ManagedDocumentProcessingContext,
    commit: (result: ManagedDocumentProcessingResult) => Promise<T>,
  ): Promise<T> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    return this.inSourceTurn(source.identity, context, signal, async (queue) => {
      const delivered = queue.delivered;
      const fingerprint = delivered ? await this.readFingerprint(source, signal) : undefined;
      let result = delivered && delivered.fingerprint === fingerprint ? delivered.result : undefined;
      if (!result) {
        const selected = await this.select(source, context, signal, fingerprint);
        queue.delivered = selected;
        result = selected.result;
      }
      throwIfAborted(signal);
      return commit(result);
    });
  }

  async resume(
    operationId: string,
    context: ManagedDocumentProcessingContext & Readonly<{ source?: ManagedDocumentSource }> = {},
  ): Promise<ManagedDocumentProcessingResult> {
    const signal = context.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const { identity } = (await this.dependencies.recovery.read(CAPABILITY, operationId)).source;
    throwIfAborted(signal);
    return this.inSourceTurn(identity, context, signal, async () => {
      // A selection that ran first may have advanced the operation.
      const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
      throwIfAborted(signal);
      if (context.source) {
        const fingerprint = await context.source.fingerprint();
        throwIfAborted(signal);
        if (context.source.identity !== record.source.identity || fingerprint !== record.source.fingerprint) {
          throw new Error(UNVERIFIABLE_SOURCE_MESSAGE);
        }
      }
      return this.continueRecord(record, context.source, context, signal);
    });
  }

  /**
   * Drops every operation retained for a source its owner discarded, such as a
   * removed chat attachment. The next selection of those bytes starts over.
   * While a selection of the source runs or waits, including its commit, the
   * operations stay for it.
   */
  async discard(identity: string): Promise<void> {
    if (sourceQueues.get(this.dependencies.recovery)?.has(identity)) return;
    for (const record of await this.dependencies.recovery.findSourceIdentityMatches(CAPABILITY, identity)) {
      if (!isRetiredManagedRecoveryRecord(record)) await this.retire(record);
    }
  }

  /**
   * Runs `run` in the source's turn. A chat that selects a PDF another chat is
   * converting waits, then uses what the first one delivered or kept, instead
   * of starting or advancing its own operation. A selection that stops while
   * waiting leaves at once, and the ones behind it still wait their turn.
   */
  private async inSourceTurn<T>(
    identity: string,
    context: ManagedDocumentProcessingContext,
    signal: AbortSignal,
    run: (queue: SourceQueue) => Promise<T>,
  ): Promise<T> {
    let queues = sourceQueues.get(this.dependencies.recovery);
    if (!queues) sourceQueues.set(this.dependencies.recovery, queues = new Map());
    let queue = queues.get(identity);
    const waits = Boolean(queue);
    if (!queue) queues.set(identity, queue = { tail: Promise.resolve(), active: 0 });
    const previous = queue.tail;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    queue.tail = previous.then(() => finished);
    queue.active += 1;
    try {
      if (waits) {
        context.onProgress?.(0, "This document is already being converted. Waiting…");
        await waitForTurn(previous, signal);
      }
      return await run(queue);
    } finally {
      finish();
      queue.active -= 1;
      if (queue.active === 0 && queues.get(identity) === queue) queues.delete(identity);
    }
  }

  // Selecting a document again is how every caller retries, so recovery
  // selection stays with this owner, before another admission. The selected
  // bytes choose among the operations retained for one source: an edited
  // file starts its own operation and leaves earlier ones for their bytes.
  private async select(
    source: ManagedDocumentSource,
    context: ManagedDocumentProcessingContext,
    signal: AbortSignal,
    knownFingerprint?: string,
  ): Promise<{ fingerprint: string; result: ManagedDocumentProcessingResult }> {
    let fingerprint = knownFingerprint;
    const retained = (await this.dependencies.recovery.findSourceIdentityMatches(CAPABILITY, source.identity))
      .filter((record) => !isRetiredManagedRecoveryRecord(record));
    throwIfAborted(signal);
    if (retained.length) {
      fingerprint ??= await this.readFingerprint(source, signal);
      const exact = retained.filter((record) => record.source.fingerprint === fingerprint);
      if (exact.length) {
        // Several operations can hold the same bytes, such as ones kept by an
        // earlier version or by another device through sync. The one that got
        // furthest continues, and the rest only repeat its work. Retiring them
        // is best effort: one still advancing elsewhere can refuse, and a
        // later selection retires it.
        const [furthest, ...repeats] = [...exact].sort(furthestFirst);
        for (const record of repeats) await this.retire(record).catch(() => undefined);
        throwIfAborted(signal);
        return { fingerprint, result: await this.continueRecord(furthest, source, context, signal) };
      }
      // A record fingerprinted by its path alone cannot show which bytes its
      // operation uploaded. It must not lock the file: retire it and convert
      // the selected bytes as a new operation.
      const legacy = retained.filter(hasPathOnlyFingerprint);
      if (legacy.length) {
        for (const record of legacy) await this.retire(record);
        throwIfAborted(signal);
        context.onNotice?.(LEGACY_OPERATION_NOTICE);
      }
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

    fingerprint ??= await this.readFingerprint(source, signal);
    const operationId = this.createOperationId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("Managed document operation ID is invalid.");
    const record = await this.dependencies.recovery.createAdmitted({
      capability: CAPABILITY,
      operationId,
      source: { identity: source.identity, fingerprint },
    });
    throwIfAborted(signal);

    return { fingerprint, result: await this.continueRecord(record, source, context, signal) };
  }

  /**
   * Whether no selection can continue the operation any more, because it was
   * retired or removed, for example by another chat that gave up the same PDF.
   */
  async isRetired(operationId: string): Promise<boolean> {
    const record = await this.dependencies.recovery.readOptional(CAPABILITY, operationId);
    return !record || isRetiredManagedRecoveryRecord(record);
  }

  /** An abandoned record that could not be deleted is already ignored, and pruned at startup. */
  private async retire(record: ManagedJobRecoveryRecord): Promise<void> {
    const abandoned = await this.dependencies.recovery.abandon(CAPABILITY, record.operationId, record.revision);
    await this.dependencies.recovery.delete(CAPABILITY, abandoned.operationId, abandoned.revision).catch(() => undefined);
  }

  private async readFingerprint(source: ManagedDocumentSource, signal: AbortSignal): Promise<string> {
    const fingerprint = await source.fingerprint();
    throwIfAborted(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Managed document source fingerprint must be SHA-256.");
    return fingerprint;
  }

  private async continueRecord(
    record: ManagedJobRecoveryRecord,
    source: ManagedDocumentSource | undefined,
    context: ManagedDocumentProcessingContext,
    signal: AbortSignal,
  ): Promise<ManagedDocumentProcessingResult> {
    try {
      return await this.advance(record, source, context, signal);
    } catch (error) {
      // A document the service failed, or no longer has, can never finish.
      // Retiring it lets the next selection of these bytes start a new
      // conversion instead of replaying the same failure.
      if (error instanceof ManagedJobError) await this.retireTerminal(record.operationId, error).catch(() => undefined);
      throw error;
    }
  }

  private async retireTerminal(operationId: string, error: ManagedJobError): Promise<void> {
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    // A 404 ends only a document the service acknowledged creating.
    const terminal = error.code === "document_processing_failed" || (error.status === 404 && Boolean(record.jobId));
    if (terminal && !isRetiredManagedRecoveryRecord(record)) await this.retire(record);
  }

  private async advance(
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
      // A recorded request is replayed as sent. The selected bytes match the
      // record's fingerprint, so a copy under another name, such as a renamed
      // chat attachment, continues with the filename it was created with.
      if (createRequest.contentType !== loaded.contentType || createRequest.contentLengthBytes !== loaded.bytes.byteLength) {
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
    return this.advanceLocalCommit(operationId, ["local_commit_pending", "completed"], signal, (record) =>
      this.dependencies.recovery.markLocalCommitPending(CAPABILITY, operationId, record.revision));
  }

  async completeLocalCommit(operationId: string, signal?: AbortSignal): Promise<ManagedJobRecoveryRecord> {
    return this.advanceLocalCommit(operationId, ["completed"], signal, (record) =>
      this.dependencies.recovery.completeLocalCommit(CAPABILITY, operationId, record.revision));
  }

  /**
   * Selections of the same bytes commit one delivered result, each in its own
   * turn, and a caller can finish its commit after its turn. The first to
   * commit advances the operation, and the others find it there.
   */
  private async advanceLocalCommit(
    operationId: string,
    reached: readonly ManagedRecoveryPhase[],
    signal: AbortSignal | undefined,
    advance: (record: ManagedJobRecoveryRecord) => Promise<ManagedJobRecoveryRecord>,
  ): Promise<ManagedJobRecoveryRecord> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (signal) throwIfAborted(signal);
    if (reached.includes(record.phase)) return record;
    try {
      return await advance(record);
    } catch (error) {
      const current = await this.dependencies.recovery.read(CAPABILITY, operationId).catch(() => undefined);
      if (current && reached.includes(current.phase)) return current;
      throw error;
    }
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
      throwIfAborted(signal);
      throw error;
    }
    throw new Error("Managed document processing observation ended without a terminal status.");
  }
}
