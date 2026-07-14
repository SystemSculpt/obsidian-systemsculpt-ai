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

/**
 * The single observable projection of semantic-index lifecycle state.
 * Every presentation surface observes the same immutable snapshot.
 */
export class SemanticIndexLifecycle {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<SemanticIndexListener>();

  getSnapshot(): Readonly<SemanticIndexSnapshot> {
    return this.snapshot;
  }

  subscribe(listener: SemanticIndexListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<Omit<SemanticIndexSnapshot, "updatedAt">>): Readonly<SemanticIndexSnapshot> {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      generation: patch.generation === undefined ? this.snapshot.generation : patch.generation,
      lastError: patch.lastError === undefined ? this.snapshot.lastError : patch.lastError,
      updatedAt: Date.now(),
    });
    for (const listener of [...this.listeners]) {
      try { listener(this.snapshot); } catch { /* lifecycle observers are isolated */ }
    }
    return this.snapshot;
  }

  reset(): void {
    this.snapshot = initialSnapshot();
    for (const listener of [...this.listeners]) {
      try { listener(this.snapshot); } catch { /* lifecycle observers are isolated */ }
    }
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}
