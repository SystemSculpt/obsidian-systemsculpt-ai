import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsStorage } from "../embeddings/storage/EmbeddingsStorage";
import type { EmbeddingVector } from "../embeddings/types";
import { buildVectorId } from "../embeddings/utils/vectorId";

function makeVector(path: string, namespace = "systemsculpt:managed:semantic-v1:v3:3"): EmbeddingVector {
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

function makePublishedVector(path: string, chunkId: number): EmbeddingVector {
  const namespace = "systemsculpt:managed:semantic-v1:v3:3";
  return {
    ...makeVector(path, namespace),
    id: buildVectorId(namespace, path, chunkId),
    chunkId,
    metadata: {
      ...makeVector(path, namespace).metadata,
      ...(chunkId === 0 ? { complete: true, partial: false, chunkCount: 2 } : {}),
    },
  };
}

function makeEmptyMarker(path: string): EmbeddingVector {
  const namespace = "systemsculpt:local-empty:v1:1";
  return {
    id: buildVectorId(namespace, path, 0),
    path,
    chunkId: 0,
    vector: new Float32Array([0]),
    metadata: {
      title: path.replace(/\.md$/, ""),
      excerpt: "",
      mtime: 2,
      contentHash: "empty:test",
      dimension: 1,
      createdAt: 2,
      namespace,
      isEmpty: true,
      complete: true,
      partial: false,
      chunkCount: 0,
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

  it("publishes every same-namespace chunk and stale deletion in one transaction", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const getAllKeys: any = {};
    const store = {
      delete: jest.fn(),
      put: jest.fn(),
      index: jest.fn(() => ({ getAllKeys: jest.fn(() => getAllKeys) })),
    };
    const transaction: any = { objectStore: jest.fn(() => store) };
    (storage as any).db = { transaction: jest.fn(() => transaction) };
    const previousKeyRange = globalThis.IDBKeyRange;
    Object.defineProperty(globalThis, "IDBKeyRange", {
      configurable: true,
      value: { only: jest.fn((value) => value) },
    });
    const vectors = [makePublishedVector("Atomic.md", 0), makePublishedVector("Atomic.md", 1)];
    const staleId = buildVectorId(vectors[0].metadata.namespace, "Atomic.md", 2);
    const priorGenerationId = buildVectorId(
      "systemsculpt:managed:semantic-v1:v2:3",
      "Atomic.md",
      0,
    );
    const emptyMarkerId = "systemsculpt:local-empty:v1:1::Atomic.md#0";

    try {
      const publication = storage.publishPath(
        "Atomic.md",
        vectors[0].metadata.namespace,
        vectors,
      );
      getAllKeys.result = [staleId, priorGenerationId, emptyMarkerId];
      getAllKeys.onsuccess();

      expect(store.delete).toHaveBeenCalledWith(staleId);
      expect(store.delete).toHaveBeenCalledWith(emptyMarkerId);
      expect(store.delete).not.toHaveBeenCalledWith(priorGenerationId);
      expect(store.put.mock.calls.map((call) => call[0].id)).toEqual(
        vectors.map((vector) => vector.id),
      );
      expect((storage as any).cache.size).toBe(0);

      transaction.oncomplete();
      await expect(publication).resolves.toBeUndefined();
      expect((storage as any).cache.get(vectors[0].id)).toEqual(vectors[0]);
      expect((storage as any).pathsSet.has("Atomic.md")).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "IDBKeyRange", {
        configurable: true,
        value: previousKeyRange,
      });
    }
  });

  it("keeps the prior root cache unchanged when atomic path publication aborts", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const prior = makeVector("Atomic.md", "systemsculpt:managed:semantic-v1:v3:3");
    (storage as any).cache.set(prior.id, prior);
    const getAllKeys: any = {};
    const store = {
      delete: jest.fn(),
      put: jest.fn(),
      index: jest.fn(() => ({ getAllKeys: jest.fn(() => getAllKeys) })),
    };
    const transaction: any = { objectStore: jest.fn(() => store) };
    (storage as any).db = { transaction: jest.fn(() => transaction) };
    const previousKeyRange = globalThis.IDBKeyRange;
    Object.defineProperty(globalThis, "IDBKeyRange", {
      configurable: true,
      value: { only: jest.fn((value) => value) },
    });

    try {
      const publication = storage.publishPath(
        "Atomic.md",
        "systemsculpt:managed:semantic-v1:v3:3",
        [makePublishedVector("Atomic.md", 0)],
      );
      transaction.error = new Error("aborted");
      transaction.onabort();

      await expect(publication).rejects.toThrow("aborted");
      expect((storage as any).cache.get(prior.id)).toBe(prior);
    } finally {
      Object.defineProperty(globalThis, "IDBKeyRange", {
        configurable: true,
        value: previousKeyRange,
      });
    }
  });

  it("atomically replaces every generation with a local empty marker", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const current = makeVector("Empty-now.md");
    const replacement = makeVector(
      "Empty-now.md",
      "systemsculpt:managed:semantic-v1:v4:3",
    );
    (storage as any).cache.set(current.id, current);
    (storage as any).cache.set(replacement.id, replacement);
    (storage as any).pathsSet.add(current.path);
    const getAllKeys: any = {};
    const store = {
      delete: jest.fn(),
      put: jest.fn(),
      index: jest.fn(() => ({ getAllKeys: jest.fn(() => getAllKeys) })),
    };
    const transaction: any = { objectStore: jest.fn(() => store) };
    (storage as any).db = { transaction: jest.fn(() => transaction) };
    const previousKeyRange = globalThis.IDBKeyRange;
    Object.defineProperty(globalThis, "IDBKeyRange", {
      configurable: true,
      value: { only: jest.fn((value) => value) },
    });
    const marker = makeEmptyMarker(current.path);

    try {
      const publication = storage.replacePath(current.path, [marker]);
      getAllKeys.result = [current.id, replacement.id];
      getAllKeys.onsuccess();

      expect(store.delete.mock.calls.map((call) => call[0])).toEqual([
        current.id,
        replacement.id,
      ]);
      expect(store.put).toHaveBeenCalledWith(marker);
      expect((storage as any).cache.get(current.id)).toBe(current);
      expect((storage as any).cache.get(replacement.id)).toBe(replacement);

      transaction.oncomplete();
      await expect(publication).resolves.toBeUndefined();
      expect((storage as any).cache.has(current.id)).toBe(false);
      expect((storage as any).cache.has(replacement.id)).toBe(false);
      expect((storage as any).cache.get(marker.id)).toBe(marker);
      expect((storage as any).pathsSet.has(current.path)).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "IDBKeyRange", {
        configurable: true,
        value: previousKeyRange,
      });
    }
  });

  it("preserves every cached generation when empty-marker replacement aborts", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const current = makeVector("Still-indexed.md");
    (storage as any).cache.set(current.id, current);
    const getAllKeys: any = {};
    const store = {
      delete: jest.fn(),
      put: jest.fn(),
      index: jest.fn(() => ({ getAllKeys: jest.fn(() => getAllKeys) })),
    };
    const transaction: any = { objectStore: jest.fn(() => store) };
    (storage as any).db = { transaction: jest.fn(() => transaction) };
    const previousKeyRange = globalThis.IDBKeyRange;
    Object.defineProperty(globalThis, "IDBKeyRange", {
      configurable: true,
      value: { only: jest.fn((value) => value) },
    });

    try {
      const publication = storage.replacePath(current.path, [makeEmptyMarker(current.path)]);
      transaction.error = new Error("aborted");
      transaction.onabort();

      await expect(publication).rejects.toThrow("aborted");
      expect((storage as any).cache.get(current.id)).toBe(current);
    } finally {
      Object.defineProperty(globalThis, "IDBKeyRange", {
        configurable: true,
        value: previousKeyRange,
      });
    }
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

  it("deletes a managed generation through the object store while iterating its index", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::test");
    const existing = makeVector("Managed.md");
    (storage as any).cache.set(existing.id, existing);
    (storage as any).pathsSet.add(existing.path);

    const cursorRequest: any = {};
    const index = { openKeyCursor: jest.fn(() => cursorRequest) };
    const store = {
      delete: jest.fn(),
      index: jest.fn(() => index),
    };
    const transaction: any = { objectStore: jest.fn(() => store) };
    (storage as any).db = { transaction: jest.fn(() => transaction) };
    const previousKeyRange = globalThis.IDBKeyRange;
    Object.defineProperty(globalThis, "IDBKeyRange", {
      configurable: true,
      value: { bound: jest.fn(() => ({ lower: "managed", upper: "managed-max" })) },
    });

    try {
      const removal = storage.removeCurrentManagedGeneration();
      const cursor = { primaryKey: existing.id, continue: jest.fn() };
      cursorRequest.result = cursor;
      cursorRequest.onsuccess();

      expect(store.delete).toHaveBeenCalledWith(existing.id);
      expect(cursor.continue).toHaveBeenCalledTimes(1);
      expect((storage as any).cache.has(existing.id)).toBe(true);

      transaction.oncomplete();
      await expect(removal).resolves.toBeUndefined();
      expect((storage as any).cache.has(existing.id)).toBe(false);
      expect((storage as any).pathsSet.has(existing.path)).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "IDBKeyRange", {
        configurable: true,
        value: previousKeyRange,
      });
    }
  });
});
