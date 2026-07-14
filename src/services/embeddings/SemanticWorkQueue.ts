import type { FailedProcessingDetail } from "./types";

export type SemanticWorkReason = "create" | "modify" | "rename" | "retry" | "reconcile";

export interface SemanticWorkItem {
  path: string;
  /** Monotonic queue identity. A worker may only settle the revision it claimed. */
  revision: number;
  /** Source mtime observed when this revision was queued. */
  sourceMtime: number | null;
  reason: SemanticWorkReason;
  requestedAt: number;
  readyAt: number;
  attempts: number;
  failure: (FailedProcessingDetail & { failedAt: number }) | null;
}

interface StoredSemanticWork {
  version: 1 | 2;
  items: SemanticWorkItem[];
}

export interface SemanticWorkStore {
  readState<T>(key: string): Promise<T | null>;
  writeState<T>(key: string, value: T): Promise<void>;
  deleteState(key: string): Promise<void>;
}

const STATE_KEY = "semantic-work-v1";

function clone(item: SemanticWorkItem): SemanticWorkItem {
  return { ...item, failure: item.failure ? { ...item.failure } : null };
}

/** Durable, path-keyed work. Repeated file events collapse into one quiet-period item. */
export class SemanticWorkQueue {
  private readonly items = new Map<string, SemanticWorkItem>();
  private persistChain: Promise<void> = Promise.resolve();
  private persistQueued = false;
  private revision = 0;
  private persistedRevision = 0;
  private nextItemRevision = 1;

  constructor(
    private readonly store: SemanticWorkStore,
    private readonly quietPeriodMs = 350,
  ) {}

  async restore(): Promise<void> {
    const stored = await this.store.readState<StoredSemanticWork>(STATE_KEY);
    this.items.clear();
    this.nextItemRevision = 1;
    if (!stored || (stored.version !== 1 && stored.version !== 2) || !Array.isArray(stored.items)) return;
    for (const item of stored.items) {
      if (!item || typeof item.path !== "string" || !item.path) continue;
      const itemRevision = Number.isSafeInteger(item.revision) && item.revision > 0
        ? item.revision
        : this.nextItemRevision;
      this.nextItemRevision = Math.max(this.nextItemRevision, itemRevision + 1);
      this.items.set(item.path, {
        path: item.path,
        revision: itemRevision,
        sourceMtime: Number.isFinite(item.sourceMtime) ? item.sourceMtime : null,
        reason: item.reason || "reconcile",
        requestedAt: Number.isFinite(item.requestedAt) ? item.requestedAt : Date.now(),
        readyAt: Number.isFinite(item.readyAt) ? item.readyAt : Date.now(),
        attempts: Number.isFinite(item.attempts) ? Math.max(0, item.attempts) : 0,
        failure: item.failure ? { ...item.failure } : null,
      });
    }
  }

  async enqueue(
    path: string,
    reason: SemanticWorkReason,
    sourceMtime: number | null,
    now = Date.now(),
  ): Promise<SemanticWorkItem | null> {
    if (!path) return null;
    const existing = this.items.get(path);
    const item: SemanticWorkItem = {
      path,
      revision: this.nextItemRevision++,
      sourceMtime: Number.isFinite(sourceMtime) ? sourceMtime : null,
      reason,
      requestedAt: existing?.requestedAt ?? now,
      readyAt: now + this.quietPeriodMs,
      attempts: existing?.attempts ?? 0,
      failure: null,
    };
    this.items.set(path, item);
    await this.persist();
    return clone(item);
  }

  async enqueueImmediate(
    path: string,
    reason: SemanticWorkReason,
    sourceMtime: number | null,
    now = Date.now(),
  ): Promise<SemanticWorkItem | null> {
    return this.enqueue(path, reason, sourceMtime, now - this.quietPeriodMs);
  }

  async rename(oldPath: string, newPath: string, now = Date.now()): Promise<void> {
    const previous = this.items.get(oldPath);
    this.items.delete(oldPath);
    if (newPath) {
      this.items.set(newPath, {
        path: newPath,
        revision: this.nextItemRevision++,
        sourceMtime: previous?.sourceMtime ?? null,
        reason: "rename",
        requestedAt: previous?.requestedAt ?? now,
        readyAt: now + this.quietPeriodMs,
        attempts: previous?.attempts ?? 0,
        failure: null,
      });
    }
    await this.persist();
  }

  async remove(path: string): Promise<void> {
    if (!this.items.delete(path)) return;
    await this.persist();
  }

  async renamePrefix(oldPrefix: string, newPrefix: string, now = Date.now()): Promise<void> {
    const from = oldPrefix.replace(/\/$/, "") + "/";
    const to = newPrefix.replace(/\/$/, "") + "/";
    let changed = false;
    for (const [path, item] of [...this.items]) {
      if (!path.startsWith(from)) continue;
      const nextPath = `${to}${path.slice(from.length)}`;
      this.items.delete(path);
      this.items.set(nextPath, {
        ...item,
        path: nextPath,
        revision: this.nextItemRevision++,
        reason: "rename",
        readyAt: now + this.quietPeriodMs,
        failure: null,
      });
      changed = true;
    }
    if (changed) await this.persist();
  }

  async removePrefix(prefix: string): Promise<void> {
    const normalized = prefix.replace(/\/$/, "") + "/";
    let changed = false;
    for (const path of [...this.items.keys()]) {
      if (path.startsWith(normalized)) changed = this.items.delete(path) || changed;
    }
    if (changed) await this.persist();
  }

  async complete(claims: Iterable<SemanticWorkItem>): Promise<void> {
    let changed = false;
    for (const claim of claims) {
      const current = this.items.get(claim.path);
      if (
        !current
        || current.revision !== claim.revision
        || current.sourceMtime !== claim.sourceMtime
      ) continue;
      changed = this.items.delete(claim.path) || changed;
    }
    if (changed) await this.persist();
  }

  async fail(
    claim: SemanticWorkItem,
    failure: FailedProcessingDetail,
    now = Date.now(),
  ): Promise<boolean> {
    const existing = this.items.get(claim.path);
    if (
      !existing
      || existing.revision !== claim.revision
      || existing.sourceMtime !== claim.sourceMtime
    ) return false;
    this.items.set(claim.path, {
      ...existing,
      readyAt: Number.MAX_SAFE_INTEGER,
      attempts: existing.attempts + 1,
      failure: { ...failure, failedAt: now },
    });
    await this.persist();
    return true;
  }

  async retryFailures(now = Date.now()): Promise<void> {
    let changed = false;
    for (const [path, item] of this.items) {
      if (!item.failure) continue;
      this.items.set(path, { ...item, reason: "retry", readyAt: now, failure: null });
      changed = true;
    }
    if (changed) await this.persist();
  }

  due(now = Date.now(), limit = 128): SemanticWorkItem[] {
    return [...this.items.values()]
      .filter((item) => !item.failure && item.readyAt <= now)
      .sort((left, right) => left.readyAt - right.readyAt || left.path.localeCompare(right.path))
      .slice(0, Math.max(1, limit))
      .map(clone);
  }

  snapshot(): SemanticWorkItem[] {
    return [...this.items.values()].map(clone);
  }

  get(path: string): SemanticWorkItem | null {
    const item = this.items.get(path);
    return item ? clone(item) : null;
  }

  get size(): number {
    return this.items.size;
  }

  get failureCount(): number {
    let count = 0;
    for (const item of this.items.values()) if (item.failure) count += 1;
    return count;
  }

  async clear(): Promise<void> {
    this.items.clear();
    await this.persist();
  }

  async settled(): Promise<void> {
    await this.persistChain;
  }

  private persist(): Promise<void> {
    this.revision += 1;
    if (this.persistQueued) return this.persistChain;
    this.persistQueued = true;
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      try {
        while (this.persistedRevision < this.revision) {
          const targetRevision = this.revision;
          const snapshot: StoredSemanticWork = { version: 2, items: this.snapshot() };
          if (snapshot.items.length === 0) await this.store.deleteState(STATE_KEY);
          else await this.store.writeState(STATE_KEY, snapshot);
          this.persistedRevision = targetRevision;
        }
      } finally {
        this.persistQueued = false;
      }
    });
    return this.persistChain;
  }
}
