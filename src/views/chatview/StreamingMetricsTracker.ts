export type StreamingStatus = "preparing" | "reasoning" | "content" | "tool_calls" | "executing_tools";

export interface StreamingMetrics {
  elapsedMs: number;
  elapsedFormatted: string;
  status: StreamingStatus;
  statusLabel: string;
}

export interface StreamingMetricsTrackerOptions {
  onUpdate?: (metrics: StreamingMetrics) => void;
}

const STATUS_LABELS: Record<StreamingStatus, string> = {
  preparing: "Preparing\u2026",
  reasoning: "Thinking\u2026",
  content: "Writing\u2026",
  tool_calls: "Using tools\u2026",
  executing_tools: "Running tools\u2026",
};

export class StreamingMetricsTracker {
  private startTime: number = 0;
  private status: StreamingStatus = "preparing";
  private running: boolean = false;
  private rafId: number | null = null;

  private readonly onUpdate?: (metrics: StreamingMetrics) => void;

  constructor(options: StreamingMetricsTrackerOptions = {}) {
    this.onUpdate = options.onUpdate;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = performance.now();
    this.status = "preparing";
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  setStatus(status: StreamingStatus): void {
    this.status = status;
  }

  getMetrics(): StreamingMetrics {
    const elapsedMs = this.running ? performance.now() - this.startTime : 0;

    return {
      elapsedMs,
      elapsedFormatted: this.formatElapsed(elapsedMs),
      status: this.status,
      statusLabel: STATUS_LABELS[this.status],
    };
  }

  private tick = (): void => {
    if (!this.running) return;
    this.onUpdate?.(this.getMetrics());
    this.rafId = requestAnimationFrame(this.tick);
  };

  private formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
}
