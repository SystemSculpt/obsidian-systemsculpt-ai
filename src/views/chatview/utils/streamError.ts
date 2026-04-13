import { SystemSculptError, ERROR_CODES, isAuthFailureMessage } from "../../../utils/errors";

export type StreamErrorKind =
  | "rate_limit"
  | "auth"
  | "model_not_found"
  | "server"
  | "network"
  | "unknown";

export type StreamErrorClassification = {
  kind: StreamErrorKind;
  /** Human-readable summary for the Notice/UI. */
  userMessage: string;
  /** Retry delay in seconds, if parseable from the error. */
  retryAfterSeconds: number;
  /**
   * True when the error is expected to clear on its own quickly — short
   * provider rate limits, transient network blips. False when the user needs
   * to take action (hard usage caps, multi-hour cooldowns, plan exhaustion).
   * UI surfaces use this to choose Notice vs. modal.
   */
  transient: boolean;
};

const HARD_RATE_LIMIT_MARKERS = [
  "usage limit",
  "free plan",
  "free tier",
  "monthly limit",
  "daily limit",
  "exhausted",
  "out of credits",
  "billing",
  "subscription",
  "upgrade",
];

// Anything longer than this is treated as a hard limit the user has to deal
// with manually, not a transient cooldown to wait out.
const TRANSIENT_RATE_LIMIT_THRESHOLD_SECONDS = 60;

function isHardRateLimit(combined: string, retryAfterSeconds: number): boolean {
  if (retryAfterSeconds > TRANSIENT_RATE_LIMIT_THRESHOLD_SECONDS) {
    return true;
  }
  return HARD_RATE_LIMIT_MARKERS.some((marker) => combined.includes(marker));
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Extract a retry delay from free-form error text.
 * Matches patterns like "Try again in ~320 min", "retry after 30 seconds",
 * "wait 5 minutes", "Please wait ~2 hours".
 */
const RETRY_DELAY_RE =
  /(?:try again|retry|wait)\s+(?:in\s+)?~?\s*(\d+)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)/i;

function parseRetryDelay(text: string): number {
  const match = RETRY_DELAY_RE.exec(text);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  if (value <= 0) return 0;
  const unit = match[2].toLowerCase();
  if (unit.startsWith("h")) return value * 3600;
  if (unit.startsWith("m")) return value * 60;
  return value;
}

function formatWaitTime(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `~${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.round(minutes / 60);
  const remainMinutes = minutes % 60;
  if (remainMinutes === 0) return `~${hours}h`;
  return `~${hours}h ${remainMinutes}m`;
}

export function classifyStreamError(
  error: string | SystemSculptError,
): StreamErrorClassification {
  const message = typeof error === "string" ? error : error.message;
  const code = error instanceof SystemSculptError ? error.code : "";
  const metadata =
    error instanceof SystemSculptError
      ? ((error.metadata ?? {}) as Record<string, unknown>)
      : {};
  const upstreamMessage =
    typeof metadata.upstreamMessage === "string" ? metadata.upstreamMessage : "";
  const combined = `${message} ${upstreamMessage}`.toLowerCase();

  const retryAfterSeconds = parseRetryDelay(combined);

  const buildRateLimit = (): StreamErrorClassification => {
    const hard = isHardRateLimit(combined, retryAfterSeconds);
    const wait = formatWaitTime(retryAfterSeconds);
    const suffix = wait ? ` Try again in ${wait}.` : " Please try again later.";
    const messageHasRetryHint = /try again|retry|wait/i.test(message);
    const userMessage = hard
      ? messageHasRetryHint
        ? message
        : `${message || "Provider usage limit reached."}${suffix}`
      : `Provider rate limit reached.${suffix}`;
    return {
      kind: "rate_limit",
      userMessage,
      retryAfterSeconds,
      transient: !hard,
    };
  };

  // Short-circuit on structured error codes when available.
  if (code === ERROR_CODES.RATE_LIMIT_ERROR) {
    return buildRateLimit();
  }
  if (code === ERROR_CODES.NETWORK_ERROR) {
    return {
      kind: "network",
      userMessage: "Could not reach the provider. Check your internet connection and try again.",
      retryAfterSeconds: 0,
      transient: true,
    };
  }
  if (code === ERROR_CODES.SERVICE_UNAVAILABLE) {
    return {
      kind: "server",
      userMessage: "The provider is temporarily unavailable. Please try again in a moment.",
      retryAfterSeconds: 0,
      transient: true,
    };
  }
  if (code === ERROR_CODES.MODEL_UNAVAILABLE) {
    return {
      kind: "model_not_found",
      userMessage: "The selected model is not available. Try switching to a different model.",
      retryAfterSeconds: 0,
      transient: false,
    };
  }

  if (
    includesAny(combined, [
      "usage limit",
      "rate limit",
      "rate_limit",
      "rate-limit",
      "too many requests",
      "429",
      "quota exceeded",
      "request limit",
      "capacity",
    ])
  ) {
    return buildRateLimit();
  }

  if (isAuthFailureMessage(combined)) {
    return {
      kind: "auth",
      userMessage: "Authentication failed for this provider. Check Settings \u2192 Providers to reconnect.",
      retryAfterSeconds: 0,
      transient: false,
    };
  }

  if (
    includesAny(combined, [
      "model not found",
      "model does not exist",
      "no such model",
      "unknown model",
      "invalid model",
      "model_not_found",
      "model is not available",
    ])
  ) {
    return {
      kind: "model_not_found",
      userMessage: "The selected model is not available. Try switching to a different model.",
      retryAfterSeconds: 0,
      transient: false,
    };
  }

  if (
    includesAny(combined, [
      "internal server error",
      "502 bad gateway",
      "503 service unavailable",
      "service unavailable",
      "server error",
      "bad gateway",
      "overloaded",
    ])
  ) {
    return {
      kind: "server",
      userMessage: "The provider is temporarily unavailable. Please try again in a moment.",
      retryAfterSeconds: 0,
      transient: true,
    };
  }

  if (
    includesAny(combined, [
      "econnrefused",
      "etimedout",
      "enotfound",
      "fetch failed",
      "network error",
      "connection refused",
      "socket hang up",
      "dns resolution",
    ])
  ) {
    return {
      kind: "network",
      userMessage: "Could not reach the provider. Check your internet connection and try again.",
      retryAfterSeconds: 0,
      transient: true,
    };
  }

  const trimmed = message.length > 200 ? message.slice(0, 197) + "..." : message;
  return {
    kind: "unknown",
    userMessage: trimmed || "An unexpected error occurred. Please try again.",
    retryAfterSeconds: 0,
    transient: false,
  };
}
