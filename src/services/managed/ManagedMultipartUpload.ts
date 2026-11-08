import type { FileSource } from "../../platform/fileSource";
import { throwIfManagedAborted } from "./ManagedAbort";
import type { ManagedJobDispatch } from "./ManagedJobDispatch";
import { dispatchManagedJob } from "./ManagedJobObservation";
import type { ManagedJobRecoveryStore } from "./ManagedJobRecoveryStore";
import type { ManagedJobRecoveryRecord, ManagedMultipartPart } from "./ManagedTypes";

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

/** Ledger-backed uploads retain their exact pending dispatch and revision on reconnect. */
export async function uploadManagedRecoveryParts(options: Readonly<{
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
  if (!plan || (record.capability !== "transcription" && record.capability !== "document_processing")) {
    throw new Error("The managed upload has no acknowledged multipart metadata.");
  }
  const capability = record.capability;
  await uploadManagedParts({
    ...options,
    abortMessage: capability === "transcription"
      ? "Transcription was cancelled locally."
      : "Document conversion was cancelled locally.",
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
