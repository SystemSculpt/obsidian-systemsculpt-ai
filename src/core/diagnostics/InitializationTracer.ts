import { PluginLogger, PluginLogContext } from "../../utils/PluginLogger";

export interface InitializationPhaseOptions {
  slowThresholdMs?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  successLevel?: "info" | "debug";
  startLevel?: "info" | "debug" | "none";
}

export interface InitializationTracerConfig {
  defaultSlowThresholdMs?: number;
  defaultTimeoutMs?: number;
}

let phaseCounter = 0;

const DEFAULT_SLOW_THRESHOLD_MS = 750;
const DEFAULT_TIMEOUT_MS = 15000;

export class InitializationTracer {
  private readonly getLogger: () => PluginLogger;
  private readonly defaultSlowThresholdMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly activePhases = new Map<number, InitializationPhaseHandle>();

  constructor(loggerFactory: () => PluginLogger, config?: InitializationTracerConfig) {
    this.getLogger = loggerFactory;
    this.defaultSlowThresholdMs = config?.defaultSlowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  startPhase(name: string, options?: InitializationPhaseOptions): InitializationPhaseHandle {
    const handle = new InitializationPhaseHandle(
      ++phaseCounter,
      name,
      this.getLogger,
      {
        slowThresholdMs: options?.slowThresholdMs ?? this.defaultSlowThresholdMs,
        timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
        metadata: options?.metadata,
        successLevel: options?.successLevel ?? "debug",
        startLevel: options?.startLevel ?? "debug",
      },
      (id) => {
        this.activePhases.delete(id);
      }
    );

    this.activePhases.set(handle.id, handle);
    return handle;
  }

  async trackPromise<T>(
    name: string,
    task: () => Promise<T>,
    options?: InitializationPhaseOptions
  ): Promise<T> {
    const phase = this.startPhase(name, options);

    try {
      const result = await task();
      phase.complete();
      return result;
    } catch (error) {
      phase.fail(error);
      throw error;
    }
  }

  markMilestone(name: string, metadata?: Record<string, unknown>): void {
    const logger = this.getLogger();
    const context: PluginLogContext = {
      source: "InitializationTracer",
      metadata: {
        milestone: name,
        ...(metadata ?? {}),
      },
    };

    logger.info("init:milestone", context);
  }

  flushOpenPhases(reason: string): void {
    const logger = this.getLogger();
    for (const phase of this.activePhases.values()) {
      logger.warn("init:open", {
        source: "InitializationTracer",
        metadata: {
          phase: phase.name,
          id: phase.id,
          elapsedMs: phase.getElapsedMs(),
          reason,
        },
      });
    }
  }
}

interface InternalPhaseOptions {
  slowThresholdMs: number;
  timeoutMs: number;
  metadata?: Record<string, unknown>;
  successLevel: "info" | "debug";
  startLevel: "info" | "debug" | "none";
}

export class InitializationPhaseHandle {
  readonly id: number;
  readonly name: string;
  private readonly getLogger: () => PluginLogger;
  private readonly options: InternalPhaseOptions;
  private readonly cleanup: (id: number) => void;
  private readonly startedAt = performance.now();
  private readonly slowTimer?: ReturnType<typeof setTimeout>;
  private readonly timeoutTimer?: ReturnType<typeof setTimeout>;
  private hasCompleted = false;

  private timedOut = false;

  constructor(
    id: number,
    name: string,
    loggerFactory: () => PluginLogger,
    options: InternalPhaseOptions,
    cleanup: (id: number) => void
  ) {
    this.id = id;
    this.name = name;
    this.getLogger = loggerFactory;
    this.options = options;
    this.cleanup = cleanup;

    this.logStart();

    if (this.options.slowThresholdMs > 0) {
      this.slowTimer = setTimeout(() => {
        if (!this.hasCompleted) {
          this.emit("debug", "init:slow", {
            elapsedMs: this.getElapsedMs(),
            slowMs: this.options.slowThresholdMs,
          });
        }
      }, this.options.slowThresholdMs);
    }

    if (this.options.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        if (!this.hasCompleted) {
          this.timedOut = true;
          this.emit("error", "init:timeout", {
            elapsedMs: this.getElapsedMs(),
            timeoutMs: this.options.timeoutMs,
          });
        }
      }, this.options.timeoutMs);
    }
  }

  complete(additional?: Record<string, unknown>): void {
    if (this.hasCompleted) {
      return;
    }

    this.hasCompleted = true;
    this.clearTimers();
    this.cleanup(this.id);

    const duration = this.getElapsedMs();
    const metadata = this.mergeMetadata({
      durMs: duration,
      ...(additional ?? {}),
    });

    if (this.timedOut) {
      this.emit("error", "init:late", metadata);
      return;
    }

    if (this.options.slowThresholdMs > 0 && duration > this.options.slowThresholdMs) {
      this.emit("debug", "init:slow-done", {
        ...metadata,
        slowMs: this.options.slowThresholdMs,
      });
      return;
    }

    const level = this.options.successLevel === "info" ? "info" : "debug";
    this.emit(level, "init:done", metadata);
  }

  fail(error: unknown, additional?: Record<string, unknown>): void {
    if (this.hasCompleted) {
      return;
    }

    this.hasCompleted = true;
    this.clearTimers();
    this.cleanup(this.id);

    const metadata = this.mergeMetadata({
      durMs: this.getElapsedMs(),
      ...(additional ?? {}),
    });

    this.emit("error", "init:fail", metadata, error);
  }

  getElapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  private logStart(): void {
    if (this.options.startLevel === "none") {
      return;
    }

    const level = this.options.startLevel === "info" ? "info" : "debug";
    this.emit(level, "init:start", {
      slowMs: this.options.slowThresholdMs,
      timeoutMs: this.options.timeoutMs,
    });
  }

  private clearTimers(): void {
    if (this.slowTimer) {
      clearTimeout(this.slowTimer);
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
    }
  }

  private mergeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(this.options.metadata ?? {}),
      ...metadata,
    };
  }

  private buildContext(metadata: Record<string, unknown>): PluginLogContext {
    return {
      source: "InitializationTracer",
      metadata: {
        phase: this.name,
        id: this.id,
        ...metadata,
      },
    };
  }

  private emit(
    level: "info" | "debug" | "warn" | "error",
    message: string,
    metadata: Record<string, unknown>,
    error?: unknown
  ): void {
    const logger = this.getLogger();
    const context = this.buildContext(metadata);

    switch (level) {
      case "debug":
        logger.debug(message, context);
        break;
      case "warn":
        logger.warn(message, context);
        break;
      case "error":
        logger.error(message, error, context);
        break;
      default:
        logger.info(message, context);
        break;
    }
  }
}
