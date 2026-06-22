import { describe, expect, it, jest } from "@jest/globals";
import {
  restoreEmbeddingsIndexIfEmpty,
  writeEmbeddingsIndexSnapshot,
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
