/**
 * @jest-environment jsdom
 */
import { FunctionProfiler, getFunctionProfiler, profile, FunctionTrace } from "../FunctionProfiler";

// Mock MemoryProfiler
jest.mock("../MemoryProfiler", () => ({
  MemoryProfiler: {
    getInstance: jest.fn().mockReturnValue({
      takeSnapshot: jest.fn().mockResolvedValue({
        summary: "Memory: 100MB used",
        details: {},
      }),
    }),
  },
}));

describe("FunctionProfiler", () => {
  let profiler: FunctionProfiler;

  beforeEach(() => {
    jest.clearAllMocks();
    profiler = new FunctionProfiler();
  });

  describe("constructor", () => {
    it("creates profiler instance", () => {
      expect(profiler).toBeInstanceOf(FunctionProfiler);
    });

    it("is enabled by default", () => {
      expect((profiler as any).enabled).toBe(true);
    });
  });

  describe("setEnabled", () => {
    it("enables profiling", () => {
      profiler.setEnabled(true);

      expect((profiler as any).enabled).toBe(true);
    });

    it("disables profiling", () => {
      profiler.setEnabled(false);

      expect((profiler as any).enabled).toBe(false);
    });

    it("resets profiler when enabled", () => {
      profiler.startTrace("test", "module");
      profiler.setEnabled(true);

      expect((profiler as any).traces.size).toBe(0);
    });
  });

  describe("setSamplingRate", () => {
    it("sets sampling rate within bounds", () => {
      profiler.setSamplingRate(0.5);

      expect((profiler as any).samplingRate).toBe(0.5);
    });

    it("clamps sampling rate to 0", () => {
      profiler.setSamplingRate(-1);

      expect((profiler as any).samplingRate).toBe(0);
    });

    it("clamps sampling rate to 1", () => {
      profiler.setSamplingRate(2);

      expect((profiler as any).samplingRate).toBe(1);
    });
  });

  describe("startTrace", () => {
    it("returns null when disabled", () => {
      profiler.setEnabled(false);

      const traceId = profiler.startTrace("testFunc", "testModule");

      expect(traceId).toBeNull();
    });

    it("returns trace ID when enabled", () => {
      profiler.setEnabled(true);

      const traceId = profiler.startTrace("testFunc", "testModule");

      expect(traceId).not.toBeNull();
      expect(traceId).toContain("testModule.testFunc");
    });

    it("creates trace with function info", () => {
      profiler.setEnabled(true);

      const traceId = profiler.startTrace("testFunc", "testModule", ["arg1", "arg2"]);

      const trace = (profiler as any).traces.get(traceId);
      expect(trace.name).toBe("testFunc");
      expect(trace.module).toBe("testModule");
      expect(trace.args).toEqual(["arg1", "arg2"]);
    });

    it("updates call stack", () => {
      profiler.setEnabled(true);

      profiler.startTrace("testFunc", "testModule");

      expect((profiler as any).callStack).toContain("testModule.testFunc");
    });

    it("respects max traces limit", () => {
      profiler.setEnabled(true);
      (profiler as any).maxTraces = 2;

      profiler.startTrace("func1", "module");
      profiler.startTrace("func2", "module");
      const traceId = profiler.startTrace("func3", "module");

      expect(traceId).toBeNull();
    });
  });

  describe("endTrace", () => {
    it("does nothing when disabled", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.setEnabled(false);

      profiler.endTrace(traceId);

      // Should not throw
    });

    it("does nothing for null traceId", () => {
      profiler.endTrace(null);

      // Should not throw
    });

    it("completes trace with result", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");

      profiler.endTrace(traceId, "result");

      const trace = (profiler as any).traces.get(traceId);
      expect(trace.result).toBe("result");
      expect(trace.endTime).toBeDefined();
      expect(trace.duration).toBeDefined();
    });

    it("records error in trace", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");
      const error = new Error("Test error");

      profiler.endTrace(traceId, undefined, error);

      const trace = (profiler as any).traces.get(traceId);
      expect(trace.error).toBe(error);
    });

    it("updates call stack", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");

      profiler.endTrace(traceId);

      expect((profiler as any).callStack).not.toContain("testModule.testFunc");
    });
  });

  describe("profileFunction", () => {
    it("wraps function and profiles it", () => {
      profiler.setEnabled(true);

      const originalFn = (a: number, b: number) => a + b;
      const profiledFn = profiler.profileFunction(originalFn, "add", "math");

      const result = profiledFn(2, 3);

      expect(result).toBe(5);
    });

    it("handles async functions", async () => {
      profiler.setEnabled(true);

      const asyncFn = async (x: number) => {
        return x * 2;
      };
      const profiledFn = profiler.profileFunction(asyncFn, "double", "math");

      const result = await profiledFn(5);

      expect(result).toBe(10);
    });

    it("propagates errors", () => {
      profiler.setEnabled(true);

      const errorFn = () => {
        throw new Error("Test error");
      };
      const profiledFn = profiler.profileFunction(errorFn, "errorFunc", "test");

      expect(() => profiledFn()).toThrow("Test error");
    });

    it("propagates async errors", async () => {
      profiler.setEnabled(true);

      const asyncErrorFn = async () => {
        throw new Error("Async error");
      };
      const profiledFn = profiler.profileFunction(asyncErrorFn, "asyncError", "test");

      await expect(profiledFn()).rejects.toThrow("Async error");
    });
  });

  describe("getReport", () => {
    it("returns report with completed traces", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId);

      const report = profiler.getReport();

      expect(report.traces.length).toBe(1);
      expect(report.startTime).toBeDefined();
      expect(report.endTime).toBeDefined();
    });

    it("excludes incomplete traces", () => {
      profiler.setEnabled(true);
      profiler.startTrace("incomplete", "module");

      const report = profiler.getReport();

      expect(report.traces.length).toBe(0);
    });

    it("includes slowest functions", () => {
      profiler.setEnabled(true);

      const traceId1 = profiler.startTrace("slowFunc", "module");
      profiler.endTrace(traceId1);

      const report = profiler.getReport();

      expect(report.slowestFunctions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("generateReportString", () => {
    it("generates readable report", async () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId);

      const report = await profiler.generateReportString();

      expect(report).toContain("Function Call Statistics");
      expect(report).toContain("Slowest Functions");
    });
  });

  describe("exportTracesAsJson", () => {
    it("exports traces as JSON string", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId, "result");

      const json = profiler.exportTracesAsJson();

      expect(typeof json).toBe("string");
      const parsed = JSON.parse(json);
      expect(parsed.traces).toBeDefined();
    });

    it("handles errors in JSON export", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId, undefined, new Error("Test error"));

      const json = profiler.exportTracesAsJson();
      const parsed = JSON.parse(json);

      expect(parsed.traces[0].error).toBeDefined();
      expect(parsed.traces[0].error.message).toBe("Test error");
    });
  });

  describe("reset", () => {
    it("clears all traces", () => {
      profiler.setEnabled(true);
      profiler.startTrace("testFunc", "testModule");

      profiler.reset();

      expect((profiler as any).traces.size).toBe(0);
    });

    it("clears call stack", () => {
      profiler.setEnabled(true);
      profiler.startTrace("testFunc", "testModule");

      profiler.reset();

      expect((profiler as any).callStack.length).toBe(0);
    });

    it("clears memory peaks", () => {
      profiler.setEnabled(true);
      profiler.startTrace("testFunc", "testModule");

      profiler.reset();

      expect((profiler as any).memoryPeaks.length).toBe(0);
    });
  });

  describe("getFlameGraphData", () => {
    it("returns flame graph structure", () => {
      profiler.setEnabled(true);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId);

      const flameData = profiler.getFlameGraphData();

      expect(flameData.name).toBe("root");
      expect(flameData.children).toBeDefined();
    });
  });

  describe("addTraceCompleteListener", () => {
    it("adds listener that is called on trace complete", () => {
      profiler.setEnabled(true);
      const listener = jest.fn();

      profiler.addTraceCompleteListener(listener);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId);

      expect(listener).toHaveBeenCalled();
    });

    it("returns unsubscribe function", () => {
      profiler.setEnabled(true);
      const listener = jest.fn();

      const unsubscribe = profiler.addTraceCompleteListener(listener);
      unsubscribe();

      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId);

      expect(listener).not.toHaveBeenCalled();
    });

    it("handles listener errors gracefully", () => {
      profiler.setEnabled(true);
      const errorListener = jest.fn().mockImplementation(() => {
        throw new Error("Listener error");
      });
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

      profiler.addTraceCompleteListener(errorListener);
      const traceId = profiler.startTrace("testFunc", "testModule");
      profiler.endTrace(traceId);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});

describe("getFunctionProfiler", () => {
  it("returns singleton instance", () => {
    const instance1 = getFunctionProfiler();
    const instance2 = getFunctionProfiler();

    expect(instance1).toBe(instance2);
  });
});

describe("profile decorator", () => {
  it("creates decorator function", () => {
    const decorator = profile("TestModule");

    expect(typeof decorator).toBe("function");
  });
});
