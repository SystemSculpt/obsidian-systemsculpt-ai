import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsStorage } from "../embeddings/storage/EmbeddingsStorage";
import type { EmbeddingVector } from "../embeddings/types";
import { buildVectorId } from "../embeddings/utils/vectorId";

function makeVector(path: string, namespace = "systemsculpt:openai/text-embedding-3-small:v2:3"): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path.replace(/\.md$/, ""),
      mtime: Date.now(),
      contentHash: `${path}-hash`,
      provider: "systemsculpt",
      model: "openai/text-embedding-3-small",
      dimension: 3,
      createdAt: Date.now(),
      namespace,
    },
  };
}

describe("EmbeddingsStorage.storeVectors", () => {
  it("does not update the in-memory cache when the transaction fails", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");

    const store = { put: jest.fn() };
    let tx: any = null;
    const db = {
      transaction: jest.fn(() => {
        tx = { objectStore: jest.fn(() => store) };
        return tx;
      }),
    };

    (storage as any).db = db;

    const vectors = [makeVector("A.md"), makeVector("B.md")];

    const promise = storage.storeVectors(vectors);

    expect(store.put).toHaveBeenCalledTimes(2);

    tx.error = new Error("transaction failed");
    tx.onerror();

    await expect(promise).rejects.toBeTruthy();

    expect((storage as any).cache.size).toBe(0);
    expect((storage as any).pathsSet.size).toBe(0);
  });

  it("updates cache and invalidates vector array cache on success", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");

    const store = { put: jest.fn() };
    let tx: any = null;
    const db = {
      transaction: jest.fn(() => {
        tx = { objectStore: jest.fn(() => store) };
        return tx;
      }),
    };

    (storage as any).db = db;
    (storage as any).vectorsArrayCache = [makeVector("Existing.md")];

    const vectors = [makeVector("C.md")];
    const vectorId = vectors[0].id;

    const promise = storage.storeVectors(vectors);
    expect(store.put).toHaveBeenCalledTimes(1);

    tx.oncomplete();
    await expect(promise).resolves.toBeUndefined();

    expect((storage as any).cache.has(vectorId)).toBe(true);
    expect((storage as any).pathsSet.has("C.md")).toBe(true);
    expect((storage as any).vectorsArrayCache).toBeNull();
  });
});
