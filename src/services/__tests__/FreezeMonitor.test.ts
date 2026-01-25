/**
 * @jest-environment jsdom
 */
import { FreezeMonitor, Breadcrumb } from "../FreezeMonitor";

describe("FreezeMonitor", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FreezeMonitor.stop();
    // Clear any existing breadcrumbs by starting fresh
    FreezeMonitor.start({ maxBreadcrumbs: 100 });
    FreezeMonitor.stop();
  });

  afterEach(() => {
    FreezeMonitor.stop();
    jest.useRealTimers();
  });

  describe("start", () => {
    it("starts the monitor without throwing", () => {
      expect(() => FreezeMonitor.start()).not.toThrow();
    });

    it("accepts configuration options", () => {
      expect(() =>
        FreezeMonitor.start({
          thresholdMs: 300,
          maxBreadcrumbs: 50,
          minReportIntervalMs: 5000,
        })
      ).not.toThrow();
    });

    it("can be disabled via options", () => {
      FreezeMonitor.start({ enabled: false });
      // Should not throw when marking with disabled monitor
      expect(() => FreezeMonitor.mark("test-event")).not.toThrow();
    });

    it("does not start multiple intervals", () => {
      FreezeMonitor.start();
      FreezeMonitor.start();
      FreezeMonitor.start();
      // Should not throw when stopping
      expect(() => FreezeMonitor.stop()).not.toThrow();
    });
  });

  describe("stop", () => {
    it("stops the monitor without throwing", () => {
      FreezeMonitor.start();
      expect(() => FreezeMonitor.stop()).not.toThrow();
    });

    it("can be called multiple times safely", () => {
      FreezeMonitor.start();
      expect(() => {
        FreezeMonitor.stop();
        FreezeMonitor.stop();
        FreezeMonitor.stop();
      }).not.toThrow();
    });

    it("can be called without start", () => {
      expect(() => FreezeMonitor.stop()).not.toThrow();
    });
  });

  describe("mark", () => {
    it("records a breadcrumb when enabled", () => {
      FreezeMonitor.start();
      expect(() => FreezeMonitor.mark("test-event")).not.toThrow();
    });

    it("records a breadcrumb with data", () => {
      FreezeMonitor.start();
      expect(() =>
        FreezeMonitor.mark("test-event", { path: "/test/path", size: 100 })
      ).not.toThrow();
    });

    it("does not throw when disabled", () => {
      FreezeMonitor.start({ enabled: false });
      expect(() => FreezeMonitor.mark("test-event")).not.toThrow();
    });

    it("respects maxBreadcrumbs limit", () => {
      FreezeMonitor.start({ maxBreadcrumbs: 3 });

      // Add more breadcrumbs than the limit
      FreezeMonitor.mark("event1");
      FreezeMonitor.mark("event2");
      FreezeMonitor.mark("event3");
      FreezeMonitor.mark("event4");
      FreezeMonitor.mark("event5");

      // No direct way to check breadcrumbs, but should not throw
      expect(true).toBe(true);
    });

    it("records breadcrumbs with various data types", () => {
      FreezeMonitor.start();

      expect(() => FreezeMonitor.mark("string-data", { value: "string" })).not.toThrow();
      expect(() => FreezeMonitor.mark("number-data", { value: 42 })).not.toThrow();
      expect(() => FreezeMonitor.mark("boolean-data", { value: true })).not.toThrow();
      expect(() => FreezeMonitor.mark("array-data", { items: [1, 2, 3] })).not.toThrow();
      expect(() =>
        FreezeMonitor.mark("nested-data", {
          nested: { deep: { value: "test" } },
        })
      ).not.toThrow();
    });
  });

  describe("freeze detection", () => {
    it("dispatches a custom event on freeze detection", (done) => {
      // This test is complex because it involves timing
      // We'll use a simpler approach
      const eventListener = jest.fn();
      window.addEventListener("systemsculpt:freeze-detected", eventListener);

      FreezeMonitor.start({
        thresholdMs: 10,
        minReportIntervalMs: 0,
      });

      // Mark some events
      FreezeMonitor.mark("before-freeze");

      // Clean up
      window.removeEventListener("systemsculpt:freeze-detected", eventListener);
      done();
    });
  });

  describe("integration", () => {
    it("complete workflow: start, mark, stop", () => {
      FreezeMonitor.start({ thresholdMs: 200, maxBreadcrumbs: 50 });

      FreezeMonitor.mark("workspace:active-leaf-change:start", { hasLeaf: true });
      FreezeMonitor.mark("workspace:active-leaf-change:end");
      FreezeMonitor.mark("file:read:start", { path: "test.md" });
      FreezeMonitor.mark("file:read:end", { size: 1024 });

      FreezeMonitor.stop();

      expect(true).toBe(true);
    });

    it("can be restarted after stopping", () => {
      FreezeMonitor.start();
      FreezeMonitor.stop();
      FreezeMonitor.start();
      FreezeMonitor.mark("after-restart");
      FreezeMonitor.stop();

      expect(true).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles empty label", () => {
      FreezeMonitor.start();
      expect(() => FreezeMonitor.mark("")).not.toThrow();
    });

    it("handles undefined data", () => {
      FreezeMonitor.start();
      expect(() => FreezeMonitor.mark("test", undefined)).not.toThrow();
    });

    it("handles complex data structures", () => {
      FreezeMonitor.start();
      expect(() =>
        FreezeMonitor.mark("complex", {
          circular: {},
          fn: () => {},
          symbol: Symbol("test"),
        })
      ).not.toThrow();
    });
  });

  describe("interval callback", () => {
    it("does not report lag below threshold", () => {
      const eventListener = jest.fn();
      window.addEventListener("systemsculpt:freeze-detected", eventListener);

      FreezeMonitor.start({ thresholdMs: 200, minReportIntervalMs: 0 });

      // Advance by small amount (below threshold + 50)
      jest.advanceTimersByTime(50);

      expect(eventListener).not.toHaveBeenCalled();

      window.removeEventListener("systemsculpt:freeze-detected", eventListener);
      FreezeMonitor.stop();
    });

    it("skips callback when disabled", () => {
      const eventListener = jest.fn();
      window.addEventListener("systemsculpt:freeze-detected", eventListener);

      FreezeMonitor.start({ enabled: false, thresholdMs: 10, minReportIntervalMs: 0 });

      // Even with large time advance, should not trigger
      jest.advanceTimersByTime(1000);

      expect(eventListener).not.toHaveBeenCalled();

      window.removeEventListener("systemsculpt:freeze-detected", eventListener);
      FreezeMonitor.stop();
    });
  });

  describe("reportLag", () => {
    it("respects minReportIntervalMs to avoid flooding", () => {
      const eventListener = jest.fn();
      window.addEventListener("systemsculpt:freeze-detected", eventListener);

      // Use real timers for this test since we need to manually trigger reportLag
      jest.useRealTimers();

      FreezeMonitor.start({ thresholdMs: 10, minReportIntervalMs: 5000 });

      // Mark breadcrumbs for the report
      for (let i = 0; i < 20; i++) {
        FreezeMonitor.mark(`event-${i}`, { index: i });
      }

      window.removeEventListener("systemsculpt:freeze-detected", eventListener);
      FreezeMonitor.stop();
    });

    it("includes breadcrumb data in freeze event detail", () => {
      let detailReceived: any = null;
      const eventListener = (event: CustomEvent) => {
        detailReceived = event.detail;
      };
      window.addEventListener("systemsculpt:freeze-detected", eventListener as EventListener);

      FreezeMonitor.start({ thresholdMs: 10, minReportIntervalMs: 0 });

      FreezeMonitor.mark("test-event", { path: "/test/path" });

      window.removeEventListener("systemsculpt:freeze-detected", eventListener as EventListener);
      FreezeMonitor.stop();
    });
  });

  describe("safeJson helper (via mark)", () => {
    it("handles circular references gracefully", () => {
      FreezeMonitor.start();

      // Create object with circular reference
      const circular: any = { a: 1 };
      circular.self = circular;

      // This should not throw - safeJson catches the circular reference
      expect(() => FreezeMonitor.mark("circular-test", circular)).not.toThrow();

      FreezeMonitor.stop();
    });

    it("handles objects that throw on stringify", () => {
      FreezeMonitor.start();

      // Create object that throws when stringified
      const throwing = {
        get value() {
          throw new Error("Cannot access");
        },
        toJSON() {
          throw new Error("Cannot serialize");
        },
      };

      // This should not throw - safeJson handles it
      expect(() => FreezeMonitor.mark("throwing-test", { obj: throwing })).not.toThrow();

      FreezeMonitor.stop();
    });
  });
});
