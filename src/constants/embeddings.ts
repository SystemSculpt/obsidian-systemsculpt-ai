/**
 * Embeddings constants and model lists
 * Centralizes defaults and legacy model detection across server and client.
 */

// Default OpenRouter embeddings model
export const DEFAULT_EMBEDDING_MODEL = "openrouter/openai/text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSION = 1536;

// Models we actively support/expose
export const SUPPORTED_EMBEDDING_MODELS: string[] = [
  "openrouter/openai/text-embedding-3-small",
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
];

// Models considered legacy that should trigger re-embedding
export const LEGACY_EMBEDDING_MODELS: string[] = [
  // OpenAI legacy
  "text-embedding-ada-002",
  "text-embedding-002",
  // Early Gemini embedding models we are retiring
  "text-embedding-004",
  "text-embedding-004-multilingual",
  "gemini/text-embedding-004",
  "google/text-embedding-004",
  "gemini-embedding-001",
];

// Max items we allow per batch call to the embeddings service
export const MAX_EMBEDDING_BATCH: number = 25;

// Embedding schema version tracks client-side changes that affect
// how we preprocess, chunk, and namespace embeddings. Bump this
// when the preprocessing/chunking logic materially changes so
// previously stored vectors are treated as stale for reuse and search.
export const EMBEDDING_SCHEMA_VERSION = 2;
