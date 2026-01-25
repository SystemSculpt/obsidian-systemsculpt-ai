/**
 * @jest-environment node
 */
import { StreamingService } from "../StreamingService";
import { SystemSculptError } from "../../utils/errors";

// Mock dependencies
jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../streaming/StreamPipeline", () => ({
  StreamPipeline: jest.fn().mockImplementation(() => ({
    push: jest.fn().mockReturnValue({ events: [], done: false }),
    flush: jest.fn().mockReturnValue([]),
  })),
}));

describe("StreamingService", () => {
  let service: StreamingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StreamingService();
  });

  describe("generateRequestId", () => {
    it("generates unique request IDs", () => {
      const id1 = service.generateRequestId();
      const id2 = service.generateRequestId();

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it("generates UUID format when crypto.randomUUID is available", () => {
      const id = service.generateRequestId();

      // Should be UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("falls back to timestamp-random format when crypto is unavailable", () => {
      const originalCrypto = global.crypto;
      // @ts-expect-error - testing fallback
      delete global.crypto;

      const id = service.generateRequestId();

      expect(id).toMatch(/^\d+-[a-z0-9]+$/);

      global.crypto = originalCrypto;
    });

    it("handles crypto.randomUUID throwing", () => {
      const originalCrypto = global.crypto;
      global.crypto = {
        ...originalCrypto,
        randomUUID: () => {
          throw new Error("Not supported");
        },
      } as Crypto;

      const id = service.generateRequestId();

      expect(id).toMatch(/^\d+-[a-z0-9]+$/);

      global.crypto = originalCrypto;
    });
  });

  describe("streamResponse", () => {
    it("throws error when response body is missing", async () => {
      // Create a mock response without body
      const mockResponse = {
        body: null,
        status: 200,
      } as unknown as Response;

      const gen = service.streamResponse(mockResponse, { model: "test-model" });

      await expect(gen.next()).rejects.toThrow(SystemSculptError);
    });

    it("yields events from pipeline", async () => {
      const { StreamPipeline } = require("../../streaming/StreamPipeline");
      StreamPipeline.mockImplementation(() => ({
        push: jest.fn().mockReturnValue({
          events: [{ type: "content", text: "Hello" }],
          done: false,
        }),
        flush: jest.fn().mockReturnValue([]),
      }));

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
          controller.close();
        },
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, { model: "test-model" });
      const result = await gen.next();

      expect(result.value).toEqual({ type: "content", text: "Hello" });
    });

    it("handles done signal from pipeline", async () => {
      const { StreamPipeline } = require("../../streaming/StreamPipeline");
      StreamPipeline.mockImplementation(() => ({
        push: jest.fn().mockReturnValue({
          events: [],
          done: true,
        }),
        flush: jest.fn().mockReturnValue([]),
      }));

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, { model: "test-model" });
      const result = await gen.next();

      expect(result.done).toBe(true);
    });

    it("yields trailing events on flush", async () => {
      const { StreamPipeline } = require("../../streaming/StreamPipeline");
      StreamPipeline.mockImplementation(() => ({
        push: jest.fn().mockReturnValue({ events: [], done: false }),
        flush: jest.fn().mockReturnValue([{ type: "content", text: "Trailing" }]),
      }));

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: test\n"));
          controller.close();
        },
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, { model: "test-model" });
      const events: any[] = [];
      for await (const event of gen) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "content", text: "Trailing" });
    });

    it("handles abort signal that is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: test\n"));
          controller.close();
        },
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, {
        model: "test-model",
        signal: controller.signal,
      });

      const result = await gen.next();
      expect(result.done).toBe(true);
    });

    it("handles DOMException AbortError gracefully", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: jest.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
        cancel: jest.fn(),
        releaseLock: jest.fn(),
      };

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("test"));
        },
      });
      Object.defineProperty(stream, "getReader", {
        value: () => mockReader,
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, { model: "test-model" });
      const result = await gen.next();

      // Should return done=true without throwing
      expect(result.done).toBe(true);
    });

    it("re-throws non-abort errors", async () => {
      const mockReader = {
        read: jest.fn().mockRejectedValue(new Error("Network error")),
        cancel: jest.fn(),
        releaseLock: jest.fn(),
      };

      const stream = new ReadableStream({
        start() {},
      });
      Object.defineProperty(stream, "getReader", {
        value: () => mockReader,
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, { model: "test-model" });

      await expect(gen.next()).rejects.toThrow("Network error");
    });

    it("passes options to StreamPipeline", async () => {
      const { StreamPipeline } = require("../../streaming/StreamPipeline");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: test\n"));
          controller.close();
        },
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, {
        model: "gpt-4",
        isCustomProvider: true,
      });
      // Consume generator to trigger pipeline creation
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of gen) {
        // consume
      }

      expect(StreamPipeline).toHaveBeenCalledWith({
        model: "gpt-4",
        isCustomProvider: true,
      });
    });

    it("processes multiple chunks", async () => {
      const { StreamPipeline } = require("../../streaming/StreamPipeline");
      const mockPush = jest.fn().mockReturnValue({ events: [], done: false });
      StreamPipeline.mockImplementation(() => ({
        push: mockPush,
        flush: jest.fn().mockReturnValue([]),
      }));

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: test\n"));
          controller.enqueue(encoder.encode("data: test2\n"));
          controller.close();
        },
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, { model: "test-model" });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of gen) {
        // consume
      }

      // Should be called for each chunk
      expect(mockPush).toHaveBeenCalled();
    });

    it("releases reader lock in finally block", async () => {
      const mockReleaseLock = jest.fn();
      const mockReader = {
        read: jest.fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("test") })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: jest.fn(),
        releaseLock: mockReleaseLock,
      };

      const stream = new ReadableStream({ start() {} });
      Object.defineProperty(stream, "getReader", {
        value: () => mockReader,
      });
      const response = new Response(stream);

      const gen = service.streamResponse(response, { model: "test-model" });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of gen) {
        // consume
      }

      expect(mockReleaseLock).toHaveBeenCalled();
    });
  });
});
