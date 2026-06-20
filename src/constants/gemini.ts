// Google Gemini (generativelanguage.googleapis.com) native API constants.
//
// Unlike the OpenAI-compatible providers, Gemini puts the model id and the
// action in the URL path and authenticates with a dedicated header. The base
// URL (AI_PROVIDERS.GOOGLE.BASE_URL) ends at the API version; per-call the
// executor builds `${base}/models/{model}:${ACTION}?${QUERY}`.

export const GEMINI_API_VERSION = "v1beta";

// Auth is a dedicated header, NOT `Authorization: Bearer` or `x-api-key`.
export const GEMINI_API_KEY_HEADER = "x-goog-api-key";

// Streaming generation action + SSE query. `alt=sse` makes the API emit
// `data: <GenerateContentResponse JSON>` frames instead of a streamed JSON
// array, which is what GeminiStreamParser consumes.
export const GEMINI_STREAM_ACTION = "streamGenerateContent";
export const GEMINI_STREAM_QUERY = "alt=sse";

// Gemini candidate finishReason values we map onto the provider-agnostic
// stop-reason vocabulary (see StreamPipeline.mapFinishReasonToPiStopReason).
export const GEMINI_FINISH_REASONS = {
  STOP: "STOP",
  MAX_TOKENS: "MAX_TOKENS",
  SAFETY: "SAFETY",
  RECITATION: "RECITATION",
  OTHER: "OTHER",
} as const;

// Detects whether a configured endpoint targets the Gemini native API.
export function isGeminiEndpoint(endpoint: string): boolean {
  const lower = String(endpoint || "").toLowerCase();
  return lower.includes("generativelanguage.googleapis.com") || lower.includes("ai.google.dev");
}
