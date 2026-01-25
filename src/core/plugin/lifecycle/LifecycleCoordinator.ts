import { InitializationTracer } from "../../diagnostics/InitializationTracer";
import { PluginLogger } from "../../../utils/PluginLogger";

export type LifecyclePhase = "bootstrap" | "critical" | "deferred" | "layout";

interface DiagnosticThresholds {
  slowThresholdMs: number;
  timeoutMs: number;
}

const PHASE_DIAGNOSTIC_DEFAULTS: Record<
  LifecyclePhase,
  { required: DiagnosticThresholds; optional: DiagnosticThresholds }
> = {
  bootstrap: {
    required: { slowThresholdMs: 800, timeoutMs: 6000 },
    optional: { slowThresholdMs: 1500, timeoutMs: 10000 },
  },
  critical: {
    required: { slowThresholdMs: 4000, timeoutMs: 25000 },
    optional: { slowThresholdMs: 5000, timeoutMs: 30000 },
  },
  deferred: {
    required: { slowThresholdMs: 6000, timeoutMs: 35000 },
    optional: { slowThresholdMs: 8000, timeoutMs: 45000 },
  },
  layout: {
    required: { slowThresholdMs: 15000, timeoutMs: 90000 },
    optional: { slowThresholdMs: 30000, timeoutMs: 120000 },
  },
};

export interface LifecycleTask {
  id: string;
  run: () => Promise<void> | void;
  label?: string;
  optional?: boolean;
  metadata?: Record<string, unknown>;
  diagnostics?: {
    slowThresholdMs?: number;
    timeoutMs?: number;
  };
}

export interface LifecycleTaskResult {
  phase: LifecyclePhase;
  taskId: string;
  label?: string;
  status: "success" | "failed";
  durationMs: number;
  error?: unknown;
  optional: boolean;
}

export interface LifecycleFailureEvent {
  phase: LifecyclePhase;
  taskId: string;
  label?: string;
  error: unknown;
  optional: boolean;
}

interface LifecycleCoordinatorOptions {
  tracer: InitializationTracer;
  logger: PluginLogger;
  onTaskFailure?: (event: LifecycleFailureEvent) => void;
}

export class LifecycleCoordinator {
  private readonly phases = new Map<LifecyclePhase, LifecycleTask[]>();
  private readonly results: LifecycleTaskResult[] = [];

  constructor(private readonly options: LifecycleCoordinatorOptions) {}

  registerTask(phase: LifecyclePhase, task: LifecycleTask): void {
    if (!this.phases.has(phase)) {
      this.phases.set(phase, []);
    }
    this.phases.get(phase)!.push(task);
  }

  async runPhase(phase: LifecyclePhase): Promise<void> {
    const tasks = this.phases.get(phase) ?? [];
    for (const task of tasks) {
      const taskId = task.id;
      const displayName = task.label ?? taskId;
      const optional = task.optional ?? false;
      const phaseDefaults = PHASE_DIAGNOSTIC_DEFAULTS[phase] ?? PHASE_DIAGNOSTIC_DEFAULTS.bootstrap;
      const defaultThresholds = optional ? phaseDefaults.optional : phaseDefaults.required;
      const slowThresholdMs = task.diagnostics?.slowThresholdMs ?? defaultThresholds.slowThresholdMs;
      const timeoutMs = task.diagnostics?.timeoutMs ?? defaultThresholds.timeoutMs;
      const phaseTracker = this.options.tracer.startPhase(`lifecycle.${phase}.${taskId}`, {
        slowThresholdMs,
        timeoutMs,
        metadata: task.metadata,
      });
      const start = performance.now();
      try {
        await task.run();
        const durationMs = Number((performance.now() - start).toFixed(1));
        phaseTracker.complete({ durationMs });
        this.results.push({
          phase,
          taskId,
          label: task.label,
          status: "success",
          durationMs,
          optional,
        });
      } catch (error) {
        const durationMs = Number((performance.now() - start).toFixed(1));
        phaseTracker.fail(error, { durationMs });
        this.results.push({
          phase,
          taskId,
          label: task.label,
          status: "failed",
          durationMs,
          error,
          optional,
        });
        this.options.logger.warn(`Lifecycle task failed: ${phase}.${taskId}`, {
          source: "LifecycleCoordinator",
          metadata: {
            optional,
            durationMs,
          },
        });
        this.options.onTaskFailure?.({ phase, taskId, label: task.label, error, optional });
        if (!optional) {
          throw error;
        }
      }
    }
  }

  getResults(): LifecycleTaskResult[] {
    return [...this.results];
  }
}
