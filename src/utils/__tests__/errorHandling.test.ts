/**
 * @jest-environment node
 */
import { Notice } from "obsidian";

// Mock obsidian
jest.mock("obsidian", () => ({
  Notice: jest.fn(),
}));

// Mock errorLogger
const mockErrorLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  setMinimumLevel: jest.fn(),
};

jest.mock("../errorLogger", () => ({
  errorLogger: mockErrorLogger,
}));

import {
  LogLevel,
  currentLogLevel,
  setLogLevel,
  logError,
  logWarning,
  logInfo,
  logDebug,
  logMobileError,
  logMobilePerformance,
  handleEmbeddingError,
  safeExecute,
  safeExecuteWithRetry,
} from "../errorHandling";

describe("errorHandling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset log level
    setLogLevel(LogLevel.WARNING);
  });

  describe("LogLevel enum", () => {
    it("has correct values", () => {
      expect(LogLevel.ERROR).toBe(0);
      expect(LogLevel.WARNING).toBe(1);
      expect(LogLevel.INFO).toBe(2);
      expect(LogLevel.DEBUG).toBe(3);
    });
  });

  describe("setLogLevel", () => {
    it("sets log level and calls errorLogger", () => {
      setLogLevel(LogLevel.DEBUG);

      expect(mockErrorLogger.setMinimumLevel).toHaveBeenCalledWith("debug");
    });

    it("maps LogLevel.ERROR to 'error'", () => {
      setLogLevel(LogLevel.ERROR);

      expect(mockErrorLogger.setMinimumLevel).toHaveBeenCalledWith("error");
    });

    it("maps LogLevel.WARNING to 'warn'", () => {
      setLogLevel(LogLevel.WARNING);

      expect(mockErrorLogger.setMinimumLevel).toHaveBeenCalledWith("warn");
    });

    it("maps LogLevel.INFO to 'info'", () => {
      setLogLevel(LogLevel.INFO);

      expect(mockErrorLogger.setMinimumLevel).toHaveBeenCalledWith("info");
    });
  });

  describe("logError", () => {
    it("logs error with context", () => {
      logError("TestContext", "Something went wrong", new Error("test"));

      expect(mockErrorLogger.error).toHaveBeenCalledWith(
        "TestContext: Something went wrong",
        expect.any(Error),
        { source: "TestContext" }
      );
    });

    it("logs error without context", () => {
      logError("", "Error message", new Error("test"));

      expect(mockErrorLogger.error).toHaveBeenCalledWith(
        "Error message",
        expect.any(Error),
        { source: "" }
      );
    });
  });

  describe("logWarning", () => {
    it("logs warning when level is WARNING or higher", () => {
      setLogLevel(LogLevel.WARNING);

      logWarning("TestContext", "Warning message", { extra: "data" });

      expect(mockErrorLogger.warn).toHaveBeenCalledWith(
        "TestContext: Warning message",
        expect.objectContaining({ source: "TestContext" })
      );
    });

    it("does not log warning when level is ERROR", () => {
      setLogLevel(LogLevel.ERROR);

      logWarning("TestContext", "Warning message");

      expect(mockErrorLogger.warn).not.toHaveBeenCalled();
    });

    it("logs warning without data", () => {
      setLogLevel(LogLevel.WARNING);

      logWarning("TestContext", "Simple warning");

      expect(mockErrorLogger.warn).toHaveBeenCalledWith(
        "TestContext: Simple warning",
        expect.objectContaining({ source: "TestContext" })
      );
    });

    it("logs warning without context", () => {
      setLogLevel(LogLevel.WARNING);

      logWarning("", "Warning message");

      expect(mockErrorLogger.warn).toHaveBeenCalledWith(
        "Warning message",
        expect.objectContaining({ source: "" })
      );
    });
  });

  describe("logInfo", () => {
    it("logs info when level is INFO or higher", () => {
      setLogLevel(LogLevel.INFO);

      logInfo("TestContext", "Info message", { extra: "data" });

      expect(mockErrorLogger.info).toHaveBeenCalledWith(
        "TestContext: Info message",
        expect.objectContaining({ source: "TestContext" })
      );
    });

    it("does not log info when level is WARNING", () => {
      setLogLevel(LogLevel.WARNING);

      logInfo("TestContext", "Info message");

      expect(mockErrorLogger.info).not.toHaveBeenCalled();
    });

    it("logs info without context", () => {
      setLogLevel(LogLevel.INFO);

      logInfo("", "Info message");

      expect(mockErrorLogger.info).toHaveBeenCalledWith(
        "Info message",
        expect.objectContaining({ source: "" })
      );
    });

    it("logs info without data", () => {
      setLogLevel(LogLevel.INFO);

      logInfo("TestContext", "Info message");

      expect(mockErrorLogger.info).toHaveBeenCalledWith(
        "TestContext: Info message",
        expect.objectContaining({ source: "TestContext", metadata: undefined })
      );
    });
  });

  describe("logDebug", () => {
    it("logs debug when level is DEBUG", () => {
      setLogLevel(LogLevel.DEBUG);

      logDebug("TestContext", "Debug message", { extra: "data" });

      expect(mockErrorLogger.debug).toHaveBeenCalledWith(
        "TestContext: Debug message",
        expect.objectContaining({ source: "TestContext" })
      );
    });

    it("does not log debug when level is INFO", () => {
      setLogLevel(LogLevel.INFO);

      logDebug("TestContext", "Debug message");

      expect(mockErrorLogger.debug).not.toHaveBeenCalled();
    });

    it("logs debug without context", () => {
      setLogLevel(LogLevel.DEBUG);

      logDebug("", "Debug message");

      expect(mockErrorLogger.debug).toHaveBeenCalledWith(
        "Debug message",
        expect.objectContaining({ source: "" })
      );
    });

    it("logs debug without data", () => {
      setLogLevel(LogLevel.DEBUG);

      logDebug("TestContext", "Debug message");

      expect(mockErrorLogger.debug).toHaveBeenCalledWith(
        "TestContext: Debug message",
        expect.objectContaining({ source: "TestContext", metadata: undefined })
      );
    });
  });

  describe("logMobileError", () => {
    it("logs error with additional info", async () => {
      await logMobileError("MobileContext", "Mobile error", new Error("test"), {
        device: "iPhone",
      });

      expect(mockErrorLogger.error).toHaveBeenCalledWith(
        "MobileContext: Mobile error",
        expect.any(Error),
        expect.objectContaining({
          source: "MobileContext",
          metadata: { additionalInfo: { device: "iPhone" } },
        })
      );
    });

    it("logs error without additional info", async () => {
      await logMobileError("MobileContext", "Mobile error", new Error("test"));

      expect(mockErrorLogger.error).toHaveBeenCalled();
    });
  });

  describe("logMobilePerformance", () => {
    it("logs performance warning when threshold exceeded on mobile", async () => {
      setLogLevel(LogLevel.WARNING);

      // Mock mobile environment
      const originalWindow = global.window;
      (global as any).window = {
        app: { isMobile: true },
      };
      (global as any).navigator = { userAgent: "iPhone" };
      (global as any).performance = { now: () => 2000 };

      await logMobilePerformance("TestOperation", 0, 1000);

      expect(mockErrorLogger.warn).toHaveBeenCalled();

      (global as any).window = originalWindow;
    });

    it("does not log when threshold not exceeded", async () => {
      setLogLevel(LogLevel.WARNING);

      (global as any).window = {
        app: { isMobile: true },
      };
      (global as any).navigator = { userAgent: "iPhone" };
      (global as any).performance = { now: () => 500 };

      await logMobilePerformance("TestOperation", 0, 1000);

      // Should not have been called because threshold wasn't exceeded
      expect(mockErrorLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("handleEmbeddingError", () => {
    it("logs error and shows notice by default", async () => {
      const error = new Error("Embedding failed");

      await handleEmbeddingError("Embeddings", "Processing failed", error);

      expect(mockErrorLogger.error).toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith("Processing failed: Embedding failed");
    });

    it("logs error without notice when showNotice is false", async () => {
      const error = new Error("Embedding failed");

      await handleEmbeddingError("Embeddings", "Processing failed", error, false);

      expect(mockErrorLogger.error).toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("handles non-Error objects", async () => {
      await handleEmbeddingError("Embeddings", "Processing failed", "string error");

      expect(Notice).toHaveBeenCalledWith("Processing failed: string error");
    });
  });

  describe("safeExecute", () => {
    it("returns result on success", async () => {
      const fn = jest.fn().mockResolvedValue("success");

      const result = await safeExecute(fn, "Test", "Error", "default");

      expect(result).toBe("success");
      expect(mockErrorLogger.error).not.toHaveBeenCalled();
    });

    it("returns default value on error", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("fail"));

      const result = await safeExecute(fn, "Test", "Error message", "default");

      expect(result).toBe("default");
      expect(mockErrorLogger.error).toHaveBeenCalled();
    });

    it("works with different types", async () => {
      const fn = jest.fn().mockResolvedValue({ key: "value" });

      const result = await safeExecute(fn, "Test", "Error", { key: "default" });

      expect(result).toEqual({ key: "value" });
    });
  });

  describe("safeExecuteWithRetry", () => {
    it("returns result on first success", async () => {
      const fn = jest.fn().mockResolvedValue("success");

      const result = await safeExecuteWithRetry(fn, "Test", "Error", "default", 3, 10);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and succeeds", async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("success");

      setLogLevel(LogLevel.WARNING);
      const result = await safeExecuteWithRetry(fn, "Test", "Error", "default", 3, 10);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("returns default after all retries fail", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("always fail"));

      setLogLevel(LogLevel.WARNING);
      const result = await safeExecuteWithRetry(fn, "Test", "Error message", "default", 3, 10);

      expect(result).toBe("default");
      expect(fn).toHaveBeenCalledTimes(3);
      expect(mockErrorLogger.error).toHaveBeenCalledWith(
        "Test: All 3 attempts failed: Error message",
        expect.any(Error),
        expect.any(Object)
      );
    });

    it("uses custom retry parameters", async () => {
      const fn = jest.fn().mockRejectedValue(new Error("fail"));

      setLogLevel(LogLevel.WARNING);
      const result = await safeExecuteWithRetry(fn, "Test", "Error", "default", 5, 5);

      expect(fn).toHaveBeenCalledTimes(5);
      expect(result).toBe("default");
    });
  });
});
