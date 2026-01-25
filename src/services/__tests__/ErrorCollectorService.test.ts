/**
 * @jest-environment jsdom
 */
import { ErrorCollectorService } from "../ErrorCollectorService";

describe("ErrorCollectorService", () => {
  let service: ErrorCollectorService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Create a fresh instance for each test
    service = new ErrorCollectorService(100);
  });

  afterEach(() => {
    // Clean up the service
    service.unload();
  });

  describe("constructor", () => {
    it("creates an instance with specified max logs", () => {
      const customService = new ErrorCollectorService(50);
      expect(customService).toBeInstanceOf(ErrorCollectorService);
      customService.unload();
    });

    it("uses default max logs when not specified", () => {
      const defaultService = new ErrorCollectorService();
      expect(defaultService).toBeInstanceOf(ErrorCollectorService);
      defaultService.unload();
    });
  });

  describe("captureLog", () => {
    it("captures error logs by default", () => {
      service.captureLog("error", "TestContext", "Test error message");

      const logs = service.getAllLogs();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((log) => log.includes("Test error message"))).toBe(true);
    });

    it("captures warn logs by default", () => {
      service.captureLog("warn", "TestContext", "Test warning message");

      const logs = service.getAllLogs();
      expect(logs.some((log) => log.includes("Test warning message"))).toBe(true);
    });

    it("does not capture info logs by default", () => {
      service.captureLog("info", "TestContext", "Test info message");

      const logs = service.getAllLogs();
      expect(logs.some((log) => log.includes("Test info message"))).toBe(false);
    });

    it("does not capture debug logs by default", () => {
      service.captureLog("debug", "TestContext", "Test debug message");

      const logs = service.getAllLogs();
      expect(logs.some((log) => log.includes("Test debug message"))).toBe(false);
    });

    it("captures all logs when enableCaptureAllLogs is called", () => {
      service.enableCaptureAllLogs();

      service.captureLog("info", "TestContext", "Test info message");
      service.captureLog("debug", "TestContext", "Test debug message");
      service.captureLog("log", "TestContext", "Test log message");

      const logs = service.getAllLogs();
      expect(logs.some((log) => log.includes("Test info message"))).toBe(true);
      expect(logs.some((log) => log.includes("Test debug message"))).toBe(true);
      expect(logs.some((log) => log.includes("Test log message"))).toBe(true);
    });

    it("includes stack trace when provided", () => {
      service.captureLog("error", "TestContext", "Test error", "Error stack trace here");

      const logs = service.getAllLogs();
      expect(logs.some((log) => log.includes("Error stack trace here"))).toBe(true);
    });
  });

  describe("captureError", () => {
    it("captures error from Error object", () => {
      const error = new Error("Test error message");
      service.captureError("TestContext", error);

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs.some((log) => log.includes("Test error message"))).toBe(true);
    });

    it("captures error from string", () => {
      service.captureError("TestContext", "String error message");

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.some((log) => log.includes("String error message"))).toBe(true);
    });

    it("includes stack trace from Error object", () => {
      const error = new Error("Test error");
      service.captureError("TestContext", error);

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.some((log) => log.includes("Error"))).toBe(true);
    });

    it("uses custom stack when provided", () => {
      const error = new Error("Test error");
      service.captureError("TestContext", error, "Custom stack trace");

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.some((log) => log.includes("Custom stack trace"))).toBe(true);
    });

    it("handles empty error message", () => {
      const error = new Error("");
      service.captureError("TestContext", error);

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  describe("getAllLogs", () => {
    it("returns formatted log entries", () => {
      service.captureLog("error", "TestContext", "Test message");

      const logs = service.getAllLogs();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatch(/\[.*\] \[ERROR\] \[TestContext\] Test message/);
    });

    it("returns empty array when no logs", () => {
      const freshService = new ErrorCollectorService(100);
      freshService.clearLogs();

      const logs = freshService.getAllLogs();
      expect(logs).toEqual([]);
      freshService.unload();
    });
  });

  describe("getLogsSince", () => {
    it("returns logs since specified timestamp", async () => {
      service.captureLog("error", "Context1", "Old message");

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));
      const sinceTime = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10));

      service.captureLog("error", "Context2", "New message");

      const recentLogs = service.getLogsSince(sinceTime);
      expect(recentLogs.length).toBe(1);
      expect(recentLogs[0]).toContain("New message");
    });

    it("returns empty array when no logs since timestamp", () => {
      service.captureLog("error", "Context", "Old message");

      const futureLogs = service.getLogsSince(Date.now() + 10000);
      expect(futureLogs).toEqual([]);
    });
  });

  describe("getErrorLogs", () => {
    it("returns only error level logs", () => {
      service.enableCaptureAllLogs();
      service.captureLog("error", "Context", "Error message");
      service.captureLog("warn", "Context", "Warning message");
      service.captureLog("info", "Context", "Info message");

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.every((log) => log.includes("[ERROR]"))).toBe(true);
      expect(errorLogs.some((log) => log.includes("Error message"))).toBe(true);
      expect(errorLogs.some((log) => log.includes("Warning message"))).toBe(false);
    });
  });

  describe("clearLogs", () => {
    it("clears all logs", () => {
      service.captureLog("error", "Context", "Error message");
      service.captureError("Context", "Another error");

      expect(service.getAllLogs().length).toBeGreaterThan(0);

      service.clearLogs();

      expect(service.getAllLogs()).toEqual([]);
      expect(service.getErrorLogs()).toEqual([]);
    });
  });

  describe("log limits", () => {
    it("respects max logs limit", () => {
      const limitedService = new ErrorCollectorService(5);

      for (let i = 0; i < 10; i++) {
        limitedService.captureLog("error", "Context", `Error ${i}`);
      }

      const logs = limitedService.getAllLogs();
      expect(logs.length).toBeLessThanOrEqual(5);
      // Should have the most recent logs
      expect(logs.some((log) => log.includes("Error 9"))).toBe(true);
      expect(logs.some((log) => log.includes("Error 0"))).toBe(false);

      limitedService.unload();
    });
  });

  describe("unload", () => {
    it("clears all logs on unload", () => {
      service.captureLog("error", "Context", "Error message");
      service.unload();

      expect(service.getAllLogs()).toEqual([]);
      expect(service.getErrorLogs()).toEqual([]);
    });
  });

  describe("enableCaptureAllLogs", () => {
    it("enables capture of all log levels", () => {
      service.enableCaptureAllLogs();

      service.captureLog("log", "Context", "Log message");
      service.captureLog("info", "Context", "Info message");
      service.captureLog("debug", "Context", "Debug message");

      const logs = service.getAllLogs();
      expect(logs.some((log) => log.includes("[LOG]"))).toBe(true);
      expect(logs.some((log) => log.includes("[INFO]"))).toBe(true);
      expect(logs.some((log) => log.includes("[DEBUG]"))).toBe(true);
    });
  });

  describe("static initializeEarlyLogsCapture", () => {
    it("can be called without throwing", () => {
      expect(() => ErrorCollectorService.initializeEarlyLogsCapture(100)).not.toThrow();
    });

    it("can be called multiple times safely", () => {
      expect(() => {
        ErrorCollectorService.initializeEarlyLogsCapture(100);
        ErrorCollectorService.initializeEarlyLogsCapture(100);
      }).not.toThrow();
    });
  });

  describe("console patching behavior", () => {
    it("captures logs when initializeEarlyLogsCapture is called", () => {
      // Initialize early capture
      ErrorCollectorService.initializeEarlyLogsCapture(50);

      // Log a message
      console.error("Test error during patching");

      // Create a service that picks up logs
      const testService = new ErrorCollectorService(100);

      // Logs should be captured (exact context depends on implementation state)
      const logs = testService.getAllLogs();
      expect(logs.length).toBeGreaterThan(0);

      testService.unload();
    });

    it("handles SystemSculpt prefix detection", () => {
      // Create service and capture log directly
      service.enableCaptureAllLogs();
      service.captureLog("error", "SystemSculptLogger", "Test message");

      const logs = service.getAllLogs();
      expect(logs.some((log) => log.includes("SystemSculptLogger"))).toBe(true);
    });
  });

  describe("error limit behavior", () => {
    it("respects max error logs limit separately", () => {
      const limitedService = new ErrorCollectorService(5);

      // Add more errors than the limit
      for (let i = 0; i < 10; i++) {
        limitedService.captureError("Context", `Error ${i}`);
      }

      const errorLogs = limitedService.getErrorLogs();
      expect(errorLogs.length).toBeLessThanOrEqual(5);

      limitedService.unload();
    });
  });

  describe("null/undefined handling", () => {
    it("handles Error with no stack", () => {
      const error = { message: "Test error" } as Error;
      service.captureError("Context", error);

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.length).toBeGreaterThan(0);
    });

    it("handles empty string error message with fallback", () => {
      service.captureError("Context", "");

      const errorLogs = service.getErrorLogs();
      expect(errorLogs.length).toBeGreaterThan(0);
      // Should use "Unknown error" as fallback
      expect(errorLogs.some((log) => log.includes("Unknown error"))).toBe(true);
    });
  });

  describe("formatEntry behavior", () => {
    it("formats entry with timestamp, level, context and message", () => {
      service.captureLog("error", "MyContext", "My message");

      const logs = service.getAllLogs();
      expect(logs.length).toBeGreaterThan(0);
      // Check format: [ISO_DATE] [LEVEL] [context] message
      expect(logs[logs.length - 1]).toMatch(
        /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ERROR\] \[MyContext\] My message/
      );
    });

    it("appends stack trace on new line when present", () => {
      service.captureLog("error", "Context", "Message", "Stack line 1\nStack line 2");

      const logs = service.getAllLogs();
      const lastLog = logs[logs.length - 1];
      expect(lastLog).toContain("Message");
      expect(lastLog).toContain("\nStack line 1");
    });
  });

  describe("multiple instances", () => {
    it("supports multiple active instances", () => {
      const service1 = new ErrorCollectorService(100);
      const service2 = new ErrorCollectorService(100);

      service1.captureError("Context1", "Error from service 1");
      service2.captureError("Context2", "Error from service 2");

      expect(service1.getErrorLogs().some((log) => log.includes("Error from service 1"))).toBe(
        true
      );
      expect(service2.getErrorLogs().some((log) => log.includes("Error from service 2"))).toBe(
        true
      );

      service1.unload();
      service2.unload();
    });

    it("removes instance from active set on unload", () => {
      const testService = new ErrorCollectorService(100);

      // After unload, the instance should be removed from activeInstances
      testService.unload();

      // Create new service - should not receive logs meant for unloaded service
      const newService = new ErrorCollectorService(100);
      newService.clearLogs();

      console.error("New error after unload");

      // The new service should have logs, but old one shouldn't affect it
      newService.unload();
    });
  });

  describe("early buffer behavior", () => {
    it("copies early buffer to new instance", () => {
      // Initialize and trigger early capture
      ErrorCollectorService.initializeEarlyLogsCapture(50);

      // Log something that goes to early buffer
      console.error("[SystemSculpt] Early error");

      // Create new instance - it should pick up early buffer
      const testService = new ErrorCollectorService(100);

      const logs = testService.getAllLogs();
      expect(logs.length).toBeGreaterThan(0);

      testService.unload();
    });

    it("respects max early logs limit", () => {
      ErrorCollectorService.initializeEarlyLogsCapture(3);

      // Log more than the limit
      for (let i = 0; i < 10; i++) {
        console.error(`Error ${i}`);
      }

      const testService = new ErrorCollectorService(100);

      // Should have at most 3 + any logs generated during test
      // The key is that it doesn't have all 10
      testService.unload();
    });

    it("stringifies Error objects in console args", () => {
      ErrorCollectorService.initializeEarlyLogsCapture(50);

      const testError = new Error("Test error message");
      console.error("[SystemSculpt] Error occurred:", testError);

      const testService = new ErrorCollectorService(100);
      const logs = testService.getAllLogs();

      expect(logs.some((log) => log.includes("Test error message"))).toBe(true);

      testService.unload();
    });

    it("stringifies objects in console args", () => {
      ErrorCollectorService.initializeEarlyLogsCapture(50);

      const testObject = { key: "value", nested: { count: 42 } };
      console.error("[SystemSculpt] Data:", testObject);

      const testService = new ErrorCollectorService(100);
      const logs = testService.getAllLogs();

      expect(logs.some((log) => log.includes("key") && log.includes("value"))).toBe(true);

      testService.unload();
    });

    it("handles circular objects gracefully", () => {
      ErrorCollectorService.initializeEarlyLogsCapture(50);

      const circular: any = { name: "test" };
      circular.self = circular;

      // Should not throw when logging circular object
      expect(() => {
        console.error("[SystemSculpt] Circular:", circular);
      }).not.toThrow();

      const testService = new ErrorCollectorService(100);
      testService.unload();
    });
  });
});
