/**
 * @jest-environment jsdom
 */
import { ResourceMonitorService, ResourceSample } from "../ResourceMonitorService";

// Mock the main plugin
jest.mock("../../main", () => {
  return class MockPlugin {
    getLogger() {
      return {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
    }
    storage = {
      appendToFile: jest.fn().mockResolvedValue(undefined),
    };
  };
});

describe("ResourceMonitorService", () => {
  let service: ResourceMonitorService;
  let mockPlugin: any;
  let mockLogger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

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

    service = new ResourceMonitorService(mockPlugin);
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(ResourceMonitorService);
    });

    it("accepts custom options", () => {
      const customService = new ResourceMonitorService(mockPlugin, {
        intervalMs: 30000,
        metricsFileName: "custom-metrics.ndjson",
        sessionId: "test-session",
      });

      expect(customService).toBeInstanceOf(ResourceMonitorService);
      expect((customService as any).samplingIntervalMs).toBe(30000);
      expect((customService as any).metricsFileName).toBe("custom-metrics.ndjson");
      expect((customService as any).sessionId).toBe("test-session");
    });

    it("uses default interval when not specified", () => {
      expect((service as any).samplingIntervalMs).toBe(15000);
    });
  });

  describe("start", () => {
    it("starts resource monitoring", () => {
      service.start();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Resource monitor starting",
        expect.objectContaining({
          source: "ResourceMonitor",
        })
      );
    });

    it("collects initial sample on startup", () => {
      service.start();

      const samples = service.getRecentSamples();
      expect(samples.length).toBeGreaterThan(0);
      expect(samples[0].note).toBe("startup");
    });

    it("does not restart if already running", () => {
      service.start();
      const firstIntervalId = (service as any).intervalId;

      service.start();
      const secondIntervalId = (service as any).intervalId;

      expect(firstIntervalId).toBe(secondIntervalId);
    });

    it("sets up interval for periodic sampling", () => {
      service.start();

      expect((service as any).intervalId).not.toBeNull();
    });
  });

  describe("stop", () => {
    it("stops resource monitoring", () => {
      service.start();
      service.stop();

      expect((service as any).intervalId).toBeNull();
    });

    it("clears lag interval", () => {
      service.start();
      service.stop();

      expect((service as any).lagIntervalId).toBeNull();
    });

    it("clears startup burst interval", () => {
      service.start();
      service.stop();

      expect((service as any).startupBurstIntervalId).toBeNull();
    });

    it("handles stop when not started", () => {
      // Should not throw
      expect(() => service.stop()).not.toThrow();
    });
  });

  describe("captureManualSample", () => {
    it("captures sample with custom note", async () => {
      const sample = await service.captureManualSample("test-note");

      expect(sample).toBeDefined();
      expect(sample.note).toBe("test-note");
    });

    it("uses default note when not specified", async () => {
      const sample = await service.captureManualSample();

      expect(sample.note).toBe("manual");
    });

    it("includes timestamp", async () => {
      const sample = await service.captureManualSample();

      expect(sample.timestamp).toBeDefined();
      expect(sample.iso).toBeDefined();
    });
  });

  describe("getRecentSamples", () => {
    it("returns empty array when no samples", () => {
      const samples = service.getRecentSamples();

      expect(samples).toEqual([]);
    });

    it("returns recent samples", async () => {
      await service.captureManualSample("sample1");
      await service.captureManualSample("sample2");
      await service.captureManualSample("sample3");

      const samples = service.getRecentSamples(2);

      expect(samples.length).toBe(2);
      expect(samples[0].note).toBe("sample2");
      expect(samples[1].note).toBe("sample3");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 20; i++) {
        await service.captureManualSample(`sample${i}`);
      }

      const samples = service.getRecentSamples(5);

      expect(samples.length).toBe(5);
    });
  });

  describe("buildSummary", () => {
    it("returns message when no samples", () => {
      const summary = service.buildSummary();

      expect(summary).toBe("No resource samples available yet.");
    });

    it("builds summary from recent samples", async () => {
      await service.captureManualSample("test");

      const summary = service.buildSummary();

      expect(summary).not.toBe("No resource samples available yet.");
    });

    it("respects lines parameter", async () => {
      for (let i = 0; i < 20; i++) {
        await service.captureManualSample(`sample${i}`);
      }

      const summary = service.buildSummary(3);
      const lines = summary.split("\n");

      expect(lines.length).toBeLessThanOrEqual(3);
    });
  });

  describe("sample data collection", () => {
    it("includes heap information when available", async () => {
      // Mock performance.memory for browsers that support it
      const originalPerformance = global.performance;
      (global as any).performance = {
        ...originalPerformance,
        memory: {
          usedJSHeapSize: 50 * 1024 * 1024, // 50 MB
          totalJSHeapSize: 100 * 1024 * 1024, // 100 MB
          jsHeapSizeLimit: 200 * 1024 * 1024, // 200 MB
        },
      };

      const sample = await service.captureManualSample();

      // Restore
      global.performance = originalPerformance;

      // Sample should have been captured
      expect(sample).toBeDefined();
    });

    it("handles missing performance.memory gracefully", async () => {
      const sample = await service.captureManualSample();

      // Should not throw and should return valid sample
      expect(sample).toBeDefined();
      expect(sample.timestamp).toBeDefined();
    });
  });

  describe("sample buffer limits", () => {
    it("respects maxSamples limit", async () => {
      const maxSamples = (service as any).maxSamples;

      for (let i = 0; i < maxSamples + 50; i++) {
        await service.captureManualSample(`sample${i}`);
      }

      const samples = (service as any).samples;
      expect(samples.length).toBeLessThanOrEqual(maxSamples);
    });
  });

  describe("ResourceSample interface", () => {
    it("sample has required fields", async () => {
      const sample = await service.captureManualSample();

      expect(sample.timestamp).toEqual(expect.any(Number));
      expect(sample.iso).toEqual(expect.any(String));
    });

    it("sample may have optional fields", async () => {
      const sample = await service.captureManualSample();

      // These are optional and may or may not be present
      expect(
        sample.heapUsedMB === undefined || typeof sample.heapUsedMB === "number"
      ).toBe(true);
      expect(
        sample.heapLimitMB === undefined || typeof sample.heapLimitMB === "number"
      ).toBe(true);
      expect(sample.cpuPercent === undefined || typeof sample.cpuPercent === "number").toBe(
        true
      );
    });
  });

  describe("exportSummaryReport", () => {
    it("returns summary when storage is not available", async () => {
      mockPlugin.storage = null;
      const localService = new ResourceMonitorService(mockPlugin);
      await localService.captureManualSample("test");

      const result = await localService.exportSummaryReport();

      expect(result.summary).toBeDefined();
      expect(result.path).toBeUndefined();
    });

    it("writes to storage when available", async () => {
      mockPlugin.storage = {
        appendToFile: jest.fn().mockResolvedValue(undefined),
        writeFile: jest.fn().mockResolvedValue({ success: true, path: "diagnostics/report.txt" }),
      };
      const localService = new ResourceMonitorService(mockPlugin);
      await localService.captureManualSample("test");

      const result = await localService.exportSummaryReport();

      expect(mockPlugin.storage.writeFile).toHaveBeenCalled();
      expect(result.path).toBe("diagnostics/report.txt");
    });

    it("handles storage write failure", async () => {
      mockPlugin.storage = {
        appendToFile: jest.fn().mockResolvedValue(undefined),
        writeFile: jest.fn().mockResolvedValue({ success: false }),
      };
      const localService = new ResourceMonitorService(mockPlugin);
      await localService.captureManualSample("test");

      const result = await localService.exportSummaryReport();

      expect(result.path).toBeUndefined();
    });
  });

  describe("checkThresholds (private)", () => {
    it("logs warning when heap usage exceeds 85%", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        heapUsedMB: 180,
        heapLimitMB: 200,
        note: "test",
      };

      (service as any).checkThresholds(sample);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "High heap usage detected",
        expect.objectContaining({
          source: "ResourceMonitor",
        })
      );
    });

    it("logs warning when CPU exceeds 85%", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        cpuPercent: 90,
        note: "test",
      };

      (service as any).checkThresholds(sample);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Sustained CPU usage detected",
        expect.objectContaining({
          source: "ResourceMonitor",
        })
      );
    });

    it("logs warning when event loop lag exceeds threshold", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        eventLoopLagMs: 300,
        note: "test",
      };

      (service as any).checkThresholds(sample);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Event loop lag detected",
        expect.objectContaining({
          source: "ResourceMonitor",
        })
      );
    });

    it("logs warning when freeze spike exceeds threshold", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        freezeDeltaMs: 1000,
        note: "test",
      };

      (service as any).checkThresholds(sample);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Freeze spike reported",
        expect.objectContaining({
          source: "ResourceMonitor",
        })
      );
    });
  });

  describe("shouldAlert (private)", () => {
    it("returns true for first alert", () => {
      const result = (service as any).shouldAlert("memory", Date.now());
      expect(result).toBe(true);
    });

    it("returns false if cooldown not elapsed", () => {
      const now = Date.now();
      (service as any).shouldAlert("memory", now);

      const result = (service as any).shouldAlert("memory", now + 1000);
      expect(result).toBe(false);
    });

    it("returns true after cooldown elapsed", () => {
      const now = Date.now();
      (service as any).shouldAlert("memory", now);

      // Memory cooldown is 60_000
      const result = (service as any).shouldAlert("memory", now + 60_001);
      expect(result).toBe(true);
    });
  });

  describe("writeSample (private)", () => {
    it("does nothing when storage is not available", async () => {
      mockPlugin.storage = null;
      const localService = new ResourceMonitorService(mockPlugin);
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
      };

      await expect((localService as any).writeSample(sample)).resolves.not.toThrow();
    });

    it("handles write errors gracefully", async () => {
      mockPlugin.storage = {
        appendToFile: jest.fn().mockRejectedValue(new Error("Write failed")),
      };
      const localService = new ResourceMonitorService(mockPlugin);
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
      };

      await expect((localService as any).writeSample(sample)).resolves.not.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("buildSummary formatting", () => {
    it("includes heap percentage when limit is available", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        heapUsedMB: 100,
        heapLimitMB: 200,
      };
      (service as any).samples.push(sample);

      const summary = service.buildSummary();

      expect(summary).toContain("Heap");
      expect(summary).toContain("%");
    });

    it("includes RSS when available", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        rssMB: 150,
      };
      (service as any).samples.push(sample);

      const summary = service.buildSummary();

      expect(summary).toContain("RSS");
    });

    it("includes CPU when available", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        cpuPercent: 45,
      };
      (service as any).samples.push(sample);

      const summary = service.buildSummary();

      expect(summary).toContain("CPU");
    });

    it("includes lag when available", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        eventLoopLagMs: 50,
      };
      (service as any).samples.push(sample);

      const summary = service.buildSummary();

      expect(summary).toContain("Lag");
    });

    it("includes freeze delta when available", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        freezeDeltaMs: 500,
      };
      (service as any).samples.push(sample);

      const summary = service.buildSummary();

      expect(summary).toContain("Freeze spike");
    });

    it("includes note when available", async () => {
      const sample: ResourceSample = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        note: "test-note",
      };
      (service as any).samples.push(sample);

      const summary = service.buildSummary();

      expect(summary).toContain("[test-note]");
    });
  });

  describe("readMemoryUsage (private)", () => {
    it("returns empty object when no memory APIs available", () => {
      const result = (service as any).readMemoryUsage();
      expect(result).toBeDefined();
    });
  });

  describe("captureCpuPercent (private)", () => {
    it("returns undefined when process not available", () => {
      const originalProcess = global.process;
      // @ts-ignore
      delete global.process;

      const result = (service as any).captureCpuPercent(Date.now());

      global.process = originalProcess;
      expect(result).toBeUndefined();
    });
  });

  describe("subscribeToFreezeEvents (private)", () => {
    it("handles freeze events", () => {
      service.start();

      const event = new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 500 },
      });
      window.dispatchEvent(event);

      const samples = service.getRecentSamples();
      const freezeSample = samples.find(s => s.note === "freeze");
      expect(freezeSample).toBeDefined();
      expect(freezeSample?.freezeDeltaMs).toBe(500);
    });
  });

  describe("startStartupBurstSampling (private)", () => {
    it("starts burst sampling interval", () => {
      service.start();
      expect((service as any).startupBurstIntervalId).not.toBeNull();
    });

    it("collects burst samples during startup", () => {
      service.start();
      const initialSampleCount = (service as any).samples.length;

      // Advance by burst interval
      jest.advanceTimersByTime(3000);

      expect((service as any).samples.length).toBeGreaterThan(initialSampleCount);
    });
  });
});
