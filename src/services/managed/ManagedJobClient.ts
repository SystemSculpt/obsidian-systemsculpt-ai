import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";
import { MANAGED_CAPABILITY_CONTRACT, ManagedJobCapability, ManagedJobStatus, ManagedTransportResult } from "./ManagedTypes";
import { parseRetryAfterMs } from "../../utils/retryAfter";
import { CREDITS_REQUIRED_MESSAGE } from "../../utils/errors";

/** @internal Tests assert against this value. */
export const MANAGED_JOB_PROTOCOL = "managed-job-protocol-v1" as const;
// Bounds only the transfer of a completed document, never server processing.
const DOCUMENT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
type MultipartJobCapability = Exclude<ManagedJobCapability, "image_generation">;
type Operation = "create" | "part_url" | "upload_complete" | "upload_abort" | "start" | "status" | "download";
type ErrorCode = "invalid_request" | "license_required" | "payment_required" | "license_rejected" | "operation_conflict" | "upgrade_required" | "rate_limited" | "temporarily_unavailable" | "managed_job_error" | "malformed_response" | "unsupported_operation" | "transcription_failed" | "document_processing_failed" | "job_expired";
const MANAGED_JOB_HTTP_ERROR_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  402: CREDITS_REQUIRED_MESSAGE,
  429: "SystemSculpt is receiving too many processing requests right now.",
  502: "SystemSculpt processing is temporarily unavailable.",
  503: "SystemSculpt processing is temporarily unavailable.",
});
export class ManagedJobError extends Error { constructor(public readonly code: ErrorCode, message: string, public readonly status?: number, public readonly requestId: string | null = null, public readonly retryable = false, public readonly jobFailure: { jobId: string | null; code: string | null } | null = null, public readonly retryAfterMs?: number) { super(message); this.name = "ManagedJobError"; } }

// Server-authored job failure detail. Codes and messages come from the
// managed API's fixed public taxonomy, but treat them as untrusted input:
// only a small character set and bounded length may reach users or logs.
const JOB_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const JOB_ERROR_MESSAGE_PATTERN = /^[\x20-\x7E]{1,240}$/;
function jobFailureDetail(holder: unknown): { jobId: string | null; code: string | null; message: string | null } {
  const record = holder && typeof holder === "object" && !Array.isArray(holder) ? holder as JsonObject : null;
  const jobId = record && typeof record.id === "string" && record.id.length <= 256 ? record.id : null;
  const error = record && record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as JsonObject : null;
  const code = error && typeof error.code === "string" && JOB_ERROR_CODE_PATTERN.test(error.code) ? error.code : null;
  const message = error && typeof error.message === "string" && JOB_ERROR_MESSAGE_PATTERN.test(error.message) ? error.message : null;
  return { jobId, code, message };
}

/** @internal Tests assert against this value. */
export const MANAGED_JOB_OPERATION_STATUSES = {
  transcription: { create: ["uploading"], upload_complete: ["queued"], upload_abort: ["failed"], start: ["queued", "processing", "succeeded", "failed"], status: ["uploading", "queued", "processing", "succeeded", "failed", "expired"] },
  document_processing: { create: ["uploading"], upload_complete: ["queued"], upload_abort: ["failed"], start: ["queued", "processing", "completed", "failed"], status: ["uploading", "queued", "processing", "completed", "failed"] },
} as const;

/** @internal Tests assert against this value. */
export const MANAGED_JOB_DESCRIPTORS: Record<MultipartJobCapability, { paths: Partial<Record<Operation, [string, string]>>; statuses: ManagedJobStatus[]; version: Operation[]; idempotent: Operation[] }> = {
  transcription: { paths: { create: ["POST", "/api/plugin/audio/transcriptions/jobs"], part_url: ["GET", "/api/plugin/audio/transcriptions/jobs/{jobId}/upload/part-url"], upload_complete: ["POST", "/api/plugin/audio/transcriptions/jobs/{jobId}/upload/complete"], upload_abort: ["POST", "/api/plugin/audio/transcriptions/jobs/{jobId}/upload/abort"], start: ["POST", "/api/plugin/audio/transcriptions/jobs/{jobId}/start"], status: ["GET", "/api/plugin/audio/transcriptions/jobs/{jobId}"] }, statuses: ["uploading", "queued", "processing", "succeeded", "failed", "expired"], version: ["create", "upload_complete", "start"], idempotent: ["create", "upload_complete", "start"] },
  document_processing: { paths: { create: ["POST", "/api/plugin/documents/jobs"], part_url: ["GET", "/api/plugin/documents/jobs/{documentId}/upload/part-url"], upload_complete: ["POST", "/api/plugin/documents/jobs/{documentId}/upload/complete"], upload_abort: ["POST", "/api/plugin/documents/jobs/{documentId}/upload/abort"], start: ["POST", "/api/plugin/documents/jobs/{documentId}/start"], status: ["GET", "/api/plugin/documents/{documentId}"], download: ["GET", "/api/plugin/documents/{documentId}/download"] }, statuses: ["uploading", "queued", "processing", "completed", "failed"], version: ["create", "upload_complete", "start"], idempotent: ["create", "upload_complete", "start"] },
};

type JsonObject = Record<string, unknown>;
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): JsonObject => { if (!value || typeof value !== "object" || Array.isArray(value)) malformed(); const object = value as JsonObject; const allowed = new Set([...required, ...optional]); if (required.some(k => !(k in object)) || Object.keys(object).some(k => !allowed.has(k))) malformed(); return object; };
const string = (v: unknown, max = 2048) => { if (typeof v !== "string" || v.length < 1 || v.length > max) malformed(); return v; };
const integer = (v: unknown, min: number, max: number) => { if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) malformed(); return v as number; };
const date = (v: unknown) => { const s = string(v, 64); if (!Number.isFinite(Date.parse(s))) malformed(); return s; };
function malformed(message = "Malformed managed job response."): never { throw new ManagedJobError("malformed_response", message); }

export class ManagedJobClient {
  readonly transcription = {
    create: (body: { filename: string; contentType: string; contentLengthBytes: number; timestamped?: boolean; language?: string }, operationId: string, signal?: AbortSignal) => { this.validateCreate(body, 524288000, ["filename", "contentType", "contentLengthBytes", "timestamped", "language"]); if (body.timestamped !== undefined && typeof body.timestamped !== "boolean" || body.language !== undefined && (typeof body.language !== "string" || body.language.length > 64)) this.invalid(); return this.call("transcription", "create", { body, operationId, signal }); },
    uploadPart: (jobId: string, partNumber: number, bytes: ArrayBuffer, signal?: AbortSignal) => this.uploadPart("transcription", jobId, partNumber, bytes, 50, signal),
    complete: (jobId: string, parts: Array<{ partNumber: number; etag: string }>, operationId: string, signal?: AbortSignal) => { this.parts(parts, 50); return this.call("transcription", "upload_complete", { jobId, body: { parts }, operationId, signal }); },
    abortUpload: (jobId: string, signal?: AbortSignal) => this.call("transcription", "upload_abort", { jobId, signal }), start: (jobId: string, operationId: string, signal?: AbortSignal) => this.call("transcription", "start", { jobId, operationId, signal }), status: (jobId: string, signal?: AbortSignal) => this.call("transcription", "status", { jobId, signal }), resume: (jobId: string, signal?: AbortSignal) => this.call("transcription", "status", { jobId, signal }), cancel: async () => { throw new ManagedJobError("unsupported_operation", "Server processing cancellation is unsupported."); },
  };
  readonly documents = {
    create: (body: { filename: string; contentType: string; contentLengthBytes: number }, operationId: string, signal?: AbortSignal) => { this.validateCreate(body, 26214400, ["filename", "contentType", "contentLengthBytes"]); if (!["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"].includes(body.contentType)) this.invalid(); return this.call("document_processing", "create", { body, operationId, signal }); },
    uploadPart: (jobId: string, partNumber: number, bytes: ArrayBuffer, signal?: AbortSignal) => this.uploadPart("document_processing", jobId, partNumber, bytes, 3, signal),
    complete: (jobId: string, parts: Array<{ partNumber: number; etag: string }>, operationId: string, signal?: AbortSignal) => { this.parts(parts, 3); return this.call("document_processing", "upload_complete", { jobId, body: { parts }, operationId, signal }); },
    abortUpload: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "upload_abort", { jobId, signal }), start: (jobId: string, operationId: string, signal?: AbortSignal) => this.call("document_processing", "start", { jobId, operationId, signal }), status: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "status", { jobId, signal }), download: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "download", { jobId, signal }), resume: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "status", { jobId, signal }), cancel: async () => { throw new ManagedJobError("unsupported_operation", "Server processing cancellation is unsupported."); },
  };
  constructor(private readonly transport: HostedTransportAdapter, private readonly now: () => number = () => Date.now()) {}

  private async uploadPart(capability: "transcription" | "document_processing", jobId: string, partNumber: number, bytes: ArrayBuffer, maxParts: number, signal?: AbortSignal): Promise<{ partNumber: number; etag: string }> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); this.partNumber(partNumber, maxParts); if (!(bytes instanceof ArrayBuffer)) this.invalid("Multipart bytes must be an ArrayBuffer.");
    const descriptor = MANAGED_JOB_DESCRIPTORS[capability].paths.part_url!; let path = descriptor[1].replace("{jobId}", encodeURIComponent(jobId)).replace("{documentId}", encodeURIComponent(jobId)); path += `?partNumber=${partNumber}`;
    const headers = { "x-systemsculpt-contract": MANAGED_CAPABILITY_CONTRACT, "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-capability": capability };
    const response = await this.transport.job({ path, method: descriptor[0], headers, signal }); const parsed = await this.parse(capability, "part_url", response) as { internal: { partNumber: number; method: string; url: string; expectedBytes: number } };
    if (parsed.internal.partNumber !== partNumber) malformed("Multipart part identity mismatch.");
    if (bytes.byteLength !== parsed.internal.expectedBytes) this.invalid("Multipart bytes do not match expected length."); const upload = await this.transport.uploadSignedJobPart(parsed.internal.url, parsed.internal.method, {}, bytes, signal);
    if (!upload.ok) throw new ManagedJobError("managed_job_error", `Signed part upload failed (${upload.status}).`, upload.status, upload.headers.get("x-request-id"), upload.status >= 500 || upload.status === 429, null, parseRetryAfterMs(upload.headers.get("retry-after")));
    const etag = upload.headers.get("etag"); if (!etag || !/^"?[A-Fa-f0-9]{8,128}(?:-[1-9][0-9]{0,9})?"?$/.test(etag) || (etag.startsWith('"') !== etag.endsWith('"'))) malformed("Invalid multipart ETag."); return { partNumber, etag };
  }

  private invalid(message = "Invalid managed job request."): never { throw new ManagedJobError("invalid_request", message); }
  private validateCreate(v: { filename: string; contentType: string; contentLengthBytes: number }, max: number, allowed: string[]) { if (!v || Object.keys(v).some(key => !allowed.includes(key)) || typeof v.filename !== "string" || v.filename.length < 1 || v.filename.length > 512 || typeof v.contentType !== "string" || v.contentType.length < 1 || !Number.isInteger(v.contentLengthBytes) || v.contentLengthBytes < 1 || v.contentLengthBytes > max) this.invalid(); }
  private partNumber(n: number, max: number) { if (!Number.isInteger(n) || n < 1 || n > max) this.invalid(); }
  private parts(parts: Array<{ partNumber: number; etag: string }>, max: number) { if (!Array.isArray(parts) || parts.length < 1 || parts.length > max || new Set(parts.map(p => p.partNumber)).size !== parts.length || parts.some(p => !Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > max || typeof p.etag !== "string" || !/^"?[A-Fa-f0-9]{8,128}(?:-[1-9][0-9]{0,9})?"?$/.test(p.etag) || (p.etag.startsWith('"') !== p.etag.endsWith('"')))) this.invalid(); }
  private async call<T = unknown>(capability: MultipartJobCapability, operation: Operation, options: { jobId?: string; body?: unknown; operationId?: string; signal?: AbortSignal }): Promise<T> {
    const descriptor = MANAGED_JOB_DESCRIPTORS[capability], route = descriptor.paths[operation]; if (!route) throw new ManagedJobError("unsupported_operation", `${capability}.${operation} is unsupported.`);
    if (options.jobId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(options.jobId)) this.invalid("Invalid first-party job ID.");
    const path = route[1].replace("{jobId}", encodeURIComponent(options.jobId ?? "")).replace("{documentId}", encodeURIComponent(options.jobId ?? ""));
    const headers: Record<string, string> = { "x-systemsculpt-contract": MANAGED_CAPABILITY_CONTRACT, "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-capability": capability };
    if (descriptor.version.includes(operation)) headers["x-plugin-version"] = this.transport.pluginVersion;
    if (descriptor.idempotent.includes(operation)) { if (!options.operationId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.operationId)) this.invalid("A durable operation ID is required."); const idempotencyOperation = operation === "upload_complete" ? "complete" : operation; const idempotencyKey = `${options.operationId}:${idempotencyOperation}`; if (idempotencyKey.length > 128) this.invalid("The durable operation ID is too long for the idempotency contract."); headers["idempotency-key"] = idempotencyKey; }
    // Inline Markdown and images have no declared transfer size. Give the
    // response body a generous backstop; timeout is a retriable transport
    // failure, so callers retain the admitted operation for recovery.
    const result = await this.transport.job({ path, method: route[0], body: options.body, headers, signal: options.signal, ...(operation === "download" ? { timeoutMs: DOCUMENT_DOWNLOAD_TIMEOUT_MS } : {}) });
    const parsed = await this.parse(capability, operation, result) as T;
    if (
      operation === "status"
      && parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && !Object.prototype.hasOwnProperty.call(parsed, "poll_after_ms")
    ) {
      const pollAfterMs = result.diagnostics.retryAfterMs;
      if (pollAfterMs !== undefined) {
        return { ...parsed, poll_after_ms: pollAfterMs };
      }
    }
    return parsed;
  }

  private async parse(capability: MultipartJobCapability, operation: Operation, result: ManagedTransportResult): Promise<unknown> {
    if (!result.response.ok) { const map: Record<number, [ErrorCode, boolean]> = { 400: ["invalid_request", false], 401: ["license_required", false], 402: ["payment_required", false], 403: ["license_rejected", false], 409: ["operation_conflict", false], 426: ["upgrade_required", false], 429: ["rate_limited", true], 502: ["temporarily_unavailable", true], 503: ["temporarily_unavailable", true] }; const [code, retryable] = map[result.response.status] ?? ["managed_job_error", false]; const message = MANAGED_JOB_HTTP_ERROR_MESSAGES[result.response.status] ?? `Managed job request failed (${result.response.status}).`; throw new ManagedJobError(code, message, result.response.status, result.diagnostics.requestId, retryable, null, result.diagnostics.retryAfterMs); }
    let value: unknown; try { value = await result.response.json(); } catch { malformed("Expected a JSON response."); }
    const parsed = this.validateResponse(capability, operation, value); const terminal = operation === "upload_abort" ? null : this.terminalError(capability, parsed);
    if (terminal) {
      const holder = (parsed as { job?: unknown; document?: unknown } | null)?.job ?? (parsed as { document?: unknown } | null)?.document;
      const detail = jobFailureDetail(holder);
      const fallback = terminal === "job_expired" ? "The managed job expired." : "Managed job failed.";
      const message = terminal === "job_expired" ? fallback : detail.message ?? fallback;
      throw new ManagedJobError(terminal, message, result.response.status, result.diagnostics.requestId, false, { jobId: detail.jobId, code: detail.code });
    }
    return parsed;
  }

  private terminalError(c: MultipartJobCapability, value: unknown): ErrorCode | null { const root = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; const holderValue = root.job ?? root.document; const holder = holderValue && typeof holderValue === "object" && !Array.isArray(holderValue) ? holderValue as JsonObject : {}; const status = holder.status; if (status === "expired") return "job_expired"; if (status === "failed") return c === "transcription" ? "transcription_failed" : "document_processing_failed"; return null; }
  private job(value: unknown, statuses: readonly ManagedJobStatus[], keys: string[]) { const x = exact(value, keys); string(x.id, 256); if (!statuses.includes(x.status as ManagedJobStatus)) malformed(); for (const key of keys) { const v = x[key]; if (["created_at", "expires_at"].includes(key)) date(v); else if (["processing_started_at", "completed_at"].includes(key) && v !== null) date(v); else if (["filename", "content_type"].includes(key)) string(v, 512); else if (key === "content_length_bytes") integer(v, 1, 524288000); else if (key === "attempt_count") integer(v, 0, 100); else if (key === "progress" && (typeof v !== "number" || v < 0 || v > 1)) malformed(); else if (key === "error" && v !== null && (typeof v !== "object" || Array.isArray(v))) malformed(); } return x; }
  private upload(value: unknown, document = false) { const keys = ["part_size_bytes", "total_parts", "part_url_expires_in_seconds", ...(document ? ["expires_at"] : [])]; const x = exact(value, keys); integer(x.part_size_bytes, 1, 524288000); integer(x.total_parts, 1, document ? 3 : 50); if (x.part_url_expires_in_seconds !== 900) malformed(); if (document) { const expiresAt = date(x.expires_at); if (Date.parse(expiresAt) <= this.now()) malformed(); } return x; }
  private validateResponse(c: MultipartJobCapability, op: Operation, value: unknown): unknown {
    const statuses = ((MANAGED_JOB_OPERATION_STATUSES[c] as Record<string, readonly ManagedJobStatus[]>)[op] ?? MANAGED_JOB_DESCRIPTORS[c].statuses);
    if (op === "part_url") { const root = exact(value, ["part"]), p = exact(root.part, ["part_number", "method", "url", "url_expires_in_seconds", "expected_content_length_bytes"]); const part_number = integer(p.part_number, 1, c === "document_processing" ? 3 : 50); if (p.method !== "PUT") malformed(); const signedUrl = string(p.url, 2048); if (!/^https:\/\//.test(signedUrl)) malformed(); if (p.url_expires_in_seconds !== 900) malformed(); const expected_content_length_bytes = integer(p.expected_content_length_bytes, 1, 524288000); return { internal: { partNumber: part_number, method: "PUT", url: signedUrl, expectedBytes: expected_content_length_bytes } }; }
    if (c === "transcription") {
      if (op === "create") { const root = exact(value, ["job", "upload"]); return { job: this.job(root.job, statuses, ["id", "status", "filename", "content_type", "content_length_bytes", "expires_at"]), upload: this.upload(root.upload) }; }
      if (op === "status") { const root = exact(value, ["job", "transcript", "progress"]); if (root.transcript !== null && typeof root.transcript !== "string") malformed(); if (typeof root.progress !== "number" || root.progress < 0 || root.progress > 1) malformed(); return { job: this.job(root.job, statuses, ["id", "status", "filename", "content_type", "content_length_bytes", "expires_at", "error"]), transcript: root.transcript, progress: root.progress }; }
      const root = exact(value, ["job"], op === "start" ? ["transcript_urls", "usage_summary"] : []); return { job: this.job(root.job, statuses, ["id", "status"]) };
    }
    if (c === "document_processing") {
      if (op === "download") { const root = exact(value, ["result"]), result = exact(root.result, ["content", "text", "markdown", "images", "metadata"]); if (!Array.isArray(result.content) || typeof result.text !== "string" || typeof result.markdown !== "string" || !Array.isArray(result.images) || !result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata)) malformed(); return { result }; }
      if (op === "create") { const root = exact(value, ["document", "upload"]); return { document: this.job(root.document, statuses, ["id", "status"]), upload: this.upload(root.upload, true) }; }
      const root = exact(value, ["document"]); return { document: this.job(root.document, statuses, op === "status" ? ["id", "status", "error", "progress"] : ["id", "status"]) };
    }
    return malformed();
  }
}
