import type {
  ManagedJobRecoveryRecord,
  ManagedLocalCommitReceipt,
  ManagedMediaDeliveryState,
  ManagedMultipartCreateRequest,
  ManagedMultipartUploadDescriptor,
  ManagedPendingDispatch,
  ManagedRecoveryCapability,
  ManagedRecoveryPhase,
} from "./ManagedTypes";

export class ManagedRecoveryError extends Error {
  constructor(
    public readonly code: "recovery_unavailable" | "recovery_corrupt" | "invalid_record" | "stale_revision" | "record_mismatch" | "illegal_transition" | "reconciliation_error",
    message: string,
  ) {
    super(message);
    this.name = "ManagedRecoveryError";
  }
}

type WriteJournal = {
  schemaVersion: 1;
  phase: "prepared" | "original_moved" | "promoted";
  capability: ManagedRecoveryCapability;
  operationId: string;
  fromRevision: number;
  toRevision: number;
};

export type ManagedRecoveryDeleteJournal = {
  schemaVersion: 1;
  capability: ManagedRecoveryCapability;
  operationId: string;
  revision: number;
  intent: "delete";
};

export const MANAGED_RECOVERY_CAPABILITIES: ManagedRecoveryCapability[] = [
  "transcription", "document_processing", "image_generation", "video_generation",
];

/** @internal Retained by ManagedJobRecoveryStore's compatibility export. */
export const MANAGED_MULTIPART_PART_LIMITS: Readonly<Record<ManagedRecoveryCapability, number>> = {
  transcription: 50,
  document_processing: 3,
  image_generation: 0,
  video_generation: 0,
};

const phases: ManagedRecoveryPhase[] = [
  "admitted", "content_ready", "prepare_dispatching", "prepared", "create_dispatching", "created",
  "part_dispatching", "uploading", "abort_dispatching", "upload_aborted", "complete_dispatching",
  "upload_completed", "start_dispatching", "processing", "result_ready", "local_commit_pending",
  "completed", "blocked_ambiguous", "abandoned",
];
const recordKeys = new Set([
  "schemaVersion", "revision", "capability", "operationId", "source", "jobId", "multipartUpload",
  "completedParts", "phase", "pendingDispatch", "localCommitReceipt", "mediaDelivery", "createdAt", "updatedAt",
]);
const mediaCapabilities: ManagedRecoveryCapability[] = ["image_generation", "video_generation"];
const isMediaCapability = (capability: ManagedRecoveryCapability) => mediaCapabilities.includes(capability);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Admits the persisted recovery format without normalizing or dropping fields.
 * Source metadata remains additive; the record and other nested envelopes do not.
 * Mutation policy belongs to the store, not this historical record format.
 */
export function decodeManagedRecoveryRecord(value: unknown): ManagedJobRecoveryRecord {
  const record = asRecord(value);
  if (!record) {
    throw new ManagedRecoveryError("invalid_record", "Record must be an object.");
  }

  const capability = record.capability;
  const phase = record.phase;
  if (
    Object.keys(record).some((key) => !recordKeys.has(key))
    || record.schemaVersion !== 1
    || typeof record.revision !== "number"
    || !Number.isInteger(record.revision)
    || record.revision < 1
    || typeof capability !== "string"
    || !MANAGED_RECOVERY_CAPABILITIES.includes(capability as ManagedRecoveryCapability)
    || typeof phase !== "string"
    || !phases.includes(phase as ManagedRecoveryPhase)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid recovery schema.");
  }
  const managedCapability = capability as ManagedRecoveryCapability;
  const recoveryPhase = phase as ManagedRecoveryPhase;

  const source = asRecord(record.source);
  if (
    typeof record.operationId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.operationId)
    || !source
    || typeof source.identity !== "string"
    || source.identity.length < 1
    || source.identity.length > 512
    || /(?:https?:\/\/|\b(?:authorization|credential|headers?|prompt|content)\b)/i.test(source.identity)
    || typeof source.fingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(source.fingerprint)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid source identity/fingerprint.");
  }

  if (
    typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.updatedAt !== "string"
    || !Number.isFinite(Date.parse(record.updatedAt))
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid timestamps.");
  }
  if (
    record.jobId !== undefined
    && (typeof record.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(record.jobId))
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid first-party job ID.");
  }

  const maxCompletedPart = MANAGED_MULTIPART_PART_LIMITS[managedCapability];
  if (record.completedParts !== undefined) {
    if (!Array.isArray(record.completedParts) || record.completedParts.length > maxCompletedPart) {
      throw new ManagedRecoveryError("invalid_record", "Invalid completed parts.");
    }
    const partNumbers = new Set<number>();
    for (const partValue of record.completedParts) {
      const part = asRecord(partValue);
      if (
        !part
        || Object.keys(part).sort().join() !== "etag,partNumber"
        || typeof part.partNumber !== "number"
        || !Number.isInteger(part.partNumber)
        || part.partNumber < 1
        || part.partNumber > maxCompletedPart
        || partNumbers.has(part.partNumber)
        || typeof part.etag !== "string"
        || !/^"?[A-Fa-f0-9]{8,128}(?:-[1-9][0-9]{0,9})?"?$/.test(part.etag)
        || (part.etag.startsWith('"') !== part.etag.endsWith('"'))
      ) {
        throw new ManagedRecoveryError("invalid_record", "Invalid completed parts.");
      }
      partNumbers.add(part.partNumber);
    }
  }

  if (record.multipartUpload !== undefined) {
    validateMultipartUpload(record.multipartUpload, managedCapability);
  }
  if (record.localCommitReceipt !== undefined) {
    validateLocalCommitReceipt(record.localCommitReceipt);
  }
  if (
    record.localCommitReceipt !== undefined
    && !["local_commit_pending", "completed"].includes(recoveryPhase)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Local commit receipts are only valid after remote completion.");
  }
  if (
    record.multipartUpload !== undefined
    && ![
      "created", "part_dispatching", "uploading", "complete_dispatching", "upload_completed",
      "start_dispatching", "processing", "result_ready", "local_commit_pending", "completed",
      "abort_dispatching", "upload_aborted", "blocked_ambiguous", "abandoned",
    ].includes(recoveryPhase)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Multipart upload metadata is only valid after create acknowledgement.");
  }

  const phaseOperation: Partial<Record<ManagedRecoveryPhase, ManagedPendingDispatch["operation"]>> = {
    prepare_dispatching: "prepare",
    create_dispatching: "create",
    part_dispatching: "part",
    abort_dispatching: "abort",
    complete_dispatching: "complete",
    start_dispatching: "start",
  };
  const expectedOperation = phaseOperation[recoveryPhase];
  if (expectedOperation) {
    if (record.pendingDispatch === undefined) {
      throw new ManagedRecoveryError("invalid_record", "Dispatching phase requires metadata.");
    }
    validateDispatch(record.pendingDispatch);
    const pending = record.pendingDispatch;
    if (pending.operation !== expectedOperation) {
      throw new ManagedRecoveryError("invalid_record", "Dispatch operation/phase mismatch.");
    }
    if (
      expectedOperation === "part"
        ? !Number.isInteger(pending.partNumber)
          || (pending.partNumber as number) < 1
          || (pending.partNumber as number) > MANAGED_MULTIPART_PART_LIMITS[managedCapability]
        : pending.partNumber !== undefined
    ) {
      throw new ManagedRecoveryError("invalid_record", "Dispatch part-number mismatch.");
    }
    const requiresIdem = ["create", "complete", "start"].includes(expectedOperation);
    if (
      (requiresIdem && pending.idempotencyKey !== `${record.operationId}:${expectedOperation}`)
      || (!requiresIdem && pending.idempotencyKey !== undefined)
    ) {
      throw new ManagedRecoveryError("invalid_record", "Dispatch idempotency mismatch.");
    }
  } else if (record.pendingDispatch !== undefined) {
    throw new ManagedRecoveryError("invalid_record", "Pending metadata outside dispatching phase.");
  }

  const imageForbidden: ManagedRecoveryPhase[] = [
    "part_dispatching", "uploading", "abort_dispatching", "upload_aborted",
    "complete_dispatching", "upload_completed", "start_dispatching",
  ];
  const multipartForbidden: ManagedRecoveryPhase[] = ["prepare_dispatching", "prepared"];
  if (record.mediaDelivery !== undefined) {
    validateMediaDelivery(record.mediaDelivery, managedCapability, recoveryPhase);
  }
  if (
    isMediaCapability(managedCapability)
      ? imageForbidden.includes(recoveryPhase)
      : multipartForbidden.includes(recoveryPhase)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Capability/phase mismatch.");
  }
  return value as ManagedJobRecoveryRecord;
}

function validateDispatch(value: unknown): asserts value is ManagedPendingDispatch {
  const keys = new Set(["operation", "requestId", "idempotencyKey", "partNumber", "dispatchedAt", "createRequest"]);
  const dispatch = asRecord(value);
  if (
    !dispatch
    || Object.keys(dispatch).some((key) => !keys.has(key))
    || typeof dispatch.operation !== "string"
    || !["prepare", "create", "part", "abort", "complete", "start"].includes(dispatch.operation)
    || typeof dispatch.requestId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(dispatch.requestId)
    || typeof dispatch.dispatchedAt !== "string"
    || !Number.isFinite(Date.parse(dispatch.dispatchedAt))
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid dispatch metadata.");
  }
  if (
    dispatch.idempotencyKey !== undefined
    && (
      typeof dispatch.idempotencyKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:(?:create|complete|start)$/.test(dispatch.idempotencyKey)
    )
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid idempotency key.");
  }
  if (dispatch.createRequest !== undefined) {
    validateCreateRequest(dispatch.createRequest);
  }
}

function validateCreateRequest(value: unknown): asserts value is ManagedMultipartCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedRecoveryError("invalid_record", "Invalid create request metadata.");
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.some((key) => !["filename", "contentType", "contentLengthBytes", "timestamped", "language"].includes(key))) {
    throw new ManagedRecoveryError("invalid_record", "Invalid create request metadata.");
  }
  if (typeof payload.filename !== "string" || !payload.filename.trim() || payload.filename.length > 255) {
    throw new ManagedRecoveryError("invalid_record", "Invalid create request filename.");
  }
  if (typeof payload.contentType !== "string" || !payload.contentType.trim() || payload.contentType.length > 255) {
    throw new ManagedRecoveryError("invalid_record", "Invalid create request content type.");
  }
  if (!Number.isInteger(payload.contentLengthBytes) || (payload.contentLengthBytes as number) < 1) {
    throw new ManagedRecoveryError("invalid_record", "Invalid create request byte length.");
  }
  if (payload.timestamped !== undefined && typeof payload.timestamped !== "boolean") {
    throw new ManagedRecoveryError("invalid_record", "Invalid create request timestamped flag.");
  }
  if (payload.language !== undefined && (typeof payload.language !== "string" || payload.language.length > 64)) {
    throw new ManagedRecoveryError("invalid_record", "Invalid create request language.");
  }
}

function validateMediaDelivery(
  value: unknown,
  capability: ManagedRecoveryCapability,
  phase: ManagedRecoveryPhase,
): asserts value is ManagedMediaDeliveryState {
  if (
    !isMediaCapability(capability)
    || !["result_ready", "local_commit_pending", "completed"].includes(phase)
    || !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid media delivery state.");
  }
  const delivery = value as Record<string, unknown>;
  if (Object.keys(delivery).some(key => ![
    "downloadStartedAt", "downloadCompletedOffsetMs", "displayedOffsetMs", "vaultWriteCompletedOffsetMs", "outputs",
  ].includes(key))) {
    throw new ManagedRecoveryError("invalid_record", "Invalid media delivery state.");
  }
  if (typeof delivery.downloadStartedAt !== "string" || !Number.isFinite(Date.parse(delivery.downloadStartedAt))) {
    throw new ManagedRecoveryError("invalid_record", "Invalid media delivery anchor.");
  }
  const offsets = [delivery.downloadCompletedOffsetMs, delivery.displayedOffsetMs, delivery.vaultWriteCompletedOffsetMs];
  if (!Number.isSafeInteger(offsets[0]) || (offsets[0] as number) < 0 || (offsets[0] as number) > 604_800_000) {
    throw new ManagedRecoveryError("invalid_record", "Invalid media delivery offset.");
  }
  if (
    offsets[1] !== undefined
    && (
      !Number.isSafeInteger(offsets[1])
      || (offsets[1] as number) < (offsets[0] as number)
      || (offsets[1] as number) > 604_800_000
    )
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid media display offset.");
  }
  if (
    offsets[2] !== undefined
    && (
      !Number.isSafeInteger(offsets[2])
      || offsets[1] === undefined
      || (offsets[2] as number) < (offsets[1] as number)
      || (offsets[2] as number) > 604_800_000
    )
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid media vault-write offset.");
  }
  if (delivery.outputs !== undefined) {
    if (
      capability !== "video_generation"
      || !Array.isArray(delivery.outputs)
      || delivery.outputs.length < 1
      || delivery.outputs.length > 4
    ) {
      throw new ManagedRecoveryError("invalid_record", "Invalid media delivery outputs.");
    }
    const indexes = new Set<number>();
    for (const raw of delivery.outputs) {
      if (
        !raw
        || typeof raw !== "object"
        || Array.isArray(raw)
        || Object.keys(raw).sort().join() !== "durationSeconds,height,index,width"
      ) {
        throw new ManagedRecoveryError("invalid_record", "Invalid media delivery output.");
      }
      const output = raw as Record<string, unknown>;
      if (
        !Number.isInteger(output.index)
        || (output.index as number) < 0
        || (output.index as number) > 3
        || indexes.has(output.index as number)
      ) {
        throw new ManagedRecoveryError("invalid_record", "Invalid media delivery output index.");
      }
      indexes.add(output.index as number);
      for (const field of ["width", "height", "durationSeconds"] as const) {
        const measured = output[field];
        const max = field === "durationSeconds" ? 3_600 : 32_768;
        if (measured !== null && (!Number.isInteger(measured) || (measured as number) < 1 || (measured as number) > max)) {
          throw new ManagedRecoveryError("invalid_record", "Invalid media delivery output measurement.");
        }
      }
    }
  }
}

function validateMultipartUpload(
  value: unknown,
  capability: ManagedRecoveryCapability,
): asserts value is ManagedMultipartUploadDescriptor {
  if (isMediaCapability(capability)) {
    throw new ManagedRecoveryError("invalid_record", "Media generation does not use multipart upload metadata.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedRecoveryError("invalid_record", "Invalid multipart upload metadata.");
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.some((key) => !["createRequest", "partSizeBytes", "totalParts"].includes(key))) {
    throw new ManagedRecoveryError("invalid_record", "Invalid multipart upload metadata.");
  }
  validateCreateRequest(payload.createRequest);
  const partSizeBytes = payload.partSizeBytes;
  const totalParts = payload.totalParts;
  if (
    !Number.isInteger(partSizeBytes)
    || (partSizeBytes as number) < 1
    || !Number.isInteger(totalParts)
    || (totalParts as number) < 1
    || (totalParts as number) > MANAGED_MULTIPART_PART_LIMITS[capability]
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid multipart upload layout.");
  }
  const contentLengthBytes = payload.createRequest.contentLengthBytes;
  if (Math.ceil(contentLengthBytes / (partSizeBytes as number)) !== totalParts) {
    throw new ManagedRecoveryError("invalid_record", "Multipart upload layout does not match its create request.");
  }
}

function validateLocalCommitReceipt(value: unknown): asserts value is ManagedLocalCommitReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedRecoveryError("invalid_record", "Invalid local commit receipt.");
  }
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (keys.some((key) => !["kind", "outputPath", "contentSha256", "marker"].includes(key))) {
    throw new ManagedRecoveryError("invalid_record", "Invalid local commit receipt.");
  }
  // Preserve the persisted format's string coercion, including its strict-kind
  // marker checks below. Admission is not a migration or a hardening pass.
  if (!["marker", "exact"].includes(String(receipt.kind))) {
    throw new ManagedRecoveryError("invalid_record", "Invalid local commit receipt kind.");
  }
  if (typeof receipt.outputPath !== "string" || !receipt.outputPath.trim() || receipt.outputPath.length > 1024) {
    throw new ManagedRecoveryError("invalid_record", "Invalid local commit output path.");
  }
  if (!/^[a-f0-9]{64}$/.test(String(receipt.contentSha256 ?? ""))) {
    throw new ManagedRecoveryError("invalid_record", "Invalid local commit content digest.");
  }
  if (
    receipt.marker !== undefined
    && (typeof receipt.marker !== "string" || !receipt.marker.trim() || receipt.marker.length > 1024)
  ) {
    throw new ManagedRecoveryError("invalid_record", "Invalid local commit marker.");
  }
  if (receipt.kind === "marker" && typeof receipt.marker !== "string") {
    throw new ManagedRecoveryError("invalid_record", "Marker receipts require a marker.");
  }
  if (receipt.kind === "exact" && receipt.marker !== undefined) {
    throw new ManagedRecoveryError("invalid_record", "Exact receipts must not include a marker.");
  }
}

export function decodeManagedRecoveryWriteJournal(raw: string, path: string): WriteJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ManagedRecoveryError("recovery_corrupt", "Malformed write journal.");
  }
  const journal = asRecord(value);
  const identity = recoveryIdentity(path);
  if (
    !journal
    || Object.keys(journal).sort().join() !== "capability,fromRevision,operationId,phase,schemaVersion,toRevision"
    || journal.schemaVersion !== 1
    || typeof journal.phase !== "string"
    || !["prepared", "original_moved", "promoted"].includes(journal.phase)
    || journal.capability !== identity.capability
    || journal.operationId !== identity.operationId
    || typeof journal.fromRevision !== "number"
    || !Number.isInteger(journal.fromRevision)
    || journal.toRevision !== journal.fromRevision + 1
  ) {
    throw new ManagedRecoveryError("recovery_corrupt", "Invalid write journal.");
  }
  return journal as WriteJournal;
}

export function decodeManagedRecoveryDeleteJournal(raw: string, path: string): ManagedRecoveryDeleteJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ManagedRecoveryError("recovery_corrupt", "Malformed delete journal.");
  }
  const journal = asRecord(value);
  const identity = recoveryIdentity(path);
  if (
    !journal
    || Object.keys(journal).sort().join() !== "capability,intent,operationId,revision,schemaVersion"
    || journal.schemaVersion !== 1
    || journal.intent !== "delete"
    || journal.capability !== identity.capability
    || journal.operationId !== identity.operationId
    || typeof journal.revision !== "number"
    || !Number.isInteger(journal.revision)
    || journal.revision < 1
  ) {
    throw new ManagedRecoveryError("recovery_corrupt", "Invalid delete journal.");
  }
  return journal as ManagedRecoveryDeleteJournal;
}

function recoveryIdentity(path: string) {
  const match = path.match(/\/([^/]+)\/([^/]+)\.json$/);
  if (!match || !MANAGED_RECOVERY_CAPABILITIES.includes(match[1] as ManagedRecoveryCapability)) {
    throw new ManagedRecoveryError("recovery_corrupt", "Invalid recovery path.");
  }
  return { capability: match[1] as ManagedRecoveryCapability, operationId: match[2] };
}
