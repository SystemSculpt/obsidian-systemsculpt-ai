import type { ManagedEmbeddingLimits } from "./types";

/** Published by the first-party `systemsculpt/embeddings` capability. */
export const MANAGED_EMBEDDING_LIMITS: Readonly<ManagedEmbeddingLimits> = Object.freeze({
  maxTexts: 128,
  maxCharsPerText: 8_000,
  maxTotalChars: 200_000,
});

export const MANAGED_EMBEDDING_GENERATION_ID = "semantic-v1" as const;
export const MANAGED_EMBEDDING_INDEX_SCHEMA_VERSION = 2 as const;
