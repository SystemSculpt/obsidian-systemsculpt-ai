import type { StreamingMetrics, StreamingStatus } from "../StreamingMetricsTracker";

const VALID_STATUSES: Set<StreamingStatus> = new Set([
  "preparing",
  "reasoning",
  "content",
  "tool_calls",
  "executing_tools",
]);

export class StreamingIndicator {
  readonly element: HTMLDivElement;
  private labelEl: HTMLSpanElement;
  private elapsedEl: HTMLSpanElement;
  private visible: boolean = false;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "ss-streaming-indicator";
    this.element.setAttribute("role", "status");
    this.element.setAttribute("aria-live", "polite");

    // Header: dots + label
    const headerEl = document.createElement("div");
    headerEl.className = "ss-streaming-header";

    const dotsEl = document.createElement("div");
    dotsEl.className = "ss-typing-dots";
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "ss-dot";
      dotsEl.appendChild(dot);
    }

    this.labelEl = document.createElement("span");
    this.labelEl.className = "ss-streaming-label";
    this.labelEl.textContent = "Preparing\u2026";

    headerEl.appendChild(dotsEl);
    headerEl.appendChild(this.labelEl);

    // Metrics row: elapsed time only
    const metricsEl = document.createElement("div");
    metricsEl.className = "ss-streaming-metrics";

    this.elapsedEl = document.createElement("span");
    this.elapsedEl.className = "ss-metric ss-elapsed";
    this.elapsedEl.textContent = "0:00";

    metricsEl.appendChild(this.elapsedEl);

    this.element.appendChild(headerEl);
    this.element.appendChild(metricsEl);
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.element.classList.remove("ss-hiding");
    this.element.classList.add("ss-visible");
  }

  update(status: string, label: string, metrics?: StreamingMetrics): void {
    const dataStatus = VALID_STATUSES.has(status as StreamingStatus) ? status : "content";
    this.element.setAttribute("data-status", dataStatus);
    this.labelEl.textContent = label || "Writing\u2026";

    if (metrics) {
      this.elapsedEl.textContent = metrics.elapsedFormatted;
    }
  }

  hide(onComplete?: () => void): void {
    if (!this.visible) {
      onComplete?.();
      return;
    }
    this.visible = false;
    this.element.classList.add("ss-hiding");
    this.element.classList.remove("ss-visible");

    const handleEnd = (): void => {
      this.element.removeEventListener("animationend", handleEnd);
      onComplete?.();
    };
    this.element.addEventListener("animationend", handleEnd);

    // Fallback in case animation doesn't fire
    setTimeout(() => {
      if (!this.visible) {
        onComplete?.();
      }
    }, 300);
  }

  destroy(): void {
    this.element.remove();
  }
}
