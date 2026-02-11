import { SystemSculptError } from "../../../utils/errors";

export type QuotaExceededClassification = {
  isTransientRateLimit: boolean;
  retryAfterSeconds: number;
};

function parsePositiveNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function classifyQuotaExceededError(error: SystemSculptError): QuotaExceededClassification {
  const metadata = (error.metadata ?? {}) as Record<string, unknown>;
  const rawError =
    metadata.rawError && typeof metadata.rawError === "object"
      ? (metadata.rawError as Record<string, unknown>)
      : {};

  const retryAfterSeconds =
    parsePositiveNumber(metadata.retryAfterSeconds) ||
    parsePositiveNumber(metadata.retryAfter) ||
    parsePositiveNumber(metadata.retry_after_seconds) ||
    parsePositiveNumber(metadata.retry_after) ||
    parsePositiveNumber(rawError.retryAfterSeconds) ||
    parsePositiveNumber(rawError.retry_after_seconds) ||
    parsePositiveNumber(rawError.retry_after);

  const explicitRetry = metadata.shouldRetry === true || metadata.isRateLimited === true;

  const upstreamMessage = typeof metadata.upstreamMessage === "string" ? metadata.upstreamMessage : "";
  const rawMessage = typeof rawError.message === "string" ? rawError.message : "";
  const fullMessage = `${error.message || ""} ${upstreamMessage} ${rawMessage}`.toLowerCase();

  const rateLimitLike = includesAny(fullMessage, [
    "rate-limited",
    "rate limited",
    "rate_limit",
    "rate-limit",
    "retry after",
    "too many requests",
    "retry shortly",
    "temporarily",
    "http 429",
    "status 429",
    "status code 429",
  ]);

  const hardQuotaLike = includesAny(fullMessage, [
    "quota exhausted",
    "usage quota exceeded",
    "insufficient quota",
    "insufficient_quota",
    "insufficient credits",
    "credits exhausted",
    "credit balance",
    "out of credits",
    "add credits",
    "purchase credits",
    "billing",
    "payment",
  ]);

  const transientEvidence = explicitRetry || retryAfterSeconds > 0 || rateLimitLike;
  const isTransientRateLimit = transientEvidence && !hardQuotaLike;

  return {
    isTransientRateLimit,
    retryAfterSeconds: Math.ceil(retryAfterSeconds),
  };
}
