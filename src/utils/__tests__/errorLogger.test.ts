/**
 * @jest-environment node
 */
import { errorLogger, ErrorLevel, ErrorContext } from "../errorLogger";

describe("errorLogger", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "debug").mockImplementation(() => {});

    // Reset logger state
    errorLogger.clearHistory();
    errorLogger.setDebugMode(false);
    errorLogger.setMinimumLevel("warn");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getInstance", () => {
    it("returns the same instance", () => {
      const instance1 = errorLogger;
      const instance2 = errorLogger;

      expect(instance1).toBe(instance2);
    });
  });

  describe("log", () => {
    it("logs error level messages", () => {
      errorLogger.log("error", "Test error message");

      expect(console.error).toHaveBeenCalled();
    });

    it("logs warn level messages", () => {
      errorLogger.log("warn", "Test warning message");

      expect(console.warn).toHaveBeenCalled();
    });

    it("logs info level when level allows", () => {
      errorLogger.setMinimumLevel("info");
      errorLogger.log("info", "Test info message");

      expect(console.info).toHaveBeenCalled();
    });

    it("logs debug level when debug mode enabled", () => {
      errorLogger.setDebugMode(true);
      errorLogger.log("debug", "Test debug message");

      expect(console.debug).toHaveBeenCalled();
    });

    it("does not emit info when minimum level is warn", () => {
      errorLogger.setMinimumLevel("warn");
      errorLogger.log("info", "Test info message");

      expect(console.info).not.toHaveBeenCalled();
    });

    it("does not emit debug when debug mode is off and level is warn", () => {
      errorLogger.setDebugMode(false);
      errorLogger.setMinimumLevel("warn");
      errorLogger.log("debug", "Test debug message");

      expect(console.debug).not.toHaveBeenCalled();
    });

    it("adds entries to history regardless of emit level", () => {
      errorLogger.setMinimumLevel("error");
      errorLogger.log("info", "Silent info");

      const history = errorLogger.getHistory();
      expect(history.some((e) => e.message === "Silent info")).toBe(true);
    });

    it("logs with Error object", () => {
      const error = new Error("Test error");
      errorLogger.log("error", "Error occurred", error);

      expect(console.error).toHaveBeenCalled();
      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.message).toBe("Test error");
    });

    it("logs with context", () => {
      const context: ErrorContext = {
        source: "TestSource",
        method: "testMethod",
      };
      errorLogger.log("error", "Error with context", undefined, context);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context?.source).toBe("TestSource");
    });
  });

  describe("error", () => {
    it("logs error messages", () => {
      errorLogger.error("Error message");

      expect(console.error).toHaveBeenCalled();
      const history = errorLogger.getHistory();
      expect(history.some((e) => e.level === "error")).toBe(true);
    });

    it("logs error with Error object", () => {
      const err = new Error("Something went wrong");
      errorLogger.error("Error with exception", err);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.message).toBe("Something went wrong");
    });

    it("logs error with context", () => {
      const context: ErrorContext = { source: "API", method: "fetch" };
      errorLogger.error("API error", undefined, context);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context?.source).toBe("API");
    });
  });

  describe("warn", () => {
    it("logs warning messages", () => {
      errorLogger.warn("Warning message");

      expect(console.warn).toHaveBeenCalled();
      const history = errorLogger.getHistory();
      expect(history.some((e) => e.level === "warn")).toBe(true);
    });

    it("logs warning with context", () => {
      const context: ErrorContext = { source: "Cache" };
      errorLogger.warn("Cache miss", context);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context?.source).toBe("Cache");
    });
  });

  describe("info", () => {
    it("logs info messages when level allows", () => {
      errorLogger.setMinimumLevel("info");
      errorLogger.info("Info message");

      expect(console.info).toHaveBeenCalled();
      const history = errorLogger.getHistory();
      expect(history.some((e) => e.level === "info")).toBe(true);
    });

    it("logs info with context", () => {
      errorLogger.setMinimumLevel("debug");
      const context: ErrorContext = { source: "Init" };
      errorLogger.info("Initialization complete", context);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context?.source).toBe("Init");
    });
  });

  describe("debug", () => {
    it("logs debug messages in debug mode", () => {
      errorLogger.setDebugMode(true);
      errorLogger.debug("Debug message");

      expect(console.debug).toHaveBeenCalled();
      const history = errorLogger.getHistory();
      expect(history.some((e) => e.level === "debug")).toBe(true);
    });

    it("logs debug with context", () => {
      errorLogger.setDebugMode(true);
      const context: ErrorContext = { source: "Debug", metadata: { key: "value" } };
      errorLogger.debug("Debug with metadata", context);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context?.metadata).toEqual({ key: "value" });
    });
  });

  describe("getHistory", () => {
    it("returns copy of history", () => {
      errorLogger.error("Entry 1");
      errorLogger.warn("Entry 2");

      const history = errorLogger.getHistory();
      expect(history.length).toBe(2);

      // Should be a copy
      history.pop();
      expect(errorLogger.getHistory().length).toBe(2);
    });

    it("returns empty array when no logs", () => {
      errorLogger.clearHistory();
      expect(errorLogger.getHistory()).toEqual([]);
    });
  });

  describe("clearHistory", () => {
    it("clears all log entries", () => {
      errorLogger.error("Entry 1");
      errorLogger.warn("Entry 2");
      errorLogger.clearHistory();

      expect(errorLogger.getHistory()).toEqual([]);
    });
  });

  describe("exportLogs", () => {
    it("exports logs as JSON string", () => {
      errorLogger.error("Export test");

      const exported = errorLogger.exportLogs();
      const parsed = JSON.parse(exported);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((e: any) => e.message === "Export test")).toBe(true);
    });

    it("returns empty array string when no logs", () => {
      errorLogger.clearHistory();
      const exported = errorLogger.exportLogs();

      expect(exported).toBe("[]");
    });

    it("exports properly formatted JSON", () => {
      errorLogger.error("Test");
      const exported = errorLogger.exportLogs();

      // Should have newlines (pretty printed)
      expect(exported.includes("\n")).toBe(true);
    });
  });

  describe("setDebugMode", () => {
    it("enables debug logging", () => {
      errorLogger.setDebugMode(true);
      errorLogger.debug("Debug enabled");

      expect(console.debug).toHaveBeenCalled();
    });

    it("disables debug logging", () => {
      errorLogger.setDebugMode(false);
      errorLogger.setMinimumLevel("error");
      errorLogger.debug("Debug disabled");

      expect(console.debug).not.toHaveBeenCalled();
    });

    it("handles truthy/falsy values", () => {
      errorLogger.setDebugMode(1 as any);
      errorLogger.debug("Truthy test");

      expect(console.debug).toHaveBeenCalled();
    });
  });

  describe("setMinimumLevel", () => {
    it("sets minimum log level to error", () => {
      errorLogger.setMinimumLevel("error");
      errorLogger.warn("Should not emit");

      expect(console.warn).not.toHaveBeenCalled();
    });

    it("sets minimum log level to info", () => {
      errorLogger.setMinimumLevel("info");
      errorLogger.info("Should emit");

      expect(console.info).toHaveBeenCalled();
    });

    it("sets minimum log level to debug", () => {
      errorLogger.setMinimumLevel("debug");
      errorLogger.debug("Should emit");

      expect(console.debug).toHaveBeenCalled();
    });
  });

  describe("history buffer management", () => {
    it("limits history to maxHistory entries", () => {
      // Add more than 500 entries
      for (let i = 0; i < 550; i++) {
        errorLogger.log("error", `Entry ${i}`);
      }

      const history = errorLogger.getHistory();
      expect(history.length).toBeLessThanOrEqual(500);
    });

    it("removes oldest entries when buffer is full", () => {
      for (let i = 0; i < 550; i++) {
        errorLogger.log("error", `Entry ${i}`);
      }

      const history = errorLogger.getHistory();
      // First entries should be removed
      expect(history.some((e) => e.message === "Entry 0")).toBe(false);
      // Recent entries should remain
      expect(history.some((e) => e.message === "Entry 549")).toBe(true);
    });
  });

  describe("error serialization", () => {
    it("serializes Error objects with stack", () => {
      const error = new Error("Test error");
      errorLogger.error("Error log", error);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.name).toBe("Error");
      expect(lastEntry.error?.message).toBe("Test error");
      expect(lastEntry.error?.stack).toBeDefined();
    });

    it("serializes error with code property", () => {
      const error = Object.assign(new Error("Coded error"), { code: "ENOENT" });
      errorLogger.error("Coded error log", error);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.code).toBe("ENOENT");
    });

    it("serializes error with status property", () => {
      const error = Object.assign(new Error("HTTP error"), { status: 404 });
      errorLogger.error("HTTP error log", error);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.status).toBe(404);
    });

    it("serializes error with retryInMs property", () => {
      const error = Object.assign(new Error("Retry error"), { retryInMs: 5000 });
      errorLogger.error("Retry error log", error);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.retryInMs).toBe(5000);
    });

    it("serializes error with details property", () => {
      const error = Object.assign(new Error("Detailed error"), {
        details: { field: "value" },
      });
      errorLogger.error("Detailed error log", error);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.details).toEqual({ field: "value" });
    });

    it("serializes plain objects", () => {
      const error = { code: 500, message: "Server error" };
      errorLogger.error("Object error", error);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.code).toBe(500);
      expect(lastEntry.error?.message).toBe("Server error");
    });

    it("handles string errors", () => {
      errorLogger.error("String error", "Simple error string");

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.error?.message).toBe("Simple error string");
    });

    it("handles circular references in objects", () => {
      const circular: any = { key: "value" };
      circular.self = circular;

      // Should not throw
      expect(() => errorLogger.error("Circular error", circular)).not.toThrow();
    });
  });

  describe("context handling", () => {
    it("includes all context fields", () => {
      const context: ErrorContext = {
        source: "TestSource",
        method: "testMethod",
        userId: "user123",
        modelId: "model456",
        providerId: "provider789",
        metadata: { extra: "data" },
      };

      errorLogger.error("Full context", undefined, context);

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context).toEqual(context);
    });

    it("omits empty context", () => {
      errorLogger.error("Empty context", undefined, {});

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context).toBeUndefined();
    });

    it("preserves context with single field", () => {
      errorLogger.error("Single field context", undefined, { source: "Test" });

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.context?.source).toBe("Test");
    });
  });

  describe("timestamp", () => {
    it("includes timestamp in entries", () => {
      errorLogger.error("Timestamped entry");

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      expect(lastEntry.timestamp).toBeDefined();
      expect(typeof lastEntry.timestamp).toBe("string");
    });

    it("timestamp is ISO format", () => {
      errorLogger.error("ISO timestamp");

      const history = errorLogger.getHistory();
      const lastEntry = history[history.length - 1];
      // Should be parseable as a date
      expect(() => new Date(lastEntry.timestamp)).not.toThrow();
    });
  });

  describe("console fallback", () => {
    it("handles missing console methods gracefully", () => {
      const originalError = console.error;
      (console as any).error = undefined;

      // Should not throw, falls back to console.log
      expect(() => errorLogger.error("Fallback test")).not.toThrow();

      console.error = originalError;
    });
  });
});
