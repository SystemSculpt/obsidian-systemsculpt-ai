/**
 * @jest-environment jsdom
 */
import {
  projectIncidentResourceSample,
  ResourceMonitorService,
  ResourceSample,
} from "../ResourceMonitorService";

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

  describe("captureIncidentTerminalSample", () => {
    it("returns an allowlisted sample synchronously and uses the fixed terminal note", () => {
      const pendingWrite = new Promise(() => undefined);
      mockPlugin.storage.appendToFile.mockReturnValue(pendingWrite);

      const sample = (service.captureIncidentTerminalSample as any)("private-caller-note");

      expect(sample.captured_at).toEqual(expect.any(String));
      expect(sample).not.toHaveProperty("note");
      expect(JSON.stringify(sample)).not.toContain("private-caller-note");
      expect(service.getRecentSamples(1)[0].note).toBe("incident-terminal");
      expect(mockPlugin.storage.appendToFile).toHaveBeenCalledTimes(1);
    });

    it("keeps a rejected diagnostics write observational", async () => {
      mockPlugin.storage.appendToFile.mockRejectedValue(new Error("private-storage-failure"));

      expect(() => service.captureIncidentTerminalSample()).not.toThrow();
      expect(service.getRecentSamples(1)).toHaveLength(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to write resource metrics",
        expect.any(Error),
        expect.objectContaining({ source: "ResourceMonitor" }),
      );
    });

    it("keeps a rejected storage result observational", async () => {
      mockPlugin.storage.appendToFile.mockResolvedValue({
        success: false,
        error: "private-storage-failure",
      });

      const sample = service.captureIncidentTerminalSample();
      await Promise.resolve();
      await Promise.resolve();

      expect(sample.captured_at).toEqual(expect.any(String));
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to write resource metrics",
        undefined,
        expect.objectContaining({ source: "ResourceMonitor" }),
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain("private-storage-failure");
    });

    it("does not emit an unhandled rejection when storage and diagnostics logging fail", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      mockPlugin.storage.appendToFile.mockRejectedValue(
        new Error("private-storage-failure"),
      );
      mockLogger.error.mockImplementation(() => {
        throw new Error("private-logger-failure");
      });

      try {
        const sample = service.captureIncidentTerminalSample();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(sample.captured_at).toEqual(expect.any(String));
        expect(service.getRecentSamples(1)).toHaveLength(1);
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
      }
    });

    it("attaches rejection containment to terminal and freeze sample writes", () => {
      const detachedWrite = {
        catch: jest.fn().mockReturnValue(Promise.resolve()),
      };
      jest.spyOn(service as any, "writeSample").mockReturnValue(detachedWrite);

      service.captureIncidentTerminalSample();
      (service as any).subscribeToFreezeEvents();
      window.dispatchEvent(new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 500 },
      }));

      expect(detachedWrite.catch).toHaveBeenCalledTimes(2);
      for (const [handler] of detachedWrite.catch.mock.calls) {
        expect(handler).toEqual(expect.any(Function));
      }
    });
  });

  describe("detached periodic sampling", () => {
    it("attaches rejection containment to startup, interval, and burst samples", () => {
      const detachedSamples: Array<{ catch: jest.Mock }> = [];
      jest.spyOn(service as any, "collectAndPersistSample").mockImplementation(() => {
        const detached = {
          catch: jest.fn().mockReturnValue(Promise.resolve()),
        };
        detachedSamples.push(detached);
        return detached;
      });

      service.start();
      jest.advanceTimersByTime(15_000);

      expect(detachedSamples.length).toBeGreaterThanOrEqual(3);
      for (const detached of detachedSamples) {
        expect(detached.catch).toHaveBeenCalledTimes(1);
        expect(detached.catch).toHaveBeenCalledWith(expect.any(Function));
      }
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

  describe("getIncidentResourceSamplesAround", () => {
    it("returns the nearest bounded samples in chronological order without notes", () => {
      const center = Date.parse("2026-08-13T12:00:00.000Z");
      const offsets = [-150, -90, -10, 0, 10, 90, 150];
      for (const offset of offsets) {
        (service as any).samples.push({
          timestamp: center + offset,
          iso: new Date(center + offset).toISOString(),
          heapUsedMB: 100 + offset,
          heapTotalMB: 999,
          externalMB: 888,
          note: `private-note-${offset}`,
        });
      }

      const samples = service.getIncidentResourceSamplesAround(center, {
        beforeMs: 100,
        afterMs: 100,
        limit: 3,
      });

      expect(samples.map((sample) => sample.captured_at)).toEqual([
        new Date(center - 10).toISOString(),
        new Date(center).toISOString(),
        new Date(center + 10).toISOString(),
      ]);
      expect(JSON.stringify(samples)).not.toContain("private-note");
      expect(samples.every((sample) => !Object.prototype.hasOwnProperty.call(sample, "heapTotalMB"))).toBe(true);
      expect(samples.every((sample) => !Object.prototype.hasOwnProperty.call(sample, "externalMB"))).toBe(true);
    });

    it("enforces the hard sample limit", () => {
      const center = Date.parse("2026-08-13T12:00:00.000Z");
      for (let index = 0; index < 40; index += 1) {
        const timestamp = center - index;
        (service as any).samples.push({
          timestamp,
          iso: new Date(timestamp).toISOString(),
        });
      }

      const samples = service.getIncidentResourceSamplesAround(center, {
        beforeMs: Number.MAX_SAFE_INTEGER,
        afterMs: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
      });

      expect(samples).toHaveLength(24);
    });

    it("returns no samples for an invalid timestamp", () => {
      expect(service.getIncidentResourceSamplesAround(Number.NaN)).toEqual([]);
    });
  });

  describe("projectIncidentResourceSample", () => {
    it("copies only the incident-safe scalar allowlist", () => {
      const projected = projectIncidentResourceSample({
        timestamp: 1_786_622_400_000,
        iso: "2026-08-13T12:00:00.000Z",
        heapUsedMB: 100.04,
        heapLimitMB: 200.05,
        heapTotalMB: 300,
        rssMB: 400.06,
        externalMB: 500,
        cpuPercent: 12.34,
        eventLoopLagMs: 5.67,
        freezeDeltaMs: 900.08,
        note: "private-note-canary",
        path: "/private/path-canary",
      });

      expect(projected).toEqual({
        captured_at: "2026-08-13T12:00:00.000Z",
        heap_used_mb: 100,
        heap_limit_mb: 200.1,
        rss_mb: 400.1,
        cpu_percent: 12.3,
        event_loop_lag_ms: 5.7,
        freeze_delta_ms: 900.1,
      });
      expect(Object.isFrozen(projected)).toBe(true);
      expect(JSON.stringify(projected)).not.toContain("canary");
    });

    it("rejects an invalid capture time and omits invalid metrics", () => {
      expect(projectIncidentResourceSample({ iso: "not-a-time", heapUsedMB: 10 })).toBeNull();
      expect(projectIncidentResourceSample({
        iso: "2026-08-13T12:00:00.000Z",
        heapUsedMB: Number.NaN,
        cpuPercent: -1,
      })).toEqual({
        captured_at: "2026-08-13T12:00:00.000Z",
      });
    });

    it("reads allowlisted getters once and fails closed on hostile values", () => {
      let isoReads = 0;
      let heapReads = 0;
      const changing = {
        get iso() {
          isoReads += 1;
          return isoReads === 1
            ? "2026-08-13T12:00:00.000Z"
            : "2026-08-13T12:00:01.000Z";
        },
        get heapUsedMB() {
          heapReads += 1;
          return heapReads === 1 ? 100.04 : 999_999;
        },
      };

      expect(projectIncidentResourceSample(changing)).toEqual({
        captured_at: "2026-08-13T12:00:00.000Z",
        heap_used_mb: 100,
      });
      expect(isoReads).toBe(1);
      expect(heapReads).toBe(1);

      expect(projectIncidentResourceSample({
        get iso() {
          throw new Error("private-resource-getter-canary");
        },
      })).toBeNull();

      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      expect(() => projectIncidentResourceSample(revoked.proxy)).not.toThrow();
      expect(projectIncidentResourceSample(revoked.proxy)).toBeNull();
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
    const subscribeAndGetHandler = (): ((event: Event) => void) => {
      (service as any).subscribeToFreezeEvents();
      return (service as any).freezeEventHandler;
    };

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

    it("keeps partial freeze evidence when memory and CPU reads fail", () => {
      jest.spyOn(service as any, "readMemoryUsage").mockImplementation(() => {
        throw new Error("private-memory-failure");
      });
      jest.spyOn(service as any, "captureCpuPercent").mockImplementation(() => {
        throw new Error("private-cpu-failure");
      });
      const writeSample = jest.spyOn(service as any, "writeSample").mockResolvedValue(undefined);
      const handler = subscribeAndGetHandler();

      expect(() => handler(new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 500 },
      }))).not.toThrow();

      const freezeSample = service.getRecentSamples(1)[0];
      expect(freezeSample).toMatchObject({
        freezeDeltaMs: 500,
        note: "freeze",
      });
      expect(freezeSample).not.toHaveProperty("cpuPercent", expect.any(Number));
      expect(writeSample).toHaveBeenCalledWith(freezeSample);
    });

    it("persists after a buffer or threshold logger failure", () => {
      const writeSample = jest.spyOn(service as any, "writeSample").mockResolvedValue(undefined);
      const bufferAndCheckSample = jest.spyOn(service as any, "bufferAndCheckSample");
      const handler = subscribeAndGetHandler();

      bufferAndCheckSample.mockImplementationOnce(() => {
        throw new Error("private-buffer-failure");
      });
      expect(() => handler(new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 500 },
      }))).not.toThrow();
      expect(writeSample).toHaveBeenCalledTimes(1);

      mockLogger.debug.mockImplementationOnce(() => {
        throw new Error("private-logger-failure");
      });
      expect(() => handler(new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 1_000 },
      }))).not.toThrow();
      expect(writeSample).toHaveBeenCalledTimes(2);
      expect(service.getRecentSamples(1)[0]).toMatchObject({
        freezeDeltaMs: 1_000,
        note: "freeze",
      });
    });

    it("contains synchronous and detached persistence failures", () => {
      const handler = subscribeAndGetHandler();
      const writeSample = jest.spyOn(service as any, "writeSample");

      writeSample.mockImplementationOnce(() => {
        throw new Error("private-sync-persistence-failure");
      });
      expect(() => handler(new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 500 },
      }))).not.toThrow();

      const detachedWrite = {
        catch: jest.fn().mockReturnValue(Promise.resolve()),
      };
      writeSample.mockReturnValueOnce(detachedWrite as any);
      expect(() => handler(new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 500 },
      }))).not.toThrow();
      expect(detachedWrite.catch).toHaveBeenCalledWith(expect.any(Function));
    });

    it("contains rejected storage and persistence logger failures", async () => {
      mockPlugin.storage.appendToFile.mockRejectedValue(new Error("private-storage-failure"));
      mockLogger.error.mockImplementation(() => {
        throw new Error("private-persistence-logger-failure");
      });
      const handler = subscribeAndGetHandler();

      expect(() => handler(new CustomEvent("systemsculpt:freeze-detected", {
        detail: { deltaMs: 500 },
      }))).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(service.getRecentSamples(1)[0]).toMatchObject({
        freezeDeltaMs: 500,
        note: "freeze",
      });
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });

    it("contains hostile freeze event detail access", () => {
      const handler = subscribeAndGetHandler();
      const event = new Event("systemsculpt:freeze-detected");
      Object.defineProperty(event, "detail", {
        get() {
          throw new Error("private-detail-failure");
        },
      });

      expect(() => handler(event)).not.toThrow();
      expect(service.getRecentSamples()).toEqual([]);
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
