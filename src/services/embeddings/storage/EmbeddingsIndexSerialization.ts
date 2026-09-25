/**
 * EmbeddingsIndexSerialization - portable, device-independent encoding of the
 * embedding index.
 *
 * The on-disk IndexedDB store is scoped to a per-install `vaultInstanceId`, so it
 * is never captured by vault sync or backups and never restored on a new device.
 * This module turns the store's `EmbeddingVector[]` into files that CAN live in
 * the vault folder, and back again.
 *
 * Format 4 (written): `index.json` is a small manifest, and the records live in
 * a fixed number of shard files keyed by a hash of the note path, so one edit
 * rewrites one shard. Each shard is a single self-validating binary file: a
 * short prefix, a JSON header with the paths, per-note metadata and chunk
 * tables, then the vectors as int8 with one Float32 scale per vector. Fields
 * that can be derived (record ids, per-record namespace, generation and
 * dimension, section titles, titles equal to the file name) are not stored.
 *
 * Format 3 (read only): one JSON envelope with every record and base64 Float32
 * vectors. Existing vaults and devices still on older releases carry it, so
 * restore keeps reading it.
 *
 * Pure module: no IndexedDB, no Obsidian, no Node — safe to load in any runtime.
 */

import type { EmbeddingVector } from "../types";
import { LOCAL_EMPTY_EMBEDDING_NAMESPACE } from "../LocalEmptyEmbeddingMarker";
import {
  isManagedNamespace,
  parseManagedNamespace,
} from "../utils/namespace";
import { buildVectorId } from "../utils/vectorId";
import { dequantizeInt8, quantizeInt8Into } from "../utils/quantization";
import { base64ToBytes as decodeBase64 } from "../../../utils/base64";

/** The single-envelope format older releases write. Read-only here. */
export const LEGACY_EMBEDDINGS_INDEX_FORMAT = 3;
/** The manifest-plus-shards format this release writes. */
export const PORTABLE_INDEX_FORMAT = 4;
export const PORTABLE_SHARD_COUNT = 32;
export const PORTABLE_VECTOR_ENCODING = "int8-scaled-v1" as const;

export interface SerializedEmbeddingVector {
  id: string;
  path: string;
  chunkId: number;
  /** Base64 of the vector's little-endian Float32 bytes ("" for empty vectors). */
  vector: string;
  metadata: EmbeddingVector["metadata"];
}

/** A format-3 envelope as written by older releases. */
export interface SerializedEmbeddingsIndex {
  format: number;
  /** Snapshot creation time (caller-supplied; null when unknown). */
  createdAt: number | null;
  vectorCount: number;
  vectors: SerializedEmbeddingVector[];
}

/** The format-4 `index.json`: small, and rewritten only when it changes. */
export interface PortableIndexManifest {
  format: typeof PORTABLE_INDEX_FORMAT;
  vectorEncoding: typeof PORTABLE_VECTOR_ENCODING;
  shardCount: number;
  /** The searchable generation when the snapshot was written. */
  committedNamespace: string | null;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function base64ToBytes(base64: string): Uint8Array {
  if (!BASE64_PATTERN.test(base64)) {
    throw new Error("Invalid base64 payload.");
  }
  return decodeBase64(base64);
}

function base64ToFloat32(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  if (bytes.length % 4 !== 0) throw new Error("Invalid Float32 byte length.");
  const out = new Float32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

function isFiniteVector(vector: Float32Array): boolean {
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) return false;
  }
  return true;
}

function parseChunkId(value: unknown, id: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  const idx = id.lastIndexOf("#");
  if (idx < 0) return 0;
  const parsed = parseInt(id.slice(idx + 1), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Decode a format-3 envelope back into `EmbeddingVector[]`.
 *
 * Fails safe: an unknown format or a non-array payload yields `[]` (the caller
 * re-embeds), and individual malformed/corrupt records are skipped rather than
 * aborting the whole restore.
 */
export function deserializeEmbeddingsIndex(input: unknown): EmbeddingVector[] {
  if (!input || typeof input !== "object") return [];
  const envelope = input as Partial<SerializedEmbeddingsIndex>;
  if (envelope.format !== LEGACY_EMBEDDINGS_INDEX_FORMAT) return [];
  if (!Array.isArray(envelope.vectors)) return [];

  const vectors: EmbeddingVector[] = [];
  for (const raw of envelope.vectors) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Partial<SerializedEmbeddingVector>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    if (typeof record.path !== "string" || record.path.length === 0) continue;
    if (typeof record.vector !== "string") continue;
    if (!record.metadata || typeof record.metadata !== "object") continue;
    if (typeof record.metadata.namespace !== "string" || record.metadata.namespace.length === 0) {
      continue;
    }

    let float: Float32Array;
    try {
      float = base64ToFloat32(record.vector);
    } catch {
      continue;
    }
    if (!isFiniteVector(float)) continue;

    const metadata = record.metadata;
    const namespace = metadata.namespace;
    const validLocalEmpty = namespace === LOCAL_EMPTY_EMBEDDING_NAMESPACE
      && metadata.isEmpty === true
      && float.length === 1
      && metadata.dimension === 1;
    const managedIdentity = parseManagedNamespace(namespace);
    const validManaged = isManagedNamespace(namespace)
      && metadata.generation === managedIdentity?.generationId
      && float.length > 0
      && metadata.dimension === float.length
      && managedIdentity?.dimensions === float.length;
    if (!validLocalEmpty && !validManaged) continue;

    vectors.push({
      id: record.id,
      path: record.path,
      chunkId: parseChunkId(record.chunkId, record.id),
      vector: float,
      metadata: record.metadata,
    });
  }

  return vectors;
}

// --- Format 4 ---------------------------------------------------------------

const SHARD_MAGIC = 0x58495353; // "SSIX" read as a little-endian u32
const SHARD_LAYOUT_VERSION = 1;
const SHARD_PREFIX_BYTES = 20;
const SCALE_BYTES = 4;
const LOCAL_EMPTY_DIMENSION = 1;

interface ShardChunk {
  chunkId: number;
  contentHash: string;
  excerpt?: string;
  headingPath?: string[];
  /** Only when it differs from the heading path joined with " › ". */
  sectionTitle?: string;
  chunkLength?: number;
  isEmpty?: true;
}

interface ShardNote {
  path: string;
  /** Index into the shard header's namespace table. */
  namespace: number;
  mtime: number;
  createdAt: number;
  /** Only when it differs from the file name without its extension. */
  title?: string;
  sourceSha256?: string;
  complete?: boolean;
  partial?: boolean;
  failedChunkCount?: number;
  chunkCount?: number;
  chunks: ShardChunk[];
}

interface ShardHeader {
  shard: number;
  namespaces: string[];
  notes: ShardNote[];
}

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable shard for a vault path; a renamed note may move to another shard. */
export function portableShardOf(path: string, shardCount = PORTABLE_SHARD_COUNT): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

function fileTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function namespaceDimensions(namespace: string): number | null {
  if (namespace === LOCAL_EMPTY_EMBEDDING_NAMESPACE) return LOCAL_EMPTY_DIMENSION;
  return parseManagedNamespace(namespace)?.dimensions ?? null;
}

function carriesVectors(namespace: string): boolean {
  return namespace !== LOCAL_EMPTY_EMBEDDING_NAMESPACE;
}

function chunkIdOf(vector: EmbeddingVector): number {
  return parseChunkId(vector.chunkId, vector.id);
}

/**
 * Encode every complete note of one shard. Records are grouped per note and
 * generation; a group without its root record is skipped, because a note
 * without a root is never considered indexed. Returns null when nothing is
 * left to write.
 */
export function encodePortableShard(shard: number, vectors: readonly EmbeddingVector[]): ArrayBuffer | null {
  const groups = new Map<string, EmbeddingVector[]>();
  for (const vector of vectors) {
    const namespace = vector?.metadata?.namespace;
    if (typeof vector?.path !== "string" || !vector.path || typeof namespace !== "string") continue;
    const dimensions = namespaceDimensions(namespace);
    if (dimensions === null) continue;
    if (carriesVectors(namespace)) {
      if (!(vector.vector instanceof Float32Array) || vector.vector.length !== dimensions) continue;
      if (!isFiniteVector(vector.vector)) continue;
    }
    const key = `${namespace}\u0000${vector.path}`;
    const group = groups.get(key);
    if (group) group.push(vector);
    else groups.set(key, [vector]);
  }

  const namespaces: string[] = [];
  const namespaceIndex = new Map<string, number>();
  const notes: ShardNote[] = [];
  const payloadVectors: Float32Array[] = [];
  for (const key of [...groups.keys()].sort()) {
    const records = groups.get(key)!.slice().sort((left, right) => chunkIdOf(left) - chunkIdOf(right));
    const root = records.find((record) => chunkIdOf(record) === 0);
    if (!root) continue;
    const namespace = root.metadata.namespace;
    let index = namespaceIndex.get(namespace);
    if (index === undefined) {
      index = namespaces.length;
      namespaces.push(namespace);
      namespaceIndex.set(namespace, index);
    }
    const metadata = root.metadata;
    const seenChunks = new Set<number>();
    const chunks: ShardChunk[] = [];
    for (const record of records) {
      const chunkId = chunkIdOf(record);
      if (seenChunks.has(chunkId)) continue;
      seenChunks.add(chunkId);
      const chunkMetadata = record.metadata;
      const headingPath = Array.isArray(chunkMetadata.headingPath) && chunkMetadata.headingPath.length > 0
        ? [...chunkMetadata.headingPath]
        : undefined;
      const derivedSection = headingPath?.join(" › ");
      chunks.push({
        chunkId,
        contentHash: String(chunkMetadata.contentHash ?? ""),
        ...(chunkMetadata.excerpt ? { excerpt: chunkMetadata.excerpt } : {}),
        ...(headingPath ? { headingPath } : {}),
        ...(chunkMetadata.sectionTitle && chunkMetadata.sectionTitle !== derivedSection
          ? { sectionTitle: chunkMetadata.sectionTitle }
          : {}),
        ...(typeof chunkMetadata.chunkLength === "number" ? { chunkLength: chunkMetadata.chunkLength } : {}),
        ...(chunkMetadata.isEmpty === true ? { isEmpty: true as const } : {}),
      });
      if (carriesVectors(namespace)) payloadVectors.push(record.vector);
    }
    notes.push({
      path: root.path,
      namespace: index,
      mtime: metadata.mtime,
      createdAt: metadata.createdAt,
      ...(metadata.title && metadata.title !== fileTitle(root.path) ? { title: metadata.title } : {}),
      ...(metadata.sourceSha256 ? { sourceSha256: metadata.sourceSha256 } : {}),
      ...(typeof metadata.complete === "boolean" ? { complete: metadata.complete } : {}),
      ...(typeof metadata.partial === "boolean" ? { partial: metadata.partial } : {}),
      ...(typeof metadata.failedChunkCount === "number" ? { failedChunkCount: metadata.failedChunkCount } : {}),
      ...(typeof metadata.chunkCount === "number" ? { chunkCount: metadata.chunkCount } : {}),
      chunks,
    });
  }
  if (notes.length === 0) return null;

  const header: ShardHeader = { shard, namespaces, notes };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const payloadLength = payloadVectors.reduce((total, vector) => total + SCALE_BYTES + vector.length, 0);
  const buffer = new ArrayBuffer(SHARD_PREFIX_BYTES + headerBytes.length + payloadLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(headerBytes, SHARD_PREFIX_BYTES);
  const codes = new Int8Array(buffer);
  let offset = SHARD_PREFIX_BYTES + headerBytes.length;
  for (const vector of payloadVectors) {
    const scale = quantizeInt8Into(vector, codes, offset + SCALE_BYTES);
    view.setFloat32(offset, scale, true);
    offset += SCALE_BYTES + vector.length;
  }
  view.setUint32(0, SHARD_MAGIC, true);
  view.setUint32(4, SHARD_LAYOUT_VERSION, true);
  view.setUint32(8, headerBytes.length, true);
  view.setUint32(12, payloadLength, true);
  view.setUint32(16, fnv1a(bytes.subarray(SHARD_PREFIX_BYTES)), true);
  return buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Decode one shard. A truncated, partially synced or otherwise corrupt file
 * throws; the caller skips it and those notes are re-embedded. Notes that fail
 * validation are dropped, the way format 3 drops malformed records.
 */
export function decodePortableShard(buffer: ArrayBuffer, expectedShard?: number): EmbeddingVector[] {
  if (buffer.byteLength < SHARD_PREFIX_BYTES) throw new Error("Portable shard is truncated.");
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (view.getUint32(0, true) !== SHARD_MAGIC || view.getUint32(4, true) !== SHARD_LAYOUT_VERSION) {
    throw new Error("Portable shard has an unknown layout.");
  }
  const headerLength = view.getUint32(8, true);
  const payloadLength = view.getUint32(12, true);
  if (SHARD_PREFIX_BYTES + headerLength + payloadLength !== buffer.byteLength) {
    throw new Error("Portable shard length does not match its prefix.");
  }
  if (fnv1a(bytes.subarray(SHARD_PREFIX_BYTES)) !== view.getUint32(16, true)) {
    throw new Error("Portable shard checksum does not match.");
  }
  const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(SHARD_PREFIX_BYTES, SHARD_PREFIX_BYTES + headerLength),
  )) as unknown;
  if (
    !isRecord(header)
    || !Array.isArray(header.namespaces)
    || !Array.isArray(header.notes)
    || (expectedShard !== undefined && header.shard !== expectedShard)
  ) {
    throw new Error("Portable shard header is invalid.");
  }
  const namespaces = header.namespaces.map((value) => (typeof value === "string" ? value : ""));
  const codes = new Int8Array(buffer);
  let offset = SHARD_PREFIX_BYTES + headerLength;
  const vectors: EmbeddingVector[] = [];

  for (const rawNote of header.notes) {
    if (!isRecord(rawNote) || !Array.isArray(rawNote.chunks)) throw new Error("Portable shard note is invalid.");
    const namespace = Number.isInteger(rawNote.namespace) ? namespaces[rawNote.namespace as number] ?? "" : "";
    const dimensions = namespaceDimensions(namespace);
    const withVectors = carriesVectors(namespace);
    if (withVectors && dimensions === null) throw new Error("Portable shard note has no dimensions.");
    const identity = parseManagedNamespace(namespace);
    const path = typeof rawNote.path === "string" ? rawNote.path : "";
    let valid = path.length > 0 && isFiniteNumber(rawNote.mtime) && isFiniteNumber(rawNote.createdAt);
    const decoded: EmbeddingVector[] = [];
    for (const rawChunk of rawNote.chunks) {
      // Consume this chunk's payload even when the note is rejected, so the
      // following notes stay aligned with their vectors.
      let vector: Float32Array | null;
      if (withVectors) {
        if (offset + SCALE_BYTES + dimensions! > buffer.byteLength) {
          throw new Error("Portable shard payload is truncated.");
        }
        vector = dequantizeInt8(codes, offset + SCALE_BYTES, dimensions!, view.getFloat32(offset, true));
        offset += SCALE_BYTES + dimensions!;
      } else {
        vector = new Float32Array(LOCAL_EMPTY_DIMENSION);
      }
      if (
        !valid
        || !vector
        || !isRecord(rawChunk)
        || !Number.isInteger(rawChunk.chunkId)
        || (rawChunk.chunkId as number) < 0
        || typeof rawChunk.contentHash !== "string"
        || !rawChunk.contentHash
      ) {
        valid = false;
        continue;
      }
      const chunkId = rawChunk.chunkId as number;
      const headingPath = Array.isArray(rawChunk.headingPath)
        && rawChunk.headingPath.length > 0
        && rawChunk.headingPath.every((heading) => typeof heading === "string")
        ? [...rawChunk.headingPath] as string[]
        : undefined;
      const sectionTitle = optionalString(rawChunk.sectionTitle) ?? headingPath?.join(" › ");
      const isEmpty = !withVectors || rawChunk.isEmpty === true;
      decoded.push({
        id: buildVectorId(namespace, path, chunkId),
        path,
        chunkId,
        vector,
        metadata: {
          title: optionalString(rawNote.title) ?? fileTitle(path),
          excerpt: optionalString(rawChunk.excerpt) ?? "",
          mtime: rawNote.mtime as number,
          contentHash: rawChunk.contentHash,
          ...(isEmpty ? { isEmpty: true } : {}),
          ...(identity ? { generation: identity.generationId } : {}),
          dimension: dimensions!,
          createdAt: rawNote.createdAt as number,
          namespace,
          ...(sectionTitle ? { sectionTitle } : {}),
          ...(headingPath ? { headingPath } : {}),
          ...(isFiniteNumber(rawChunk.chunkLength) ? { chunkLength: rawChunk.chunkLength } : {}),
          ...(chunkId === 0
            ? {
                ...(typeof rawNote.complete === "boolean" ? { complete: rawNote.complete } : {}),
                ...(typeof rawNote.partial === "boolean" ? { partial: rawNote.partial } : {}),
                ...(isFiniteNumber(rawNote.failedChunkCount) ? { failedChunkCount: rawNote.failedChunkCount } : {}),
                ...(isFiniteNumber(rawNote.chunkCount) ? { chunkCount: rawNote.chunkCount } : {}),
                ...(typeof rawNote.sourceSha256 === "string" ? { sourceSha256: rawNote.sourceSha256 } : {}),
              }
            : {}),
        },
      });
    }
    if (valid && decoded.some((vector) => vector.chunkId === 0)) vectors.push(...decoded);
  }
  if (offset !== buffer.byteLength) throw new Error("Portable shard payload has trailing bytes.");
  return vectors;
}

export function buildPortableManifest(committedNamespace: string | null): PortableIndexManifest {
  return {
    format: PORTABLE_INDEX_FORMAT,
    vectorEncoding: PORTABLE_VECTOR_ENCODING,
    shardCount: PORTABLE_SHARD_COUNT,
    committedNamespace: committedNamespace && isManagedNamespace(committedNamespace) ? committedNamespace : null,
  };
}

/** A format-4 manifest this build can read, or null. */
export function parsePortableManifest(value: unknown): PortableIndexManifest | null {
  if (
    !isRecord(value)
    || value.format !== PORTABLE_INDEX_FORMAT
    || value.vectorEncoding !== PORTABLE_VECTOR_ENCODING
    || !Number.isInteger(value.shardCount)
    || (value.shardCount as number) < 1
    || (value.shardCount as number) > 4096
  ) {
    return null;
  }
  return {
    format: PORTABLE_INDEX_FORMAT,
    vectorEncoding: PORTABLE_VECTOR_ENCODING,
    shardCount: value.shardCount as number,
    committedNamespace: typeof value.committedNamespace === "string" && isManagedNamespace(value.committedNamespace)
      ? value.committedNamespace
      : null,
  };
}
