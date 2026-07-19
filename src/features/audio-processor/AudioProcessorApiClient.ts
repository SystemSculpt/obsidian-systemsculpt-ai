import { PlatformRequestClient } from "../../services/PlatformRequestClient";
import { SystemSculptEnvironment } from "../../services/api/SystemSculptEnvironment";
import type {
  AudioProcessorArtifactDescriptor,
  AudioProcessorArtifactManifest,
  AudioProcessorCreatedJob,
  AudioProcessorJob,
  AudioProcessorResult,
  AudioProcessorStage,
  AudioProcessorStatus,
  AudioProcessorTranscriptArtifact,
  AudioProcessorUpload,
} from "./types";
import { AUDIO_PROCESSOR_ARTIFACT_MANIFEST_VERSION } from "./types";

type JsonRecord = Record<string, unknown>;

export interface AudioProcessorApiClientOptions {
  pluginVersion: string;
  licenseKey: () => string;
  baseUrl?: string;
  requestClient?: PlatformRequestClient;
}

export interface AudioProcessorSignedPart {
  partNumber: number;
  url: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface AudioProcessorUploadedPart {
  part_number: number;
  etag: string;
}

export interface AudioProcessorRemoteUploadPart {
  part_number: number;
  etag: string;
  size_bytes: number;
}

export interface AudioProcessorRemoteUploadState {
  objectCompleted: boolean;
  partSizeBytes: number;
  totalParts: number;
  parts: AudioProcessorRemoteUploadPart[];
}

const STATUSES: readonly AudioProcessorStatus[] = [
  "uploading", "queued", "awaiting_funds", "processing", "succeeded", "failed", "expired",
];
const STAGES: readonly AudioProcessorStage[] = [
  "uploading", "queued", "awaiting_funds", "transcribing", "summarizing", "rendering", "complete",
];
const MAX_JSON_RESPONSE_CHARS = 1024 * 1024;
const MAX_NOTE_BYTES = 32 * 1024 * 1024;

export class AudioProcessorApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AudioProcessorApiError";
  }
}

export class AudioProcessorApiClient {
  private readonly baseUrl: string;
  private readonly requestClient: PlatformRequestClient;

  constructor(private readonly options: AudioProcessorApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? SystemSculptEnvironment.resolveBaseUrl()).replace(/\/+$/, "");
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
  }

  async createAudioJob(
    source: Readonly<{
      filename: string;
      contentType: string;
      sizeBytes: number;
    }>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<AudioProcessorCreatedJob> {
    const payload = await this.apiJson("/audio-processor/jobs", "POST", {
      source: {
        type: "audio",
        filename: source.filename,
        content_type: source.contentType,
        size_bytes: source.sizeBytes,
      },
    }, operationId, signal);
    return this.parseCreatedJob(payload, true);
  }

  async createYouTubeJob(
    url: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<AudioProcessorCreatedJob> {
    const payload = await this.apiJson("/audio-processor/jobs", "POST", {
      source: { type: "youtube", url },
    }, operationId, signal);
    return this.parseCreatedJob(payload, false);
  }

  async getPartUrl(
    jobId: string,
    partNumber: number,
    signal?: AbortSignal,
  ): Promise<AudioProcessorSignedPart> {
    const payload = await this.apiJson(
      `/audio-processor/jobs/${encodeURIComponent(jobId)}/upload/part-url?partNumber=${partNumber}`,
      "GET",
      undefined,
      undefined,
      signal,
    );
    const part = record(payload, "Signed upload part");
    const returnedPart = positiveInteger(part.part_number, "part_number");
    if (returnedPart !== partNumber) malformed("The signed upload part did not match the request.");
    return {
      partNumber: returnedPart,
      url: publicHttpsUrl(part.url, "part URL"),
      headers: stringHeaders(part.headers),
      expiresInSeconds: positiveInteger(part.expires_in_seconds, "expires_in_seconds"),
    };
  }

  async uploadPart(
    part: AudioProcessorSignedPart,
    bytes: ArrayBuffer,
    signal?: AbortSignal,
  ): Promise<AudioProcessorUploadedPart> {
    const response = await this.requestClient.request({
      url: part.url,
      method: "PUT",
      headers: part.headers,
      body: bytes,
      bodyEncoding: "raw",
      responseEncoding: "text",
      transport: "requestUrl",
      preserveResponseHeaders: true,
      allowTransportFallback: false,
      signal,
    });
    if (!response.ok) {
      throw new AudioProcessorApiError(
        `Audio upload failed (${response.status}).`,
        response.status,
        "upload_failed",
      );
    }
    const etag = response.headers.get("etag")?.trim();
    if (!etag || etag.length > 512) malformed("The audio upload response did not include a valid ETag.");
    return { part_number: part.partNumber, etag };
  }

  async completeUpload(
    jobId: string,
    parts: readonly AudioProcessorUploadedPart[],
    operationId: string,
    signal?: AbortSignal,
  ): Promise<AudioProcessorJob> {
    const payload = await this.apiJson(
      `/audio-processor/jobs/${encodeURIComponent(jobId)}/upload/complete`,
      "POST",
      { parts },
      operationId,
      signal,
    );
    return parseJobEnvelope(payload, "Upload completion response");
  }

  async getUploadParts(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<AudioProcessorRemoteUploadState> {
    const payload = await this.apiJson(
      `/audio-processor/jobs/${encodeURIComponent(jobId)}/upload/parts`,
      "GET",
      undefined,
      undefined,
      signal,
    );
    return parseUploadParts(payload);
  }

  async abortUpload(
    jobId: string,
    operationId: string,
    options: {
      signal?: AbortSignal;
      ifUnchangedSince?: string;
    } = {},
  ): Promise<void> {
    await this.apiJson(
      `/audio-processor/jobs/${encodeURIComponent(jobId)}/upload/abort`,
      "POST",
      options.ifUnchangedSince
        ? { if_unchanged_since: options.ifUnchangedSince }
        : {},
      operationId,
      options.signal,
    );
  }

  async getJob(jobId: string, signal?: AbortSignal): Promise<AudioProcessorJob> {
    const payload = await this.apiJson(
      `/audio-processor/jobs/${encodeURIComponent(jobId)}`,
      "GET",
      undefined,
      undefined,
      signal,
    );
    return parseJobEnvelope(payload, "Audio job response");
  }

  async resumeJob(
    jobId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<AudioProcessorJob> {
    const payload = await this.apiJson(
      `/audio-processor/jobs/${encodeURIComponent(jobId)}/resume`,
      "POST",
      {},
      operationId,
      signal,
    );
    return parseJobEnvelope(payload, "Audio job resume response");
  }

  async getActiveJobs(signal?: AbortSignal): Promise<AudioProcessorJob[]> {
    const payload = await this.apiJson(
      "/audio-processor/jobs?active=true",
      "GET",
      undefined,
      undefined,
      signal,
    );
    const root = record(payload, "Active audio jobs response");
    if (!Array.isArray(root.jobs) || root.jobs.length > 25) {
      malformed("Active audio jobs must be a bounded array.");
    }
    return root.jobs.map((entry) => parseJobEnvelope(entry, "Active audio job"));
  }

  async acknowledgeJob(
    jobId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.apiJson(
      `/audio-processor/jobs/${encodeURIComponent(jobId)}/acknowledge`,
      "POST",
      {},
      operationId,
      signal,
    );
  }

  async downloadNote(url: string, signal?: AbortSignal): Promise<string> {
    const response = await this.requestClient.request({
      url: publicHttpsUrl(url, "audio note URL"),
      method: "GET",
      bodyEncoding: "raw",
      responseEncoding: "text",
      transport: "requestUrl",
      preserveResponseHeaders: true,
      allowTransportFallback: false,
      signal,
    });
    if (!response.ok) {
      throw new AudioProcessorApiError(
        `The completed audio note could not be downloaded (${response.status}).`,
        response.status,
        "note_download_failed",
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_NOTE_BYTES) {
      malformed("The completed audio note was too large.");
    }
    const note = await response.text();
    const byteLength = new TextEncoder().encode(note).byteLength;
    if (!note.trim() || byteLength > MAX_NOTE_BYTES) {
      malformed("The completed audio note was empty or too large.");
    }
    return note;
  }

  private parseCreatedJob(value: unknown, requiresUpload: boolean): AudioProcessorCreatedJob {
    const root = record(value, "Audio job creation response");
    const job = parseJobEnvelope(root, "Audio job creation response");
    const upload = root.upload == null ? null : parseUpload(root.upload);
    if (requiresUpload && job.status === "uploading" && !upload) {
      malformed("Uploading audio jobs require an upload plan.");
    }
    if (requiresUpload && job.status !== "uploading" && upload) {
      malformed("Only uploading audio jobs may include an upload plan.");
    }
    if (!requiresUpload && upload) malformed("YouTube audio jobs must not include an upload plan.");
    return { job, upload };
  }

  private async apiJson(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    operationId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const licenseKey = this.options.licenseKey().trim();
    const headers = {
      ...SystemSculptEnvironment.buildHeaders(licenseKey || undefined),
      "x-plugin-version": this.options.pluginVersion,
      ...(operationId ? { "Idempotency-Key": operationId } : {}),
    };
    const response = await this.requestClient.request({
      url: `${this.baseUrl}${path}`,
      method,
      headers,
      body,
      signal,
      licenseKey: licenseKey || undefined,
      preserveResponseHeaders: true,
      allowTransportFallback: method === "GET",
    });
    const text = await response.text();
    if (text.length > MAX_JSON_RESPONSE_CHARS) malformed("The audio service response was too large.");

    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      malformed("The audio service returned malformed JSON.");
    }
    if (!response.ok) {
      const root = isRecord(payload) ? payload : {};
      const error = isRecord(root.error) ? root.error : root;
      const code = typeof error.code === "string" ? error.code : "request_failed";
      const message = typeof error.message === "string"
        ? error.message
        : typeof root.error === "string"
          ? root.error
        : `Audio service request failed (${response.status}).`;
      throw new AudioProcessorApiError(message, response.status, code);
    }
    return payload;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) malformed(`${label} must be an object.`);
  return value;
}

function string(value: unknown, label: string, max = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    malformed(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    malformed(`${label} must be a positive integer.`);
  }
  return value as number;
}

function isoTimestamp(value: unknown, label: string): string {
  const raw = string(value, label, 128).trim();
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) || !Number.isFinite(Date.parse(raw))) {
    malformed(`${label} must be an ISO timestamp with an explicit timezone.`);
  }
  return raw;
}

function publicHttpsUrl(value: unknown, label: string): string {
  const raw = string(value, label, 8192);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    malformed(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    malformed(`${label} must be a credential-free HTTPS URL.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    malformed(`${label} must use a public hostname.`);
  }
  return raw;
}

function stringHeaders(value: unknown): Record<string, string> {
  const source = record(value, "Signed upload headers");
  const output: Record<string, string> = {};
  const entries = Object.entries(source);
  if (entries.length > 24) malformed("The signed upload returned too many headers.");
  for (const [name, headerValue] of entries) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(name) || typeof headerValue !== "string" || headerValue.length > 2048) {
      malformed("The signed upload returned invalid headers.");
    }
    output[name] = headerValue;
  }
  return output;
}

function parseUpload(value: unknown): AudioProcessorUpload {
  const upload = record(value, "Audio upload plan");
  const partSizeBytes = positiveInteger(upload.part_size_bytes, "part_size_bytes");
  const totalParts = positiveInteger(upload.total_parts, "total_parts");
  if (partSizeBytes > 100 * 1024 * 1024 || totalParts > 10_000) {
    malformed("The audio upload plan exceeded client limits.");
  }
  return { partSizeBytes, totalParts };
}

function parseUploadParts(value: unknown): AudioProcessorRemoteUploadState {
  const upload = record(value, "Audio upload parts");
  if (typeof upload.object_completed !== "boolean") {
    malformed("object_completed must be a boolean.");
  }
  const partSizeBytes = positiveInteger(upload.part_size_bytes, "part_size_bytes");
  const totalParts = positiveInteger(upload.total_parts, "total_parts");
  if (!Array.isArray(upload.parts) || upload.parts.length > totalParts || totalParts > 10_000) {
    malformed("Audio upload parts exceeded client limits.");
  }
  const deduped = new Map<number, AudioProcessorRemoteUploadPart>();
  for (const entry of upload.parts) {
    const part = record(entry, "Audio upload part");
    const partNumber = positiveInteger(part.part_number, "part_number");
    const sizeBytes = positiveInteger(part.size_bytes, "size_bytes");
    const etag = string(part.etag, "etag", 512).trim();
    if (partNumber > totalParts || sizeBytes > partSizeBytes) {
      malformed("Audio upload part was out of bounds.");
    }
    deduped.set(partNumber, { part_number: partNumber, etag, size_bytes: sizeBytes });
  }
  return {
    objectCompleted: upload.object_completed,
    partSizeBytes,
    totalParts,
    parts: [...deduped.values()].sort((left, right) => left.part_number - right.part_number),
  };
}

function parseJobEnvelope(value: unknown, label: string): AudioProcessorJob {
  const envelope = record(value, label);
  return parseJob(envelope.job, envelope.result, envelope.transcript_artifact);
}

function parseJob(
  value: unknown,
  resultValue: unknown,
  transcriptArtifactValue: unknown,
): AudioProcessorJob {
  const job = record(value, "Audio job");
  const id = string(job.id, "job.id", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id)) malformed("job.id was invalid.");
  if (!STATUSES.includes(job.status as AudioProcessorStatus)) malformed("job.status was invalid.");
  if (!STAGES.includes(job.stage as AudioProcessorStage)) malformed("job.stage was invalid.");
  if (typeof job.progress !== "number" || !Number.isFinite(job.progress) || job.progress < 0 || job.progress > 1) {
    malformed("job.progress must be between zero and one.");
  }
  const status = job.status as AudioProcessorStatus;
  const stage = job.stage as AudioProcessorStage;
  const terminal = status === "succeeded" || status === "failed" || status === "expired";
  if (terminal !== (stage === "complete")) {
    malformed("job.stage did not match its terminal status.");
  }
  if ((status === "awaiting_funds") !== (stage === "awaiting_funds")) {
    malformed("job.stage did not match its funding status.");
  }
  const quotedCredits = nullableNonNegativeInteger(job.quoted_credits, "job.quoted_credits");
  const chargedCredits = nonNegativeInteger(job.charged_credits, "job.charged_credits");
  if (typeof job.resume_required !== "boolean") {
    malformed("job.resume_required must be a boolean.");
  }
  const resumeRequired = job.resume_required;
  if (resumeRequired !== (status === "awaiting_funds")) {
    malformed("job.resume_required did not match its funding status.");
  }
  const result = resultValue == null ? null : parseResult(resultValue);
  if (status === "succeeded" && !result) malformed("A succeeded audio job requires a result.");
  if (status !== "succeeded" && result) malformed("Only a succeeded audio job may include a result.");
  const transcriptArtifact = transcriptArtifactValue == null
    ? null
    : parseTranscriptArtifact(transcriptArtifactValue);
  if (
    transcriptArtifact
    && (
      !["queued", "awaiting_funds", "processing", "succeeded", "failed"].includes(status)
      || chargedCredits <= 0
    )
  ) {
    malformed("Only an entitled audio job may include a transcript artifact.");
  }

  return {
    id,
    status,
    stage,
    progress: job.progress,
    updatedAt: isoTimestamp(job.updated_at, "job.updated_at"),
    error: parseJobError(job.error),
    quotedCredits,
    chargedCredits,
    resumeRequired,
    result,
    transcriptArtifact,
  };
}

function parseJobError(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return string(value, "job.error", 2048);
  const error = record(value, "job.error");
  return string(error.message, "job.error.message", 2048);
}

function parseResult(value: unknown): AudioProcessorResult {
  const result = record(value, "Audio job result");
  const parsed: AudioProcessorResult = {
    artifactJobId: string(result.artifact_job_id, "artifact_job_id", 255),
    noteUrl: publicHttpsUrl(result.note_url, "note_url"),
    summaryUrl: publicHttpsUrl(result.summary_url, "summary_url"),
    transcriptUrl: publicHttpsUrl(result.transcript_url, "transcript_url"),
    urlExpiresInSeconds: positiveInteger(result.url_expires_in_seconds, "url_expires_in_seconds"),
    filename: string(result.filename, "filename", 255),
    artifactManifest: null,
  };
  const hasArtifactManifest = Object.prototype.hasOwnProperty.call(result, "artifact_manifest");
  if (hasArtifactManifest && result.artifact_manifest == null) {
    malformed("The audio result did not include a complete artifact manifest.");
  }
  if (result.artifact_manifest != null) {
    const manifest = parseArtifactManifest(result.artifact_manifest);
    if (
      manifest.note.url !== parsed.noteUrl
      || manifest.summary.url !== parsed.summaryUrl
      || manifest.transcript.url !== parsed.transcriptUrl
      || manifest.note.filename !== parsed.filename
    ) {
      malformed("The artifact manifest did not match the audio result.");
    }
    const resultSha256 = result.sha256 == null
      ? null
      : sha256(result.sha256, "sha256");
    if (resultSha256 && resultSha256 !== manifest.note.sha256) {
      malformed("The artifact manifest note digest did not match the audio result.");
    }
    parsed.artifactManifest = manifest;
  }
  return parsed;
}

function parseArtifactManifest(value: unknown): AudioProcessorArtifactManifest {
  const manifest = record(value, "Audio artifact manifest");
  if (manifest.version !== AUDIO_PROCESSOR_ARTIFACT_MANIFEST_VERSION) {
    malformed("The audio artifact manifest version was unsupported.");
  }
  return {
    version: AUDIO_PROCESSOR_ARTIFACT_MANIFEST_VERSION,
    note: parseArtifactDescriptor(manifest.note, "note"),
    summary: parseArtifactDescriptor(manifest.summary, "summary"),
    transcript: parseArtifactDescriptor(manifest.transcript, "transcript"),
  };
}

function parseArtifactDescriptor(
  value: unknown,
  kind: "note" | "summary" | "transcript",
): AudioProcessorArtifactDescriptor {
  const artifact = record(value, `Audio ${kind} artifact`);
  return {
    url: publicHttpsUrl(artifact.url, `artifact_manifest.${kind}.url`),
    filename: string(artifact.filename, `artifact_manifest.${kind}.filename`, 255),
    sha256: sha256(artifact.sha256, `artifact_manifest.${kind}.sha256`),
  };
}

function parseTranscriptArtifact(value: unknown): AudioProcessorTranscriptArtifact {
  const artifact = record(value, "Audio transcript artifact");
  return {
    artifactJobId: string(artifact.artifact_job_id, "transcript_artifact.artifact_job_id", 255),
    transcriptUrl: publicHttpsUrl(artifact.transcript_url, "transcript_artifact.transcript_url"),
    urlExpiresInSeconds: positiveInteger(
      artifact.url_expires_in_seconds,
      "transcript_artifact.url_expires_in_seconds",
    ),
    filename: string(artifact.filename, "transcript_artifact.filename", 255),
    sha256: sha256(artifact.sha256, "transcript_artifact.sha256"),
  };
}

function sha256(value: unknown, label: string): string {
  const digest = string(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    malformed(`${label} must be a SHA-256 digest.`);
  }
  return digest;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    malformed(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value == null ? null : nonNegativeInteger(value, label);
}

function malformed(message: string): never {
  throw new AudioProcessorApiError(message, 0, "malformed_response");
}
