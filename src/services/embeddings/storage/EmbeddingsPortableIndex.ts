/**
 * EmbeddingsPortableIndex - the restore/snapshot decision logic that ties the
 * IndexedDB store to the vault-relative snapshot files.
 *
 * Kept dependency-light (small interfaces, no IndexedDB/Obsidian imports) so the
 * decisions — "restore only into an empty store", "rewrite only the shards that
 * changed", "never keep a snapshot that resurrects removed notes" — are
 * unit-testable with fakes and the EmbeddingsManager wiring stays a thin call.
 */

import type { EmbeddingRootRecord, EmbeddingVector } from "../types";
import { LOCAL_EMPTY_EMBEDDING_NAMESPACE } from "../LocalEmptyEmbeddingMarker";
import { isManagedNamespace } from "../utils/namespace";
import {
  buildPortableManifest,
  decodePortableShard,
  deserializeEmbeddingsIndex,
  encodePortableShard,
  parsePortableManifest,
  portableShardOf,
  readPortableShardChecksum,
  PORTABLE_SHARD_COUNT,
  type PortableIndexManifest,
} from "./EmbeddingsIndexSerialization";

export interface PortableIndexStore {
  countVectors(): Promise<number>;
  importVectors(vectors: EmbeddingVector[]): Promise<{ imported: number }>;
  /** Paths that have a root record. */
  getDistinctPaths(): string[];
  /** Every root record (metadata only), used to describe what each shard should hold. */
  listRoots(): Iterable<EmbeddingRootRecord>;
  /** Every record for the given notes, read transiently. */
  readPaths(paths: readonly string[]): Promise<EmbeddingVector[]>;
  /** Paths changed since the last call (`all` for sweeps that do not name paths). */
  takePortableChanges(): { all: boolean; paths: string[] };
  readState<T>(key: string): Promise<T | null>;
  writeState<T>(key: string, value: T): Promise<void>;
}

export interface PortableIndexFile {
  /** `index.json`: a format-4 manifest, an older release's whole index, or null. */
  read(): Promise<Record<string, unknown> | null>;
  write(manifest: PortableIndexManifest): Promise<void>;
  /** Byte size of `index.json`, or null when it is missing. */
  size(): Promise<number | null>;
  listShards(): Promise<Set<number>>;
  readShard(shard: number): Promise<ArrayBuffer | null>;
  /** Size and modification time of one shard file, or null when it is missing. */
  shardStat(shard: number): Promise<{ size: number; mtime: number | null } | null>;
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
/** Consecutive failed writes back off up to this long between retries. */
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** A format-4 manifest is tiny; anything larger is an older release's whole index. */
const MAX_MANIFEST_BYTES = 64 * 1024;
/** What this device last wrote to each shard file, so reconciliation can compare contents. */
const SHARD_RECORDS_STATE_KEY = "semantic-portable-shards-v1";

export interface PortableCheckpointTiming {
  quietMs?: number;
  maxWaitMs?: number;
  destructiveQuietMs?: number;
  destructiveMaxWaitMs?: number;
}

interface ShardRecord {
  /** Byte size of the file this device wrote (or restored from). */
  size: number;
  /** Signature of the notes the file holds; see shardSignatures. */
  signature: string;
  /** The content checksum in that file's prefix. */
  checksum: number | null;
  /** The file's modification time when last verified; a change prompts a checksum check. */
  mtime: number | null;
}

interface ShardRecords {
  version: 1;
  shards: Record<string, ShardRecord>;
}

function allShards(): number[] {
  return Array.from({ length: PORTABLE_SHARD_COUNT }, (_, shard) => shard);
}

function isRootRecord(record: Pick<EmbeddingRootRecord, "id" | "chunkId">): boolean {
  if (typeof record.chunkId === "number") return record.chunkId === 0;
  return record.id.endsWith("#0");
}

/**
 * Identify which notes and which embeddings a shard holds: every root's path,
 * generation, creation time and chunk count. A re-embed changes the creation
 * time; an mtime-only touch of unchanged bytes does not, and needs no write.
 */
function shardSignatures(roots: Iterable<EmbeddingRootRecord>): Map<number, string> {
  const entries = new Map<number, string[]>();
  for (const root of roots) {
    if (!root?.path || !isRootRecord(root)) continue;
    const shard = portableShardOf(root.path);
    const entry = [
      root.path,
      root.metadata.namespace,
      root.metadata.createdAt,
      root.metadata.chunkCount ?? "",
      root.metadata.complete === true ? 1 : 0,
    ].join("\u0000");
    const list = entries.get(shard);
    if (list) list.push(entry);
    else entries.set(shard, [entry]);
  }
  const signatures = new Map<number, string>();
  for (const [shard, list] of entries) {
    let hash = 0x811c9dc5;
    for (const character of list.sort().join("\u0001")) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    signatures.set(shard, `${list.length}:${(hash >>> 0).toString(16)}`);
  }
  return signatures;
}

async function readShardRecords(store: PortableIndexStore): Promise<ShardRecords> {
  const stored = await store.readState<ShardRecords>(SHARD_RECORDS_STATE_KEY);
  return stored?.version === 1 && stored.shards && typeof stored.shards === "object"
    ? { version: 1, shards: { ...stored.shards } }
    : { version: 1, shards: {} };
}

/**
 * Coalesces snapshot writes and writes only the shards whose notes changed.
 * Edits wait for a long quiet period; removals use a short one so bursts (a
 * folder of deletes, a rename storm) still become one write. A failed write
 * after a removal deletes the affected shards: a missing shard only costs a
 * re-embed on restore, while a stale one would resurrect removed notes. A
 * shard that could be neither rewritten nor deleted stays pending and is
 * retried, with backoff, until it is.
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
  private consecutiveFailures = 0;
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
   * Bring the files on disk in line with the store without rewriting shards
   * that already match. A missing or older-release `index.json` schedules
   * every shard (the one-time migration). Otherwise a shard is rewritten when
   * the notes it should hold differ from what this device last wrote there,
   * when it is missing, when it exists with no notes left, or when its file is
   * no longer the file this device wrote (another writer, a partial sync).
   */
  async reconcileFormat(): Promise<void> {
    const { store, file } = this.deps;
    const expected = shardSignatures(store.listRoots());
    if (expected.size === 0) return;
    const [manifestCurrent, onDisk, records] = await Promise.all([
      this.manifestIsCurrent(),
      file.listShards(),
      readShardRecords(store),
    ]);
    if (!manifestCurrent) this.writtenManifest = null;
    const stale: number[] = [];
    let recordsChanged = false;
    for (const shard of allShards()) {
      const signature = expected.get(shard);
      const record = records.shards[String(shard)];
      if (!manifestCurrent) {
        stale.push(shard);
      } else if (!signature || !onDisk.has(shard)) {
        if (Boolean(signature) !== onDisk.has(shard)) stale.push(shard);
      } else if (!record || record.signature !== signature) {
        stale.push(shard);
      } else {
        const verified = await this.verifyShardFile(shard, record);
        if (verified === "replaced") stale.push(shard);
        if (verified === "touched") recordsChanged = true;
      }
    }
    if (recordsChanged) await store.writeState(SHARD_RECORDS_STATE_KEY, records).catch(() => undefined);
    if (stale.length === 0) return;
    for (const shard of stale) this.pendingShards.add(shard);
    this.markChanged();
  }

  /**
   * Is the shard file still the one this device wrote? A stat answers when
   * size and modification time are unchanged. When only the time moved (a
   * sync tool re-downloading, or a same-size replacement), the checksum the
   * writer stored in the file's prefix settles it without hashing the file.
   */
  private async verifyShardFile(shard: number, record: ShardRecord): Promise<"same" | "touched" | "replaced"> {
    const stat = await this.deps.file.shardStat(shard);
    if (!stat || stat.size !== record.size) return "replaced";
    if (record.mtime !== null && stat.mtime === record.mtime) return "same";
    const bytes = await this.deps.file.readShard(shard);
    const checksum = bytes ? readPortableShardChecksum(bytes) : null;
    if (checksum === null || record.checksum === null || checksum !== record.checksum) return "replaced";
    record.mtime = stat.mtime;
    return "touched";
  }

  async clear(): Promise<void> {
    this.cancelTimer();
    this.revision += 1;
    this.writtenRevision = this.revision;
    this.destructiveRevision = 0;
    this.firstDirtyAt = null;
    this.firstDestructiveAt = null;
    this.consecutiveFailures = 0;
    this.pendingShards.clear();
    this.deps.store.takePortableChanges();
    this.writtenManifest = null;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await this.deps.file.remove?.();
      await this.deps.store.writeState<ShardRecords>(SHARD_RECORDS_STATE_KEY, { version: 1, shards: {} });
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
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      // Failed shards were deleted instead; nothing stale is left to retry.
      // A shard that could not even be deleted keeps the change pending.
      if (destructive && this.pendingShards.size === 0) {
        this.writtenRevision = Math.max(this.writtenRevision, targetRevision);
      }
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
      await file.remove?.();
      this.pendingShards.clear();
      this.writtenManifest = null;
      await store.writeState<ShardRecords>(SHARD_RECORDS_STATE_KEY, { version: 1, shards: {} });
      return;
    }

    const records = await readShardRecords(store);
    const signatures = shardSignatures(store.listRoots());
    try {
      for (const shard of [...this.pendingShards].sort((left, right) => left - right)) {
        const paths = pathsByShard.get(shard) ?? [];
        const bytes = paths.length > 0 ? encodePortableShard(shard, await store.readPaths(paths)) : null;
        if (bytes) {
          await file.writeShard(shard, bytes);
          records.shards[String(shard)] = {
            size: bytes.byteLength,
            signature: signatures.get(shard) ?? "",
            checksum: readPortableShardChecksum(bytes),
            mtime: (await file.shardStat(shard))?.mtime ?? null,
          };
        } else {
          await file.removeShard(shard);
          delete records.shards[String(shard)];
        }
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
        // Never leave shards holding records that were just removed. A shard
        // that cannot be deleted either stays pending for the next attempt.
        for (const shard of [...this.pendingShards]) {
          try {
            await file.removeShard(shard);
            delete records.shards[String(shard)];
            this.pendingShards.delete(shard);
          } catch { /* retried by the next flush */ }
        }
      }
      throw error;
    } finally {
      await store.writeState(SHARD_RECORDS_STATE_KEY, records).catch(() => undefined);
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
    let dueAt = Math.max(now, Math.min(now + quiet, deadline));
    if (this.consecutiveFailures > 0) {
      dueAt = Math.max(dueAt, now + Math.min(MAX_RETRY_DELAY_MS, quiet * 2 ** this.consecutiveFailures));
    }
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

export interface PortableSnapshot {
  committedNamespace: string | null;
  vectors: EmbeddingVector[];
  /** What each readable shard file held when it was read. */
  shards: Map<number, ShardRecord>;
}

function noteKey(vector: EmbeddingVector): string {
  return `${vector.metadata.namespace}\u0000${vector.path}`;
}

/** A note's root, which dates its embedding: source mtime, then embedding time. */
function newerNote(left: EmbeddingVector[], right: EmbeddingVector[]): EmbeddingVector[] {
  const leftRoot = left.find((vector) => vector.chunkId === 0);
  const rightRoot = right.find((vector) => vector.chunkId === 0);
  if (!rightRoot) return left;
  if (!leftRoot) return right;
  const byMtime = (rightRoot.metadata.mtime || 0) - (leftRoot.metadata.mtime || 0);
  if (byMtime !== 0) return byMtime > 0 ? right : left;
  return (rightRoot.metadata.createdAt || 0) > (leftRoot.metadata.createdAt || 0) ? right : left;
}

/**
 * Combine the sharded snapshot with an older release's single-file index when
 * both are present (a device on an older release rewrote index.json after
 * the shards were written, or the shards synced first). Each note keeps its
 * newer embedding; the shards win ties.
 */
function mergeNewestPerNote(sharded: EmbeddingVector[], legacy: EmbeddingVector[]): EmbeddingVector[] {
  if (legacy.length === 0) return sharded;
  if (sharded.length === 0) return legacy;
  const group = (vectors: EmbeddingVector[]) => {
    const groups = new Map<string, EmbeddingVector[]>();
    for (const vector of vectors) {
      const key = noteKey(vector);
      const list = groups.get(key);
      if (list) list.push(vector);
      else groups.set(key, [vector]);
    }
    return groups;
  };
  const merged = group(sharded);
  for (const [key, notes] of group(legacy)) {
    const current = merged.get(key);
    merged.set(key, current ? newerNote(current, notes) : notes);
  }
  return [...merged.values()].flat();
}

/**
 * Read whatever snapshot the vault folder holds: the format-4 manifest and its
 * shards, an older release's single-file index, or both. Shards are read
 * whenever they exist, even when `index.json` is missing, unparseable, not
 * yet synced, or an older release's file. A corrupt or partially synced shard
 * is skipped; its notes are re-embedded.
 */
export async function readPortableSnapshot(file: PortableIndexFile): Promise<PortableSnapshot | null> {
  const index = await file.read();
  const manifest = parsePortableManifest(index);
  const legacy = index && !manifest ? deserializeEmbeddingsIndex(index) : [];
  const shardFiles = await file.listShards();
  if (!index && shardFiles.size === 0) return null;
  const sharded: EmbeddingVector[] = [];
  const shards = new Map<number, ShardRecord>();
  for (const shard of [...shardFiles].sort((left, right) => left - right)) {
    const bytes = await file.readShard(shard);
    if (!bytes) continue;
    try {
      const decoded = decodePortableShard(bytes, shard);
      sharded.push(...decoded);
      shards.set(shard, {
        size: bytes.byteLength,
        signature: shardSignatures(decoded).get(shard) ?? "",
        checksum: readPortableShardChecksum(bytes),
        mtime: (await file.shardStat(shard))?.mtime ?? null,
      });
    } catch {
      // A shard that fails validation is treated as absent.
    }
  }
  return {
    committedNamespace: manifest?.committedNamespace ?? null,
    vectors: mergeNewestPerNote(sharded, legacy),
    shards,
  };
}

/**
 * Restore the index from the vault snapshot, but only when the local store is
 * empty (a fresh device / wiped IndexedDB). A populated store always wins so we
 * never clobber newer local vectors with a stale snapshot — mirroring the
 * existing legacy-DB import guard.
 *
 * `isRestorable` filters notes against this vault: a note that no longer
 * exists, or that the current exclusions hide, is never restored, whatever
 * the snapshot still holds.
 */
export async function restoreEmbeddingsIndexIfEmpty(deps: {
  store: PortableIndexStore;
  file: PortableIndexFile;
  isRestorable?: (path: string) => boolean;
}): Promise<RestoreResult> {
  const { store, file, isRestorable } = deps;

  const count = await store.countVectors();
  if (count > 0) {
    return { restored: false, imported: 0, reason: "store-not-empty" };
  }

  const snapshot = await readPortableSnapshot(file);
  if (!snapshot) {
    return { restored: false, imported: 0, reason: "no-snapshot" };
  }

  const present = isRestorable
    ? snapshot.vectors.filter((vector) => isRestorable(vector.path))
    : snapshot.vectors;
  const vectors = retainRestorableGenerations(present, snapshot.committedNamespace);
  const { imported } = await store.importVectors(vectors);
  // Record what each shard file held, so reconciliation rewrites exactly the
  // shards that still carry notes this restore left out.
  const shards: Record<string, ShardRecord> = {};
  for (const [shard, record] of snapshot.shards) shards[String(shard)] = record;
  await store.writeState<ShardRecords>(SHARD_RECORDS_STATE_KEY, { version: 1, shards });
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
