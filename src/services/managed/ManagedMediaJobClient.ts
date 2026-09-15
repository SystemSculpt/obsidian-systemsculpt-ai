import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";
import {
  MANAGED_CAPABILITY_CONTRACT,
  MANAGED_IMAGE_OUTPUT_MAX_BYTES,
  MANAGED_VIDEO_OUTPUT_MAX_BYTES,
  ManagedDeliveredImageOutputBytes,
  ManagedImageOutputMetadata,
  ManagedMediaUsage,
  ManagedTransportResult,
  ManagedDeliveredVideoOutputBytes,
  ManagedVideoOutputMetadata,
} from "./ManagedTypes";
import type { ManagedUploadedImageInput } from "./ManagedJobClient";
import { retryAfterHeaderMs } from "./ManagedJobObservation";

/**
 * managed-job-protocol-v2 — the negotiated media contract that adds model
 * selection, video generation, and synthesized progress fields
 * (typical_duration_ms). managed-job-protocol-v1 and its client
 * (ManagedJobClient) stay frozen for released artifacts; this sibling client
 * never shares parsing state with it.
 */
export const MANAGED_MEDIA_JOB_PROTOCOL = "managed-job-protocol-v2" as const;

export type ManagedMediaKind = "image" | "video";
export type ManagedMediaJobStatus = "queued" | "processing" | "succeeded" | "failed" | "expired";
export type ManagedVideoFrameRole = "first_frame" | "last_frame";
export type ManagedVideoFrameImage = ManagedUploadedImageInput & Readonly<{ role: ManagedVideoFrameRole }>;

export interface ManagedMediaJobSnapshot {
  id: string;
  status: ManagedMediaJobStatus;
  model: string;
  created_at: string;
  processing_started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  error: { code: string | null; message: string | null } | null;
  attempt_count: number;
}

export interface ManagedImageCreateBody {
  model?: string;
  prompt: string;
  input_images?: ManagedUploadedImageInput[];
  options?: { count?: number; aspect_ratio?: string; image_size?: string; seed?: number };
}
export interface ManagedVideoCreateBody {
  model: string;
  prompt: string;
  frame_images?: ManagedVideoFrameImage[];
  options?: { duration_seconds?: number; resolution?: string; aspect_ratio?: string; generate_audio?: boolean; seed?: number };
}

export interface ManagedMediaCreateResponse {
  job: { id: string; status: ManagedMediaJobStatus; model: string; created_at: string; expires_at: string; error: { code: string | null; message: string | null } | null };
  poll_url: string;
  idempotent_replay?: boolean;
}
export interface ManagedMediaStatusResponse<Output> {
  job: ManagedMediaJobSnapshot;
  outputs: readonly Output[];
  usage: ManagedMediaUsage;
  poll_after_ms?: number;
  typical_duration_ms?: number;
}
export interface ManagedMediaListResponse<Output> {
  items: Array<{ job: ManagedMediaJobSnapshot; outputs: readonly Output[]; usage: ManagedMediaUsage }>;
  next_before: string | null;
}
export interface ManagedMediaListQuery { limit?: number; before?: string; status?: ManagedMediaJobStatus }
export interface ManagedMediaDeliveryBody {
  download_completed_offset_ms: number;
  displayed_offset_ms: number;
  vault_write_completed_offset_ms: number;
}
export interface ManagedVideoDeliveryBody extends ManagedMediaDeliveryBody {
  outputs: Array<{
    index: number;
    width: number | null;
    height: number | null;
    duration_seconds: number | null;
  }>;
}
export interface ManagedMediaDeliveryAcknowledgment {
  acknowledged: true;
  acknowledged_at: string;
}

// Server-authored codes and messages are still untrusted input: only a small
// character set and bounded length may reach users or logs.
const SERVER_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SERVER_MESSAGE_PATTERN = /^[\x20-\x7E]{1,240}$/;
const MODEL_PATTERN = /^(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9./_:-]{0,159}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UPLOADED_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const VIDEO_EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
// Image models publish their own aspect/size matrices via the server catalog,
// so the client checks shape only ('auto', 'match_input_image', or W:H with
// optional decimals; a pixel/K size token) and the server enforces membership.
const IMAGE_ASPECT_RATIO_PATTERN = /^\d{1,2}(\.\d{1,2})?:\d{1,2}(\.\d{1,2})?$/;
const VIDEO_ASPECT_RATIO_PATTERN = /^[0-9]{1,2}:[0-9]{1,2}$/;
const IMAGE_SIZE_PATTERN = /^\d{1,4}(\.\d{1,2})?K?$/i;
const MEDIA_STATUSES: readonly ManagedMediaJobStatus[] = ["queued", "processing", "succeeded", "failed", "expired"];
const MEDIA_DELIVERY_MAX_OFFSET_MS = 7 * 24 * 60 * 60 * 1_000;
const MEDIA_DOWNLOAD_STARTED_AT_HEADER = "x-systemsculpt-download-started-at";
const MEDIA_DOWNLOAD_REQUESTED_AT_HEADER = "x-systemsculpt-download-requested-at";
const CAPABILITY: Record<ManagedMediaKind, "image_generation" | "video_generation"> = { image: "image_generation", video: "video_generation" };
const JOBS_PATH: Record<ManagedMediaKind, string> = { image: "/api/plugin/images/generations/jobs", video: "/api/plugin/videos/generations/jobs" };
const HTTP_FALLBACK_ERRORS: Readonly<Record<number, [string, string]>> = Object.freeze({
  400: ["invalid_request", "The managed media request is invalid."],
  401: ["license_required", "A valid license is required."],
  402: ["payment_required", "Not enough credits are available for this generation."],
  403: ["license_rejected", "License access is forbidden."],
  404: ["not_found", "The managed media job was not found."],
  409: ["operation_conflict", "The managed media job is in a conflicting state."],
  413: ["invalid_request", "The managed media request is too large."],
  426: ["upgrade_required", "A newer SystemSculpt plugin version is required."],
  429: ["rate_limited", "SystemSculpt is receiving too many processing requests right now."],
  502: ["temporarily_unavailable", "SystemSculpt processing is temporarily unavailable."],
  503: ["temporarily_unavailable", "SystemSculpt processing is temporarily unavailable."],
});

export class ManagedMediaJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly requestId: string | null = null,
    public readonly retryable = false,
    public readonly jobFailure: { jobId: string | null; code: string | null } | null = null,
    public readonly retryAfterMs?: number,
  ) { super(message); this.name = "ManagedMediaJobError"; }
}

type JsonObject = Record<string, unknown>;
function malformed(message = "Malformed managed media response."): never { throw new ManagedMediaJobError("malformed_response", message); }
function invalid(message = "Invalid managed media request."): never { throw new ManagedMediaJobError("invalid_request", message); }
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): JsonObject => { if (!value || typeof value !== "object" || Array.isArray(value)) malformed(); const object = value as JsonObject; const allowed = new Set([...required, ...optional]); if (required.some(k => !(k in object)) || Object.keys(object).some(k => !allowed.has(k))) malformed(); return object; };
const string = (v: unknown, max = 2048) => { if (typeof v !== "string" || v.length < 1 || v.length > max) malformed(); return v; };
const integer = (v: unknown, min: number, max: number) => { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) malformed(); return v as number; };
const requestInteger = (v: unknown, min: number, max: number) => { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) invalid(); return v as number; };
const date = (v: unknown) => { const s = string(v, 64); if (!Number.isFinite(Date.parse(s))) malformed(); return s; };

// Terminal failure detail is advisory presentation data, so unsafe or
// unexpected shapes degrade to the generic terminal message instead of
// rejecting an otherwise valid job snapshot.
function jobError(value: unknown): { code: string | null; message: string | null } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const holder = value as JsonObject;
  const code = typeof holder.code === "string" && SERVER_CODE_PATTERN.test(holder.code) ? holder.code : null;
  const message = typeof holder.message === "string" && SERVER_MESSAGE_PATTERN.test(holder.message) ? holder.message : null;
  return code === null && message === null ? null : { code, message };
}

export class ManagedMediaJobClient {
  readonly images = {
    prepareInputs: (input_images: Array<{ mime_type: string; size_bytes: number; sha256: string }>, bytes: (index: number) => Promise<ArrayBuffer>, signal?: AbortSignal) => this.prepareInputs(input_images, bytes, signal),
    create: (body: ManagedImageCreateBody, operationId: string, signal?: AbortSignal) => { this.validateImageCreate(body); return this.create("image", body, operationId, signal); },
    status: (jobId: string, signal?: AbortSignal): Promise<ManagedMediaStatusResponse<ManagedImageOutputMetadata>> => this.status("image", jobId, signal) as Promise<ManagedMediaStatusResponse<ManagedImageOutputMetadata>>,
    list: (query: ManagedMediaListQuery = {}, signal?: AbortSignal): Promise<ManagedMediaListResponse<ManagedImageOutputMetadata>> => this.list("image", query, signal) as Promise<ManagedMediaListResponse<ManagedImageOutputMetadata>>,
    downloadOutput: (jobId: string, outputIndex: number, expected: ManagedImageOutputMetadata, signal?: AbortSignal): Promise<ManagedDeliveredImageOutputBytes> => this.download("image", jobId, outputIndex, expected, signal) as Promise<ManagedDeliveredImageOutputBytes>,
    acknowledgeDelivery: (jobId: string, body: ManagedMediaDeliveryBody, signal?: AbortSignal): Promise<ManagedMediaDeliveryAcknowledgment> => this.acknowledgeDelivery("image", jobId, body, signal),
  };
  readonly videos = {
    create: (body: ManagedVideoCreateBody, operationId: string, signal?: AbortSignal) => { this.validateVideoCreate(body); return this.create("video", body, operationId, signal); },
    status: (jobId: string, signal?: AbortSignal): Promise<ManagedMediaStatusResponse<ManagedVideoOutputMetadata>> => this.status("video", jobId, signal) as Promise<ManagedMediaStatusResponse<ManagedVideoOutputMetadata>>,
    list: (query: ManagedMediaListQuery = {}, signal?: AbortSignal): Promise<ManagedMediaListResponse<ManagedVideoOutputMetadata>> => this.list("video", query, signal) as Promise<ManagedMediaListResponse<ManagedVideoOutputMetadata>>,
    downloadOutput: (jobId: string, outputIndex: number, expected: ManagedVideoOutputMetadata, signal?: AbortSignal): Promise<ManagedDeliveredVideoOutputBytes> => this.download("video", jobId, outputIndex, expected, signal) as Promise<ManagedDeliveredVideoOutputBytes>,
    acknowledgeDelivery: (jobId: string, body: ManagedVideoDeliveryBody, signal?: AbortSignal): Promise<ManagedMediaDeliveryAcknowledgment> => this.acknowledgeDelivery("video", jobId, body, signal),
  };

  constructor(
    private readonly transport: HostedTransportAdapter,
    private readonly now: () => number = () => Date.now(),
    private readonly createRequestId: () => string = () => window.crypto?.randomUUID?.() ?? `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    private readonly elapsedNow: () => number = () => window.performance?.now?.() ?? Date.now(),
  ) {}

  private requestId(): string { const requestId = this.createRequestId(); if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new Error("Invalid generated request ID."); return requestId; }
  private headers(kind: ManagedMediaKind, requestId: string, operationId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "x-systemsculpt-contract": MANAGED_CAPABILITY_CONTRACT,
      "x-systemsculpt-job-contract": MANAGED_MEDIA_JOB_PROTOCOL,
      "x-systemsculpt-capability": CAPABILITY[kind],
      "x-request-id": requestId,
    };
    if (operationId !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) invalid("A durable operation ID is required.");
      const idempotencyKey = `${operationId}:create`;
      if (idempotencyKey.length > 128) invalid("The durable operation ID is too long for the idempotency contract.");
      headers["idempotency-key"] = idempotencyKey;
    }
    return headers;
  }

  private async call(kind: ManagedMediaKind, options: { method: "GET" | "POST"; path: string; body?: unknown; operationId?: string; signal?: AbortSignal }): Promise<{ value: unknown; result: ManagedTransportResult; requestId: string }> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const requestId = this.requestId();
    const result = await this.transport.job({
      path: options.path,
      method: options.method,
      body: options.body,
      headers: this.headers(kind, requestId, options.operationId),
      signal: options.signal,
    }, false);
    if (!result.response.ok) await this.protocolError(result, requestId);
    if (result.response.headers.get("x-request-id") !== requestId) malformed("Managed media response request ID mismatch.");
    let value: unknown;
    try { value = await result.response.json(); } catch { malformed("Expected a JSON managed media response."); }
    return { value, result, requestId };
  }

  private async protocolError(result: ManagedTransportResult, requestId: string): Promise<never> {
    const status = result.response.status;
    const retryAfterMs = retryAfterHeaderMs(result.response.headers.get("retry-after"));
    const retryable = status === 429 || status === 502 || status === 503;
    let envelope: { code: string; message: string } | null = null;
    try {
      const value = await result.response.clone().json() as JsonObject | null;
      if (
        value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).sort().join() === "code,contract_version,message,request_id"
        && value.contract_version === MANAGED_MEDIA_JOB_PROTOCOL
        && typeof value.code === "string" && SERVER_CODE_PATTERN.test(value.code)
        && typeof value.message === "string" && SERVER_MESSAGE_PATTERN.test(value.message)
        && value.request_id === requestId
      ) envelope = { code: value.code, message: value.message };
    } catch { /* fall back to the HTTP status taxonomy */ }
    const [code, message]: [string, string] = envelope ? [envelope.code, envelope.message] : (HTTP_FALLBACK_ERRORS[status] ?? ["managed_media_error", `Managed media request failed (${status}).`]);
    throw new ManagedMediaJobError(code, message, status, requestId, retryable, null, retryAfterMs);
  }

  private job(value: unknown, keys: readonly string[]): ManagedMediaJobSnapshot {
    const job = exact(value, keys);
    string(job.id, 256);
    if (!MEDIA_STATUSES.includes(job.status as ManagedMediaJobStatus)) malformed();
    const model = string(job.model, 160);
    date(job.created_at); date(job.expires_at);
    if ("processing_started_at" in job && job.processing_started_at !== null) date(job.processing_started_at);
    if ("completed_at" in job && job.completed_at !== null) date(job.completed_at);
    if ("attempt_count" in job) integer(job.attempt_count, 0, 100);
    return {
      id: job.id as string,
      status: job.status as ManagedMediaJobStatus,
      model,
      created_at: job.created_at as string,
      processing_started_at: (job.processing_started_at ?? null) as string | null,
      completed_at: (job.completed_at ?? null) as string | null,
      expires_at: job.expires_at as string,
      error: jobError(job.error),
      attempt_count: (job.attempt_count ?? 0) as number,
    };
  }

  private outputMetadata(kind: ManagedMediaKind, value: unknown): ManagedImageOutputMetadata | ManagedVideoOutputMetadata {
    const keys = kind === "video"
      ? ["index", "mime_type", "size_bytes", "sha256", "width", "height", "duration_seconds"]
      : ["index", "mime_type", "size_bytes", "sha256", "width", "height"];
    const output = exact(value, keys);
    const mimeTypes: readonly string[] = kind === "video" ? VIDEO_MIME_TYPES : IMAGE_MIME_TYPES;
    const maxBytes = kind === "video" ? MANAGED_VIDEO_OUTPUT_MAX_BYTES : MANAGED_IMAGE_OUTPUT_MAX_BYTES;
    const index = integer(output.index, 0, 3);
    const mime = string(output.mime_type, 32);
    if (!mimeTypes.includes(mime)) malformed();
    const sizeBytes = integer(output.size_bytes, 1, maxBytes);
    const sha256 = string(output.sha256, 64);
    if (!SHA256_PATTERN.test(sha256)) malformed();
    const width = output.width === null ? null : integer(output.width, 0, 32768);
    const height = output.height === null ? null : integer(output.height, 0, 32768);
    if (kind === "video") {
      const duration = output.duration_seconds === null ? null : integer(output.duration_seconds, 1, 3600);
      return { index, mime_type: mime as ManagedVideoOutputMetadata["mime_type"], size_bytes: sizeBytes, sha256, width, height, duration_seconds: duration };
    }
    return { index, mime_type: mime as ManagedImageOutputMetadata["mime_type"], size_bytes: sizeBytes, sha256, width, height };
  }

  private usage(value: unknown): ManagedMediaUsage {
    const usage = exact(value, ["raw_usd", "cost_source", "estimated"]);
    if (typeof usage.raw_usd !== "number" || !Number.isFinite(usage.raw_usd) || usage.raw_usd < 0 || typeof usage.estimated !== "boolean") malformed();
    return { raw_usd: usage.raw_usd, cost_source: string(usage.cost_source, 64), estimated: usage.estimated };
  }

  private item(kind: ManagedMediaKind, value: unknown): { job: ManagedMediaJobSnapshot; outputs: Array<ManagedImageOutputMetadata | ManagedVideoOutputMetadata>; usage: ManagedMediaUsage } {
    const item = exact(value, ["job", "outputs", "usage"]);
    const job = this.job(item.job, ["id", "status", "model", "created_at", "processing_started_at", "completed_at", "expires_at", "error", "attempt_count"]);
    if (!Array.isArray(item.outputs)) malformed();
    const outputs = item.outputs.map(raw => this.outputMetadata(kind, raw));
    if (outputs.length > 4 || new Set(outputs.map(output => output.index)).size !== outputs.length) malformed();
    const usage = this.usage(item.usage);
    const status = job.status;
    if ((status === "queued" || status === "processing") && outputs.length !== 0) malformed();
    if (status === "succeeded" && (outputs.length < 1 || job.completed_at === null)) malformed();
    if ((status === "failed" || status === "expired") && outputs.length !== 0) malformed();
    if (status === "processing" && job.processing_started_at === null) malformed();
    if (status === "queued" && job.processing_started_at !== null) malformed();
    return { job, outputs, usage };
  }

  private throwTerminal(kind: ManagedMediaKind, job: ManagedMediaJobSnapshot, status: number, requestId: string): void {
    if (job.status === "expired") throw new ManagedMediaJobError("job_expired", "The managed job expired.", status, requestId, false, { jobId: job.id, code: job.error?.code ?? null });
    if (job.status === "failed") {
      const code = kind === "video" ? "video_generation_failed" : "image_generation_failed";
      throw new ManagedMediaJobError(code, job.error?.message ?? "Managed job failed.", status, requestId, false, { jobId: job.id, code: job.error?.code ?? null });
    }
  }

  private async create(kind: ManagedMediaKind, body: unknown, operationId: string, signal?: AbortSignal): Promise<ManagedMediaCreateResponse> {
    if (typeof operationId !== "string") invalid("A durable operation ID is required.");
    const { value, result, requestId } = await this.call(kind, { method: "POST", path: JOBS_PATH[kind], body, operationId, signal });
    const root = exact(value, ["job", "poll_url"], ["idempotent_replay"]);
    const pollUrl = string(root.poll_url, 2048);
    if (!pollUrl.startsWith("/") || pollUrl.startsWith("//")) malformed();
    if (root.idempotent_replay !== undefined && typeof root.idempotent_replay !== "boolean") malformed();
    const job = this.job(root.job, ["id", "status", "model", "created_at", "expires_at", "error"]);
    this.throwTerminal(kind, job, result.response.status, requestId);
    return {
      job: { id: job.id, status: job.status, model: job.model, created_at: job.created_at, expires_at: job.expires_at, error: job.error },
      poll_url: pollUrl,
      ...(root.idempotent_replay === undefined ? {} : { idempotent_replay: root.idempotent_replay }),
    };
  }

  private async status(kind: ManagedMediaKind, jobId: string, signal?: AbortSignal): Promise<ManagedMediaStatusResponse<ManagedImageOutputMetadata | ManagedVideoOutputMetadata>> {
    if (!JOB_ID_PATTERN.test(jobId)) invalid("Invalid managed media job ID.");
    const { value, result, requestId } = await this.call(kind, { method: "GET", path: `${JOBS_PATH[kind]}/${jobId}`, signal });
    const root = exact(value, ["job", "outputs", "usage"], ["poll_after_ms", "typical_duration_ms"]);
    if (root.poll_after_ms !== undefined) integer(root.poll_after_ms, 0, 3600000);
    if (root.typical_duration_ms !== undefined) integer(root.typical_duration_ms, 0, 3600000);
    const item = this.item(kind, { job: root.job, outputs: root.outputs, usage: root.usage });
    if (item.job.id !== jobId) malformed("Managed media status identity changed.");
    this.throwTerminal(kind, item.job, result.response.status, requestId);
    const pollAfterMs = root.poll_after_ms === undefined
      ? retryAfterHeaderMs(result.response.headers.get("retry-after"))
      : root.poll_after_ms as number;
    return {
      ...item,
      ...(pollAfterMs === undefined ? {} : { poll_after_ms: pollAfterMs }),
      ...(root.typical_duration_ms === undefined ? {} : { typical_duration_ms: root.typical_duration_ms as number }),
    };
  }

  private async list(kind: ManagedMediaKind, query: ManagedMediaListQuery, signal?: AbortSignal): Promise<ManagedMediaListResponse<ManagedImageOutputMetadata | ManagedVideoOutputMetadata>> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) { if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid(); params.set("limit", String(query.limit)); }
    if (query.before !== undefined) { if (!Number.isFinite(Date.parse(query.before))) invalid(); params.set("before", query.before); }
    if (query.status !== undefined) { if (!MEDIA_STATUSES.includes(query.status)) invalid(); params.set("status", query.status); }
    const suffix = params.toString();
    const { value } = await this.call(kind, { method: "GET", path: `${JOBS_PATH[kind]}${suffix ? `?${suffix}` : ""}`, signal });
    const root = exact(value, ["items", "next_before"]);
    if (!Array.isArray(root.items)) malformed();
    if (root.next_before !== null) date(root.next_before);
    return { items: root.items.map(raw => this.item(kind, raw)), next_before: root.next_before as string | null };
  }

  private async download(kind: ManagedMediaKind, jobId: string, outputIndex: number, expected: ManagedImageOutputMetadata | ManagedVideoOutputMetadata, signal?: AbortSignal): Promise<ManagedDeliveredImageOutputBytes | ManagedDeliveredVideoOutputBytes> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!JOB_ID_PATTERN.test(jobId) || !Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex > 3) invalid("Invalid managed media output identity.");
    let validated: ManagedImageOutputMetadata | ManagedVideoOutputMetadata;
    try { validated = this.outputMetadata(kind, expected); } catch { invalid("Invalid expected media output metadata."); }
    if (validated.index !== outputIndex) invalid("Media output metadata index mismatch.");
    const localRequestStartedAtMs = this.elapsedNow();
    const requestId = this.requestId();
    const path = `${JOBS_PATH[kind]}/${jobId}/outputs/${outputIndex}`;
    const result = await this.transport.managedMediaOutput(path, this.headers(kind, requestId), signal);
    const response = result.response;
    if (response.status !== 200) {
      if (response.status >= 400) await this.protocolError(result, requestId);
      malformed("Managed media output was not a direct success response.");
    }
    const extension = (kind === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS)[validated.mime_type];
    const declaredLength = response.headers.get("content-length");
    // A proxy may legitimately re-frame the fixed body as chunked; when a
    // length is present it must agree with the verified metadata, and the
    // exact byte count is enforced after reading either way.
    const validDeclaredLength = declaredLength === null
      || (/^(0|[1-9]\d*)$/.test(declaredLength) && Number(declaredLength) === validated.size_bytes);
    const required: Record<string, string> = {
      "x-request-id": requestId,
      "x-systemsculpt-contract": MANAGED_CAPABILITY_CONTRACT,
      "x-systemsculpt-job-contract": MANAGED_MEDIA_JOB_PROTOCOL,
      "x-systemsculpt-output-index": String(outputIndex),
      "x-systemsculpt-content-sha256": validated.sha256,
      "content-type": validated.mime_type,
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="systemsculpt-${kind}-${outputIndex}.${extension}"`,
    };
    const downloadStartedAt = response.headers.get(MEDIA_DOWNLOAD_STARTED_AT_HEADER);
    const downloadStartedAtMs = downloadStartedAt === null ? NaN : Date.parse(downloadStartedAt);
    const downloadRequestedAt = response.headers.get(MEDIA_DOWNLOAD_REQUESTED_AT_HEADER);
    const downloadRequestedAtMs = downloadRequestedAt === null ? NaN : Date.parse(downloadRequestedAt);
    const validRequestedAt = downloadRequestedAt === null || (
      Number.isFinite(downloadRequestedAtMs)
      && downloadRequestedAtMs >= downloadStartedAtMs
      && downloadRequestedAtMs - downloadStartedAtMs <= MEDIA_DELIVERY_MAX_OFFSET_MS
    );
    const mismatched = [
      ...Object.entries(required).filter(([name, value]) => response.headers.get(name) !== value).map(([name]) => name),
      ...(validDeclaredLength ? [] : ["content-length"]),
      ...(Number.isFinite(downloadStartedAtMs) ? [] : [MEDIA_DOWNLOAD_STARTED_AT_HEADER]),
      ...(validRequestedAt ? [] : [MEDIA_DOWNLOAD_REQUESTED_AT_HEADER]),
    ];
    if (mismatched.length > 0) malformed(`Invalid managed media output headers: ${mismatched.join(", ")}.`);
    const bytes = await this.readBounded(response, validated.size_bytes);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (bytes.byteLength !== validated.size_bytes) malformed("Managed media output integrity mismatch.");
    if (await this.sha256(bytes) !== validated.sha256) malformed("Managed media output integrity mismatch.");
    const localRequestCompletedAtMs = this.elapsedNow();
    const localRequestElapsedMs = Math.max(0, localRequestCompletedAtMs - localRequestStartedAtMs);
    const downloadCompletedOffsetMs = Math.min(MEDIA_DELIVERY_MAX_OFFSET_MS, Math.max(0, Math.round(
      downloadRequestedAt === null
        ? localRequestCompletedAtMs - downloadStartedAtMs
        : (downloadRequestedAtMs - downloadStartedAtMs) + localRequestElapsedMs,
    )));
    return {
      metadata: validated,
      bytes,
      delivery: {
        download_started_at: downloadStartedAt as string,
        download_completed_offset_ms: downloadCompletedOffsetMs,
      },
    } as ManagedDeliveredImageOutputBytes | ManagedDeliveredVideoOutputBytes;
  }

  private async acknowledgeDelivery(
    kind: ManagedMediaKind,
    jobId: string,
    body: ManagedMediaDeliveryBody | ManagedVideoDeliveryBody,
    signal?: AbortSignal,
  ): Promise<ManagedMediaDeliveryAcknowledgment> {
    if (!JOB_ID_PATTERN.test(jobId)) invalid("Invalid managed media job ID.");
    const normalized = this.deliveryBody(kind, body);
    const { value } = await this.call(kind, {
      method: "POST",
      path: `${JOBS_PATH[kind]}/${jobId}/delivery`,
      body: normalized,
      signal,
    });
    const root = exact(value, ["acknowledged", "acknowledged_at"]);
    if (root.acknowledged !== true) malformed("Managed media delivery was not acknowledged.");
    return { acknowledged: true, acknowledged_at: date(root.acknowledged_at) };
  }

  private deliveryBody(
    kind: ManagedMediaKind,
    body: ManagedMediaDeliveryBody | ManagedVideoDeliveryBody,
  ): ManagedMediaDeliveryBody | ManagedVideoDeliveryBody {
    const required = [
      "download_completed_offset_ms",
      "displayed_offset_ms",
      "vault_write_completed_offset_ms",
      ...(kind === "video" ? ["outputs"] : []),
    ];
    let root: JsonObject;
    try { root = exact(body, required); } catch { invalid("Invalid managed media delivery timing."); }
    const download = requestInteger(root.download_completed_offset_ms, 0, MEDIA_DELIVERY_MAX_OFFSET_MS);
    const displayed = requestInteger(root.displayed_offset_ms, download, MEDIA_DELIVERY_MAX_OFFSET_MS);
    const vaultWrite = requestInteger(root.vault_write_completed_offset_ms, displayed, MEDIA_DELIVERY_MAX_OFFSET_MS);
    const timing = {
      download_completed_offset_ms: download,
      displayed_offset_ms: displayed,
      vault_write_completed_offset_ms: vaultWrite,
    };
    if (kind === "image") return timing;
    if (!Array.isArray(root.outputs) || root.outputs.length < 1 || root.outputs.length > 4) {
      invalid("Invalid managed video delivery outputs.");
    }
    const indexes = new Set<number>();
    const outputs = root.outputs.map((raw, arrayIndex) => {
      let output: JsonObject;
      try { output = exact(raw, ["index", "width", "height", "duration_seconds"]); } catch { invalid("Invalid managed video delivery output."); }
      const index = requestInteger(output.index, 0, 3);
      if (indexes.has(index)) invalid("Managed video delivery output indexes must be unique.");
      indexes.add(index);
      const nullableMeasurement = (field: "width" | "height" | "duration_seconds", max: number): number | null =>
        output[field] === null ? null : requestInteger(output[field], 1, max);
      return {
        index,
        width: nullableMeasurement("width", 32_768),
        height: nullableMeasurement("height", 32_768),
        duration_seconds: nullableMeasurement("duration_seconds", 3_600),
        arrayIndex,
      };
    });
    outputs.sort((a, b) => a.index - b.index);
    return {
      ...timing,
      outputs: outputs.map(({ arrayIndex: _arrayIndex, ...output }) => output),
    };
  }

  // The transport already caps the response at the per-kind ceiling; this
  // bounds the read at the job's own verified size so an overlong body is
  // cancelled instead of buffered, and abort errors surface unwrapped.
  private async readBounded(response: Response, expectedBytes: number): Promise<ArrayBuffer> {
    const body = response.body;
    if (!body) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > expectedBytes) malformed("Managed media output exceeded expected size.");
      return bytes;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        malformed("Managed media output exceeded expected size.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  }

  private async prepareInputs(input_images: Array<{ mime_type: string; size_bytes: number; sha256: string }>, bytes: (index: number) => Promise<ArrayBuffer>, signal?: AbortSignal): Promise<{ uploadId: string; inputs: ManagedUploadedImageInput[] }> {
    if (!Array.isArray(input_images) || input_images.length < 1 || input_images.length > 4 || input_images.some(x => !x || Object.keys(x).sort().join() !== "mime_type,sha256,size_bytes" || !(IMAGE_MIME_TYPES as readonly string[]).includes(x.mime_type) || !Number.isInteger(x.size_bytes) || x.size_bytes < 1 || x.size_bytes > 20971520 || !SHA256_PATTERN.test(x.sha256))) invalid();
    const { value } = await this.call("image", { method: "POST", path: "/api/plugin/images/inputs/prepare", body: { input_images }, signal });
    const root = exact(value, ["contract", "upload_id", "expires_at", "input_uploads"]);
    if (root.contract !== "systemsculpt-image-input-upload-v1" || !Array.isArray(root.input_uploads) || root.input_uploads.length !== input_images.length) malformed();
    const uploadId = string(root.upload_id, 256);
    const rootExpiresAt = date(root.expires_at);
    if (Date.parse(rootExpiresAt) <= this.now() || Date.parse(rootExpiresAt) - this.now() > 900_000 + 60_000) malformed();
    const internalUploads: Array<{ index: number; url: string; headers: Record<string, string>; size_bytes: number }> = [];
    const indexedInputs: Array<{ index: number; input: ManagedUploadedImageInput }> = [];
    const indexes = new Set<number>();
    for (const raw of root.input_uploads) {
      const entry = exact(raw, ["index", "upload", "input_image"]);
      const upload = exact(entry.upload, ["method", "url", "headers", "expires_in_seconds", "expires_at"]);
      const image = exact(entry.input_image, ["type", "key", "mime_type", "size_bytes", "sha256"]);
      const index = integer(entry.index, 0, 3);
      if (indexes.has(index)) malformed();
      indexes.add(index);
      const mimeType = string(image.mime_type, 32);
      if (upload.method !== "PUT" || image.type !== "uploaded" || !(IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) malformed();
      const uploadHeaders = upload.headers;
      if (!uploadHeaders || typeof uploadHeaders !== "object" || Array.isArray(uploadHeaders) || Object.keys(uploadHeaders).length !== 1 || (uploadHeaders as JsonObject)["content-type"] !== mimeType) malformed();
      integer(upload.expires_in_seconds, 1, 3600);
      const uploadExpiresAt = date(upload.expires_at);
      if (Date.parse(uploadExpiresAt) <= this.now() || Date.parse(uploadExpiresAt) > Date.parse(rootExpiresAt) + 1000) malformed();
      const key = string(image.key, 512);
      if (!UPLOADED_KEY_PATTERN.test(key)) malformed();
      const sizeBytes = integer(image.size_bytes, 1, 20971520);
      const sha256 = string(image.sha256, 64);
      if (!SHA256_PATTERN.test(sha256)) malformed();
      const url = string(upload.url, 2048);
      if (!/^https:\/\//.test(url)) malformed();
      internalUploads.push({ index, url, headers: { "content-type": mimeType }, size_bytes: sizeBytes });
      indexedInputs.push({ index, input: { type: "uploaded", key, mime_type: mimeType as ManagedUploadedImageInput["mime_type"], size_bytes: sizeBytes, sha256 } });
    }
    if ([...indexes].some(index => index >= indexedInputs.length)) malformed();
    const inputs = indexedInputs.sort((left, right) => left.index - right.index).map(entry => entry.input);
    if (inputs.some((input, index) => !input_images[index] || input_images[index].mime_type !== input.mime_type || input_images[index].size_bytes !== input.size_bytes || input_images[index].sha256 !== input.sha256)) malformed("Prepared inputs do not match request.");
    for (const item of internalUploads) {
      const body = await bytes(item.index);
      if (!(body instanceof ArrayBuffer) || body.byteLength !== item.size_bytes) invalid("Input bytes do not match declared size.");
      await this.transport.uploadSignedInput(item.url, "PUT", item.headers, body, signal);
    }
    return { uploadId, inputs };
  }

  private validateUploadedReference(x: unknown, extraKeys: readonly string[] = []): asserts x is ManagedUploadedImageInput {
    const keys = ["key", "mime_type", "sha256", "size_bytes", "type", ...extraKeys].sort().join();
    const value = x as JsonObject | null;
    if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== keys || value.type !== "uploaded" || typeof value.key !== "string" || value.key.length < 1 || value.key.length > 512 || !UPLOADED_KEY_PATTERN.test(value.key) || !(IMAGE_MIME_TYPES as readonly string[]).includes(value.mime_type as string) || !Number.isInteger(value.size_bytes) || (value.size_bytes as number) < 1 || (value.size_bytes as number) > 20971520 || typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) invalid();
  }

  private validateImageCreate(body: ManagedImageCreateBody): void {
    if (!body || Object.keys(body).some(k => !["model", "prompt", "input_images", "options"].includes(k)) || typeof body.prompt !== "string" || body.prompt.length < 1 || body.prompt.length > 8000) invalid();
    if (body.model !== undefined && (typeof body.model !== "string" || !MODEL_PATTERN.test(body.model))) invalid();
    if (body.input_images !== undefined) {
      if (!Array.isArray(body.input_images) || body.input_images.length > 4) invalid();
      for (const input of body.input_images) this.validateUploadedReference(input);
    }
    if (body.options !== undefined) {
      const o = body.options;
      if (!o || Object.keys(o).some(k => !["count", "aspect_ratio", "image_size", "seed"].includes(k))) invalid();
      if (o.count !== undefined && (!Number.isInteger(o.count) || o.count < 1 || o.count > 4)) invalid();
      if (o.aspect_ratio !== undefined && (typeof o.aspect_ratio !== "string" || !(o.aspect_ratio === "auto" || o.aspect_ratio === "match_input_image" || IMAGE_ASPECT_RATIO_PATTERN.test(o.aspect_ratio)))) invalid();
      if (o.image_size !== undefined && (typeof o.image_size !== "string" || !IMAGE_SIZE_PATTERN.test(o.image_size))) invalid();
      if (o.seed !== undefined && (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 2147483647)) invalid();
    }
  }

  private validateVideoCreate(body: ManagedVideoCreateBody): void {
    if (!body || Object.keys(body).some(k => !["model", "prompt", "frame_images", "options"].includes(k)) || typeof body.prompt !== "string" || body.prompt.length < 1 || body.prompt.length > 8000) invalid();
    if (typeof body.model !== "string" || !MODEL_PATTERN.test(body.model)) invalid();
    if (body.frame_images !== undefined) {
      if (!Array.isArray(body.frame_images) || body.frame_images.length > 2) invalid();
      const roles = new Set<string>();
      for (const frame of body.frame_images) {
        if (!frame || (frame.role !== "first_frame" && frame.role !== "last_frame") || roles.has(frame.role)) invalid();
        roles.add(frame.role);
        this.validateUploadedReference(frame, ["role"]);
      }
    }
    if (body.options !== undefined) {
      const o = body.options;
      if (!o || Object.keys(o).some(k => !["duration_seconds", "resolution", "aspect_ratio", "generate_audio", "seed"].includes(k))) invalid();
      if (o.duration_seconds !== undefined && (!Number.isInteger(o.duration_seconds) || o.duration_seconds < 1 || o.duration_seconds > 60)) invalid();
      if (o.resolution !== undefined && (typeof o.resolution !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(o.resolution))) invalid();
      if (o.aspect_ratio !== undefined && (typeof o.aspect_ratio !== "string" || !VIDEO_ASPECT_RATIO_PATTERN.test(o.aspect_ratio))) invalid();
      if (o.generate_audio !== undefined && typeof o.generate_audio !== "boolean") invalid();
      if (o.seed !== undefined && (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 2147483647)) invalid();
    }
  }

  private async sha256(bytes: ArrayBuffer): Promise<string> {
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }
}
