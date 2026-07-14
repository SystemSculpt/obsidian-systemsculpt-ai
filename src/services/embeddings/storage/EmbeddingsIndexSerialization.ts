/**
 * EmbeddingsIndexSerialization - portable, device-independent encoding of the
 * embedding index.
 *
 * The on-disk IndexedDB store is scoped to a per-install `vaultInstanceId`, so it
 * is never captured by Obsidian Sync/backup and never restored on a new device.
 * This module turns the store's `EmbeddingVector[]` into a versioned JSON
 * envelope that CAN live in the synced vault, and back again.
 *
 * Vectors are encoded as explicit little-endian Float32 bytes (via DataView) and
 * base64'd, so the snapshot round-trips byte-for-byte across platforms. The
 * Each record carries a first-party generation namespace with no device
 * identity, so a restored snapshot needs no remapping.
 *
 * Pure module: no IndexedDB, no Obsidian, no Node — safe to load in any runtime.
 */

import type { EmbeddingVector } from "../types";
import { LOCAL_EMPTY_EMBEDDING_NAMESPACE } from "../LocalEmptyEmbeddingMarker";
import {
  isManagedNamespace,
  MANAGED_EMBEDDING_GENERATION,
  parseNamespaceDimension,
} from "../utils/namespace";

/** Bump when the envelope shape changes incompatibly. */
export const EMBEDDINGS_INDEX_FORMAT = 2;

export interface SerializedEmbeddingVector {
  id: string;
  path: string;
  chunkId: number;
  /** Base64 of the vector's little-endian Float32 bytes ("" for empty vectors). */
  vector: string;
  metadata: EmbeddingVector["metadata"];
}

export interface SerializedEmbeddingsIndex {
  format: number;
  /** Snapshot creation time (caller-supplied; null when unknown). */
  createdAt: number | null;
  vectorCount: number;
  vectors: SerializedEmbeddingVector[];
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (!BASE64_PATTERN.test(base64)) {
    throw new Error("Invalid base64 payload.");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function float32ToBase64(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) {
    view.setFloat32(i * 4, vector[i], true);
  }
  return bytesToBase64(bytes);
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
 * Encode an in-memory index into a portable, versioned envelope.
 */
export function serializeEmbeddingsIndex(
  vectors: EmbeddingVector[],
  opts: { createdAt?: number | null } = {},
): SerializedEmbeddingsIndex {
  const serializedVectors: SerializedEmbeddingVector[] = [];
  for (const vector of vectors) {
    if (!vector || typeof vector.id !== "string" || typeof vector.path !== "string") {
      continue;
    }
    const float = vector.vector instanceof Float32Array ? vector.vector : new Float32Array(0);
    serializedVectors.push({
      id: vector.id,
      path: vector.path,
      chunkId: parseChunkId(vector.chunkId, vector.id),
      vector: float32ToBase64(float),
      metadata: vector.metadata,
    });
  }

  return {
    format: EMBEDDINGS_INDEX_FORMAT,
    createdAt: typeof opts.createdAt === "number" ? opts.createdAt : null,
    vectorCount: serializedVectors.length,
    vectors: serializedVectors,
  };
}

/**
 * Decode a portable envelope back into `EmbeddingVector[]`.
 *
 * Fails safe: an unknown format or a non-array payload yields `[]` (the caller
 * re-embeds), and individual malformed/corrupt records are skipped rather than
 * aborting the whole restore.
 */
export function deserializeEmbeddingsIndex(input: unknown): EmbeddingVector[] {
  if (!input || typeof input !== "object") return [];
  const envelope = input as Partial<SerializedEmbeddingsIndex>;
  if (envelope.format !== EMBEDDINGS_INDEX_FORMAT) return [];
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
    const validManaged = isManagedNamespace(namespace)
      && metadata.generation === MANAGED_EMBEDDING_GENERATION
      && float.length > 0
      && metadata.dimension === float.length
      && parseNamespaceDimension(namespace) === float.length;
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
