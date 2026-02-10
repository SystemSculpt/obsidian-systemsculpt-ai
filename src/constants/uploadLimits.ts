// Serverless request bodies are capped at ~4.5MiB (platform hard limit); leave headroom for multipart boundaries.
// Note: We use MiB because the UI formatter reports "MB" based on 1024*1024.
const SERVERLESS_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const DOCUMENT_UPLOAD_MAX_BYTES =
  SERVERLESS_BODY_LIMIT_BYTES - MULTIPART_OVERHEAD_BYTES;
export const AUDIO_UPLOAD_MAX_BYTES = DOCUMENT_UPLOAD_MAX_BYTES;
