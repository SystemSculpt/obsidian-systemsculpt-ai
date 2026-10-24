/**
 * @jest-environment node
 */
import { errorLogger, type ErrorLevel, type ErrorContext } from "../errorLogger";

describe("errorLogger", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "debug").mockImplementation(() => {});
    errorLogger.setDebugMode(false);
    errorLogger.setMinimumLevel("warn");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<ErrorLevel>(["error", "warn", "info", "debug"])("routes %s with its context", (level) => {
    errorLogger.setMinimumLevel("debug");
    const context: ErrorContext = { source: "Test", method: "run", metadata: { count: 1 } };

    if (level === "error") errorLogger.error("message", undefined, context);
    else errorLogger[level]("message", context);

    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
    expect(method).toHaveBeenCalledWith(`[SystemSculpt][${level.toUpperCase()}] message`, context);
  });

  it.each<ErrorLevel>(["error", "warn", "info", "debug"])("honors the %s minimum level", (minimum) => {
    const levels: ErrorLevel[] = ["error", "warn", "info", "debug"];
    errorLogger.setMinimumLevel(minimum);
    for (const level of levels) errorLogger.log(level, level);

    const calls = [console.error, console.warn, console.debug].flatMap((method) => (method as jest.Mock).mock.calls);
    expect(calls).toHaveLength(levels.indexOf(minimum) + 1);
    for (const level of levels.slice(0, levels.indexOf(minimum) + 1)) {
      expect(calls).toContainEqual([`[SystemSculpt][${level.toUpperCase()}] ${level}`]);
    }
  });

  it("does not inspect suppressed errors or context", () => {
    const reads = jest.fn(() => { throw new Error("must not inspect suppressed data"); });
    const error = new Proxy({}, { ownKeys: reads, get: reads });
    const context = new Proxy({}, { ownKeys: reads, get: reads });
    errorLogger.setMinimumLevel("error");

    expect(() => errorLogger.log("info", "suppressed", error, context)).not.toThrow();

    expect(reads).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
  });

  it("forwards errors without serializing them or keeping a history", () => {
    const stack = jest.fn(() => "expensive stack");
    const error = new Error("original");
    Object.defineProperty(error, "stack", { get: stack });

    errorLogger.error("failed", error);

    expect(stack).not.toHaveBeenCalled();
    expect((console.error as jest.Mock).mock.calls[0][1]).toBe(error);
    expect(errorLogger).not.toHaveProperty("getHistory");
    expect(errorLogger).not.toHaveProperty("exportLogs");
    expect(errorLogger).not.toHaveProperty("clearHistory");
  });

  it.each(["text error", 0, false, null, { code: 500, message: "server error" }])("forwards a non-Error value %p unchanged", (error) => {
    errorLogger.error("failed", error);

    expect(console.error).toHaveBeenCalledWith("[SystemSculpt][ERROR] failed", error);
  });

  it("forwards circular metadata and errors without traversal", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const context = { metadata: circular };

    expect(() => errorLogger.error("failed", circular, context)).not.toThrow();

    expect(console.error).toHaveBeenCalledWith("[SystemSculpt][ERROR] failed", context, circular);
  });

  it("omits empty context and undefined errors", () => {
    errorLogger.error("failed", undefined, {});

    expect(console.error).toHaveBeenCalledWith("[SystemSculpt][ERROR] failed");
  });

  it("lets debug mode override the minimum level until disabled", () => {
    errorLogger.setMinimumLevel("error");
    errorLogger.setDebugMode(true);
    errorLogger.debug("visible");
    errorLogger.setDebugMode(false);
    errorLogger.debug("hidden");

    expect(console.debug).toHaveBeenCalledTimes(1);
    expect(console.debug).toHaveBeenCalledWith("[SystemSculpt][DEBUG] visible");
  });

  it("falls back to debug if a console method is unavailable", () => {
    const original = console.error;
    try {
      console.error = undefined as any;
      expect(() => errorLogger.error("fallback")).not.toThrow();
      expect(console.debug).toHaveBeenCalledWith("[SystemSculpt][ERROR] fallback");
    } finally {
      console.error = original;
    }
  });
});
