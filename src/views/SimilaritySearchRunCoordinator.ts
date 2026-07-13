import type { TFile } from "obsidian";
import type { ChatView } from "./chatview/ChatView";

export type SimilaritySearchSource =
  | Readonly<{ kind: "file"; key: string; file: TFile }>
  | Readonly<{ kind: "chat"; key: string; chatView: ChatView }>;

export interface SimilaritySearchRun {
  readonly source: SimilaritySearchSource;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

interface SimilaritySearchRunCoordinatorOptions {
  isVisible: () => boolean;
  execute: (run: SimilaritySearchRun) => Promise<void>;
  onError: (error: unknown, source: SimilaritySearchSource) => void;
  onCancel?: () => void;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

/**
 * Owns the lifecycle of Similar Notes work. Views describe a typed source and
 * render results; this coordinator owns visibility deferral, timers,
 * cancellation, stale-run fencing, and terminal settlement.
 */
export class SimilaritySearchRunCoordinator {
  private generation = 0;
  private active: Readonly<{
    generation: number;
    source: SimilaritySearchSource;
    controller: AbortController;
  }> | null = null;
  private pending: SimilaritySearchSource | null = null;
  private timer: number | null = null;
  private scheduledSource: SimilaritySearchSource | null = null;
  private closed = false;

  public constructor(private readonly options: SimilaritySearchRunCoordinatorOptions) {}

  public open(): void {
    this.closed = false;
  }

  public close(): void {
    this.closed = true;
    this.cancel();
  }

  public isRunning(): boolean {
    return this.active !== null;
  }

  public hasPending(): boolean {
    return this.pending !== null;
  }

  public cancel(clearPending = true): void {
    this.clearTimer();
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
    if (clearPending) this.pending = null;
    this.options.onCancel?.();
  }

  public schedule(source: SimilaritySearchSource, delay: number): void {
    this.cancel();
    if (this.closed) return;
    this.scheduledSource = source;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.scheduledSource = null;
      void this.run(source);
    }, Math.max(0, delay));
  }

  public scheduleTask(task: () => void, delay: number): void {
    this.cancel();
    if (this.closed) return;
    this.scheduledSource = null;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.closed) task();
    }, Math.max(0, delay));
  }

  public reconcileVisibility(delay = 10): void {
    if (!this.options.isVisible()) {
      const source = this.active?.source ?? this.pending ?? this.scheduledSource;
      if (!source) return;
      this.cancel(false);
      this.pending = source;
      return;
    }
    this.flushPending(delay);
  }

  public flushPending(delay = 10): void {
    if (this.closed || !this.options.isVisible() || !this.pending) return;
    const source = this.pending;
    this.pending = null;
    this.schedule(source, delay);
  }

  public async run(source: SimilaritySearchSource): Promise<void> {
    if (this.closed) return;
    this.clearTimer();
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
    this.pending = null;

    if (!this.options.isVisible()) {
      this.pending = source;
      this.options.onCancel?.();
      return;
    }

    const controller = new AbortController();
    const generation = this.generation;
    this.active = Object.freeze({ generation, source, controller });
    const isIdentityCurrent = () => !this.closed
      && this.active?.generation === generation
      && this.active.controller === controller
      && !controller.signal.aborted;
    const run: SimilaritySearchRun = Object.freeze({
      source,
      signal: controller.signal,
      isCurrent: () => isIdentityCurrent() && this.options.isVisible(),
    });

    try {
      await this.options.execute(run);
    } catch (error) {
      if (run.isCurrent() && !isAbortError(error)) this.options.onError(error, source);
    } finally {
      if (isIdentityCurrent()) this.active = null;
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
    this.scheduledSource = null;
  }
}

export function fileSimilaritySource(file: TFile): SimilaritySearchSource {
  return Object.freeze({ kind: "file", key: file.path, file });
}

export function chatSimilaritySource(chatView: ChatView): SimilaritySearchSource {
  return Object.freeze({ kind: "chat", key: `chat:${chatView.chatId}`, chatView });
}
