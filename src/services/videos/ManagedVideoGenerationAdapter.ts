import type { ManagedUploadedImageInput } from "../managed/ManagedJobClient";
import type { ManagedJobRecoveryStore } from "../managed/ManagedJobRecoveryStore";
import type {
  ManagedJobRecoveryRecord,
  ManagedPendingDispatch,
  ManagedDeliveredVideoOutputBytes,
  ManagedVideoOutputMetadata,
} from "../managed/ManagedTypes";
import {
  dispatchManagedJob,
  isRetryableManagedJobObservationError,
  observeManagedJob,
  waitForManagedJob,
} from "../managed/ManagedJobObservation";
import type { ManagedMediaJobError, ManagedVideoFrameImage, ManagedVideoFrameRole } from "../managed/ManagedMediaJobClient";
import { sha256HexFromBytesPortable } from "../../utils/sha256";

const CAPABILITY = "video_generation" as const;
const RESOLUTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const ASPECT_RATIO_PATTERN = /^[0-9]{1,2}:[0-9]{1,2}$/;
const VIDEO_METADATA_TIMEOUT_MS = 3_000;
const MEDIA_DELIVERY_MAX_OFFSET_MS = 7 * 24 * 60 * 60 * 1_000;

type VideoOutputMeasurement = {
  index: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export type ManagedVideoFrameInput = Readonly<{
  role: ManagedVideoFrameRole;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  sha256: string;
  load: () => Promise<ArrayBuffer>;
}>;

export type ManagedVideoGenerationPayload = Readonly<{
  /** Server catalog model ID. Required: video generation has no server default. */
  model: string;
  prompt: string;
  frameImages?: readonly ManagedVideoFrameInput[];
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
}>;

/** Progress the server chooses to publish while a job runs. */
export type ManagedVideoGenerationProgress = Readonly<{
  status: string;
  typicalDurationMs?: number;
}>;

export type ManagedVideoGenerationOperation = Readonly<{
  operationId: string;
  sourceIdentity: string;
  buildPayload: () => ManagedVideoGenerationPayload | Promise<ManagedVideoGenerationPayload>;
  signal?: AbortSignal;
  onProgress?: (progress: ManagedVideoGenerationProgress) => void;
}>;

export type ManagedVideoGenerationResult = Readonly<{
  operationId: string;
  jobId: string;
  outputs: readonly ManagedDeliveredVideoOutputBytes[];
}>;

type VideoCreateResponse = Readonly<{ job: Readonly<{ id: string; status: string }> }>;

type VideoStatusResponse = Readonly<{
  job: Readonly<{ id: string; status: string }>;
  outputs: readonly ManagedVideoOutputMetadata[];
  poll_after_ms?: number;
  typical_duration_ms?: number;
}>;

type VideoJobs = Readonly<{
  create: (
    body: {
      model: string;
      prompt: string;
      frame_images?: ManagedVideoFrameImage[];
      options?: { duration_seconds?: number; resolution?: string; aspect_ratio?: string; generate_audio?: boolean };
    },
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<VideoCreateResponse>;
  status: (jobId: string, signal?: AbortSignal) => Promise<VideoStatusResponse>;
  downloadOutput: (
    jobId: string,
    outputIndex: number,
    expected: ManagedVideoOutputMetadata,
    signal?: AbortSignal,
  ) => Promise<ManagedDeliveredVideoOutputBytes>;
  acknowledgeDelivery: (
    jobId: string,
    body: {
      download_completed_offset_ms: number;
      displayed_offset_ms: number;
      vault_write_completed_offset_ms: number;
      outputs: Array<{ index: number; width: number | null; height: number | null; duration_seconds: number | null }>;
    },
    signal?: AbortSignal,
  ) => Promise<{ acknowledged: true; acknowledged_at: string }>;
}>;

type FramePrepare = (
  inputs: Array<{ mime_type: string; size_bytes: number; sha256: string }>,
  load: (index: number) => Promise<ArrayBuffer>,
  signal?: AbortSignal,
) => Promise<{ uploadId: string; inputs: ManagedUploadedImageInput[] }>;

type VideoRecovery = Pick<
  ManagedJobRecoveryStore,
  | "createAdmitted"
  | "read"
  | "markContentReady"
  | "markLocalCommitPending"
  | "completeLocalCommit"
  | "beginDispatch"
  | "acknowledgeVideoPrepared"
  | "acknowledgeVideoCreated"
  | "applyReconciliation"
  | "recordMediaDownload"
  | "recordMediaDisplayed"
  | "recordMediaVaultWrite"
  | "recordVideoOutputMeasurements"
>;

export type ManagedVideoGenerationDependencies = Readonly<{
  /** hosted_videos discovery probe (fail-open tri-state). */
  availability: (signal?: AbortSignal) => Promise<{ canOpen: boolean; authoritative: boolean }>;
  /** admission-v1 license validation; video generation has no frozen-catalog lease. */
  admission: (signal?: AbortSignal) => Promise<{ outcome: string }>;
  jobs: VideoJobs;
  /** Frame stills upload through the managed image input prepare endpoint. */
  prepareFrames: FramePrepare;
  recovery: VideoRecovery;
  createRequestId?: () => string;
  now?: () => string;
  nowMs?: () => number;
  elapsedNow?: () => number;
  probeOutputMetadata?: (output: ManagedDeliveredVideoOutputBytes) => Promise<VideoOutputMeasurement>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

async function probeVideoOutputMetadata(output: ManagedDeliveredVideoOutputBytes): Promise<VideoOutputMeasurement> {
  const known: VideoOutputMeasurement = {
    index: output.metadata.index,
    width: output.metadata.width,
    height: output.metadata.height,
    durationSeconds: output.metadata.duration_seconds,
  };
  if (known.width !== null && known.height !== null && known.durationSeconds !== null) return known;

  const video = createEl("video");
  const ownerWindow = video.ownerDocument.defaultView;
  const urlApi = ownerWindow?.URL;
  if (!ownerWindow || typeof urlApi?.createObjectURL !== "function" || typeof urlApi.revokeObjectURL !== "function") return known;
  const objectUrl = urlApi.createObjectURL(new ownerWindow.Blob([output.bytes], { type: output.metadata.mime_type }));
  video.muted = true;
  video.preload = "metadata";
  try {
    const measured = await new Promise<VideoOutputMeasurement | null>((resolve) => {
      let settled = false;
      const finish = (value: VideoOutputMeasurement | null): void => {
        if (settled) return;
        settled = true;
        ownerWindow.clearTimeout(timeout);
        resolve(value);
      };
      const positiveInteger = (value: number, max: number): number | null => {
        if (!Number.isFinite(value) || value <= 0) return null;
        return Math.min(max, Math.max(1, Math.round(value)));
      };
      const timeout = ownerWindow.setTimeout(() => finish(null), VIDEO_METADATA_TIMEOUT_MS);
      video.addEventListener("error", () => finish(null), { once: true });
      video.addEventListener("loadedmetadata", () => finish({
        index: output.metadata.index,
        width: positiveInteger(video.videoWidth, 32_768),
        height: positiveInteger(video.videoHeight, 32_768),
        durationSeconds: positiveInteger(video.duration, 3_600),
      }), { once: true });
      video.src = objectUrl;
      video.load();
    });
    return measured ? {
      index: known.index,
      width: measured.width ?? known.width,
      height: measured.height ?? known.height,
      durationSeconds: measured.durationSeconds ?? known.durationSeconds,
    } : known;
  } catch {
    return known;
  } finally {
    video.removeAttribute("src");
    video.load();
    urlApi.revokeObjectURL(objectUrl);
  }
}

function abortError(): DOMException {
  return new DOMException("Video generation was cancelled locally.", "AbortError");
}

/** Phases where the server holds work this vault has not yet saved locally. */
function isResumablePhase(phase: ManagedJobRecoveryRecord["phase"]): boolean {
  return phase === "created" || phase === "processing" || phase === "result_ready" || phase === "local_commit_pending";
}

/**
 * A media record only accepts the server's terminal status while the job is
 * still in flight; every later phase already recorded it and the store refuses
 * a second one. Resume deliberately rejoins those later phases — a job whose
 * result was ready before the vault closed still needs its bytes saved — so
 * the re-download has to skip the reconciliation rather than die on it and
 * strand the placeholder on every reload.
 */
function isReconcilable(phase: ManagedJobRecoveryRecord["phase"]): boolean {
  return phase === "processing";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function defaultRequestId(): string {
  return window.crypto?.randomUUID?.() ?? `video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizePayload(payload: ManagedVideoGenerationPayload): {
  model: string;
  prompt: string;
  frames: ManagedVideoFrameInput[];
  options: { duration_seconds?: number; resolution?: string; aspect_ratio?: string; generate_audio?: boolean };
} {
  const model = String(payload.model || "").trim();
  if (!/^(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9./_:-]{0,159}$/.test(model)) {
    throw new Error("Managed video generation requires a valid model ID.");
  }
  const prompt = String(payload.prompt || "").trim();
  if (!prompt || prompt.length > 8_000) throw new Error("Managed video generation requires a prompt of at most 8,000 characters.");
  const frames = [...(payload.frameImages || [])];
  if (frames.length > 2 || new Set(frames.map(frame => frame.role)).size !== frames.length) {
    throw new Error("Managed video generation accepts at most one first frame and one last frame.");
  }
  for (const frame of frames) {
    if (
      (frame.role !== "first_frame" && frame.role !== "last_frame")
      || !["image/png", "image/jpeg", "image/webp"].includes(frame.mimeType)
      || !Number.isInteger(frame.sizeBytes)
      || frame.sizeBytes < 1
      || frame.sizeBytes > 20 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(frame.sha256)
      || typeof frame.load !== "function"
    ) throw new Error("Managed video generation received an invalid frame image.");
  }
  if (payload.durationSeconds !== undefined && (!Number.isInteger(payload.durationSeconds) || payload.durationSeconds < 1 || payload.durationSeconds > 60)) {
    throw new Error("Managed video generation duration must be 1-60 seconds.");
  }
  if (payload.resolution !== undefined && !RESOLUTION_PATTERN.test(payload.resolution)) {
    throw new Error("Managed video generation resolution is invalid.");
  }
  if (payload.aspectRatio !== undefined && !ASPECT_RATIO_PATTERN.test(payload.aspectRatio)) {
    throw new Error("Managed video generation received an invalid aspect ratio.");
  }
  if (payload.generateAudio !== undefined && typeof payload.generateAudio !== "boolean") {
    throw new Error("Managed video generation audio flag must be boolean.");
  }
  return {
    model,
    prompt,
    frames,
    options: {
      ...(payload.durationSeconds === undefined ? {} : { duration_seconds: payload.durationSeconds }),
      ...(payload.resolution === undefined ? {} : { resolution: payload.resolution }),
      ...(payload.aspectRatio === undefined ? {} : { aspect_ratio: payload.aspectRatio }),
      ...(payload.generateAudio === undefined ? {} : { generate_audio: payload.generateAudio }),
    },
  };
}

function contentFingerprint(payload: ReturnType<typeof normalizePayload>): string {
  const acceptedContent = JSON.stringify({
    model: payload.model,
    prompt: payload.prompt,
    frame_images: payload.frames.map(frame => ({
      role: frame.role,
      mime_type: frame.mimeType,
      size_bytes: frame.sizeBytes,
      sha256: frame.sha256,
    })),
    options: payload.options,
  });
  return `sha256:${sha256HexFromBytesPortable(new TextEncoder().encode(acceptedContent))}`;
}

function terminalStatusFromError(error: unknown): "failed" | "expired" | null {
  const code = (error as Partial<ManagedMediaJobError> | null)?.code;
  if (code === "video_generation_failed") return "failed";
  if (code === "job_expired") return "expired";
  return null;
}

export class ManagedVideoGenerationAdapter {
  private readonly createRequestId: () => string;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly elapsedNow: () => number;
  private readonly probeOutputMetadata: (output: ManagedDeliveredVideoOutputBytes) => Promise<VideoOutputMeasurement>;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly deliveryClocks = new Map<string, { completedOffsetMs: number; completedAtMs: number }>();
  private readonly outputMeasurementTasks = new Map<string, Promise<VideoOutputMeasurement[]>>();

  constructor(private readonly dependencies: ManagedVideoGenerationDependencies) {
    this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.nowMs = dependencies.nowMs ?? (() => Date.now());
    this.elapsedNow = dependencies.elapsedNow ?? (() => window.performance?.now?.() ?? Date.now());
    this.probeOutputMetadata = dependencies.probeOutputMetadata ?? probeVideoOutputMetadata;
    this.wait = dependencies.wait ?? waitForManagedJob;
  }

  async generate(operation: ManagedVideoGenerationOperation): Promise<ManagedVideoGenerationResult> {
    const signal = operation.signal ?? new AbortController().signal;
    if (typeof operation.operationId !== "string" || operation.operationId.length > 121 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operation.operationId)) {
      throw new Error("Managed video generation operation ID is invalid.");
    }
    if (!operation.sourceIdentity || operation.sourceIdentity.length > 512 || typeof operation.buildPayload !== "function") {
      throw new Error("Managed video generation source identity is invalid.");
    }
    throwIfAborted(signal);

    const availability = await this.dependencies.availability(signal);
    throwIfAborted(signal);
    if (!availability.canOpen) throw new Error("Managed video generation is not available on this server.");
    const admission = await this.dependencies.admission(signal).catch((error: unknown) => {
      throwIfAborted(signal);
      throw error;
    });
    throwIfAborted(signal);
    if (admission.outcome !== "allowed") throw new Error(`Managed video generation is unavailable (${admission.outcome}).`);

    const payload = normalizePayload(await operation.buildPayload());
    throwIfAborted(signal);
    const fingerprint = contentFingerprint(payload);
    let record = await this.dependencies.recovery.createAdmitted({
      capability: CAPABILITY,
      operationId: operation.operationId,
      source: { identity: operation.sourceIdentity, fingerprint },
    });
    throwIfAborted(signal);
    record = await this.dependencies.recovery.markContentReady(CAPABILITY, operation.operationId, record.revision);

    let uploadedFrames: ManagedVideoFrameImage[] | undefined;
    if (payload.frames.length > 0) {
      record = await this.beginDispatch(record, "prepare");
      const prepared = await this.dependencies.prepareFrames(
        payload.frames.map(frame => ({
          mime_type: frame.mimeType,
          size_bytes: frame.sizeBytes,
          sha256: frame.sha256,
        })),
        index => payload.frames[index].load(),
        signal,
      );
      throwIfAborted(signal);
      if (prepared.inputs.length !== payload.frames.length) throw new Error("Managed video generation frame preparation returned the wrong count.");
      uploadedFrames = prepared.inputs.map((input, index) => ({ ...input, role: payload.frames[index].role }));
      record = await this.dependencies.recovery.acknowledgeVideoPrepared(operation.operationId, record.revision);
    }

    record = await this.beginDispatch(record, "create");
    const created = await dispatchManagedJob({
      send: () => this.dependencies.jobs.create({
        model: payload.model,
        prompt: payload.prompt,
        ...(uploadedFrames && uploadedFrames.length > 0 ? { frame_images: uploadedFrames } : {}),
        ...(Object.keys(payload.options).length > 0 ? { options: payload.options } : {}),
      }, operation.operationId, signal),
      signal,
      retryAfterMs: error => (error as Partial<ManagedMediaJobError> | null)?.retryAfterMs,
      wait: this.wait,
    });
    throwIfAborted(signal);
    const jobId = String(created.job?.id || "").trim();
    if (!jobId) throw new Error("Managed video generation create response did not include a job ID.");
    record = await this.dependencies.recovery.acknowledgeVideoCreated(operation.operationId, record.revision, jobId);

    return this.pollAndDownload(record, signal, operation.onProgress);
  }

  /**
   * Rejoin a clip this vault already commissioned. The recovery record holds
   * the server job ID, so quitting Obsidian mid-render costs nothing: the same
   * job is awaited and saved on the next load.
   */
  async resume(
    operationId: string,
    signal?: AbortSignal,
    onProgress?: (progress: ManagedVideoGenerationProgress) => void,
  ): Promise<ManagedVideoGenerationResult | null> {
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId).catch(() => null);
    if (!record || !record.jobId || !isResumablePhase(record.phase)) return null;
    return await this.pollAndDownload(record, signal ?? new AbortController().signal, onProgress);
  }

  async beginLocalCommit(operationId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.phase === "local_commit_pending") return;
    await this.dependencies.recovery.markLocalCommitPending(CAPABILITY, operationId, record.revision);
    if (signal) throwIfAborted(signal);
  }

  async markDisplayed(operationId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.mediaDelivery?.displayedOffsetMs !== undefined) return;
    const offset = this.deliveryOffset(record);
    await this.dependencies.recovery.recordMediaDisplayed(CAPABILITY, operationId, record.revision, offset);
    if (signal) throwIfAborted(signal);
  }

  async markVaultWriteCompleted(operationId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.mediaDelivery?.vaultWriteCompletedOffsetMs !== undefined) return;
    const offset = this.deliveryOffset(record);
    await this.dependencies.recovery.recordMediaVaultWrite(CAPABILITY, operationId, record.revision, offset);
    if (signal) throwIfAborted(signal);
  }

  async completeLocalCommit(operationId: string, signal?: AbortSignal): Promise<void> {
    const deliverySignal = signal ?? new AbortController().signal;
    throwIfAborted(deliverySignal);
    let record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.phase === "completed") return;
    record = await this.persistPendingOutputMeasurements(record);
    const delivery = record.mediaDelivery;
    if (
      !record.jobId
      || !delivery
      || delivery.displayedOffsetMs === undefined
      || delivery.vaultWriteCompletedOffsetMs === undefined
      || !delivery.outputs?.length
    ) {
      throw new Error("Managed video delivery is not ready for acknowledgment.");
    }
    await dispatchManagedJob({
      send: () => this.dependencies.jobs.acknowledgeDelivery(record.jobId as string, {
        download_completed_offset_ms: delivery.downloadCompletedOffsetMs,
        displayed_offset_ms: delivery.displayedOffsetMs as number,
        vault_write_completed_offset_ms: delivery.vaultWriteCompletedOffsetMs as number,
        outputs: delivery.outputs!.map(output => ({
          index: output.index,
          width: output.width,
          height: output.height,
          duration_seconds: output.durationSeconds,
        })),
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
    if (!delivery) throw new Error("Managed video delivery timing is unavailable.");
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
    onProgress?: (progress: ManagedVideoGenerationProgress) => void,
  ): Promise<ManagedVideoGenerationResult> {
    let record = initialRecord;
    const jobId = record.jobId;
    if (!jobId) throw new Error("Managed video generation recovery record is missing its job ID.");

    try {
      for await (const status of observeManagedJob<VideoStatusResponse>({
        read: () => this.dependencies.jobs.status(jobId, signal),
        signal,
        pollAfterMs: value => value.poll_after_ms,
        isRetryableError: isRetryableManagedJobObservationError,
        retryAfterMs: error => (error as Partial<ManagedMediaJobError> | null)?.retryAfterMs,
        wait: this.wait,
      })) {
        if (status.job.id !== jobId) throw new Error("Managed video generation status identity changed.");
        try {
          onProgress?.({
            status: status.job.status,
            ...(status.typical_duration_ms === undefined ? {} : { typicalDurationMs: status.typical_duration_ms }),
          });
        } catch { /* progress display must never break the job */ }
        if (status.job.status === "queued" || status.job.status === "processing") continue;
        if (status.job.status !== "succeeded" || status.outputs.length < 1) {
          throw new Error("Managed video generation completed without verified outputs.");
        }
        if (isReconcilable(record.phase)) {
          record = await this.dependencies.recovery.applyReconciliation(
            CAPABILITY,
            record.operationId,
            record.revision,
            "succeeded",
          );
        }
        const outputs: ManagedDeliveredVideoOutputBytes[] = [];
        for (const metadata of status.outputs) {
          throwIfAborted(signal);
          // A failed transfer only repeats retrieval of this verified output;
          // the completed server job must never be commissioned again.
          for await (const output of observeManagedJob<ManagedDeliveredVideoOutputBytes>({
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
        if (!downloadStartedAt || outputs.some(output => output.delivery.download_started_at !== downloadStartedAt)) {
          throw new Error("Managed video download timing changed between outputs.");
        }
        const downloadCompletedOffsetMs = Math.max(...outputs.map(output => output.delivery.download_completed_offset_ms));
        const downloadCompletedAtMs = this.elapsedNow();
        const fallbackMeasurements = outputs.map(output => this.outputMeasurement(output));
        const measurementTask = Promise.all(outputs.map(async output => {
          try {
            const value = await this.probeOutputMetadata(output);
            if (value.index !== output.metadata.index) return this.outputMeasurement(output);
            return {
              index: value.index,
              width: this.validMeasurement(value.width, 32_768) ?? output.metadata.width,
              height: this.validMeasurement(value.height, 32_768) ?? output.metadata.height,
              durationSeconds: this.validMeasurement(value.durationSeconds, 3_600) ?? output.metadata.duration_seconds,
            };
          } catch {
            return this.outputMeasurement(output);
          }
        }));
        this.outputMeasurementTasks.set(record.operationId, measurementTask);
        record = await this.dependencies.recovery.recordMediaDownload(CAPABILITY, record.operationId, record.revision, {
          downloadStartedAt,
          downloadCompletedOffsetMs,
          outputs: fallbackMeasurements,
        });
        this.deliveryClocks.set(record.operationId, {
          completedOffsetMs: downloadCompletedOffsetMs,
          completedAtMs: downloadCompletedAtMs,
        });
        return Object.freeze({ operationId: record.operationId, jobId, outputs: Object.freeze(outputs) });
      }
    } catch (error) {
      const terminal = terminalStatusFromError(error);
      if (terminal && isReconcilable(record.phase)) {
        await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, terminal);
      }
      throw error;
    }
    throw new Error("Managed video generation observation ended without a terminal status.");
  }

  private outputMeasurement(output: ManagedDeliveredVideoOutputBytes): VideoOutputMeasurement {
    return {
      index: output.metadata.index,
      width: output.metadata.width,
      height: output.metadata.height,
      durationSeconds: output.metadata.duration_seconds,
    };
  }

  private validMeasurement(value: number | null, max: number): number | null {
    return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max ? value : null;
  }

  private async persistPendingOutputMeasurements(record: ManagedJobRecoveryRecord): Promise<ManagedJobRecoveryRecord> {
    const task = this.outputMeasurementTasks.get(record.operationId);
    if (!task) return record;
    const outputs = await task;
    const updated = await this.dependencies.recovery.recordVideoOutputMeasurements(
      record.operationId,
      record.revision,
      outputs,
    );
    this.outputMeasurementTasks.delete(record.operationId);
    return updated;
  }
}
