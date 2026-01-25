/**
 * @jest-environment jsdom
 */
import { ReadableStream as NodeReadableStream } from "stream/web";
import { createSSEStreamFromChatCompletionJSON } from "../streaming";

// Polyfill ReadableStream for jsdom environment
if (typeof globalThis.ReadableStream === "undefined") {
  (globalThis as any).ReadableStream = NodeReadableStream;
}

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

describe("streaming utilities", () => {
  describe("createSSEStreamFromChatCompletionJSON", () => {
    it("creates a ReadableStream from JSON response", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              content: "Hello, world!",
            },
            finish_reason: "stop",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 5,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream with reasoning in response", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              content: "Hello",
              reasoning: "Thinking step by step",
            },
            finish_reason: "stop",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream with tool calls in response", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"location":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream with annotations in response", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              content: "Check this link",
              annotations: [
                { type: "url_citation", url: "https://example.com" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream with webSearchEnabled flag", () => {
      const response = {
        text: "Search result",
        webSearchEnabled: true,
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream from plain string response", () => {
      const response = "Plain text response";

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 5,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream from text property in response object", () => {
      const response = {
        text: "Text content",
        reasoning: "Some reasoning",
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("uses default chunk settings when not provided", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              content: "Hello",
            },
            finish_reason: "stop",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response);
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream with empty content", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              content: "",
            },
            finish_reason: "stop",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("creates stream with multiple tool calls", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "fn1" } },
                { id: "call_2", type: "function", function: { name: "fn2" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("handles response with all fields", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              content: "Response content",
              reasoning: "My reasoning",
              annotations: [{ type: "citation", url: "https://test.com" }],
              tool_calls: [{ id: "c1", type: "function", function: { name: "fn" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 50,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("handles null/undefined gracefully in tool calls", () => {
      const response = {
        id: "test-id",
        model: "gpt-4",
        choices: [
          {
            message: {
              tool_calls: [null, { id: "call_1", type: "function", function: { name: "fn1" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      };

      const stream = createSSEStreamFromChatCompletionJSON(response, {
        chunkSize: 100,
        chunkDelayMs: 0,
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });
  });
});
