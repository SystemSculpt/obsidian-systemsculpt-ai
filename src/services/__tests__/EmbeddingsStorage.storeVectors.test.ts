import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsStorage } from "../embeddings/storage/EmbeddingsStorage";
import type { EmbeddingVector } from "../embeddings/types";
import { buildVectorId } from "../embeddings/utils/vectorId";

function makeVector(path: string, namespace = "systemsculpt:managed:semantic-v1:v2:3"): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path.replace(/\.md$/, ""),
      mtime: Date.now(),
      contentHash: `${path}-hash`,
      generation: "semantic-v1",
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

  it("updates the root readiness cache on success", async () => {
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
    const vectors = [makeVector("C.md")];
    const vectorId = vectors[0].id;

    const promise = storage.storeVectors(vectors);
    expect(store.put).toHaveBeenCalledTimes(1);

    tx.oncomplete();
    await expect(promise).resolves.toBeUndefined();

    expect((storage as any).cache.has(vectorId)).toBe(true);
    expect((storage as any).pathsSet.has("C.md")).toBe(true);
  });

  it("keeps the root cache unchanged when a vector move transaction aborts", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const existing = makeVector("Move.md");
    (storage as any).cache.set(existing.id, existing);
    const getRequest: any = {};
    const store = {
      get: jest.fn(() => getRequest),
      put: jest.fn(),
      delete: jest.fn(),
    };
    const transaction: any = { objectStore: jest.fn(() => store) };
    (storage as any).db = { transaction: jest.fn(() => transaction) };
    const nextId = buildVectorId(existing.metadata.namespace, existing.path, 1);

    const move = storage.moveVectorId(existing.id, nextId, 1);
    getRequest.result = existing;
    getRequest.onsuccess();
    transaction.error = new Error("aborted");
    transaction.onabort();

    await expect(move).rejects.toThrow("aborted");
    expect((storage as any).cache.get(existing.id)).toBe(existing);
    expect((storage as any).cache.has(nextId)).toBe(false);
  });

  it("keeps cached roots until a removal transaction commits", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const existing = makeVector("Remove.md");
    (storage as any).cache.set(existing.id, existing);
    const store = { delete: jest.fn() };
    const transaction: any = { objectStore: jest.fn(() => store) };
    (storage as any).db = { transaction: jest.fn(() => transaction) };

    const removal = storage.removeIds([existing.id]);
    expect((storage as any).cache.has(existing.id)).toBe(true);
    transaction.oncomplete();

    await expect(removal).resolves.toBeUndefined();
    expect((storage as any).cache.has(existing.id)).toBe(false);
  });
});
