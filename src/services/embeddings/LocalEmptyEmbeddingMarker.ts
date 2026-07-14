import type { TFile } from "obsidian";
import type { EmbeddingVector } from "./types";
import { buildVectorId } from "./utils/vectorId";

const LOCAL_EMPTY_DIMENSION = 1;

/**
 * A local-only namespace for files whose markdown has no semantic text after
 * normalization (for example, frontmatter-only or image-only notes). Keeping
 * it outside the managed namespace prevents it from becoming an embedding
 * dimension hint.
 */
export const LOCAL_EMPTY_EMBEDDING_NAMESPACE = "systemsculpt:local-empty:v1:1";

export interface LocalEmptyEmbeddingRevision {
  path: string;
  basename: string;
  mtime: number;
}

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
  return createLocalEmptyEmbeddingMarkerForRevision({
    path: file.path,
    basename: file.basename,
    mtime: file.stat?.mtime ?? Date.now(),
  }, source);
}

export function createLocalEmptyEmbeddingMarkerForRevision(
  revision: LocalEmptyEmbeddingRevision,
  source: string,
): EmbeddingVector {
  return {
    id: localEmptyEmbeddingMarkerId(revision.path),
    path: revision.path,
    chunkId: 0,
    vector: new Float32Array(LOCAL_EMPTY_DIMENSION),
    metadata: {
      title: revision.basename,
      excerpt: "",
      mtime: revision.mtime,
      contentHash: localContentHash(source),
      isEmpty: true,
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
