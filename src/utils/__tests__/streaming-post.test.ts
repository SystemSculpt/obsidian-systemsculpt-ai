/**
 * @jest-environment node
 */
import { postJsonStreaming } from "../streaming";

// Store original fetch
const originalFetch = global.fetch;

// Mock obsidian
jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
  Platform: {
    isMobile: false,
    isDesktop: true,
  },
}));

// Mock errorLogger
jest.mock("../errorLogger", () => ({
  errorLogger: {
    debug: jest.fn(),
  },
}));

// Mock MOBILE_STREAM_CONFIG
jest.mock("../../constants/webSearch", () => ({
  MOBILE_STREAM_CONFIG: {
    CHUNK_SIZE: 100,
    CHUNK_DELAY_MS: 0,
  },
}));

describe("postJsonStreaming", () => {
  let requestUrlMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const obsidian = require("obsidian");
    requestUrlMock = obsidian.requestUrl;
    requestUrlMock.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("desktop mode with fetch", () => {
    it("uses fetch for non-mobile, non-anthropic URLs", async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const response = await postJsonStreaming(
        "https://api.openrouter.ai/v1/chat/completions",
        { Authorization: "Bearer test" },
        { model: "gpt-4" },
        false
      );

      expect(global.fetch).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("strips OpenRouter CORS headers", async () => {
      const mockResponse = new Response("{}", { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      await postJsonStreaming(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          Authorization: "Bearer test",
          "HTTP-Referer": "https://example.com",
          "X-Title": "Test App",
          "Cache-Control": "no-cache",
        },
        { model: "gpt-4" },
        false
      );

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers.Authorization).toBe("Bearer test");
      expect(headers["HTTP-Referer"]).toBeUndefined();
      expect(headers["X-Title"]).toBeUndefined();
    });

    it("falls back to requestUrl on fetch error", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("CORS error"));
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ ok: true }),
        json: { ok: true },
      });

      const response = await postJsonStreaming(
        "https://api.openrouter.ai/v1/chat/completions",
        { Authorization: "Bearer test" },
        { model: "gpt-4" },
        false
      );

      expect(global.fetch).toHaveBeenCalled();
      expect(requestUrlMock).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });
  });

  describe("mobile mode", () => {
    it("uses requestUrl for mobile", async () => {
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: "Hello" } }] }),
        json: { choices: [{ message: { content: "Hello" } }] },
      });

      const response = await postJsonStreaming(
        "https://api.example.com/v1/chat",
        { Authorization: "Bearer test" },
        { model: "gpt-4" },
        true // isMobile = true
      );

      expect(requestUrlMock).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });
  });

  describe("error handling", () => {
    it("returns error response for API errors", async () => {
      requestUrlMock.mockResolvedValue({
        status: 401,
        text: JSON.stringify({ error: { message: "Unauthorized" } }),
        json: { error: { message: "Unauthorized" } },
      });

      const response = await postJsonStreaming(
        "https://api.example.com/v1/chat",
        { Authorization: "invalid" },
        { model: "gpt-4" },
        true
      );

      expect(response.status).toBe(401);
    });

    it("handles API 500 error", async () => {
      requestUrlMock.mockResolvedValue({
        status: 500,
        text: "Internal Server Error",
        json: null,
      });

      const response = await postJsonStreaming(
        "https://api.example.com/v1/chat",
        {},
        {},
        true
      );

      expect(response.status).toBe(500);
    });
  });

  describe("SSE format handling", () => {
    it("passes through SSE text response", async () => {
      const sseContent = "event: message\ndata: {\"text\":\"Hello\"}\n\ndata: [DONE]\n\n";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: sseContent,
      });

      const response = await postJsonStreaming(
        "https://api.example.com/v1/chat",
        {},
        {},
        true
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("handles SSE with only data lines (no event)", async () => {
      const sseContent = "data: {\"text\":\"Hello\"}\n\ndata: [DONE]\n\n";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: sseContent,
      });

      const response = await postJsonStreaming(
        "https://api.example.com/v1/chat",
        {},
        {},
        true
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("adds [DONE] marker if missing", async () => {
      const sseContent = "data: {\"text\":\"Hello\"}\n\n";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: sseContent,
      });

      const response = await postJsonStreaming(
        "https://api.example.com/v1/chat",
        {},
        {},
        true
      );

      const text = await response.text();
      expect(text).toContain("[DONE]");
    });
  });

  describe("JSON format handling", () => {
    it("returns JSON response for non-SSE", async () => {
      const jsonResponse = { choices: [{ message: { content: "Hello" } }] };
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: JSON.stringify(jsonResponse),
        json: jsonResponse,
      });

      const response = await postJsonStreaming(
        "https://api.example.com/v1/chat",
        {},
        {},
        true
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });

  describe("anthropic handling", () => {
    it("uses requestUrl for anthropic URLs even on desktop", async () => {
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ content: [{ text: "Hello" }] }),
        json: { content: [{ text: "Hello" }] },
      });

      await postJsonStreaming(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": "test" },
        { model: "claude-3" },
        false
      );

      expect(requestUrlMock).toHaveBeenCalled();
    });

    it("sets anthropic format header for SSE", async () => {
      const sseContent = "event: message_start\ndata: {}\n\n";
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: sseContent,
      });

      const response = await postJsonStreaming(
        "https://api.anthropic.com/v1/messages",
        {},
        {},
        true
      );

      expect(response.headers.get("X-Provider-Format")).toBe("anthropic-sse");
    });

    it("sets anthropic format header for JSON", async () => {
      requestUrlMock.mockResolvedValue({
        status: 200,
        text: "{}",
        json: {},
      });

      const response = await postJsonStreaming(
        "https://api.anthropic.com/v1/messages",
        {},
        {},
        true
      );

      expect(response.headers.get("X-Provider-Format")).toBe("anthropic-json");
    });
  });

  describe("abort signal", () => {
    it("passes abort signal to fetch", async () => {
      const mockResponse = new Response("{}", { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);
      const controller = new AbortController();

      await postJsonStreaming(
        "https://api.openrouter.ai/v1/chat/completions",
        {},
        {},
        false,
        controller.signal
      );

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[1].signal).toBe(controller.signal);
    });
  });
});
