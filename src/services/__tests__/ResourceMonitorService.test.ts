/**
 * @jest-environment jsdom
 */
import {
  projectIncidentResourceSample,
  ResourceMonitorService,
  ResourceSample,
} from "../ResourceMonitorService";

const MINUTE_MS = 60_000;

function createFakeObserver(supportedEntryTypes: readonly string[] = ["long-animation-frame"]) {
  const instances: FakeObserver[] = [];
  class FakeObserver {
    static supportedEntryTypes = supportedEntryTypes;
    readonly observe = jest.fn();
    readonly disconnect = jest.fn();
    constructor(private readonly callback: PerformanceObserverCallback) {
      instances.push(this);
    }
    emit(durations: number[]): void {
      this.callback(
        { getEntries: () => durations.map((duration) => ({ duration })) } as unknown as PerformanceObserverEntryList,
        this as unknown as PerformanceObserver,
      );
    }
  }
  return { FakeObserver, instances };
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

function writtenLines(appendToFile: jest.Mock): Record<string, unknown>[] {
  return appendToFile.mock.calls.flatMap(([, , payload]: [string, string, string]) =>
    payload.trim().split("\n").map((line) => JSON.parse(line)));
}

describe("ResourceMonitorService", () => {
  let service: ResourceMonitorService;
  let mockPlugin: any;
  let mockLogger: any;
  let observer: ReturnType<typeof createFakeObserver>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setDocumentHidden(false);

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockPlugin = {
      getLogger: jest.fn().mockReturnValue(mockLogger),
      register: jest.fn(),
      storage: {
        appendToFile: jest.fn().mockResolvedValue({ success: true }),
        writeFile: jest.fn().mockResolvedValue({ success: true }),
        getPath: jest.fn((type: string, fileName: string) => `.systemsculpt/${type}/${fileName}`),
      },
      app: {
        vault: {
          adapter: {
            stat: jest.fn().mockResolvedValue(null),
          },
        },
      },
    };

    observer = createFakeObserver();
    service = new ResourceMonitorService(mockPlugin, {
      metricsFileName: "resource-metrics-latest.ndjson",
      sessionId: "20260924-120000",
      freezeObserverConstructor: observer.FakeObserver as never,
    });
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
    delete (document as any).hidden;
  });

  describe("constructor", () => {
    it("samples at most once a minute", () => {
      expect((service as any).samplingIntervalMs).toBe(MINUTE_MS);
      expect((new ResourceMonitorService(mockPlugin, { intervalMs: 15_000 }) as any).samplingIntervalMs).toBe(MINUTE_MS);
      expect((new ResourceMonitorService(mockPlugin, { intervalMs: Number.NaN }) as any).samplingIntervalMs).toBe(MINUTE_MS);
      expect((new ResourceMonitorService(mockPlugin, { intervalMs: 5 * MINUTE_MS }) as any).samplingIntervalMs).toBe(5 * MINUTE_MS);
    });
  });

  describe("while diagnostics recording is off", () => {
    it("runs no timer, observes nothing, and writes nothing", async () => {
      expect(jest.getTimerCount()).toBe(0);
      expect(observer.instances).toHaveLength(0);

      await service.captureManualSample("support");
      const terminal = service.captureIncidentTerminalSample();
      await jest.advanceTimersByTimeAsync(60 * MINUTE_MS);
      await service.flushPending();

      expect(service.isRecording()).toBe(false);
      expect(terminal.captured_at).toEqual(expect.any(String));
      expect(service.getRecentSamples().map((sample) => sample.note)).toEqual(["support", "incident-terminal"]);
      expect(mockPlugin.storage.appendToFile).not.toHaveBeenCalled();
      expect(mockPlugin.storage.writeFile).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.adapter.stat).not.toHaveBeenCalled();
      expect(mockPlugin.register).not.toHaveBeenCalled();
    });

    it("stops every timer, observer, and queued write when recording is turned off", async () => {
      service.start();
      service.stop();
      await service.flushPending();
      mockPlugin.storage.appendToFile.mockClear();

      await jest.advanceTimersByTimeAsync(10 * MINUTE_MS);
      await service.captureManualSample("after-stop");
      setDocumentHidden(false);
      await service.flushPending();

      expect(jest.getTimerCount()).toBe(0);
      expect(observer.instances[0].disconnect).toHaveBeenCalledTimes(1);
      expect(mockPlugin.storage.appendToFile).not.toHaveBeenCalled();
    });
  });

  describe("while diagnostics recording is on", () => {
    it("records one sample a minute on a single timer", async () => {
      service.start();
      service.start();

      expect(service.isRecording()).toBe(true);
      expect(jest.getTimerCount()).toBe(1);
      expect(observer.instances).toHaveLength(1);
      expect(service.getRecentSamples().map((sample) => sample.note)).toEqual(["recording-started"]);

      await jest.advanceTimersByTimeAsync(MINUTE_MS - 1);
      expect(service.getRecentSamples()).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(service.getRecentSamples()).toHaveLength(2);
      expect(service.getRecentSamples()[1].note).toBeUndefined();
      expect(service.getRecentSamples()[1]).not.toHaveProperty("eventLoopLagMs", expect.any(Number));
    });

    it("appends samples in batches instead of once per sample", async () => {
      service.start();
      await jest.advanceTimersByTimeAsync(3 * MINUTE_MS);
      expect(mockPlugin.storage.appendToFile).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      expect(mockPlugin.storage.appendToFile).toHaveBeenCalledTimes(1);
      expect(mockPlugin.storage.appendToFile.mock.calls[0][0]).toBe("diagnostics");
      expect(mockPlugin.storage.appendToFile.mock.calls[0][1]).toBe("resource-metrics-latest.ndjson");
      const lines = writtenLines(mockPlugin.storage.appendToFile);
      expect(lines).toHaveLength(5);
      expect(lines.every((line) => line.sessionId === "20260924-120000")).toBe(true);
    });

    it("pauses sampling while the window is hidden and flushes what it has", async () => {
      service.start();
      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      setDocumentHidden(true);
      await Promise.resolve();

      expect(jest.getTimerCount()).toBe(0);
      expect(writtenLines(mockPlugin.storage.appendToFile)).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(30 * MINUTE_MS);
      expect(service.getRecentSamples()).toHaveLength(2);

      setDocumentHidden(false);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      expect(service.getRecentSamples()).toHaveLength(3);
    });

    it("does not start the timer when recording begins in a hidden window", () => {
      setDocumentHidden(true);

      service.start();

      expect(jest.getTimerCount()).toBe(0);
      setDocumentHidden(false);
      expect(jest.getTimerCount()).toBe(1);
    });

    it("keeps samples queued after stop until they are flushed", async () => {
      service.start();
      await jest.advanceTimersByTimeAsync(MINUTE_MS);
      service.stop();

      expect(mockPlugin.storage.appendToFile).not.toHaveBeenCalled();
      await service.flushPending();

      expect(writtenLines(mockPlugin.storage.appendToFile).map((line) => line.note)).toEqual(["recording-started", undefined]);
    });

    it("drains samples queued behind an active flush", async () => {
      let releaseFirst!: () => void;
      mockPlugin.storage.appendToFile.mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ success: true });
      }));
      service.start();
      const first = service.flushPending();
      await service.captureManualSample("queued");
      const drained = service.flushPending();

      releaseFirst();
      await first;
      await drained;

      expect(mockPlugin.storage.appendToFile).toHaveBeenCalledTimes(2);
      expect(writtenLines(mockPlugin.storage.appendToFile).map((line) => line.note)).toEqual(["recording-started", "queued"]);
    });

    it("queues incident samples with the next batch instead of writing each one", () => {
      service.start();

      const sample = (service.captureIncidentTerminalSample as any)("private-caller-note");

      expect(sample.captured_at).toEqual(expect.any(String));
      expect(sample).not.toHaveProperty("note");
      expect(JSON.stringify(sample)).not.toContain("private-caller-note");
      expect(service.getRecentSamples(1)[0].note).toBe("incident-terminal");
      expect(mockPlugin.storage.appendToFile).not.toHaveBeenCalled();
    });

    it("ties its timer and observer to plugin unload once", () => {
      service.start();
      service.stop();
      service.start();

      expect(mockPlugin.register).toHaveBeenCalledTimes(1);
      mockPlugin.register.mock.calls[0][0]();
      expect(service.isRecording()).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe("long-frame reports", () => {
    it("records a freeze sample from the observer without writing immediately", () => {
      service.start();

      observer.instances[0].emit([80, 512.34]);

      const freezeSample = service.getRecentSamples(1)[0];
      expect(freezeSample).toMatchObject({
        note: "freeze",
        freezeDeltaMs: 512.3,
        eventLoopLagMs: 512.3,
      });
      expect(mockPlugin.storage.appendToFile).not.toHaveBeenCalled();
    });

    it("ignores frames below the freeze threshold", () => {
      service.start();

      observer.instances[0].emit([60, 199]);

      expect(service.getRecentSamples().map((sample) => sample.note)).toEqual(["recording-started"]);
    });

    it("keeps partial freeze evidence when memory and CPU reads fail", () => {
      service.start();
      jest.spyOn(service as any, "readMemoryUsage").mockImplementation(() => {
        throw new Error("private-memory-failure");
      });
      jest.spyOn(service as any, "captureCpuPercent").mockImplementation(() => {
        throw new Error("private-cpu-failure");
      });

      expect(() => observer.instances[0].emit([500])).not.toThrow();

      const freezeSample = service.getRecentSamples(1)[0];
      expect(freezeSample).toMatchObject({ freezeDeltaMs: 500, note: "freeze" });
      expect(freezeSample).not.toHaveProperty("cpuPercent", expect.any(Number));
      expect((service as any).pendingWrites).toContain(freezeSample);
    });

    it("queues the sample after a buffer or threshold logger failure", () => {
      service.start();
      const bufferAndCheckSample = jest.spyOn(service as any, "bufferAndCheckSample");
      bufferAndCheckSample.mockImplementationOnce(() => {
        throw new Error("private-buffer-failure");
      });

      expect(() => observer.instances[0].emit([1_000])).not.toThrow();

      expect((service as any).pendingWrites.at(-1)).toMatchObject({ freezeDeltaMs: 1_000, note: "freeze" });
    });
  });

  describe("metrics file", () => {
    it("reports failed and rejected batch writes without throwing", async () => {
      service.start();
      mockPlugin.storage.appendToFile.mockResolvedValueOnce({ success: false, error: "private-storage-failure" });
      await service.flushPending();

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to write resource metrics",
        undefined,
        expect.objectContaining({ source: "ResourceMonitor" }),
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain("private-storage-failure");

      await service.captureManualSample("second");
      mockPlugin.storage.appendToFile.mockRejectedValueOnce(new Error("private-storage-failure"));
      await service.flushPending();

      expect(mockLogger.error).toHaveBeenLastCalledWith(
        "Failed to write resource metrics",
        expect.any(Error),
        expect.objectContaining({ source: "ResourceMonitor" }),
      );
    });

    it("does not emit an unhandled rejection when storage and diagnostics logging fail", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      mockPlugin.storage.appendToFile.mockRejectedValue(new Error("private-storage-failure"));
      mockLogger.error.mockImplementation(() => {
        throw new Error("private-logger-failure");
      });

      try {
        service.start();
        for (let index = 0; index < 5; index += 1) service.captureIncidentTerminalSample();
        await service.flushPending();
        await Promise.resolve();

        expect(service.getRecentSamples()).toHaveLength(6);
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
      }
    });

    it("keeps pending samples when storage is not ready", async () => {
      mockPlugin.storage = null;
      service.start();

      await expect(service.flushPending()).resolves.toBeUndefined();

      expect((service as any).pendingWrites).toHaveLength(1);
    });

    it("stats the file once per session, then counts appended bytes", async () => {
      mockPlugin.app.vault.adapter.stat.mockResolvedValue({ size: 1_000 });
      service.start();
      await service.flushPending();
      await service.captureManualSample("next");
      await service.flushPending();

      expect(mockPlugin.app.vault.adapter.stat).toHaveBeenCalledTimes(1);
      expect(mockPlugin.app.vault.adapter.stat).toHaveBeenCalledWith(".systemsculpt/diagnostics/resource-metrics-latest.ndjson");
      expect((service as any).metricsFileBytes).toBeGreaterThan(1_000);
      expect(mockPlugin.storage.writeFile).not.toHaveBeenCalled();
    });

    it("caps the file at 1 MB by rewriting it with the newest samples", async () => {
      mockPlugin.app.vault.adapter.stat.mockResolvedValue({ size: 999_990 });
      service.start();
      await service.flushPending();
      expect(mockPlugin.storage.writeFile).not.toHaveBeenCalled();
      await service.captureManualSample("over-cap");

      await service.flushPending();

      expect(mockPlugin.storage.writeFile).toHaveBeenCalledTimes(1);
      const [type, fileName, retained] = mockPlugin.storage.writeFile.mock.calls[0];
      expect(type).toBe("diagnostics");
      expect(fileName).toBe("resource-metrics-latest.ndjson");
      expect(retained.trim().split("\n").map((line: string) => JSON.parse(line).note)).toEqual(["recording-started", "over-cap"]);
      expect((service as any).metricsFileBytes).toBe(retained.length);
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
});
