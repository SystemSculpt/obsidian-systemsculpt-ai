/**
 * @jest-environment node
 */
// Mock errorLogger
jest.mock("../errorLogger", () => ({
  errorLogger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    setMinimumLevel: jest.fn(),
  },
}));

import { errorLogger } from "../errorLogger";

const mockErrorLogger = errorLogger as unknown as {
  error: jest.Mock;
  warn: jest.Mock;
  info: jest.Mock;
  debug: jest.Mock;
  setMinimumLevel: jest.Mock;
};

import {
  LogLevel,
  setLogLevel,
  logError,
  logInfo,
  logDebug,
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
});
