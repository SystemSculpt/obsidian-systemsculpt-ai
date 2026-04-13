import { classifyStreamError } from "../streamError";
import { SystemSculptError, ERROR_CODES } from "../../../../utils/errors";

describe("classifyStreamError", () => {
  describe("rate limit detection", () => {
    it("detects ChatGPT usage limit with retry timing as a hard (non-transient) limit", () => {
      const result = classifyStreamError(
        "You have hit your ChatGPT usage limit (free plan). Try again in ~320 min.",
      );
      expect(result.kind).toBe("rate_limit");
      expect(result.retryAfterSeconds).toBe(320 * 60);
      expect(result.transient).toBe(false);
      // Hard limits keep the original upstream message verbatim so the user
      // sees the exact retry hint the provider returned.
      expect(result.userMessage).toContain("ChatGPT usage limit");
      expect(result.userMessage).toContain("~320 min");
    });

    it("detects generic rate limit as transient", () => {
      const result = classifyStreamError("Rate limit exceeded");
      expect(result.kind).toBe("rate_limit");
      expect(result.transient).toBe(true);
    });

    it("detects 429 status as transient", () => {
      const result = classifyStreamError("HTTP 429 Too Many Requests");
      expect(result.kind).toBe("rate_limit");
      expect(result.transient).toBe(true);
    });

    it("detects quota exceeded as transient (no hard markers, no long retry)", () => {
      const result = classifyStreamError("Quota exceeded for this model");
      expect(result.kind).toBe("rate_limit");
      expect(result.transient).toBe(true);
    });

    it("parses short retry time in seconds as transient", () => {
      const result = classifyStreamError("Rate limited. Try again in 30 seconds.");
      expect(result.kind).toBe("rate_limit");
      expect(result.retryAfterSeconds).toBe(30);
      expect(result.transient).toBe(true);
      expect(result.userMessage).toContain("~30s");
    });

    it("parses retry time in hours as a hard limit", () => {
      const result = classifyStreamError("Usage limit. Try again in ~2 hours.");
      expect(result.retryAfterSeconds).toBe(7200);
      expect(result.transient).toBe(false);
      // Original message preserved when it already contains the wait hint.
      expect(result.userMessage).toContain("Usage limit");
      expect(result.userMessage).toContain("2 hours");
    });

    it("flags free-plan exhaustion as a hard limit even with a short delay", () => {
      const result = classifyStreamError("Free plan capacity reached.");
      expect(result.kind).toBe("rate_limit");
      expect(result.transient).toBe(false);
    });
  });

  describe("auth error detection", () => {
    it("detects unauthorized", () => {
      const result = classifyStreamError("Unauthorized: invalid API key");
      expect(result.kind).toBe("auth");
      expect(result.userMessage).toContain("Authentication failed");
      expect(result.userMessage).toContain("Providers");
    });

    it("detects bad credentials", () => {
      const result = classifyStreamError("Bad credentials: token is not valid.");
      expect(result.kind).toBe("auth");
    });

    it("detects forbidden", () => {
      const result = classifyStreamError("403 Forbidden");
      expect(result.kind).toBe("auth");
    });
  });

  describe("model not found detection", () => {
    it("detects model not found", () => {
      const result = classifyStreamError("Model not found: gpt-5-turbo");
      expect(result.kind).toBe("model_not_found");
      expect(result.userMessage).toContain("not available");
    });

    it("detects unknown model", () => {
      const result = classifyStreamError("Unknown model specified");
      expect(result.kind).toBe("model_not_found");
    });
  });

  describe("server error detection", () => {
    it("detects internal server error", () => {
      const result = classifyStreamError("500 Internal Server Error");
      expect(result.kind).toBe("server");
      expect(result.userMessage).toContain("temporarily unavailable");
    });

    it("detects service unavailable", () => {
      const result = classifyStreamError("503 Service Unavailable");
      expect(result.kind).toBe("server");
    });

    it("detects overloaded", () => {
      const result = classifyStreamError("The server is overloaded right now");
      expect(result.kind).toBe("server");
    });
  });

  describe("network error detection", () => {
    it("detects connection refused", () => {
      const result = classifyStreamError("ECONNREFUSED 127.0.0.1:443");
      expect(result.kind).toBe("network");
      expect(result.userMessage).toContain("internet connection");
    });

    it("detects fetch failed", () => {
      const result = classifyStreamError("fetch failed");
      expect(result.kind).toBe("network");
    });
  });

  describe("fallback / unknown", () => {
    it("returns unknown for unrecognized errors", () => {
      const result = classifyStreamError("Something weird happened");
      expect(result.kind).toBe("unknown");
      expect(result.userMessage).toBe("Something weird happened");
    });

    it("truncates long messages", () => {
      const long = "A".repeat(300);
      const result = classifyStreamError(long);
      expect(result.kind).toBe("unknown");
      expect(result.userMessage.length).toBeLessThanOrEqual(200);
      expect(result.userMessage).toContain("...");
    });

    it("handles empty message", () => {
      const result = classifyStreamError("");
      expect(result.kind).toBe("unknown");
      expect(result.userMessage).toContain("unexpected error");
    });
  });

  describe("SystemSculptError with metadata", () => {
    it("uses upstreamMessage for classification", () => {
      const error = new SystemSculptError("Stream error", ERROR_CODES.STREAM_ERROR, 500, {
        upstreamMessage: "Rate limit exceeded. Try again in 60 seconds.",
      });
      const result = classifyStreamError(error);
      expect(result.kind).toBe("rate_limit");
      expect(result.retryAfterSeconds).toBe(60);
    });
  });

  describe("structured error code short-circuit", () => {
    it("uses RATE_LIMIT_ERROR code directly", () => {
      const error = new SystemSculptError("something", ERROR_CODES.RATE_LIMIT_ERROR, 429);
      const result = classifyStreamError(error);
      expect(result.kind).toBe("rate_limit");
    });

    it("uses NETWORK_ERROR code directly", () => {
      const error = new SystemSculptError("something", ERROR_CODES.NETWORK_ERROR, 0);
      const result = classifyStreamError(error);
      expect(result.kind).toBe("network");
    });

    it("uses SERVICE_UNAVAILABLE code directly", () => {
      const error = new SystemSculptError("something", ERROR_CODES.SERVICE_UNAVAILABLE, 503);
      const result = classifyStreamError(error);
      expect(result.kind).toBe("server");
    });

    it("uses MODEL_UNAVAILABLE code directly", () => {
      const error = new SystemSculptError("something", ERROR_CODES.MODEL_UNAVAILABLE, 404);
      const result = classifyStreamError(error);
      expect(result.kind).toBe("model_not_found");
    });
  });
});
