import type SystemSculptPlugin from "../main";
import type { PluginLogger } from "../utils/PluginLogger";

export interface ResourceSample {
  timestamp: number;
  iso: string;
  heapUsedMB?: number;
  heapLimitMB?: number;
  heapTotalMB?: number;
  rssMB?: number;
  externalMB?: number;
  cpuPercent?: number;
  eventLoopLagMs?: number;
  freezeDeltaMs?: number;
  note?: string;
}

interface MonitorOptions {
  intervalMs?: number;
  metricsFileName?: string;
  sessionId?: string;
}

const DEFAULT_METRICS_FILE = "resource-metrics.ndjson";
const LAG_WARN_THRESHOLD_MS = 200;
const FREEZE_WARN_THRESHOLD_MS = 800;
const ALERT_COOLDOWN_MS: Record<string, number> = {
  memory: 60_000,
  cpu: 60_000,
  lag: 60_000,
  freeze: 5_000,
};

/**
 * Periodically collects runtime resource metrics to help debug lag and memory leaks.
 */
export class ResourceMonitorService {
  private readonly plugin: SystemSculptPlugin;
  private readonly logger: PluginLogger;
  private samplingIntervalMs: number;
  private intervalId: number | null = null;
  private lagIntervalId: number | null = null;
  private startupBurstIntervalId: number | null = null;
  private lastLagMs = 0;
  private lagSampleInterval = 1000;
  private readonly samples: ResourceSample[] = [];
  private readonly maxSamples = 120;
  private lastCpuUsage?: NodeJS.CpuUsage;
  private lastCpuTimestamp?: number;
  private readonly lastAlertAt: Record<string, number> = {};
  private freezeEventHandler?: (event: Event) => void;
  private readonly metricsFileName: string;
  private readonly sessionId?: string;
  private readonly startupBurstDurationMs = 60_000;
  private readonly startupBurstIntervalMs = 3000;

  constructor(plugin: SystemSculptPlugin, options?: MonitorOptions) {
    this.plugin = plugin;
    this.logger = plugin.getLogger();
    this.samplingIntervalMs = options?.intervalMs ?? 15000;
    this.metricsFileName = options?.metricsFileName ?? DEFAULT_METRICS_FILE;
    this.sessionId = options?.sessionId;
  }

  start() {
    if (this.intervalId) {
      return;
    }
    this.logger.debug("Resource monitor starting", {
      source: "ResourceMonitor",
      metadata: { intervalMs: this.samplingIntervalMs },
    });
    this.collectAndPersistSample("startup");
    if (typeof window !== "undefined") {
      this.intervalId = window.setInterval(() => this.collectAndPersistSample(), this.samplingIntervalMs);
      this.startStartupBurstSampling();
      this.startLagProbe();
      this.subscribeToFreezeEvents();
    }
  }

  stop() {
    if (this.intervalId && typeof window !== "undefined") {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.lagIntervalId && typeof window !== "undefined") {
      window.clearInterval(this.lagIntervalId);
      this.lagIntervalId = null;
    }
    if (this.startupBurstIntervalId && typeof window !== "undefined") {
      window.clearInterval(this.startupBurstIntervalId);
      this.startupBurstIntervalId = null;
    }
    if (this.freezeEventHandler && typeof window !== "undefined") {
      window.removeEventListener("systemsculpt:freeze-detected", this.freezeEventHandler as EventListener);
      this.freezeEventHandler = undefined;
    }
  }

  async captureManualSample(note: string = "manual"): Promise<ResourceSample> {
    return this.collectAndPersistSample(note);
  }

  getRecentSamples(limit: number = 10): ResourceSample[] {
    return this.samples.slice(-limit);
  }

  buildSummary(lines: number = 8): string {
    const recent = this.getRecentSamples(lines);
    if (!recent.length) {
      return "No resource samples available yet.";
    }
    return recent
      .map((sample) => {
        const parts: string[] = [];
        parts.push(`${sample.iso}`);
        if (typeof sample.heapUsedMB === "number" && typeof sample.heapLimitMB === "number") {
          const pct = sample.heapLimitMB > 0 ? ((sample.heapUsedMB / sample.heapLimitMB) * 100).toFixed(1) : "0";
          parts.push(`Heap ${sample.heapUsedMB.toFixed(1)} MB (${pct}%)`);
        } else if (typeof sample.heapUsedMB === "number") {
          parts.push(`Heap ${sample.heapUsedMB.toFixed(1)} MB`);
        }
        if (typeof sample.rssMB === "number") {
          parts.push(`RSS ${sample.rssMB.toFixed(1)} MB`);
        }
        if (typeof sample.cpuPercent === "number") {
          parts.push(`CPU ${sample.cpuPercent.toFixed(1)}%`);
        }
        if (typeof sample.eventLoopLagMs === "number") {
          parts.push(`Lag ${sample.eventLoopLagMs.toFixed(1)} ms`);
        }
        if (typeof sample.freezeDeltaMs === "number") {
          parts.push(`Freeze spike ${sample.freezeDeltaMs.toFixed(1)} ms`);
        }
        if (sample.note) {
          parts.push(`[${sample.note}]`);
        }
        return parts.join(" | ");
      })
      .join("\n");
  }

  async exportSummaryReport(lines: number = 12): Promise<{ summary: string; path?: string }> {
    const summary = this.buildSummary(lines);
    const storage = this.plugin.storage;
    if (!storage) {
      return { summary };
    }
    const fileName = `resource-report-${formatFileTimestamp(new Date())}.txt`;
    const result = await storage.writeFile("diagnostics", fileName, summary);
    return {
      summary,
      path: result.success ? result.path : undefined,
    };
  }

  private async collectAndPersistSample(note?: string): Promise<ResourceSample> {
    const sample = this.collectSample(note);
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    this.checkThresholds(sample);
    await this.writeSample(sample);
    return sample;
  }

  private collectSample(note?: string): ResourceSample {
    const timestamp = Date.now();
    const iso = new Date(timestamp).toISOString();
    const memoryUsage = this.readMemoryUsage();
    const cpuPercent = this.captureCpuPercent(timestamp);
    const eventLoopLagMs = this.lastLagMs ? Number(this.lastLagMs.toFixed(1)) : undefined;

    return {
      timestamp,
      iso,
      ...memoryUsage,
      cpuPercent,
      eventLoopLagMs,
      note,
    };
  }

  private readMemoryUsage() {
    const result: Partial<ResourceSample> = {};
    const perfMemory = typeof performance !== "undefined" ? (performance as any).memory : undefined;
    if (perfMemory) {
      if (typeof perfMemory.usedJSHeapSize === "number") {
        result.heapUsedMB = perfMemory.usedJSHeapSize / 1024 / 1024;
      }
      if (typeof perfMemory.totalJSHeapSize === "number") {
        result.heapTotalMB = perfMemory.totalJSHeapSize / 1024 / 1024;
      }
      if (typeof perfMemory.jsHeapSizeLimit === "number") {
        result.heapLimitMB = perfMemory.jsHeapSizeLimit / 1024 / 1024;
      }
    }

    const proc: any = typeof process !== "undefined" ? process : null;
    if (proc?.memoryUsage) {
      const mem = proc.memoryUsage();
      if (typeof mem.rss === "number") {
        result.rssMB = mem.rss / 1024 / 1024;
      }
      if (typeof mem.external === "number") {
        result.externalMB = mem.external / 1024 / 1024;
      }
      if (!result.heapUsedMB && typeof mem.heapUsed === "number") {
        result.heapUsedMB = mem.heapUsed / 1024 / 1024;
      }
      if (!result.heapTotalMB && typeof mem.heapTotal === "number") {
        result.heapTotalMB = mem.heapTotal / 1024 / 1024;
      }
    }

    return result;
  }

  private captureCpuPercent(now: number): number | undefined {
    const proc: any = typeof process !== "undefined" ? process : null;
    if (!proc) {
      return undefined;
    }

    if (typeof proc.getCPUUsage === "function") {
      const usage = proc.getCPUUsage();
      if (typeof usage.percentCPUUsage === "number") {
        return Number(usage.percentCPUUsage.toFixed(1));
      }
      const elapsedMs = now - (this.lastCpuTimestamp ?? now);
      this.lastCpuTimestamp = now;
      const totalMicros = (usage.user ?? 0) + (usage.system ?? 0);
      if (elapsedMs <= 0) {
        return undefined;
      }
      return Number(((totalMicros / 1000) / elapsedMs * 100).toFixed(1));
    }

    if (typeof proc.cpuUsage === "function") {
      const usage: NodeJS.CpuUsage = proc.cpuUsage();
      if (!this.lastCpuUsage || !this.lastCpuTimestamp) {
        this.lastCpuUsage = usage;
        this.lastCpuTimestamp = now;
        return undefined;
      }
      const elapsedMs = now - this.lastCpuTimestamp;
      const diffUser = usage.user - this.lastCpuUsage.user;
      const diffSystem = usage.system - this.lastCpuUsage.system;
      this.lastCpuUsage = usage;
      this.lastCpuTimestamp = now;
      if (elapsedMs <= 0) {
        return undefined;
      }
      const totalMicros = diffUser + diffSystem;
      return Number(((totalMicros / 1000) / elapsedMs * 100).toFixed(1));
    }

    return undefined;
  }

  private async writeSample(sample: ResourceSample) {
    const storage = this.plugin.storage;
    if (!storage) {
      return;
    }
    try {
      const payload = {
        ...sample,
        sessionId: this.sessionId ?? null,
      };
      await storage.appendToFile("diagnostics", this.metricsFileName, `${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.logger.error("Failed to write resource metrics", error, {
        source: "ResourceMonitor",
      });
    }
  }

  private startLagProbe() {
    if (typeof window === "undefined") {
      return;
    }
    let lastTick = performance.now();
    this.lagIntervalId = window.setInterval(() => {
      const now = performance.now();
      const delta = now - lastTick;
      lastTick = now;
      const lag = Math.max(0, delta - this.lagSampleInterval);
      this.lastLagMs = lag;
    }, this.lagSampleInterval);
  }

  private subscribeToFreezeEvents() {
    if (typeof window === "undefined") {
      return;
    }
    this.freezeEventHandler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const deltaMs = detail?.deltaMs;
      if (typeof deltaMs === "number") {
        const timestamp = Date.now();
        const memoryUsage = this.readMemoryUsage();
        const cpuPercent = this.captureCpuPercent(timestamp);
        const lagValue = Math.max(this.lastLagMs, deltaMs);
        const sample: ResourceSample = {
          timestamp,
          iso: new Date(timestamp).toISOString(),
          freezeDeltaMs: deltaMs,
          eventLoopLagMs: Number(lagValue.toFixed(1)),
          note: "freeze",
          ...memoryUsage,
          cpuPercent,
        };
        this.samples.push(sample);
        if (this.samples.length > this.maxSamples) {
          this.samples.shift();
        }
        this.checkThresholds(sample);
        void this.writeSample(sample);
      }
    };
    window.addEventListener("systemsculpt:freeze-detected", this.freezeEventHandler as EventListener);
  }

  private startStartupBurstSampling(): void {
    if (typeof window === "undefined") {
      return;
    }
    const stopAt = Date.now() + this.startupBurstDurationMs;
    this.startupBurstIntervalId = window.setInterval(() => {
      if (Date.now() > stopAt) {
        if (this.startupBurstIntervalId) {
          window.clearInterval(this.startupBurstIntervalId);
          this.startupBurstIntervalId = null;
        }
        return;
      }
      void this.collectAndPersistSample("startup-burst");
    }, this.startupBurstIntervalMs);
  }

  private checkThresholds(sample: ResourceSample) {
    const now = sample.timestamp;
    if (
      typeof sample.heapLimitMB === "number" &&
      typeof sample.heapUsedMB === "number" &&
      sample.heapLimitMB > 0
    ) {
      const pct = (sample.heapUsedMB / sample.heapLimitMB) * 100;
      if (pct > 85 && this.shouldAlert("memory", now)) {
        this.logger.debug("High heap usage detected", {
          source: "ResourceMonitor",
          metadata: {
            heapUsedMB: Number(sample.heapUsedMB.toFixed(1)),
            heapLimitMB: Number(sample.heapLimitMB.toFixed(1)),
            percent: Number(pct.toFixed(1)),
          },
        });
      }
    }

    if (typeof sample.cpuPercent === "number" && sample.cpuPercent > 85 && this.shouldAlert("cpu", now)) {
      this.logger.debug("Sustained CPU usage detected", {
        source: "ResourceMonitor",
        metadata: {
          cpuPercent: sample.cpuPercent,
        },
      });
    }

    const isFreezeSample = typeof sample.freezeDeltaMs === "number" || sample.note === "freeze";

    if (
      typeof sample.eventLoopLagMs === "number" &&
      sample.eventLoopLagMs > LAG_WARN_THRESHOLD_MS &&
      !isFreezeSample &&
      this.shouldAlert("lag", now)
    ) {
      this.logger.debug("Event loop lag detected", {
        source: "ResourceMonitor",
        metadata: {
          lagMs: Number(sample.eventLoopLagMs.toFixed(1)),
        },
      });
    }

    if (typeof sample.freezeDeltaMs === "number") {
      if (sample.freezeDeltaMs >= FREEZE_WARN_THRESHOLD_MS && this.shouldAlert("freeze", now)) {
        this.logger.debug("Freeze spike reported", {
          source: "ResourceMonitor",
          metadata: {
            freezeDeltaMs: sample.freezeDeltaMs,
            lagMs: sample.eventLoopLagMs,
            heapUsedMB: typeof sample.heapUsedMB === "number" ? Number(sample.heapUsedMB.toFixed(1)) : undefined,
            rssMB: typeof sample.rssMB === "number" ? Number(sample.rssMB.toFixed(1)) : undefined,
          },
        });
      }
    }
  }

  private shouldAlert(kind: string, now: number): boolean {
    const cooldown = ALERT_COOLDOWN_MS[kind] ?? 60_000;
    const last = this.lastAlertAt[kind] ?? 0;
    if (cooldown > 0 && now - last < cooldown) {
      return false;
    }
    this.lastAlertAt[kind] = now;
    return true;
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
