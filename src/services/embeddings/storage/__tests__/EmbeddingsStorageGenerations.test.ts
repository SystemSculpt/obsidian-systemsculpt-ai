import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsStorage, EmbeddingsStorageBlockedError } from "../EmbeddingsStorage";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import { createLocalEmptyEmbeddingMarkerForRevision } from "../../LocalEmptyEmbeddingMarker";
import { installFakeIndexedDb } from "../../__tests__/support/fakeIndexedDb";

const V2 = "systemsculpt:managed:semantic-v1:v2:3";
const V3 = "systemsculpt:managed:semantic-v1:v3:3";
const V4 = "systemsculpt:managed:semantic-v1:v4:3";
const LEGACY = "systemsculpt:openrouter/openai/text-embedding-3-small:v2:3";

function record(namespace: string, path: string, chunkId: number, createdAt = 1): EmbeddingVector {
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
      ...(chunkId === 0 ? { complete: true, chunkCount: 2 } : {}),
    },
  };
}

function openDatabase(
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function indexNames(db: IDBDatabase): string[] {
  const names = db.transaction("embeddings", "readonly").objectStore("embeddings").indexNames;
  return ["by_path", "by_namespace", "by_mtime", "by_contentHash"].filter((name) => names.contains(name));
}

/** The version 11 schema every release through 6.14.0 created. */
function createReleasedSchema(db: IDBDatabase): void {
  const store = db.createObjectStore("embeddings", { keyPath: "id" });
  store.createIndex("by_path", "path", { unique: false });
  store.createIndex("by_namespace", "metadata.namespace", { unique: false });
  store.createIndex("by_mtime", "metadata.mtime", { unique: false });
  store.createIndex("by_contentHash", "metadata.contentHash", { unique: false });
  db.createObjectStore("semantic_state");
}

describe("EmbeddingsStorage schema", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  it("opens a released version 11 database beside its never-closed connection, keeping every record", async () => {
    const name = "SystemSculptEmbeddings::released-v11";
    // An in-app update unloads 6.14.0 without closing this connection.
    const previous = await openDatabase(name, 11, createReleasedSchema);
    const vectors = [record(V3, "A.md", 0), record(V3, "A.md", 1), record(V3, "B.md", 0)];
    const state = { version: 1, namespace: V3, committedAt: 42 };
    await new Promise<void>((resolve, reject) => {
      const tx = previous.transaction(["embeddings", "semantic_state"], "readwrite");
      for (const vector of vectors) tx.objectStore("embeddings").put(vector);
      tx.objectStore("semantic_state").put(state, "semantic-committed-namespace-v1");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const storage = new EmbeddingsStorage(name);
    await storage.initialize();
    await storage.loadEmbeddings();
    try {
      expect(previous.version).toBe(11);
      expect(indexNames(previous)).toEqual(["by_path", "by_namespace", "by_mtime", "by_contentHash"]);
      expect(await storage.getAllVectors()).toEqual(vectors);
      expect(await storage.countVectors()).toBe(3);
      expect(await storage.readState("semantic-committed-namespace-v1")).toEqual(state);
      expect([...storage.listRoots()]).toEqual(
        vectors.filter((record) => record.chunkId === 0).map(({ vector: _vector, ...root }) => root),
      );
      expect(storage.getDistinctPaths()).toEqual(["A.md", "B.md"]);
      expect(await storage.getVectorsByPath("A.md")).toEqual(vectors.slice(0, 2));
      expect(await storage.listStoredNamespaces()).toEqual([V3]);

      const replacement = record(V3, "A.md", 0, 2);
      await storage.publishPath("A.md", V3, [replacement]);
      expect(await storage.getVectorsByPath("A.md")).toEqual([replacement]);
      expect(storage.getVectorSync(replacement.id)?.metadata.createdAt).toBe(2);
      expect(await storage.countVectors()).toBe(2);
    } finally {
      previous.close();
      await storage.reset();
    }
  });

  it("creates fresh version 11 databases with only the path and namespace indexes", async () => {
    const name = "SystemSculptEmbeddings::fresh-schema";
    const storage = new EmbeddingsStorage(name);
    await storage.initialize();
    const db = await openDatabase(name);
    try {
      expect(db.version).toBe(11);
      expect(indexNames(db)).toEqual(["by_path", "by_namespace"]);
    } finally {
      db.close();
      await storage.reset();
    }
  });
});

describe("EmbeddingsStorage connections", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  it("closes a held-open connection on versionchange so a later version upgrades without waiting", async () => {
    const name = "SystemSculptEmbeddings::versionchange";
    const held = new EmbeddingsStorage(name);
    await held.initialize();
    await held.storeVectors([record(V3, "A.md", 0)]);

    const blocked = jest.fn();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 12);
      request.onblocked = blocked;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      expect(blocked).not.toHaveBeenCalled();
      expect(upgraded.version).toBe(12);
      expect(fake.factory.openConnections(name).size).toBe(1);
      expect(fake.factory.rows(name, "embeddings").size).toBe(1);
      await expect(held.countVectors()).rejects.toThrow("Database not initialized");
      await expect(held.initialize()).rejects.toThrow("VersionError");
    } finally {
      upgraded.close();
    }
  });

  it("lets another connection reset the database while this one is open", async () => {
    const name = "SystemSculptEmbeddings::versionchange-delete";
    const held = new EmbeddingsStorage(name);
    await held.initialize();
    await held.storeVectors([record(V3, "A.md", 0)]);

    await new EmbeddingsStorage(name).reset();

    expect(fake.factory.databases.has(name)).toBe(false);
    expect(fake.factory.openConnections(name).size).toBe(0);
  });

  it("settles a blocked open with a restart error and keeps the late connection once the blocker goes", async () => {
    const name = "SystemSculptEmbeddings::blocked";
    // A build without a versionchange handler holds an older version open.
    const blocker = await openDatabase(name, 10, (db) => db.createObjectStore("embeddings", { keyPath: "id" }));
    const storage = new EmbeddingsStorage(name);

    const opening = storage.initialize();
    await expect(opening).rejects.toBeInstanceOf(EmbeddingsStorageBlockedError);
    await expect(opening).rejects.toThrow("Restart Obsidian to finish updating the semantic index.");
    // A second open or a delete would queue behind the blocked open with no
    // blocked event of its own; both settle with the same error instead.
    await expect(storage.initialize()).rejects.toBeInstanceOf(EmbeddingsStorageBlockedError);
    await expect(storage.reset()).rejects.toBeInstanceOf(EmbeddingsStorageBlockedError);
    expect(storage.size()).toBe(0);

    // When the blocker finally closes, the pending upgrade completes and its connection is kept.
    blocker.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.factory.databases.get(name)?.version).toBe(11);
    expect(fake.factory.openConnections(name).size).toBe(1);

    await storage.initialize();
    expect(await storage.countVectors()).toBe(0);
    storage.close();
    expect(fake.factory.openConnections(name).size).toBe(0);
  });

  it("models a second open queued behind a blocked one without its own blocked event", async () => {
    const name = "SystemSculptEmbeddings::queued";
    const blocker = await openDatabase(name, 10);
    const events: string[] = [];
    const open = (label: string) => {
      const request = indexedDB.open(name, 11);
      request.onblocked = () => events.push(`${label} blocked`);
      request.onsuccess = () => { events.push(`${label} opened`); request.result.close(); };
    };
    open("first");
    open("second");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first blocked"]);

    blocker.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first blocked", "first opened", "second opened"]);
  });

  it("closes an open that succeeds after the storage was closed", async () => {
    const name = "SystemSculptEmbeddings::closed-while-opening";
    const storage = new EmbeddingsStorage(name);
    const opening = storage.initialize();
    storage.close();

    await expect(opening).rejects.toThrow("Embeddings storage is closed.");
    expect(fake.factory.openConnections(name).size).toBe(0);
  });
});

describe("EmbeddingsStorage generation retention", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  async function seededStorage(): Promise<EmbeddingsStorage> {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::generations");
    await storage.initialize();
    await storage.storeVectors([
      record(V2, "A.md", 0, 10), record(V2, "A.md", 1, 10),
      record(V3, "A.md", 0, 20), record(V3, "A.md", 1, 20),
      record(V4, "A.md", 0, 30),
      record(LEGACY, "A.md", 0, 5), record(LEGACY, "B.md", 0, 5),
      // A chunk whose root is already gone must not survive either.
      record(V2, "Orphan.md", 3, 10),
      createLocalEmptyEmbeddingMarkerForRevision({ path: "Empty.md", basename: "Empty", mtime: 1 }, ""),
    ]);
    await storage.loadEmbeddings();
    return storage;
  }

  it("keeps only the requested managed generations and local empty markers", async () => {
    const storage = await seededStorage();

    const removed = await storage.retainNamespaces(new Set([V3, V4]));

    expect(removed).toBe(5);
    expect((await storage.listStoredNamespaces()).sort()).toEqual([
      "systemsculpt:local-empty:v1:1",
      V3,
      V4,
    ].sort());
    expect(storage.getVectorSync(buildVectorId(V2, "A.md", 0))).toBeNull();
    expect(storage.getVectorSync(buildVectorId(LEGACY, "B.md", 0))).toBeNull();
    expect(storage.getVectorSync(buildVectorId(V3, "A.md", 0))).not.toBeNull();
    expect(storage.getDistinctPaths().sort()).toEqual(["A.md", "Empty.md"]);
  });

  it("drops only non-managed namespaces when no generation is trusted yet", async () => {
    const storage = await seededStorage();

    await storage.retainNamespaces(null);

    expect((await storage.listStoredNamespaces()).sort()).toEqual([
      "systemsculpt:local-empty:v1:1",
      V2,
      V3,
      V4,
    ].sort());
  });

  it("names the most recently written generation as in progress", async () => {
    const storage = await seededStorage();

    expect(storage.peekLatestManagedNamespace()).toBe(V4);
    expect(storage.listRootNamespaces()).toEqual(
      ["systemsculpt:local-empty:v1:1", LEGACY, V2, V3, V4].sort(),
    );
  });
});
