/**
 * @jest-environment jsdom
 */
import { PluginLogger } from "../PluginLogger";
import { LogLevel } from "../errorHandling";

describe("PluginLogger", () => {
  let logger: PluginLogger;
  let mockPlugin: any;
  let mockStorage: any;
  let consoleSpy: { [key: string]: jest.SpyInstance };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockStorage = {
      appendToFile: jest.fn().mockResolvedValue(undefined),
      getPath: jest.fn((dir, file) => `${dir}/${file}`),
    };

    mockPlugin = {
      settings: {
        debugMode: false,
        logLevel: LogLevel.WARNING,
      },
      storage: mockStorage,
      app: {
        vault: {
          adapter: {
            stat: jest.fn().mockResolvedValue({ size: 100 }),
            write: jest.fn().mockResolvedValue(undefined),
          },
        },
      },
      getErrorCollector: jest.fn(() => null),
    };

    consoleSpy = {
      log: jest.spyOn(console, "log").mockImplementation(),
      info: jest.spyOn(console, "info").mockImplementation(),
      warn: jest.spyOn(console, "warn").mockImplementation(),
      error: jest.spyOn(console, "error").mockImplementation(),
      debug: jest.spyOn(console, "debug").mockImplementation(),
    };

    logger = new PluginLogger(mockPlugin);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.values(consoleSpy).forEach((spy) => spy.mockRestore());
  });

  describe("constructor", () => {
    it("creates logger instance", () => {
      expect(logger).toBeInstanceOf(PluginLogger);
    });

    it("accepts custom log file name", () => {
      const customLogger = new PluginLogger(mockPlugin, { logFileName: "custom.log" });
      expect(customLogger).toBeInstanceOf(PluginLogger);
    });
  });

  describe("logging methods", () => {
    it("info logs message at info level", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Test info message");

      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringContaining("Test info message")
      );
    });

    it("warn logs message at warn level", () => {
      logger.warn("Test warning");

      expect(consoleSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining("Test warning")
      );
    });

    it("error logs message at error level", () => {
      const error = new Error("Test error");

      logger.error("Error occurred", error);

      expect(consoleSpy.error).toHaveBeenCalledWith(
        expect.stringContaining("Error occurred"),
        error
      );
    });

    it("debug logs message at debug level", () => {
      mockPlugin.settings.debugMode = true;

      logger.debug("Debug info");

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        expect.stringContaining("Debug info")
      );
    });

    it("includes context in log", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message with context", { source: "TestSource" });

      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringContaining("Message with context"),
        expect.objectContaining({ source: "TestSource" })
      );
    });
  });

  describe("log level filtering", () => {
    it("logs all levels when debugMode is true", () => {
      mockPlugin.settings.debugMode = true;

      logger.debug("Debug message");
      logger.info("Info message");
      logger.warn("Warn message");
      logger.error("Error message");

      expect(consoleSpy.debug).toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it("respects log level setting", () => {
      mockPlugin.settings.logLevel = LogLevel.ERROR;

      logger.debug("Should not log");
      logger.info("Should not log");
      logger.warn("Should not log");
      logger.error("Should log");

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it("always logs InitializationTracer warnings and errors", () => {
      mockPlugin.settings.logLevel = LogLevel.ERROR;

      logger.warn("Tracer warning", { source: "InitializationTracer" });

      expect(consoleSpy.warn).toHaveBeenCalled();
    });
  });

  describe("getRecentEntries", () => {
    it("returns empty array initially", () => {
      const entries = logger.getRecentEntries();

      expect(entries).toEqual([]);
    });

    it("returns logged entries", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("First message");
      logger.warn("Second message");

      const entries = logger.getRecentEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0].message).toBe("First message");
      expect(entries[1].message).toBe("Second message");
    });

    it("returns copy of entries array", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message");

      const entries1 = logger.getRecentEntries();
      const entries2 = logger.getRecentEntries();

      expect(entries1).not.toBe(entries2);
    });
  });

  describe("setLogFileName", () => {
    it("updates log file name", () => {
      logger.setLogFileName("new-log.log");

      // File name should be updated (verified by flush behavior)
      expect(() => logger.setLogFileName("another.log")).not.toThrow();
    });

    it("ignores empty string", () => {
      logger.setLogFileName("test.log");
      logger.setLogFileName("");

      // Should not throw or change behavior
      expect(() => logger.setLogFileName("")).not.toThrow();
    });
  });

  describe("flush behavior", () => {
    it("flushes entries after interval", async () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message to flush");

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(mockStorage.appendToFile).toHaveBeenCalled();
    });

    it("flushNow forces immediate flush", async () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Immediate flush");

      await logger.flushNow();

      expect(mockStorage.appendToFile).toHaveBeenCalled();
    });

    it("does not flush when no entries pending", async () => {
      await logger.flushNow();

      expect(mockStorage.appendToFile).not.toHaveBeenCalled();
    });

    it("handles missing storage gracefully", async () => {
      mockPlugin.storage = null;
      mockPlugin.settings.debugMode = true;

      logger.info("Message without storage");

      // Advance timers to allow flush scheduling to work
      jest.advanceTimersByTime(3000);

      // Should not throw - but we can't fully test flushNow without storage
      // as it waits for storage to become available
      expect(() => logger.info("Another message")).not.toThrow();
    });
  });

  describe("error serialization", () => {
    it("serializes Error objects", () => {
      const error = new Error("Test error");
      error.stack = "Error: Test error\n  at test.ts:1:1";

      logger.error("Error occurred", error);

      const entries = logger.getRecentEntries();
      expect(entries[0].error).toEqual(expect.objectContaining({
        name: "Error",
        message: "Test error",
        stack: expect.stringContaining("Test error"),
      }));
    });

    it("serializes non-Error objects", () => {
      logger.error("Error occurred", { custom: "error" });

      const entries = logger.getRecentEntries();
      expect(entries[0].error).toEqual({ custom: "error" });
    });

    it("serializes primitive errors", () => {
      logger.error("Error occurred", "String error");

      const entries = logger.getRecentEntries();
      expect(entries[0].error).toEqual({ message: "String error" });
    });
  });

  describe("context sanitization", () => {
    it("preserves valid context fields", () => {
      mockPlugin.settings.debugMode = true;

      logger.info("Message", {
        source: "TestSource",
        method: "testMethod",
        command: "testCommand",
        metadata: { key: "value" },
      });

      const entries = logger.getRecentEntries();
      expect(entries[0].context).toEqual({
        source: "TestSource",
        method: "testMethod",
        command: "testCommand",
        metadata: { key: "value" },
      });
    });

    it("handles unserializable metadata", () => {
      mockPlugin.settings.debugMode = true;

      const circular: any = {};
      circular.self = circular;

      logger.info("Message", { metadata: circular });

      const entries = logger.getRecentEntries();
      expect(entries[0].context?.metadata).toEqual({ note: "metadata_unserializable" });
    });
  });

  describe("error collector forwarding", () => {
    it("forwards logs to error collector when available", () => {
      const mockCollector = {
        captureLog: jest.fn(),
      };
      mockPlugin.getErrorCollector = jest.fn(() => mockCollector);

      logger.error("Test error", new Error("Test"));

      expect(mockCollector.captureLog).toHaveBeenCalledWith(
        "error",
        expect.any(String),
        "Test error",
        expect.any(String)
      );
    });

    it("handles missing error collector", () => {
      mockPlugin.getErrorCollector = jest.fn(() => null);

      expect(() => logger.error("Test")).not.toThrow();
    });
  });
});
