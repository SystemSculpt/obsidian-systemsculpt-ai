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

const AUTH_FAILURE_SNIPPETS = [
  "invalid license",
  "license key invalid",
  "license key missing",
  "missing license key",
  "authentication failed",
  "authentication failure",
  "authentication error",
  "too many authentication failures",
  "unauthorized",
  "unauthorised",
  "not authorized",
  "invalid token",
  "token invalid",
  "bad credentials",
  "access denied",
  "permission denied",
  "forbidden"
];

export function isAuthFailureMessage(message?: string | null): boolean {
  if (!message) return false;
  const normalized = String(message).toLowerCase();
  if (/\b401\b/.test(normalized) || /\b403\b/.test(normalized)) {
    return true;
  }
  return AUTH_FAILURE_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

/**
 * Detect common "prompt too long / context length exceeded" gateway errors.
 */
export function isContextOverflowErrorMessage(message?: string | null): boolean {
  if (!message) return false;
  const lc = String(message).toLowerCase();
  if (!lc) return false;

  if (lc.includes("context_length_exceeded")) return true;
  if (lc.includes("maximum context length")) return true;
  if (lc.includes("context length") && (lc.includes("exceed") || lc.includes("greater than") || lc.includes("too long") || lc.includes("limit"))) {
    return true;
  }
  if (lc.includes("context window") && (lc.includes("exceed") || lc.includes("too long") || lc.includes("too small") || lc.includes("limit"))) {
    return true;
  }
  if (lc.includes("prompt is too long") || lc.includes("prompt too long")) return true;
  if (lc.includes("too many tokens") && (lc.includes("maximum") || lc.includes("context") || lc.includes("limit"))) return true;

  return false;
}


export class SystemSculptError extends Error {
  constructor(
    message: string,
    public code: ErrorCode = ERROR_CODES.UNKNOWN_ERROR,
    public statusCode: number = 500,
    public metadata?: Record<string, any>,
  ) {
    super(message);
    this.name = "SystemSculptError";
  }
}

/**
 * Identify managed SystemSculpt license/subscription failures. The v6 client
 * has no alternate authentication authority, so both license codes are owned
 * by the SystemSculpt account flow.
 */
export function isManagedLicenseFailure(error: unknown): error is SystemSculptError {
  if (!(error instanceof SystemSculptError)) return false;
  return error.code === ERROR_CODES.LICENSE_EXPIRED || error.code === ERROR_CODES.INVALID_LICENSE;
}

/**
 * Get a user-friendly error message for the given error code
 */
export function getErrorMessage(code: ErrorCode): string {
  const messages: Record<ErrorCode, string> = {
    // Authentication Errors
    [ERROR_CODES.INVALID_LICENSE]: "Invalid license key. Please check your license in settings.",
    [ERROR_CODES.LICENSE_EXPIRED]: "Your license has expired. Please renew your subscription.",
    [ERROR_CODES.LICENSE_DISABLED]: "Your license has been disabled. Please contact support.",
    [ERROR_CODES.PRO_REQUIRED]: "This feature requires a Pro license. Please upgrade your subscription.",

    // Model Errors
    [ERROR_CODES.MODEL_UNAVAILABLE]: "SystemSculpt cannot run this request right now. Please try again.",
    [ERROR_CODES.MODEL_REQUEST_ERROR]: "SystemSculpt could not process your request. Please try again.",

    // Stream Errors
    [ERROR_CODES.STREAM_ERROR]: "Error in streaming response. Please try again.",
    [ERROR_CODES.INVALID_RESPONSE]: "Received invalid response from the service. Please try again.",
    [ERROR_CODES.NO_IMAGE]: "No image detected in the current note.",

    // File Processing Errors
    [ERROR_CODES.FILE_NOT_FOUND]: "File not found. Please check the file path.",
    [ERROR_CODES.FILE_TOO_LARGE]: "File is too large to process. Please try with a smaller file.",
    [ERROR_CODES.UNSUPPORTED_FORMAT]: "Unsupported file format. Please try with a supported format.",
    [ERROR_CODES.PROCESSING_ERROR]: "Error processing the file. Please try again.",

    // Network Errors
    [ERROR_CODES.NETWORK_ERROR]: "Network error. Please check your internet connection.",
    [ERROR_CODES.TIMEOUT_ERROR]: "Request timed out. Please try again.",
    [ERROR_CODES.SERVICE_UNAVAILABLE]: "Service is temporarily unavailable. Please try again later.",
    [ERROR_CODES.RATE_LIMIT_ERROR]: "Rate limit exceeded. Please wait a moment before trying again.",

    // Generic Errors
    [ERROR_CODES.UNKNOWN_ERROR]: "An unexpected error occurred. Please try again.",
    [ERROR_CODES.QUOTA_EXCEEDED]: "Usage quota exceeded. Please check your account limits.",

    // Billing / Credits
    [ERROR_CODES.INSUFFICIENT_CREDITS]: "Insufficient credits. Please add credits to continue.",
    [ERROR_CODES.TURN_IN_FLIGHT]: "A previous request is still processing. Please wait for it to finish.",
  };

  return messages[code];
}
