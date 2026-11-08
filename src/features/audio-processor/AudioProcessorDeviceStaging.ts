import type SystemSculptPlugin from "../../main";
import type { PendingAudioProcessorUploadSource } from "../../types";
import { sha256HexFromArrayBuffer } from "../../utils/sha256";
import { throwIfManagedAborted } from "../../services/managed/ManagedAbort";
import { ManagedLocalStaging } from "../../services/managed/ManagedLocalStaging";
import {
  AUDIO_PROCESSOR_MAX_AUDIO_BYTES,
  type AudioProcessorAudioSource,
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
const INCOMPLETE_STAGING_TTL_MS = 24 * 60 * 60 * 1_000;
const READY_STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type StagedSourceDescriptor = Extract<PendingAudioProcessorUploadSource, { kind: "staged" }>;

interface StagedChunk {
  index: number;
  byteLength: number;
  sha256: string;
}

interface StagingManifest {
  schemaVersion: 1;
  sequence: number;
  phase: "staging" | "ready";
  stagingId: string;
  createdAt: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  chunkSizeBytes: number;
  chunks: StagedChunk[];
}

export interface AudioProcessorDeviceStagingTestSeam {
  chunkSizeBytes?: number;
  digest?: (bytes: ArrayBuffer) => Promise<string>;
  now?: () => number;
}

/** @internal Tests match this error class. */
export class AudioProcessorDeviceStagingError extends Error {
  constructor(
    public readonly code: "invalid_staging_request" | "staging_corrupt",
    message: string,
  ) {
    super(message);
    this.name = "AudioProcessorDeviceStagingError";
  }
}

/**
 * Durable, adapter-only staging for device-selected audio. Each source is split
 * into bounded immutable files, then made visible through an atomic ready
 * manifest. Restart reads verify one chunk at a time and never reconstruct the
 * complete source in memory.
 */
export class AudioProcessorDeviceStaging {
  private readonly storage: ManagedLocalStaging<StagingManifest>;
  private readonly chunkSizeBytes: number;
  private readonly digest: (bytes: ArrayBuffer) => Promise<string>;
  private readonly now: () => number;

  constructor(
    plugin: SystemSculptPlugin,
    testSeam: AudioProcessorDeviceStagingTestSeam = {},
  ) {
    const chunkSizeBytes = testSeam.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0 || chunkSizeBytes > 32 * 1024 * 1024) {
      invalidRequest();
    }
    this.chunkSizeBytes = chunkSizeBytes;
    this.digest = testSeam.digest ?? sha256HexFromArrayBuffer;
    this.now = testSeam.now ?? Date.now;
    this.storage = new ManagedLocalStaging(plugin, {
      directory: ".audio-processor-staging",
      isManifest,
      digest: this.digest,
      error: (code, message) => new AudioProcessorDeviceStagingError(
        code,
        message ?? "Invalid audio staging request.",
      ),
    });
  }

  async stage(
    jobId: string,
    source: AudioProcessorAudioSource,
    signal?: AbortSignal,
    onProgress?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<AudioProcessorAudioSource> {
    validateSource(source);
    const stagingId = await this.stagingIdForJob(jobId, signal);
    let existing: AudioProcessorAudioSource | null;
    try {
      existing = await this.openForStagingId(stagingId, undefined, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      existing = null;
    }
    if (
      existing
      && existing.filename === source.filename
      && existing.contentType === source.contentType
      && existing.sizeBytes === source.sizeBytes
    ) return existing;

    const createdAt = this.now();
    const totalChunks = Math.ceil(source.sizeBytes / this.chunkSizeBytes);
    const readyManifest = await this.storage.stage(
      stagingId,
      this.chunks(source, signal),
      (sequence, phase, chunks) => ({
        schemaVersion: 1,
        sequence,
        phase,
        stagingId,
        createdAt,
        filename: source.filename,
        contentType: source.contentType,
        sizeBytes: source.sizeBytes,
        chunkSizeBytes: this.chunkSizeBytes,
        chunks,
      }),
      { replace: true, signal, onProgress: completed => onProgress?.(completed, totalChunks) },
    );
    const manifestSha256 = await this.digest(new TextEncoder().encode(JSON.stringify(readyManifest)).buffer);
    throwIfManagedAborted(signal);
    return this.buildSource(readyManifest, { kind: "staged", stagingId, manifestSha256 }, signal);
  }

  async open(
    descriptor: StagedSourceDescriptor,
    signal?: AbortSignal,
  ): Promise<AudioProcessorAudioSource> {
    validateDescriptor(descriptor);
    const source = await this.openForStagingId(
      descriptor.stagingId,
      descriptor.manifestSha256,
      signal,
    );
    if (!source) corrupt("Audio staging manifest is missing.");
    return source;
  }

  async openForJob(jobId: string, signal?: AbortSignal): Promise<AudioProcessorAudioSource | null> {
    const stagingId = await this.stagingIdForJob(jobId, signal);
    return await this.openForStagingId(stagingId, undefined, signal);
  }

  async hasReadyForJob(jobId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      return await this.openForJob(jobId, signal) !== null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  async cleanupForJob(jobId: string, signal?: AbortSignal): Promise<void> {
    const stagingId = await this.stagingIdForJob(jobId, signal);
    await this.storage.cleanup(stagingId, signal);
  }

  async cleanupDescriptor(
    descriptor: PendingAudioProcessorUploadSource,
    signal?: AbortSignal,
  ): Promise<void> {
    if (descriptor.kind !== "staged") return;
    validateDescriptor(descriptor);
    await this.storage.cleanup(descriptor.stagingId, signal);
  }

  async cleanupStale(activeJobIds: readonly string[], signal?: AbortSignal): Promise<void> {
    throwIfManagedAborted(signal);
    const activeStagingIds = new Set<string>();
    for (const jobId of activeJobIds) {
      activeStagingIds.add(await this.stagingIdForJob(jobId, signal));
    }
    await this.storage.cleanupStale(activeStagingIds, (manifest, modifiedAt) => {
      const createdAt = manifest?.createdAt ?? modifiedAt ?? this.now();
      const ttl = manifest?.phase === "ready" ? READY_STAGING_TTL_MS : INCOMPLETE_STAGING_TTL_MS;
      return this.now() - createdAt >= ttl;
    }, signal);
  }

  private async openForStagingId(
    stagingId: string,
    expectedManifestSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<AudioProcessorAudioSource | null> {
    if (!SHA256_PATTERN.test(stagingId)) invalidRequest();
    const manifest = await this.storage.findManifest(stagingId, undefined, signal);
    if (!manifest || manifest.phase !== "ready") return null;
    const manifestText = JSON.stringify(manifest);
    const manifestSha256 = await this.digest(new TextEncoder().encode(manifestText).buffer);
    throwIfManagedAborted(signal);
    if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
      corrupt("Audio staging manifest did not match its recovery descriptor.");
    }
    return this.buildSource(manifest, { kind: "staged", stagingId, manifestSha256 }, signal);
  }

  private buildSource(
    manifest: StagingManifest,
    descriptor: StagedSourceDescriptor,
    signal?: AbortSignal,
  ): AudioProcessorAudioSource {
    validateReadyManifest(manifest);
    return {
      filename: manifest.filename,
      contentType: manifest.contentType,
      sizeBytes: manifest.sizeBytes,
      resumeDescriptor: descriptor,
      readSlice: async (start, end) => await this.readSlice(manifest, start, end, signal),
      release: () => undefined,
    };
  }

  private async readSlice(
    manifest: StagingManifest,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    throwIfManagedAborted(signal);
    if (
      !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end <= start
      || end > manifest.sizeBytes
    ) invalidRequest();
    const output = new Uint8Array(end - start);
    const firstChunk = Math.floor(start / manifest.chunkSizeBytes);
    const lastChunk = Math.floor((end - 1) / manifest.chunkSizeBytes);
    let outputOffset = 0;
    for (let index = firstChunk; index <= lastChunk; index += 1) {
      const metadata = manifest.chunks[index];
      if (!metadata || metadata.index !== index) corrupt("Audio staging chunk metadata is incomplete.");
      const bytes = await this.storage.readVerified(manifest.stagingId, chunkName(index), metadata, signal);
      const chunkStart = index * manifest.chunkSizeBytes;
      const copyStart = Math.max(start, chunkStart) - chunkStart;
      const copyEnd = Math.min(end, chunkStart + bytes.byteLength) - chunkStart;
      const view = new Uint8Array(bytes, copyStart, copyEnd - copyStart);
      output.set(view, outputOffset);
      outputOffset += view.byteLength;
    }
    if (outputOffset !== output.byteLength) corrupt("Audio staging slice was incomplete.");
    return output.buffer;
  }

  private async *chunks(source: AudioProcessorAudioSource, signal?: AbortSignal) {
    const totalChunks = Math.ceil(source.sizeBytes / this.chunkSizeBytes);
    for (let index = 0; index < totalChunks; index += 1) {
      throwIfManagedAborted(signal);
      const start = index * this.chunkSizeBytes;
      const end = Math.min(source.sizeBytes, start + this.chunkSizeBytes);
      const bytes = await source.readSlice(start, end);
      throwIfManagedAborted(signal);
      if (bytes.byteLength !== end - start) corrupt("Device staging source changed while it was read.");
      const sha256 = await this.digest(bytes);
      throwIfManagedAborted(signal);
      yield { name: chunkName(index), bytes, metadata: { index, byteLength: bytes.byteLength, sha256 } };
    }
  }

  private async stagingIdForJob(jobId: string, signal?: AbortSignal): Promise<string> {
    throwIfManagedAborted(signal);
    if (!JOB_ID_PATTERN.test(jobId)) invalidRequest();
    const stagingId = await this.digest(
      new TextEncoder().encode(`audio-processor-device-staging-v1\0${jobId}`).buffer,
    );
    throwIfManagedAborted(signal);
    if (!SHA256_PATTERN.test(stagingId)) corrupt("Audio staging digest was invalid.");
    return stagingId;
  }
}

function validateSource(source: AudioProcessorAudioSource): void {
  if (
    !source
    || typeof source.filename !== "string"
    || source.filename.length === 0
    || source.filename.length > 512
    || typeof source.contentType !== "string"
    || source.contentType.length === 0
    || source.contentType.length > 128
    || !Number.isInteger(source.sizeBytes)
    || source.sizeBytes <= 0
    || source.sizeBytes > AUDIO_PROCESSOR_MAX_AUDIO_BYTES
  ) invalidRequest();
}

function validateDescriptor(descriptor: StagedSourceDescriptor): void {
  if (
    descriptor.kind !== "staged"
    || !SHA256_PATTERN.test(descriptor.stagingId)
    || !SHA256_PATTERN.test(descriptor.manifestSha256)
  ) invalidRequest();
}

function isManifest(value: unknown, stagingId: string): value is StagingManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<StagingManifest>;
  return manifest.schemaVersion === 1
    && Number.isInteger(manifest.sequence)
    && (manifest.sequence as number) > 0
    && (manifest.phase === "staging" || manifest.phase === "ready")
    && manifest.stagingId === stagingId
    && Number.isFinite(manifest.createdAt)
    && (manifest.createdAt as number) > 0
    && typeof manifest.filename === "string"
    && manifest.filename.length > 0
    && manifest.filename.length <= 512
    && typeof manifest.contentType === "string"
    && manifest.contentType.length > 0
    && manifest.contentType.length <= 128
    && Number.isInteger(manifest.sizeBytes)
    && (manifest.sizeBytes as number) > 0
    && (manifest.sizeBytes as number) <= AUDIO_PROCESSOR_MAX_AUDIO_BYTES
    && Number.isInteger(manifest.chunkSizeBytes)
    && (manifest.chunkSizeBytes as number) > 0
    && (manifest.chunkSizeBytes as number) <= 32 * 1024 * 1024
    && Array.isArray(manifest.chunks)
    && manifest.chunks.every((chunk, index) =>
      chunk
      && Number.isInteger(chunk.index)
      && chunk.index === index
      && Number.isInteger(chunk.byteLength)
      && chunk.byteLength > 0
      && chunk.byteLength <= (manifest.chunkSizeBytes as number)
      && typeof chunk.sha256 === "string"
      && SHA256_PATTERN.test(chunk.sha256));
}

function validateReadyManifest(manifest: StagingManifest): void {
  if (!isManifest(manifest, manifest.stagingId) || manifest.phase !== "ready") {
    corrupt("Audio staging manifest is invalid.");
  }
  const expectedChunks = Math.ceil(manifest.sizeBytes / manifest.chunkSizeBytes);
  const totalBytes = manifest.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (manifest.chunks.length !== expectedChunks || totalBytes !== manifest.sizeBytes) {
    corrupt("Audio staging manifest is incomplete.");
  }
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    const expectedLength = Math.min(
      manifest.chunkSizeBytes,
      manifest.sizeBytes - index * manifest.chunkSizeBytes,
    );
    if (manifest.chunks[index].byteLength !== expectedLength) {
      corrupt("Audio staging chunk length was invalid.");
    }
  }
}

function chunkName(index: number): string {
  return `chunk-${String(index + 1).padStart(6, "0")}.bin`;
}

function invalidRequest(): never {
  throw new AudioProcessorDeviceStagingError(
    "invalid_staging_request",
    "Invalid audio staging request.",
  );
}

function corrupt(message: string): never {
  throw new AudioProcessorDeviceStagingError("staging_corrupt", message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
