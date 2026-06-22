/**
 * Typed transcription provider errors — the transcription twin of the embeddings
 * `EmbeddingsProviderError` (src/services/embeddings/providers/ProviderError.ts).
 *
 * Before #211 every transcription failure was a plain `new Error(message)` with
 * an ad-hoc `additionalInfo` bag, and retry decisions were made by substring-
 * matching the message ("is500Error"/"isNetworkError"). That makes it impossible
 * to tell a transient 429/5xx from a permanent 400, or a license/auth failure
 * from a malformed response, without parsing prose. This carries the same
 * structured fields the embeddings rework standardized on, so callers (the retry
 * layer, the recorder UX, config validation) can branch on typed fields.
 */

export type TranscriptionProviderErrorCode =
  | "HOST_UNAVAILABLE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "LICENSE_INVALID"
  | "UNEXPECTED_RESPONSE"
  | "INVALID_RESPONSE";

export interface TranscriptionProviderErrorOptions {
  code: TranscriptionProviderErrorCode;
  status?: number;
  retryInMs?: number;
  transient?: boolean;
  licenseRelated?: boolean;
  providerId?: string;
  endpoint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class TranscriptionProviderError extends Error {
  readonly code: TranscriptionProviderErrorCode;
  readonly status?: number;
  readonly retryInMs?: number;
  readonly transient: boolean;
  readonly licenseRelated: boolean;
  readonly providerId?: string;
  readonly endpoint?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(message: string, options: TranscriptionProviderErrorOptions) {
    super(message);
    this.name = "TranscriptionProviderError";
    this.code = options.code;
    this.status = options.status;
    this.retryInMs = options.retryInMs;
    this.transient = options.transient ?? false;
    this.licenseRelated = options.licenseRelated ?? false;
    this.providerId = options.providerId;
    this.endpoint = options.endpoint;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isTranscriptionProviderError(
  error: unknown,
): error is TranscriptionProviderError {
  return error instanceof TranscriptionProviderError;
}
