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

export type IncidentResourceSample = Readonly<{
  captured_at: string;
  heap_used_mb?: number;
  heap_limit_mb?: number;
  rss_mb?: number;
  cpu_percent?: number;
  event_loop_lag_ms?: number;
  freeze_delta_ms?: number;
}>;

export interface IncidentResourceWindowOptions {
  beforeMs?: number;
  afterMs?: number;
  limit?: number;
}

interface MonitorOptions {
  intervalMs?: number;
  metricsFileName?: string;
  sessionId?: string;
}

const DEFAULT_METRICS_FILE = "resource-metrics.ndjson";
const INCIDENT_TERMINAL_NOTE = "incident-terminal";
const DEFAULT_INCIDENT_WINDOW_BEFORE_MS = 60_000;
const DEFAULT_INCIDENT_WINDOW_AFTER_MS = 5_000;
const DEFAULT_INCIDENT_WINDOW_LIMIT = 12;
const MAX_INCIDENT_WINDOW_MS = 5 * 60_000;
const MAX_INCIDENT_WINDOW_LIMIT = 24;
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
    void this.collectAndPersistSample("startup").catch(() => undefined);
    if (typeof window !== "undefined") {
      this.intervalId = window.setInterval(() => {
        void this.collectAndPersistSample().catch(() => undefined);
      }, this.samplingIntervalMs);
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

  /**
   * Captures the terminal resource state without delaying incident handling on diagnostics storage.
   * The returned projection contains only allowlisted scalar metrics and never exposes the internal note.
   */
  captureIncidentTerminalSample(): IncidentResourceSample {
    const sample = this.collectSample(INCIDENT_TERMINAL_NOTE);
    this.bufferAndCheckSample(sample);
    this.writeSampleDetached(sample);
    return projectIncidentResourceSample(sample) ?? Object.freeze({ captured_at: sample.iso });
  }

  getRecentSamples(limit: number = 10): ResourceSample[] {
    return this.samples.slice(-limit);
  }

  /**
   * Returns a count-bounded and time-bounded incident-safe window in chronological order.
   */
  getIncidentResourceSamplesAround(
    timestamp: number,
    options: IncidentResourceWindowOptions = {},
  ): IncidentResourceSample[] {
    if (!Number.isFinite(timestamp)) {
      return [];
    }

    const beforeMs = normalizeBoundedWholeNumber(
      options.beforeMs,
      DEFAULT_INCIDENT_WINDOW_BEFORE_MS,
      MAX_INCIDENT_WINDOW_MS,
    );
    const afterMs = normalizeBoundedWholeNumber(
      options.afterMs,
      DEFAULT_INCIDENT_WINDOW_AFTER_MS,
      MAX_INCIDENT_WINDOW_MS,
    );
    const limit = normalizeBoundedWholeNumber(
      options.limit,
      DEFAULT_INCIDENT_WINDOW_LIMIT,
      MAX_INCIDENT_WINDOW_LIMIT,
    );
    if (limit === 0) {
      return [];
    }

    const windowStart = timestamp - beforeMs;
    const windowEnd = timestamp + afterMs;
    const candidates = this.samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ sample }) => (
        Number.isFinite(sample.timestamp)
        && sample.timestamp >= windowStart
        && sample.timestamp <= windowEnd
      ));

    const selected = candidates.length <= limit
      ? candidates
      : candidates
        .sort((left, right) => {
          const distance = Math.abs(left.sample.timestamp - timestamp) - Math.abs(right.sample.timestamp - timestamp);
          if (distance !== 0) return distance;
          const capturedAt = left.sample.timestamp - right.sample.timestamp;
          return capturedAt !== 0 ? capturedAt : left.index - right.index;
        })
        .slice(0, limit);

    return selected
      .sort((left, right) => {
        const capturedAt = left.sample.timestamp - right.sample.timestamp;
        return capturedAt !== 0 ? capturedAt : left.index - right.index;
      })
      .map(({ sample }) => projectIncidentResourceSample(sample))
      .filter((sample): sample is IncidentResourceSample => sample !== null);
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
    this.bufferAndCheckSample(sample);
    await this.writeSample(sample);
    return sample;
  }

  private bufferAndCheckSample(sample: ResourceSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    this.checkThresholds(sample);
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
      const result = await storage.appendToFile("diagnostics", this.metricsFileName, `${JSON.stringify(payload)}\n`);
      if (result?.success === false) {
        this.logger.error("Failed to write resource metrics", undefined, {
          source: "ResourceMonitor",
        });
      }
    } catch (error) {
      this.logger.error("Failed to write resource metrics", error, {
        source: "ResourceMonitor",
      });
    }
  }

  private writeSampleDetached(sample: ResourceSample): void {
    try {
      void this.writeSample(sample).catch(() => undefined);
    } catch {
      // Resource diagnostics must stay observational, including synchronous write failures.
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
      try {
        const detail = (event as CustomEvent).detail;
        const deltaMs = detail?.deltaMs;
        if (typeof deltaMs !== "number") {
          return;
        }

        const timestamp = Date.now();
        let memoryUsage: Partial<ResourceSample> = {};
        try {
          memoryUsage = { ...this.readMemoryUsage() };
        } catch {
          // A failed platform metric must not suppress the remaining freeze evidence.
        }

        let cpuPercent: number | undefined;
        try {
          cpuPercent = this.captureCpuPercent(timestamp);
        } catch {
          // CPU APIs differ across Electron versions and can fail independently.
        }

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
        try {
          this.bufferAndCheckSample(sample);
        } catch {
          // Buffer and threshold logging failures must not block best-effort persistence.
        }
        this.writeSampleDetached(sample);
      } catch {
        // Freeze reporting must never add a second failure to the application event loop.
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
      void this.collectAndPersistSample("startup-burst").catch(() => undefined);
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

/**
 * Projects an internal sample through the only resource fields allowed in incident reports.
 */
export function projectIncidentResourceSample(sample: unknown): IncidentResourceSample | null {
  try {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
      return null;
    }

    const candidate = sample as Record<string, unknown>;
    // Read every allowlisted property once. A getter cannot pass validation
    // with one value and then place a different value in the report.
    const raw = {
      iso: candidate.iso,
      heapUsedMB: candidate.heapUsedMB,
      heapLimitMB: candidate.heapLimitMB,
      rssMB: candidate.rssMB,
      cpuPercent: candidate.cpuPercent,
      eventLoopLagMs: candidate.eventLoopLagMs,
      freezeDeltaMs: candidate.freezeDeltaMs,
    };
    if (typeof raw.iso !== "string" || raw.iso.length > 40) {
      return null;
    }
    const parsedCapturedAt = Date.parse(raw.iso);
    if (!Number.isFinite(parsedCapturedAt) || new Date(parsedCapturedAt).toISOString() !== raw.iso) {
      return null;
    }

    const projected: {
      captured_at: string;
      heap_used_mb?: number;
      heap_limit_mb?: number;
      rss_mb?: number;
      cpu_percent?: number;
      event_loop_lag_ms?: number;
      freeze_delta_ms?: number;
    } = {
      captured_at: raw.iso,
    };
    const metrics = [
      ["heap_used_mb", raw.heapUsedMB],
      ["heap_limit_mb", raw.heapLimitMB],
      ["rss_mb", raw.rssMB],
      ["cpu_percent", raw.cpuPercent],
      ["event_loop_lag_ms", raw.eventLoopLagMs],
      ["freeze_delta_ms", raw.freezeDeltaMs],
    ] as const;
    for (const [key, value] of metrics) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        continue;
      }
      projected[key] = Math.round(value * 10) / 10;
    }

    return Object.freeze(projected);
  } catch {
    return null;
  }
}

function normalizeBoundedWholeNumber(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(0, Math.floor(value)));
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
