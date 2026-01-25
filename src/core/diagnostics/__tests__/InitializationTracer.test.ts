import { InitializationTracer } from "../InitializationTracer";

class TestLogger {
  public readonly entries: Array<{ level: string; message: string; context: unknown; error?: unknown }> = [];

  info(message: string, context?: unknown): void {
    this.entries.push({ level: "info", message, context });
  }

  warn(message: string, context?: unknown): void {
    this.entries.push({ level: "warn", message, context });
  }

  error(message: string, error?: unknown, context?: unknown): void {
    this.entries.push({ level: "error", message, context, error });
  }

  debug(message: string, context?: unknown): void {
    this.entries.push({ level: "debug", message, context });
  }
}

describe("InitializationTracer", () => {
  let logger: TestLogger;
  let tracer: InitializationTracer;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = new TestLogger();
    tracer = new InitializationTracer(() => logger as any, {
      defaultSlowThresholdMs: 100,
      defaultTimeoutMs: 1000,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("uses default thresholds when no config provided", () => {
      const tracerNoConfig = new InitializationTracer(() => logger as any);
      const phase = tracerNoConfig.startPhase("test");
      phase.complete();
      expect(logger.entries.length).toBeGreaterThan(0);
    });

    it("uses custom thresholds from config", () => {
      const customTracer = new InitializationTracer(() => logger as any, {
        defaultSlowThresholdMs: 500,
        defaultTimeoutMs: 5000,
      });

      const phase = customTracer.startPhase("test");
      phase.complete();
      expect(logger.entries.length).toBeGreaterThan(0);
    });
  });

  describe("startPhase", () => {
    it("creates a phase handle with correct name", () => {
      const phase = tracer.startPhase("test-phase");
      expect(phase.name).toBe("test-phase");
      phase.complete();
    });

    it("logs start message", () => {
      tracer.startPhase("test-phase", { startLevel: "info" }).complete();
      const infoEntries = logger.entries.filter((e) => e.level === "info" && e.message === "init:start");
      expect(infoEntries.length).toBeGreaterThanOrEqual(1);
    });

    it("skips start log when startLevel is none", () => {
      logger.entries.length = 0;
      tracer.startPhase("test-phase", { startLevel: "none" }).complete();
      const startEntries = logger.entries.filter((e) => e.message === "init:start");
      expect(startEntries).toHaveLength(0);
    });

    it("includes metadata in logs", () => {
      tracer.startPhase("test-phase", { metadata: { key: "value" } }).complete();
      const entry = logger.entries.find((e) => e.message === "init:done");
      expect(entry).toBeDefined();
    });
  });

  describe("trackPromise", () => {
    it("tracks successful promise", async () => {
      const result = await tracer.trackPromise("test-task", async () => {
        return "success";
      });

      expect(result).toBe("success");
      const doneEntries = logger.entries.filter((e) => e.message === "init:done");
      expect(doneEntries.length).toBeGreaterThan(0);
    });

    it("tracks failed promise and rethrows", async () => {
      const error = new Error("Task failed");

      await expect(
        tracer.trackPromise("test-task", async () => {
          throw error;
        })
      ).rejects.toThrow("Task failed");

      const failEntries = logger.entries.filter((e) => e.message === "init:fail");
      expect(failEntries.length).toBeGreaterThan(0);
    });

    it("passes options to phase", async () => {
      await tracer.trackPromise(
        "test-task",
        async () => "done",
        { slowThresholdMs: 500, metadata: { custom: true } }
      );

      expect(logger.entries.length).toBeGreaterThan(0);
    });
  });

  describe("markMilestone", () => {
    it("logs milestone as info", () => {
      tracer.markMilestone("test-milestone");

      const milestoneEntries = logger.entries.filter(
        (e) => e.level === "info" && e.message === "init:milestone"
      );
      expect(milestoneEntries).toHaveLength(1);
    });

    it("includes metadata in milestone log", () => {
      tracer.markMilestone("test-milestone", { count: 42 });

      const entry = logger.entries.find((e) => e.message === "init:milestone");
      expect(entry).toBeDefined();
      expect((entry?.context as any)?.metadata?.count).toBe(42);
    });
  });

  describe("flushOpenPhases", () => {
    it("logs warning for each open phase", () => {
      tracer.startPhase("phase1");
      tracer.startPhase("phase2");

      tracer.flushOpenPhases("test cleanup");

      const warnings = logger.entries.filter(
        (e) => e.level === "warn" && e.message === "init:open"
      );
      expect(warnings).toHaveLength(2);
    });

    it("includes reason in warning metadata", () => {
      tracer.startPhase("test-phase");
      tracer.flushOpenPhases("shutdown");

      const warning = logger.entries.find((e) => e.message === "init:open");
      expect((warning?.context as any)?.metadata?.reason).toBe("shutdown");
    });
  });

  describe("slow threshold handling", () => {
    it("does not warn when slowThresholdMs is zero", () => {
      const phase = tracer.startPhase("phase.zero-threshold", {
        slowThresholdMs: 0,
        timeoutMs: 0,
      });

      phase.complete();

      const warnings = logger.entries.filter((entry) => entry.level === "warn");
      expect(warnings).toHaveLength(0);
    });

    it("logs slow warning when threshold exceeded", () => {
      const phase = tracer.startPhase("slow-phase", {
        slowThresholdMs: 50,
        timeoutMs: 0,
      });

      jest.advanceTimersByTime(60);
      phase.complete();

      const slowEntries = logger.entries.filter((e) => e.message === "init:slow");
      expect(slowEntries.length).toBeGreaterThanOrEqual(1);
    });

    it("does not log slow warning if completed before threshold", () => {
      const phase = tracer.startPhase("fast-phase", {
        slowThresholdMs: 100,
        timeoutMs: 0,
      });

      jest.advanceTimersByTime(10);
      phase.complete();

      const slowEntries = logger.entries.filter((e) => e.message === "init:slow");
      expect(slowEntries).toHaveLength(0);
    });
  });

  describe("timeout handling", () => {
    it("logs timeout warning when timeout exceeded", () => {
      tracer.startPhase("timeout-phase", {
        slowThresholdMs: 0,
        timeoutMs: 100,
      });

      jest.advanceTimersByTime(150);

      const timeoutEntries = logger.entries.filter((e) => e.message === "init:timeout");
      expect(timeoutEntries.length).toBeGreaterThanOrEqual(1);
    });

    it("does not log timeout if completed before timeout", () => {
      const phase = tracer.startPhase("fast-phase", {
        slowThresholdMs: 0,
        timeoutMs: 1000,
      });

      jest.advanceTimersByTime(100);
      phase.complete();

      const timeoutEntries = logger.entries.filter((e) => e.message === "init:timeout");
      expect(timeoutEntries).toHaveLength(0);
    });
  });

  describe("InitializationPhaseHandle", () => {
    describe("complete", () => {
      it("logs completion at configured success level", () => {
        tracer.startPhase("info-phase", { successLevel: "info" }).complete();
        const infoDone = logger.entries.filter((e) => e.level === "info" && e.message === "init:done");
        expect(infoDone.length).toBeGreaterThan(0);
      });

      it("logs completion at debug level by default", () => {
        tracer.startPhase("debug-phase").complete();
        const debugDone = logger.entries.filter((e) => e.level === "debug" && e.message === "init:done");
        expect(debugDone.length).toBeGreaterThan(0);
      });

      it("can only be called once", () => {
        const phase = tracer.startPhase("single-complete");
        phase.complete();
        const countBefore = logger.entries.filter((e) => e.message === "init:done").length;
        phase.complete();
        const countAfter = logger.entries.filter((e) => e.message === "init:done").length;
        expect(countAfter).toBe(countBefore);
      });

      it("clears timers on completion", () => {
        const phase = tracer.startPhase("timer-phase", {
          slowThresholdMs: 50,
          timeoutMs: 100,
        });

        phase.complete();
        jest.advanceTimersByTime(200);

        const slowOrTimeout = logger.entries.filter(
          (e) => e.message === "init:slow" || e.message === "init:timeout"
        );
        expect(slowOrTimeout).toHaveLength(0);
      });
    });

    describe("fail", () => {
      it("logs failure as error", () => {
        const phase = tracer.startPhase("fail-phase");
        phase.fail(new Error("Test error"));

        const failEntries = logger.entries.filter((e) => e.level === "error" && e.message === "init:fail");
        expect(failEntries.length).toBeGreaterThan(0);
      });

      it("includes error information in log", () => {
        const phase = tracer.startPhase("fail-phase");
        const error = new Error("Test error message");
        phase.fail(error);

        const failEntry = logger.entries.find((e) => e.message === "init:fail");
        expect(failEntry).toBeDefined();
        expect(failEntry?.error).toBe(error);
      });

      it("clears timers on failure", () => {
        const phase = tracer.startPhase("timer-fail-phase", {
          slowThresholdMs: 50,
          timeoutMs: 100,
        });

        phase.fail(new Error("fail"));
        jest.advanceTimersByTime(200);

        const slowOrTimeout = logger.entries.filter(
          (e) => e.message === "init:slow" || e.message === "init:timeout"
        );
        expect(slowOrTimeout).toHaveLength(0);
      });
    });

    describe("getElapsedMs", () => {
      it("returns elapsed time", () => {
        const phase = tracer.startPhase("elapsed-phase");
        jest.advanceTimersByTime(100);
        const elapsed = phase.getElapsedMs();
        expect(elapsed).toBeGreaterThanOrEqual(100);
        phase.complete();
      });
    });

    describe("late completion after timeout", () => {
      it("logs error when complete called after timeout", () => {
        const phase = tracer.startPhase("late-phase", {
          slowThresholdMs: 0,
          timeoutMs: 50,
        });

        // Let timeout fire
        jest.advanceTimersByTime(100);

        // Now complete after timeout
        phase.complete();

        const lateEntries = logger.entries.filter((e) => e.message === "init:late");
        expect(lateEntries.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("fail after already completed", () => {
      it("does nothing if fail called after complete", () => {
        const phase = tracer.startPhase("already-done");
        phase.complete();

        const countBefore = logger.entries.length;
        phase.fail(new Error("Too late"));
        const countAfter = logger.entries.length;

        // No new entries should be added
        expect(countAfter).toBe(countBefore);
      });

      it("does nothing if fail called twice", () => {
        const phase = tracer.startPhase("double-fail");
        phase.fail(new Error("First"));

        const countBefore = logger.entries.length;
        phase.fail(new Error("Second"));
        const countAfter = logger.entries.length;

        // No new entries should be added
        expect(countAfter).toBe(countBefore);
      });
    });

  });
});
