/**
 * EmbeddingsStorage - Efficient IndexedDB storage layer
 * 
 * Features:
 * - Optimized batch operations
 * - In-memory caching for fast lookups
 * - Concurrent read/write safety
 */

import { EmbeddingVector } from '../types';
import { buildVectorId } from "../utils/vectorId";
import { normalizeInPlace } from '../utils/vector';
import {
  isManagedNamespace,
  MANAGED_EMBEDDING_NAMESPACE_PREFIX,
} from "../utils/namespace";
import {
  deserializeEmbeddingsIndex,
  serializeEmbeddingsIndex,
  type SerializedEmbeddingsIndex,
} from './EmbeddingsIndexSerialization';

const DB_NAME_PREFIX = "SystemSculptEmbeddings";
const DB_VERSION = 11;
const STORE_NAME = 'embeddings';
const STATE_STORE_NAME = "semantic_state";

export class EmbeddingsStorage {
  public static buildDbName(vaultInstanceId: string): string {
    const id = String(vaultInstanceId || "").trim();
    if (!id) {
      throw new Error("EmbeddingsStorage requires a vaultInstanceId to scope IndexedDB per vault.");
    }
    return `${DB_NAME_PREFIX}::${id}`;
  }

  private db: IDBDatabase | null = null;
  private cache: Map<string, EmbeddingVector> = new Map();
  private initialized = false;
  // Root records only: enough for synchronous freshness and path statistics.
  private pathsSet: Set<string> = new Set();

  constructor(private readonly dbName: string) {}

  /**
   * Fast count of vectors stored in the DB (does not require loading into memory).
   */
  public async countVectors(): Promise<number> {
    if (!this.db) throw new Error("Database not initialized");
    return await new Promise<number>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(typeof req.result === "number" ? req.result : 0);
      req.onerror = () => reject(req.error);
    });
  }

  private normalizeDirPrefix(dir: string): string {
    if (!dir) return "";
    return dir.endsWith("/") ? dir : `${dir}/`;
  }

  private parseChunkIdFromId(id: string): number {
    const raw = String(id || "");
    const idx = raw.lastIndexOf("#");
    if (idx < 0) return 0;
    const parsed = parseInt(raw.slice(idx + 1), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private refreshPathsCache(): void {
    this.pathsSet.clear();
    for (const vector of this.cache.values()) {
      if (vector?.path) {
        this.pathsSet.add(vector.path);
      }
    }
  }

  /**
   * Initialize the database
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        resolve();
      };
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const transaction = (event.target as IDBOpenDBRequest).transaction!;

        if (!db.objectStoreNames.contains(STATE_STORE_NAME)) {
          db.createObjectStore(STATE_STORE_NAME);
        }

        let store: IDBObjectStore;
        if (db.objectStoreNames.contains(STORE_NAME)) {
          const existing = transaction.objectStore(STORE_NAME);
          if (existing.keyPath !== "id") {
            // Pre-first-party indexes are intentionally discarded and rebuilt.
            db.deleteObjectStore(STORE_NAME);
            store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          } else {
            store = existing;
          }
        } else {
          store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }

        if (!store.indexNames.contains("by_path")) store.createIndex("by_path", "path", { unique: false });
        if (!store.indexNames.contains("by_namespace")) {
          store.createIndex("by_namespace", "metadata.namespace", { unique: false });
        }
        if (!store.indexNames.contains("by_mtime")) store.createIndex("by_mtime", "metadata.mtime", { unique: false });
        if (!store.indexNames.contains("by_contentHash")) {
          store.createIndex("by_contentHash", "metadata.contentHash", { unique: false });
        }
      };
    });
  }

  /** Load only root records needed for synchronous readiness checks. */
  async loadEmbeddings(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      this.cache.clear();
      this.pathsSet.clear();
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const vector = cursor.value as EmbeddingVector;
        const chunkId = typeof vector.chunkId === "number"
          ? vector.chunkId
          : this.parseChunkIdFromId(vector.id);
        if (chunkId === 0) {
          this.cache.set(vector.id, vector);
          if (vector.path) this.pathsSet.add(vector.path);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Store embeddings in batch using a single IndexedDB transaction
   */
  async storeVectors(vectors: EmbeddingVector[]): Promise<void> {
    if (!this.db || vectors.length === 0) return;

    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      const store = transaction.objectStore(STORE_NAME);

      for (const vector of vectors) {
        store.put(vector);
      }

      transaction.oncomplete = () => {
        for (const vector of vectors) {
          const chunkId = typeof vector.chunkId === "number"
            ? vector.chunkId
            : this.parseChunkIdFromId(vector.id);
          if (chunkId === 0) {
            this.cache.set(vector.id, vector);
            if (vector.path) this.pathsSet.add(vector.path);
          }
        }
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error || new Error('IndexedDB transaction aborted while storing vectors.'));
    });
  }

  /**
   * Get all vectors for a specific file path using the by_path index
   */
  async getVectorsByPath(path: string): Promise<EmbeddingVector[]> {
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('by_path');
        const req = index.getAll(IDBKeyRange.only(path));
        req.onsuccess = () => {
          const items = (req.result || []) as EmbeddingVector[];
          for (const v of items) {
            if ((v.chunkId ?? this.parseChunkIdFromId(v.id)) === 0) this.cache.set(v.id, v);
          }
          resolve(items);
        };
        req.onerror = () => reject(req.error);
      } catch (e) {
        resolve([]);
      }
    });
  }

  /**
   * Move a vector to a new id (e.g., when a chunk's index changes but content is identical).
   * If a vector already exists at the destination id, it will be replaced.
   */
  async moveVectorId(oldId: string, newId: string, newChunkId?: number): Promise<void> {
    if (!this.db) return;
    if (oldId === newId) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let updated: EmbeddingVector | null = null;
      const getOld = store.get(oldId);
      getOld.onsuccess = () => {
        const existing = getOld.result as EmbeddingVector | undefined;
        if (!existing) return;
        updated = {
          ...existing,
          id: newId,
          chunkId: typeof newChunkId === 'number' ? newChunkId : existing.chunkId,
        };
        store.put(updated);
        store.delete(oldId);
      };
      getOld.onerror = () => reject(getOld.error);
      tx.oncomplete = () => {
        if (updated) {
          this.cache.delete(oldId);
          const chunkId = updated.chunkId ?? this.parseChunkIdFromId(updated.id);
          if (chunkId === 0) this.cache.set(newId, updated);
        }
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB vector move aborted."));
    });
  }

  /**
   * Get vector synchronously from cache
   */
  getVectorSync(id: string): EmbeddingVector | null {
    return this.cache.get(id) || null;
  }

  /** Infer the most complete validated managed namespace from cached root records. */
  public peekCurrentManagedNamespace(): string | null {
    if (this.cache.size === 0) return null;

    type Candidate = {
      namespace: string;
      completeRoots: number;
      incompleteRoots: number;
      latestCompleteMtime: number;
      latestMtime: number;
      roots: number;
    };
    const stats = new Map<string, Candidate>();

    for (const v of this.cache.values()) {
      const ns = typeof v?.metadata?.namespace === "string" ? v.metadata.namespace : "";
      if (!isManagedNamespace(ns)) continue;

      const chunkId = typeof v.chunkId === "number" ? v.chunkId : this.parseChunkIdFromId(v.id);
      if (chunkId !== 0) continue;

      const mtime = typeof v.metadata?.mtime === "number" ? v.metadata.mtime : 0;
      const complete = v.metadata?.complete === true && v.metadata?.partial !== true;
      let entry = stats.get(ns);
      if (!entry) {
        entry = {
          namespace: ns,
          completeRoots: 0,
          incompleteRoots: 0,
          latestCompleteMtime: 0,
          latestMtime: 0,
          roots: 0,
        };
        stats.set(ns, entry);
      }
      entry.roots += 1;
      if (complete) {
        entry.completeRoots += 1;
        if (mtime > entry.latestCompleteMtime) entry.latestCompleteMtime = mtime;
      } else {
        entry.incompleteRoots += 1;
      }
      if (mtime > entry.latestMtime) entry.latestMtime = mtime;
    }

    if (stats.size === 0) return null;

    let best: Candidate | null = null;
    for (const entry of stats.values()) {
      if (entry.completeRoots === 0) continue;
      if (!best) {
        best = entry;
        continue;
      }
      if (entry.completeRoots > best.completeRoots) {
        best = entry;
        continue;
      }
      if (entry.completeRoots === best.completeRoots && entry.incompleteRoots < best.incompleteRoots) {
        best = entry;
        continue;
      }
      if (
        entry.completeRoots === best.completeRoots
        && entry.incompleteRoots === best.incompleteRoots
        && entry.latestCompleteMtime > best.latestCompleteMtime
      ) {
        best = entry;
        continue;
      }
      if (
        entry.completeRoots === best.completeRoots
        && entry.incompleteRoots === best.incompleteRoots
        && entry.latestCompleteMtime === best.latestCompleteMtime
        && entry.roots > best.roots
      ) {
        best = entry;
        continue;
      }
      if (
        entry.completeRoots === best.completeRoots
        && entry.incompleteRoots === best.incompleteRoots
        && entry.latestCompleteMtime === best.latestCompleteMtime
        && entry.roots === best.roots
        && entry.namespace.localeCompare(best.namespace) < 0
      ) {
        best = entry;
      }
    }

    return best?.namespace ?? null;
  }

  /** All managed namespaces represented by complete or partial cached roots. */
  public listManagedRootNamespaces(): string[] {
    const namespaces = new Set<string>();
    for (const vector of this.cache.values()) {
      const namespace = typeof vector?.metadata?.namespace === "string"
        ? vector.metadata.namespace
        : "";
      if (!isManagedNamespace(namespace)) continue;
      const chunkId = typeof vector.chunkId === "number"
        ? vector.chunkId
        : this.parseChunkIdFromId(vector.id);
      if (chunkId === 0) namespaces.add(namespace);
    }
    return [...namespaces].sort();
  }

  /** Read all records transiently. Search/snapshot callers must not hydrate a permanent cache. */
  async getAllVectors(): Promise<EmbeddingVector[]> {
    if (!this.db) return [...this.cache.values()];
    return await new Promise<EmbeddingVector[]>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readonly");
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result || []) as EmbeddingVector[]);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Serialize every stored vector into a portable, versioned envelope that can
   * live in the synced vault (so Obsidian Sync/backup restores it on a new
   * device). Records are device-independent — no remapping needed on import.
   */
  async exportAll(): Promise<SerializedEmbeddingsIndex> {
    const vectors = await this.getAllVectors();
    return serializeEmbeddingsIndex(vectors, { createdAt: Date.now() });
  }

  /**
   * Import a portable envelope into the store. Malformed records and unknown
   * formats are dropped by the deserializer, so this never throws on a partially
   * synced or corrupt snapshot.
   */
  async importAll(index: SerializedEmbeddingsIndex): Promise<{ imported: number }> {
    const vectors = deserializeEmbeddingsIndex(index);
    if (vectors.length === 0) return { imported: 0 };
    await this.storeVectors(vectors);
    return { imported: vectors.length };
  }

  async getVectorsByNamespace(namespace: string): Promise<EmbeddingVector[]> {
    if (!namespace) return [];

    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction([STORE_NAME], "readonly");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("by_namespace");
        const req = index.getAll(IDBKeyRange.only(namespace));

        req.onsuccess = () => {
          const results = (req.result || []) as EmbeddingVector[];
          resolve(results);
        };
        req.onerror = () => reject(req.error);
      } catch {
        resolve([]);
      }
    });
  }

  /** Stream namespace records in bounded batches without retaining them in the root cache. */
  async scanVectorsByNamespace(
    namespace: string,
    onBatch: (vectors: EmbeddingVector[]) => void,
    options: { batchSize?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!this.db || !namespace || options.signal?.aborted) return;
    const batchSize = Math.max(25, Math.min(1_000, Math.floor(options.batchSize ?? 250)));
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readonly");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("by_namespace");
      const request = index.openCursor(IDBKeyRange.only(namespace));
      let batch: EmbeddingVector[] = [];
      let stopped = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || options.signal?.aborted) {
          if (batch.length > 0 && !options.signal?.aborted) onBatch(batch);
          batch = [];
          stopped = true;
          return;
        }
        batch.push(cursor.value as EmbeddingVector);
        if (batch.length >= batchSize) {
          onBatch(batch);
          batch = [];
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        if (!stopped && batch.length > 0 && !options.signal?.aborted) onBatch(batch);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clear all embeddings
   */
  async clear(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        this.cache.clear();
        this.pathsSet.clear();
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Reset the database
   */
  async reset(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    this.cache.clear();
    this.pathsSet.clear();

    return new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase(this.dbName);
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => reject(new Error("IndexedDB reset was blocked by another open connection."));
    });
  }

  /**
   * Get storage size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get a snapshot of all distinct file paths represented in the store
   */
  getDistinctPaths(): string[] {
    return Array.from(this.pathsSet);
  }

  async readState<T>(key: string): Promise<T | null> {
    if (!this.db || !key) return null;
    return await new Promise<T | null>((resolve, reject) => {
      const tx = this.db!.transaction([STATE_STORE_NAME], "readonly");
      const request = tx.objectStore(STATE_STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async writeState<T>(key: string, value: T): Promise<void> {
    if (!this.db || !key) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STATE_STORE_NAME], "readwrite");
      tx.objectStore(STATE_STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteState(key: string): Promise<void> {
    if (!this.db || !key) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STATE_STORE_NAME], "readwrite");
      tx.objectStore(STATE_STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Remove specific vector ids from storage.
   */
  async removeIds(ids: Iterable<string>): Promise<void> {
    if (!this.db) return;
    const toRemove = Array.from(ids).filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (toRemove.length === 0) return;

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      for (const id of toRemove) {
        store.delete(id);
      }

      tx.oncomplete = () => {
        for (const id of toRemove) this.cache.delete(id);
        this.refreshPathsCache();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB vector removal aborted."));
    });
  }

  /**
   * Remove all vectors associated with a given file path
   */
  async removeByPath(path: string): Promise<void> {
    if (!this.db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.index('by_path').getAllKeys(IDBKeyRange.only(path));
      req.onsuccess = () => {
        for (const key of (req.result || []) as string[]) store.delete(key);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => {
        for (const [id, vector] of this.cache) {
          if (vector.path === path) this.cache.delete(id);
        }
        this.pathsSet.delete(path);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB path deletion aborted."));
    });
  }

  /**
   * Remove all vectors for a path+namespace except those with ids in keepIds.
   * This prevents duplicate chunks when indices shift while preserving other namespaces.
   */
  async removeByPathExceptIds(path: string, namespace: string, keepIds: Set<string>): Promise<void> {
    if (!this.db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const prefix = `${namespace}::${path}#`;
      let deletedIds: string[] = [];
      const request = store.index('by_path').getAllKeys(IDBKeyRange.only(path));
      request.onsuccess = () => {
        deletedIds = ((request.result || []) as string[])
          .filter((id) => id.startsWith(prefix) && !keepIds.has(id));
        for (const id of deletedIds) store.delete(id);
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        for (const id of deletedIds) this.cache.delete(id);
        this.refreshPathsCache();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB stale-chunk removal aborted."));
    });
  }

  /** Atomically publish a complete root and remove stale chunks for one note generation. */
  async finalizePath(
    path: string,
    namespace: string,
    root: EmbeddingVector,
    keepIds: Set<string>,
  ): Promise<void> {
    if (!this.db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const prefix = `${namespace}::${path}#`;
      const request = store.index("by_path").getAllKeys(IDBKeyRange.only(path));
      request.onsuccess = () => {
        for (const id of (request.result || []) as string[]) {
          if (id.startsWith(prefix) && !keepIds.has(id)) store.delete(id);
        }
        store.put(root);
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        for (const [id, vector] of this.cache) {
          if (vector.path === path && id.startsWith(prefix) && !keepIds.has(id)) this.cache.delete(id);
        }
        this.cache.set(root.id, root);
        this.pathsSet.add(path);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB note finalization aborted."));
    });
  }

  async renameByPath(oldPath: string, newPath: string, newTitle?: string): Promise<void> {
    if (!this.db) return;
    if (!oldPath || !newPath || oldPath === newPath) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const updates: EmbeddingVector[] = [];
      const req = store.index('by_path').getAll(IDBKeyRange.only(oldPath));
      req.onsuccess = () => {
        for (const vector of (req.result || []) as EmbeddingVector[]) {
          const chunkId = typeof vector.chunkId === 'number' ? vector.chunkId : this.parseChunkIdFromId(vector.id);
          const namespace = typeof vector.metadata?.namespace === "string" ? vector.metadata.namespace : "";
          if (!namespace) {
            store.delete(vector.id);
            continue;
          }
          const updated: EmbeddingVector = {
            ...vector,
            id: buildVectorId(namespace, newPath, chunkId),
            path: newPath,
            chunkId,
            metadata: newTitle ? { ...vector.metadata, title: newTitle } : vector.metadata,
          };
          updates.push(updated);
          store.delete(vector.id);
          store.put(updated);
        }
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => {
        for (const [id, vector] of this.cache) if (vector.path === oldPath) this.cache.delete(id);
        for (const vector of updates) {
          if ((vector.chunkId ?? this.parseChunkIdFromId(vector.id)) === 0) this.cache.set(vector.id, vector);
        }
        this.pathsSet.delete(oldPath);
        if (updates.length > 0) this.pathsSet.add(newPath);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB path rename aborted."));
    });
  }

  /**
   * Rename all vectors under a directory prefix without re-embedding.
   * Uses an indexed cursor to avoid loading the entire store into memory.
   */
  async renameByDirectory(oldDir: string, newDir: string): Promise<void> {
    if (!this.db) return;
    const oldPrefix = this.normalizeDirPrefix(oldDir);
    const newPrefix = this.normalizeDirPrefix(newDir);
    if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) return;

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const range = IDBKeyRange.bound(oldPrefix, `${oldPrefix}\uffff`);
      const deletedRootIds: string[] = [];
      const updatedRoots: EmbeddingVector[] = [];

      tx.oncomplete = () => {
        for (const id of deletedRootIds) this.cache.delete(id);
        for (const vector of updatedRoots) this.cache.set(vector.id, vector);
        this.refreshPathsCache();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB directory rename aborted."));

      const cursorRequest = store.index("by_path").openCursor(range);
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as EmbeddingVector;
        const currentId = String(cursor.primaryKey);
        const namespace = typeof value.metadata?.namespace === "string" ? value.metadata.namespace : "";
        const chunkId = typeof value.chunkId === "number"
          ? value.chunkId
          : this.parseChunkIdFromId(value.id);
        // Delete through the owning store. Some Chromium/Obsidian IndexedDB
        // implementations throw from IDBCursor.delete() while an index cursor
        // is advancing, which escapes the event callback as an unhandled
        // exception and aborts the whole vault operation.
        store.delete(cursor.primaryKey);
        if (namespace) {
          const relativePath = (value.path || "").slice(oldPrefix.length);
          const newPath = `${newPrefix}${relativePath}`;
          const updated: EmbeddingVector = {
            ...value,
            id: buildVectorId(namespace, newPath, chunkId),
            path: newPath,
            chunkId,
          };
          store.put(updated);
          if (chunkId === 0) updatedRoots.push(updated);
        }
        if (chunkId === 0) deletedRootIds.push(currentId);
        cursor.continue();
      };
    });
  }

  /**
   * Remove all vectors under a directory prefix (e.g., when folder is deleted).
   * Streams keys via the path index to avoid full-store scans.
   */
  async removeByDirectory(dir: string): Promise<void> {
    if (!this.db) return;
    const prefix = this.normalizeDirPrefix(dir);
    if (!prefix) return;

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const deletedIds: string[] = [];

      tx.oncomplete = () => {
        for (const id of deletedIds) this.cache.delete(id);
        this.refreshPathsCache();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB directory removal aborted."));

      const cursorRequest = store.index("by_path").openKeyCursor(range);
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        deletedIds.push(String(cursor.primaryKey));
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  /** Remove every vector in the current managed generation family. */
  async removeCurrentManagedGeneration(): Promise<void> {
    if (!this.db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("by_namespace");
      const range = IDBKeyRange.bound(
        MANAGED_EMBEDDING_NAMESPACE_PREFIX,
        `${MANAGED_EMBEDDING_NAMESPACE_PREFIX}\uffff`,
      );
      const deletedIds: string[] = [];

      tx.oncomplete = () => {
        for (const id of deletedIds) this.cache.delete(id);
        this.refreshPathsCache();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);

      const cursorRequest = index.openKeyCursor(range);
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        deletedIds.push(String(cursor.primaryKey));
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  async removeNamespacesExcept(prefix: string, keepNamespace: string): Promise<number> {
    if (!this.db || !prefix || !keepNamespace) return 0;
    let removed = 0;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const request = store.index("by_namespace").openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const vector = cursor.value as EmbeddingVector;
        if (vector.metadata.namespace !== keepNamespace) {
          store.delete(cursor.primaryKey);
          removed += 1;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        for (const [id, vector] of this.cache) {
          if (vector.metadata.namespace.startsWith(prefix) && vector.metadata.namespace !== keepNamespace) {
            this.cache.delete(id);
          }
        }
        this.refreshPathsCache();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
    return removed;
  }

  /**
   * Validate cached roots without loading the full index into memory. A broken
   * root invalidates the note and schedules a complete regeneration.
   */
  async purgeCorruptedVectors(): Promise<{
    removedCount: number;
    correctedCount: number;
    removedPaths: string[];
    correctedPaths: string[];
  }> {
    if (this.cache.size === 0) {
      return { removedCount: 0, correctedCount: 0, removedPaths: [], correctedPaths: [] };
    }

    const removedIds: string[] = [];
    const correctedVectors: EmbeddingVector[] = [];
    const removedPaths = new Set<string>();
    const correctedPaths = new Set<string>();

    for (const [id, vector] of this.cache.entries()) {
      if (!vector || typeof vector !== 'object') {
        removedIds.push(id);
        continue;
      }

      const path = typeof vector.path === 'string' ? vector.path : '';
      if (!path) {
        removedIds.push(id);
        continue;
      }

      if (!(vector.vector instanceof Float32Array)) {
        removedIds.push(id);
        removedPaths.add(path);
        continue;
      }

      let invalidNumber = false;
      for (const value of vector.vector) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          invalidNumber = true;
          break;
        }
      }
      if (invalidNumber) {
        removedIds.push(id);
        removedPaths.add(path);
        continue;
      }

      const metadata = vector.metadata;
      if (!metadata || typeof metadata !== 'object') {
        removedIds.push(id);
        removedPaths.add(path);
        continue;
      }

      if (typeof metadata.contentHash !== 'string' || metadata.contentHash.length === 0) {
        removedIds.push(id);
        removedPaths.add(path);
        continue;
      }

      if (typeof metadata.namespace !== 'string' || metadata.namespace.length === 0) {
        removedIds.push(id);
        removedPaths.add(path);
        continue;
      }

      const dimension = vector.vector.length;
      if (dimension === 0 && metadata.isEmpty !== true) {
        removedIds.push(id);
        removedPaths.add(path);
        continue;
      }

      const EPSILON = 0.015;
      let correctedVector: Float32Array | null = null;
      const dimensionChanged = typeof metadata.dimension !== 'number'
        || metadata.dimension <= 0
        || metadata.dimension !== dimension;

      if (metadata.isEmpty !== true) {
        let sumSq = 0;
        for (let index = 0; index < vector.vector.length; index += 1) {
          const value = vector.vector[index];
          sumSq += value * value;
        }
        const norm = Math.sqrt(sumSq);
        if (!Number.isFinite(norm) || Math.abs(norm - 1) > EPSILON) {
          correctedVector = new Float32Array(vector.vector);
          if (!normalizeInPlace(correctedVector)) {
            removedIds.push(id);
            removedPaths.add(path);
            continue;
          }
        }
      }

      if (dimensionChanged || correctedVector) {
        correctedVectors.push({
          ...vector,
          vector: correctedVector ?? vector.vector,
          metadata: { ...metadata, dimension },
        });
        correctedPaths.add(path);
      }
    }

    if (removedIds.length > 0) {
      await this.removeIds(removedIds);
    }

    if (correctedVectors.length > 0) {
      await this.storeVectors(correctedVectors);
    }

    return {
      removedCount: removedIds.length,
      correctedCount: correctedVectors.length,
      removedPaths: Array.from(removedPaths),
      correctedPaths: Array.from(correctedPaths),
    };
  }
}
