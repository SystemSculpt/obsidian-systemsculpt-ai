import {
  StreamingMetricsTracker,
  type StreamingMetrics,
  type StreamingStatus,
} from "../StreamingMetricsTracker";

export interface ChatTurnProgressControllerOptions {
  showStreamingStatus: (messageEl: HTMLElement) => void;
  hideStreamingStatus: (messageEl: HTMLElement) => void;
  updateStreamingStatus: (
    messageEl: HTMLElement,
    status: string,
    text: string,
    metrics?: StreamingMetrics
  ) => void;
}

export class ChatTurnProgressController {
  private readonly tracker: StreamingMetricsTracker;
  private readonly showStreamingStatus: (messageEl: HTMLElement) => void;
  private readonly hideStreamingStatus: (messageEl: HTMLElement) => void;
  private readonly updateStreamingStatus: (
    messageEl: HTMLElement,
    status: string,
    text: string,
    metrics?: StreamingMetrics
  ) => void;

  private active = false;
  private targetMessageEl: HTMLElement | null = null;

  constructor(options: ChatTurnProgressControllerOptions) {
    this.showStreamingStatus = options.showStreamingStatus;
    this.hideStreamingStatus = options.hideStreamingStatus;
    this.updateStreamingStatus = options.updateStreamingStatus;
    this.tracker = new StreamingMetricsTracker({
      onUpdate: (metrics) => this.render(metrics),
    });
  }

  public begin(messageEl?: HTMLElement): void {
    if (this.active) {
      if (messageEl) {
        this.attach(messageEl);
      }
      return;
    }

    this.active = true;
    if (messageEl) {
      this.attach(messageEl);
    }
    this.tracker.start();
    this.renderNow();
  }

  public attach(messageEl: HTMLElement): void {
    if (!this.active) {
      return;
    }

    this.targetMessageEl = messageEl;
    this.showStreamingStatus(messageEl);
    this.renderNow();
  }

  public setStatus(status: StreamingStatus): void {
    if (!this.active) {
      return;
    }

    this.tracker.setStatus(status);
    this.renderNow();
  }

  public getTracker(): StreamingMetricsTracker {
    return this.tracker;
  }

  public end(): void {
    const target = this.targetMessageEl;
    this.active = false;
    this.tracker.stop();
    this.targetMessageEl = null;

    if (target) {
      this.hideStreamingStatus(target);
    }
  }

  private renderNow(): void {
    this.render(this.tracker.getMetrics());
  }

  private render(metrics: StreamingMetrics): void {
    const target = this.targetMessageEl;
    if (!this.active || !target) {
      return;
    }

    this.updateStreamingStatus(target, metrics.status, metrics.statusLabel, metrics);
  }
}
