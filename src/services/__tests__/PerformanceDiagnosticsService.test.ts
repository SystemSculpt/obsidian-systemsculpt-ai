/**
 * @jest-environment jsdom
 */
import { PerformanceDiagnosticsService, OperationStat } from "../PerformanceDiagnosticsService";
import { FunctionProfiler, getFunctionProfiler } from "../FunctionProfiler";

// Mock FunctionProfiler
jest.mock("../FunctionProfiler", () => ({
  getFunctionProfiler: jest.fn().mockReturnValue({
    profileFunction: jest.fn((fn, name, module) => fn),
    addTraceCompleteListener: jest.fn(),
  }),
  FunctionProfiler: jest.fn(),
  FunctionTrace: {},
}));

describe("PerformanceDiagnosticsService", () => {
  let service: PerformanceDiagnosticsService;
  let mockPlugin: any;
  let mockLogger: any;
  let mockProfiler: any;
  let traceCompleteCallback: ((trace: any) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();

    traceCompleteCallback = null;

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockPlugin = {
      getLogger: jest.fn().mockReturnValue(mockLogger),
      storage: {
        appendToFile: jest.fn().mockResolvedValue(undefined),
      },
    };

    mockProfiler = {
      profileFunction: jest.fn((fn, name, module) => fn),
      addTraceCompleteListener: jest.fn((callback) => {
        traceCompleteCallback = callback;
      }),
    };

    (getFunctionProfiler as jest.Mock).mockReturnValue(mockProfiler);

    service = new PerformanceDiagnosticsService(mockPlugin);
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(PerformanceDiagnosticsService);
    });

    it("registers trace complete listener", () => {
      expect(mockProfiler.addTraceCompleteListener).toHaveBeenCalled();
    });

    it("uses default operations file name", () => {
      expect((service as any).operationsFileName).toBe("operations.ndjson");
    });

    it("accepts custom options", () => {
      const customService = new PerformanceDiagnosticsService(mockPlugin, {
        operationsFileName: "custom.ndjson",
        sessionId: "test-session",
        blockedModules: ["BlockedModule"],
      });

      expect((customService as any).operationsFileName).toBe("custom.ndjson");
      expect((customService as any).sessionId).toBe("test-session");
      expect((customService as any).blockedModules.has("BlockedModule")).toBe(true);
    });
  });

  describe("instrumentObject", () => {
    it("returns 0 for null instance", () => {
      const count = service.instrumentObject(null, "TestModule");

      expect(count).toBe(0);
    });

    it("returns 0 for non-object instance", () => {
      const count = service.instrumentObject("string" as any, "TestModule");

      expect(count).toBe(0);
    });

    it("returns 0 for blocked modules", () => {
      const blockedService = new PerformanceDiagnosticsService(mockPlugin, {
        blockedModules: ["BlockedModule"],
      });

      const instance = {
        testMethod: () => {},
      };

      const count = blockedService.instrumentObject(instance, "BlockedModule");

      expect(count).toBe(0);
    });

    it("instruments matching methods", () => {
      class TestClass {
        initializeSomething() {}
        processData() {}
        handleEvent() {}
        regularMethod() {}
      }

      const instance = new TestClass();

      const count = service.instrumentObject(instance, "TestModule", {
        includePrefixes: ["initialize", "process", "handle"],
      });

      expect(count).toBeGreaterThan(0);
    });

    it("excludes specified methods", () => {
      class TestClass {
        initializeA() {}
        initializeB() {}
        getterMethod() {}
      }

      const instance = new TestClass();

      const count = service.instrumentObject(instance, "TestModule", {
        includePrefixes: ["initialize", "getter"],
        exclude: ["getterMethod"],
      });

      // Should only instrument initialize methods, not getter
      expect(count).toBe(2);
    });

    it("skips already instrumented prototypes", () => {
      class TestClass {
        initializeMethod() {}
      }

      const instance1 = new TestClass();
      const instance2 = new TestClass();

      const count1 = service.instrumentObject(instance1, "TestModule", {
        includePrefixes: ["initialize"],
      });

      const count2 = service.instrumentObject(instance2, "TestModule", {
        includePrefixes: ["initialize"],
      });

      expect(count1).toBe(1);
      expect(count2).toBe(0); // Already instrumented
    });

    it("logs instrumentation", () => {
      class TestClass {
        initializeMethod() {}
      }

      const instance = new TestClass();

      service.instrumentObject(instance, "TestModule", {
        includePrefixes: ["initialize"],
      });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Performance instrumentation applied",
        expect.objectContaining({
          source: "PerformanceDiagnostics",
        })
      );
    });
  });

  describe("instrumentPluginLifecycle", () => {
    it("instruments plugin methods", () => {
      const instrumentSpy = jest.spyOn(service, "instrumentObject");

      service.instrumentPluginLifecycle(mockPlugin);

      expect(instrumentSpy).toHaveBeenCalledWith(
        mockPlugin,
        "SystemSculptPlugin",
        expect.objectContaining({
          includePrefixes: expect.arrayContaining(["initialize", "run", "register"]),
        })
      );
    });
  });

  describe("profileFunction", () => {
    it("delegates to profiler", () => {
      const fn = () => "result";

      service.profileFunction(fn, "TestModule", "testFunc");

      expect(mockProfiler.profileFunction).toHaveBeenCalledWith(
        fn,
        "testFunc",
        "TestModule"
      );
    });
  });

  describe("getHotspots", () => {
    it("returns empty array when no stats", () => {
      const hotspots = service.getHotspots();

      expect(hotspots).toEqual([]);
    });

    it("returns stats sorted by duration", () => {
      // Manually add stats
      const stats = (service as any).stats;
      stats.set("slow", {
        key: "slow",
        module: "TestModule",
        name: "slowMethod",
        count: 1,
        totalDuration: 1000,
        totalMemoryDelta: 100,
        maxDuration: 1000,
        maxMemoryDelta: 100,
        lastTimestamp: Date.now(),
      });
      stats.set("fast", {
        key: "fast",
        module: "TestModule",
        name: "fastMethod",
        count: 1,
        totalDuration: 10,
        totalMemoryDelta: 50,
        maxDuration: 10,
        maxMemoryDelta: 50,
        lastTimestamp: Date.now(),
      });

      const hotspots = service.getHotspots(10, "duration");

      expect(hotspots[0].name).toBe("slowMethod");
      expect(hotspots[1].name).toBe("fastMethod");
    });

    it("returns stats sorted by memory when specified", () => {
      const stats = (service as any).stats;
      stats.set("lowMem", {
        key: "lowMem",
        module: "TestModule",
        name: "lowMemMethod",
        count: 1,
        totalDuration: 1000,
        totalMemoryDelta: 10,
        maxDuration: 1000,
        maxMemoryDelta: 10,
        lastTimestamp: Date.now(),
      });
      stats.set("highMem", {
        key: "highMem",
        module: "TestModule",
        name: "highMemMethod",
        count: 1,
        totalDuration: 10,
        totalMemoryDelta: 1000,
        maxDuration: 10,
        maxMemoryDelta: 1000,
        lastTimestamp: Date.now(),
      });

      const hotspots = service.getHotspots(10, "memory");

      expect(hotspots[0].name).toBe("highMemMethod");
      expect(hotspots[1].name).toBe("lowMemMethod");
    });

    it("respects limit parameter", () => {
      const stats = (service as any).stats;
      for (let i = 0; i < 20; i++) {
        stats.set(`stat${i}`, {
          key: `stat${i}`,
          module: "TestModule",
          name: `method${i}`,
          count: 1,
          totalDuration: i * 10,
          totalMemoryDelta: 0,
          maxDuration: i * 10,
          maxMemoryDelta: 0,
          lastTimestamp: Date.now(),
        });
      }

      const hotspots = service.getHotspots(5);

      expect(hotspots.length).toBe(5);
    });
  });

  describe("buildHotspotReport", () => {
    it("returns message when no hotspots", () => {
      const report = service.buildHotspotReport();

      expect(report).toContain("No profiled functions yet");
    });

    it("builds report from hotspots", () => {
      const stats = (service as any).stats;
      stats.set("test", {
        key: "test",
        module: "TestModule",
        name: "testMethod",
        count: 5,
        totalDuration: 100,
        totalMemoryDelta: 50,
        maxDuration: 30,
        maxMemoryDelta: 15,
        lastTimestamp: Date.now(),
      });

      const report = service.buildHotspotReport();

      expect(report).toContain("Performance hotspots");
      expect(report).toContain("TestModule.testMethod");
    });

    it("includes average calculations", () => {
      const stats = (service as any).stats;
      stats.set("test", {
        key: "test",
        module: "TestModule",
        name: "testMethod",
        count: 4,
        totalDuration: 100,
        totalMemoryDelta: 40,
        maxDuration: 40,
        maxMemoryDelta: 20,
        lastTimestamp: Date.now(),
      });

      const report = service.buildHotspotReport();

      // Average should be 100/4 = 25ms
      expect(report).toContain("avg");
    });
  });

  describe("shouldInclude", () => {
    it("includes methods with matching prefixes", () => {
      const result = (service as any).shouldInclude("initializeService", {
        includePrefixes: ["initialize"],
      });

      expect(result).toBe(true);
    });

    it("excludes methods in exclude list", () => {
      const result = (service as any).shouldInclude("getterMethod", {
        includePrefixes: ["get"],
        exclude: ["getterMethod"],
      });

      expect(result).toBe(false);
    });

    it("includes methods matching regex", () => {
      const result = (service as any).shouldInclude("handleUserEvent", {
        includeMatches: /^handle.*Event$/,
      });

      expect(result).toBe(true);
    });

    it("includes methods in include list", () => {
      const result = (service as any).shouldInclude("specificMethod", {
        include: ["specificMethod", "otherMethod"],
      });

      expect(result).toBe(true);
    });

    it("returns false when no match", () => {
      const result = (service as any).shouldInclude("randomMethod", {
        includePrefixes: ["initialize"],
        include: ["specificMethod"],
      });

      expect(result).toBe(false);
    });

    it("handles undefined options", () => {
      // When options is undefined, behavior depends on implementation
      const result = (service as any).shouldInclude("method", undefined);

      // Just verify it returns a boolean
      expect(typeof result).toBe("boolean");
    });
  });

  describe("handleTraceComplete", () => {
    it("callback is registered", () => {
      // Verify the listener was registered
      expect(mockProfiler.addTraceCompleteListener).toHaveBeenCalled();
      expect(traceCompleteCallback).toBeDefined();
    });

    it("handleTraceComplete method exists", () => {
      expect((service as any).handleTraceComplete).toBeDefined();
      expect(typeof (service as any).handleTraceComplete).toBe("function");
    });

    it("handles trace with all required fields", () => {
      const trace = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
        memoryDelta: 1024,
        timestamp: Date.now(),
      };

      // Call handleTraceComplete directly
      expect(() => (service as any).handleTraceComplete(trace)).not.toThrow();
    });

    it("ignores trace without duration", () => {
      const trace = {
        module: "TestModule",
        name: "testMethod",
      };

      (service as any).handleTraceComplete(trace);

      expect((service as any).stats.size).toBe(0);
    });

    it("creates new stat entry for new trace", () => {
      const trace = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
      };

      (service as any).handleTraceComplete(trace);

      expect((service as any).stats.has("TestModule.testMethod")).toBe(true);
    });

    it("updates existing stat entry", () => {
      const trace1 = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
        memoryDelta: 1024,
      };
      const trace2 = {
        module: "TestModule",
        name: "testMethod",
        duration: 100,
        memoryDelta: 2048,
      };

      (service as any).handleTraceComplete(trace1);
      (service as any).handleTraceComplete(trace2);

      const stat = (service as any).stats.get("TestModule.testMethod");
      expect(stat.count).toBe(2);
      expect(stat.totalDuration).toBe(150);
      expect(stat.maxDuration).toBe(100);
    });

    it("tracks max memory delta", () => {
      const trace1 = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
        memoryDelta: 5000,
      };
      const trace2 = {
        module: "TestModule",
        name: "testMethod",
        duration: 100,
        memoryDelta: 1000,
      };

      (service as any).handleTraceComplete(trace1);
      (service as any).handleTraceComplete(trace2);

      const stat = (service as any).stats.get("TestModule.testMethod");
      expect(stat.maxMemoryDelta).toBe(5000);
    });
  });

  describe("persistTrace (private)", () => {
    it("does nothing when storage is not available", async () => {
      mockPlugin.storage = null;
      const localService = new PerformanceDiagnosticsService(mockPlugin);
      const trace = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
      };

      await expect((localService as any).persistTrace(trace)).resolves.not.toThrow();
    });

    it("skips if already persisting", async () => {
      (service as any).isPersistingTrace = true;
      const trace = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
      };

      await (service as any).persistTrace(trace);

      expect(mockPlugin.storage.appendToFile).not.toHaveBeenCalled();
    });

    it("writes to operations file", async () => {
      const trace = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
        memoryDelta: 1024,
      };

      await (service as any).persistTrace(trace);

      expect(mockPlugin.storage.appendToFile).toHaveBeenCalledWith(
        "diagnostics",
        "operations.ndjson",
        expect.any(String)
      );
    });

    it("writes to session file when sessionId is set", async () => {
      const sessionService = new PerformanceDiagnosticsService(mockPlugin, {
        sessionId: "test-session",
      });

      const trace = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
      };

      await (sessionService as any).persistTrace(trace);

      expect(mockPlugin.storage.appendToFile).toHaveBeenCalledWith(
        "diagnostics",
        "operations-test-session.ndjson",
        expect.any(String)
      );
    });

    it("handles write errors gracefully", async () => {
      mockPlugin.storage.appendToFile.mockRejectedValueOnce(new Error("Write failed"));
      const trace = {
        module: "TestModule",
        name: "testMethod",
        duration: 50,
      };

      await expect((service as any).persistTrace(trace)).resolves.not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe("exportHotspotReport", () => {
    it("returns report without storage", async () => {
      mockPlugin.storage = null;
      const localService = new PerformanceDiagnosticsService(mockPlugin);

      const result = await localService.exportHotspotReport();

      expect(result.text).toBeDefined();
      expect(result.path).toBeUndefined();
    });

    it("writes report to storage", async () => {
      mockPlugin.storage = {
        appendToFile: jest.fn().mockResolvedValue(undefined),
        writeFile: jest.fn().mockResolvedValue({ success: true, path: "diagnostics/report.txt" }),
      };

      const result = await service.exportHotspotReport();

      expect(mockPlugin.storage.writeFile).toHaveBeenCalled();
      expect(result.path).toBe("diagnostics/report.txt");
    });

    it("handles storage write failure", async () => {
      mockPlugin.storage = {
        appendToFile: jest.fn().mockResolvedValue(undefined),
        writeFile: jest.fn().mockResolvedValue({ success: false }),
      };

      const result = await service.exportHotspotReport();

      expect(result.path).toBeUndefined();
    });
  });

  describe("shouldInclude edge cases", () => {
    it("returns true when no include options specified", () => {
      const result = (service as any).shouldInclude("anyMethod", {
        exclude: ["otherMethod"],
      });

      expect(result).toBe(true);
    });

    it("exclude takes precedence over include", () => {
      const result = (service as any).shouldInclude("testMethod", {
        include: ["testMethod"],
        exclude: ["test"],
      });

      expect(result).toBe(false);
    });
  });

  describe("instrumentObject edge cases", () => {
    it("returns 0 when prototype is null", () => {
      const instance = Object.create(null);

      const count = service.instrumentObject(instance, "TestModule");

      expect(count).toBe(0);
    });

    it("skips constructor property", () => {
      class TestClass {
        constructor() {}
        initialize() {}
      }

      const instance = new TestClass();
      const count = service.instrumentObject(instance, "TestModule", {
        includePrefixes: ["initialize", "constructor"],
      });

      // Should only instrument initialize, not constructor
      expect(count).toBe(1);
    });

    it("skips non-function properties", () => {
      class TestClass {
        initializeValue = 42;
        initializeMethod() {}
      }

      const instance = new TestClass();
      const count = service.instrumentObject(instance, "TestModule", {
        includePrefixes: ["initialize"],
      });

      expect(count).toBe(1);
    });
  });
});
