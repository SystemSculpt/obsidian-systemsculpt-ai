import type SystemSculptPlugin from "../main";
import type { PluginLogger } from "../utils/PluginLogger";
import { FunctionProfiler, FunctionTrace, getFunctionProfiler } from "./FunctionProfiler";

export interface PerformanceDiagnosticsOptions {
  operationsFileName?: string;
  sessionId?: string;
  blockedModules?: string[];
}

export interface InstrumentOptions {
  include?: string[];
  includePrefixes?: string[];
  includeMatches?: RegExp;
  exclude?: string[];
}

export interface OperationStat {
  key: string;
  module: string;
  name: string;
  count: number;
  totalDuration: number;
  totalMemoryDelta: number;
  maxDuration: number;
  maxMemoryDelta: number;
  lastTimestamp: number;
}

const PROFILER_MARK = Symbol("systemsculpt:profiled");
const DEFAULT_OPERATIONS_FILE = "operations.ndjson";

/**
 * Aggregates function-level diagnostics so we can identify hotspots quickly.
 */
export class PerformanceDiagnosticsService {
  private readonly plugin: SystemSculptPlugin;
  private readonly logger: PluginLogger;
  private readonly profiler: FunctionProfiler;
  private readonly stats = new Map<string, OperationStat>();
  private readonly instrumentedPrototypes = new WeakSet<object>();
  private readonly operationsFileName: string;
  private readonly sessionId?: string;
  private readonly blockedModules: Set<string>;
  private isPersistingTrace = false;

  constructor(plugin: SystemSculptPlugin, options?: PerformanceDiagnosticsOptions) {
    this.plugin = plugin;
    this.logger = plugin.getLogger();
    this.profiler = getFunctionProfiler();
    this.operationsFileName = options?.operationsFileName ?? DEFAULT_OPERATIONS_FILE;
    this.sessionId = options?.sessionId;
    this.blockedModules = new Set(options?.blockedModules ?? []);
    this.profiler.addTraceCompleteListener((trace) => {
      this.handleTraceComplete(trace);
    });
  }

  instrumentPluginLifecycle(pluginInstance: SystemSculptPlugin): void {
    this.instrumentObject(pluginInstance, "SystemSculptPlugin", {
      includePrefixes: ["initialize", "run", "register", "ensure", "load", "save", "process", "handle"],
      exclude: ["get", "set", "on"],
    });
  }

  instrumentObject(instance: unknown, moduleName: string, options?: InstrumentOptions): number {
    if (!instance || typeof instance !== "object") {
      return 0;
    }
    if (this.blockedModules.has(moduleName)) {
      return 0;
    }

    const prototype = Object.getPrototypeOf(instance);
    if (!prototype || prototype === Object.prototype || this.instrumentedPrototypes.has(prototype)) {
      return 0;
    }

    const instrumented: string[] = [];
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor") continue;

      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") {
        continue;
      }

      if (!this.shouldInclude(name, options)) {
        continue;
      }

      const original = descriptor.value;
      if ((original as any)[PROFILER_MARK]) {
        continue;
      }

      const wrapped = this.profiler.profileFunction(original, name, moduleName);
      (wrapped as any)[PROFILER_MARK] = true;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value: wrapped,
      });
      instrumented.push(name);
    }

    if (instrumented.length > 0) {
      this.instrumentedPrototypes.add(prototype);
      this.logger.debug("Performance instrumentation applied", {
        source: "PerformanceDiagnostics",
        metadata: {
          moduleName,
          methods: instrumented,
        },
      });
    }

    return instrumented.length;
  }

  profileFunction<T extends (...args: any[]) => any>(fn: T, moduleName: string, functionName: string): T {
    return this.profiler.profileFunction(fn, functionName, moduleName);
  }

  getHotspots(limit: number = 10, sort: "duration" | "memory" = "duration"): OperationStat[] {
    const bucket = Array.from(this.stats.values());
    if (sort === "memory") {
      bucket.sort((a, b) => b.totalMemoryDelta - a.totalMemoryDelta);
    } else {
      bucket.sort((a, b) => b.totalDuration - a.totalDuration);
    }
    return bucket.slice(0, limit);
  }

  buildHotspotReport(limit: number = 10): string {
    const hotspots = this.getHotspots(limit);
    if (hotspots.length === 0) {
      return "No profiled functions yet. Interact with the plugin to capture traces.";
    }

    const lines: string[] = [];
    lines.push(`Performance hotspots (top ${hotspots.length}):`);
    hotspots.forEach((stat, index) => {
      const avg = stat.count > 0 ? stat.totalDuration / stat.count : 0;
      const avgMem = stat.count > 0 ? stat.totalMemoryDelta / stat.count : 0;
      lines.push(
        `${index + 1}. ${stat.module}.${stat.name} — avg ${avg.toFixed(2)}ms (max ${stat.maxDuration.toFixed(
          2
        )}ms), avg Δ ${formatMB(avgMem).toFixed(3)} MB`
      );
    });
    return lines.join("\n");
  }

  async exportHotspotReport(limit: number = 10): Promise<{ text: string; path?: string }> {
    const report = this.buildHotspotReport(limit);
    const storage = this.plugin.storage;
    if (!storage) {
      return { text: report };
    }
    const fileName = `performance-report-${formatFileTimestamp(new Date())}.txt`;
    const result = await storage.writeFile("diagnostics", fileName, report);
    return {
      text: report,
      path: result.success ? result.path : undefined,
    };
  }

  private handleTraceComplete(trace: FunctionTrace): void {
    if (typeof trace.duration !== "number") {
      return;
    }
    const key = `${trace.module}.${trace.name}`;
    const stat =
      this.stats.get(key) ??
      ({
        key,
        module: trace.module,
        name: trace.name,
        count: 0,
        totalDuration: 0,
        totalMemoryDelta: 0,
        maxDuration: 0,
        maxMemoryDelta: 0,
        lastTimestamp: 0,
      } as OperationStat);

    stat.count += 1;
    stat.totalDuration += trace.duration;
    stat.maxDuration = Math.max(stat.maxDuration, trace.duration);
    if (typeof trace.memoryDelta === "number") {
      stat.totalMemoryDelta += trace.memoryDelta;
      stat.maxMemoryDelta = Math.max(stat.maxMemoryDelta, trace.memoryDelta);
    }
    stat.lastTimestamp = Date.now();
    this.stats.set(key, stat);

    void this.persistTrace(trace);
  }

  private async persistTrace(trace: FunctionTrace): Promise<void> {
    const storage = this.plugin.storage;
    if (!storage) return;

    if (this.isPersistingTrace) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      module: trace.module,
      name: trace.name,
      durationMs: typeof trace.duration === "number" ? Number(trace.duration.toFixed(3)) : undefined,
      memoryDeltaMB:
        typeof trace.memoryDelta === "number" ? Number(formatMB(trace.memoryDelta).toFixed(3)) : undefined,
      callStack: trace.callStack,
      sessionId: this.sessionId ?? null,
    };

    this.isPersistingTrace = true;
    try {
      const serialized = `${JSON.stringify(payload)}\n`;
      const targets = [this.operationsFileName];
      if (this.sessionId) {
        const sessionFile = `operations-${this.sessionId}.ndjson`;
        if (!targets.includes(sessionFile)) {
          targets.push(sessionFile);
        }
      }
      for (const fileName of targets) {
        await storage.appendToFile("diagnostics", fileName, serialized);
      }
    } catch (error) {
      this.logger.warn("Failed to persist performance trace", {
        source: "PerformanceDiagnostics",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.isPersistingTrace = false;
    }
  }

  private shouldInclude(name: string, options?: InstrumentOptions): boolean {
    if (!options) {
      return true;
    }
    if (options.exclude?.some((prefix) => name.startsWith(prefix))) {
      return false;
    }
    if (options.include?.includes(name)) {
      return true;
    }
    if (options.includePrefixes?.some((prefix) => name.startsWith(prefix))) {
      return true;
    }
    if (options.includeMatches && options.includeMatches.test(name)) {
      return true;
    }
    if (!options.include && !options.includePrefixes && !options.includeMatches) {
      return true;
    }
    return false;
  }
}

function formatFileTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function formatMB(bytes: number): number {
  return bytes / 1024 / 1024;
}
