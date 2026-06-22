/**
 * providerHttpErrors - pure classification of an HTTP failure from a transcription
 * endpoint into the typed `TranscriptionProviderError` shape. The transcription
 * twin of the embeddings `providerHttpErrors`.
 *
 * The current code decides retries by substring-matching error messages
 * ("is500Error", "isNetworkError"). This maps a status code to
 * {code, transient, retryInMs} so the retry layer and the recorder UX can act on
 * typed fields, and so the self-hosted Whisper contract has a single definition
 * of which failures are retryable.
 */

import type {
  TranscriptionProviderErrorCode,
  TranscriptionProviderErrorOptions,
} from "./ProviderError";

export interface TranscriptionHttpClassification {
  code: TranscriptionProviderErrorCode;
  transient: boolean;
  retryInMs?: number;
}

/**
 * Parse a `Retry-After` header (case-insensitive) into milliseconds. Whisper
 * endpoints send integer seconds; the HTTP-date form is not parsed here (kept
 * pure / Date-free) and yields undefined.
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
 * Classify an HTTP status (and optional headers) from a transcription endpoint.
 *  - 429            -> RATE_LIMITED, transient, retryInMs from Retry-After
 *  - 408 / >= 500   -> HTTP_ERROR, transient (timeouts and server faults retry)
 *  - <= 0           -> HTTP_ERROR, transient (no usable status from transport)
 *  - other          -> HTTP_ERROR, permanent (4xx client errors do not retry)
 */
export function classifyTranscriptionHttpStatus(
  status: number,
  headers?: Record<string, string>,
): TranscriptionHttpClassification {
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      transient: true,
      retryInMs: parseRetryAfterMs(headers),
    };
  }
  if (status <= 0 || status === 408 || status >= 500) {
    return { code: "HTTP_ERROR", transient: true };
  }
  return { code: "HTTP_ERROR", transient: false };
}

/**
 * Build the `TranscriptionProviderError` options for a failed transcription HTTP
 * call, merging the status classification with provider/endpoint context.
 */
export function buildTranscriptionHttpErrorOptions(args: {
  status: number;
  headers?: Record<string, string>;
  providerId: string;
  endpoint: string;
  details?: Record<string, unknown>;
}): TranscriptionProviderErrorOptions {
  const classification = classifyTranscriptionHttpStatus(args.status, args.headers);
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
