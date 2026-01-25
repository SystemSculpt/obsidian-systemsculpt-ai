/**
 * EmbeddingsStorage - Efficient IndexedDB storage layer
 * 
 * Features:
 * - Optimized batch operations
 * - In-memory caching for fast lookups
 * - Automatic migration support
 * - Concurrent read/write safety
 */

import { EmbeddingVector } from '../types';
import { buildNamespaceWithSchema, normalizeModelForNamespace, parseNamespace } from '../utils/namespace';
import { buildVectorId } from "../utils/vectorId";
import { normalizeInPlace, toFloat32Array, VectorLike } from '../utils/vector';

const LEGACY_DB_NAME = "SystemSculptEmbeddings";
const DB_VERSION = 10;
const STORE_NAME = 'embeddings';

export class EmbeddingsStorage {
  public static buildDbName(vaultInstanceId: string): string {
    const id = String(vaultInstanceId || "").trim();
    if (!id) {
      throw new Error("EmbeddingsStorage requires a vaultInstanceId to scope IndexedDB per vault.");
    }
    return `${LEGACY_DB_NAME}::${id}`;
  }

  private db: IDBDatabase | null = null;
  private cache: Map<string, EmbeddingVector> = new Map();
  private initialized = false;
  // Cached array view of vectors to avoid re-allocating on every search
  private vectorsArrayCache: EmbeddingVector[] | null = null;
  // Track distinct file paths for accurate stats
  private pathsSet: Set<string> = new Set();

  constructor(private readonly dbName: string) {}

  public getDbName(): string {
    return this.dbName;
  }

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

  /**
   * Backfill `metadata.complete` and `metadata.chunkCount` on root vectors (`#0`) when
   * the store already contains a contiguous set of chunk vectors for a file.
   *
   * This prevents upgrades from triggering mass re-embedding purely due to missing
   * "complete" metadata in older DB versions.
   */
  public async backfillRootCompleteness(): Promise<{ updated: number; skipped: number }> {
    if (!this.db) throw new Error("Database not initialized");

    type PathInfo = {
      namespace: string;
      path: string;
      count: number;
      maxChunkId: number;
      hasRoot: boolean;
      rootIsEmpty: boolean;
      rootComplete: boolean;
      rootChunkCount: number | null;
    };

    const perKey = new Map<string, PathInfo>();

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readonly");
      const store = tx.objectStore(STORE_NAME);
      tx.onerror = () => reject(tx.error);
      const cursorReq = store.openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result as IDBCursorWithValue | null;
        if (!cursor) {
          resolve();
          return;
        }

        const value: any = cursor.value;
        const path = typeof value?.path === "string" ? value.path : "";
        const namespace = typeof value?.metadata?.namespace === "string" ? value.metadata.namespace : "";
        if (path && namespace) {
          const chunkIdFromValue =
            typeof value?.chunkId === "number" ? value.chunkId : this.parseChunkIdFromId(typeof value?.id === "string" ? value.id : "");
          const chunkId = Number.isFinite(chunkIdFromValue) && chunkIdFromValue >= 0 ? chunkIdFromValue : 0;

          const key = `${namespace}::${path}`;
          let info = perKey.get(key);
          if (!info) {
            info = {
              namespace,
              path,
              count: 0,
              maxChunkId: 0,
              hasRoot: false,
              rootIsEmpty: false,
              rootComplete: false,
              rootChunkCount: null,
            };
            perKey.set(key, info);
          }

          info.count += 1;
          if (chunkId > info.maxChunkId) info.maxChunkId = chunkId;
          if (chunkId === 0) {
            info.hasRoot = true;
            const metadata = value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
            info.rootIsEmpty = metadata.isEmpty === true;
            info.rootComplete = metadata.complete === true;
            info.rootChunkCount = typeof metadata.chunkCount === "number" ? metadata.chunkCount : null;
          }
        }

        cursor.continue();
      };
    });

    const targets: Array<{ rootId: string; chunkCount: number }> = [];
    for (const [, info] of perKey.entries()) {
      if (!info.hasRoot) continue;
      const rootId = buildVectorId(info.namespace, info.path, 0);

      if (info.rootIsEmpty) {
        const desired = 0;
        if (info.rootComplete !== true || info.rootChunkCount !== desired) {
          targets.push({ rootId, chunkCount: desired });
        }
        continue;
      }

      const expectedCount = info.maxChunkId + 1;
      const contiguous = info.count === expectedCount;
      if (!contiguous) continue;

      if (info.rootComplete === true && info.rootChunkCount === expectedCount) continue;
      targets.push({ rootId, chunkCount: expectedCount });
    }

    if (targets.length === 0) {
      return { updated: 0, skipped: 0 };
    }

    let updated = 0;
    let skipped = 0;

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      for (const target of targets) {
        const getReq = store.get(target.rootId);
        getReq.onerror = () => reject(getReq.error);
        getReq.onsuccess = () => {
          const root: any = getReq.result;
          if (!root) {
            skipped += 1;
            return;
          }

          const metadata = root?.metadata && typeof root.metadata === "object" ? root.metadata : {};
          const next = {
            ...root,
            metadata: {
              ...metadata,
              complete: true,
              chunkCount: target.chunkCount,
            },
          };

          const putReq = store.put(next);
          putReq.onerror = () => reject(putReq.error);
          putReq.onsuccess = () => {
            updated += 1;
          };
        };
      }
    });

    // Clear any in-memory state; caller should reload.
    this.cache.clear();
    this.pathsSet.clear();
    this.vectorsArrayCache = null;

    return { updated, skipped };
  }

  private refreshPathsCache(): void {
    this.pathsSet.clear();
    for (const vector of this.cache.values()) {
      if (vector?.path) {
        this.pathsSet.add(vector.path);
      }
    }
  }

  private async putManyWithoutCache(items: any[]): Promise<void> {
    if (!this.db || items.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const item of items) {
        store.put(item);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Initialize the database
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        resolve();
      };
      
	      request.onupgradeneeded = (event) => {
	        const db = (event.target as IDBOpenDBRequest).result;
	        const oldVersion = (event as IDBVersionChangeEvent).oldVersion;


        // Create or upgrade object store
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('by_path', 'path', { unique: false });
          store.createIndex('by_namespace', 'metadata.namespace', { unique: false });
          store.createIndex('by_mtime', 'metadata.mtime', { unique: false });
          store.createIndex('by_contentHash', 'metadata.contentHash', { unique: false });
        } else {
          const transaction = (event.target as IDBOpenDBRequest).transaction!;
          const oldStore = transaction.objectStore(STORE_NAME);
          // If old store used 'path' as keyPath, migrate to 'id'
          // @ts-ignore
	          const wasPathKey = oldStore.keyPath === 'path';
	          if (wasPathKey) {
	            const tempName = `${STORE_NAME}_temp_v8`;
	            const tempStore = db.createObjectStore(tempName, { keyPath: 'id' });
	            tempStore.createIndex('by_path', 'path', { unique: false });
	            tempStore.createIndex('by_namespace', 'metadata.namespace', { unique: false });
	            tempStore.createIndex('by_mtime', 'metadata.mtime', { unique: false });
	            tempStore.createIndex('by_contentHash', 'metadata.contentHash', { unique: false });

	            const copyOldToTemp = () => {
	              const cursorReq = oldStore.openCursor();
	              cursorReq.onsuccess = () => {
	                const cursor = cursorReq.result as IDBCursorWithValue | null;
	                if (!cursor) {
	                  // Replace the legacy store with the new schema.
	                  db.deleteObjectStore(STORE_NAME);
	                  const newStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
	                  newStore.createIndex('by_path', 'path', { unique: false });
	                  newStore.createIndex('by_namespace', 'metadata.namespace', { unique: false });
	                  newStore.createIndex('by_mtime', 'metadata.mtime', { unique: false });
	                  newStore.createIndex('by_contentHash', 'metadata.contentHash', { unique: false });

	                  // Copy from temp store into new store.
	                  const tempCursorReq = tempStore.openCursor();
	                  tempCursorReq.onsuccess = () => {
	                    const tempCursor = tempCursorReq.result as IDBCursorWithValue | null;
	                    if (!tempCursor) {
	                      db.deleteObjectStore(tempName);
	                      return;
	                    }
	                    const putReq = newStore.put(tempCursor.value);
	                    putReq.onsuccess = () => tempCursor.continue();
	                  };
	                  tempCursorReq.onerror = () => {
	                    db.deleteObjectStore(tempName);
	                  };

	                  return;
	                }

		                const item: any = cursor.value;
		                const rawVector = item.vector as any;
		                let migratedVector: Float32Array;
		                try {
		                  migratedVector = toFloat32Array(rawVector as VectorLike);
		                } catch {
		                  migratedVector = new Float32Array(0);
		                }
		                let isEmpty = item.metadata?.isEmpty === true;
		                if (!isEmpty) {
		                  const ok = normalizeInPlace(migratedVector);
		                  if (!ok) {
		                    isEmpty = true;
		                    migratedVector = new Float32Array(migratedVector.length);
		                  }
		                }
		                const dimension = migratedVector.length;
                    const rawMeta: any = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
                    const parsedNamespace = parseNamespace(typeof rawMeta?.namespace === "string" ? rawMeta.namespace : "");
                    const provider =
                      typeof rawMeta?.provider === "string" && rawMeta.provider.trim().length > 0
                        ? rawMeta.provider
                        : (parsedNamespace?.provider ?? "unknown");
                    const rawModel =
                      typeof rawMeta?.model === "string" && rawMeta.model.trim().length > 0
                        ? rawMeta.model
                        : (parsedNamespace?.model ?? "unknown");
                    const model = normalizeModelForNamespace(provider, rawModel);
                    const schema = parsedNamespace?.schema ?? 0;
                    const namespace = buildNamespaceWithSchema(provider, model, schema, dimension);
		                const id = buildVectorId(namespace, item.path, 0);
                    const title = typeof rawMeta?.title === "string" ? rawMeta.title : "";
                    const excerpt = typeof rawMeta?.excerpt === "string" ? rawMeta.excerpt : undefined;
                    const mtime = typeof rawMeta?.mtime === "number" && Number.isFinite(rawMeta.mtime) ? rawMeta.mtime : Date.now();
                    const legacyHash = typeof rawMeta?.hash === "string" ? rawMeta.hash.trim() : "";
                    const contentHash =
                      typeof rawMeta?.contentHash === "string" && rawMeta.contentHash.trim().length > 0
                        ? rawMeta.contentHash.trim()
                        : (legacyHash.length > 0 ? legacyHash : "legacy");
                    const createdAt =
                      typeof rawMeta?.createdAt === "number" && Number.isFinite(rawMeta.createdAt) ? rawMeta.createdAt : Date.now();
                    const sectionTitle = typeof rawMeta?.sectionTitle === "string" ? rawMeta.sectionTitle : undefined;
                    const headingPath = Array.isArray(rawMeta?.headingPath) ? rawMeta.headingPath : undefined;
                    const chunkLength = typeof rawMeta?.chunkLength === "number" ? rawMeta.chunkLength : undefined;
                    const chunkCount =
                      typeof rawMeta?.chunkCount === "number" && Number.isFinite(rawMeta.chunkCount) && rawMeta.chunkCount >= 0
                        ? rawMeta.chunkCount
                        : (isEmpty ? 0 : 1);
		                const migrated: any = {
		                  id,
		                  path: item.path,
		                  chunkId: 0,
		                  vector: migratedVector,
		                  metadata: {
		                    title,
		                    excerpt,
		                    mtime,
		                    contentHash,
		                    isEmpty,
		                    provider,
		                    model,
		                    dimension,
		                    createdAt,
		                    namespace,
                        ...(sectionTitle ? { sectionTitle } : {}),
                        ...(headingPath ? { headingPath } : {}),
                        ...(typeof chunkLength === "number" ? { chunkLength } : {}),
                        complete: true,
                        chunkCount
		                  }
		                };
	                const putReq = tempStore.put(migrated);
	                putReq.onsuccess = () => cursor.continue();
	              };
	            };

	            copyOldToTemp();
	          } else {
	            if (!oldStore.indexNames.contains('by_path')) oldStore.createIndex('by_path', 'path', { unique: false });
	            if (!oldStore.indexNames.contains('by_namespace')) oldStore.createIndex('by_namespace', 'metadata.namespace', { unique: false });
	            if (!oldStore.indexNames.contains('by_mtime')) oldStore.createIndex('by_mtime', 'metadata.mtime', { unique: false });
	            if (!oldStore.indexNames.contains('by_contentHash')) oldStore.createIndex('by_contentHash', 'metadata.contentHash', { unique: false });

              // v10: canonicalize namespaces and namespace-qualified vector ids so multiple models/dimensions can coexist.
              // - id format: `${namespace}::${path}#${chunkId}`
              // - metadata.provider/model/dimension/namespace are backfilled + normalized
              if (oldVersion < 10) {
                const cursorReq = oldStore.openCursor();
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result as IDBCursorWithValue | null;
                  if (!cursor) return;

                  const value: any = cursor.value;
                  const rawPath = typeof value?.path === "string" ? value.path : "";
                  const path = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
                  const existingId = typeof value?.id === "string" ? value.id : "";
                  if (!path || !existingId) {
                    cursor.continue();
                    return;
                  }

                  const chunkIdFromValue =
                    typeof value?.chunkId === "number"
                      ? value.chunkId
                      : this.parseChunkIdFromId(existingId);
                  const chunkId = Number.isFinite(chunkIdFromValue) && chunkIdFromValue >= 0 ? chunkIdFromValue : 0;

                  const metadata: any = value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
                  const existingNamespace = typeof metadata?.namespace === "string" ? metadata.namespace : "";
                  const parsedNamespace = parseNamespace(existingNamespace);

                  const rawVector: any = value?.vector;
                  const vecLen = rawVector && typeof rawVector.length === "number" ? rawVector.length : 0;
                  const dimFromMeta =
                    typeof metadata?.dimension === "number" && Number.isFinite(metadata.dimension) && metadata.dimension > 0
                      ? metadata.dimension
                      : 0;
                  const dimFromParsed = typeof parsedNamespace?.dimension === "number" && parsedNamespace.dimension > 0 ? parsedNamespace.dimension : 0;
                  const dimension = (vecLen > 0 ? vecLen : 0) || dimFromMeta || dimFromParsed;

                  const provider =
                    typeof metadata?.provider === "string" && metadata.provider.trim().length > 0
                      ? metadata.provider
                      : (parsedNamespace?.provider ?? "unknown");
                  const rawModel =
                    typeof metadata?.model === "string" && metadata.model.trim().length > 0
                      ? metadata.model
                      : (parsedNamespace?.model ?? "unknown");
                  const model = normalizeModelForNamespace(provider, rawModel);

                  const schema = parsedNamespace?.schema ?? 0;
                  const namespace = buildNamespaceWithSchema(provider, model, schema, dimension);
                  const nextId = buildVectorId(namespace, path, chunkId);

                  const updatedValue: any = {
                    ...value,
                    id: nextId,
                    path,
                    chunkId,
                    metadata: {
                      ...metadata,
                      provider,
                      model,
                      dimension,
                      namespace,
                    },
                  };

                  const metadataAlreadyCanonical =
                    metadata?.provider === provider
                    && metadata?.model === model
                    && metadata?.dimension === dimension
                    && metadata?.namespace === namespace;
                  const chunkIdAlreadyCanonical = typeof value?.chunkId === "number" && value.chunkId === chunkId;
                  const pathAlreadyCanonical = rawPath === path;
                  if (existingId === nextId && metadataAlreadyCanonical && chunkIdAlreadyCanonical && pathAlreadyCanonical) {
                    cursor.continue();
                    return;
                  }

                  if (existingId === nextId) {
                    const updateReq = cursor.update(updatedValue);
                    updateReq.onerror = () => cursor.continue();
                    updateReq.onsuccess = () => cursor.continue();
                    return;
                  }

                  const putReq = oldStore.put(updatedValue);
                  putReq.onerror = () => cursor.continue();
                  putReq.onsuccess = () => {
                    const delReq = cursor.delete();
                    delReq.onerror = () => cursor.continue();
                    delReq.onsuccess = () => cursor.continue();
                  };
                };
              }
          }
        }
      };
    });
  }

  private async openLegacyGlobalDbIfExists(): Promise<IDBDatabase | null> {
    // Avoid creating the legacy DB when it doesn't exist.
    return await new Promise((resolve) => {
      let createdFresh = false;
      const request = indexedDB.open(LEGACY_DB_NAME);

      request.onupgradeneeded = (event) => {
        // If oldVersion is 0, this would create a brand new DB. Treat as non-existent.
        const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
        if (oldVersion === 0) {
          createdFresh = true;
        }
      };

      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (createdFresh) {
          try { db.close(); } catch {}
          try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch {}
          resolve(null);
          return;
        }
        resolve(db);
      };
    });
  }

  /**
   * One-time import helper: copy embeddings from the legacy global DB into this vault-scoped DB.
   * Only imports vectors whose `path` exists in `eligiblePaths`.
   *
   * NOTE: This does not mutate the legacy DB.
   */
  async importFromLegacyGlobalDb(eligiblePaths: Set<string>): Promise<{ imported: number; skipped: number }> {
    if (!this.db) throw new Error("Database not initialized");
    if (this.dbName === LEGACY_DB_NAME) return { imported: 0, skipped: 0 };
    if (!eligiblePaths || eligiblePaths.size === 0) return { imported: 0, skipped: 0 };

    const legacyDb = await this.openLegacyGlobalDbIfExists();
    if (!legacyDb) return { imported: 0, skipped: 0 };

    try {
      if (!legacyDb.objectStoreNames.contains(STORE_NAME)) {
        return { imported: 0, skipped: 0 };
      }

      return await new Promise((resolve, reject) => {
        const FLUSH_THRESHOLD = 250;
        let imported = 0;
        let skipped = 0;
        const pending: any[] = [];
        let writeChain: Promise<void> = Promise.resolve();
        let done = false;

        const safeReject = (error: any) => {
          if (done) return;
          done = true;
          reject(error);
        };

        const flush = (batch: any[]) => {
          if (batch.length === 0) return;
          writeChain = writeChain.then(() => this.putManyWithoutCache(batch));
          writeChain.catch(safeReject);
        };

        const readTx = legacyDb.transaction([STORE_NAME], "readonly");
        const readStore = readTx.objectStore(STORE_NAME);
        readTx.onerror = () => safeReject(readTx.error);

        const cursorReq = readStore.openCursor();
        cursorReq.onerror = () => safeReject(cursorReq.error);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result as IDBCursorWithValue | null;
          if (!cursor) {
            flush(pending.splice(0, pending.length));
            writeChain
              .then(() => {
                if (done) return;
                done = true;
                resolve({ imported, skipped });
              })
              .catch(safeReject);
            return;
          }

          const value: any = cursor.value;
          const rawPath = typeof value?.path === "string" ? value.path : "";
          const canonicalPath = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
          if (!canonicalPath || !eligiblePaths.has(canonicalPath)) {
            skipped += 1;
            cursor.continue();
            return;
          }

          const chunkIdFromValue =
            typeof value?.chunkId === "number"
              ? value.chunkId
              : this.parseChunkIdFromId(typeof value?.id === "string" ? value.id : "");
          const chunkId = Number.isFinite(chunkIdFromValue) && chunkIdFromValue >= 0 ? chunkIdFromValue : 0;

          const rawVector = value?.vector as any;
          let vec: Float32Array;
          try {
            vec = toFloat32Array(rawVector as VectorLike);
          } catch {
            vec = new Float32Array(0);
          }

          const metadata = value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
          const isEmpty = metadata.isEmpty === true;
          if (!isEmpty) {
            const ok = normalizeInPlace(vec);
            if (!ok) {
              // Skip invalid vectors; they'll be regenerated later.
              skipped += 1;
              cursor.continue();
              return;
            }
          }

          const dimension = vec.length;
          const parsedNamespace = parseNamespace(typeof metadata?.namespace === "string" ? metadata.namespace : "");
          const provider =
            typeof metadata?.provider === "string" && metadata.provider.trim().length > 0
              ? metadata.provider
              : (parsedNamespace?.provider ?? "unknown");
          const rawModel =
            typeof metadata?.model === "string" && metadata.model.trim().length > 0
              ? metadata.model
              : (parsedNamespace?.model ?? "unknown");
          const model = normalizeModelForNamespace(provider, rawModel);
          const schema = parsedNamespace?.schema ?? 0;
          const namespace = buildNamespaceWithSchema(provider, model, schema, dimension);
          const id = buildVectorId(namespace, canonicalPath, chunkId);

          const updated: any = {
            ...value,
            id,
            path: canonicalPath,
            chunkId,
            vector: vec,
            metadata: {
              ...metadata,
              namespace,
              provider,
              model,
              dimension,
            },
          };

          pending.push(updated);
          imported += 1;
          if (pending.length >= FLUSH_THRESHOLD) {
            flush(pending.splice(0, pending.length));
          }
          cursor.continue();
        };
      });
    } finally {
      try { legacyDb.close(); } catch {}
    }
  }

  /**
   * Rewrite all vectors in this DB to the canonical format:
   * - `vector` is a `Float32Array`
   * - vectors are L2-normalized (unit length) unless `metadata.isEmpty === true`
   * - `metadata.dimension` matches `vector.length`
   * - `metadata.namespace` includes dimension (preserving schema version)
   */
  async upgradeVectorsToCanonicalFormat(): Promise<{ updated: number; skipped: number; removed: number }> {
    if (!this.db) throw new Error("Database not initialized");

    const EPSILON = 0.015; // allow some numeric drift while treating vectors as already normalized
    let updated = 0;
    let skipped = 0;
    let removed = 0;

    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      const cursorReq = store.openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result as IDBCursorWithValue | null;
        if (!cursor) return;

        const value: any = cursor.value;
        const id = typeof value?.id === "string" ? value.id : "";
        const path = typeof value?.path === "string" ? value.path : "";
        if (!id || !path) {
          const delReq = cursor.delete();
          delReq.onerror = () => reject(delReq.error);
          delReq.onsuccess = () => {
            removed += 1;
            cursor.continue();
          };
          return;
        }

        const rawVector = value?.vector as any;
        let vec: Float32Array;
        let needsRewrite = false;

        if (rawVector instanceof Float32Array) {
          vec = rawVector;
        } else if (Array.isArray(rawVector)) {
          vec = Float32Array.from(rawVector);
          needsRewrite = true;
        } else {
          const delReq = cursor.delete();
          delReq.onerror = () => reject(delReq.error);
          delReq.onsuccess = () => {
            removed += 1;
            cursor.continue();
          };
          return;
        }

        const metadata = value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
        const metadataAny: any = metadata as any;
        const isEmpty = metadata.isEmpty === true;

        if (!isEmpty) {
          let sumSq = 0;
          for (let i = 0; i < vec.length; i++) {
            const v = vec[i];
            sumSq += v * v;
          }
          const norm = Math.sqrt(sumSq);
          const alreadyNormalized = Number.isFinite(norm) && Math.abs(norm - 1) <= EPSILON;
          if (!alreadyNormalized) {
            const copy = new Float32Array(vec);
            const ok = normalizeInPlace(copy);
            if (!ok) {
              const delReq = cursor.delete();
              delReq.onerror = () => reject(delReq.error);
              delReq.onsuccess = () => {
                removed += 1;
                cursor.continue();
              };
              return;
            }
            vec = copy;
            needsRewrite = true;
          }
        } else if (!(rawVector instanceof Float32Array)) {
          // Keep empty vectors as Float32Array of matching length.
          vec = new Float32Array(vec.length);
          needsRewrite = true;
        }

        const dimension = vec.length;
        const dimensionMismatch = typeof metadata.dimension !== "number" || metadata.dimension !== dimension;
        if (dimensionMismatch) {
          needsRewrite = true;
        }

        const legacyHash = typeof metadataAny.hash === "string" ? metadataAny.hash.trim() : "";
        const contentHash = typeof metadataAny.contentHash === "string" ? metadataAny.contentHash.trim() : "";
        const hasLegacyHashField = Object.prototype.hasOwnProperty.call(metadataAny, "hash");
        const promoteLegacyHash = legacyHash.length > 0 && (!contentHash || contentHash === "legacy");
        if (promoteLegacyHash || hasLegacyHashField) {
          needsRewrite = true;
        }

        const existingNamespace = typeof metadata.namespace === "string" ? metadata.namespace : "";
        const parsedNamespace = parseNamespace(existingNamespace);
        const schema = parsedNamespace?.schema ?? 0;

        const provider =
          typeof metadata.provider === "string" && metadata.provider.trim().length > 0
            ? metadata.provider
            : (parsedNamespace?.provider ?? "unknown");
        const rawModel =
          typeof metadata.model === "string" && metadata.model.trim().length > 0
            ? metadata.model
            : (parsedNamespace?.model ?? "unknown");
        const model = normalizeModelForNamespace(provider, rawModel);

        const nextNamespace = buildNamespaceWithSchema(provider, model, schema, dimension);
        const namespaceMismatch = existingNamespace !== nextNamespace;
        const providerMissing = typeof metadata.provider !== "string" || metadata.provider.trim().length === 0;
        const modelMissing = typeof metadata.model !== "string" || metadata.model.trim().length === 0;
        const modelNormalizedMismatch = rawModel !== model;
        const chunkId =
          typeof value?.chunkId === "number"
            ? value.chunkId
            : this.parseChunkIdFromId(id);
        const nextId = buildVectorId(nextNamespace, path, Number.isFinite(chunkId) && chunkId >= 0 ? chunkId : 0);
        const idMismatch = id !== nextId;
        if (namespaceMismatch || providerMissing || modelMissing || modelNormalizedMismatch) {
          needsRewrite = true;
        }
        if (idMismatch) {
          needsRewrite = true;
        }

        if (!needsRewrite) {
          skipped += 1;
          cursor.continue();
          return;
        }

        const { hash: _hash, ...restMetadata } = metadataAny;
        const updatedValue: any = {
          ...value,
          id: nextId,
          chunkId: Number.isFinite(chunkId) && chunkId >= 0 ? chunkId : 0,
          vector: vec,
          metadata: {
            ...restMetadata,
            ...(promoteLegacyHash ? { contentHash: legacyHash } : {}),
            provider,
            model,
            dimension,
            namespace: nextNamespace,
          },
        };

        if (idMismatch) {
          // Can't update a record's primary key (id) via cursor.update; move it instead.
          const putReq = store.put(updatedValue);
          putReq.onerror = () => reject(putReq.error);
          putReq.onsuccess = () => {
            const delReq = cursor.delete();
            delReq.onerror = () => reject(delReq.error);
            delReq.onsuccess = () => {
              updated += 1;
              cursor.continue();
            };
          };
          return;
        }

        const updateReq = cursor.update(updatedValue);
        updateReq.onerror = () => reject(updateReq.error);
        updateReq.onsuccess = () => {
          updated += 1;
          cursor.continue();
        };
      };
    });

    // Clear any in-memory state; caller should reload.
    this.cache.clear();
    this.pathsSet.clear();
    this.vectorsArrayCache = null;

    return { updated, skipped, removed };
  }

  /**
   * Load all embeddings into cache
   */
  async loadEmbeddings(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const results = (request.result || []) as EmbeddingVector[];

        this.cache.clear();
        this.pathsSet.clear();

        const vectors: EmbeddingVector[] = [];
        let index = 0;

        const processSlice = () => {
          const sliceStart = performance.now();
          while (index < results.length && performance.now() - sliceStart < 8) {
            const vector = results[index++];
            this.cache.set(vector.id, vector);
            if (vector.path) this.pathsSet.add(vector.path);
            vectors.push(vector);
          }

          if (index < results.length) {
            window.setTimeout(processSlice, 0);
            return;
          }

          this.vectorsArrayCache = vectors;
          resolve();
        };

        processSlice();
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
          this.cache.set(vector.id, vector);
          if (vector.path) this.pathsSet.add(vector.path);
        }
        this.vectorsArrayCache = null;
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
          // Warm cache
          for (const v of items) this.cache.set(v.id, v);
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
      const getOld = store.get(oldId);
      getOld.onsuccess = () => {
        const existing = getOld.result as EmbeddingVector | undefined;
        if (!existing) return resolve();
        const updated: EmbeddingVector = {
          ...existing,
          id: newId,
          chunkId: typeof newChunkId === 'number' ? newChunkId : existing.chunkId,
        };
        const putReq = store.put(updated);
        putReq.onsuccess = () => {
          const delReq = store.delete(oldId);
          delReq.onsuccess = () => {
            this.cache.delete(oldId);
            this.cache.set(newId, updated);
            // pathsSet remains unchanged
            resolve();
          };
          delReq.onerror = () => reject(delReq.error);
        };
        putReq.onerror = () => reject(putReq.error);
      };
      getOld.onerror = () => reject(getOld.error);
      tx.oncomplete = () => {
        this.vectorsArrayCache = null;
      };
    });
  }

  /**
   * Get vector synchronously from cache
   */
  getVectorSync(id: string): EmbeddingVector | null {
    return this.cache.get(id) || null;
  }

  /**
   * Best-effort: infer the most "active" namespace for a provider/model/schema prefix,
   * based on root vectors (chunkId 0) currently loaded in the in-memory cache.
   *
   * Used only for lookups when the provider's true dimension is unknown (e.g. custom
   * providers before their first request in this session). Never sets provider state.
   */
  public peekBestNamespaceForPrefix(prefix: string): string | null {
    if (!prefix) return null;
    if (this.cache.size === 0) return null;

    type Candidate = { namespace: string; latestMtime: number; roots: number };
    const stats = new Map<string, Candidate>();

    for (const v of this.cache.values()) {
      const ns = typeof v?.metadata?.namespace === "string" ? v.metadata.namespace : "";
      if (!ns || !ns.startsWith(prefix)) continue;

      const chunkId = typeof v.chunkId === "number" ? v.chunkId : this.parseChunkIdFromId(v.id);
      if (chunkId !== 0) continue;

      const mtime = typeof v.metadata?.mtime === "number" ? v.metadata.mtime : 0;
      let entry = stats.get(ns);
      if (!entry) {
        entry = { namespace: ns, latestMtime: 0, roots: 0 };
        stats.set(ns, entry);
      }
      entry.roots += 1;
      if (mtime > entry.latestMtime) entry.latestMtime = mtime;
    }

    if (stats.size === 0) return null;

    let best: Candidate | null = null;
    for (const entry of stats.values()) {
      if (!best) {
        best = entry;
        continue;
      }
      if (entry.latestMtime > best.latestMtime) {
        best = entry;
        continue;
      }
      if (entry.latestMtime === best.latestMtime && entry.roots > best.roots) {
        best = entry;
        continue;
      }
      if (entry.latestMtime === best.latestMtime && entry.roots === best.roots && entry.namespace.localeCompare(best.namespace) < 0) {
        best = entry;
      }
    }

    return best?.namespace ?? null;
  }

  /**
   * Get all vectors
   */
  async getAllVectors(): Promise<EmbeddingVector[]> {
    // Return from cache if fully loaded
    if (this.cache.size > 0) {
      // If we have a cached array view, reuse it to avoid allocations
      if (!this.vectorsArrayCache) {
        this.vectorsArrayCache = Array.from(this.cache.values());
      }
      return this.vectorsArrayCache;
    }

    // Load from database
    await this.loadEmbeddings();
    if (!this.vectorsArrayCache) {
      this.vectorsArrayCache = Array.from(this.cache.values());
    }
    return this.vectorsArrayCache;
  }

  async getVectorsByNamespacePrefix(prefix: string): Promise<EmbeddingVector[]> {
    if (!prefix) return [];

    if (this.cache.size > 0) {
      const results: EmbeddingVector[] = [];
      for (const v of this.cache.values()) {
        if (typeof v.metadata?.namespace === 'string' && v.metadata.namespace.startsWith(prefix)) {
          results.push(v);
        }
      }
      return results;
    }

    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('by_namespace');
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
        const req = index.getAll(range);

        req.onsuccess = () => {
          const results = (req.result || []) as EmbeddingVector[];
          for (const v of results) {
            this.cache.set(v.id, v);
          }
          resolve(results);
        };
        req.onerror = () => reject(req.error);
      } catch {
        resolve([]);
      }
    });
  }

  async getVectorsByNamespace(namespace: string): Promise<EmbeddingVector[]> {
    if (!namespace) return [];

    if (this.cache.size > 0) {
      const results: EmbeddingVector[] = [];
      for (const v of this.cache.values()) {
        if (v.metadata?.namespace === namespace) {
          results.push(v);
        }
      }
      return results;
    }

    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction([STORE_NAME], "readonly");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("by_namespace");
        const req = index.getAll(IDBKeyRange.only(namespace));

        req.onsuccess = () => {
          const results = (req.result || []) as EmbeddingVector[];
          for (const v of results) {
            this.cache.set(v.id, v);
          }
          resolve(results);
        };
        req.onerror = () => reject(req.error);
      } catch {
        resolve([]);
      }
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
        this.vectorsArrayCache = null;
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

    return new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase(this.dbName);

      deleteRequest.onsuccess = () => {
        this.cache.clear();
        this.initialized = false;
        this.vectorsArrayCache = null;
        this.pathsSet.clear();
        resolve();
      };

      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => {
        setTimeout(() => resolve(), 1000);
      };
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
        const req = store.delete(id);
        req.onsuccess = () => {
          this.cache.delete(id);
        };
        req.onerror = () => reject(req.error);
      }

      tx.oncomplete = () => {
        this.vectorsArrayCache = null;
        this.refreshPathsCache();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
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
      try {
        const index = store.index('by_path');
        const req = index.getAllKeys(IDBKeyRange.only(path));
        req.onsuccess = () => {
          const keys = (req.result || []) as string[];
          if (keys.length === 0) return resolve();
          const delTx = this.db!.transaction([STORE_NAME], 'readwrite');
          const delStore = delTx.objectStore(STORE_NAME);
          let completed = 0;
          for (const key of keys) {
            const delReq = delStore.delete(key);
            delReq.onsuccess = () => {
              this.cache.delete(key);
            // If this was the last vector for the path, we'll refresh pathsSet on completion
              completed++;
              if (completed === keys.length) resolve();
            };
            delReq.onerror = () => reject(delReq.error);
          }
          delTx.oncomplete = () => {
            this.vectorsArrayCache = null;
          // Recompute paths set cheaply from cache
          this.pathsSet.clear();
          for (const v of this.cache.values()) this.pathsSet.add(v.path);
          };
        };
        req.onerror = () => reject(req.error);
      } catch (e) {
        resolve();
      }
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
      try {
        const index = store.index('by_path');
        const req = index.getAllKeys(IDBKeyRange.only(path));
        req.onsuccess = () => {
          const keys = (req.result || []) as string[];
          const prefix = `${namespace}::${path}#`;
          const toDelete = keys.filter(id => id.startsWith(prefix) && !keepIds.has(id));
          if (toDelete.length === 0) {
            tx.oncomplete = () => {
              this.vectorsArrayCache = null;
              // Recompute pathsSet
              this.pathsSet.clear();
              for (const v of this.cache.values()) this.pathsSet.add(v.path);
            };
            return resolve();
          }
          let completed = 0;
          for (const id of toDelete) {
            const delReq = store.delete(id);
            delReq.onsuccess = () => {
              this.cache.delete(id);
              completed++;
              if (completed === toDelete.length) resolve();
            };
            delReq.onerror = () => reject(delReq.error);
          }
          tx.oncomplete = () => {
            this.vectorsArrayCache = null;
            // Recompute pathsSet
            this.pathsSet.clear();
            for (const v of this.cache.values()) this.pathsSet.add(v.path);
          };
        };
        req.onerror = () => reject(req.error);
      } catch (e) {
        resolve();
      }
    });
  }

  async renameByPath(oldPath: string, newPath: string, newTitle?: string): Promise<void> {
    if (!this.db) return;
    if (!oldPath || !newPath || oldPath === newPath) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      try {
        const index = store.index('by_path');
        const req = index.getAll(IDBKeyRange.only(oldPath));
        req.onsuccess = () => {
          const items = (req.result || []) as EmbeddingVector[];
          if (items.length === 0) return resolve();
          const writeTx = this.db!.transaction([STORE_NAME], 'readwrite');
          const writeStore = writeTx.objectStore(STORE_NAME);
          let completed = 0;
          for (const v of items) {
            const chunkId = typeof v.chunkId === 'number' ? v.chunkId : this.parseChunkIdFromId(v.id);
            const namespace = typeof v.metadata?.namespace === "string" ? v.metadata.namespace : "unknown:unknown:v0:0";
            const newId = buildVectorId(namespace, newPath, chunkId);
            const updated: EmbeddingVector = {
              ...v,
              id: newId,
              path: newPath,
              chunkId,
              metadata: newTitle ? { ...v.metadata, title: newTitle } : v.metadata
            };
            const delReq = writeStore.delete(v.id);
            delReq.onsuccess = () => {
              const putReq = writeStore.put(updated);
              putReq.onsuccess = () => {
                this.cache.delete(v.id);
                this.cache.set(newId, updated);
                completed++;
                if (completed === items.length) resolve();
              };
              putReq.onerror = () => reject(putReq.error);
            };
            delReq.onerror = () => reject(delReq.error);
          }
          writeTx.oncomplete = () => {
            this.vectorsArrayCache = null;
            this.pathsSet.delete(oldPath);
            this.pathsSet.add(newPath);
          };
        };
        req.onerror = () => reject(req.error);
      } catch (e) {
        resolve();
      }
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

    await new Promise<void>((resolve) => {
      let resolved = false;
      const safeResolve = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      try {
        const tx = this.db!.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("by_path");
        const range = IDBKeyRange.bound(oldPrefix, `${oldPrefix}\uffff`);

        tx.oncomplete = () => {
          this.vectorsArrayCache = null;
          this.refreshPathsCache();
          safeResolve();
        };
        tx.onerror = () => safeResolve();

        const cursorReq = index.openCursor(range);
        cursorReq.onerror = () => safeResolve();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const value = cursor.value as EmbeddingVector;
          const currentId = String(cursor.primaryKey);
          const relative = (value.path || "").substring(oldPrefix.length);
          const chunkId =
            typeof value.chunkId === "number"
              ? value.chunkId
              : this.parseChunkIdFromId(value.id);
          const newPath = `${newPrefix}${relative}`;
          const namespace = typeof value.metadata?.namespace === "string" ? value.metadata.namespace : "unknown:unknown:v0:0";
          const newId = buildVectorId(namespace, newPath, chunkId);
          const updated: EmbeddingVector = { ...value, id: newId, path: newPath, chunkId };

          const deleteReq = store.delete(cursor.primaryKey);
          deleteReq.onerror = () => safeResolve();
          deleteReq.onsuccess = () => {
            const putReq = store.put(updated);
            putReq.onerror = () => safeResolve();
            putReq.onsuccess = () => {
              this.cache.delete(currentId);
              this.cache.set(newId, updated);
              cursor.continue();
            };
          };
        };
      } catch (e) {
        safeResolve();
      }
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

    await new Promise<void>((resolve) => {
      let resolved = false;
      const safeResolve = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      try {
        const tx = this.db!.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("by_path");
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);

        tx.oncomplete = () => {
          this.vectorsArrayCache = null;
          this.refreshPathsCache();
          safeResolve();
        };
        tx.onerror = () => safeResolve();

        const cursorReq = index.openKeyCursor(range);
        cursorReq.onerror = () => safeResolve();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const key = String(cursor.primaryKey);
          const delReq = store.delete(cursor.primaryKey);
          delReq.onerror = () => safeResolve();
          delReq.onsuccess = () => {
            this.cache.delete(key);
            cursor.continue();
          };
        };
      } catch (e) {
        safeResolve();
      }
    });
  }

  /**
   * Remove all vectors whose namespace starts with a given prefix.
   * Used for forcing a refresh/migration for the current provider+model+schema.
   */
	  async removeByNamespacePrefix(prefix: string): Promise<void> {
	    if (!this.db) return;
	    if (!prefix) return;
	    await new Promise<void>((resolve, reject) => {
	      let completed = false;
	      const safeResolve = () => {
	        if (completed) return;
	        completed = true;
	        resolve();
	      };

	      try {
	        const tx = this.db!.transaction([STORE_NAME], "readwrite");
	        const store = tx.objectStore(STORE_NAME);
	        const index = store.index("by_namespace");
	        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);

	        tx.oncomplete = () => {
	          this.vectorsArrayCache = null;
	          this.refreshPathsCache();
	          safeResolve();
	        };
	        tx.onerror = () => reject(tx.error);

	        const cursorReq = index.openKeyCursor(range);
	        cursorReq.onerror = () => reject(cursorReq.error);
	        cursorReq.onsuccess = () => {
	          const cursor = cursorReq.result;
	          if (!cursor) return;
	          const key = String(cursor.primaryKey);
	          const delReq = store.delete(cursor.primaryKey);
	          delReq.onerror = () => reject(delReq.error);
	          delReq.onsuccess = () => {
	            this.cache.delete(key);
	            cursor.continue();
	          };
	        };
	      } catch (e) {
	        safeResolve();
	      }
	    });
	  }

  /**
   * Scan cached vectors for corruption and repair or remove invalid entries.
   * Returns a summary so callers can schedule re-indexing where needed.
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
	      let needsRewrite = false;

	      if (typeof metadata.dimension !== 'number' || metadata.dimension <= 0 || metadata.dimension !== dimension) {
	        needsRewrite = true;
	      }

	      if (metadata.isEmpty !== true) {
	        let sumSq = 0;
	        for (let i = 0; i < vector.vector.length; i++) {
	          const v = vector.vector[i];
	          sumSq += v * v;
	        }
	        const norm = Math.sqrt(sumSq);
	        const alreadyNormalized = Number.isFinite(norm) && Math.abs(norm - 1) <= EPSILON;
	        if (!alreadyNormalized) {
	          const copy = new Float32Array(vector.vector);
	          const ok = normalizeInPlace(copy);
	          if (!ok) {
	            removedIds.push(id);
	            removedPaths.add(path);
	            continue;
	          }
	          vector.vector = copy;
	          needsRewrite = true;
	          correctedPaths.add(path);
	        }
	      }

	      if (needsRewrite) {
	        vector.metadata = {
	          ...metadata,
	          dimension,
	        };
	        correctedVectors.push(vector);
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
