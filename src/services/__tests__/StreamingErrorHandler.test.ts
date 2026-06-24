import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { SystemSculptError, ERROR_CODES } from "../../utils/errors";

describe("StreamingErrorHandler", () => {
  const createMockResponse = (
    status: number,
    body: any,
    headers?: Record<string, string>
  ): Response => ({
    status,
    text: jest.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
    ok: status >= 200 && status < 300,
    statusText: "OK",
    headers: new Headers(headers),
    redirected: false,
    type: "basic",
    url: "",
    clone: jest.fn(),
    body: null,
    bodyUsed: false,
    arrayBuffer: jest.fn(),
    blob: jest.fn(),
    formData: jest.fn(),
    json: jest.fn(),
    bytes: jest.fn(),
  } as unknown as Response);

  it("preserves upstream message for custom provider 404 responses", async () => {
    const upstreamMessage = "No allowed providers are available for the selected model.";
    const response = createMockResponse(404, {
      error: {
        message: upstreamMessage,
        code: 404,
      },
    });

    await expect(async () => {
      try {
        await StreamingErrorHandler.handleStreamError(response, true);
      } catch (err) {
        expect(err).toBeInstanceOf(SystemSculptError);
        const systemError = err as SystemSculptError;
        expect(systemError.message).toBe(upstreamMessage);
        expect(systemError.metadata).toEqual(
          expect.objectContaining({
            upstreamMessage,
            model: "unknown",
            statusCode: 404,
          })
        );
        throw err;
      }
    }).rejects.toThrow(upstreamMessage);
  });

  describe("SystemSculpt API license failures (#249)", () => {
    it("classifies a 401 'Invalid or expired license key' string as LICENSE_EXPIRED (not a generic stream error)", async () => {
      const response = createMockResponse(401, { error: "Invalid or expired license key" });
      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({
        code: ERROR_CODES.LICENSE_EXPIRED,
        message: "Your license has expired. Please renew your subscription.",
      });
    });

    it("classifies an invalid (non-expired) key as INVALID_LICENSE", async () => {
      const response = createMockResponse(401, { error: "Invalid license key", code: "license_invalid" });
      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_LICENSE });
    });

    it("honors a discriminated server code + renew_url in metadata", async () => {
      const response = createMockResponse(401, {
        error: "Invalid or expired license key",
        code: "license_expired",
        renew_url: "https://systemsculpt.com/renew",
      });
      try {
        await StreamingErrorHandler.handleStreamError(response, false);
        throw new Error("expected handleStreamError to throw");
      } catch (err) {
        const systemError = err as SystemSculptError;
        expect(systemError.code).toBe(ERROR_CODES.LICENSE_EXPIRED);
        expect(systemError.metadata).toEqual(
          expect.objectContaining({
            licenseFailure: true,
            renewUrl: "https://systemsculpt.com/renew",
            statusCode: 401,
          })
        );
      }
    });

    it("classifies the object-shaped error form ({ error: { code } }) as a license failure", async () => {
      const response = createMockResponse(401, {
        error: { code: "invalid_license", message: "Invalid license key" },
      });
      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_LICENSE });
    });

    it("classifies an object-shaped missing_license code as a license failure", async () => {
      const response = createMockResponse(401, {
        error: { code: "missing_license", message: "Missing license key" },
      });
      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_LICENSE });
    });

    it("does NOT misclassify a generic 500 stream error as a license problem", async () => {
      const response = createMockResponse(500, { error: "INTERNAL_ERROR", message: "boom" });
      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({ code: ERROR_CODES.STREAM_ERROR });
    });
  });

  describe("non-JSON response handling", () => {
    it("handles plain text error response", async () => {
      const response = createMockResponse(500, "Internal Server Error");

      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({
        message: "Internal Server Error",
      });
    });

    it("handles empty text response", async () => {
      const response = createMockResponse(500, "   ");

      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({
        message: "Unknown error",
      });
    });
  });

  describe("custom provider errors", () => {
    it("handles 429 rate limit", async () => {
      const response = createMockResponse(429, {
        error: { message: "Rate limit exceeded" },
      });

      await expect(
        StreamingErrorHandler.handleStreamError(response, true)
      ).rejects.toMatchObject({
        code: ERROR_CODES.QUOTA_EXCEEDED,
        message: "Rate limit exceeded",
      });
    });

    // BUG-17: a BYOK/custom-provider 429 is transient, not terminal. The classifier
    // (quotaError.ts) keys "offer a retry" off isRateLimited/shouldRetry, so the
    // custom branch must set them — otherwise BYOK 429s never offer a retry.
    it("classifies a custom-provider 429 as a transient rate limit", async () => {
      const response = createMockResponse(429, {
        error: { message: "Rate limit exceeded" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true);
        throw new Error("expected handleStreamError to throw");
      } catch (err) {
        const sysErr = err as SystemSculptError;
        expect(sysErr.code).toBe(ERROR_CODES.QUOTA_EXCEEDED);
        expect(sysErr.metadata?.isRateLimited).toBe(true);
        expect(sysErr.metadata?.shouldRetry).toBe(true);
      }
    });

    // BUG-16/BUG-17: the custom 429 must honor the server Retry-After header
    // instead of an unconditional hint.
    it("honors the Retry-After header on a custom-provider 429", async () => {
      const response = createMockResponse(
        429,
        { error: { message: "Rate limit exceeded" } },
        { "retry-after": "42" }
      );

      try {
        await StreamingErrorHandler.handleStreamError(response, true);
        throw new Error("expected handleStreamError to throw");
      } catch (err) {
        const sysErr = err as SystemSculptError;
        expect(sysErr.metadata?.retryAfterSeconds).toBe(42);
      }
    });

    it("uses top-level message when error wrapper is missing", async () => {
      const response = createMockResponse(400, {
        message: "Tool calling is not supported for this model",
      });

      await expect(
        StreamingErrorHandler.handleStreamError(response, true)
      ).rejects.toMatchObject({
        message: "Tool calling is not supported for this model",
      });
    });

    it("treats 429 authentication failures as auth errors", async () => {
      const response = createMockResponse(429, {
        error: { message: "Too many authentication failures" },
      });

      await expect(
        StreamingErrorHandler.handleStreamError(response, true)
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_LICENSE,
        message: "Too many authentication failures",
      });
    });

    it("handles 401 authentication error", async () => {
      const response = createMockResponse(401, {
        error: { message: "Invalid API key" },
      });

      await expect(
        StreamingErrorHandler.handleStreamError(response, true)
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_LICENSE,
        message: "Invalid API key",
      });
    });

    it("extracts model from error message pattern", async () => {
      const response = createMockResponse(404, {
        error: { message: "The model `gpt-5-turbo` does not exist" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true);
      } catch (err) {
        expect((err as SystemSculptError).metadata.model).toBe("gpt-5-turbo");
      }
    });

    it("extracts model from error.model field", async () => {
      const response = createMockResponse(404, {
        error: { message: "Resource is unavailable", model: "claude-3" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true);
      } catch (err) {
        expect((err as SystemSculptError).metadata.model).toBe("claude-3");
      }
    });

    it("extracts model from error.data.model field", async () => {
      const response = createMockResponse(404, {
        error: { message: "Resource is unavailable", data: { model: "gemini-pro" } },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true);
      } catch (err) {
        expect((err as SystemSculptError).metadata.model).toBe("gemini-pro");
      }
    });

    it("detects tools not supported errors", async () => {
      const toolErrorPatterns = [
        "does not support tools",
        "tools not supported",
        "tool calling not supported",
        "tool calling is not supported",
        "tool_calls not supported",
        "function calling not supported",
        "function_calling not supported",
        "function_call not supported",
        "additional properties are not allowed: 'tools'",
        "unknown field: tools",
        "input_schema does not support oneof",
        "input_schema does not support anyof",
        "input_schema does not support allof",
      ];

      for (const pattern of toolErrorPatterns) {
        const response = createMockResponse(400, {
          error: { message: pattern },
        });

        try {
          await StreamingErrorHandler.handleStreamError(response, true);
        } catch (err) {
          const metadata = (err as SystemSculptError).metadata;
          expect(metadata.shouldResubmitWithoutTools).toBe(true);
          expect(metadata.toolSupport).toBe(false);
        }
      }
    });

    it("detects image not supported errors for custom providers", async () => {
      const imageErrorPatterns = [
        "does not support image",
        "image input not supported",
        "vision not supported",
        "unknown field: image_url",
        "additional properties are not allowed: 'image_url'",
        "unsupported type: image_url",
        "Invalid type for 'messages[0].content': expected string",
        "messages[0].content must be a string",
      ];

      for (const pattern of imageErrorPatterns) {
        const response = createMockResponse(400, {
          error: { message: pattern },
        });

        try {
          await StreamingErrorHandler.handleStreamError(response, true);
        } catch (err) {
          const metadata = (err as SystemSculptError).metadata;
          expect(metadata.shouldResubmitWithoutImages).toBe(true);
          expect(metadata.imageSupport).toBe(false);
        }
      }
    });

    it("detects invalid chat settings", async () => {
      const response = createMockResponse(400, {
        error: { message: "invalid chat setting detected" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true);
      } catch (err) {
        expect((err as SystemSculptError).metadata.invalidChatSettings).toBe(true);
      }
    });

    it("sets shouldResubmit for unavailable/not found messages", async () => {
      const patterns = ["Model is unavailable", "Resource not found"];

      for (const message of patterns) {
        const response = createMockResponse(500, {
          error: { message },
        });

        try {
          await StreamingErrorHandler.handleStreamError(response, true);
        } catch (err) {
          expect((err as SystemSculptError).metadata.shouldResubmit).toBe(true);
        }
      }
    });

    it("uses context model when metadata model is unknown", async () => {
      const response = createMockResponse(500, {
        error: { message: "Some error" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true, {
          model: "context-model",
        });
      } catch (err) {
        expect((err as SystemSculptError).metadata.model).toBe("context-model");
      }
    });

    it("includes requestId when present", async () => {
      const response = createMockResponse(500, {
        error: { message: "Error" },
        request_id: "req-123",
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true);
      } catch (err) {
        expect((err as SystemSculptError).metadata.requestId).toBe("req-123");
      }
    });

    it("includes endpoint from context", async () => {
      const response = createMockResponse(500, {
        error: { message: "Error" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, true, {
          endpoint: "https://api.example.com",
        });
      } catch (err) {
        expect((err as SystemSculptError).metadata.endpoint).toBe("https://api.example.com");
      }
    });
  });

  describe("SystemSculpt API errors (non-custom)", () => {
    it("handles string error format", async () => {
      const response = createMockResponse(500, {
        error: "INTERNAL_ERROR",
        message: "Something went wrong",
      });

      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({
        message: "Something went wrong",
      });
    });

    it("handles 429 rate limiting with rate-limited message", async () => {
      const response = createMockResponse(429, {
        error: { message: "Request rate-limited upstream by provider" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, false);
      } catch (err) {
        const sysErr = err as SystemSculptError;
        expect(sysErr.code).toBe(ERROR_CODES.QUOTA_EXCEEDED);
        expect(sysErr.metadata.isRateLimited).toBe(true);
        expect(sysErr.metadata.shouldRetry).toBe(true);
      }
    });

    it("handles rate-limited upstream message specially", async () => {
      const response = createMockResponse(429, {
        error: { message: "rate-limited upstream" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, false);
      } catch (err) {
        expect((err as SystemSculptError).message).toContain("OpenRouter is automatically trying");
      }
    });

    // BUG-16: the managed 429 path used to hard-code a 5s hint, so the UI always
    // said "wait ~5s" even when the server's Retry-After header said 60. The hint
    // must reflect the real header value.
    it("honors the Retry-After header on a managed 429 (BUG-16)", async () => {
      const response = createMockResponse(
        429,
        { error: { message: "Request rate-limited upstream by provider" } },
        { "retry-after": "60" }
      );

      try {
        await StreamingErrorHandler.handleStreamError(response, false);
        throw new Error("expected handleStreamError to throw");
      } catch (err) {
        const sysErr = err as SystemSculptError;
        expect(sysErr.code).toBe(ERROR_CODES.QUOTA_EXCEEDED);
        expect(sysErr.metadata?.isRateLimited).toBe(true);
        expect(sysErr.metadata?.shouldRetry).toBe(true);
        // Must reflect the server header, not the legacy hard-coded 5.
        expect(sysErr.metadata?.retryAfterSeconds).toBe(60);
      }
    });

    // BUG-16: when the server omits Retry-After, fall back to the 5s hint.
    it("falls back to a 5s hint when a managed 429 has no Retry-After header", async () => {
      const response = createMockResponse(429, {
        error: { message: "Request rate-limited upstream by provider" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, false);
        throw new Error("expected handleStreamError to throw");
      } catch (err) {
        const sysErr = err as SystemSculptError;
        expect(sysErr.metadata?.retryAfterSeconds).toBe(5);
      }
    });

    it("detects model unavailable for 404", async () => {
      const response = createMockResponse(404, {
        error: { message: "Model not found" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, false);
      } catch (err) {
        expect((err as SystemSculptError).metadata.shouldResubmit).toBe(true);
      }
    });

    it("detects MODEL_UNAVAILABLE error code", async () => {
      const response = createMockResponse(400, {
        error: { code: ERROR_CODES.MODEL_UNAVAILABLE, message: "Model unavailable" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, false);
      } catch (err) {
        expect((err as SystemSculptError).metadata.shouldResubmit).toBe(true);
      }
    });

    it("detects tools not supported in non-custom path", async () => {
      const response = createMockResponse(400, {
        error: { message: "This model does not support tools" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, false);
      } catch (err) {
        const metadata = (err as SystemSculptError).metadata;
        expect(metadata.shouldResubmitWithoutTools).toBe(true);
        expect(metadata.toolSupport).toBe(false);
      }
    });

    it("detects image not supported errors", async () => {
      const imageErrorPatterns = [
        "does not support image",
        "image input not supported",
        "vision not supported",
        "unknown field: image_url",
        "additional properties are not allowed: 'image_url'",
        "unsupported type: image_url",
        "Invalid type for 'messages[0].content': expected string",
        "messages[0].content must be a string",
      ];

      for (const pattern of imageErrorPatterns) {
        const response = createMockResponse(400, {
          error: { message: pattern },
        });

        try {
          await StreamingErrorHandler.handleStreamError(response, false);
        } catch (err) {
          const metadata = (err as SystemSculptError).metadata;
          expect(metadata.shouldResubmitWithoutImages).toBe(true);
          expect(metadata.imageSupport).toBe(false);
        }
      }
    });

    it("uses context model when response model missing", async () => {
      const response = createMockResponse(500, {
        error: { message: "Error" },
      });

      try {
        await StreamingErrorHandler.handleStreamError(response, false, {
          model: "context-model-2",
        });
      } catch (err) {
        expect((err as SystemSculptError).metadata.model).toBe("context-model-2");
      }
    });
  });

  describe("error re-throwing", () => {
    it("re-throws SystemSculptError as-is", async () => {
      const response = createMockResponse(500, {
        error: { message: "Test error", code: ERROR_CODES.STREAM_ERROR },
      });

      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toBeInstanceOf(SystemSculptError);
    });

    it("wraps non-SystemSculptError in new SystemSculptError", async () => {
      const response: Response = {
        status: 500,
        text: jest.fn().mockRejectedValue(new Error("Network error")),
      } as unknown as Response;

      await expect(
        StreamingErrorHandler.handleStreamError(response, false)
      ).rejects.toMatchObject({
        code: ERROR_CODES.STREAM_ERROR,
        statusCode: 500,
      });
    });
  });
});
