import type { DataAdapter } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { PendingAudioProcessorUploadSource } from "../../types";
import {
  AUDIO_PROCESSOR_MAX_AUDIO_BYTES,
  type AudioProcessorAudioSource,
} from "./types";

const STAGING_DIRECTORY = ".audio-processor-staging";
const MANIFEST_PATTERN = /\/manifest-(\d{6})\.json$/;
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
  private readonly adapter: DataAdapter;
  private readonly root: string;
  private readonly chunkSizeBytes: number;
  private readonly digest: (bytes: ArrayBuffer) => Promise<string>;
  private readonly now: () => number;

  constructor(
    plugin: SystemSculptPlugin,
    testSeam: AudioProcessorDeviceStagingTestSeam = {},
  ) {
    const configDirectory = normalizeRelativePath(plugin?.app?.vault?.configDir);
    const pluginId = normalizePluginId(plugin?.manifest?.id);
    if (pluginId !== "systemsculpt-ai") invalidRequest();
    const pluginDirectory = `${configDirectory}/plugins/${pluginId}`;
    if (
      plugin.manifest.dir !== undefined
      && normalizeRelativePath(plugin.manifest.dir) !== pluginDirectory
    ) {
      throw new AudioProcessorDeviceStagingError(
        "invalid_staging_request",
        "Plugin manifest directory does not match the installed plugin location.",
      );
    }
    const chunkSizeBytes = testSeam.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0 || chunkSizeBytes > 32 * 1024 * 1024) {
      invalidRequest();
    }
    this.adapter = plugin.app.vault.adapter;
    this.root = `${pluginDirectory}/${STAGING_DIRECTORY}`;
    this.chunkSizeBytes = chunkSizeBytes;
    this.digest = testSeam.digest ?? sha256;
    this.now = testSeam.now ?? Date.now;
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

    await this.cleanupStagingId(stagingId, signal);
    await this.ensureDirectory(this.root, signal);
    const directory = this.directory(stagingId);
    await this.ensureDirectory(directory, signal);
    const createdAt = this.now();
    const totalChunks = Math.ceil(source.sizeBytes / this.chunkSizeBytes);
    const stagingManifest: StagingManifest = {
      schemaVersion: 1,
      sequence: 1,
      phase: "staging",
      stagingId,
      createdAt,
      filename: source.filename,
      contentType: source.contentType,
      sizeBytes: source.sizeBytes,
      chunkSizeBytes: this.chunkSizeBytes,
      chunks: [],
    };
    await this.writeManifest(directory, stagingManifest, signal);

    const chunks: StagedChunk[] = [];
    for (let index = 0; index < totalChunks; index += 1) {
      throwIfAborted(signal);
      const start = index * this.chunkSizeBytes;
      const end = Math.min(source.sizeBytes, start + this.chunkSizeBytes);
      const bytes = await source.readSlice(start, end);
      throwIfAborted(signal);
      if (bytes.byteLength !== end - start) corrupt("Device staging source changed while it was read.");
      const digest = await this.digest(bytes);
      throwIfAborted(signal);
      const path = this.chunkPath(directory, index);
      const temporaryPath = `${path}.tmp`;
      await this.adapter.writeBinary(temporaryPath, bytes);
      throwIfAborted(signal);
      await this.adapter.rename(temporaryPath, path);
      throwIfAborted(signal);
      const verified = await this.adapter.readBinary(path);
      throwIfAborted(signal);
      const verifiedDigest = await this.digest(verified);
      throwIfAborted(signal);
      if (verified.byteLength !== bytes.byteLength || verifiedDigest !== digest) {
        corrupt("Staged audio failed verification.");
      }
      chunks.push({ index, byteLength: bytes.byteLength, sha256: digest });
      onProgress?.(index + 1, totalChunks);
    }

    const readyManifest: StagingManifest = {
      ...stagingManifest,
      sequence: 2,
      phase: "ready",
      chunks,
    };
    const manifestText = JSON.stringify(readyManifest);
    const manifestSha256 = await this.digest(new TextEncoder().encode(manifestText).buffer);
    throwIfAborted(signal);
    await this.writeManifest(directory, readyManifest, signal);
    const persistedText = await this.adapter.read(this.manifestPath(directory, readyManifest.sequence));
    throwIfAborted(signal);
    if (await this.digest(new TextEncoder().encode(persistedText).buffer) !== manifestSha256) {
      corrupt("Audio staging manifest failed verification.");
    }
    return this.buildSource(readyManifest, { kind: "staged", stagingId, manifestSha256 });
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
    await this.cleanupStagingId(stagingId, signal);
  }

  async cleanupDescriptor(
    descriptor: PendingAudioProcessorUploadSource,
    signal?: AbortSignal,
  ): Promise<void> {
    if (descriptor.kind !== "staged") return;
    validateDescriptor(descriptor);
    await this.cleanupStagingId(descriptor.stagingId, signal);
  }

  async cleanupStale(activeJobIds: readonly string[], signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!await this.adapter.exists(this.root)) return;
    throwIfAborted(signal);
    const activeStagingIds = new Set<string>();
    for (const jobId of activeJobIds) {
      activeStagingIds.add(await this.stagingIdForJob(jobId, signal));
    }
    const listing = await this.adapter.list(this.root);
    throwIfAborted(signal);
    for (const folder of listing.folders) {
      const stagingId = folder.slice(folder.lastIndexOf("/") + 1);
      if (!SHA256_PATTERN.test(stagingId) || activeStagingIds.has(stagingId)) continue;
      const manifest = await this.readLatestManifest(stagingId, signal).catch(() => null);
      const stat = manifest ? null : await this.adapter.stat(folder);
      throwIfAborted(signal);
      const createdAt = manifest?.createdAt ?? stat?.mtime ?? this.now();
      const ttl = manifest?.phase === "ready" ? READY_STAGING_TTL_MS : INCOMPLETE_STAGING_TTL_MS;
      if (this.now() - createdAt >= ttl) await this.cleanupStagingId(stagingId, signal);
    }
  }

  private async openForStagingId(
    stagingId: string,
    expectedManifestSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<AudioProcessorAudioSource | null> {
    if (!SHA256_PATTERN.test(stagingId)) invalidRequest();
    const manifest = await this.readLatestManifest(stagingId, signal);
    if (!manifest || manifest.phase !== "ready") return null;
    const manifestText = JSON.stringify(manifest);
    const manifestSha256 = await this.digest(new TextEncoder().encode(manifestText).buffer);
    throwIfAborted(signal);
    if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
      corrupt("Audio staging manifest did not match its recovery descriptor.");
    }
    return this.buildSource(manifest, { kind: "staged", stagingId, manifestSha256 });
  }

  private buildSource(
    manifest: StagingManifest,
    descriptor: StagedSourceDescriptor,
  ): AudioProcessorAudioSource {
    validateReadyManifest(manifest);
    const directory = this.directory(manifest.stagingId);
    return {
      filename: manifest.filename,
      contentType: manifest.contentType,
      sizeBytes: manifest.sizeBytes,
      resumeDescriptor: descriptor,
      readSlice: async (start, end) => await this.readSlice(directory, manifest, start, end),
      release: () => undefined,
    };
  }

  private async readSlice(
    directory: string,
    manifest: StagingManifest,
    start: number,
    end: number,
  ): Promise<ArrayBuffer> {
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
      const bytes = await this.adapter.readBinary(this.chunkPath(directory, index));
      const digest = await this.digest(bytes);
      if (bytes.byteLength !== metadata.byteLength || digest !== metadata.sha256) {
        corrupt("Staged audio chunk failed verification.");
      }
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

  private async readLatestManifest(
    stagingId: string,
    signal?: AbortSignal,
  ): Promise<StagingManifest | null> {
    const directory = this.directory(stagingId);
    if (!await this.adapter.exists(directory)) return null;
    throwIfAborted(signal);
    const listing = await this.adapter.list(directory);
    throwIfAborted(signal);
    const paths = listing.files.filter((path) => MANIFEST_PATTERN.test(path)).sort().reverse();
    for (const path of paths) {
      const raw = await this.adapter.read(path);
      throwIfAborted(signal);
      try {
        const value = JSON.parse(raw) as unknown;
        if (isManifest(value, stagingId)) return value;
      } catch {
        // Ignore an incomplete newest immutable generation and try an older one.
      }
    }
    return null;
  }

  private async stagingIdForJob(jobId: string, signal?: AbortSignal): Promise<string> {
    if (!JOB_ID_PATTERN.test(jobId)) invalidRequest();
    const stagingId = await this.digest(
      new TextEncoder().encode(`audio-processor-device-staging-v1\0${jobId}`).buffer,
    );
    throwIfAborted(signal);
    if (!SHA256_PATTERN.test(stagingId)) corrupt("Audio staging digest was invalid.");
    return stagingId;
  }

  private async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    if (await this.adapter.exists(path)) return;
    throwIfAborted(signal);
    try {
      await this.adapter.mkdir(path);
    } catch (error) {
      if (!await this.adapter.exists(path)) throw error;
    }
    throwIfAborted(signal);
  }

  private async cleanupStagingId(stagingId: string, signal?: AbortSignal): Promise<void> {
    if (!SHA256_PATTERN.test(stagingId)) invalidRequest();
    const directory = this.directory(stagingId);
    if (!await this.adapter.exists(directory)) return;
    throwIfAborted(signal);
    await this.adapter.rmdir(directory, true);
    throwIfAborted(signal);
  }

  private async writeManifest(
    directory: string,
    manifest: StagingManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = this.manifestPath(directory, manifest.sequence);
    const temporaryPath = `${path}.tmp`;
    await this.adapter.write(temporaryPath, JSON.stringify(manifest));
    throwIfAborted(signal);
    await this.adapter.rename(temporaryPath, path);
    throwIfAborted(signal);
  }

  private manifestPath(directory: string, sequence: number): string {
    return `${directory}/manifest-${String(sequence).padStart(6, "0")}.json`;
  }

  private chunkPath(directory: string, index: number): string {
    return `${directory}/chunk-${String(index + 1).padStart(6, "0")}.bin`;
  }

  private directory(stagingId: string): string {
    return `${this.root}/${stagingId}`;
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

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => part === ".." || part === "." || !part)
  ) invalidRequest();
  return normalized;
}

function normalizePluginId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    invalidRequest();
  }
  return value;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
