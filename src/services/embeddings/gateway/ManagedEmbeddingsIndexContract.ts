import type { ManagedTransportResult } from "../../managed/ManagedTypes";

export const MANAGED_EMBEDDINGS_INDEX_CONTRACT = "managed-embeddings-index-v1" as const;
export const MANAGED_EMBEDDINGS_INDEX_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_MAX_JSON_BYTES = 64 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_VECTOR_ENCODING = "float32-le-base64" as const;
export const MANAGED_EMBEDDINGS_INDEX_MAX_QUERY_BYTES = 16 * 1024;
export const MANAGED_EMBEDDINGS_INDEX_MAX_QUERY_CHARS = 8_000;

/** The gateway's wire boundary, independent of the concrete hosted transport. */
export interface ManagedEmbeddingsIndexTransport {
  managedEmbeddingsIndex(body: ArrayBuffer, contentSha256: string, signal?: AbortSignal): Promise<ManagedTransportResult>;
  getManagedEmbeddingsIndexMetadata(signal?: AbortSignal): Promise<ManagedTransportResult>;
  managedEmbeddingsIndexQuery(query: string, contentSha256: string, signal?: AbortSignal): Promise<ManagedTransportResult>;
}
