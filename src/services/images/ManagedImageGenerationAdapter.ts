import type { ManagedUploadedImageInput } from "../managed/ManagedJobClient";
import type { ManagedJobRecoveryStore } from "../managed/ManagedJobRecoveryStore";
import type {
  ManagedDeliveredImageOutputBytes,
  ManagedImageOutputMetadata,
  ManagedJobRecoveryRecord,
  ManagedMediaUsage,
  ManagedPendingDispatch,
} from "../managed/ManagedTypes";
import {
  dispatchManagedJob,
  isRetryableManagedJobObservationError,
  observeManagedJob,
  waitForManagedJob,
} from "../managed/ManagedJobObservation";
import type { ManagedImageCreateBody, ManagedMediaJobError } from "../managed/ManagedMediaJobClient";
import { sha256HexFromBytesPortable } from "../../utils/sha256";

const CAPABILITY = "image_generation" as const;
const MEDIA_DELIVERY_MAX_OFFSET_MS = 7 * 24 * 60 * 60 * 1_000;
/** managed-job-protocol-v2 caps image jobs at four references and four outputs. */
export const MANAGED_IMAGE_INPUT_MAX_COUNT = 4;
export const MANAGED_IMAGE_OUTPUT_MAX_COUNT = 4;
const MODEL_PATTERN = /^(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9./_:-]{0,159}$/;
const ASPECT_RATIO_PATTERN = /^(auto|match_input_image|\d{1,2}(\.\d{1,2})?:\d{1,2}(\.\d{1,2})?)$/;
const OPTION_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

type ManagedImageGenerationInput = Readonly<{
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  sha256: string;
  load: () => Promise<ArrayBuffer>;
}>;

type ManagedImageGenerationPayload = Readonly<{
  /** Server catalog model ID; omitted means the server's default image model. */
  model?: string;
  prompt: string;
  inputImages?: readonly ManagedImageGenerationInput[];
  count?: number;
  aspectRatio?: string;
  quality?: string;
  background?: string;
}>;

export type ManagedImageGenerationProgress = Readonly<{ status: string; typicalDurationMs?: number }>;

export type ManagedImageGenerationOperation = Readonly<{
  operationId: string;
  sourceIdentity: string;
  buildPayload: () => ManagedImageGenerationPayload | Promise<ManagedImageGenerationPayload>;
  signal?: AbortSignal;
  onProgress?: (progress: ManagedImageGenerationProgress) => void;
}>;

export type ManagedImageGenerationResult = Readonly<{
  operationId: string;
  jobId: string;
  /** Model the server actually ran. */
  model: string;
  usage: ManagedMediaUsage;
  outputs: readonly ManagedDeliveredImageOutputBytes[];
}>;

type ImageStatusResponse = Readonly<{
  job: Readonly<{ id: string; status: string; model: string }>;
  outputs: readonly ManagedImageOutputMetadata[];
  usage: ManagedMediaUsage;
  poll_after_ms?: number;
  typical_duration_ms?: number;
}>;

type ImageJobs = Readonly<{
  create: (body: ManagedImageCreateBody, operationId: string, signal?: AbortSignal) => Promise<{ job: Readonly<{ id: string }> }>;
  status: (jobId: string, signal?: AbortSignal) => Promise<ImageStatusResponse>;
  downloadOutput: (jobId: string, outputIndex: number, expected: ManagedImageOutputMetadata, signal?: AbortSignal) => Promise<ManagedDeliveredImageOutputBytes>;
  acknowledgeDelivery: (
    jobId: string,
    body: { download_completed_offset_ms: number; displayed_offset_ms: number; vault_write_completed_offset_ms: number },
    signal?: AbortSignal,
  ) => Promise<{ acknowledged: true; acknowledged_at: string }>;
}>;

type InputPrepare = (
  inputs: Array<{ mime_type: string; size_bytes: number; sha256: string }>,
  load: (index: number) => Promise<ArrayBuffer>,
  signal?: AbortSignal,
) => Promise<{ uploadId: string; inputs: ManagedUploadedImageInput[] }>;

type ImageRecovery = Pick<
  ManagedJobRecoveryStore,
  | "createAdmitted"
  | "read"
  | "markContentReady"
  | "markLocalCommitPending"
  | "completeLocalCommit"
  | "beginDispatch"
  | "acknowledgePrepared"
  | "acknowledgeImageCreated"
  | "applyReconciliation"
  | "recordMediaDownload"
  | "recordMediaDisplayed"
  | "recordMediaVaultWrite"
>;

export type ManagedImageGenerationDependencies = Readonly<{
  /** admission-v1 license validation. */
  admission: (signal?: AbortSignal) => Promise<{ outcome: string }>;
  jobs: ImageJobs;
  prepareInputs: InputPrepare;
  recovery: ImageRecovery;
  createRequestId?: () => string;
  now?: () => string;
  nowMs?: () => number;
  elapsedNow?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

function abortError(): DOMException {
  return new DOMException("Image generation was cancelled locally.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function defaultRequestId(): string {
  return window.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizePayload(payload: ManagedImageGenerationPayload): {
  model?: string;
  prompt: string;
  inputs: ManagedImageGenerationInput[];
  options: NonNullable<ManagedImageCreateBody["options"]>;
} {
  const model = String(payload.model || "").trim();
  if (model && !MODEL_PATTERN.test(model)) throw new Error("Managed image generation received an invalid model ID.");
  const prompt = String(payload.prompt || "").trim();
  if (!prompt || prompt.length > 8_000) throw new Error("Managed image generation requires a prompt of at most 8,000 characters.");
  const inputs = [...(payload.inputImages || [])];
  if (inputs.length > MANAGED_IMAGE_INPUT_MAX_COUNT) {
    throw new Error(`Managed image generation accepts at most ${MANAGED_IMAGE_INPUT_MAX_COUNT} reference images.`);
  }
  for (const input of inputs) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(input.mimeType)
      || !Number.isInteger(input.sizeBytes)
      || input.sizeBytes < 1
      || input.sizeBytes > 20 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(input.sha256)
      || typeof input.load !== "function"
    ) throw new Error("Managed image generation received an invalid reference image.");
  }
  if (payload.count !== undefined && (!Number.isInteger(payload.count) || payload.count < 1 || payload.count > MANAGED_IMAGE_OUTPUT_MAX_COUNT)) {
    throw new Error(`Managed image generation count must be 1-${MANAGED_IMAGE_OUTPUT_MAX_COUNT}.`);
  }
  if (payload.aspectRatio !== undefined && !ASPECT_RATIO_PATTERN.test(payload.aspectRatio)) {
    throw new Error("Managed image generation received an invalid aspect ratio.");
  }
  for (const [label, value] of [["quality", payload.quality], ["background", payload.background]] as const) {
    if (value !== undefined && !OPTION_TOKEN_PATTERN.test(value)) throw new Error(`Managed image generation received an invalid ${label}.`);
  }
  return {
    ...(model ? { model } : {}),
    prompt,
    inputs,
    options: {
      ...(payload.count === undefined ? {} : { count: payload.count }),
      ...(payload.aspectRatio === undefined ? {} : { aspect_ratio: payload.aspectRatio }),
      ...(payload.quality === undefined ? {} : { quality: payload.quality }),
      ...(payload.background === undefined ? {} : { background: payload.background }),
    },
  };
}

function contentFingerprint(payload: ReturnType<typeof normalizePayload>): string {
  const acceptedContent = JSON.stringify({
    model: payload.model ?? null,
    prompt: payload.prompt,
    input_images: payload.inputs.map(input => ({ mime_type: input.mimeType, size_bytes: input.sizeBytes, sha256: input.sha256 })),
    options: payload.options,
  });
  return `sha256:${sha256HexFromBytesPortable(new TextEncoder().encode(acceptedContent))}`;
}

function terminalStatusFromError(error: unknown): "failed" | "expired" | null {
  const code = (error as Partial<ManagedMediaJobError> | null)?.code;
  if (code === "image_generation_failed") return "failed";
  if (code === "job_expired") return "expired";
  return null;
}

/**
 * Hosted image generation over managed-job-protocol-v2: optional reference
 * upload, one idempotent create, poll, verified download, then a delivery
 * receipt after the vault write. The provider key never leaves the server.
 */
export class ManagedImageGenerationAdapter {
  private readonly createRequestId: () => string;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly elapsedNow: () => number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly deliveryClocks = new Map<string, { completedOffsetMs: number; completedAtMs: number }>();

  constructor(private readonly dependencies: ManagedImageGenerationDependencies) {
    this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.nowMs = dependencies.nowMs ?? (() => Date.now());
    this.elapsedNow = dependencies.elapsedNow ?? (() => window.performance?.now?.() ?? Date.now());
    this.wait = dependencies.wait ?? waitForManagedJob;
  }

  async generate(operation: ManagedImageGenerationOperation): Promise<ManagedImageGenerationResult> {
    const signal = operation.signal ?? new AbortController().signal;
    if (typeof operation.operationId !== "string" || operation.operationId.length > 121 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operation.operationId)) {
      throw new Error("Managed image generation operation ID is invalid.");
    }
    if (!operation.sourceIdentity || operation.sourceIdentity.length > 512 || typeof operation.buildPayload !== "function") {
      throw new Error("Managed image generation source identity is invalid.");
    }
    throwIfAborted(signal);
    const admission = await this.dependencies.admission(signal).catch((error: unknown) => {
      throwIfAborted(signal);
      throw error;
    });
    throwIfAborted(signal);
    if (admission.outcome !== "allowed") throw new Error(`Managed image generation is unavailable (${admission.outcome}).`);

    const payload = normalizePayload(await operation.buildPayload());
    throwIfAborted(signal);
    let record = await this.dependencies.recovery.createAdmitted({
      capability: CAPABILITY,
      operationId: operation.operationId,
      source: { identity: operation.sourceIdentity, fingerprint: contentFingerprint(payload) },
    });
    throwIfAborted(signal);
    record = await this.dependencies.recovery.markContentReady(CAPABILITY, operation.operationId, record.revision);

    let uploaded: ManagedUploadedImageInput[] | undefined;
    if (payload.inputs.length > 0) {
      record = await this.beginDispatch(record, "prepare");
      const prepared = await this.dependencies.prepareInputs(
        payload.inputs.map(input => ({ mime_type: input.mimeType, size_bytes: input.sizeBytes, sha256: input.sha256 })),
        index => payload.inputs[index].load(),
        signal,
      );
      throwIfAborted(signal);
      if (prepared.inputs.length !== payload.inputs.length) throw new Error("Managed image input preparation returned the wrong count.");
      uploaded = prepared.inputs;
      record = await this.dependencies.recovery.acknowledgePrepared(operation.operationId, record.revision);
    }

    record = await this.beginDispatch(record, "create");
    const created = await dispatchManagedJob({
      send: () => this.dependencies.jobs.create({
        ...(payload.model ? { model: payload.model } : {}),
        prompt: payload.prompt,
        ...(uploaded && uploaded.length > 0 ? { input_images: uploaded } : {}),
        ...(Object.keys(payload.options).length > 0 ? { options: payload.options } : {}),
      }, operation.operationId, signal),
      signal,
      retryAfterMs: error => (error as Partial<ManagedMediaJobError> | null)?.retryAfterMs,
      wait: this.wait,
    });
    throwIfAborted(signal);
    const jobId = String(created.job?.id || "").trim();
    if (!jobId) throw new Error("Managed image generation create response did not include a job ID.");
    record = await this.dependencies.recovery.acknowledgeImageCreated(operation.operationId, record.revision, jobId);
    return this.pollAndDownload(record, signal, operation.onProgress);
  }

  async beginLocalCommit(operationId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.phase === "local_commit_pending") return;
    await this.dependencies.recovery.markLocalCommitPending(CAPABILITY, operationId, record.revision);
  }

  /** The runtime commits once the run's artifacts are persisted: displayed, written, then acknowledged. */
  async completeLocalCommit(operationId: string, signal?: AbortSignal): Promise<void> {
    const deliverySignal = signal ?? new AbortController().signal;
    throwIfAborted(deliverySignal);
    let record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.phase === "completed") return;
    if (record.mediaDelivery?.displayedOffsetMs === undefined) {
      record = await this.dependencies.recovery.recordMediaDisplayed(CAPABILITY, operationId, record.revision, this.deliveryOffset(record));
    }
    if (record.mediaDelivery?.vaultWriteCompletedOffsetMs === undefined) {
      record = await this.dependencies.recovery.recordMediaVaultWrite(CAPABILITY, operationId, record.revision, this.deliveryOffset(record));
    }
    const delivery = record.mediaDelivery;
    if (!record.jobId || !delivery || delivery.displayedOffsetMs === undefined || delivery.vaultWriteCompletedOffsetMs === undefined) {
      throw new Error("Managed image delivery is not ready for acknowledgment.");
    }
    await dispatchManagedJob({
      send: () => this.dependencies.jobs.acknowledgeDelivery(record.jobId as string, {
        download_completed_offset_ms: delivery.downloadCompletedOffsetMs,
        displayed_offset_ms: delivery.displayedOffsetMs as number,
        vault_write_completed_offset_ms: delivery.vaultWriteCompletedOffsetMs as number,
      }, deliverySignal),
      signal: deliverySignal,
      retryAfterMs: error => (error as Partial<ManagedMediaJobError> | null)?.retryAfterMs,
      wait: this.wait,
    });
    throwIfAborted(deliverySignal);
    await this.dependencies.recovery.completeLocalCommit(CAPABILITY, operationId, record.revision);
    this.deliveryClocks.delete(operationId);
  }

  private deliveryOffset(record: ManagedJobRecoveryRecord): number {
    const delivery = record.mediaDelivery;
    if (!delivery) throw new Error("Managed image delivery timing is unavailable.");
    const clock = this.deliveryClocks.get(record.operationId);
    const rawOffset = clock
      ? clock.completedOffsetMs + Math.max(0, this.elapsedNow() - clock.completedAtMs)
      : this.nowMs() - Date.parse(delivery.downloadStartedAt);
    const floor = delivery.displayedOffsetMs ?? delivery.downloadCompletedOffsetMs;
    return Math.min(MEDIA_DELIVERY_MAX_OFFSET_MS, Math.max(floor, Math.round(rawOffset)));
  }

  private beginDispatch(
    record: ManagedJobRecoveryRecord,
    operation: Extract<ManagedPendingDispatch["operation"], "prepare" | "create">,
  ): Promise<ManagedJobRecoveryRecord> {
    return this.dependencies.recovery.beginDispatch(CAPABILITY, record.operationId, record.revision, {
      operation,
      requestId: this.createRequestId(),
      ...(operation === "create" ? { idempotencyKey: `${record.operationId}:create` } : {}),
      dispatchedAt: this.now(),
    });
  }

  private async pollAndDownload(
    initialRecord: ManagedJobRecoveryRecord,
    signal: AbortSignal,
    onProgress?: (progress: ManagedImageGenerationProgress) => void,
  ): Promise<ManagedImageGenerationResult> {
    let record = initialRecord;
    const jobId = record.jobId;
    if (!jobId) throw new Error("Managed image generation recovery record is missing its job ID.");
    try {
      for await (const status of observeManagedJob<ImageStatusResponse>({
        read: () => this.dependencies.jobs.status(jobId, signal),
        signal,
        pollAfterMs: value => value.poll_after_ms,
        isRetryableError: isRetryableManagedJobObservationError,
        retryAfterMs: error => (error as Partial<ManagedMediaJobError> | null)?.retryAfterMs,
        wait: this.wait,
      })) {
        if (status.job.id !== jobId) throw new Error("Managed image generation status identity changed.");
        try {
          onProgress?.({
            status: status.job.status,
            ...(status.typical_duration_ms === undefined ? {} : { typicalDurationMs: status.typical_duration_ms }),
          });
        } catch { /* progress display must never break the job */ }
        if (status.job.status === "queued" || status.job.status === "processing") continue;
        if (status.job.status !== "succeeded" || status.outputs.length < 1) {
          throw new Error("Managed image generation completed without verified outputs.");
        }
        if (record.phase === "processing") {
          record = await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, "succeeded");
        }
        const outputs: ManagedDeliveredImageOutputBytes[] = [];
        for (const metadata of status.outputs) {
          throwIfAborted(signal);
          // A failed transfer repeats retrieval only; the finished job is never commissioned again.
          for await (const output of observeManagedJob<ManagedDeliveredImageOutputBytes>({
            read: () => this.dependencies.jobs.downloadOutput(jobId, metadata.index, metadata, signal),
            signal,
            isRetryableError: isRetryableManagedJobObservationError,
            retryAfterMs: error => (error as Partial<ManagedMediaJobError> | null)?.retryAfterMs,
            wait: this.wait,
          })) {
            outputs.push(output);
            break;
          }
        }
        const downloadStartedAt = outputs[0]?.delivery.download_started_at;
        if (!downloadStartedAt) throw new Error("Managed image download timing is missing.");
        const downloadCompletedOffsetMs = Math.max(...outputs.map(output => output.delivery.download_completed_offset_ms));
        const downloadCompletedAtMs = this.elapsedNow();
        record = await this.dependencies.recovery.recordMediaDownload(CAPABILITY, record.operationId, record.revision, {
          downloadStartedAt,
          downloadCompletedOffsetMs,
        });
        this.deliveryClocks.set(record.operationId, { completedOffsetMs: downloadCompletedOffsetMs, completedAtMs: downloadCompletedAtMs });
        return Object.freeze({
          operationId: record.operationId,
          jobId,
          model: status.job.model,
          usage: status.usage,
          outputs: Object.freeze(outputs),
        });
      }
    } catch (error) {
      const terminal = terminalStatusFromError(error);
      if (terminal && record.phase === "processing") {
        await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, terminal);
      }
      throw error;
    }
    throw new Error("Managed image generation observation ended without a terminal status.");
  }
}
