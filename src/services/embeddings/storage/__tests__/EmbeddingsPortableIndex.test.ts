import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  readPortableSnapshot,
  restoreEmbeddingsIndexIfEmpty,
  retainRestorableGenerations,
  PortableCheckpointCoordinator,
  type PortableIndexFile,
  type PortableIndexStore,
} from "../EmbeddingsPortableIndex";
import {
  encodePortableShard,
  portableShardOf,
  PORTABLE_SHARD_COUNT,
  type PortableIndexManifest,
} from "../EmbeddingsIndexSerialization";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import { createLocalEmptyEmbeddingMarkerForRevision } from "../../LocalEmptyEmbeddingMarker";
import { serializeLegacyEmbeddingsIndex } from "../../__tests__/support/legacyIndexFixture";

const V3 = "systemsculpt:managed:semantic-v1:v3:3";

function root(namespace: string, path: string, createdAt: number, chunkId = 0): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, chunkId),
    path,
    chunkId,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path.replace(/\.md$/, ""),
      mtime: 1,
      contentHash: `${path}:${chunkId}`,
      generation: "semantic-v1",
      dimension: 3,
      createdAt,
      namespace,
      ...(chunkId === 0 ? { complete: true, chunkCount: 1 } : {}),
    },
  };
}

/** An in-memory store holding records and the snapshot change log. */
function memoryStore(records: EmbeddingVector[] = []) {
  const vectors = new Map(records.map((record) => [record.id, record]));
  let changes = { all: false, paths: new Set<string>() };
  const store = {
    vectors,
    countVectors: jest.fn(async () => vectors.size),
    importVectors: jest.fn(async (imported: EmbeddingVector[]) => {
      for (const record of imported) vectors.set(record.id, record);
      return { imported: imported.length };
    }),
    getDistinctPaths: jest.fn(() => [...new Set([...vectors.values()]
      .filter((record) => record.chunkId === 0)
      .map((record) => record.path))]),
    readPaths: jest.fn(async (paths: readonly string[]) => [...vectors.values()].filter((record) => paths.includes(record.path))),
    takePortableChanges: jest.fn(() => {
      const taken = { all: changes.all, paths: [...changes.paths] };
      changes = { all: false, paths: new Set() };
      return taken;
    }),
    put(record: EmbeddingVector) {
      vectors.set(record.id, record);
      changes.paths.add(record.path);
    },
    removePath(path: string) {
      for (const [id, record] of vectors) if (record.path === path) vectors.delete(id);
      changes.paths.add(path);
    },
  };
  return store as typeof store & jest.Mocked<PortableIndexStore>;
}

/** An in-memory snapshot directory. */
function memoryFile(initial: { index?: Record<string, unknown> | null } = {}) {
  let index: Record<string, unknown> | null = initial.index ?? null;
  const shards = new Map<number, ArrayBuffer>();
  const file = {
    shards,
    get index() { return index; },
    read: jest.fn(async () => index),
    write: jest.fn(async (manifest: PortableIndexManifest) => { index = JSON.parse(JSON.stringify(manifest)); }),
    size: jest.fn(async () => (index ? JSON.stringify(index).length : null)),
    listShards: jest.fn(async () => new Set(shards.keys())),
    readShard: jest.fn(async (shard: number) => shards.get(shard) ?? null),
    writeShard: jest.fn(async (shard: number, bytes: ArrayBuffer) => { shards.set(shard, bytes); }),
    removeShard: jest.fn(async (shard: number) => { shards.delete(shard); }),
    removeRecoveryCopy: jest.fn(async () => undefined),
    remove: jest.fn(async () => {
      index = null;
      shards.clear();
    }),
  };
  return file as typeof file & jest.Mocked<PortableIndexFile>;
}

describe("restoreEmbeddingsIndexIfEmpty", () => {
  it("restores an older release's single-file index", async () => {
    const snapshot = serializeLegacyEmbeddingsIndex([root(V3, "A.md", 1), root(V3, "B.md", 1)]);
    const store = memoryStore();
    const file = memoryFile({ index: snapshot as unknown as Record<string, unknown> });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(result).toEqual({ restored: true, imported: 2, reason: "restored" });
    expect(store.importVectors.mock.calls[0][0].map((vector) => vector.path)).toEqual(["A.md", "B.md"]);
  });

  it("restores the sharded snapshot, even before its manifest has synced", async () => {
    const records = ["A.md", "B.md", "C.md"].map((path) => root(V3, path, 1));
    const file = memoryFile();
    for (const record of records) {
      file.shards.set(portableShardOf(record.path), encodePortableShard(portableShardOf(record.path), [record])!);
    }
    const store = memoryStore();

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(result).toMatchObject({ restored: true, imported: 3 });
    expect(store.importVectors.mock.calls[0][0].map((vector) => vector.id).sort()).toEqual(
      records.map((record) => record.id).sort(),
    );
  });

  it("skips a corrupt shard and restores the rest", async () => {
    const good = root(V3, "Good.md", 1);
    const file = memoryFile();
    file.shards.set(portableShardOf(good.path), encodePortableShard(portableShardOf(good.path), [good])!);
    const corruptShard = (portableShardOf(good.path) + 1) % PORTABLE_SHARD_COUNT;
    file.shards.set(corruptShard, new Uint8Array([1, 2, 3]).buffer);

    const snapshot = await readPortableSnapshot(file);

    expect(snapshot?.vectors.map((vector) => vector.path)).toEqual(["Good.md"]);
  });

  it("skips entirely when the store already has vectors", async () => {
    const store = memoryStore([root(V3, "Local.md", 1)]);
    const file = memoryFile({ index: serializeLegacyEmbeddingsIndex([root(V3, "A.md", 1)]) as never });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(file.read).not.toHaveBeenCalled();
    expect(store.importVectors).not.toHaveBeenCalled();
    expect(result).toEqual({ restored: false, imported: 0, reason: "store-not-empty" });
  });

  it("skips when no snapshot is present", async () => {
    const store = memoryStore();

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file: memoryFile() });

    expect(store.importVectors).not.toHaveBeenCalled();
    expect(result).toEqual({ restored: false, imported: 0, reason: "no-snapshot" });
  });

  it("restores only the committed and in-progress generations of an old snapshot", async () => {
    const v2 = "systemsculpt:managed:semantic-v1:v2:3";
    const v4 = "systemsculpt:managed:semantic-v1:v4:3";
    const snapshot = serializeLegacyEmbeddingsIndex([
      root(v2, "A.md", 10), root(v2, "B.md", 10),
      root(V3, "A.md", 20), root(V3, "B.md", 20), root(V3, "C.md", 20), root(V3, "C.md", 20, 1),
      root(v4, "A.md", 30),
      createLocalEmptyEmbeddingMarkerForRevision({ path: "Empty.md", basename: "Empty", mtime: 1 }, ""),
    ]);
    const store = memoryStore();

    await restoreEmbeddingsIndexIfEmpty({ store, file: memoryFile({ index: snapshot as never }) });

    const restored = store.importVectors.mock.calls[0][0];
    expect([...new Set(restored.map((vector) => vector.metadata.namespace))].sort()).toEqual([
      "systemsculpt:local-empty:v1:1",
      V3,
      v4,
    ].sort());
    expect(restored.filter((vector) => vector.metadata.namespace === V3)).toHaveLength(4);
  });

  it("reports an empty or unusable snapshot without claiming a restore", async () => {
    const result = await restoreEmbeddingsIndexIfEmpty({
      store: memoryStore(),
      file: memoryFile({ index: { format: 999 } }),
    });
    expect(result).toEqual({ restored: false, imported: 0, reason: "empty-snapshot" });
  });
});

describe("retainRestorableGenerations", () => {
  it("prefers the committed generation named by the snapshot over the most complete one", () => {
    const v2 = "systemsculpt:managed:semantic-v1:v2:3";
    const v4 = "systemsculpt:managed:semantic-v1:v4:3";
    const vectors = [root(v2, "A.md", 1), root(v2, "B.md", 1), root(V3, "A.md", 1), root(v4, "A.md", 9)];
    const namespaces = (kept: EmbeddingVector[]) => [...new Set(kept.map((vector) => vector.metadata.namespace))].sort();

    expect(namespaces(retainRestorableGenerations(vectors))).toEqual([v2, v4]);
    expect(namespaces(retainRestorableGenerations(vectors, V3))).toEqual([V3, v4]);
  });
});

describe("PortableCheckpointCoordinator", () => {
  const timing = { quietMs: 60_000, maxWaitMs: 60_000, destructiveQuietMs: 1_000, destructiveMaxWaitMs: 5_000 };

  afterEach(() => {
    jest.useRealTimers();
  });

  function seeded(count: number) {
    const store = memoryStore(Array.from({ length: count }, (_, index) => root(V3, `Notes/${index}.md`, 1)));
    const file = memoryFile();
    const checkpoint = new PortableCheckpointCoordinator({ store, file, committedNamespace: () => V3 }, timing);
    return { store, file, checkpoint };
  }

  it("migrates an older release's snapshot once, then rewrites only the shard an edit touched", async () => {
    const { store, file, checkpoint } = seeded(200);
    (file as unknown as { write: (value: object) => Promise<void> }).write({ format: 3, vectors: [] });
    file.write.mockClear();

    await checkpoint.reconcileFormat();
    await checkpoint.flush();

    const occupied = new Set(store.getDistinctPaths().map((path) => portableShardOf(path)));
    expect(new Set(file.shards.keys())).toEqual(occupied);
    expect(file.index).toEqual({ format: 4, vectorEncoding: "int8-scaled-v1", shardCount: 32, committedNamespace: V3 });
    expect(file.removeRecoveryCopy).toHaveBeenCalled();

    file.writeShard.mockClear();
    file.write.mockClear();
    store.put({ ...root(V3, "Notes/7.md", 2) });
    checkpoint.markChanged();
    await checkpoint.flush();

    expect(file.writeShard).toHaveBeenCalledTimes(1);
    expect(file.writeShard.mock.calls[0][0]).toBe(portableShardOf("Notes/7.md"));
    expect(file.write).not.toHaveBeenCalled();
    checkpoint.cancel();
  });

  it("schedules nothing when the snapshot on disk is already current", async () => {
    const { file, checkpoint } = seeded(50);
    await checkpoint.reconcileFormat();
    await checkpoint.flush();
    file.writeShard.mockClear();

    const restarted = new PortableCheckpointCoordinator({
      store: memoryStore([...Array.from({ length: 50 }, (_, index) => root(V3, `Notes/${index}.md`, 1))]),
      file,
    }, timing);
    await restarted.reconcileFormat();

    expect(restarted.status().pending).toBe(false);
    expect(file.writeShard).not.toHaveBeenCalled();
  });

  it("restores a shard that went missing from disk", async () => {
    const { store, file, checkpoint } = seeded(50);
    await checkpoint.reconcileFormat();
    await checkpoint.flush();
    const lost = portableShardOf(store.getDistinctPaths()[0]);
    file.shards.delete(lost);
    file.writeShard.mockClear();

    await checkpoint.reconcileFormat();
    await checkpoint.flush();

    expect(file.writeShard.mock.calls.map((call) => call[0])).toEqual([lost]);
  });

  it("removes a shard whose last note was deleted", async () => {
    const { store, file, checkpoint } = seeded(1);
    store.put(root(V3, "Other.md", 1));
    await checkpoint.reconcileFormat();
    await checkpoint.flush();
    const shard = portableShardOf("Notes/0.md");
    expect(file.shards.has(shard)).toBe(true);

    store.removePath("Notes/0.md");
    checkpoint.markDestructive();
    await checkpoint.flush();

    if (shard !== portableShardOf("Other.md")) expect(file.shards.has(shard)).toBe(false);
    expect(file.index).not.toBeNull();
  });

  it("writes nothing when nothing changed", async () => {
    const { file, checkpoint } = seeded(3);

    await checkpoint.flush();

    expect(file.writeShard).not.toHaveBeenCalled();
    expect(file.write).not.toHaveBeenCalled();
  });

  it("waits out a quiet period for edits, bounded by the maximum wait", async () => {
    jest.useFakeTimers();
    const store = memoryStore([root(V3, "A.md", 1)]);
    const file = memoryFile();
    const checkpoint = new PortableCheckpointCoordinator({ store, file }, {
      ...timing,
      quietMs: 30_000,
      maxWaitMs: 120_000,
    });

    for (let tick = 0; tick < 9; tick += 1) {
      store.put(root(V3, "A.md", tick));
      checkpoint.markChanged();
      await jest.advanceTimersByTimeAsync(20_000);
    }

    // Continuous edits every 20 s never go quiet, so only the 2-minute cap fires.
    expect(file.writeShard).toHaveBeenCalledTimes(1);
    checkpoint.cancel();
  });

  it("coalesces a burst of removals into one expedited write", async () => {
    jest.useFakeTimers();
    const { store, file, checkpoint } = seeded(30);

    for (let index = 0; index < 20; index += 1) {
      store.removePath(`Notes/${index}.md`);
      checkpoint.markDestructive();
      await jest.advanceTimersByTimeAsync(100);
    }
    expect(file.writeShard).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(store.takePortableChanges).toHaveBeenCalledTimes(1);
    expect(file.index).not.toBeNull();
    checkpoint.cancel();
  });

  it("removes the whole snapshot once no notes remain", async () => {
    const { store, file, checkpoint } = seeded(1);
    await checkpoint.reconcileFormat();
    await checkpoint.flush();

    store.removePath("Notes/0.md");
    checkpoint.markDestructive();
    await checkpoint.flush();

    expect(file.remove).toHaveBeenCalledTimes(1);
    expect(file.index).toBeNull();
    expect(file.shards.size).toBe(0);
  });

  it("clear always removes the portable checkpoint instead of preserving ghost notes", async () => {
    const { file, checkpoint } = seeded(4);
    checkpoint.markChanged();

    await checkpoint.clear();

    expect(file.remove).toHaveBeenCalledTimes(1);
    expect(file.writeShard).not.toHaveBeenCalled();
    expect(checkpoint.status().pending).toBe(false);
  });

  it("drops the affected shard and reports it when a removal rewrite fails", async () => {
    jest.useFakeTimers();
    const { store, file, checkpoint } = seeded(2);
    const onError = jest.fn();
    const failing = new PortableCheckpointCoordinator({ store, file, onError }, timing);
    await checkpoint.reconcileFormat();
    await checkpoint.flush();
    const shard = portableShardOf("Notes/1.md");
    file.writeShard.mockImplementation(async () => { throw new Error("sync adapter failed"); });

    store.removePath("Notes/1.md");
    store.put(root(V3, `Other-${shard}.md`, 1));
    failing.markDestructive();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "sync adapter failed" }), true);
    expect(file.removeShard).toHaveBeenCalledWith(shard);
    expect(file.shards.has(shard)).toBe(false);
    expect(failing.status().pending).toBe(false);
  });

  it("keeps the previous shard and retries when an ordinary rewrite fails", async () => {
    const { store, file, checkpoint } = seeded(2);
    await checkpoint.reconcileFormat();
    await checkpoint.flush();
    const shard = portableShardOf("Notes/1.md");
    const previous = file.shards.get(shard);
    file.writeShard.mockImplementationOnce(async () => { throw new Error("disk full"); });

    store.put(root(V3, "Notes/1.md", 5));
    checkpoint.markChanged();
    await expect(checkpoint.flush()).rejects.toThrow("disk full");

    expect(file.shards.get(shard)).toBe(previous);
    expect(checkpoint.status().pending).toBe(true);
    await checkpoint.flush();
    expect(file.shards.get(shard)).not.toBe(previous);
    checkpoint.cancel();
  });
});
