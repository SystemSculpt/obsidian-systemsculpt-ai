/**
 * FreezeMonitor - reports long main-thread stalls without polling.
 *
 * Observes `long-animation-frame` entries, or `longtask` on hosts without
 * them, through a PerformanceObserver. Unlike a polling timer it costs nothing
 * while the app is idle, and Chromium's timer throttling in hidden or occluded
 * windows cannot masquerade as a freeze (#325, #337).
 */
export type FreezeEntryType = "long-animation-frame" | "longtask";

export type FreezeReport = Readonly<{
  durationMs: number;
  entryType: FreezeEntryType;
}>;

type PerformanceObserverConstructor = {
  new (callback: PerformanceObserverCallback): PerformanceObserver;
  readonly supportedEntryTypes?: readonly string[];
};

export type FreezeMonitorOptions = Readonly<{
  onFreeze: (report: FreezeReport) => void;
  thresholdMs?: number;
  minReportIntervalMs?: number;
  /** Defaults to the host PerformanceObserver. */
  observerConstructor?: PerformanceObserverConstructor;
  now?: () => number;
}>;

const PREFERRED_ENTRY_TYPES: readonly FreezeEntryType[] = ["long-animation-frame", "longtask"];
const DEFAULT_THRESHOLD_MS = 200;
const DEFAULT_MIN_REPORT_INTERVAL_MS = 2_000;

/** Picks the richest long-frame entry type the host can observe, if any. */
export function resolveFreezeEntryType(
  observerConstructor: PerformanceObserverConstructor | undefined,
): FreezeEntryType | null {
  try {
    const supported = observerConstructor?.supportedEntryTypes;
    if (!supported || typeof supported.includes !== "function") return null;
    return PREFERRED_ENTRY_TYPES.find((type) => supported.includes(type)) ?? null;
  } catch {
    return null;
  }
}

export class FreezeMonitor {
  private readonly onFreeze: FreezeMonitorOptions["onFreeze"];
  private readonly thresholdMs: number;
  private readonly minReportIntervalMs: number;
  private readonly observerConstructor?: PerformanceObserverConstructor;
  private readonly now: () => number;
  private observer: PerformanceObserver | null = null;
  private entryType: FreezeEntryType | null = null;
  private lastReportAt = Number.NEGATIVE_INFINITY;

  constructor(options: FreezeMonitorOptions) {
    this.onFreeze = options.onFreeze;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.minReportIntervalMs = options.minReportIntervalMs ?? DEFAULT_MIN_REPORT_INTERVAL_MS;
    this.observerConstructor = options.observerConstructor
      ?? (typeof PerformanceObserver === "function" ? PerformanceObserver : undefined);
    this.now = options.now ?? (() => performance.now());
  }

  /** Starts observing and returns the entry type, or null when the host cannot report long frames. */
  start(): FreezeEntryType | null {
    if (this.observer) return this.entryType;
    const Observer = this.observerConstructor;
    const entryType = resolveFreezeEntryType(Observer);
    if (!Observer || !entryType) return null;
    try {
      const observer = new Observer((list) => this.handleEntries(list));
      observer.observe({ type: entryType });
      this.observer = observer;
      this.entryType = entryType;
      return entryType;
    } catch {
      return null;
    }
  }

  stop(): void {
    const observer = this.observer;
    this.observer = null;
    this.entryType = null;
    try {
      observer?.disconnect();
    } catch {
      // A stale observer must not block diagnostics teardown.
    }
  }

  isObserving(): boolean {
    return this.observer !== null;
  }

  private handleEntries(list: PerformanceObserverEntryList): void {
    try {
      const entryType = this.entryType;
      if (!entryType) return;
      let longestMs = 0;
      for (const entry of list.getEntries()) {
        if (entry.duration > longestMs) longestMs = entry.duration;
      }
      if (!(longestMs >= this.thresholdMs)) return;
      const now = this.now();
      if (now - this.lastReportAt < this.minReportIntervalMs) return;
      this.lastReportAt = now;
      this.onFreeze({ durationMs: Number(longestMs.toFixed(1)), entryType });
    } catch {
      // Freeze reporting must never affect the monitored UI thread.
    }
  }
}
