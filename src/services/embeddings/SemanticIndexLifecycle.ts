export type SemanticIndexPhase =
  | "initializing"
  | "idle"
  | "reconciling"
  | "paused"
  | "error";

export interface SemanticIndexGenerationSnapshot {
  id: string;
  namespace: string;
  dimensions: number;
}

export interface SemanticIndexFailureSnapshot {
  code: string;
  message: string;
}

export interface SemanticIndexSnapshot {
  phase: SemanticIndexPhase;
  ready: boolean;
  generation: SemanticIndexGenerationSnapshot | null;
  total: number;
  completed: number;
  pending: number;
  failed: number;
  currentPath: string | null;
  lastError: SemanticIndexFailureSnapshot | null;
  updatedAt: number;
}

export type SemanticIndexFileState =
  | "ready"
  | "stale"
  | "missing"
  | "pending"
  | "failed"
  | "excluded"
  | "empty";

export interface SemanticIndexFileSnapshot {
  path: string;
  state: SemanticIndexFileState;
  ready: boolean;
  indexedAt: number | null;
  generation: SemanticIndexGenerationSnapshot | null;
}

type SemanticIndexListener = (snapshot: Readonly<SemanticIndexSnapshot>) => void;

const initialSnapshot = (): SemanticIndexSnapshot => ({
  phase: "initializing",
  ready: false,
  generation: null,
  total: 0,
  completed: 0,
  pending: 0,
  failed: 0,
  currentPath: null,
  lastError: null,
  updatedAt: Date.now(),
});

/** While indexing, progress-only changes reach observers at about 4 Hz. */
const PROGRESS_NOTIFY_INTERVAL_MS = 250;

function sameGeneration(
  left: SemanticIndexGenerationSnapshot | null,
  right: SemanticIndexGenerationSnapshot | null,
): boolean {
  return left === right || Boolean(
    left
    && right
    && left.id === right.id
    && left.namespace === right.namespace
    && left.dimensions === right.dimensions,
  );
}

function sameFailure(
  left: SemanticIndexFailureSnapshot | null,
  right: SemanticIndexFailureSnapshot | null,
): boolean {
  return left === right || Boolean(left && right && left.code === right.code && left.message === right.message);
}

function sameVisibleState(left: SemanticIndexSnapshot, right: SemanticIndexSnapshot): boolean {
  return left.phase === right.phase
    && left.ready === right.ready
    && left.total === right.total
    && left.completed === right.completed
    && left.pending === right.pending
    && left.failed === right.failed
    && left.currentPath === right.currentPath
    && sameGeneration(left.generation, right.generation)
    && sameFailure(left.lastError, right.lastError);
}

/** Only counters and the current note moved; the phase and errors did not. */
function isProgressOnly(previous: SemanticIndexSnapshot, next: SemanticIndexSnapshot): boolean {
  return previous.phase === "reconciling"
    && next.phase === "reconciling"
    && previous.ready === next.ready
    && previous.failed === next.failed
    && sameGeneration(previous.generation, next.generation)
    && sameFailure(previous.lastError, next.lastError);
}

/**
 * The single observable projection of semantic-index lifecycle state.
 * Every presentation surface observes the same immutable snapshot.
 *
 * Updates that change nothing visible are dropped, and progress-only updates
 * while indexing are coalesced so observers repaint at a bounded rate. The
 * latest snapshot is always readable immediately through getSnapshot().
 */
export class SemanticIndexLifecycle {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<SemanticIndexListener>();
  private lastNotifiedAt = 0;
  private notifyTimer: number | null = null;

  getSnapshot(): Readonly<SemanticIndexSnapshot> {
    return this.snapshot;
  }

  subscribe(listener: SemanticIndexListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<Omit<SemanticIndexSnapshot, "updatedAt">>): Readonly<SemanticIndexSnapshot> {
    const previous = this.snapshot;
    const next: SemanticIndexSnapshot = {
      ...previous,
      ...patch,
      generation: patch.generation === undefined ? previous.generation : patch.generation,
      lastError: patch.lastError === undefined ? previous.lastError : patch.lastError,
      updatedAt: previous.updatedAt,
    };
    if (sameVisibleState(previous, next)) return previous;
    this.snapshot = Object.freeze({ ...next, updatedAt: Date.now() });
    const wait = isProgressOnly(previous, this.snapshot)
      ? this.lastNotifiedAt + PROGRESS_NOTIFY_INTERVAL_MS - Date.now()
      : 0;
    if (wait > 0) {
      this.notifyTimer ??= window.setTimeout(() => {
        this.notifyTimer = null;
        this.notify();
      }, wait);
    } else {
      this.notify();
    }
    return this.snapshot;
  }

  reset(): void {
    this.snapshot = initialSnapshot();
    this.notify();
  }

  clearListeners(): void {
    this.cancelPendingNotify();
    this.listeners.clear();
  }

  private notify(): void {
    this.cancelPendingNotify();
    this.lastNotifiedAt = Date.now();
    for (const listener of [...this.listeners]) {
      try { listener(this.snapshot); } catch { /* lifecycle observers are isolated */ }
    }
  }

  private cancelPendingNotify(): void {
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
  }
}
