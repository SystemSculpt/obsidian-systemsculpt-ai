import { describe, expect, it, jest } from "@jest/globals";
import {
  restoreEmbeddingsIndexIfEmpty,
  writeEmbeddingsIndexSnapshot,
  PortableCheckpointCoordinator,
  type PortableIndexFile,
  type PortableIndexStore,
} from "../EmbeddingsPortableIndex";
import {
  EMBEDDINGS_INDEX_FORMAT,
  type SerializedEmbeddingsIndex,
} from "../EmbeddingsIndexSerialization";

function index(vectorCount: number): SerializedEmbeddingsIndex {
  return { format: EMBEDDINGS_INDEX_FORMAT, createdAt: 1, vectorCount, vectors: [] };
}

function makeStore(overrides: Partial<PortableIndexStore> = {}): jest.Mocked<PortableIndexStore> {
  return {
    countVectors: jest.fn(async () => 0),
    exportAll: jest.fn(async () => index(0)),
    importAll: jest.fn(async () => ({ imported: 0 })),
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
    const snapshot = index(5);
    const store = makeStore({
      countVectors: jest.fn(async () => 0),
      importAll: jest.fn(async () => ({ imported: 5 })),
    });
    const file = makeFile({ read: jest.fn(async () => snapshot) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(file.read).toHaveBeenCalledTimes(1);
    expect(store.importAll).toHaveBeenCalledWith(snapshot);
    expect(result).toEqual({ restored: true, imported: 5, reason: "restored" });
  });

  it("skips entirely when the store already has vectors", async () => {
    const store = makeStore({ countVectors: jest.fn(async () => 42) });
    const file = makeFile({ read: jest.fn(async () => index(5)) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(file.read).not.toHaveBeenCalled();
    expect(store.importAll).not.toHaveBeenCalled();
    expect(result).toEqual({ restored: false, imported: 0, reason: "store-not-empty" });
  });

  it("skips when no snapshot file is present", async () => {
    const store = makeStore({ countVectors: jest.fn(async () => 0) });
    const file = makeFile({ read: jest.fn(async () => null) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });

    expect(store.importAll).not.toHaveBeenCalled();
    expect(result).toEqual({ restored: false, imported: 0, reason: "no-snapshot" });
  });

  it("reports an empty/unusable snapshot without claiming a restore", async () => {
    const store = makeStore({
      countVectors: jest.fn(async () => 0),
      importAll: jest.fn(async () => ({ imported: 0 })),
    });
    const file = makeFile({ read: jest.fn(async () => index(0)) });

    const result = await restoreEmbeddingsIndexIfEmpty({ store, file });
    expect(result).toEqual({ restored: false, imported: 0, reason: "empty-snapshot" });
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
