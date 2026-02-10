/**
 * @jest-environment node
 */
import {
  ERROR_CODES,
  SystemSculptError,
  getErrorMessage,
  ErrorCode,
  isAuthFailureMessage,
  isContextOverflowErrorMessage,
} from "../errors";

describe("errors", () => {
  describe("ERROR_CODES", () => {
    it("has authentication error codes", () => {
      expect(ERROR_CODES.INVALID_LICENSE).toBe("INVALID_LICENSE");
      expect(ERROR_CODES.LICENSE_EXPIRED).toBe("LICENSE_EXPIRED");
      expect(ERROR_CODES.LICENSE_DISABLED).toBe("LICENSE_DISABLED");
      expect(ERROR_CODES.PRO_REQUIRED).toBe("PRO_REQUIRED");
    });

    it("has model error codes", () => {
      expect(ERROR_CODES.MODEL_UNAVAILABLE).toBe("MODEL_UNAVAILABLE");
      expect(ERROR_CODES.MODEL_REQUEST_ERROR).toBe("MODEL_REQUEST_ERROR");
    });

    it("has stream error codes", () => {
      expect(ERROR_CODES.STREAM_ERROR).toBe("STREAM_ERROR");
      expect(ERROR_CODES.INVALID_RESPONSE).toBe("INVALID_RESPONSE");
      expect(ERROR_CODES.NO_IMAGE).toBe("NO_IMAGE");
    });

    it("has file processing error codes", () => {
      expect(ERROR_CODES.FILE_NOT_FOUND).toBe("FILE_NOT_FOUND");
      expect(ERROR_CODES.FILE_TOO_LARGE).toBe("FILE_TOO_LARGE");
      expect(ERROR_CODES.UNSUPPORTED_FORMAT).toBe("UNSUPPORTED_FORMAT");
      expect(ERROR_CODES.PROCESSING_ERROR).toBe("PROCESSING_ERROR");
    });

    it("has network error codes", () => {
      expect(ERROR_CODES.NETWORK_ERROR).toBe("NETWORK_ERROR");
      expect(ERROR_CODES.TIMEOUT_ERROR).toBe("TIMEOUT_ERROR");
      expect(ERROR_CODES.SERVICE_UNAVAILABLE).toBe("SERVICE_UNAVAILABLE");
      expect(ERROR_CODES.RATE_LIMIT_ERROR).toBe("RATE_LIMIT_ERROR");
    });

    it("has generic error codes", () => {
      expect(ERROR_CODES.UNKNOWN_ERROR).toBe("UNKNOWN_ERROR");
      expect(ERROR_CODES.QUOTA_EXCEEDED).toBe("QUOTA_EXCEEDED");
    });
  });

  describe("SystemSculptError", () => {
    it("is an instance of Error", () => {
      const error = new SystemSculptError("Test error");

      expect(error).toBeInstanceOf(Error);
    });

    it("sets message correctly", () => {
      const error = new SystemSculptError("Custom error message");

      expect(error.message).toBe("Custom error message");
    });

    it("sets name to SystemSculptError", () => {
      const error = new SystemSculptError("Test");

      expect(error.name).toBe("SystemSculptError");
    });

    it("defaults code to UNKNOWN_ERROR", () => {
      const error = new SystemSculptError("Test");

      expect(error.code).toBe(ERROR_CODES.UNKNOWN_ERROR);
    });

    it("defaults statusCode to 500", () => {
      const error = new SystemSculptError("Test");

      expect(error.statusCode).toBe(500);
    });

    it("accepts custom code", () => {
      const error = new SystemSculptError("Test", ERROR_CODES.INVALID_LICENSE);

      expect(error.code).toBe(ERROR_CODES.INVALID_LICENSE);
    });

    it("accepts custom statusCode", () => {
      const error = new SystemSculptError("Test", ERROR_CODES.INVALID_LICENSE, 401);

      expect(error.statusCode).toBe(401);
    });

    it("accepts metadata", () => {
      const error = new SystemSculptError(
        "Test",
        ERROR_CODES.MODEL_UNAVAILABLE,
        503,
        { provider: "openai", model: "gpt-4" }
      );

      expect(error.metadata).toEqual({ provider: "openai", model: "gpt-4" });
    });

    it("metadata can include shouldResubmit", () => {
      const error = new SystemSculptError(
        "Test",
        ERROR_CODES.STREAM_ERROR,
        500,
        { shouldResubmit: true }
      );

      expect(error.metadata?.shouldResubmit).toBe(true);
    });

    it("metadata can include arbitrary properties", () => {
      const error = new SystemSculptError(
        "Test",
        ERROR_CODES.UNKNOWN_ERROR,
        500,
        { customProp: "value", count: 42 }
      );

      expect(error.metadata?.customProp).toBe("value");
      expect(error.metadata?.count).toBe(42);
    });
  });

  describe("isAuthFailureMessage", () => {
    it("detects common authentication failure messages", () => {
      expect(isAuthFailureMessage("Invalid API key")).toBe(true);
      expect(isAuthFailureMessage("401 Unauthorized")).toBe(true);
      expect(isAuthFailureMessage("Too many authentication failures")).toBe(true);
    });

    it("does not flag rate limit messages", () => {
      expect(isAuthFailureMessage("Rate limit exceeded")).toBe(false);
    });
  });

  describe("isContextOverflowErrorMessage", () => {
    it("detects llama.cpp / LM Studio context length errors", () => {
      expect(
        isContextOverflowErrorMessage(
          "The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input"
        )
      ).toBe(true);
    });

    it("detects OpenAI-style maximum context length errors", () => {
      expect(
        isContextOverflowErrorMessage(
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."
        )
      ).toBe(true);
    });

    it("does not flag unrelated errors", () => {
      expect(isContextOverflowErrorMessage("Rate limit exceeded")).toBe(false);
      expect(isContextOverflowErrorMessage("Invalid API key")).toBe(false);
    });
  });

  describe("getErrorMessage", () => {
    it("returns message for INVALID_LICENSE", () => {
      const message = getErrorMessage(ERROR_CODES.INVALID_LICENSE);

      expect(message).toContain("Invalid license");
    });

    it("returns message for LICENSE_EXPIRED", () => {
      const message = getErrorMessage(ERROR_CODES.LICENSE_EXPIRED);

      expect(message).toContain("expired");
    });

    it("returns message for LICENSE_DISABLED", () => {
      const message = getErrorMessage(ERROR_CODES.LICENSE_DISABLED);

      expect(message).toContain("disabled");
    });

    it("returns message for PRO_REQUIRED", () => {
      const message = getErrorMessage(ERROR_CODES.PRO_REQUIRED);

      expect(message).toContain("Pro");
    });

    it("returns message for MODEL_UNAVAILABLE without model", () => {
      const message = getErrorMessage(ERROR_CODES.MODEL_UNAVAILABLE);

      expect(message).toContain("unavailable");
    });

    it("returns message for MODEL_UNAVAILABLE with model", () => {
      const message = getErrorMessage(ERROR_CODES.MODEL_UNAVAILABLE, "gpt-4");

      expect(message).toContain("gpt-4");
      expect(message).toContain("unavailable");
    });

    it("returns message for MODEL_REQUEST_ERROR without model", () => {
      const message = getErrorMessage(ERROR_CODES.MODEL_REQUEST_ERROR);

      expect(message).toContain("Error processing");
    });

    it("returns message for MODEL_REQUEST_ERROR with model", () => {
      const message = getErrorMessage(ERROR_CODES.MODEL_REQUEST_ERROR, "claude-3");

      expect(message).toContain("claude-3");
    });

    it("returns message for STREAM_ERROR", () => {
      const message = getErrorMessage(ERROR_CODES.STREAM_ERROR);

      expect(message).toContain("streaming");
    });

    it("returns message for INVALID_RESPONSE", () => {
      const message = getErrorMessage(ERROR_CODES.INVALID_RESPONSE);

      expect(message).toContain("invalid");
    });

    it("returns message for NO_IMAGE", () => {
      const message = getErrorMessage(ERROR_CODES.NO_IMAGE);

      expect(message).toContain("image");
    });

    it("returns message for FILE_NOT_FOUND", () => {
      const message = getErrorMessage(ERROR_CODES.FILE_NOT_FOUND);

      expect(message).toContain("not found");
    });

    it("returns message for FILE_TOO_LARGE", () => {
      const message = getErrorMessage(ERROR_CODES.FILE_TOO_LARGE);

      expect(message).toContain("too large");
    });

    it("returns message for UNSUPPORTED_FORMAT", () => {
      const message = getErrorMessage(ERROR_CODES.UNSUPPORTED_FORMAT);

      expect(message).toContain("Unsupported");
    });

    it("returns message for PROCESSING_ERROR", () => {
      const message = getErrorMessage(ERROR_CODES.PROCESSING_ERROR);

      expect(message).toContain("processing");
    });

    it("returns message for NETWORK_ERROR", () => {
      const message = getErrorMessage(ERROR_CODES.NETWORK_ERROR);

      expect(message).toContain("Network");
    });

    it("returns message for TIMEOUT_ERROR", () => {
      const message = getErrorMessage(ERROR_CODES.TIMEOUT_ERROR);

      expect(message).toContain("timed out");
    });

    it("returns message for SERVICE_UNAVAILABLE", () => {
      const message = getErrorMessage(ERROR_CODES.SERVICE_UNAVAILABLE);

      expect(message).toContain("unavailable");
    });

    it("returns message for RATE_LIMIT_ERROR", () => {
      const message = getErrorMessage(ERROR_CODES.RATE_LIMIT_ERROR);

      expect(message).toContain("Rate limit");
    });

    it("returns message for UNKNOWN_ERROR", () => {
      const message = getErrorMessage(ERROR_CODES.UNKNOWN_ERROR);

      expect(message).toContain("unexpected error");
    });

    it("returns message for QUOTA_EXCEEDED", () => {
      const message = getErrorMessage(ERROR_CODES.QUOTA_EXCEEDED);

      expect(message).toContain("quota");
    });

    it("all error codes have messages", () => {
      const codes = Object.values(ERROR_CODES) as ErrorCode[];

      for (const code of codes) {
        const message = getErrorMessage(code);
        expect(message).toBeTruthy();
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }
    });
  });
});
