import type { FileSource } from "../../platform/fileSource";
import { throwIfManagedAborted } from "./ManagedAbort";
import type { ManagedJobDispatch } from "./ManagedJobDispatch";
import { dispatchManagedJob } from "./ManagedJobObservation";
import type { ManagedJobRecoveryStore } from "./ManagedJobRecoveryStore";
import { MANAGED_MULTIPART_PART_LIMITS } from "./ManagedRecoveryRecordDecoder";
import type {
  ManagedJobRecoveryRecord,
  ManagedMultipartCreateRequest,
  ManagedMultipartPart,
} from "./ManagedTypes";

type MultipartProgress = (partNumber: number, state: "recovered" | "uploading" | "uploaded") => void;
type MultipartSource = Pick<FileSource, "sizeBytes" | "readSlice">;
type MultipartPlan = Readonly<{ partSizeBytes: number; totalParts: number }>;

/** Owns slice admission, replay, retry and durable part ordering for every media upload. */
export async function uploadManagedParts(options: Readonly<{
  source: MultipartSource;
  plan: MultipartPlan;
  completedParts?: readonly ManagedMultipartPart[];
  sendPart: (partNumber: number, bytes: ArrayBuffer) => Promise<ManagedMultipartPart>;
  checkpoint?: Readonly<{
    begin: (partNumber: number) => Promise<void>;
    acknowledge: (part: ManagedMultipartPart) => Promise<void>;
  }>;
  signal: AbortSignal;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onProgress?: MultipartProgress;
  sourceChangedMessage?: string;
  abortMessage?: string;
}>): Promise<ManagedMultipartPart[]> {
  const { source, plan, signal, abortMessage } = options;
  throwIfManagedAborted(signal, abortMessage);
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1
    || !Number.isSafeInteger(plan.partSizeBytes) || plan.partSizeBytes < 1
    || !Number.isSafeInteger(plan.totalParts) || plan.totalParts < 1
    || plan.totalParts !== Math.ceil(source.sizeBytes / plan.partSizeBytes)) {
    throw new Error("The service returned an inconsistent multipart upload plan.");
  }
  const parts = new Map<number, ManagedMultipartPart>();
  for (const part of options.completedParts ?? []) {
    if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > plan.totalParts
      || !part.etag.trim() || parts.has(part.partNumber)) {
      throw new Error("The multipart upload checkpoint contains invalid parts.");
    }
    parts.set(part.partNumber, part);
  }
  for (let partNumber = 1; partNumber <= plan.totalParts; partNumber += 1) {
    throwIfManagedAborted(signal, abortMessage);
    if (parts.has(partNumber)) {
      options.onProgress?.(partNumber, "recovered");
      continue;
    }
    options.onProgress?.(partNumber, "uploading");
    throwIfManagedAborted(signal, abortMessage);
    const start = (partNumber - 1) * plan.partSizeBytes;
    const end = Math.min(source.sizeBytes, start + plan.partSizeBytes);
    const bytes = await source.readSlice(start, end);
    throwIfManagedAborted(signal, abortMessage);
    if (bytes.byteLength !== end - start) {
      throw new Error(options.sourceChangedMessage ?? "The selected file changed while it was being read.");
    }
    await options.checkpoint?.begin(partNumber);
    throwIfManagedAborted(signal, abortMessage);
    const part = await dispatchManagedJob({
      send: () => options.sendPart(partNumber, bytes),
      signal,
      wait: options.wait,
    });
    throwIfManagedAborted(signal, abortMessage);
    if (part.partNumber !== partNumber || !part.etag.trim()) {
      throw new Error("The service acknowledged a different multipart upload part.");
    }
    await options.checkpoint?.acknowledge(part);
    throwIfManagedAborted(signal, abortMessage);
    parts.set(partNumber, part);
    options.onProgress?.(partNumber, "uploaded");
  }
  throwIfManagedAborted(signal, abortMessage);
  return [...parts.values()].sort((left, right) => left.partNumber - right.partNumber);
}

type LedgerCapability = "transcription" | "document_processing";

/** The upload phases a ledger record passes through before `upload_completed`. */
export const MANAGED_UPLOAD_PHASES: readonly ManagedJobRecoveryRecord["phase"][] = [
  "content_ready", "create_dispatching", "created", "part_dispatching", "uploading", "complete_dispatching",
];

export type ManagedRecoveryUploadProgress =
  | Readonly<{ stage: "create"; resumed: boolean }>
  | Readonly<{ stage: "part"; partNumber: number; totalParts: number }>
  | Readonly<{ stage: "complete"; resumed: boolean }>;

/**
 * Drives one ledger-backed upload from `content_ready` to `upload_completed`:
 * create, bounded parts and completion, each persisted before transport so an
 * interrupted upload resumes from its record. Source bytes are loaded only
 * while parts remain to send.
 */
export async function completeManagedRecoveryUpload<Source extends MultipartSource>(options: Readonly<{
  record: ManagedJobRecoveryRecord;
  loadSource: () => Promise<Source>;
  /** The create request for a record that has not dispatched one yet. */
  createRequest: (source: Source) => ManagedMultipartCreateRequest;
  jobs: Readonly<{
    create: (request: ManagedMultipartCreateRequest, operationId: string, signal: AbortSignal) => Promise<unknown>;
    uploadPart: (jobId: string, partNumber: number, bytes: ArrayBuffer, signal: AbortSignal) => Promise<ManagedMultipartPart>;
    complete: (jobId: string, parts: ManagedMultipartPart[], operationId: string, signal: AbortSignal) => Promise<unknown>;
  }>;
  dispatch: ManagedJobDispatch;
  recovery: Pick<ManagedJobRecoveryStore, "acknowledgeCreated" | "acknowledgePart" | "acknowledgeComplete">;
  signal: AbortSignal;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onProgress?: (progress: ManagedRecoveryUploadProgress) => void;
  sourceChangedMessage: string;
}>): Promise<ManagedJobRecoveryRecord> {
  const { signal, wait, dispatch, recovery, jobs } = options;
  let record = options.record;
  const capability = ledgerCapability(record);
  const abortMessage = cancelledMessage(capability);
  const checkAbort = (): void => throwIfManagedAborted(signal, abortMessage);
  if (record.phase === "upload_completed") return record;
  if (!MANAGED_UPLOAD_PHASES.includes(record.phase)) {
    throw new Error(`The upload cannot continue from ${record.phase}.`);
  }

  if (record.phase !== "complete_dispatching") {
    const source = await options.loadSource();
    checkAbort();
    const createRequest = record.pendingDispatch?.createRequest
      ?? record.multipartUpload?.createRequest
      ?? options.createRequest(source);
    if (createRequest.contentLengthBytes !== source.sizeBytes) throw new Error(options.sourceChangedMessage);

    if (record.phase === "content_ready" || record.phase === "create_dispatching") {
      const resumed = record.phase === "create_dispatching";
      options.onProgress?.({ stage: "create", resumed });
      if (!resumed) {
        record = await dispatch.begin(record, "create", undefined, createRequest);
        checkAbort();
      }
      const created = readCreatedUpload(capability, await dispatchManagedJob({
        send: () => jobs.create(createRequest, record.operationId, signal),
        signal,
        wait,
      }));
      checkAbort();
      if (created.totalParts !== Math.ceil(source.sizeBytes / created.partSizeBytes)) {
        throw new Error("The service returned an inconsistent multipart upload plan.");
      }
      record = await recovery.acknowledgeCreated(capability, record.operationId, record.revision, created.jobId, {
        createRequest,
        partSizeBytes: created.partSizeBytes,
        totalParts: created.totalParts,
      });
      checkAbort();
    }

    const jobId = record.jobId;
    if (!jobId) throw new Error("The managed upload has no acknowledged job ID.");
    if (!record.multipartUpload) {
      throw new Error("This upload cannot resume safely because its persisted upload metadata is missing.");
    }
    const totalParts = record.multipartUpload.totalParts;
    record = await uploadManagedRecoveryParts({
      record,
      source,
      dispatch,
      recovery,
      sendPart: (partNumber, bytes) => jobs.uploadPart(jobId, partNumber, bytes, signal),
      signal,
      wait,
      sourceChangedMessage: options.sourceChangedMessage,
      onProgress: (partNumber, state) => {
        if (state === "uploaded") options.onProgress?.({ stage: "part", partNumber, totalParts });
      },
    });
    checkAbort();
    record = await dispatch.begin(record, "complete");
    checkAbort();
  } else {
    options.onProgress?.({ stage: "complete", resumed: true });
  }

  const jobId = record.jobId;
  const completedParts = record.completedParts;
  if (!jobId || !completedParts?.length) {
    throw new Error("The upload cannot be completed without acknowledged parts.");
  }
  await dispatchManagedJob({
    send: () => jobs.complete(jobId, completedParts, record.operationId, signal),
    signal,
    wait,
  });
  checkAbort();
  record = await recovery.acknowledgeComplete(capability, record.operationId, record.revision);
  checkAbort();
  return record;
}

function ledgerCapability(record: ManagedJobRecoveryRecord): LedgerCapability {
  if (record.capability !== "transcription" && record.capability !== "document_processing") {
    throw new Error("The managed upload has no acknowledged multipart metadata.");
  }
  return record.capability;
}

function cancelledMessage(capability: LedgerCapability): string {
  return capability === "transcription"
    ? "Transcription was cancelled locally."
    : "Document conversion was cancelled locally.";
}

/** Reads the job identity and part layout from a validated create response. */
function readCreatedUpload(
  capability: LedgerCapability,
  value: unknown,
): Readonly<{ jobId: string; partSizeBytes: number; totalParts: number }> {
  const response = value as {
    job?: { id?: unknown };
    document?: { id?: unknown };
    upload?: { part_size_bytes?: unknown; total_parts?: unknown };
  } | null;
  const jobId = capability === "transcription" ? response?.job?.id : response?.document?.id;
  const partSizeBytes = response?.upload?.part_size_bytes;
  const totalParts = response?.upload?.total_parts;
  if (typeof jobId !== "string" || !jobId) {
    throw new Error("The service did not return an upload job ID.");
  }
  if (!Number.isSafeInteger(partSizeBytes) || (partSizeBytes as number) < 1
    || !Number.isSafeInteger(totalParts) || (totalParts as number) < 1
    || (totalParts as number) > MANAGED_MULTIPART_PART_LIMITS[capability]) {
    throw new Error("The service returned invalid multipart upload metadata.");
  }
  return { jobId, partSizeBytes: partSizeBytes as number, totalParts: totalParts as number };
}

/** Ledger-backed uploads retain their exact pending dispatch and revision on reconnect. */
async function uploadManagedRecoveryParts(options: Readonly<{
  record: ManagedJobRecoveryRecord;
  source: MultipartSource;
  dispatch: ManagedJobDispatch;
  recovery: Pick<ManagedJobRecoveryStore, "acknowledgePart">;
  sendPart: (partNumber: number, bytes: ArrayBuffer) => Promise<ManagedMultipartPart>;
  signal: AbortSignal;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onProgress?: MultipartProgress;
  sourceChangedMessage?: string;
}>): Promise<ManagedJobRecoveryRecord> {
  let record = options.record;
  const plan = record.multipartUpload;
  const capability = ledgerCapability(record);
  if (!plan) throw new Error("The managed upload has no acknowledged multipart metadata.");
  await uploadManagedParts({
    ...options,
    abortMessage: cancelledMessage(capability),
    plan,
    completedParts: record.completedParts,
    checkpoint: {
      begin: async (partNumber) => {
        if (record.phase === "part_dispatching") {
          if (record.pendingDispatch?.partNumber !== partNumber) {
            throw new Error("The pending upload part does not match the next unacknowledged part.");
          }
        } else {
          record = await options.dispatch.begin(record, "part", partNumber);
        }
      },
      acknowledge: async (part) => {
        record = await options.recovery.acknowledgePart(capability, record.operationId, record.revision, part);
      },
    },
  });
  return record;
}
