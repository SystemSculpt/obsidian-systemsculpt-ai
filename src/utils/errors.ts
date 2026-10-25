export const ERROR_CODES = {
  // Authentication Errors
  INVALID_LICENSE: "INVALID_LICENSE",
  LICENSE_EXPIRED: "LICENSE_EXPIRED",
  LICENSE_DISABLED: "LICENSE_DISABLED",
  PRO_REQUIRED: "PRO_REQUIRED",

  // Model Errors
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  MODEL_REQUEST_ERROR: "MODEL_REQUEST_ERROR",

  // Stream Errors
  STREAM_ERROR: "STREAM_ERROR",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  NO_IMAGE: "NO_IMAGE",

  // File Processing Errors
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
  PROCESSING_ERROR: "PROCESSING_ERROR",

  // Network Errors
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  RATE_LIMIT_ERROR: "RATE_LIMIT_ERROR",

  // Generic Errors
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",

  // Billing / Credits
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  TURN_IN_FLIGHT: "TURN_IN_FLIGHT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function toError(reason: unknown, fallbackMessage = "Operation failed."): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.trim() ? reason : fallbackMessage,
  ) as Error & { cause?: unknown };
  error.cause = reason;
  return error;
}

/**
 * True when a vault adapter call failed because its file or folder is not
 * there. Desktop adapters raise Node's ENOENT; the message forms cover
 * adapters that only say the path does not exist.
 */
export function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === "ENOENT") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /ENOENT|not found|does not exist|doesn't exist/i.test(message);
}

export class SystemSculptError extends Error {
  constructor(
    message: string,
    public code: ErrorCode = ERROR_CODES.UNKNOWN_ERROR,
    public statusCode: number = 500,
    public metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SystemSculptError";
  }
}

/** Single source for the "why is this locked" sentence shown across the plugin. */
export const PLAN_REQUIRED_MESSAGE =
  "Create a free account for 500 starter credits, or choose a plan.";

/** Pre-flight error thrown before contacting the server when no plan is active. */
export function planRequiredError(feature: string): SystemSculptError {
  return new SystemSculptError(
    `${feature} needs an active SystemSculpt plan. ${PLAN_REQUIRED_MESSAGE}`,
    ERROR_CODES.PRO_REQUIRED,
    401,
  );
}

const PLAN_ACCESS_CODES = new Set<string>([
  ERROR_CODES.PRO_REQUIRED,
  ERROR_CODES.INVALID_LICENSE,
  ERROR_CODES.LICENSE_EXPIRED,
  ERROR_CODES.LICENSE_DISABLED,
  "license_required",
  "license_rejected",
]);

/**
 * True when an error means the account has no usable plan or license —
 * the local pre-flight error, client license codes, or the managed
 * service's structured `license_required`/`license_rejected` payloads.
 */
export function isPlanAccessError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && PLAN_ACCESS_CODES.has(code);
}

/** Shared wording for a managed request the account cannot currently fund. */
export const CREDITS_REQUIRED_MESSAGE = "Not enough credits are available. Add credits to continue.";

const CREDITS_REQUIRED_CODES = new Set<string>([
  ERROR_CODES.INSUFFICIENT_CREDITS,
  "insufficient_credits",
  "out_of_credits",
  "payment_required",
]);

/**
 * True when an error means the account lacks credits: a structured credits
 * code or an HTTP 402. Follows the originalError/cause chain because managed
 * transcription wraps its transport failure in a recovery error.
 */
export function isCreditsRequiredError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const { code, status } = current as { code?: unknown; status?: unknown };
    if (typeof code === "string" && CREDITS_REQUIRED_CODES.has(code)) return true;
    if (status === 402) return true;
    const wrapper = current as { originalError?: unknown; cause?: unknown };
    current = wrapper.originalError ?? wrapper.cause;
  }
  return false;
}
