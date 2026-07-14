import type { ManagedAdmission } from "../managed/ManagedAdmission";
import type {
  ManagedJobError,
  ManagedUploadedImageInput,
} from "../managed/ManagedJobClient";
import type { ManagedJobRecoveryStore } from "../managed/ManagedJobRecoveryStore";
import type {
  ManagedImageOutputBytes,
  ManagedImageOutputMetadata,
  ManagedJobRecoveryRecord,
  ManagedPendingDispatch,
} from "../managed/ManagedTypes";
import { sha256HexFromBytesPortable } from "../../studio/hash";

const CAPABILITY = "image_generation" as const;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 900;

export type ManagedImageGenerationInput = Readonly<{
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  sha256: string;
  load: () => Promise<ArrayBuffer>;
}>;

export type ManagedImageGenerationPayload = Readonly<{
  prompt: string;
  inputImages?: readonly ManagedImageGenerationInput[];
  count?: number;
  aspectRatio?: string;
  imageSize?: "1K";
  seed?: number;
}>;

export type ManagedImageGenerationOperation = Readonly<{
  operationId: string;
  sourceIdentity: string;
  buildPayload: () => ManagedImageGenerationPayload | Promise<ManagedImageGenerationPayload>;
  signal?: AbortSignal;
}>;

export type ManagedImageGenerationResult = Readonly<{
  operationId: string;
  jobId: string;
  outputs: readonly ManagedImageOutputBytes[];
}>;

type ImageCreateResponse = Readonly<{
  job: Readonly<{ id: string; status: "queued" | "processing" | "succeeded" }>;
}>;

type ImageStatusResponse = Readonly<{
  job: Readonly<{ id: string; status: "queued" | "processing" | "succeeded" }>;
  outputs: readonly ManagedImageOutputMetadata[];
  poll_after_ms?: number;
}>;

type ImageJobs = Readonly<{
  prepareInputs: (
    inputs: Array<{ mime_type: string; size_bytes: number; sha256: string }>,
    load: (index: number) => Promise<ArrayBuffer>,
    signal?: AbortSignal,
  ) => Promise<{ uploadId: string; inputs: ManagedUploadedImageInput[] }>;
  create: (
    body: {
      prompt: string;
      input_images?: ManagedUploadedImageInput[];
      options?: { count?: number; aspect_ratio?: string; image_size?: "1K"; seed?: number };
    },
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<ImageCreateResponse>;
  status: (jobId: string, signal?: AbortSignal) => Promise<ImageStatusResponse>;
  downloadOutput: (
    jobId: string,
    outputIndex: number,
    expected: ManagedImageOutputMetadata,
    signal?: AbortSignal,
  ) => Promise<ManagedImageOutputBytes>;
}>;

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
>;

export type ManagedImageGenerationDependencies = Readonly<{
  admission: Pick<ManagedAdmission, "acquireLease">;
  jobs: ImageJobs;
  recovery: ImageRecovery;
  createRequestId?: () => string;
  now?: () => string;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxPolls?: number;
}>;

function abortError(): DOMException {
  return new DOMException("Image generation was cancelled locally.", "AbortError");
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

function defaultRequestId(): string {
  return window.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizePayload(payload: ManagedImageGenerationPayload): {
  prompt: string;
  inputs: ManagedImageGenerationInput[];
  options: { count?: number; aspect_ratio?: string; image_size?: "1K"; seed?: number };
} {
  const prompt = String(payload.prompt || "").trim();
  if (!prompt || prompt.length > 8_000) throw new Error("Managed image generation requires a prompt of at most 8,000 characters.");
  const inputs = [...(payload.inputImages || [])];
  if (inputs.length > 4) throw new Error("Managed image generation accepts at most four input images.");
  for (const input of inputs) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(input.mimeType)
      || !Number.isInteger(input.sizeBytes)
      || input.sizeBytes < 1
      || input.sizeBytes > 20 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(input.sha256)
      || typeof input.load !== "function"
    ) throw new Error("Managed image generation received an invalid input image.");
  }
  return {
    prompt,
    inputs,
    options: {
      ...(payload.count === undefined ? {} : { count: payload.count }),
      ...(payload.aspectRatio ? { aspect_ratio: payload.aspectRatio } : {}),
      ...(payload.imageSize ? { image_size: payload.imageSize } : {}),
      ...(payload.seed === undefined ? {} : { seed: payload.seed }),
    },
  };
}

function contentFingerprint(payload: ReturnType<typeof normalizePayload>): string {
  const acceptedContent = JSON.stringify({
    prompt: payload.prompt,
    input_images: payload.inputs.map(input => ({
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      sha256: input.sha256,
    })),
    options: payload.options,
  });
  return `sha256:${sha256HexFromBytesPortable(new TextEncoder().encode(acceptedContent))}`;
}

function terminalStatusFromError(error: unknown): "failed" | "expired" | null {
  const code = (error as Partial<ManagedJobError> | null)?.code;
  if (code === "image_generation_failed") return "failed";
  if (code === "job_expired") return "expired";
  return null;
}

export class ManagedImageGenerationAdapter {
  private readonly createRequestId: () => string;
  private readonly now: () => string;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly maxPolls: number;

  constructor(private readonly dependencies: ManagedImageGenerationDependencies) {
    this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.wait = dependencies.wait ?? defaultWait;
    this.maxPolls = dependencies.maxPolls ?? DEFAULT_MAX_POLLS;
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

    const lease = await this.dependencies.admission.acquireLease({ alias: "systemsculpt/images" });
    throwIfAborted(signal);
    if (lease.outcome !== "allowed") throw new Error(`Managed image generation is unavailable (${lease.outcome}).`);

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

    let uploadedInputs: ManagedUploadedImageInput[] | undefined;
    if (payload.inputs.length > 0) {
      record = await this.beginDispatch(record, "prepare");
      const prepared = await this.dependencies.jobs.prepareInputs(
        payload.inputs.map(input => ({
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
          sha256: input.sha256,
        })),
        index => payload.inputs[index].load(),
        signal,
      );
      throwIfAborted(signal);
      uploadedInputs = prepared.inputs;
      record = await this.dependencies.recovery.acknowledgePrepared(operation.operationId, record.revision);
    }

    record = await this.beginDispatch(record, "create");
    const created = await this.dependencies.jobs.create({
      prompt: payload.prompt,
      ...(uploadedInputs && uploadedInputs.length > 0 ? { input_images: uploadedInputs } : {}),
      ...(Object.keys(payload.options).length > 0 ? { options: payload.options } : {}),
    }, operation.operationId, signal);
    throwIfAborted(signal);
    const jobId = String(created.job?.id || "").trim();
    if (!jobId) throw new Error("Managed image generation create response did not include a job ID.");
    record = await this.dependencies.recovery.acknowledgeImageCreated(operation.operationId, record.revision, jobId);

    return this.pollAndDownload(record, signal);
  }

  async beginLocalCommit(operationId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.phase === "local_commit_pending") return;
    await this.dependencies.recovery.markLocalCommitPending(CAPABILITY, operationId, record.revision);
    if (signal) throwIfAborted(signal);
  }

  async completeLocalCommit(operationId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const record = await this.dependencies.recovery.read(CAPABILITY, operationId);
    if (record.phase === "completed") return;
    await this.dependencies.recovery.completeLocalCommit(CAPABILITY, operationId, record.revision);
    if (signal) throwIfAborted(signal);
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
  ): Promise<ManagedImageGenerationResult> {
    let record = initialRecord;
    const jobId = record.jobId;
    if (!jobId) throw new Error("Managed image generation recovery record is missing its job ID.");

    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      throwIfAborted(signal);
      let status: ImageStatusResponse;
      try {
        status = await this.dependencies.jobs.status(jobId, signal);
      } catch (error) {
        const terminal = terminalStatusFromError(error);
        if (terminal) {
          await this.dependencies.recovery.applyReconciliation(CAPABILITY, record.operationId, record.revision, terminal);
        }
        throw error;
      }
      throwIfAborted(signal);
      if (status.job.id !== jobId) throw new Error("Managed image generation status identity changed.");
      if (status.job.status === "queued" || status.job.status === "processing") {
        const delay = Number.isInteger(status.poll_after_ms) && Number(status.poll_after_ms) >= 0
          ? Number(status.poll_after_ms)
          : DEFAULT_POLL_INTERVAL_MS;
        await this.wait(delay, signal);
        continue;
      }
      if (status.job.status !== "succeeded" || status.outputs.length < 1) {
        throw new Error("Managed image generation completed without verified outputs.");
      }
      record = await this.dependencies.recovery.applyReconciliation(
        CAPABILITY,
        record.operationId,
        record.revision,
        "succeeded",
      );
      const outputs: ManagedImageOutputBytes[] = [];
      for (const metadata of status.outputs) {
        throwIfAborted(signal);
        outputs.push(await this.dependencies.jobs.downloadOutput(jobId, metadata.index, metadata, signal));
      }
      return Object.freeze({ operationId: record.operationId, jobId, outputs: Object.freeze(outputs) });
    }
    throw new Error("Managed image generation did not complete before the polling limit.");
  }
}
