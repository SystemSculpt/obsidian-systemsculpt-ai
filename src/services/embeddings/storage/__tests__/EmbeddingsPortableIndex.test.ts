import { describe, expect, it, jest } from "@jest/globals";
import {
  restoreEmbeddingsIndexIfEmpty,
  retainRestorableGenerations,
  writeEmbeddingsIndexSnapshot,
  PortableCheckpointCoordinator,
  type PortableIndexFile,
  type PortableIndexStore,
} from "../EmbeddingsPortableIndex";
import {
  EMBEDDINGS_INDEX_FORMAT,
  serializeEmbeddingsIndex,
  type SerializedEmbeddingsIndex,
} from "../EmbeddingsIndexSerialization";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import { createLocalEmptyEmbeddingMarkerForRevision } from "../../LocalEmptyEmbeddingMarker";

function index(vectorCount: number): SerializedEmbeddingsIndex {
  return { format: EMBEDDINGS_INDEX_FORMAT, createdAt: 1, vectorCount, vectors: [] };
}

function root(namespace: string, path: string, createdAt: number, chunkId = 0): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, chunkId),
    path,
    chunkId,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path,
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

function makeStore(overrides: Partial<PortableIndexStore> = {}): jest.Mocked<PortableIndexStore> {
  return {
    countVectors: jest.fn(async () => 0),
    exportAll: jest.fn(async () => index(0)),
    importVectors: jest.fn(async (vectors: EmbeddingVector[]) => ({ imported: vectors.length })),
    ...overrides,
  } as jest.Mocked<PortableIndexStore>;
}

function makeFile(overrides: Partial<PortableIndexFile> = {}): jest.Mocked<PortableIndexFile> {
  return {
    read: jest.fn(async () => null),
    write: jest.fn(async () => undefined),
    ...overrides,
  } as jest.Mocked<PortableIndexFile>;
}

describe("restoreEmbeddingsIndexIfEmpty", () => {
  it("imports the snapshot when the local store is empty", async () => {
    const namespace = "systemsculpt:managed:semantic-v1:v3:3";
    const snapshot = serializeEmbeddingsIndex([root(namespace, "A.md", 1), root(namespace, "B.md", 1)]);
    const store = makeStore({ countVectors: jest.fn(async () => 0) });
    const file = makeFile({ read: jest.fn(async () => snapshot) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(file.read).toHaveBeenCalledTimes(1);
    expect(store.importVectors).toHaveBeenCalledTimes(1);
    expect(store.importVectors.mock.calls[0][0].map((vector) => vector.path)).toEqual(["A.md", "B.md"]);
    expect(result).toEqual({ restored: true, imported: 2, reason: "restored" });
  });

  it("restores only the committed and in-progress generations of an old snapshot", async () => {
    const v2 = "systemsculpt:managed:semantic-v1:v2:3";
    const v3 = "systemsculpt:managed:semantic-v1:v3:3";
    const v4 = "systemsculpt:managed:semantic-v1:v4:3";
    const snapshot = serializeEmbeddingsIndex([
      root(v2, "A.md", 10), root(v2, "B.md", 10),
      root(v3, "A.md", 20), root(v3, "B.md", 20), root(v3, "C.md", 20), root(v3, "C.md", 20, 1),
      root(v4, "A.md", 30),
      createLocalEmptyEmbeddingMarkerForRevision({ path: "Empty.md", basename: "Empty", mtime: 1 }, ""),
    ]);
    const store = makeStore();
    const file = makeFile({ read: jest.fn(async () => snapshot) });

    await restoreEmbeddingsIndexIfEmpty({ store, file });

    const restored = store.importVectors.mock.calls[0][0];
    expect([...new Set(restored.map((vector) => vector.metadata.namespace))].sort()).toEqual([
      "systemsculpt:local-empty:v1:1",
      v3,
      v4,
    ].sort());
    expect(restored.filter((vector) => vector.metadata.namespace === v3)).toHaveLength(4);
  });

  it("skips entirely when the store already has vectors", async () => {
    const store = makeStore({ countVectors: jest.fn(async () => 42) });
    const file = makeFile({ read: jest.fn(async () => index(5)) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(file.read).not.toHaveBeenCalled();
    expect(store.importVectors).not.toHaveBeenCalled();
    expect(result).toEqual({ restored: false, imported: 0, reason: "store-not-empty" });
  });

  it("skips when no snapshot file is present", async () => {
    const store = makeStore({ countVectors: jest.fn(async () => 0) });
    const file = makeFile({ read: jest.fn(async () => null) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(store.importVectors).not.toHaveBeenCalled();
    expect(result).toEqual({ restored: false, imported: 0, reason: "no-snapshot" });
  });

  it("reports an empty/unusable snapshot without claiming a restore", async () => {
    const store = makeStore({ countVectors: jest.fn(async () => 0) });
    const file = makeFile({ read: jest.fn(async () => index(0)) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });
    expect(result).toEqual({ restored: false, imported: 0, reason: "empty-snapshot" });
  });
});

describe("retainRestorableGenerations", () => {
  it("prefers the committed generation named by the snapshot over the most complete one", () => {
    const v2 = "systemsculpt:managed:semantic-v1:v2:3";
    const v3 = "systemsculpt:managed:semantic-v1:v3:3";
    const v4 = "systemsculpt:managed:semantic-v1:v4:3";
    const vectors = [root(v2, "A.md", 1), root(v2, "B.md", 1), root(v3, "A.md", 1), root(v4, "A.md", 9)];
    const namespaces = (kept: EmbeddingVector[]) => [...new Set(kept.map((vector) => vector.metadata.namespace))].sort();

    expect(namespaces(retainRestorableGenerations(vectors))).toEqual([v2, v4]);
    expect(namespaces(retainRestorableGenerations(vectors, v3))).toEqual([v3, v4]);
  });
});

describe("writeEmbeddingsIndexSnapshot", () => {
  it("writes the exported index when it has vectors", async () => {
    const exported = index(7);
    const store = makeStore({ exportAll: jest.fn(async () => exported) });
    const file = makeFile();

    const result = await writeEmbeddingsIndexSnapshot({ store, file });

    expect(file.write).toHaveBeenCalledWith(exported);
    expect(result).toEqual({ written: true, count: 7 });
  });

  it("does not write an empty index (nothing to snapshot)", async () => {
    const store = makeStore({ exportAll: jest.fn(async () => index(0)) });
    const file = makeFile();

    const result = await writeEmbeddingsIndexSnapshot({ store, file });

    expect(file.write).not.toHaveBeenCalled();
    expect(result).toEqual({ written: false, count: 0 });
  });
});

describe("PortableCheckpointCoordinator", () => {
  it("coalesces ordinary edits into one atomic snapshot flush", async () => {
    const store = makeStore({ exportAll: jest.fn(async () => index(3)) });
    const file = makeFile();
    const checkpoint = new PortableCheckpointCoordinator({ store, file }, 60_000, 60_000);

    checkpoint.markChanged();
    checkpoint.markChanged();
    checkpoint.markChanged();
    expect(store.exportAll).not.toHaveBeenCalled();

    await checkpoint.flush();

    expect(store.exportAll).toHaveBeenCalledTimes(1);
    expect(file.write).toHaveBeenCalledTimes(1);
    expect(checkpoint.status().pending).toBe(false);
    checkpoint.cancel();
  });

  it("commits destructive mutations immediately and deletes an empty checkpoint", async () => {
    const store = makeStore({ exportAll: jest.fn(async () => index(0)) });
    const file = makeFile({ remove: jest.fn(async () => undefined) });
    const checkpoint = new PortableCheckpointCoordinator({ store, file }, 60_000, 60_000);

    await checkpoint.commitDestructiveMutation();

    expect(store.exportAll).toHaveBeenCalledTimes(1);
    expect(file.write).not.toHaveBeenCalled();
    expect(file.remove).toHaveBeenCalledTimes(1);
    checkpoint.cancel();
  });

  it("clear always removes the portable checkpoint instead of preserving ghost notes", async () => {
    const store = makeStore({ exportAll: jest.fn(async () => index(4)) });
    const file = makeFile({ remove: jest.fn(async () => undefined) });
    const checkpoint = new PortableCheckpointCoordinator({ store, file }, 60_000, 60_000);
    checkpoint.markChanged();

    await checkpoint.clear();

    expect(file.remove).toHaveBeenCalledTimes(1);
    expect(file.write).not.toHaveBeenCalled();
    expect(checkpoint.status().pending).toBe(false);
  });

  it("deletes a stale checkpoint when a destructive rewrite fails", async () => {
    const store = makeStore({ exportAll: jest.fn(async () => index(2)) });
    const file = makeFile({
      write: jest.fn(async () => { throw new Error("sync adapter failed"); }),
      remove: jest.fn(async () => undefined),
    });
    const checkpoint = new PortableCheckpointCoordinator({ store, file }, 60_000, 60_000);

    await expect(checkpoint.commitDestructiveMutation()).rejects.toThrow("sync adapter failed");

    expect(file.remove).toHaveBeenCalledTimes(1);
    expect(checkpoint.status().pending).toBe(false);
  });
});
