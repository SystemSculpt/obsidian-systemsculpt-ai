/**
 * @jest-environment jsdom
 */

// Mock obsidian before any imports
jest.mock("obsidian", () => ({
  Plugin: class MockPlugin {},
  Notice: jest.fn(),
  Menu: jest.fn(),
  TFile: class MockTFile {},
  MarkdownView: jest.fn(),
  requestUrl: jest.fn(),
  App: jest.fn(),
  normalizePath: jest.fn((p: string) => p),
}));

// Mock PlatformContext
jest.mock("../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      isMobile: jest.fn(() => false),
      preferredTransport: jest.fn(() => "fetch"),
      supportsStreaming: jest.fn(() => true),
    })),
  },
}));

// Mock SystemSculptService
jest.mock("../SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => ({
      baseUrl: "https://api.systemsculpt.com",
    })),
  },
}));

// Mock AudioResampler
jest.mock("../AudioResampler", () => ({
  AudioResampler: jest.fn().mockImplementation(() => ({
    checkNeedsResampling: jest.fn().mockResolvedValue({ needsResampling: false, currentSampleRate: 16000 }),
    resampleAudio: jest.fn().mockResolvedValue({ buffer: new ArrayBuffer(100) }),
    dispose: jest.fn(),
  })),
}));

// Mock SerialTaskQueue
jest.mock("../../utils/SerialTaskQueue", () => ({
  SerialTaskQueue: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((fn: () => Promise<any>) => ({
      promise: fn(),
      ahead: 0,
    })),
    size: 0,
  })),
}));

// Mock error logging
jest.mock("../../utils/errorHandling", () => ({
  logDebug: jest.fn(),
  logInfo: jest.fn(),
  logWarning: jest.fn(),
  logError: jest.fn(),
  logMobileError: jest.fn(),
}));

import { requestUrl, TFile } from "obsidian";
import { PlatformContext } from "../PlatformContext";
import { TranscriptionService } from "../TranscriptionService";
import { AUDIO_UPLOAD_MAX_BYTES } from "../../constants/uploadLimits";
describe("TranscriptionService", () => {
  let service: TranscriptionService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlugin = {
      app: {
        vault: {
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(1000)),
          adapter: {
            basePath: "/test/vault",
          },
        },
      },
      settings: {
        licenseKey: "test-license-key",
        licenseValid: true,
        transcriptionProvider: "systemsculpt",
        customTranscriptionEndpoint: "",
        customTranscriptionApiKey: "",
        customTranscriptionModel: "whisper-1",
        enableAutoAudioResampling: true,
      },
      directoryManager: null,
    };

    // Reset singleton for each test
    (TranscriptionService as any).instance = undefined;
    service = TranscriptionService.getInstance(mockPlugin);
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = TranscriptionService.getInstance(mockPlugin);
      const instance2 = TranscriptionService.getInstance(mockPlugin);
      expect(instance1).toBe(instance2);
    });
  });

  describe("formatTimestamp", () => {
    it("formats zero seconds correctly", () => {
      const result = (service as any).formatTimestamp(0);
      expect(result).toBe("00:00:00,000");
    });

    it("formats seconds only", () => {
      const result = (service as any).formatTimestamp(45);
      expect(result).toBe("00:00:45,000");
    });

    it("formats minutes and seconds", () => {
      const result = (service as any).formatTimestamp(125);
      expect(result).toBe("00:02:05,000");
    });

    it("formats hours, minutes, and seconds", () => {
      const result = (service as any).formatTimestamp(3665);
      expect(result).toBe("01:01:05,000");
    });

    it("formats milliseconds", () => {
      const result = (service as any).formatTimestamp(5.5);
      expect(result).toBe("00:00:05,500");
    });

    it("formats fractional seconds correctly", () => {
      const result = (service as any).formatTimestamp(1.234);
      expect(result).toBe("00:00:01,234");
    });
  });

  describe("timestampToSeconds", () => {
    it("converts SRT format timestamp to seconds", () => {
      const result = (service as any).timestampToSeconds("00:01:30,500");
      expect(result).toBe(90.5);
    });

    it("converts VTT format timestamp to seconds", () => {
      const result = (service as any).timestampToSeconds("00:01:30.500");
      expect(result).toBe(90.5);
    });

    it("converts timestamp with hours to seconds", () => {
      const result = (service as any).timestampToSeconds("01:30:45,250");
      expect(result).toBe(5445.25);
    });

    it("converts zero timestamp to zero", () => {
      const result = (service as any).timestampToSeconds("00:00:00,000");
      expect(result).toBe(0);
    });
  });

  describe("secondsToTimestamp", () => {
    it("converts seconds to SRT format", () => {
      const result = (service as any).secondsToTimestamp(90.5, "srt");
      expect(result).toBe("00:01:30,500");
    });

    it("converts seconds to VTT format", () => {
      const result = (service as any).secondsToTimestamp(90.5, "vtt");
      expect(result).toBe("00:01:30.500");
    });

    it("handles zero seconds", () => {
      const result = (service as any).secondsToTimestamp(0, "srt");
      expect(result).toBe("00:00:00,000");
    });

    it("handles hours correctly", () => {
      const result = (service as any).secondsToTimestamp(3661.5, "srt");
      expect(result).toBe("01:01:01,500");
    });
  });

  describe("hasTimestamps", () => {
    it("returns true for SRT format timestamps", () => {
      const text = "1\n00:00:00,000 --> 00:00:05,000\nHello world";
      const result = (service as any).hasTimestamps(text);
      expect(result).toBe(true);
    });

    it("returns true for VTT format timestamps", () => {
      const text = "1\n00:00:00.000 --> 00:00:05.000\nHello world";
      const result = (service as any).hasTimestamps(text);
      expect(result).toBe(true);
    });

    it("returns false for plain text", () => {
      const text = "Hello world, this is plain text without timestamps.";
      const result = (service as any).hasTimestamps(text);
      expect(result).toBe(false);
    });

    it("returns false for text with time-like strings that are not timestamps", () => {
      const text = "The meeting is at 10:30 AM tomorrow.";
      const result = (service as any).hasTimestamps(text);
      expect(result).toBe(false);
    });
  });

  describe("isSrtFormat", () => {
    it("returns true for valid SRT format", () => {
      const text = "1\n00:00:00,000 --> 00:00:05,000\nHello world";
      const result = (service as any).isSrtFormat(text);
      expect(result).toBe(true);
    });

    it("returns false for VTT format", () => {
      const text = "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world";
      const result = (service as any).isSrtFormat(text);
      expect(result).toBe(false);
    });

    it("returns false for plain text", () => {
      const text = "This is just plain text.";
      const result = (service as any).isSrtFormat(text);
      expect(result).toBe(false);
    });
  });

  describe("parseTimestamps", () => {
    it("parses SRT timestamps", () => {
      const text = "1\n00:00:05,000 --> 00:00:10,500\nHello";
      const result = (service as any).parseTimestamps(text);
      expect(result).toHaveLength(1);
      expect(result[0].startSeconds).toBe(5);
      expect(result[0].endSeconds).toBe(10.5);
    });

    it("parses VTT timestamps", () => {
      const text = "00:00:05.000 --> 00:00:10.500\nHello";
      const result = (service as any).parseTimestamps(text);
      expect(result).toHaveLength(1);
      expect(result[0].startSeconds).toBe(5);
      expect(result[0].endSeconds).toBe(10.5);
    });

    it("parses multiple timestamps", () => {
      const text = `1
00:00:00,000 --> 00:00:05,000
First

2
00:00:05,500 --> 00:00:10,000
Second`;
      const result = (service as any).parseTimestamps(text);
      expect(result).toHaveLength(2);
    });

    it("returns empty array for no timestamps", () => {
      const text = "Plain text without timestamps";
      const result = (service as any).parseTimestamps(text);
      expect(result).toHaveLength(0);
    });
  });

  describe("parseSrtEntries", () => {
    it("parses SRT entries correctly", () => {
      const text = `1
00:00:00,000 --> 00:00:05,000
First entry

2
00:00:05,500 --> 00:00:10,000
Second entry`;
      const result = (service as any).parseSrtEntries(text);
      expect(result).toHaveLength(2);
      expect(result[0].entryNumber).toBe(1);
      expect(result[0].content).toBe("First entry");
      expect(result[1].entryNumber).toBe(2);
      expect(result[1].content).toBe("Second entry");
    });

    it("handles multi-line content", () => {
      const text = `1
00:00:00,000 --> 00:00:05,000
First line
Second line`;
      const result = (service as any).parseSrtEntries(text);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("First line\nSecond line");
    });

    it("returns empty array for invalid format", () => {
      const text = "This is not SRT format";
      const result = (service as any).parseSrtEntries(text);
      expect(result).toHaveLength(0);
    });
  });

  describe("isReversedSrtNumbering", () => {
    it("returns true for reversed numbering", () => {
      const entries = [
        { entryNumber: 5 },
        { entryNumber: 4 },
        { entryNumber: 3 },
        { entryNumber: 2 },
        { entryNumber: 1 },
      ];
      const result = (service as any).isReversedSrtNumbering(entries);
      expect(result).toBe(true);
    });

    it("returns false for normal numbering", () => {
      const entries = [
        { entryNumber: 1 },
        { entryNumber: 2 },
        { entryNumber: 3 },
      ];
      const result = (service as any).isReversedSrtNumbering(entries);
      expect(result).toBe(false);
    });

    it("returns false for single entry", () => {
      const entries = [{ entryNumber: 1 }];
      const result = (service as any).isReversedSrtNumbering(entries);
      expect(result).toBe(false);
    });

    it("returns false for empty array", () => {
      const result = (service as any).isReversedSrtNumbering([]);
      expect(result).toBe(false);
    });

    it("returns false for non-consistently decreasing", () => {
      const entries = [
        { entryNumber: 5 },
        { entryNumber: 3 },
        { entryNumber: 4 },
      ];
      const result = (service as any).isReversedSrtNumbering(entries);
      expect(result).toBe(false);
    });
  });

  describe("hasUnusualSrtNumbering", () => {
    it("returns true if not starting with 1", () => {
      const entries = [
        { entryNumber: 2 },
        { entryNumber: 3 },
        { entryNumber: 4 },
      ];
      const result = (service as any).hasUnusualSrtNumbering(entries);
      expect(result).toBe(true);
    });

    it("returns true for reversed numbering", () => {
      const entries = [
        { entryNumber: 3 },
        { entryNumber: 2 },
        { entryNumber: 1 },
      ];
      const result = (service as any).hasUnusualSrtNumbering(entries);
      expect(result).toBe(true);
    });

    it("returns true for non-sequential numbering", () => {
      const entries = [
        { entryNumber: 1 },
        { entryNumber: 3 },
        { entryNumber: 5 },
      ];
      const result = (service as any).hasUnusualSrtNumbering(entries);
      expect(result).toBe(true);
    });

    it("returns false for normal sequential numbering starting from 1", () => {
      const entries = [
        { entryNumber: 1 },
        { entryNumber: 2 },
        { entryNumber: 3 },
      ];
      const result = (service as any).hasUnusualSrtNumbering(entries);
      expect(result).toBe(false);
    });

    it("returns false for single entry starting with 1", () => {
      const entries = [{ entryNumber: 1 }];
      const result = (service as any).hasUnusualSrtNumbering(entries);
      expect(result).toBe(false);
    });
  });

  describe("findOverlap", () => {
    it("finds exact overlap between strings", () => {
      const str1 = "Hello world, this is a test sentence.";
      const str2 = "this is a test sentence. And more content.";
      const result = (service as any).findOverlap(str1, str2);
      expect(result).toBeGreaterThan(0);
    });

    it("returns 0 for no overlap", () => {
      const str1 = "Completely different";
      const str2 = "No overlap here";
      const result = (service as any).findOverlap(str1, str2);
      expect(result).toBe(0);
    });

    it("handles case-insensitive matching", () => {
      const str1 = "Hello WORLD";
      const str2 = "hello world and more";
      const result = (service as any).findOverlap(str1, str2);
      expect(result).toBeGreaterThan(0);
    });

    it("respects max overlap length", () => {
      const str1 = "A".repeat(200);
      const str2 = "A".repeat(200);
      const result = (service as any).findOverlap(str1, str2, 50);
      expect(result).toBeLessThanOrEqual(50);
    });
  });

  describe("adjustTimestamps", () => {
    it("adds positive offset to timestamps", () => {
      const text = "1\n00:00:00,000 --> 00:00:05,000\nHello";
      const result = (service as any).adjustTimestamps(text, 10);
      expect(result).toContain("00:00:10,000");
      expect(result).toContain("00:00:15,000");
    });

    it("subtracts negative offset from timestamps", () => {
      const text = "1\n00:00:10,000 --> 00:00:15,000\nHello";
      const result = (service as any).adjustTimestamps(text, -5);
      expect(result).toContain("00:00:05,000");
      expect(result).toContain("00:00:10,000");
    });

    it("does not adjust below zero", () => {
      const text = "1\n00:00:05,000 --> 00:00:10,000\nHello";
      const result = (service as any).adjustTimestamps(text, -10);
      expect(result).toContain("00:00:00,000");
    });

    it("returns original text for zero offset", () => {
      const text = "1\n00:00:05,000 --> 00:00:10,000\nHello";
      const result = (service as any).adjustTimestamps(text, 0);
      expect(result).toBe(text);
    });

    it("returns original text for no timestamps", () => {
      const text = "Plain text without timestamps";
      const result = (service as any).adjustTimestamps(text, 10);
      expect(result).toBe(text);
    });
  });

  describe("renumberSrtEntries", () => {
    it("renumbers entries starting from specified number", () => {
      const text = `5
00:00:00,000 --> 00:00:05,000
First

6
00:00:05,500 --> 00:00:10,000
Second`;
      const result = (service as any).renumberSrtEntries(text, 1);
      expect(result).toContain("1");
      expect(result).toContain("2");
    });

    it("returns original text for empty entries", () => {
      const text = "Plain text";
      const result = (service as any).renumberSrtEntries(text, 1);
      expect(result).toBe(text);
    });
  });

  describe("mergeTranscriptions", () => {
    it("returns empty string for empty array", () => {
      const result = (service as any).mergeTranscriptions([]);
      expect(result).toBe("");
    });

    it("returns single transcription unchanged if normal numbering", () => {
      const transcription = `1
00:00:00,000 --> 00:00:05,000
Hello`;
      const result = (service as any).mergeTranscriptions([transcription]);
      expect(result).toContain("Hello");
    });

    it("merges multiple plain text transcriptions", () => {
      const result = (service as any).mergeTranscriptions([
        "First part of the text.",
        "Second part of the text.",
      ]);
      expect(result).toContain("First part");
      expect(result).toContain("Second part");
    });

    it("handles overlap in plain text transcriptions", () => {
      const result = (service as any).mergeTranscriptions([
        "This is a test sentence that ends here.",
        "sentence that ends here. And continues with more.",
      ]);
      // Should not have duplicate content
      expect(result.match(/sentence that ends here/g)?.length || 0).toBeLessThanOrEqual(2);
    });
  });

  describe("parseNdjsonText", () => {
    it("parses NDJSON with text response", () => {
      const text = '{"progress_update":{"progress":50,"status":"Processing"}}\n{"text":"Hello world"}';
      const result = (service as any).parseNdjsonText(text);
      expect(result.text).toBe("Hello world");
    });

    it("parses NDJSON with error response", () => {
      const text = '{"error":"Something went wrong"}';
      const result = (service as any).parseNdjsonText(text);
      expect(result.error).toBe("Something went wrong");
    });

    it("calls progress callback for progress updates", () => {
      const onProgress = jest.fn();
      const text = '{"progress_update":{"progress":50,"status":"Processing"}}\n{"text":"Done"}';
      (service as any).parseNdjsonText(text, onProgress);
      expect(onProgress).toHaveBeenCalledWith(50, "Processing");
    });

    it("handles empty text", () => {
      const result = (service as any).parseNdjsonText("");
      expect(result).toEqual({});
    });

    it("handles malformed JSON gracefully", () => {
      const text = 'not valid json\n{"text":"Valid"}';
      const result = (service as any).parseNdjsonText(text);
      expect(result.text).toBe("Valid");
    });
  });

  describe("buildMultipartBody", () => {
    it("builds multipart body with string fields", async () => {
      const fields = [
        { name: "field1", value: "value1" },
        { name: "field2", value: "value2" },
      ];
      const boundary = "testboundary";
      const result = await (service as any).buildMultipartBody(fields, boundary);

      expect(result).toBeInstanceOf(Uint8Array);
      const text = new TextDecoder().decode(result);
      expect(text).toContain("field1");
      expect(text).toContain("value1");
      expect(text).toContain("field2");
      expect(text).toContain("value2");
      expect(text).toContain(`--${boundary}--`);
    });

    it("builds multipart body with mixed fields", async () => {
      // Test with string fields and verify boundary is present
      const fields = [
        { name: "file", value: "file-content" },
        { name: "model", value: "whisper-1" },
        { name: "requestId", value: "test-123" },
      ];
      const boundary = "testboundary";
      const result = await (service as any).buildMultipartBody(fields, boundary);

      expect(result).toBeInstanceOf(Uint8Array);
      const text = new TextDecoder().decode(result);
      expect(text).toContain('name="file"');
      expect(text).toContain('name="model"');
      expect(text).toContain("whisper-1");
      expect(text).toContain("test-123");
      expect(text).toContain(`--${boundary}--`);
    });
  });

  describe("unload", () => {
    it("disposes audio resampler", () => {
      const disposeSpy = jest.fn();
      (service as any).audioResampler = { dispose: disposeSpy };

      service.unload();

      expect(disposeSpy).toHaveBeenCalled();
    });

    it("handles missing audio resampler", () => {
      (service as any).audioResampler = null;
      expect(() => service.unload()).not.toThrow();
    });
  });

  describe("parseErrorResponse", () => {
    // Create a mock Response-like object for testing
    function createMockResponse(body: string, status: number, statusText: string) {
      return {
        status,
        statusText,
        json: async () => JSON.parse(body),
      };
    }

    function createFailingMockResponse(status: number, statusText: string) {
      return {
        status,
        statusText,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      };
    }

    it("parses error with message string", async () => {
      const response = createMockResponse(
        JSON.stringify({ error: "Test error" }),
        500,
        "Internal Server Error"
      );
      const result = await (service as any).parseErrorResponse(response);
      expect(result.message).toBe("Test error");
    });

    it("parses error with error.message object", async () => {
      const response = createMockResponse(
        JSON.stringify({ error: { message: "Nested error message" } }),
        400,
        "Bad Request"
      );
      const result = await (service as any).parseErrorResponse(response);
      expect(result.message).toBe("Nested error message");
    });

    it("parses error with complex error object", async () => {
      const response = createMockResponse(
        JSON.stringify({ error: { code: 123, details: "some details" } }),
        400,
        "Bad Request"
      );
      const result = await (service as any).parseErrorResponse(response);
      expect(result.message).toContain("code");
    });

    it("handles non-error response", async () => {
      const response = createMockResponse(
        JSON.stringify({ success: true }),
        500,
        "Server Error"
      );
      const result = await (service as any).parseErrorResponse(response);
      expect(result.message).toBe("Server Error");
    });

    it("handles invalid JSON", async () => {
      const response = createFailingMockResponse(500, "Server Error");
      const result = await (service as any).parseErrorResponse(response);
      expect(result.message).toBe("Server Error");
    });

    it("returns data from parsed response", async () => {
      const response = createMockResponse(
        JSON.stringify({ error: "Test", extraData: "value" }),
        400,
        "Bad Request"
      );
      const result = await (service as any).parseErrorResponse(response);
      expect(result.data).toBeDefined();
      expect(result.data.extraData).toBe("value");
    });
  });

  describe("buildMultipartBody string fields only", () => {
    it("correctly terminates with boundary", async () => {
      const fields = [{ name: "test", value: "value" }];
      const boundary = "myboundary";
      const result = await (service as any).buildMultipartBody(fields, boundary);

      const text = new TextDecoder().decode(result);
      expect(text).toContain("--myboundary--");
    });

    it("handles empty fields array", async () => {
      const fields: any[] = [];
      const boundary = "emptyboundary";
      const result = await (service as any).buildMultipartBody(fields, boundary);

      const text = new TextDecoder().decode(result);
      expect(text).toBe("--emptyboundary--\r\n");
    });

    it("handles special characters in field values", async () => {
      const fields = [
        { name: "field", value: "value with spaces & special chars!" },
      ];
      const boundary = "boundary";
      const result = await (service as any).buildMultipartBody(fields, boundary);

      const text = new TextDecoder().decode(result);
      expect(text).toContain("value with spaces & special chars!");
    });
  });

  describe("getDiagnostics", () => {
    it("returns current state diagnostics", () => {
      const result = (service as any).getDiagnostics();
      expect(result).toHaveProperty("activeUploads");
      expect(result).toHaveProperty("maxConcurrentUploads");
      expect(result).toHaveProperty("queueSize");
      expect(result).toHaveProperty("retryCount");
    });
  });

  describe("logging methods", () => {
    it("debug logs with diagnostics", () => {
      const { logDebug } = require("../../utils/errorHandling");
      (service as any).debug("test message", { extra: "data" });
      expect(logDebug).toHaveBeenCalledWith(
        "TranscriptionService",
        "test message",
        expect.objectContaining({ extra: "data" })
      );
    });

    it("info logs with diagnostics", () => {
      const { logInfo } = require("../../utils/errorHandling");
      (service as any).info("info message", { key: "value" });
      expect(logInfo).toHaveBeenCalledWith(
        "TranscriptionService",
        "info message",
        expect.objectContaining({ key: "value" })
      );
    });

    it("warn logs with diagnostics", () => {
      const { logWarning } = require("../../utils/errorHandling");
      (service as any).warn("warning message");
      expect(logWarning).toHaveBeenCalledWith(
        "TranscriptionService",
        "warning message",
        expect.any(Object)
      );
    });

    it("error logs with error object", () => {
      const { logError } = require("../../utils/errorHandling");
      const error = new Error("test error");
      (service as any).error("error message", error, { context: "test" });
      expect(logError).toHaveBeenCalled();
    });
  });

  describe("mergeTranscriptions edge cases", () => {
    it("fixes reversed SRT numbering in single transcription", () => {
      const transcription = `3
00:00:10,000 --> 00:00:15,000
Third

2
00:00:05,000 --> 00:00:10,000
Second

1
00:00:00,000 --> 00:00:05,000
First`;
      const result = (service as any).mergeTranscriptions([transcription]);
      // Should renumber entries starting from 1
      expect(result).toContain("1\n00:00");
    });

    it("merges timestamped non-SRT transcriptions", () => {
      // VTT format (not SRT)
      const transcriptions = [
        "00:00:00.000 --> 00:00:05.000\nFirst chunk",
        "00:00:05.000 --> 00:00:10.000\nSecond chunk",
      ];
      const result = (service as any).mergeTranscriptions(transcriptions);
      expect(result).toContain("First chunk");
      expect(result).toContain("Second chunk");
    });

    it("merges multiple SRT transcriptions with renumbering", () => {
      const transcription1 = `1
00:00:00,000 --> 00:00:05,000
First`;
      const transcription2 = `1
00:00:05,000 --> 00:00:10,000
Second`;
      const result = (service as any).mergeTranscriptions([
        transcription1,
        transcription2,
      ]);
      expect(result).toContain("1\n00:00:00,000");
      expect(result).toContain("2\n00:00:05,000");
    });

    it("handles plain text with punctuation at end", () => {
      const result = (service as any).mergeTranscriptions([
        "First sentence.",
        "Second sentence.",
      ]);
      expect(result).toContain("First sentence.");
      expect(result).toContain("Second sentence.");
    });

    it("handles plain text ending without punctuation with uppercase next", () => {
      const result = (service as any).mergeTranscriptions([
        "First part",
        "Second Part",
      ]);
      // Should add period before uppercase
      expect(result).toContain(". Second Part");
    });

    it("handles plain text ending without punctuation with lowercase next", () => {
      const result = (service as any).mergeTranscriptions([
        "First part",
        "second part",
      ]);
      // Should add space for continuity
      expect(result).toContain(" second part");
    });

    it("handles text ending with space", () => {
      const result = (service as any).mergeTranscriptions([
        "First part ",
        "second part",
      ]);
      expect(result).toBe("First part second part");
    });
  });

  describe("adjustTimestamps VTT format", () => {
    it("adjusts VTT format timestamps", () => {
      const text = "00:00:00.000 --> 00:00:05.000\nHello";
      const result = (service as any).adjustTimestamps(text, 10);
      expect(result).toContain("00:00:10.000");
      expect(result).toContain("00:00:15.000");
    });
  });

  describe("renumberSrtEntries edge cases", () => {
    it("handles reversed entries", () => {
      const text = `3
00:00:10,000 --> 00:00:15,000
Third

2
00:00:05,000 --> 00:00:10,000
Second

1
00:00:00,000 --> 00:00:05,000
First`;
      const result = (service as any).renumberSrtEntries(text, 1);
      // Entries should be renumbered based on position
      expect(result).toContain("1");
      expect(result).toContain("2");
      expect(result).toContain("3");
    });
  });

  describe("parseNdjsonText edge cases", () => {
    it("ignores NaN progress values", () => {
      const onProgress = jest.fn();
      const text = '{"progress_update":{"progress":"not a number","status":"Processing"}}';
      (service as any).parseNdjsonText(text, onProgress);
      expect(onProgress).not.toHaveBeenCalled();
    });

    it("handles progress without status", () => {
      const onProgress = jest.fn();
      const text = '{"progress_update":{"progress":50}}';
      (service as any).parseNdjsonText(text, onProgress);
      expect(onProgress).toHaveBeenCalledWith(50, "");
    });

    it("handles multiple progress updates keeping last text", () => {
      const onProgress = jest.fn();
      const text = '{"progress_update":{"progress":25,"status":"Starting"}}\n{"progress_update":{"progress":75,"status":"Almost done"}}\n{"text":"Final result"}';
      const result = (service as any).parseNdjsonText(text, onProgress);
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(result.text).toBe("Final result");
    });
  });

  describe("buildMultipartBody", () => {
    it("builds a multipart body with string and blob fields", async () => {
      const boundary = "test-boundary";
      const fields = [
        { name: "model", value: "whisper-1" },
        { name: "file", value: new Blob(["audio"], { type: "audio/mpeg" }), filename: "audio.mp3" },
      ];

      const body = await (service as any).buildMultipartBody(fields, boundary);
      const decoded = new TextDecoder().decode(body);

      expect(decoded).toContain(`--${boundary}`);
      expect(decoded).toContain('name="model"');
      expect(decoded).toContain("whisper-1");
      expect(decoded).toContain('name="file"');
      expect(decoded).toContain("audio.mp3");
    });
  });

  describe("parseNdjsonText", () => {
    it("emits progress updates and returns final payload", () => {
      const onProgress = jest.fn();
      const raw = [
        JSON.stringify({ progress_update: { progress: 10, status: "Uploading" } }),
        JSON.stringify({ text: "final text" }),
      ].join("\n");

      const result = (service as any).parseNdjsonText(raw, onProgress);

      expect(onProgress).toHaveBeenCalledWith(10, "Uploading");
      expect(result.text).toBe("final text");
    });
  });

  describe("parseNdjsonStream", () => {
    it("falls back to text parsing when no stream is available", async () => {
      const onProgress = jest.fn();
      const response = {
        body: null,
        text: jest.fn().mockResolvedValue(
          JSON.stringify({ progress_update: { progress: 40, status: "Processing" } }) +
            "\n" +
            JSON.stringify({ text: "streamed text" })
        ),
      } as any;

      const result = await (service as any).parseNdjsonStream(response, onProgress);

      expect(onProgress).toHaveBeenCalledWith(40, "Processing");
      expect(result.text).toBe("streamed text");
    });
  });

  describe("transcribeAudio", () => {
    it("transcribes via requestUrl for systemsculpt provider", async () => {
      (PlatformContext.get as jest.Mock).mockReturnValue({
        isMobile: jest.fn(() => false),
        preferredTransport: jest.fn(() => "requestUrl"),
        supportsStreaming: jest.fn(() => true),
      });
      (TranscriptionService as any).instance = undefined;
      service = TranscriptionService.getInstance(mockPlugin);

      (requestUrl as jest.Mock).mockResolvedValue({
        status: 200,
        headers: { "content-type": "application/json" },
        json: { text: "hello world" },
      });

      const file = new TFile({ path: "audio.mp3", name: "audio.mp3", extension: "mp3" });
      const blob = new Blob(["audio"], { type: "audio/mpeg" });

      const result = await (service as any).transcribeAudio(file, blob, {
        onProgress: jest.fn(),
      });

      expect(result).toBe("hello world");
      expect(requestUrl).toHaveBeenCalled();
    });

    it("sends OGG with correct filename + mime type for Groq custom", async () => {
      (PlatformContext.get as jest.Mock).mockReturnValue({
        isMobile: jest.fn(() => false),
        preferredTransport: jest.fn(() => "requestUrl"),
        supportsStreaming: jest.fn(() => true),
      });

      mockPlugin.settings.transcriptionProvider = "custom";
      mockPlugin.settings.customTranscriptionEndpoint =
        "https://api.groq.com/openai/v1/audio/transcriptions";
      mockPlugin.settings.customTranscriptionApiKey = "test";
      (TranscriptionService as any).instance = undefined;
      service = TranscriptionService.getInstance(mockPlugin);

      (requestUrl as jest.Mock).mockResolvedValue({
        status: 200,
        headers: { "content-type": "application/json" },
        json: { text: "ok" },
      });

      const file = new TFile();
      (file as any).path = "audio.ogg";
      (file as any).name = "audio.ogg";
      (file as any).basename = "audio";
      (file as any).extension = "ogg";

      const blob = new Blob(["audio"], { type: "audio/ogg" });
      const result = await (service as any).transcribeAudio(file, blob, {
        onProgress: jest.fn(),
      });

      expect(result).toBe("ok");
      expect(requestUrl).toHaveBeenCalledTimes(1);

      const requestArgs = (requestUrl as jest.Mock).mock.calls[0][0];
      const body = requestArgs.body as ArrayBuffer;
      const text = new TextDecoder().decode(new Uint8Array(body).slice(0, 800));
      expect(text).toContain('filename="audio.ogg"');
      expect(text).toContain("Content-Type: audio/ogg");
    });
  });

  describe("transcribeFile chunking", () => {
    it("does not chunk custom Groq uploads under the 25MB limit", async () => {
      (PlatformContext.get as jest.Mock).mockReturnValue({
        isMobile: jest.fn(() => false),
        preferredTransport: jest.fn(() => "requestUrl"),
        supportsStreaming: jest.fn(() => true),
      });

      mockPlugin.settings.transcriptionProvider = "custom";
      mockPlugin.settings.customTranscriptionEndpoint =
        "https://api.groq.com/openai/v1/audio/transcriptions";
      mockPlugin.settings.customTranscriptionApiKey = "test";
      (TranscriptionService as any).instance = undefined;
      service = TranscriptionService.getInstance(mockPlugin);

      const buildChunksSpy = jest.spyOn(service as any, "buildWavChunkBlobs");

      (requestUrl as jest.Mock).mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/json" },
        json: { text: "ok" },
      });

      const file = new TFile();
      (file as any).path = "big.ogg";
      (file as any).name = "big.ogg";
      (file as any).basename = "big";
      (file as any).extension = "ogg";
      (file as any).stat = { size: AUDIO_UPLOAD_MAX_BYTES + 1 };

      mockPlugin.app.vault.readBinary = jest
        .fn()
        .mockResolvedValue(new ArrayBuffer(AUDIO_UPLOAD_MAX_BYTES + 1));

      const result = await service.transcribeFile(file, {
        type: "note",
        timestamped: false,
        onProgress: jest.fn(),
        suppressNotices: true,
      });

      expect(result).toBe("ok");
      expect(buildChunksSpy).not.toHaveBeenCalled();
      expect(requestUrl).toHaveBeenCalledTimes(1);

      const requestArgs = (requestUrl as jest.Mock).mock.calls[0][0];
      const body = requestArgs.body as ArrayBuffer;
      const text = new TextDecoder().decode(new Uint8Array(body).slice(0, 800));
      expect(text).toContain('filename="big.ogg"');
      expect(text).toContain("Content-Type: audio/ogg");
    });

    it("chunks files larger than the SystemSculpt serverless limit", async () => {
      (PlatformContext.get as jest.Mock).mockReturnValue({
        isMobile: jest.fn(() => false),
        preferredTransport: jest.fn(() => "requestUrl"),
        supportsStreaming: jest.fn(() => true),
      });
      (TranscriptionService as any).instance = undefined;
      service = TranscriptionService.getInstance(mockPlugin);

      const blob1 = new Blob(["a"], { type: "audio/wav" });
      const blob2 = new Blob(["b"], { type: "audio/wav" });
      jest
        .spyOn(service as any, "buildWavChunkBlobs")
        .mockResolvedValue([blob1, blob2]);

      (requestUrl as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          headers: { "content-type": "application/json" },
          json: { text: "chunk1" },
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: { "content-type": "application/json" },
          json: { text: "chunk2" },
        });

      const file = new TFile();
      (file as any).path = "big.ogg";
      (file as any).name = "big.ogg";
      (file as any).basename = "big";
      (file as any).extension = "ogg";
      (file as any).stat = { size: AUDIO_UPLOAD_MAX_BYTES + 1 };

      mockPlugin.app.vault.readBinary = jest
        .fn()
        .mockResolvedValue(new ArrayBuffer(AUDIO_UPLOAD_MAX_BYTES + 1));

      const result = await service.transcribeFile(file, {
        type: "note",
        timestamped: false,
        onProgress: jest.fn(),
        suppressNotices: true,
      });

      expect(result).toBe("chunk1 chunk2");
      expect(requestUrl).toHaveBeenCalledTimes(2);
    });
  });
});
