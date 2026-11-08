import { readVerifiedManagedOutput } from "./ManagedOutputBytes";
import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";
import {
  ManagedUploadedImageInput,
  MANAGED_CAPABILITY_CONTRACT,
  ManagedDeliveredImageOutputBytes,
  ManagedImageOutputMetadata,
  ManagedTransportResult,
  ManagedDeliveredVideoOutputBytes,
  ManagedVideoOutputMetadata,
} from "./ManagedTypes";
import { MANAGED_MEDIA_DELIVERY_MAX_OFFSET_MS as MEDIA_DELIVERY_MAX_OFFSET_MS } from "./ManagedMediaDeliveryTiming";

import { createManagedMediaDecoder, MANAGED_MEDIA_JOB_PROTOCOL } from "./ManagedMediaJobContract";
import type {
  ManagedMediaKind,
  ManagedMediaJobSnapshot,
  ManagedImageCreateBody,
  ManagedVideoCreateBody,
  ManagedMediaCreateResponse,
  ManagedMediaStatusResponse,
  ManagedMediaListResponse,
  ManagedMediaListQuery,
  ManagedMediaDeliveryBody,
  ManagedVideoDeliveryBody,
  ManagedMediaDeliveryAcknowledgment,
} from "./ManagedMediaJobContract";
export { MANAGED_MEDIA_JOB_PROTOCOL } from "./ManagedMediaJobContract";
export type {
  ManagedMediaKind,
  ManagedVideoFrameRole,
  ManagedVideoFrameImage,
  ManagedMediaJobSnapshot,
  ManagedImageCreateBody,
  ManagedVideoCreateBody,
  ManagedMediaCreateResponse,
  ManagedMediaStatusResponse,
  ManagedMediaListResponse,
  ManagedMediaListQuery,
  ManagedMediaDeliveryBody,
  ManagedVideoDeliveryBody,
  ManagedMediaDeliveryAcknowledgment,
} from "./ManagedMediaJobContract";

// Server-authored codes and messages are still untrusted input: only a small
// character set and bounded length may reach users or logs.
const SERVER_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SERVER_MESSAGE_PATTERN = /^[\x20-\x7E]{1,240}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const VIDEO_EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
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

export class ManagedMediaJobClient {
  private readonly decoder: ReturnType<typeof createManagedMediaDecoder>;
  readonly images = {
    prepareInputs: (input_images: Array<{ mime_type: string; size_bytes: number; sha256: string }>, bytes: (index: number) => Promise<ArrayBuffer>, signal?: AbortSignal) => this.prepareInputs(input_images, bytes, signal),
    create: (body: ManagedImageCreateBody, operationId: string, signal?: AbortSignal) => { this.decoder.validateImageCreate(body); return this.create("image", body, operationId, signal); },
    status: (jobId: string, signal?: AbortSignal): Promise<ManagedMediaStatusResponse<ManagedImageOutputMetadata>> => this.status("image", jobId, signal) as Promise<ManagedMediaStatusResponse<ManagedImageOutputMetadata>>,
    list: (query: ManagedMediaListQuery = {}, signal?: AbortSignal): Promise<ManagedMediaListResponse<ManagedImageOutputMetadata>> => this.list("image", query, signal) as Promise<ManagedMediaListResponse<ManagedImageOutputMetadata>>,
    downloadOutput: (jobId: string, outputIndex: number, expected: ManagedImageOutputMetadata, signal?: AbortSignal): Promise<ManagedDeliveredImageOutputBytes> => this.download("image", jobId, outputIndex, expected, signal) as Promise<ManagedDeliveredImageOutputBytes>,
    acknowledgeDelivery: (jobId: string, body: ManagedMediaDeliveryBody, signal?: AbortSignal): Promise<ManagedMediaDeliveryAcknowledgment> => this.acknowledgeDelivery("image", jobId, body, signal),
  };
  readonly videos = {
    create: (body: ManagedVideoCreateBody, operationId: string, signal?: AbortSignal) => { this.decoder.validateVideoCreate(body); return this.create("video", body, operationId, signal); },
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
  ) {
    this.decoder = createManagedMediaDecoder(malformed, invalid, () => this.now());
  }

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
    const retryAfterMs = result.diagnostics.retryAfterMs;
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

  private throwTerminal(kind: ManagedMediaKind, job: Pick<ManagedMediaJobSnapshot, "id" | "status" | "error">, status: number, requestId: string): void {
    if (job.status === "expired") throw new ManagedMediaJobError("job_expired", "The managed job expired.", status, requestId, false, { jobId: job.id, code: job.error?.code ?? null });
    if (job.status === "failed") {
      const code = kind === "video" ? "video_generation_failed" : "image_generation_failed";
      throw new ManagedMediaJobError(code, job.error?.message ?? "Managed job failed.", status, requestId, false, { jobId: job.id, code: job.error?.code ?? null });
    }
  }

  private async create(kind: ManagedMediaKind, body: unknown, operationId: string, signal?: AbortSignal): Promise<ManagedMediaCreateResponse> {
    if (typeof operationId !== "string") invalid("A durable operation ID is required.");
    const { value, result, requestId } = await this.call(kind, { method: "POST", path: JOBS_PATH[kind], body, operationId, signal });
    const response = this.decoder.createResponse(value);
    this.throwTerminal(kind, response.job, result.response.status, requestId);
    return response;
  }

  private async status(kind: ManagedMediaKind, jobId: string, signal?: AbortSignal): Promise<ManagedMediaStatusResponse<ManagedImageOutputMetadata | ManagedVideoOutputMetadata>> {
    if (!JOB_ID_PATTERN.test(jobId)) invalid("Invalid managed media job ID.");
    const { value, result, requestId } = await this.call(kind, { method: "GET", path: `${JOBS_PATH[kind]}/${jobId}`, signal });
    const snapshot = this.decoder.statusResponse(kind, value, jobId);
    this.throwTerminal(kind, snapshot.job, result.response.status, requestId);
    const bodyPollAfterMs = snapshot.poll_after_ms;
    const retryAfterMs = result.diagnostics.retryAfterMs;
    const pollAfterMs = bodyPollAfterMs === undefined && retryAfterMs === undefined
      ? undefined
      : Math.max(bodyPollAfterMs ?? 0, retryAfterMs ?? 0);
    const serverTimeMs = Date.parse(result.response.headers.get("date") ?? "");
    return {
      ...snapshot,
      ...(Number.isFinite(serverTimeMs) ? { serverTimeMs } : {}),
      ...(pollAfterMs === undefined ? {} : { poll_after_ms: pollAfterMs }),
    };
  }

  private async list(kind: ManagedMediaKind, query: ManagedMediaListQuery, signal?: AbortSignal): Promise<ManagedMediaListResponse<ManagedImageOutputMetadata | ManagedVideoOutputMetadata>> {
    const suffix = this.decoder.listQuery(query);
    const { value } = await this.call(kind, { method: "GET", path: `${JOBS_PATH[kind]}${suffix ? `?${suffix}` : ""}`, signal });
    return this.decoder.listResponse(kind, value);
  }

  private async download(kind: ManagedMediaKind, jobId: string, outputIndex: number, expected: ManagedImageOutputMetadata | ManagedVideoOutputMetadata, signal?: AbortSignal): Promise<ManagedDeliveredImageOutputBytes | ManagedDeliveredVideoOutputBytes> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!JOB_ID_PATTERN.test(jobId) || !Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex > 3) invalid("Invalid managed media output identity.");
    let validated: ManagedImageOutputMetadata | ManagedVideoOutputMetadata;
    try { validated = this.decoder.outputMetadata(kind, expected); } catch { invalid("Invalid expected media output metadata."); }
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
    const bytes = await readVerifiedManagedOutput(response, validated, signal, reason => malformed(`Managed media output ${reason}.`));
    const localRequestCompletedAtMs = this.elapsedNow();
    const localRequestElapsedMs = Math.max(0, localRequestCompletedAtMs - localRequestStartedAtMs);
    const downloadCompletedOffsetMs = Math.min(MEDIA_DELIVERY_MAX_OFFSET_MS, Math.max(0, Math.round(
      downloadRequestedAt === null
        ? this.now() - downloadStartedAtMs
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
    const normalized = this.decoder.deliveryBody(kind, body);
    const { value } = await this.call(kind, {
      method: "POST",
      path: `${JOBS_PATH[kind]}/${jobId}/delivery`,
      body: normalized,
      signal,
    });
    return this.decoder.deliveryResponse(value);
  }

  private async prepareInputs(input_images: Array<{ mime_type: string; size_bytes: number; sha256: string }>, bytes: (index: number) => Promise<ArrayBuffer>, signal?: AbortSignal): Promise<{ uploadId: string; inputs: ManagedUploadedImageInput[] }> {
    this.decoder.inputImagesRequest(input_images);
    const { value } = await this.call("image", { method: "POST", path: "/api/plugin/images/inputs/prepare", body: { input_images }, signal });
    const { uploadId, inputs, uploads } = this.decoder.preparedInputsResponse(value, input_images);
    for (const item of uploads) {
      const body = await bytes(item.index);
      if (!(body instanceof ArrayBuffer) || body.byteLength !== item.size_bytes) invalid("Input bytes do not match declared size.");
      await this.transport.uploadSignedInput(item.url, "PUT", item.headers, body, signal);
    }
    return { uploadId, inputs };
  }


}
