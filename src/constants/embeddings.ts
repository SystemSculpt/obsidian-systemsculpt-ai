// Embedding schema version tracks client-side changes that affect
// how we preprocess, chunk, and namespace embeddings. Bump this
// when the preprocessing/chunking logic materially changes so
// previously stored vectors are treated as stale for reuse and search.
export const EMBEDDING_SCHEMA_VERSION = 2;
