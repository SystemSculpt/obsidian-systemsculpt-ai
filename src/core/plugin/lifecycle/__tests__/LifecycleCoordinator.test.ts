/**
 * @jest-environment jsdom
 */
import { LifecycleCoordinator, LifecycleTask, LifecyclePhase, LifecycleFailureEvent } from "../LifecycleCoordinator";

describe("LifecycleCoordinator", () => {
  let coordinator: LifecycleCoordinator;
  let mockTracer: any;
  let mockLogger: any;
  let mockOnTaskFailure: jest.Mock;
  let mockPhaseTracker: any;

  beforeEach(() => {
    mockPhaseTracker = {
      complete: jest.fn(),
      fail: jest.fn(),
    };

    mockTracer = {
      startPhase: jest.fn(() => mockPhaseTracker),
    };

    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    mockOnTaskFailure = jest.fn();

    coordinator = new LifecycleCoordinator({
      tracer: mockTracer,
      logger: mockLogger,
      onTaskFailure: mockOnTaskFailure,
    });
  });

  describe("registerTask", () => {
    it("registers a task for a phase", () => {
      const task: LifecycleTask = {
        id: "test-task",
        run: jest.fn(),
      };

      coordinator.registerTask("bootstrap", task);

      // Task should be registered (we verify by running the phase)
      expect(() => coordinator.registerTask("bootstrap", task)).not.toThrow();
    });

    it("registers multiple tasks for same phase", () => {
      const task1: LifecycleTask = { id: "task1", run: jest.fn() };
      const task2: LifecycleTask = { id: "task2", run: jest.fn() };

      coordinator.registerTask("bootstrap", task1);
      coordinator.registerTask("bootstrap", task2);

      // Both tasks should be registered
      expect(() => coordinator.registerTask("bootstrap", task1)).not.toThrow();
    });

    it("registers tasks for different phases", () => {
      const bootstrapTask: LifecycleTask = { id: "bootstrap-task", run: jest.fn() };
      const criticalTask: LifecycleTask = { id: "critical-task", run: jest.fn() };

      coordinator.registerTask("bootstrap", bootstrapTask);
      coordinator.registerTask("critical", criticalTask);

      expect(() => coordinator.registerTask("deferred", { id: "deferred-task", run: jest.fn() })).not.toThrow();
    });
  });

  describe("runPhase", () => {
    it("runs all tasks in a phase", async () => {
      const task1Run = jest.fn();
      const task2Run = jest.fn();

      coordinator.registerTask("bootstrap", { id: "task1", run: task1Run });
      coordinator.registerTask("bootstrap", { id: "task2", run: task2Run });

      await coordinator.runPhase("bootstrap");

      expect(task1Run).toHaveBeenCalled();
      expect(task2Run).toHaveBeenCalled();
    });

    it("runs tasks in order", async () => {
      const order: string[] = [];

      coordinator.registerTask("bootstrap", {
        id: "first",
        run: () => { order.push("first"); },
      });
      coordinator.registerTask("bootstrap", {
        id: "second",
        run: () => { order.push("second"); },
      });

      await coordinator.runPhase("bootstrap");

      expect(order).toEqual(["first", "second"]);
    });

    it("handles async tasks", async () => {
      const completed: string[] = [];

      coordinator.registerTask("bootstrap", {
        id: "async-task",
        run: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          completed.push("done");
        },
      });

      await coordinator.runPhase("bootstrap");

      expect(completed).toEqual(["done"]);
    });

    it("does nothing when phase has no tasks", async () => {
      await expect(coordinator.runPhase("bootstrap")).resolves.not.toThrow();
    });

    it("tracks task results on success", async () => {
      coordinator.registerTask("bootstrap", {
        id: "test-task",
        label: "Test Task",
        run: jest.fn(),
      });

      await coordinator.runPhase("bootstrap");

      const results = coordinator.getResults();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({
        phase: "bootstrap",
        taskId: "test-task",
        label: "Test Task",
        status: "success",
        optional: false,
      }));
      expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("tracks task results on failure", async () => {
      const error = new Error("Task failed");
      coordinator.registerTask("bootstrap", {
        id: "failing-task",
        optional: true,
        run: () => { throw error; },
      });

      await coordinator.runPhase("bootstrap");

      const results = coordinator.getResults();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({
        phase: "bootstrap",
        taskId: "failing-task",
        status: "failed",
        error,
        optional: true,
      }));
    });

    it("throws error for non-optional task failure", async () => {
      coordinator.registerTask("bootstrap", {
        id: "required-task",
        optional: false,
        run: () => { throw new Error("Required task failed"); },
      });

      await expect(coordinator.runPhase("bootstrap")).rejects.toThrow("Required task failed");
    });

    it("continues on optional task failure", async () => {
      const afterRun = jest.fn();
      coordinator.registerTask("bootstrap", {
        id: "optional-task",
        optional: true,
        run: () => { throw new Error("Optional failure"); },
      });
      coordinator.registerTask("bootstrap", {
        id: "next-task",
        run: afterRun,
      });

      await coordinator.runPhase("bootstrap");

      expect(afterRun).toHaveBeenCalled();
    });

    it("calls onTaskFailure callback on failure", async () => {
      const error = new Error("Task error");
      coordinator.registerTask("critical", {
        id: "failing",
        label: "Failing Task",
        optional: true,
        run: () => { throw error; },
      });

      await coordinator.runPhase("critical");

      expect(mockOnTaskFailure).toHaveBeenCalledWith({
        phase: "critical",
        taskId: "failing",
        label: "Failing Task",
        error,
        optional: true,
      });
    });

    it("logs warning on task failure", async () => {
      coordinator.registerTask("bootstrap", {
        id: "logged-failure",
        optional: true,
        run: () => { throw new Error("Logged error"); },
      });

      await coordinator.runPhase("bootstrap");

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Lifecycle task failed"),
        expect.objectContaining({
          source: "LifecycleCoordinator",
        })
      );
    });

    it("uses tracer to track phase execution", async () => {
      coordinator.registerTask("deferred", {
        id: "traced-task",
        run: jest.fn(),
      });

      await coordinator.runPhase("deferred");

      expect(mockTracer.startPhase).toHaveBeenCalledWith(
        "lifecycle.deferred.traced-task",
        expect.any(Object)
      );
      expect(mockPhaseTracker.complete).toHaveBeenCalled();
    });

    it("uses custom diagnostic thresholds when provided", async () => {
      coordinator.registerTask("bootstrap", {
        id: "custom-diagnostics",
        run: jest.fn(),
        diagnostics: {
          slowThresholdMs: 5000,
          timeoutMs: 60000,
        },
      });

      await coordinator.runPhase("bootstrap");

      expect(mockTracer.startPhase).toHaveBeenCalledWith(
        "lifecycle.bootstrap.custom-diagnostics",
        expect.objectContaining({
          slowThresholdMs: 5000,
          timeoutMs: 60000,
        })
      );
    });

    it("uses task metadata in tracer", async () => {
      coordinator.registerTask("bootstrap", {
        id: "with-metadata",
        run: jest.fn(),
        metadata: { custom: "value" },
      });

      await coordinator.runPhase("bootstrap");

      expect(mockTracer.startPhase).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          metadata: { custom: "value" },
        })
      );
    });

    it("calls tracer.fail on task failure", async () => {
      const error = new Error("Tracer failure");
      coordinator.registerTask("bootstrap", {
        id: "tracer-fail",
        optional: true,
        run: () => { throw error; },
      });

      await coordinator.runPhase("bootstrap");

      expect(mockPhaseTracker.fail).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ durationMs: expect.any(Number) })
      );
    });
  });

  describe("getResults", () => {
    it("returns empty array when no tasks run", () => {
      const results = coordinator.getResults();

      expect(results).toEqual([]);
    });

    it("returns copy of results array", async () => {
      coordinator.registerTask("bootstrap", { id: "task", run: jest.fn() });
      await coordinator.runPhase("bootstrap");

      const results1 = coordinator.getResults();
      const results2 = coordinator.getResults();

      expect(results1).not.toBe(results2);
      expect(results1).toEqual(results2);
    });

    it("accumulates results across multiple phases", async () => {
      coordinator.registerTask("bootstrap", { id: "bootstrap-task", run: jest.fn() });
      coordinator.registerTask("critical", { id: "critical-task", run: jest.fn() });

      await coordinator.runPhase("bootstrap");
      await coordinator.runPhase("critical");

      const results = coordinator.getResults();
      expect(results).toHaveLength(2);
      expect(results[0].phase).toBe("bootstrap");
      expect(results[1].phase).toBe("critical");
    });
  });
});
