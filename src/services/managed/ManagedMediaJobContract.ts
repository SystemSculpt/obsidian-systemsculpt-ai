import type { ManagedUploadedImageInput, ManagedImageOutputMetadata, ManagedVideoOutputMetadata, ManagedMediaUsage } from "./ManagedTypes";
import { MANAGED_IMAGE_OUTPUT_MAX_BYTES, MANAGED_VIDEO_OUTPUT_MAX_BYTES } from "./ManagedTypes";
import { MANAGED_MEDIA_DELIVERY_MAX_OFFSET_MS as MEDIA_DELIVERY_MAX_OFFSET_MS } from "./ManagedMediaDeliveryTiming";

/**
 * managed-job-protocol-v2 — the negotiated media contract that adds model
 * selection, video generation, and synthesized progress fields
 * (typical_duration_ms). Audio and documents retain their strict
 * managed-job-protocol-v1 parser in ManagedJobClient; media never shares
 * parsing state with it.
 * @internal Tests assert against this value.
 */
export const MANAGED_MEDIA_JOB_PROTOCOL = "managed-job-protocol-v2" as const;

export type ManagedMediaKind = "image" | "video";
type ManagedMediaJobStatus = "queued" | "processing" | "succeeded" | "failed" | "expired";
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
  options?: { count?: number; aspect_ratio?: string; image_size?: string; quality?: string; background?: string; seed?: number };
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
  /** HTTP Date as observation metadata; never read from the response body. */
  serverTimeMs?: number;
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
const UPLOADED_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
// Image models publish their own aspect/size matrices via the server catalog,
// so the client checks shape only ('auto', 'match_input_image', or W:H with
// optional decimals; a pixel/K size token) and the server enforces membership.
const IMAGE_ASPECT_RATIO_PATTERN = /^\d{1,2}(\.\d{1,2})?:\d{1,2}(\.\d{1,2})?$/;
const VIDEO_ASPECT_RATIO_PATTERN = /^[0-9]{1,2}:[0-9]{1,2}$/;
const IMAGE_SIZE_PATTERN = /^\d{1,4}(\.\d{1,2})?K?$/i;
// Quality and background values are model-specific; the server checks membership.
const IMAGE_OPTION_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;
const MEDIA_STATUSES: readonly ManagedMediaJobStatus[] = ["queued", "processing", "succeeded", "failed", "expired"];

type JsonObject = Record<string, unknown>;
type DecodeFailure = (message?: string) => never;
type ImageInput = { mime_type: string; size_bytes: number; sha256: string };

/**
 * Owns the strict v2 media contract, not HTTP dispatch or verified byte delivery.
 * Keep its exact envelopes distinct from additive catalog/admission contracts.
 */
export function createManagedMediaDecoder(malformed: DecodeFailure, invalid: DecodeFailure, now: () => number) {
  function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
    const object = value as JsonObject;
    const allowed = new Set([...required, ...optional]);
    if (required.some(key => !(key in object)) || Object.keys(object).some(key => !allowed.has(key))) malformed();
    return object;
  }

  function string(value: unknown, max = 2048): string {
    if (typeof value !== "string" || value.length < 1 || value.length > max) malformed();
    return value;
  }

  function integer(value: unknown, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) malformed();
    return value as number;
  }

  function requestInteger(value: unknown, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) invalid();
    return value as number;
  }

  function date(value: unknown): string {
    const text = string(value, 64);
    if (!Number.isFinite(Date.parse(text))) malformed();
    return text;
  }

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

  function decodeJob(value: unknown, keys: readonly string[]): ManagedMediaJobSnapshot {
    const job = exact(value, keys);
    string(job.id, 256);
    if (!MEDIA_STATUSES.includes(job.status as ManagedMediaJobStatus)) malformed();
    const model = string(job.model, 160);
    date(job.created_at);
    date(job.expires_at);
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

  function outputMetadata(kind: ManagedMediaKind, value: unknown): ManagedImageOutputMetadata | ManagedVideoOutputMetadata {
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

  function decodeUsage(value: unknown): ManagedMediaUsage {
    const usage = exact(value, ["raw_usd", "cost_source", "estimated"]);
    if (
      typeof usage.raw_usd !== "number"
      || !Number.isFinite(usage.raw_usd)
      || usage.raw_usd < 0
      || typeof usage.estimated !== "boolean"
    ) malformed();
    return { raw_usd: usage.raw_usd, cost_source: string(usage.cost_source, 64), estimated: usage.estimated };
  }

  function item(kind: ManagedMediaKind, value: unknown): { job: ManagedMediaJobSnapshot; outputs: Array<ManagedImageOutputMetadata | ManagedVideoOutputMetadata>; usage: ManagedMediaUsage } {
    const item = exact(value, ["job", "outputs", "usage"]);
    const job = decodeJob(item.job, ["id", "status", "model", "created_at", "processing_started_at", "completed_at", "expires_at", "error", "attempt_count"]);
    if (!Array.isArray(item.outputs)) malformed();
    const outputs = item.outputs.map(raw => outputMetadata(kind, raw));
    if (outputs.length > 4 || new Set(outputs.map(output => output.index)).size !== outputs.length) malformed();
    const usage = decodeUsage(item.usage);
    const status = job.status;
    if ((status === "queued" || status === "processing") && outputs.length !== 0) malformed();
    if (status === "succeeded" && (outputs.length < 1 || job.completed_at === null)) malformed();
    if ((status === "failed" || status === "expired") && outputs.length !== 0) malformed();
    if (status === "processing" && job.processing_started_at === null) malformed();
    if (status === "queued" && job.processing_started_at !== null) malformed();
    return { job, outputs, usage };
  }

  function createResponse(value: unknown): ManagedMediaCreateResponse {
    const root = exact(value, ["job", "poll_url"], ["idempotent_replay"]);
    const pollUrl = string(root.poll_url, 2048);
    if (!pollUrl.startsWith("/") || pollUrl.startsWith("//")) malformed();
    if (root.idempotent_replay !== undefined && typeof root.idempotent_replay !== "boolean") malformed();
    const snapshot = decodeJob(root.job, ["id", "status", "model", "created_at", "expires_at", "error"]);
    return {
      job: { id: snapshot.id, status: snapshot.status, model: snapshot.model, created_at: snapshot.created_at, expires_at: snapshot.expires_at, error: snapshot.error },
      poll_url: pollUrl,
      ...(root.idempotent_replay === undefined ? {} : { idempotent_replay: root.idempotent_replay }),
    };
  }

  function statusResponse(kind: ManagedMediaKind, value: unknown, jobId: string): ManagedMediaStatusResponse<ManagedImageOutputMetadata | ManagedVideoOutputMetadata> {
    const root = exact(value, ["job", "outputs", "usage"], ["poll_after_ms", "typical_duration_ms"]);
    if (root.poll_after_ms !== undefined) integer(root.poll_after_ms, 0, 3600000);
    if (root.typical_duration_ms !== undefined) integer(root.typical_duration_ms, 0, 3600000);
    const snapshot = item(kind, { job: root.job, outputs: root.outputs, usage: root.usage });
    if (snapshot.job.id !== jobId) malformed("Managed media status identity changed.");
    return {
      ...snapshot,
      ...(root.poll_after_ms === undefined ? {} : { poll_after_ms: root.poll_after_ms as number }),
      ...(root.typical_duration_ms === undefined ? {} : { typical_duration_ms: root.typical_duration_ms as number }),
    };
  }

  function listResponse(kind: ManagedMediaKind, value: unknown): ManagedMediaListResponse<ManagedImageOutputMetadata | ManagedVideoOutputMetadata> {
    const root = exact(value, ["items", "next_before"]);
    if (!Array.isArray(root.items)) malformed();
    if (root.next_before !== null) date(root.next_before);
    return { items: root.items.map(raw => item(kind, raw)), next_before: root.next_before as string | null };
  }

  function listQuery(query: ManagedMediaListQuery): string {
    const params = new URLSearchParams();
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid();
      params.set("limit", String(query.limit));
    }
    if (query.before !== undefined) {
      if (!Number.isFinite(Date.parse(query.before))) invalid();
      params.set("before", query.before);
    }
    if (query.status !== undefined) {
      if (!MEDIA_STATUSES.includes(query.status)) invalid();
      params.set("status", query.status);
    }
    return params.toString();
  }

  function deliveryResponse(value: unknown): ManagedMediaDeliveryAcknowledgment {
    const root = exact(value, ["acknowledged", "acknowledged_at"]);
    if (root.acknowledged !== true) malformed("Managed media delivery was not acknowledged.");
    return { acknowledged: true, acknowledged_at: date(root.acknowledged_at) };
  }

  function inputImagesRequest(inputImages: ImageInput[]): void {
    if (!Array.isArray(inputImages) || inputImages.length < 1 || inputImages.length > 4) invalid();
    if (inputImages.some(input => (
      !input
      || Object.keys(input).sort().join() !== "mime_type,sha256,size_bytes"
      || !(IMAGE_MIME_TYPES as readonly string[]).includes(input.mime_type)
      || !Number.isInteger(input.size_bytes)
      || input.size_bytes < 1
      || input.size_bytes > 20971520
      || !SHA256_PATTERN.test(input.sha256)
    ))) invalid();
  }

  function preparedInputsResponse(value: unknown, input_images: ImageInput[]) {
    const root = exact(value, ["contract", "upload_id", "expires_at", "input_uploads"]);
    if (
      root.contract !== "systemsculpt-image-input-upload-v1"
      || !Array.isArray(root.input_uploads)
      || root.input_uploads.length !== input_images.length
    ) malformed();
    const uploadId = string(root.upload_id, 256);
    const rootExpiresAt = date(root.expires_at);
    if (Date.parse(rootExpiresAt) <= now() || Date.parse(rootExpiresAt) - now() > 900_000 + 60_000) malformed();
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
      if (
        !uploadHeaders
        || typeof uploadHeaders !== "object"
        || Array.isArray(uploadHeaders)
        || Object.keys(uploadHeaders).length !== 1
        || (uploadHeaders as JsonObject)["content-type"] !== mimeType
      ) malformed();
      integer(upload.expires_in_seconds, 1, 3600);
      const uploadExpiresAt = date(upload.expires_at);
      if (Date.parse(uploadExpiresAt) <= now() || Date.parse(uploadExpiresAt) > Date.parse(rootExpiresAt) + 1000) malformed();
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
    if (inputs.some((input, index) => (
      !input_images[index]
      || input_images[index].mime_type !== input.mime_type
      || input_images[index].size_bytes !== input.size_bytes
      || input_images[index].sha256 !== input.sha256
    ))) malformed("Prepared inputs do not match request.");
    return { uploadId, inputs, uploads: internalUploads };
  }

  function deliveryBody(
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

  function validateUploadedReference(x: unknown, extraKeys: readonly string[] = []): asserts x is ManagedUploadedImageInput {
    const keys = ["key", "mime_type", "sha256", "size_bytes", "type", ...extraKeys].sort().join();
    const value = x as JsonObject | null;
    if (
      !value
      || typeof value !== "object"
      || Object.keys(value).sort().join() !== keys
      || value.type !== "uploaded"
      || typeof value.key !== "string"
      || value.key.length < 1
      || value.key.length > 512
      || !UPLOADED_KEY_PATTERN.test(value.key)
      || !(IMAGE_MIME_TYPES as readonly string[]).includes(value.mime_type as string)
      || !Number.isInteger(value.size_bytes)
      || (value.size_bytes as number) < 1
      || (value.size_bytes as number) > 20971520
      || typeof value.sha256 !== "string"
      || !SHA256_PATTERN.test(value.sha256)
    ) invalid();
  }

  function validateImageCreate(body: ManagedImageCreateBody): void {
    if (
      !body
      || Object.keys(body).some(k => !["model", "prompt", "input_images", "options"].includes(k))
      || typeof body.prompt !== "string"
      || body.prompt.length < 1
      || body.prompt.length > 8000
    ) invalid();
    if (body.model !== undefined && (typeof body.model !== "string" || !MODEL_PATTERN.test(body.model))) invalid();
    if (body.input_images !== undefined) {
      if (!Array.isArray(body.input_images) || body.input_images.length > 4) invalid();
      for (const input of body.input_images) validateUploadedReference(input);
    }
    if (body.options !== undefined) {
      const options = body.options;
      if (
        !options
        || Object.keys(options).some(k => !["count", "aspect_ratio", "image_size", "quality", "background", "seed"].includes(k))
      ) invalid();
      if (options.count !== undefined && (!Number.isInteger(options.count) || options.count < 1 || options.count > 4)) invalid();
      if (
        options.aspect_ratio !== undefined
        && (
          typeof options.aspect_ratio !== "string"
          || !(
            options.aspect_ratio === "auto"
            || options.aspect_ratio === "match_input_image"
            || IMAGE_ASPECT_RATIO_PATTERN.test(options.aspect_ratio)
          )
        )
      ) invalid();
      if (options.image_size !== undefined && (typeof options.image_size !== "string" || !IMAGE_SIZE_PATTERN.test(options.image_size))) invalid();
      if (options.quality !== undefined && (typeof options.quality !== "string" || !IMAGE_OPTION_TOKEN_PATTERN.test(options.quality))) invalid();
      if (options.background !== undefined && (typeof options.background !== "string" || !IMAGE_OPTION_TOKEN_PATTERN.test(options.background))) invalid();
      if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2147483647)) invalid();
    }
  }

  function validateVideoCreate(body: ManagedVideoCreateBody): void {
    if (
      !body
      || Object.keys(body).some(k => !["model", "prompt", "frame_images", "options"].includes(k))
      || typeof body.prompt !== "string"
      || body.prompt.length < 1
      || body.prompt.length > 8000
    ) invalid();
    if (typeof body.model !== "string" || !MODEL_PATTERN.test(body.model)) invalid();
    if (body.frame_images !== undefined) {
      if (!Array.isArray(body.frame_images) || body.frame_images.length > 2) invalid();
      const roles = new Set<string>();
      for (const frame of body.frame_images) {
        if (!frame || (frame.role !== "first_frame" && frame.role !== "last_frame") || roles.has(frame.role)) invalid();
        roles.add(frame.role);
        validateUploadedReference(frame, ["role"]);
      }
    }
    if (body.options !== undefined) {
      const options = body.options;
      if (
        !options
        || Object.keys(options).some(k => !["duration_seconds", "resolution", "aspect_ratio", "generate_audio", "seed"].includes(k))
      ) invalid();
      if (options.duration_seconds !== undefined && (!Number.isInteger(options.duration_seconds) || options.duration_seconds < 1 || options.duration_seconds > 60)) invalid();
      if (options.resolution !== undefined && (typeof options.resolution !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(options.resolution))) invalid();
      if (
        options.aspect_ratio !== undefined
        && (
          typeof options.aspect_ratio !== "string"
          || !VIDEO_ASPECT_RATIO_PATTERN.test(options.aspect_ratio)
        )
      ) invalid();
      if (options.generate_audio !== undefined && typeof options.generate_audio !== "boolean") invalid();
      if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2147483647)) invalid();
    }
  }

  return {
    createResponse,
    statusResponse,
    listResponse,
    listQuery,
    outputMetadata,
    deliveryResponse,
    deliveryBody,
    inputImagesRequest,
    preparedInputsResponse,
    validateImageCreate,
    validateVideoCreate,
  };
}
