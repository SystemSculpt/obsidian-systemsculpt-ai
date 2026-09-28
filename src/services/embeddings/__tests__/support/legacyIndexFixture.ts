/**
 * Writes the format-3 single-file index that releases before the sharded
 * snapshot produced. Production code only reads that format; tests build it
 * here to prove migration and cross-device restore keep working.
 */

import type { EmbeddingVector } from "../../types";
import {
  LEGACY_EMBEDDINGS_INDEX_FORMAT,
  type SerializedEmbeddingVector,
  type SerializedEmbeddingsIndex,
} from "../../storage/EmbeddingsIndexSerialization";
import { bytesToBase64 } from "../../../../utils/base64";

function float32ToBase64(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) view.setFloat32(index * 4, vector[index], true);
  return bytesToBase64(bytes);
}

export function serializeLegacyEmbeddingsIndex(
  vectors: EmbeddingVector[],
  opts: { createdAt?: number | null } = {},
): SerializedEmbeddingsIndex {
  const serialized: SerializedEmbeddingVector[] = vectors.map((vector) => ({
    id: vector.id,
    path: vector.path,
    chunkId: vector.chunkId ?? 0,
    vector: float32ToBase64(vector.vector instanceof Float32Array ? vector.vector : new Float32Array(0)),
    metadata: vector.metadata,
  }));
  return {
    format: LEGACY_EMBEDDINGS_INDEX_FORMAT,
    createdAt: typeof opts.createdAt === "number" ? opts.createdAt : null,
    vectorCount: serialized.length,
    vectors: serialized,
  };
}
