export type EmbeddingsProviderErrorCode =
  | "HOST_UNAVAILABLE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "LICENSE_INVALID"
  | "UNEXPECTED_RESPONSE"
  | "INVALID_RESPONSE";

export interface EmbeddingsProviderErrorOptions {
  code: EmbeddingsProviderErrorCode;
  status?: number;
  retryInMs?: number;
  transient?: boolean;
  licenseRelated?: boolean;
  providerId?: string;
  endpoint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class EmbeddingsProviderError extends Error {
  readonly code: EmbeddingsProviderErrorCode;
  readonly status?: number;
  readonly retryInMs?: number;
  readonly transient: boolean;
  readonly licenseRelated: boolean;
  readonly providerId?: string;
  readonly endpoint?: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(message: string, options: EmbeddingsProviderErrorOptions) {
    super(message);
    this.name = "EmbeddingsProviderError";
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

export function isEmbeddingsProviderError(error: unknown): error is EmbeddingsProviderError {
  return error instanceof EmbeddingsProviderError;
}
