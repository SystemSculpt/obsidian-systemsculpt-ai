/**
 * EmbeddingsPortableIndex - the restore/snapshot decision logic that ties the
 * IndexedDB store to the vault-relative snapshot file.
 *
 * Kept dependency-light (small interfaces, no IndexedDB/Obsidian imports) so the
 * decisions — "restore only into an empty store", "never write an empty
 * snapshot" — are unit-testable with fakes and the EmbeddingsManager wiring stays
 * a thin call.
 */

import type { EmbeddingVector } from "../types";
import { LOCAL_EMPTY_EMBEDDING_NAMESPACE } from "../LocalEmptyEmbeddingMarker";
import { isManagedNamespace } from "../utils/namespace";
import {
  deserializeEmbeddingsIndex,
  type SerializedEmbeddingsIndex,
} from "./EmbeddingsIndexSerialization";

export interface PortableIndexStore {
  countVectors(): Promise<number>;
  exportAll(): Promise<SerializedEmbeddingsIndex>;
  importVectors(vectors: EmbeddingVector[]): Promise<{ imported: number }>;
}

export interface PortableIndexFile {
  read(): Promise<SerializedEmbeddingsIndex | null>;
  write(index: SerializedEmbeddingsIndex): Promise<void>;
  remove?(): Promise<void>;
}

export interface PortableCheckpointStatus {
  pending: boolean;
  lastWrittenAt: number | null;
}

/**
 * Debounces expensive full-index serialization while forcing destructive
 * mutations through an immediate checkpoint so deleted notes cannot restore.
 */
export class PortableCheckpointCoordinator {
  private timer: number | null = null;
  private firstDirtyAt: number | null = null;
  private revision = 0;
  private writtenRevision = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWrittenAt: number | null = null;

  constructor(
    private readonly deps: { store: PortableIndexStore; file: PortableIndexFile },
    private readonly quietMs = 1_500,
    private readonly maxWaitMs = 15_000,
  ) {}

  markChanged(): void {
    this.revision += 1;
    this.firstDirtyAt ??= Date.now();
    this.schedule();
  }

  async commitDestructiveMutation(): Promise<void> {
    this.markChanged();
    try {
      await this.flush();
    } catch (error) {
      // A missing checkpoint is safer than a stale checkpoint containing ghosts.
      await this.deps.file.remove?.();
      this.writtenRevision = this.revision;
      this.firstDirtyAt = null;
      throw error;
    }
  }

  async clear(): Promise<void> {
    this.cancelTimer();
    this.revision += 1;
    this.writtenRevision = this.revision;
    this.firstDirtyAt = null;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await this.deps.file.remove?.();
      this.lastWrittenAt = Date.now();
    });
    await this.writeChain;
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.writtenRevision === this.revision) return this.writeChain;
    const targetRevision = this.revision;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const result = await writeEmbeddingsIndexSnapshot(this.deps);
      if (!result.written && result.count === 0) await this.deps.file.remove?.();
      this.writtenRevision = targetRevision;
      this.lastWrittenAt = Date.now();
    });
    await this.writeChain;
    if (this.writtenRevision !== this.revision) {
      this.firstDirtyAt ??= Date.now();
      this.schedule();
    } else {
      this.firstDirtyAt = null;
    }
  }

  status(): PortableCheckpointStatus {
    return { pending: this.writtenRevision !== this.revision, lastWrittenAt: this.lastWrittenAt };
  }

  cancel(): void {
    this.cancelTimer();
  }

  private schedule(): void {
    this.cancelTimer();
    const elapsed = this.firstDirtyAt === null ? 0 : Date.now() - this.firstDirtyAt;
    const delay = Math.max(0, Math.min(this.quietMs, this.maxWaitMs - elapsed));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface RestoreResult {
  restored: boolean;
  imported: number;
  reason: "restored" | "store-not-empty" | "no-snapshot" | "empty-snapshot";
}

export interface WriteResult {
  written: boolean;
  count: number;
}

/**
 * Restore the index from the vault snapshot, but only when the local store is
 * empty (a fresh device / wiped IndexedDB). A populated store always wins so we
 * never clobber newer local vectors with a stale snapshot — mirroring the
 * existing legacy-DB import guard.
 */
export async function restoreEmbeddingsIndexIfEmpty(deps: {
  store: PortableIndexStore;
  file: PortableIndexFile;
}): Promise<RestoreResult> {
  const { store, file } = deps;

  const count = await store.countVectors();
  if (count > 0) {
    return { restored: false, imported: 0, reason: "store-not-empty" };
  }

  const snapshot = await file.read();
  if (!snapshot) {
    return { restored: false, imported: 0, reason: "no-snapshot" };
  }

  const vectors = retainRestorableGenerations(deserializeEmbeddingsIndex(snapshot));
  const { imported } = await store.importVectors(vectors);
  if (imported > 0) {
    return { restored: true, imported, reason: "restored" };
  }
  return { restored: false, imported: 0, reason: "empty-snapshot" };
}

/**
 * Keep at most two managed generations from a snapshot: the committed one
 * (named by the snapshot, else the one with the most complete roots) and the
 * most recently written one, which is the generation an interrupted rebuild
 * was moving to. Older snapshots carried every generation a vault ever used
 * (#324); restoring them would only resurrect vectors nothing can query.
 */
export function retainRestorableGenerations(
  vectors: EmbeddingVector[],
  committedNamespace?: string | null,
): EmbeddingVector[] {
  const generations = new Map<string, { completeRoots: number; latestCreatedAt: number }>();
  for (const vector of vectors) {
    const namespace = vector.metadata.namespace;
    if (vector.chunkId !== 0 || vector.metadata.complete !== true || !isManagedNamespace(namespace)) continue;
    const entry = generations.get(namespace) ?? { completeRoots: 0, latestCreatedAt: 0 };
    entry.completeRoots += 1;
    entry.latestCreatedAt = Math.max(entry.latestCreatedAt, vector.metadata.createdAt || 0);
    generations.set(namespace, entry);
  }
  const ranked = [...generations.entries()];
  const pick = (score: (entry: { completeRoots: number; latestCreatedAt: number }) => number) => (
    ranked
      .slice()
      .sort((left, right) => score(right[1]) - score(left[1]) || left[0].localeCompare(right[0]))[0]?.[0]
  );
  const keep = new Set<string>();
  const committed = committedNamespace && generations.has(committedNamespace)
    ? committedNamespace
    : pick((entry) => entry.completeRoots);
  if (committed) keep.add(committed);
  const latest = pick((entry) => entry.latestCreatedAt);
  if (latest) keep.add(latest);
  return vectors.filter((vector) => (
    vector.metadata.namespace === LOCAL_EMPTY_EMBEDDING_NAMESPACE
    || keep.has(vector.metadata.namespace)
  ));
}

/**
 * Write the current store to the vault snapshot. Skips an empty index so we
 * don't overwrite a good snapshot with nothing (e.g. before the first embed).
 */
export async function writeEmbeddingsIndexSnapshot(deps: {
  store: PortableIndexStore;
  file: PortableIndexFile;
}): Promise<WriteResult> {
  const { store, file } = deps;

  const index = await store.exportAll();
  if (index.vectorCount === 0) {
    return { written: false, count: 0 };
  }

  await file.write(index);
  return { written: true, count: index.vectorCount };
}
