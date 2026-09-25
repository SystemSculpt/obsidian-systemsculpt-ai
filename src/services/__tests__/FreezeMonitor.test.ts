/**
 * @jest-environment jsdom
 */
import { FreezeMonitor, resolveFreezeEntryType, type FreezeReport } from "../FreezeMonitor";

type FakeEntry = Readonly<{ duration: number }>;

function createFakeObserver(supportedEntryTypes: readonly string[] | undefined) {
  const instances: FakeObserver[] = [];
  class FakeObserver {
    static supportedEntryTypes = supportedEntryTypes;
    readonly observe = jest.fn();
    readonly disconnect = jest.fn();
    constructor(private readonly callback: PerformanceObserverCallback) {
      instances.push(this);
    }
    emit(entries: FakeEntry[]): void {
      this.callback({ getEntries: () => entries } as unknown as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
    }
  }
  return { FakeObserver, instances };
}

describe("FreezeMonitor", () => {
  it("prefers long-animation-frame and falls back to longtask", () => {
    expect(resolveFreezeEntryType(createFakeObserver(["longtask", "long-animation-frame"]).FakeObserver as never))
      .toBe("long-animation-frame");
    expect(resolveFreezeEntryType(createFakeObserver(["mark", "longtask"]).FakeObserver as never)).toBe("longtask");
    expect(resolveFreezeEntryType(createFakeObserver(["mark", "measure"]).FakeObserver as never)).toBeNull();
    expect(resolveFreezeEntryType(createFakeObserver(undefined).FakeObserver as never)).toBeNull();
    expect(resolveFreezeEntryType(undefined)).toBeNull();
  });

  it("observes long frames without any timer", () => {
    jest.useFakeTimers();
    try {
      const { FakeObserver, instances } = createFakeObserver(["long-animation-frame"]);
      const monitor = new FreezeMonitor({ onFreeze: jest.fn(), observerConstructor: FakeObserver as never });

      expect(monitor.start()).toBe("long-animation-frame");

      expect(instances).toHaveLength(1);
      expect(instances[0].observe).toHaveBeenCalledWith({ type: "long-animation-frame" });
      expect(jest.getTimerCount()).toBe(0);
      monitor.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does nothing on hosts that cannot report long frames", () => {
    const { FakeObserver, instances } = createFakeObserver(["mark"]);
    const monitor = new FreezeMonitor({ onFreeze: jest.fn(), observerConstructor: FakeObserver as never });

    expect(monitor.start()).toBeNull();
    expect(monitor.isObserving()).toBe(false);
    expect(instances).toHaveLength(0);
  });

  it("reports the longest frame above the threshold, rate limited", () => {
    const { FakeObserver, instances } = createFakeObserver(["longtask"]);
    const reports: FreezeReport[] = [];
    let now = 10_000;
    const monitor = new FreezeMonitor({
      onFreeze: (report) => reports.push(report),
      thresholdMs: 200,
      minReportIntervalMs: 2_000,
      observerConstructor: FakeObserver as never,
      now: () => now,
    });
    monitor.start();
    const observer = instances[0];

    observer.emit([{ duration: 120 }, { duration: 199.9 }]);
    observer.emit([{ duration: 250 }, { duration: 612.34 }, { duration: 90 }]);
    now += 1_000;
    observer.emit([{ duration: 900 }]);
    now += 1_000;
    observer.emit([{ duration: 300 }]);

    expect(reports).toEqual([
      { durationMs: 612.3, entryType: "longtask" },
      { durationMs: 300, entryType: "longtask" },
    ]);
  });

  it("disconnects on stop and can restart", () => {
    const { FakeObserver, instances } = createFakeObserver(["long-animation-frame"]);
    const monitor = new FreezeMonitor({ onFreeze: jest.fn(), observerConstructor: FakeObserver as never });

    monitor.start();
    monitor.start();
    expect(instances).toHaveLength(1);
    monitor.stop();
    monitor.stop();

    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(monitor.isObserving()).toBe(false);
    monitor.start();
    expect(instances).toHaveLength(2);
    monitor.stop();
  });

  it("contains observer and callback failures", () => {
    const { FakeObserver, instances } = createFakeObserver(["longtask"]);
    const onFreeze = jest.fn(() => {
      throw new Error("private-callback-failure");
    });
    const monitor = new FreezeMonitor({ onFreeze, observerConstructor: FakeObserver as never });
    monitor.start();

    expect(() => instances[0].emit([{ duration: 1_000 }])).not.toThrow();
    expect(onFreeze).toHaveBeenCalledTimes(1);

    instances[0].disconnect.mockImplementation(() => {
      throw new Error("private-disconnect-failure");
    });
    expect(() => monitor.stop()).not.toThrow();

    class ThrowingObserver {
      static supportedEntryTypes = ["longtask"];
      constructor() {
        throw new Error("private-constructor-failure");
      }
    }
    const unsupported = new FreezeMonitor({ onFreeze, observerConstructor: ThrowingObserver as never });
    expect(unsupported.start()).toBeNull();
  });
});
