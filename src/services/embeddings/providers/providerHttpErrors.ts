/**
 * providerHttpErrors - pure classification of an HTTP failure from a custom
 * embeddings endpoint into the typed `EmbeddingsProviderError` shape.
 *
 * Before #208 the CustomProvider threw plain `Error("Custom API error 429: ...")`
 * strings, so the manager (and the retry/backoff work in the next slice) could
 * not tell a transient 429/503 apart from a permanent 400 — every failure looked
 * the same. This maps a status code to {code, transient, retryInMs} so callers
 * can decide whether to retry, and how long to wait, from typed fields instead
 * of regex-matching messages.
 */

import type {
  EmbeddingsProviderErrorCode,
  EmbeddingsProviderErrorOptions,
} from "./ProviderError";

export interface EmbeddingsHttpClassification {
  code: EmbeddingsProviderErrorCode;
  transient: boolean;
  retryInMs?: number;
}

/**
 * Parse a `Retry-After` header value (case-insensitive lookup by the caller)
 * into milliseconds. Embedding APIs send integer seconds; the HTTP-date form is
 * not parsed here (kept pure / Date-free) and yields `undefined`.
 */
export function parseRetryAfterMs(
  headers?: Record<string, string>,
): number | undefined {
  if (!headers) return undefined;
  let raw: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "retry-after") {
      raw = value;
      break;
    }
  }
  if (raw == null) return undefined;
  const seconds = Number(String(raw).trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Classify an HTTP status (and optional headers) from a custom endpoint.
 *  - 429            -> RATE_LIMITED, transient, retryInMs from Retry-After
 *  - 408 / >= 500   -> HTTP_ERROR, transient (timeouts and server faults retry)
 *  - other          -> HTTP_ERROR, permanent (4xx client errors do not retry)
 */
export function classifyEmbeddingsHttpStatus(
  status: number,
  headers?: Record<string, string>,
): EmbeddingsHttpClassification {
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      transient: true,
      retryInMs: parseRetryAfterMs(headers),
    };
  }
  // <= 0 means the transport gave us no usable status (treat as retryable);
  // 408 (timeout) and 5xx (server fault) are transient too.
  if (status <= 0 || status === 408 || status >= 500) {
    return { code: "HTTP_ERROR", transient: true };
  }
  return { code: "HTTP_ERROR", transient: false };
}

/**
 * Build the `EmbeddingsProviderError` options for a failed custom-endpoint HTTP
 * call, merging the status classification with provider/endpoint context.
 */
export function buildHttpErrorOptions(args: {
  status: number;
  headers?: Record<string, string>;
  providerId: string;
  endpoint: string;
  details?: Record<string, unknown>;
}): EmbeddingsProviderErrorOptions {
  const classification = classifyEmbeddingsHttpStatus(args.status, args.headers);
  return {
    code: classification.code,
    status: args.status,
    transient: classification.transient,
    retryInMs: classification.retryInMs,
    providerId: args.providerId,
    endpoint: args.endpoint,
    details: args.details,
  };
}
