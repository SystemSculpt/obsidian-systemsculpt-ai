/**
 * Readwise Service Error
 * Custom error class for Readwise API operations
 */

export type ReadwiseErrorCode =
  | "AUTH_INVALID"
  | "AUTH_EXPIRED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "API_ERROR"
  | "FILE_WRITE_ERROR"
  | "INVALID_RESPONSE"
  | "SYNC_CANCELLED";

export interface ReadwiseErrorOptions {
  code: ReadwiseErrorCode;
  status?: number;
  retryAfterMs?: number;
  transient?: boolean;
  details?: Record<string, unknown>;
}

export class ReadwiseServiceError extends Error {
  readonly code: ReadwiseErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly transient: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: ReadwiseErrorOptions) {
    super(message);
    this.name = "ReadwiseServiceError";
    this.code = options.code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.transient = options.transient ?? false;
    this.details = options.details;
  }

  /**
   * Create error from HTTP response
   */
  static fromHttpStatus(status: number, message?: string): ReadwiseServiceError {
    switch (status) {
      case 401:
        return new ReadwiseServiceError(
          message || "Invalid or expired Readwise API token",
          { code: "AUTH_INVALID", status, transient: false }
        );
      case 429:
        return new ReadwiseServiceError(
          message || "Rate limited by Readwise API",
          { code: "RATE_LIMITED", status, transient: true }
        );
      case 500:
      case 502:
      case 503:
      case 504:
        return new ReadwiseServiceError(
          message || "Readwise API server error",
          { code: "API_ERROR", status, transient: true }
        );
      default:
        return new ReadwiseServiceError(
          message || `Readwise API error (${status})`,
          { code: "API_ERROR", status, transient: false }
        );
    }
  }

  /**
   * Create error for network failures
   */
  static networkError(originalError: Error): ReadwiseServiceError {
    return new ReadwiseServiceError(
      `Network error: ${originalError.message}`,
      {
        code: "NETWORK_ERROR",
        transient: true,
        details: { originalError: originalError.message },
      }
    );
  }

  /**
   * Create error for file write failures
   */
  static fileWriteError(path: string, originalError: Error): ReadwiseServiceError {
    return new ReadwiseServiceError(
      `Failed to write file: ${path}`,
      {
        code: "FILE_WRITE_ERROR",
        transient: false,
        details: { path, originalError: originalError.message },
      }
    );
  }

  /**
   * Create error for cancelled sync
   */
  static syncCancelled(): ReadwiseServiceError {
    return new ReadwiseServiceError("Sync was cancelled", {
      code: "SYNC_CANCELLED",
      transient: false,
    });
  }

  /**
   * Check if error is recoverable with retry
   */
  isRetryable(): boolean {
    return this.transient && this.code !== "SYNC_CANCELLED";
  }
}
