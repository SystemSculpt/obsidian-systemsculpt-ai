/**
 * EmbeddingsPortableIndex - the restore/snapshot decision logic that ties the
 * IndexedDB store to the vault-relative snapshot files.
 *
 * Kept dependency-light (small interfaces, no IndexedDB/Obsidian imports) so the
 * decisions — "restore only into an empty store", "rewrite only the shards that
 * changed", "never keep a snapshot that resurrects removed notes" — are
 * unit-testable with fakes and the EmbeddingsManager wiring stays a thin call.
 */

import type { EmbeddingVector } from "../types";
import { LOCAL_EMPTY_EMBEDDING_NAMESPACE } from "../LocalEmptyEmbeddingMarker";
import { isManagedNamespace } from "../utils/namespace";
import {
  buildPortableManifest,
  decodePortableShard,
  deserializeEmbeddingsIndex,
  encodePortableShard,
  parsePortableManifest,
  portableShardOf,
  PORTABLE_SHARD_COUNT,
  type PortableIndexManifest,
} from "./EmbeddingsIndexSerialization";

export interface PortableIndexStore {
  countVectors(): Promise<number>;
  importVectors(vectors: EmbeddingVector[]): Promise<{ imported: number }>;
  /** Paths that have a root record. */
  getDistinctPaths(): string[];
  /** Every record for the given notes, read transiently. */
  readPaths(paths: readonly string[]): Promise<EmbeddingVector[]>;
  /** Paths changed since the last call (`all` for sweeps that do not name paths). */
  takePortableChanges(): { all: boolean; paths: string[] };
}

export interface PortableIndexFile {
  /** `index.json`: a format-4 manifest, an older release's whole index, or null. */
  read(): Promise<Record<string, unknown> | null>;
  write(manifest: PortableIndexManifest): Promise<void>;
  /** Byte size of `index.json`, or null when it is missing. */
  size(): Promise<number | null>;
  listShards(): Promise<Set<number>>;
  readShard(shard: number): Promise<ArrayBuffer | null>;
  writeShard(shard: number, bytes: ArrayBuffer): Promise<void>;
  removeShard(shard: number): Promise<void>;
  removeRecoveryCopy?(): Promise<void>;
  remove?(): Promise<void>;
}

export interface PortableCheckpointStatus {
  pending: boolean;
  lastWrittenAt: number | null;
}

/** Ordinary changes (new vectors) wait for a quiet period, bounded by maxWait. */
const DEFAULT_QUIET_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
/** Removals are expedited so deleted or excluded notes leave the snapshot soon. */
const DEFAULT_DESTRUCTIVE_QUIET_MS = 1_000;
const DEFAULT_DESTRUCTIVE_MAX_WAIT_MS = 10_000;
/** A format-4 manifest is tiny; anything larger is an older release's whole index. */
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface PortableCheckpointTiming {
  quietMs?: number;
  maxWaitMs?: number;
  destructiveQuietMs?: number;
  destructiveMaxWaitMs?: number;
}

function allShards(): number[] {
  return Array.from({ length: PORTABLE_SHARD_COUNT }, (_, shard) => shard);
}

/**
 * Coalesces snapshot writes and writes only the shards whose notes changed.
 * Edits wait for a long quiet period; removals use a short one so bursts (a
 * folder of deletes, a rename storm) still become one write. A failed write
 * after a removal deletes the affected shards: a missing shard only costs a
 * re-embed on restore, while a stale one would resurrect removed notes.
 */
export class PortableCheckpointCoordinator {
  private timer: number | null = null;
  private firstDirtyAt: number | null = null;
  private firstDestructiveAt: number | null = null;
  private revision = 0;
  private writtenRevision = 0;
  private destructiveRevision = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWrittenAt: number | null = null;
  /** Shards that still need writing, beyond the store's pending changes. */
  private readonly pendingShards = new Set<number>();
  /** The manifest this session last wrote; null forces one write per session. */
  private writtenManifest: string | null = null;
  private readonly timing: Required<PortableCheckpointTiming>;

  constructor(
    private readonly deps: {
      store: PortableIndexStore;
      file: PortableIndexFile;
      /** The searchable generation recorded in the manifest. */
      committedNamespace?: () => string | null;
      /** Receives background write failures; the local index stays authoritative. */
      onError?: (error: unknown, destructive: boolean) => void;
    },
    timing: PortableCheckpointTiming = {},
  ) {
    this.timing = {
      quietMs: timing.quietMs ?? DEFAULT_QUIET_MS,
      maxWaitMs: timing.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      destructiveQuietMs: timing.destructiveQuietMs ?? DEFAULT_DESTRUCTIVE_QUIET_MS,
      destructiveMaxWaitMs: timing.destructiveMaxWaitMs ?? DEFAULT_DESTRUCTIVE_MAX_WAIT_MS,
    };
  }

  markChanged(): void {
    this.revision += 1;
    this.firstDirtyAt ??= Date.now();
    this.schedule();
  }

  /** A removal happened: write soon, and drop the affected shards if that write fails. */
  markDestructive(): void {
    this.revision += 1;
    this.destructiveRevision = this.revision;
    this.firstDirtyAt ??= Date.now();
    this.firstDestructiveAt ??= Date.now();
    this.schedule();
  }

  /**
   * Bring the files on disk in line with the current format without a
   * rewrite when they already are: a missing or older-release `index.json`
   * schedules every shard (the one-time migration); otherwise only shards
   * missing from disk, or on disk with no notes left, are scheduled.
   */
  async reconcileFormat(): Promise<void> {
    const expected = new Set(this.deps.store.getDistinctPaths().map((path) => portableShardOf(path)));
    if (expected.size === 0) return;
    const [manifestCurrent, onDisk] = await Promise.all([
      this.manifestIsCurrent(),
      this.deps.file.listShards(),
    ]);
    const stale = allShards().filter((shard) => !manifestCurrent || expected.has(shard) !== onDisk.has(shard));
    if (!manifestCurrent) this.writtenManifest = null;
    if (stale.length === 0) return;
    for (const shard of stale) this.pendingShards.add(shard);
    this.markChanged();
  }

  async clear(): Promise<void> {
    this.cancelTimer();
    this.revision += 1;
    this.writtenRevision = this.revision;
    this.destructiveRevision = 0;
    this.firstDirtyAt = null;
    this.firstDestructiveAt = null;
    this.pendingShards.clear();
    this.deps.store.takePortableChanges();
    this.writtenManifest = null;
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
    const destructive = this.destructiveRevision > this.writtenRevision;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await this.writeChangedShards(destructive);
      this.writtenRevision = Math.max(this.writtenRevision, targetRevision);
      this.lastWrittenAt = Date.now();
    });
    try {
      await this.writeChain;
    } catch (error) {
      // The affected shards were dropped; there is nothing stale left to retry.
      if (destructive) this.writtenRevision = Math.max(this.writtenRevision, targetRevision);
      throw error;
    } finally {
      if (this.writtenRevision >= this.destructiveRevision) this.firstDestructiveAt = null;
      if (this.writtenRevision !== this.revision) {
        this.firstDirtyAt ??= Date.now();
        this.schedule();
      } else {
        this.firstDirtyAt = null;
      }
    }
  }

  status(): PortableCheckpointStatus {
    return { pending: this.writtenRevision !== this.revision, lastWrittenAt: this.lastWrittenAt };
  }

  cancel(): void {
    this.cancelTimer();
  }

  /**
   * One shard at a time: read that shard's notes, encode, replace the file,
   * release. Peak memory is one shard, never the whole index as one string.
   */
  private async writeChangedShards(destructive: boolean): Promise<void> {
    const { store, file } = this.deps;
    const changes = store.takePortableChanges();
    if (changes.all) for (const shard of allShards()) this.pendingShards.add(shard);
    for (const path of changes.paths) this.pendingShards.add(portableShardOf(path));

    const pathsByShard = new Map<number, string[]>();
    for (const path of store.getDistinctPaths()) {
      const shard = portableShardOf(path);
      const paths = pathsByShard.get(shard);
      if (paths) paths.push(path);
      else pathsByShard.set(shard, [path]);
    }
    if (pathsByShard.size === 0) {
      // Nothing left to snapshot; an empty snapshot would only shadow a restore.
      this.pendingShards.clear();
      this.writtenManifest = null;
      await file.remove?.();
      return;
    }

    try {
      for (const shard of [...this.pendingShards].sort((left, right) => left - right)) {
        const paths = pathsByShard.get(shard) ?? [];
        const bytes = paths.length > 0 ? encodePortableShard(shard, await store.readPaths(paths)) : null;
        if (bytes) await file.writeShard(shard, bytes);
        else await file.removeShard(shard);
        this.pendingShards.delete(shard);
      }
      const manifest = buildPortableManifest(this.deps.committedNamespace?.() ?? null);
      const serialized = JSON.stringify(manifest);
      if (serialized !== this.writtenManifest) {
        await file.write(manifest);
        await file.removeRecoveryCopy?.();
        this.writtenManifest = serialized;
      }
    } catch (error) {
      if (destructive) {
        // Never leave shards holding records that were just removed.
        for (const shard of [...this.pendingShards]) {
          try {
            await file.removeShard(shard);
            this.pendingShards.delete(shard);
          } catch { /* the next write retries this shard */ }
        }
      }
      throw error;
    }
  }

  private async manifestIsCurrent(): Promise<boolean> {
    const size = await this.deps.file.size();
    if (size === null || size > MAX_MANIFEST_BYTES) return false;
    return parsePortableManifest(await this.deps.file.read())?.shardCount === PORTABLE_SHARD_COUNT;
  }

  private schedule(): void {
    const now = Date.now();
    const destructive = this.destructiveRevision > this.writtenRevision;
    const quiet = destructive ? this.timing.destructiveQuietMs : this.timing.quietMs;
    const deadline = destructive
      ? (this.firstDestructiveAt ?? now) + this.timing.destructiveMaxWaitMs
      : (this.firstDirtyAt ?? now) + this.timing.maxWaitMs;
    const dueAt = Math.max(now, Math.min(now + quiet, deadline));
    this.cancelTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush().catch((error) => this.deps.onError?.(error, destructive));
    }, dueAt - now);
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

/**
 * Read whatever snapshot the vault folder holds: the format-4 manifest and its
 * shards, or an older release's single-file index. Shards are read even when
 * the manifest has not synced yet. A corrupt or partially synced shard is
 * skipped; its notes are re-embedded.
 */
export async function readPortableSnapshot(file: PortableIndexFile): Promise<{
  committedNamespace: string | null;
  vectors: EmbeddingVector[];
} | null> {
  const index = await file.read();
  const manifest = parsePortableManifest(index);
  if (index && !manifest) {
    return { committedNamespace: null, vectors: deserializeEmbeddingsIndex(index) };
  }
  const shards = await file.listShards();
  if (!manifest && shards.size === 0) return null;
  const vectors: EmbeddingVector[] = [];
  for (const shard of [...shards].sort((left, right) => left - right)) {
    const bytes = await file.readShard(shard);
    if (!bytes) continue;
    try {
      vectors.push(...decodePortableShard(bytes, shard));
    } catch {
      // A shard that fails validation is treated as absent.
    }
  }
  return { committedNamespace: manifest?.committedNamespace ?? null, vectors };
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

  const snapshot = await readPortableSnapshot(file);
  if (!snapshot) {
    return { restored: false, imported: 0, reason: "no-snapshot" };
  }

  const vectors = retainRestorableGenerations(snapshot.vectors, snapshot.committedNamespace);
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
