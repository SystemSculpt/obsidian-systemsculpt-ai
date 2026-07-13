import type { TFile } from "obsidian";
import type { EmbeddingVector } from "./types";
import { buildNamespaceWithSchema } from "./utils/namespace";
import { buildVectorId } from "./utils/vectorId";

const LOCAL_EMPTY_MODEL = "local-empty";
const LOCAL_EMPTY_DIMENSION = 1;

/**
 * A local-only namespace for files whose markdown has no semantic text after
 * normalization (for example, frontmatter-only or image-only notes). Keeping
 * it outside the managed namespace prevents it from becoming an embedding
 * dimension hint.
 */
export const LOCAL_EMPTY_EMBEDDING_NAMESPACE = buildNamespaceWithSchema(
  "systemsculpt",
  LOCAL_EMPTY_MODEL,
  1,
  LOCAL_EMPTY_DIMENSION,
);

export function localEmptyEmbeddingMarkerId(path: string): string {
  return buildVectorId(LOCAL_EMPTY_EMBEDDING_NAMESPACE, path, 0);
}

export function isLocalEmptyEmbeddingMarker(vector: EmbeddingVector | null | undefined): boolean {
  return Boolean(
    vector
    && vector.chunkId === 0
    && vector.metadata.isEmpty === true
    && vector.metadata.namespace === LOCAL_EMPTY_EMBEDDING_NAMESPACE,
  );
}

export function isCurrentLocalEmptyEmbeddingMarker(
  vector: EmbeddingVector | null | undefined,
  file: TFile,
): boolean {
  return isLocalEmptyEmbeddingMarker(vector)
    && typeof file.stat?.mtime === "number"
    && (vector?.metadata.mtime ?? 0) >= file.stat.mtime;
}

export function createLocalEmptyEmbeddingMarker(file: TFile, source: string): EmbeddingVector {
  const mtime = file.stat?.mtime ?? Date.now();
  return {
    id: localEmptyEmbeddingMarkerId(file.path),
    path: file.path,
    chunkId: 0,
    vector: new Float32Array(LOCAL_EMPTY_DIMENSION),
    metadata: {
      title: file.basename,
      excerpt: "",
      mtime,
      contentHash: localContentHash(source),
      isEmpty: true,
      provider: "systemsculpt",
      model: LOCAL_EMPTY_MODEL,
      dimension: LOCAL_EMPTY_DIMENSION,
      createdAt: Date.now(),
      namespace: LOCAL_EMPTY_EMBEDDING_NAMESPACE,
      chunkLength: 0,
      complete: true,
      partial: false,
      failedChunkCount: 0,
      chunkCount: 0,
    },
  };
}

function localContentHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `empty:${(hash >>> 0).toString(36)}`;
}
