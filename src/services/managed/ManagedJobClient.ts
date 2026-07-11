import { HostedTransportAdapter } from "./adapters/HostedTransportAdapter";
import { MANAGED_CAPABILITY_CONTRACT, ManagedJobCapability, ManagedJobStatus, ManagedTransportResult } from "./ManagedTypes";

export const MANAGED_JOB_PROTOCOL = "managed-job-protocol-v1" as const;

type Operation = "create" | "part_url" | "upload_complete" | "upload_abort" | "start" | "status" | "download" | "input_prepare" | "generation_create" | "generation_list" | "generation_status";
type JobErrorCode = "managed_job_error" | "malformed_response" | "unsupported_operation" | "invalid_request";
export class ManagedJobError extends Error {
  constructor(public readonly code: JobErrorCode, message: string, public readonly status?: number, public readonly requestId?: string | null) { super(message); this.name = "ManagedJobError"; }
}

export const MANAGED_JOB_DESCRIPTORS: Record<ManagedJobCapability, { paths: Partial<Record<Operation, [string, string]>>; statuses: ManagedJobStatus[]; version: Operation[]; idempotent: Operation[] }> = {
  transcription: {
    paths: { create: ["POST", "/api/plugin/audio/transcriptions/jobs"], part_url: ["GET", "/api/plugin/audio/transcriptions/jobs/{jobId}/upload/part-url"], upload_complete: ["POST", "/api/plugin/audio/transcriptions/jobs/{jobId}/upload/complete"], upload_abort: ["POST", "/api/plugin/audio/transcriptions/jobs/{jobId}/upload/abort"], start: ["POST", "/api/plugin/audio/transcriptions/jobs/{jobId}/start"], status: ["GET", "/api/plugin/audio/transcriptions/jobs/{jobId}"] },
    statuses: ["uploading", "queued", "processing", "succeeded", "failed", "expired"], version: ["create", "upload_complete", "start"], idempotent: ["create", "upload_complete", "start"],
  },
  document_processing: {
    paths: { create: ["POST", "/api/plugin/documents/jobs"], part_url: ["GET", "/api/plugin/documents/jobs/{documentId}/upload/part-url"], upload_complete: ["POST", "/api/plugin/documents/jobs/{documentId}/upload/complete"], upload_abort: ["POST", "/api/plugin/documents/jobs/{documentId}/upload/abort"], start: ["POST", "/api/plugin/documents/jobs/{documentId}/start"], status: ["GET", "/api/plugin/documents/{documentId}"], download: ["GET", "/api/plugin/documents/{documentId}/download"] },
    statuses: ["uploading", "queued", "processing", "completed", "failed"], version: ["create", "upload_complete", "start"], idempotent: ["create", "upload_complete", "start"],
  },
  image_generation: {
    paths: { input_prepare: ["POST", "/api/plugin/images/inputs/prepare"], generation_create: ["POST", "/api/plugin/images/generations/jobs"], generation_list: ["GET", "/api/plugin/images/generations/jobs"], generation_status: ["GET", "/api/plugin/images/generations/jobs/{jobId}"] },
    statuses: ["queued", "processing", "succeeded", "failed", "expired"], version: [], idempotent: [],
  },
};

export class ManagedJobClient {
  readonly transcription = {
    create: (body: { filename: string; contentType: string; contentLengthBytes: number; timestamped?: boolean; language?: string }, operationId: string, signal?: AbortSignal) => this.call("transcription", "create", { body, operationId, signal }),
    partUrl: (jobId: string, partNumber: number, signal?: AbortSignal) => this.call("transcription", "part_url", { jobId, query: `partNumber=${partNumber}`, signal }),
    complete: (jobId: string, parts: Array<{ partNumber: number; etag: string }>, operationId: string, signal?: AbortSignal) => this.call("transcription", "upload_complete", { jobId, body: { parts }, operationId, signal }),
    abortUpload: (jobId: string, signal?: AbortSignal) => this.call("transcription", "upload_abort", { jobId, signal }),
    start: (jobId: string, operationId: string, signal?: AbortSignal) => this.call("transcription", "start", { jobId, operationId, signal }),
    status: (jobId: string, signal?: AbortSignal) => this.call("transcription", "status", { jobId, signal }),
    resume: (jobId: string, signal?: AbortSignal) => this.call("transcription", "status", { jobId, signal }),
    cancel: async () => { throw new ManagedJobError("unsupported_operation", "Server processing cancellation is unsupported."); },
  };
  readonly documents = {
    create: (body: { filename: string; contentType: string; contentLengthBytes: number }, operationId: string, signal?: AbortSignal) => this.call("document_processing", "create", { body, operationId, signal }),
    partUrl: (jobId: string, partNumber: number, signal?: AbortSignal) => this.call("document_processing", "part_url", { jobId, query: `partNumber=${partNumber}`, signal }),
    complete: (jobId: string, parts: Array<{ partNumber: number; etag: string }>, operationId: string, signal?: AbortSignal) => this.call("document_processing", "upload_complete", { jobId, body: { parts }, operationId, signal }),
    abortUpload: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "upload_abort", { jobId, signal }),
    start: (jobId: string, operationId: string, signal?: AbortSignal) => this.call("document_processing", "start", { jobId, operationId, signal }),
    status: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "status", { jobId, signal }),
    download: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "download", { jobId, signal }),
    resume: (jobId: string, signal?: AbortSignal) => this.call("document_processing", "status", { jobId, signal }),
    cancel: async () => { throw new ManagedJobError("unsupported_operation", "Server processing cancellation is unsupported."); },
  };
  readonly images = {
    prepareInputs: async (input_images: Array<{ mime_type: string; size_bytes: number; sha256: string }>, upload: (value: { index: number; method: string; url: string; headers: Record<string, string>; expiresAt: string }) => Promise<void>, signal?: AbortSignal) => {
      const result: any = await this.call("image_generation", "input_prepare", { body: { input_images }, signal });
      if (!Array.isArray(result.input_uploads)) throw new ManagedJobError("malformed_response", "Missing input_uploads.");
      for (const item of result.input_uploads) {
        const u = item?.upload; if (!u || typeof u.url !== "string" || u.url.length > 2048 || typeof u.expires_at !== "string" || Date.parse(u.expires_at) <= Date.now()) throw new ManagedJobError("malformed_response", "Invalid signed upload.");
        await upload({ index: item.index, method: u.method, url: u.url, headers: u.headers ?? {}, expiresAt: u.expires_at });
      }
      return { uploadId: result.upload_id as string, inputs: result.input_uploads.map((x: any) => x.input_image) };
    },
    create: (body: unknown, operationId?: string, signal?: AbortSignal) => this.call("image_generation", "generation_create", { body, optionalIdempotencyKey: operationId ? `${operationId}:create` : undefined, signal }),
    status: (jobId: string, signal?: AbortSignal) => this.call("image_generation", "generation_status", { jobId, signal }),
    list: (query = "", signal?: AbortSignal) => this.call("image_generation", "generation_list", { query, signal }),
    resume: async (_jobId: string) => { throw new ManagedJobError("unsupported_operation", "Image processing resume is unsupported."); },
    cancel: async (_jobId: string) => { throw new ManagedJobError("unsupported_operation", "Image cancellation is unsupported."); },
  };

  constructor(private readonly transport: HostedTransportAdapter) {}

  private async call(capability: ManagedJobCapability, operation: Operation, options: { jobId?: string; query?: string; body?: unknown; operationId?: string; optionalIdempotencyKey?: string; signal?: AbortSignal }): Promise<any> {
    const descriptor = MANAGED_JOB_DESCRIPTORS[capability]; const route = descriptor.paths[operation];
    if (!route) throw new ManagedJobError("unsupported_operation", `${capability}.${operation} is unsupported.`);
    let path = route[1].replace("{jobId}", encodeURIComponent(options.jobId ?? "")).replace("{documentId}", encodeURIComponent(options.jobId ?? ""));
    if (options.query) path += `?${options.query}`;
    const headers: Record<string, string> = { "x-systemsculpt-contract": MANAGED_CAPABILITY_CONTRACT, "x-systemsculpt-job-contract": MANAGED_JOB_PROTOCOL, "x-systemsculpt-capability": capability };
    if (descriptor.version.includes(operation)) headers["x-plugin-version"] = (this.transport as any).options.pluginVersion;
    if (descriptor.idempotent.includes(operation)) {
      if (!options.operationId) throw new ManagedJobError("invalid_request", "A durable operation ID is required.");
      const suffix = operation === "upload_complete" ? "complete" : operation;
      headers["idempotency-key"] = `${options.operationId}:${suffix}`;
    } else if (options.optionalIdempotencyKey) headers["idempotency-key"] = options.optionalIdempotencyKey;
    const result = await this.transport.job({ path, method: route[0], body: options.body, headers, signal: options.signal });
    return this.parse(capability, operation, result);
  }

  private async parse(capability: ManagedJobCapability, operation: Operation, result: ManagedTransportResult): Promise<any> {
    if (!result.response.ok) throw new ManagedJobError("managed_job_error", `Managed job request failed (${result.response.status}).`, result.response.status, result.diagnostics.requestId);
    let value: any; try { value = await result.response.json(); } catch { throw new ManagedJobError("malformed_response", "Expected a JSON response.", result.response.status, result.diagnostics.requestId); }
    const statuses = MANAGED_JOB_DESCRIPTORS[capability].statuses;
    const jobs = [value?.job, ...(Array.isArray(value?.items) ? value.items.map((x: any) => x?.job) : [])].filter(Boolean);
    for (const job of jobs) if (typeof job.id !== "string" || !statuses.includes(job.status)) throw new ManagedJobError("malformed_response", "Invalid job status response.", result.response.status, result.diagnostics.requestId);
    if (operation !== "input_prepare" && operation !== "generation_list" && jobs.length === 0 && operation !== "download") throw new ManagedJobError("malformed_response", "Missing job response.", result.response.status, result.diagnostics.requestId);
    return value;
  }
}
