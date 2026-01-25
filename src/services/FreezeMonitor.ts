/**
 * FreezeMonitor - lightweight main-thread lag detector with breadcrumbs.
 *
 * - Measures event-loop lag using setInterval
 * - Records recent breadcrumb marks (event starts/ends)
 * - Emits a compact console report when a lag spike is detected
 *
 * Usage:
 *   FreezeMonitor.start();
 *   FreezeMonitor.mark('workspace:active-leaf-change:start', { path });
 */
export type Breadcrumb = {
  t: number;          // performance.now timestamp
  label: string;      // event label
  data?: Record<string, any>; // optional metadata
};

export class FreezeMonitor {
  private static breadcrumbs: Breadcrumb[] = [];
  private static maxBreadcrumbs = 100; // keep last 100 marks
  private static intervalId: number | null = null;
  private static lastTick = performance.now();
  private static thresholdMs = 200; // lag threshold in ms
  private static enabled = true;
  private static lastReportTime = 0;
  private static minReportIntervalMs = 3000; // avoid flooding

  public static start(options?: { thresholdMs?: number; maxBreadcrumbs?: number; minReportIntervalMs?: number; enabled?: boolean }) {
    if (typeof window === 'undefined') return; // SSR/Node safety
    if (this.intervalId) return;
    if (options?.thresholdMs) this.thresholdMs = options.thresholdMs;
    if (options?.maxBreadcrumbs) this.maxBreadcrumbs = options.maxBreadcrumbs;
    if (options?.minReportIntervalMs) this.minReportIntervalMs = options.minReportIntervalMs;
    if (options?.enabled === false) this.enabled = false;

    this.lastTick = performance.now();
    this.intervalId = window.setInterval(() => {
      if (!this.enabled) return;
      const now = performance.now();
      const delta = now - this.lastTick;
      this.lastTick = now;
      // Allow some jitter; flag only larger spikes
      if (delta > (50 + this.thresholdMs)) {
        this.reportLag(delta);
      }
    }, 50);
  }

  public static stop() {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public static mark(label: string, data?: Record<string, any>) {
    if (!this.enabled) return;
    const entry: Breadcrumb = { t: performance.now(), label, data };
    this.breadcrumbs.push(entry);
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }
  }

  private static reportLag(deltaMs: number) {
    const now = performance.now();
    if (now - this.lastReportTime < this.minReportIntervalMs) return;
    this.lastReportTime = now;

    // Prepare a compact snapshot of the last N breadcrumbs
    const tail = this.breadcrumbs.slice(-15);
    const snapshot = tail.map((b, i) => {
      const prev = i > 0 ? tail[i - 1].t : (tail[0]?.t ?? b.t);
      const dt = Math.max(0, b.t - prev).toFixed(1);
      const json = b.data ? ` ${safeJson(b.data)}` : '';
      return `${dt}ms ${b.label}${json}`;
    });

    // Optionally emit a custom event instead of direct console logging
    try {
      const event = new CustomEvent('systemsculpt:freeze-detected', {
        detail: {
          deltaMs: Number(deltaMs.toFixed(1)),
          events: snapshot
        }
      });
      window.dispatchEvent(event);
    } catch {}
  }
}

function safeJson(obj: Record<string, any>): string {
  try {
    return JSON.stringify(obj);
  } catch (_) {
    return '[unserializable]';
  }
}



