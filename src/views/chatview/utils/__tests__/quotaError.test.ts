import { SystemSculptError, ERROR_CODES } from "../../../../utils/errors";
import { classifyQuotaExceededError } from "../quotaError";

describe("classifyQuotaExceededError", () => {
  it("classifies retryable upstream throttling as transient", () => {
    const error = new SystemSculptError(
      "Provider returned error is temporarily rate-limited upstream. Please retry shortly.",
      ERROR_CODES.QUOTA_EXCEEDED,
      429,
      {
        shouldRetry: true,
        isRateLimited: true,
        retryAfterSeconds: 3,
      }
    );

    const result = classifyQuotaExceededError(error);
    expect(result.isTransientRateLimit).toBe(true);
    expect(result.retryAfterSeconds).toBe(3);
  });

  it("does not classify hard quota exhaustion as transient", () => {
    const error = new SystemSculptError(
      "Quota exhausted. Add credits to continue.",
      ERROR_CODES.QUOTA_EXCEEDED,
      402
    );

    const result = classifyQuotaExceededError(error);
    expect(result.isTransientRateLimit).toBe(false);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("does not classify 429 insufficient_quota errors as transient", () => {
    const error = new SystemSculptError(
      "OpenAI error: insufficient_quota. Please add credits.",
      ERROR_CODES.QUOTA_EXCEEDED,
      429,
      {
        statusCode: 429,
      }
    );

    const result = classifyQuotaExceededError(error);
    expect(result.isTransientRateLimit).toBe(false);
    expect(result.retryAfterSeconds).toBe(0);
  });
});
