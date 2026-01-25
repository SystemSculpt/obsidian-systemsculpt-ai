import type { HttpResponseShim } from "../httpClient";

describe("httpClient", () => {
  let requestUrlMock: jest.Mock;
  let httpRequest: typeof import("../httpClient").httpRequest;
  let isHostTemporarilyDisabled: typeof import("../httpClient").isHostTemporarilyDisabled;

  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-09-19T00:00:00Z"));

    const obsidian = await import("obsidian");
    requestUrlMock = obsidian.requestUrl as jest.Mock;
    requestUrlMock.mockReset();
    requestUrlMock.mockImplementation(async () => {
      throw new Error("requestUrl not mocked");
    });

    const clientModule = await import("../httpClient");
    httpRequest = clientModule.httpRequest;
    isHostTemporarilyDisabled = clientModule.isHostTemporarilyDisabled;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("successful requests", () => {
    it("makes GET request and returns response", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ data: "test" }),
        headers: { "content-type": "application/json" },
      });

      const response = await httpRequest({ url });

      expect(response.status).toBe(200);
      expect(response.json).toEqual({ data: "test" });
    });

    it("makes POST request with body", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 201,
        text: JSON.stringify({ id: 1 }),
        headers: {},
      });

      const response = await httpRequest({
        url,
        method: "POST",
        body: JSON.stringify({ name: "test" }),
      });

      expect(response.status).toBe(201);
      expect(requestUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "test" }),
        })
      );
    });

    it("passes custom headers", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      await httpRequest({
        url,
        headers: { Authorization: "Bearer token123" },
      });

      expect(requestUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer token123",
          }),
        })
      );
    });

    it("adds User-Agent header if not provided", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      await httpRequest({ url });

      expect(requestUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": "SystemSculpt-Obsidian",
          }),
        })
      );
    });

    it("adds Content-Type for POST with body", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      await httpRequest({
        url,
        method: "POST",
        body: "{}",
      });

      expect(requestUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("does not add Content-Type for GET requests", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      await httpRequest({
        url,
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      expect(requestUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.not.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("parses JSON response", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ nested: { value: 123 } }),
        headers: {},
      });

      const response = await httpRequest({ url });

      expect(response.json).toEqual({ nested: { value: 123 } });
    });

    it("handles non-JSON response text", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "Plain text response",
        headers: {},
      });

      const response = await httpRequest({ url });

      expect(response.text).toBe("Plain text response");
      expect(response.json).toBeUndefined();
    });

    it("resets circuit breaker on success", async () => {
      const url = "https://api.unique-host-reset.com/data";

      // First cause a failure
      requestUrlMock.mockResolvedValueOnce({ status: 502, text: "<html>Bad Gateway</html>" });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });

      // Now succeed
      requestUrlMock.mockResolvedValueOnce({
        status: 200,
        text: "{}",
        headers: {},
      });
      await httpRequest({ url });

      // Should be enabled
      expect(isHostTemporarilyDisabled(url).disabled).toBe(false);
    });
  });

  describe("error handling", () => {
    it("throws on 400 error", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 400,
        text: JSON.stringify({ error: "Bad Request" }),
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 400 });
    });

    it("throws on 401 error", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 401,
        text: "Unauthorized",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 401 });
    });

    it("throws on 403 error", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 403,
        text: "Forbidden",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 403 });
    });

    it("throws on 404 error", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 404,
        text: "Not Found",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 404 });
    });

    it("throws on 500 error", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 500,
        text: "Internal Server Error",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 500 });
    });

    it("handles network errors", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));

      await expect(httpRequest({ url })).rejects.toThrow("net::ERR_CONNECTION_REFUSED");
    });

    it("does not treat 403 HTML as circuit breaker trigger", async () => {
      const url = "https://api.unique-403.com/data";
      requestUrlMock.mockResolvedValue({
        status: 403,
        text: "<html>Forbidden</html>",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 403 });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 403 });

      // Should NOT be disabled (403 HTML is not a network issue)
      expect(isHostTemporarilyDisabled(url).disabled).toBe(false);
    });
  });

  describe("gateway resilience / circuit breaker", () => {
    it("opens a circuit breaker after consecutive 502 responses", async () => {
      const url = "https://api.systemsculpt.com/api/v1/embeddings";

      requestUrlMock.mockResolvedValue({ status: 502, text: "<html>Bad Gateway</html>" });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });
      expect(isHostTemporarilyDisabled(url)).toEqual({ disabled: false, retryInMs: 0 });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });

      const state = isHostTemporarilyDisabled(url);
      expect(state.disabled).toBe(true);
      expect(state.retryInMs).toBe(120000);

      await expect(httpRequest({ url })).rejects.toThrow(/circuit open/i);
      expect(requestUrlMock).toHaveBeenCalledTimes(2);
    });

    it("allows requests again after the backoff window elapses", async () => {
      const url = "https://api.systemsculpt.com/api/v1/embeddings";

      requestUrlMock
        .mockResolvedValueOnce({ status: 502, text: "<html>Bad Gateway</html>" })
        .mockResolvedValueOnce({ status: 502, text: "<html>Bad Gateway</html>" })
        .mockResolvedValueOnce({
          status: 200,
          text: JSON.stringify({ ok: true }),
          headers: { "content-type": "application/json" },
        } as HttpResponseShim);

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });

      jest.advanceTimersByTime(2 * 60 * 1000 + 1);

      const response = await httpRequest({ url });
      expect(response.status).toBe(200);
      expect(response.json).toEqual({ ok: true });
      expect(isHostTemporarilyDisabled(url).disabled).toBe(false);
      expect(requestUrlMock).toHaveBeenCalledTimes(3);
    });

    it("handles 503 as gateway error", async () => {
      const url = "https://api.unique-503.com/data";
      requestUrlMock.mockResolvedValue({
        status: 503,
        text: "<html>Service Unavailable</html>",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 503 });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 503 });

      expect(isHostTemporarilyDisabled(url).disabled).toBe(true);
    });

    it("handles 504 as gateway error", async () => {
      const url = "https://api.unique-504.com/data";
      requestUrlMock.mockResolvedValue({
        status: 504,
        text: "<html>Gateway Timeout</html>",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 504 });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 504 });

      expect(isHostTemporarilyDisabled(url).disabled).toBe(true);
    });

    it("handles ECONNRESET as network error", async () => {
      const url = "https://api.unique-econnreset.com/data";
      requestUrlMock.mockRejectedValue(new Error("ECONNRESET"));

      await expect(httpRequest({ url })).rejects.toThrow("ECONNRESET");
      await expect(httpRequest({ url })).rejects.toThrow("ECONNRESET");

      expect(isHostTemporarilyDisabled(url).disabled).toBe(true);
    });

    it("handles ENOTFOUND as network error", async () => {
      const url = "https://api.unique-enotfound.com/data";
      requestUrlMock.mockRejectedValue(new Error("ENOTFOUND"));

      await expect(httpRequest({ url })).rejects.toThrow("ENOTFOUND");
      await expect(httpRequest({ url })).rejects.toThrow("ENOTFOUND");

      expect(isHostTemporarilyDisabled(url).disabled).toBe(true);
    });
  });

  describe("isHostTemporarilyDisabled", () => {
    it("returns false for unknown host", () => {
      const result = isHostTemporarilyDisabled("https://unknown.example.com");
      expect(result).toEqual({ disabled: false, retryInMs: 0 });
    });

    it("returns false for empty URL", () => {
      const result = isHostTemporarilyDisabled("");
      expect(result).toEqual({ disabled: false, retryInMs: 0 });
    });

    it("returns false for invalid URL", () => {
      const result = isHostTemporarilyDisabled("not-a-url");
      expect(result).toEqual({ disabled: false, retryInMs: 0 });
    });

    it("returns retry time for disabled host", async () => {
      const url = "https://api.disabled-test.com/data";
      requestUrlMock.mockResolvedValue({ status: 502, text: "<html>Bad Gateway</html>" });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });

      const result = isHostTemporarilyDisabled(url);
      expect(result.disabled).toBe(true);
      expect(result.retryInMs).toBeGreaterThan(0);
    });
  });

  describe("timeout handling", () => {
    it("handles zero timeout as no timeout", async () => {
      const url = "https://api.no-timeout.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      const response = await httpRequest({ url, timeoutMs: 0 });

      expect(response.status).toBe(200);
    });

    it("handles negative timeout as no timeout", async () => {
      const url = "https://api.negative-timeout.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      const response = await httpRequest({ url, timeoutMs: -100 });

      expect(response.status).toBe(200);
    });
  });

  describe("header normalization edge cases", () => {
    it("preserves custom User-Agent if provided", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      await httpRequest({
        url,
        headers: { "User-Agent": "CustomAgent/1.0" },
      });

      expect(requestUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": "CustomAgent/1.0",
          }),
        })
      );
    });

    it("preserves custom Content-Type for POST", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        headers: {},
      });

      await httpRequest({
        url,
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "plain text",
      });

      expect(requestUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "text/plain",
          }),
        })
      );
    });
  });

  describe("response parsing edge cases", () => {
    it("handles empty response text", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "",
        headers: {},
      });

      const response = await httpRequest({ url });

      expect(response.text).toBe("");
      expect(response.json).toBeUndefined();
    });

    it("handles undefined response text", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: undefined,
        headers: {},
      });

      const response = await httpRequest({ url });

      expect(response.json).toBeUndefined();
    });

    it("handles malformed JSON response", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{invalid json",
        headers: {},
      });

      const response = await httpRequest({ url });

      expect(response.text).toBe("{invalid json");
      expect(response.json).toBeUndefined();
    });
  });

  describe("circuit breaker edge cases", () => {
    it("handles 500 with HTML as degraded server", async () => {
      const url = "https://api.unique-500-html.com/data";
      requestUrlMock.mockResolvedValue({
        status: 500,
        text: "<html>Error</html>",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 500 });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 500 });

      expect(isHostTemporarilyDisabled(url).disabled).toBe(true);
    });

    it("does not trigger circuit for 500 with JSON", async () => {
      const url = "https://api.unique-500-json.com/data";
      requestUrlMock.mockResolvedValue({
        status: 500,
        text: '{"error":"Internal error"}',
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 500 });
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 500 });

      // JSON 500 is not considered server degraded
      expect(isHostTemporarilyDisabled(url).disabled).toBe(false);
    });

    it("handles ECONN errors", async () => {
      const url = "https://api.unique-econn.com/data";
      requestUrlMock.mockRejectedValue(new Error("ECONN"));

      await expect(httpRequest({ url })).rejects.toThrow("ECONN");
      await expect(httpRequest({ url })).rejects.toThrow("ECONN");

      expect(isHostTemporarilyDisabled(url).disabled).toBe(true);
    });

    it("handles REFUSED errors", async () => {
      const url = "https://api.unique-refused.com/data";
      requestUrlMock.mockRejectedValue(new Error("REFUSED"));

      await expect(httpRequest({ url })).rejects.toThrow("REFUSED");
      await expect(httpRequest({ url })).rejects.toThrow("REFUSED");

      expect(isHostTemporarilyDisabled(url).disabled).toBe(true);
    });

    it("exponentially increases backoff", async () => {
      const url = "https://api.exponential-backoff.com/data";
      requestUrlMock.mockResolvedValue({ status: 502, text: "<html>Bad Gateway</html>" });

      // First failure - no backoff
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });
      expect(isHostTemporarilyDisabled(url).disabled).toBe(false);

      // Second failure - 2 minute backoff
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });
      const state1 = isHostTemporarilyDisabled(url);
      expect(state1.disabled).toBe(true);
      expect(state1.retryInMs).toBe(2 * 60 * 1000); // 2 minutes

      // Advance past backoff
      jest.advanceTimersByTime(2 * 60 * 1000 + 1);

      // Third failure - 4 minute backoff
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });
      const state2 = isHostTemporarilyDisabled(url);
      expect(state2.disabled).toBe(true);
      expect(state2.retryInMs).toBe(4 * 60 * 1000); // 4 minutes
    });

    it("caps backoff at 60 minutes", async () => {
      const url = "https://api.max-backoff.com/data";
      requestUrlMock.mockResolvedValue({ status: 502, text: "<html>Bad Gateway</html>" });

      // Cause many failures to hit max backoff
      for (let i = 0; i < 10; i++) {
        try {
          await httpRequest({ url });
        } catch {}
        // Advance past any backoff
        jest.advanceTimersByTime(60 * 60 * 1000 + 1);
      }

      // One more to ensure we're at max
      await expect(httpRequest({ url })).rejects.toMatchObject({ status: 502 });

      const state = isHostTemporarilyDisabled(url);
      // Max is 60 minutes
      expect(state.retryInMs).toBeLessThanOrEqual(60 * 60 * 1000);
    });
  });

  describe("error response formatting", () => {
    it("extracts error message from parsed JSON", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 400,
        text: JSON.stringify({ error: { message: "Detailed error" } }),
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({
        status: 400,
        json: { error: { message: "Detailed error" } },
      });
    });

    it("handles status 0 as 500", async () => {
      const url = "https://api.example.com/data";
      requestUrlMock.mockResolvedValue({
        status: 0,
        text: "",
        headers: {},
      });

      await expect(httpRequest({ url })).rejects.toMatchObject({
        status: 500,
      });
    });
  });
});
