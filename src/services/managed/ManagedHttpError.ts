type ManagedHttpErrorCode =
  | "invalid_request"
  | "license_required"
  | "payment_required"
  | "license_rejected"
  | "not_found"
  | "operation_conflict"
  | "upgrade_required"
  | "rate_limited"
  | "temporarily_unavailable";

const CLIENT_ERROR_CODES: Readonly<Record<number, ManagedHttpErrorCode>> = Object.freeze({
  400: "invalid_request",
  401: "license_required",
  402: "payment_required",
  403: "license_rejected",
  404: "not_found",
  409: "operation_conflict",
  413: "invalid_request",
  422: "invalid_request",
  426: "upgrade_required",
  429: "rate_limited",
});

/**
 * HTTP fallback for managed requests, not a decoder for a negotiated error
 * envelope. A validated protocol's explicit retry decision takes precedence.
 */
export function classifyManagedHttpError(status: number): Readonly<{
  code: ManagedHttpErrorCode | undefined;
  retryable: boolean;
}> {
  const serverFailure = Number.isInteger(status) && status >= 500 && status < 600;
  return {
    code: serverFailure ? "temporarily_unavailable" : CLIENT_ERROR_CODES[status],
    retryable: serverFailure || status === 429,
  };
}
