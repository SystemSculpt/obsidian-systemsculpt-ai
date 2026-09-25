import type SystemSculptPlugin from "../main";
import {
  getDesktopProcess,
  type DesktopCpuUsage,
} from "../platform/desktopOnly";
import type { PluginLogger } from "../utils/PluginLogger";
import { FreezeMonitor, type FreezeMonitorOptions, type FreezeReport } from "./FreezeMonitor";

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
  /** Periodic sampling interval while recording; values below one minute are raised to one minute. */
  intervalMs?: number;
  metricsFileName?: string;
  sessionId?: string;
  /** Defaults to the host PerformanceObserver. */
  freezeObserverConstructor?: FreezeMonitorOptions["observerConstructor"];
}

type PerformanceWithMemory = Performance & {
  memory?: Readonly<{
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  }>;
};

const DEFAULT_METRICS_FILE = "resource-metrics.ndjson";
const INCIDENT_TERMINAL_NOTE = "incident-terminal";
const RECORDING_STARTED_NOTE = "recording-started";
const FREEZE_NOTE = "freeze";
const DEFAULT_INCIDENT_WINDOW_BEFORE_MS = 60_000;
const DEFAULT_INCIDENT_WINDOW_AFTER_MS = 5_000;
const DEFAULT_INCIDENT_WINDOW_LIMIT = 12;
const MAX_INCIDENT_WINDOW_MS = 5 * 60_000;
const MAX_INCIDENT_WINDOW_LIMIT = 24;
const MIN_SAMPLING_INTERVAL_MS = 60_000;
const FLUSH_BATCH_SIZE = 5;
const MAX_PENDING_WRITES = 120;
const MAX_METRICS_FILE_BYTES = 1_000_000;
const FREEZE_THRESHOLD_MS = 200;
const FREEZE_MIN_REPORT_INTERVAL_MS = 2_000;
const FREEZE_WARN_THRESHOLD_MS = 800;
const ALERT_COOLDOWN_MS: Record<string, number> = {
  memory: 60_000,
  cpu: 60_000,
  freeze: 5_000,
};

/**
 * Samples runtime resource metrics for support snapshots and incident reports.
 *
 * On-demand samples are always available and stay in memory. Periodic
 * sampling, long-frame observation and the metrics file run only while
 * diagnostics recording is on (#337): at most one sample per minute, paused
 * while the window is hidden, appended in batches to a size-capped file.
 */
export class ResourceMonitorService {
  private readonly plugin: SystemSculptPlugin;
  private readonly logger: PluginLogger;
  private readonly samplingIntervalMs: number;
  private readonly metricsFileName: string;
  private readonly sessionId?: string;
  private readonly freezeMonitor: FreezeMonitor;
  private readonly samples: ResourceSample[] = [];
  private readonly maxSamples = 120;
  private readonly pendingWrites: ResourceSample[] = [];
  /** Samples captured while recording; only these may ever reach the metrics file. */
  private readonly persistableSamples = new WeakSet<ResourceSample>();
  private samplesSinceFlush = 0;
  private recording = false;
  private intervalId: number | null = null;
  private visibilityDocument: Document | null = null;
  private unloadCleanupRegistered = false;
  private activeFlush: Promise<void> | null = null;
  private metricsFileBytes: number | null = null;
  private lastCpuUsage?: DesktopCpuUsage;
  private lastCpuTimestamp?: number;
  private readonly lastAlertAt: Record<string, number> = {};

  constructor(plugin: SystemSculptPlugin, options?: MonitorOptions) {
    this.plugin = plugin;
    this.logger = plugin.getLogger();
    const intervalMs = options?.intervalMs;
    this.samplingIntervalMs = typeof intervalMs === "number" && Number.isFinite(intervalMs)
      ? Math.max(MIN_SAMPLING_INTERVAL_MS, intervalMs)
      : MIN_SAMPLING_INTERVAL_MS;
    this.metricsFileName = options?.metricsFileName ?? DEFAULT_METRICS_FILE;
    this.sessionId = options?.sessionId;
    this.freezeMonitor = new FreezeMonitor({
      thresholdMs: FREEZE_THRESHOLD_MS,
      minReportIntervalMs: FREEZE_MIN_REPORT_INTERVAL_MS,
      observerConstructor: options?.freezeObserverConstructor,
      onFreeze: (report) => this.recordFreeze(report),
    });
  }

  /** Starts periodic recording. Idempotent. */
  start(): void {
    if (this.recording) {
      return;
    }
    this.recording = true;
    this.registerUnloadCleanup();
    this.logger.debug("Resource monitor recording started", {
      source: "ResourceMonitor",
      metadata: { intervalMs: this.samplingIntervalMs },
    });
    this.recordSampleSafely(RECORDING_STARTED_NOTE);
    if (typeof window === "undefined") {
      return;
    }
    this.freezeMonitor.start();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.visibilityDocument = document;
    }
    if (!this.visibilityDocument?.hidden) {
      this.startSampling();
    }
  }

  /** Stops periodic recording. Queued samples stay pending until flushPending(). */
  stop(): void {
    this.recording = false;
    this.stopSampling();
    this.freezeMonitor.stop();
    this.visibilityDocument?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityDocument = null;
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Appends every queued sample. Never rejects. */
  flushPending(): Promise<void> {
    if (this.activeFlush) {
      return this.activeFlush.then(() => this.flushPending());
    }
    if (this.pendingWrites.length === 0) {
      return Promise.resolve();
    }
    this.samplesSinceFlush = 0;
    const flush: Promise<void> = this.writeBatch()
      .catch(() => undefined)
      .finally(() => {
        if (this.activeFlush === flush) this.activeFlush = null;
      });
    this.activeFlush = flush;
    return flush;
  }

  async captureManualSample(note: string = "manual"): Promise<ResourceSample> {
    return this.recordSample(note);
  }

  /**
   * Captures the terminal resource state without delaying incident handling on diagnostics storage.
   * The returned projection contains only allowlisted scalar metrics and never exposes the internal note.
   */
  captureIncidentTerminalSample(): IncidentResourceSample {
    const sample = this.collectSample(INCIDENT_TERMINAL_NOTE);
    this.bufferAndCheckSample(sample);
    try {
      this.enqueueWrite(sample);
    } catch {
      // Resource diagnostics must stay observational.
    }
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

  private readonly handleVisibilityChange = (): void => {
    if (!this.recording) {
      return;
    }
    if (this.visibilityDocument?.hidden) {
      // Hidden windows get no samples: nothing changes that a user can see,
      // and a sleeping laptop should not wake just to record it.
      this.stopSampling();
      void this.flushPending();
    } else {
      this.startSampling();
    }
  };

  private startSampling(): void {
    if (this.intervalId !== null || typeof window === "undefined") {
      return;
    }
    this.intervalId = window.setInterval(() => this.recordSampleSafely(), this.samplingIntervalMs);
  }

  private stopSampling(): void {
    if (this.intervalId === null) {
      return;
    }
    if (typeof window !== "undefined") {
      window.clearInterval(this.intervalId);
    }
    this.intervalId = null;
  }

  private registerUnloadCleanup(): void {
    if (this.unloadCleanupRegistered || typeof this.plugin.register !== "function") {
      return;
    }
    this.unloadCleanupRegistered = true;
    // One registration ties the timer, observer and listener to plugin unload,
    // even when a teardown path never reaches stop().
    this.plugin.register(() => this.stop());
  }

  private recordSample(note?: string): ResourceSample {
    const sample = this.collectSample(note);
    this.bufferAndCheckSample(sample);
    this.enqueueWrite(sample);
    return sample;
  }

  private recordSampleSafely(note?: string): void {
    try {
      this.recordSample(note);
    } catch {
      // Periodic diagnostics must never add a failure to the host event loop.
    }
  }

  private recordFreeze(report: FreezeReport): void {
    try {
      if (!this.recording) {
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

      const sample: ResourceSample = {
        timestamp,
        iso: new Date(timestamp).toISOString(),
        freezeDeltaMs: report.durationMs,
        eventLoopLagMs: report.durationMs,
        note: FREEZE_NOTE,
        ...memoryUsage,
        cpuPercent,
      };
      try {
        this.bufferAndCheckSample(sample);
      } catch {
        // Buffer and threshold logging failures must not block best-effort persistence.
      }
      this.enqueueWrite(sample);
    } catch {
      // Freeze reporting must never add a second failure to the application event loop.
    }
  }

  private bufferAndCheckSample(sample: ResourceSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    this.checkThresholds(sample);
  }

  /**
   * Queues a sample for the metrics file. A sample taken while not recording
   * stays in memory only and is never written later, including by the size-cap
   * rewrite after recording is turned on.
   */
  private enqueueWrite(sample: ResourceSample): void {
    if (!this.recording) {
      return;
    }
    this.persistableSamples.add(sample);
    this.pendingWrites.push(sample);
    if (this.pendingWrites.length > MAX_PENDING_WRITES) {
      this.pendingWrites.shift();
    }
    // Count new samples, not queue length: a batch kept after a failed write
    // must not turn every later sample into another write attempt.
    this.samplesSinceFlush += 1;
    if (this.samplesSinceFlush >= FLUSH_BATCH_SIZE) {
      void this.flushPending();
    }
  }

  private collectSample(note?: string): ResourceSample {
    const timestamp = Date.now();
    const iso = new Date(timestamp).toISOString();
    const memoryUsage = this.readMemoryUsage();
    const cpuPercent = this.captureCpuPercent(timestamp);

    return {
      timestamp,
      iso,
      ...memoryUsage,
      cpuPercent,
      note,
    };
  }

  private readMemoryUsage() {
    const result: Partial<ResourceSample> = {};
    const perfMemory = typeof performance !== "undefined"
      ? (performance as PerformanceWithMemory).memory
      : undefined;
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

    const proc = getDesktopProcess();
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
    const proc = getDesktopProcess();
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
      const usage = proc.cpuUsage();
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

  private serializeSample(sample: ResourceSample): string {
    return `${JSON.stringify({ ...sample, sessionId: this.sessionId ?? null })}\n`;
  }

  private async writeBatch(): Promise<void> {
    const storage = this.plugin.storage;
    if (!storage) {
      return;
    }
    // The batch leaves the queue only after the append succeeds, so a failed
    // write is retried by the next flush instead of dropping its samples.
    const batch = this.pendingWrites.slice();
    const payload = batch.map((sample) => this.serializeSample(sample)).join("");
    try {
      const result = await storage.appendToFile("diagnostics", this.metricsFileName, payload);
      if (result?.success === false) {
        this.reportWriteFailure(undefined);
        return;
      }
      const written = new Set(batch);
      const remaining = this.pendingWrites.filter((sample) => !written.has(sample));
      this.pendingWrites.splice(0, this.pendingWrites.length, ...remaining);
      await this.enforceMetricsFileCap(payload);
    } catch (error) {
      this.reportWriteFailure(error);
    }
  }

  /**
   * Caps the in-session metrics file like the plugin log's 1 MB cap: past the
   * limit it is rewritten with the newest in-memory samples. Only the first
   * batch of a session stats the file; later batches count appended bytes.
   */
  private async enforceMetricsFileCap(appended: string): Promise<void> {
    const storage = this.plugin.storage;
    if (!storage) {
      return;
    }
    // Samples serialize to ASCII JSON, so string length is the byte count.
    this.metricsFileBytes = this.metricsFileBytes === null
      ? (await this.readMetricsFileBytes()) ?? appended.length
      : this.metricsFileBytes + appended.length;
    if (this.metricsFileBytes <= MAX_METRICS_FILE_BYTES) {
      return;
    }
    const retained = this.samples
      .filter((sample) => this.persistableSamples.has(sample))
      .map((sample) => this.serializeSample(sample))
      .join("");
    const result = await storage.writeFile("diagnostics", this.metricsFileName, retained);
    this.metricsFileBytes = result?.success === false ? null : retained.length;
  }

  private async readMetricsFileBytes(): Promise<number | null> {
    try {
      const storage = this.plugin.storage;
      const stat = await this.plugin.app.vault.adapter.stat(storage.getPath("diagnostics", this.metricsFileName));
      return stat && Number.isFinite(stat.size) ? stat.size : null;
    } catch {
      return null;
    }
  }

  private reportWriteFailure(error: unknown): void {
    try {
      this.logger.error("Failed to write resource metrics", error, {
        source: "ResourceMonitor",
      });
    } catch {
      // Resource diagnostics must stay observational, including logger failures.
    }
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
