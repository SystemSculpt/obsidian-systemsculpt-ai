import { App, EventRef, TFile } from "obsidian";
import { Mutex } from "async-mutex";
import SystemSculptPlugin from "../../main";
import type {
  EmbeddingVector,
  EmbeddingsManagerConfig,
  ProcessingProgress,
  SearchResult,
} from "./types";
import { ManagedEmbeddingsAdapter, ManagedEmbeddingsError } from "./gateway/ManagedEmbeddingsAdapter";
import {
  EmbeddingsProcessor,
  type EmbeddingSourceRevision,
} from "./processing/EmbeddingsProcessor";
import { ContentPreprocessor } from "./processing/ContentPreprocessor";
import { VectorSearch } from "./search/VectorSearch";
import { EmbeddingsStorage } from "./storage/EmbeddingsStorage";
import { EmbeddingsIndexFile } from "./storage/EmbeddingsIndexFile";
import {
  restoreEmbeddingsIndexIfEmpty,
  PortableCheckpointCoordinator,
} from "./storage/EmbeddingsPortableIndex";
import {
  buildManagedNamespace,
  isManagedNamespace,
  parseNamespaceDimension,
  MANAGED_EMBEDDING_GENERATION,
  MANAGED_EMBEDDING_FAMILY_PREFIX,
} from "./utils/namespace";
import { buildVectorId } from "./utils/vectorId";
import { normalizeInPlace, toFloat32Array } from "./utils/vector";
import {
  isCurrentLocalEmptyEmbeddingMarker,
  isLocalEmptyEmbeddingMarker,
  localEmptyEmbeddingMarkerId,
} from "./LocalEmptyEmbeddingMarker";
import {
  SemanticIndexLifecycle,
  type SemanticIndexFileSnapshot,
  type SemanticIndexSnapshot,
} from "./SemanticIndexLifecycle";
import {
  SemanticWorkQueue,
  type SemanticWorkItem,
  type SemanticWorkReason,
} from "./SemanticWorkQueue";
import {
  MANAGED_EMBEDDING_INDEX_SCHEMA_VERSION,
  MANAGED_EMBEDDING_LIMITS,
} from "./ManagedEmbeddingsContract";

export type EmbeddingsRunStatus = "complete" | "aborted";

export interface EmbeddingsRunResult {
  status: EmbeddingsRunStatus;
  processed: number;
  failure?: ManagedEmbeddingsError;
  message?: string;
  partialSuccess?: boolean;
}

export type PendingEmbeddingReason =
  | "missing"
  | "modified"
  | "schema-mismatch"
  | "metadata-missing"
  | "incomplete"
  | "empty"
  | "failed";

export interface PendingEmbeddingFile {
  path: string;
  reason: PendingEmbeddingReason;
  lastModified: number | null;
  lastEmbedded: number | null;
  size: number | null;
  existingNamespace?: string;
  failureInfo?: {
    code: string;
    message: string;
    failedAt: number;
  };
}

interface FailedEmbeddingFile {
  path: string;
  error: { code: string; message: string };
  failedAt: number;
}

interface CommittedNamespaceState {
  version: 1;
  namespace: string;
  committedAt: number;
}

const QUEUED_WORK_MUTEX_BACKOFF_MS = 75;
const COMMITTED_NAMESPACE_STATE_KEY = "semantic-committed-namespace-v1";

type FileState = {
  needsProcessing: boolean;
  reason: PendingEmbeddingReason | "excluded" | "up-to-date";
  lastEmbedded?: number | null;
  existingNamespace?: string;
};

/**
 * Managed-only embeddings coordinator.
 *
 * Endpoint configuration, retries, cooldowns, and entitlement decisions do not
 * exist here. Admission and transport ownership live in ManagedCapabilityClient.
 */
export class EmbeddingsManager {
  private readonly storage: EmbeddingsStorage;
  private readonly gateway: ManagedEmbeddingsAdapter;
  private readonly processor: EmbeddingsProcessor;
  private readonly preprocessor = new ContentPreprocessor();
  private readonly search = new VectorSearch();
  private readonly processingMutex = new Mutex();
  private readonly failedFiles = new Map<string, FailedEmbeddingFile>();
  private readonly queryCache = new Map<string, { vector: Float32Array; namespace: string; expiresAt: number }>();
  private readonly lifecycle = new SemanticIndexLifecycle();
  private readonly workQueue: SemanticWorkQueue;
  private config: EmbeddingsManagerConfig;
  private initializationPromise: Promise<void> | null = null;
  private initialized = false;
  private processingSuspended = false;
  private automaticRunQueued = false;
  private operationSequence = 0;
  /** Namespace that is complete enough to query while another is written. */
  private searchNamespace: string | null = null;
  private fileWatchers: EventRef[] = [];
  private portableIndexFile: EmbeddingsIndexFile | null = null;
  private portableCheckpoint: PortableCheckpointCoordinator | null = null;
  private workTimer: number | null = null;
  private workTimerDueAt: number | null = null;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    config?: Partial<EmbeddingsManagerConfig>,
  ) {
    this.config = this.buildConfig(config);
    this.storage = new EmbeddingsStorage(
      EmbeddingsStorage.buildDbName(this.plugin.settings.vaultInstanceId || ""),
    );
    this.gateway = new ManagedEmbeddingsAdapter(this.plugin.getManagedCapabilityClient());
    const stateStorage = this.storage as EmbeddingsStorage & Partial<Pick<
      EmbeddingsStorage,
      "readState" | "writeState" | "deleteState"
    >>;
    this.workQueue = new SemanticWorkQueue({
      readState: <T>(key: string) => typeof stateStorage.readState === "function"
        ? stateStorage.readState<T>(key)
        : Promise.resolve(null),
      writeState: <T>(key: string, value: T) => typeof stateStorage.writeState === "function"
        ? stateStorage.writeState(key, value)
        : Promise.resolve(),
      deleteState: (key: string) => typeof stateStorage.deleteState === "function"
        ? stateStorage.deleteState(key)
        : Promise.resolve(),
    });
    this.processor = new EmbeddingsProcessor(
      this.gateway,
      this.storage,
      this.preprocessor,
    );
  }

  async initialize(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeStorage();
    }
    await this.initializationPromise;
    if (this.plugin.settings.embeddingsEnabled) {
      this.requestAutomaticProcessing();
    }
  }

  private async initializeStorage(): Promise<void> {
    this.lifecycle.update({ phase: "initializing", ready: false, lastError: null });
    await this.storage.initialize();
    await this.workQueue.restore();
    this.hydrateFailuresFromWorkQueue();
    await this.restorePortableIndexIfEmpty();
    await this.storage.loadEmbeddings();
    await this.migrateToManagedNamespaceContract();
    const repair = await this.storage.purgeCorruptedVectors();
    await this.hydrateManagedIdentityFromStorage();
    for (const path of repair.removedPaths) {
      const failedAt = Date.now();
      const error = { code: "invalid_response", message: "Stored vector was invalid." };
      const abstract = this.app.vault.getAbstractFileByPath(path);
      const claim = await this.workQueue.enqueueImmediate(
        path,
        "reconcile",
        abstract instanceof TFile ? this.sourceMtime(abstract) : null,
        failedAt,
      );
      if (claim && await this.workQueue.fail(claim, error, failedAt)) {
        this.failedFiles.set(path, { path, error, failedAt });
      }
    }
    this.setupFileWatchers();
    this.initialized = true;
    this.refreshLifecycle({ phase: this.processingSuspended ? "paused" : "idle", ready: true });
  }

  async processVault(onProgress?: (progress: ProcessingProgress) => void): Promise<EmbeddingsRunResult> {
    await this.awaitReady();
    if (this.processingSuspended) {
      return { status: "aborted", processed: 0, message: "Embeddings processing is paused." };
    }
    try {
      await this.gateway.initializeContract();
    } catch (error) {
      this.reportLifecycleFailure(error);
      throw error;
    }
    if (this.processingMutex.isLocked()) {
      throw new Error("Embeddings processing is already in progress.");
    }

    return this.processingMutex.runExclusive(async () => {
      await this.setRebuildPending(true);
      const eligibleFiles = this.app.vault.getMarkdownFiles().filter((file) => !this.isFileExcluded(file));
      this.refreshLifecycle({
        phase: "reconciling",
        total: eligibleFiles.length,
        completed: 0,
        currentPath: null,
        lastError: null,
      });
      const emptyFiles = eligibleFiles.filter((file) => this.isLocallyEmpty(file));
      const emptyClaims = await this.captureWorkClaims(emptyFiles, "reconcile");
      for (const file of emptyFiles) {
        await this.storage.removeByPath(file.path);
        this.failedFiles.delete(file.path);
      }
      await this.workQueue.complete(emptyClaims.values());
      const files = eligibleFiles.filter((file) => !this.isLocallyEmpty(file) && this.shouldProcessFile(file));
      if (files.length === 0) {
        await this.setRebuildPending(false);
        if (emptyFiles.length > 0) await this.commitPortableDestructiveMutation();
        const committed = await this.commitSearchNamespaceIfComplete();
        if (committed) await this.pruneInactiveManagedNamespaces();
        this.refreshLifecycle({ phase: "idle", currentPath: null, lastError: null });
        return { status: "complete", processed: 0 };
      }

      const workClaims = await this.captureWorkClaims(files, "reconcile");
      const sourceRevisions = this.buildSourceRevisions(files, workClaims);
      this.emit("embeddings:processing-start", { scope: "vault", total: files.length, reason: "managed" });
      const result = await this.processor.processFiles(files, this.app, (progress) => {
        this.emit("embeddings:processing-progress", {
          scope: "vault",
          total: files.length,
          current: progress.current,
          batch: progress.batchProgress,
        });
        this.refreshLifecycle({
          phase: "reconciling",
          total: progress.total,
          completed: progress.current,
          currentPath: progress.currentFile ?? null,
        });
        onProgress?.(progress);
      }, { sourceRevisions });
      await this.recordFailures(result.failedPaths, workClaims, result.failedDetails, result.fatalError);
      const completedPaths = new Set(result.completedPaths);
      const failedPaths = new Set(result.failedPaths);
      for (const path of completedPaths) this.failedFiles.delete(path);
      await this.workQueue.complete(
        [...completedPaths]
          .map((path) => workClaims.get(path))
          .filter((claim): claim is SemanticWorkItem => Boolean(claim)),
      );

      const unfinishedCount = files.reduce((count, file) => (
        completedPaths.has(file.path) || failedPaths.has(file.path) ? count : count + 1
      ), 0);
      await this.setRebuildPending(
        Boolean(result.fatalError) || result.cancelled || result.failed > 0 || unfinishedCount > 0,
      );
      const completedCleanly = !result.fatalError
        && !result.cancelled
        && result.failed === 0
        && unfinishedCount === 0;
      const committed = completedCleanly
        ? await this.commitSearchNamespaceIfComplete()
        : false;
      const pruned = committed ? await this.pruneInactiveManagedNamespaces() : 0;
      const destructive = emptyFiles.length > 0 || result.failed > 0 || pruned > 0;
      if (destructive) {
        await this.commitPortableDestructiveMutation();
      } else if (completedPaths.size > 0) {
        this.markPortableIndexChanged();
        await this.flushPortableIndex();
      }
      const firstFailure = result.failedDetails?.[result.failedPaths[0] ?? ""];
      this.refreshLifecycle({
        phase: result.fatalError || result.failed > 0
          ? "error"
          : this.processingSuspended
            ? "paused"
            : "idle",
        currentPath: null,
        lastError: result.fatalError
          ? { code: result.fatalError.code, message: result.fatalError.message }
          : firstFailure
            ? { code: firstFailure.code, message: firstFailure.message }
            : null,
      });
      this.emit("embeddings:processing-complete", {
        scope: "vault",
        processed: result.completed,
        failed: result.failed,
        status: result.fatalError
          ? "error"
          : result.cancelled
            ? "aborted"
            : result.failed > 0
              ? "partial"
              : "success",
      });

      if (result.fatalError) {
        return {
          status: "aborted",
          processed: result.completed,
          failure: result.fatalError,
          message: result.fatalError.message,
          partialSuccess: result.completed > 0,
        };
      }
      if (result.cancelled) {
        return {
          status: "aborted",
          processed: result.completed,
          message: "Embeddings processing was stopped locally.",
          partialSuccess: result.completed > 0,
        };
      }
      return {
        status: "complete",
        processed: result.completed,
        partialSuccess: result.failed > 0,
      };
    });
  }

  async retryFailedFiles(): Promise<EmbeddingsRunResult> {
    await this.workQueue.retryFailures();
    this.failedFiles.clear();
    return this.processVault();
  }

  async searchSimilar(query: string, limit = 20, signal?: AbortSignal): Promise<SearchResult[]> {
    await this.awaitReady();
    await this.gateway.initializeContract();
    const prepared = String(query || "").trim();
    if (!prepared || signal?.aborted) return [];

    let namespace = this.getSearchNamespace();
    let cacheKey = `${namespace ?? "unnegotiated"}:${this.hashQuery(prepared)}`;
    const cached = this.queryCache.get(cacheKey);
    let queryVector: Float32Array;
    if (cached && namespace && cached.namespace === namespace && cached.expiresAt > Date.now()) {
      queryVector = cached.vector;
    } else {
      const vectors = await this.gateway.generateEmbeddings([prepared], {
        idempotencyKey: this.nextIdempotencyKey("query"),
        signal,
      });
      if (signal?.aborted) return [];
      const raw = vectors[0];
      if (!raw) throw new ManagedEmbeddingsError("invalid_response", "Managed query embedding is missing.", 200);
      queryVector = toFloat32Array(raw);
      if (!normalizeInPlace(queryVector)) {
        throw new ManagedEmbeddingsError("invalid_response", "Managed query embedding is invalid.", 200);
      }
      const negotiatedNamespace = this.gateway.activeGeneration?.indexNamespace;
      if (!negotiatedNamespace || !isManagedNamespace(negotiatedNamespace)) {
        throw new ManagedEmbeddingsError("invalid_response", "Managed embedding generation is missing.", 200);
      }
      // A newly-written namespace is not searchable until the full eligible
      // corpus has committed. Never expose a partial replacement here.
      if (!namespace || namespace !== negotiatedNamespace) return [];
      cacheKey = `${namespace}:${this.hashQuery(prepared)}`;
      this.rememberQuery(cacheKey, queryVector, namespace);
      this.refreshLifecycle({ generation: this.currentGenerationSnapshot() });
    }

    if (!namespace || namespace !== buildManagedNamespace(queryVector.length)) return [];
    const [rawResults] = await this.searchIndexedNamespace(
      namespace,
      [queryVector],
      Math.max(limit * 4, limit),
      signal,
    );
    if (signal?.aborted) return [];
    return this.applyLexicalSignals(prepared, this.mergeChunkResults([rawResults ?? []], limit));
  }

  async findSimilar(filePath: string, limit = 15, signal?: AbortSignal): Promise<SearchResult[]> {
    await this.awaitReady();
    if (signal?.aborted || !filePath || this.isPathExcluded(filePath)) return [];
    const namespace = this.getSearchNamespace();
    if (!namespace) return [];
    const sourceFile = this.app.vault.getAbstractFileByPath(filePath);
    if (!(sourceFile instanceof TFile) || !this.isFileReadyInNamespace(sourceFile, namespace)) return [];

    const storedSourceVectors = await this.storage.getVectorsByPath(filePath);
    if (signal?.aborted) return [];
    const sourceVectors = storedSourceVectors.filter((vector) => (
      vector.metadata.namespace === namespace && vector.metadata.isEmpty !== true
    ));
    const queryVectors = this.selectQueryVectors(sourceVectors);
    if (queryVectors.length === 0) return [];

    const sets = await this.searchIndexedNamespace(
      namespace,
      queryVectors.map((vector) => vector.vector),
      Math.max(limit * 4, limit),
      signal,
      filePath,
    );
    if (signal?.aborted) return [];
    return this.mergeChunkResults(sets, limit, filePath);
  }

  getStats(): { total: number; processed: number; present: number; needsProcessing: number; failed: number } {
    const files = this.eligibleFiles();
    let processed = 0;
    let present = 0;
    for (const file of files) {
      const state = this.evaluateFileProcessingState(file);
      if (state.reason !== "missing" && state.reason !== "schema-mismatch" && state.reason !== "empty") {
        present += 1;
      }
      if (!state.needsProcessing) processed += 1;
    }
    return {
      total: files.length,
      processed,
      present,
      needsProcessing: Math.max(0, files.length - processed),
      failed: this.failedFiles.size,
    };
  }

  async listPendingFiles(): Promise<PendingEmbeddingFile[]> {
    await this.awaitReady();
    const pending: PendingEmbeddingFile[] = [];
    for (const file of this.eligibleFiles()) {
      const failed = this.failedFiles.get(file.path);
      if (failed) {
        pending.push({
          path: file.path,
          reason: "failed",
          lastModified: file.stat?.mtime ?? null,
          lastEmbedded: null,
          size: file.stat?.size ?? null,
          failureInfo: { ...failed.error, failedAt: failed.failedAt },
        });
        continue;
      }
      const state = this.evaluateFileProcessingState(file);
      if (!state.needsProcessing || state.reason === "excluded" || state.reason === "up-to-date") continue;
      pending.push({
        path: file.path,
        reason: state.reason,
        lastModified: file.stat?.mtime ?? null,
        lastEmbedded: state.lastEmbedded ?? null,
        size: file.stat?.size ?? null,
        existingNamespace: state.existingNamespace,
      });
    }
    return pending.sort((left, right) => {
      if (left.reason === "failed" && right.reason !== "failed") return -1;
      if (right.reason === "failed" && left.reason !== "failed") return 1;
      return (right.lastModified ?? 0) - (left.lastModified ?? 0);
    });
  }

  public async awaitReady(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  public isReady(): boolean {
    return this.initialized;
  }

  public getLifecycleSnapshot(): Readonly<SemanticIndexSnapshot> {
    return this.lifecycle.getSnapshot();
  }

  public subscribeLifecycle(
    listener: (snapshot: Readonly<SemanticIndexSnapshot>) => void,
  ): () => void {
    return this.lifecycle.subscribe(listener);
  }

  public getFileIndexSnapshot(path: string): Readonly<SemanticIndexFileSnapshot> {
    const searchNamespace = this.getSearchNamespace();
    const base = {
      path,
      generation: searchNamespace
        ? this.generationSnapshotForNamespace(searchNamespace)
        : this.currentGenerationSnapshot(),
    };
    if (!path) return { ...base, state: "missing", ready: false, indexedAt: null };
    const queued = this.workQueue.get(path);
    if (queued?.failure || this.failedFiles.has(path)) {
      return { ...base, state: "failed", ready: false, indexedAt: null };
    }
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile) || abstract.extension !== "md") {
      return { ...base, state: "missing", ready: false, indexedAt: null };
    }
    const state = this.evaluateFileProcessingState(abstract);
    // A queued file event is newer work even when the filesystem reports the
    // same coarse mtime as the stored root. Do not surface it as ready until
    // that exact queue revision settles.
    if (queued) {
      return { ...base, state: "pending", ready: false, indexedAt: state.lastEmbedded ?? null };
    }
    if (state.reason === "excluded") {
      return { ...base, state: "excluded", ready: false, indexedAt: state.lastEmbedded ?? null };
    }
    if (state.reason === "empty") {
      return { ...base, state: "empty", ready: false, indexedAt: state.lastEmbedded ?? null };
    }
    if (searchNamespace && this.isFileReadyInNamespace(abstract, searchNamespace)) {
      const root = this.storage.getVectorSync(buildVectorId(searchNamespace, path, 0));
      return {
        ...base,
        state: "ready",
        ready: true,
        indexedAt: root?.metadata.mtime ?? null,
      };
    }
    if (state.reason === "up-to-date") {
      return { ...base, state: "ready", ready: true, indexedAt: state.lastEmbedded ?? null };
    }
    if (state.reason === "modified") {
      return { ...base, state: "stale", ready: false, indexedAt: state.lastEmbedded ?? null };
    }
    return {
      ...base,
      state: state.reason === "missing" ? "missing" : "pending",
      ready: false,
      indexedAt: state.lastEmbedded ?? null,
    };
  }

  isCurrentlyProcessing(): boolean {
    return this.processingMutex.isLocked();
  }

  suspendProcessing(): void {
    this.processingSuspended = true;
    this.clearWorkTimer();
    this.processor.cancel();
    this.refreshLifecycle({ phase: "paused", currentPath: null });
  }

  resumeProcessing(): void {
    this.processingSuspended = false;
    this.refreshLifecycle({ phase: "idle", currentPath: null, lastError: null });
    if (this.plugin.settings.embeddingsEnabled) this.requestAutomaticProcessing();
  }

  isSuspended(): boolean {
    return this.processingSuspended;
  }

  public syncFromSettings(): void {
    const previous = this.config;
    this.config = this.buildConfig();
    if (JSON.stringify(previous.exclusions) !== JSON.stringify(this.config.exclusions)) {
      void this.cleanupExcludedEmbeddings().catch(() => undefined);
    }
    if (this.plugin.settings.embeddingsEnabled) {
      this.requestAutomaticProcessing();
    }
  }

  public hasAnyStoredVectors(): boolean {
    return this.storage.size() > 0;
  }

  public hasAnyEmbeddings(): boolean {
    return this.storage.getDistinctPaths().some((path) => this.getFileIndexSnapshot(path).ready);
  }

  public hasVector(path: string): boolean {
    return this.getFileIndexSnapshot(path).ready;
  }

  async clearAll(): Promise<void> {
    await this.awaitReady();
    this.processor.cancel();
    await this.processingMutex.runExclusive(async () => {
      await this.storage.clear();
      await this.workQueue.clear();
      this.failedFiles.clear();
      this.queryCache.clear();
      this.gateway.activeGeneration = undefined;
      this.gateway.expectedDimension = undefined;
      this.searchNamespace = null;
      await this.setRebuildPending(false);
      await this.deleteCommittedNamespace();
      await this.getPortableCheckpoint()?.clear();
      this.refreshLifecycle({
        phase: "idle",
        generation: null,
        total: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        currentPath: null,
        lastError: null,
      });
    });
  }

  async resetDatabase(): Promise<void> {
    this.processor.cancel();
    await this.processingMutex.runExclusive(async () => {
      await this.storage.reset();
      this.initialized = false;
      this.initializationPromise = null;
      this.failedFiles.clear();
      this.queryCache.clear();
      this.gateway.activeGeneration = undefined;
      this.gateway.expectedDimension = undefined;
      this.searchNamespace = null;
      this.portableCheckpoint?.cancel();
      this.portableCheckpoint = null;
    });
    await this.initialize();
  }

  async forceRefreshCurrentNamespace(): Promise<void> {
    await this.awaitReady();
    this.suspendProcessing();
    try {
      await this.processingMutex.runExclusive(async () => {
        await this.storage.removeCurrentManagedGeneration();
        this.searchNamespace = null;
        this.queryCache.clear();
        await this.deleteCommittedNamespace();
        await this.commitPortableDestructiveMutation();
      });
    } finally {
      this.processingSuspended = false;
      this.refreshLifecycle({ phase: "idle", currentPath: null, lastError: null });
    }
    await this.processVault();
  }

  async cleanup(): Promise<void> {
    this.processingSuspended = true;
    this.processor.cleanup();
    this.clearWorkTimer();
    for (const ref of this.fileWatchers) {
      try { this.app.vault.offref(ref); } catch { /* Obsidian may already have detached it. */ }
    }
    this.fileWatchers = [];
    await this.processingMutex.runExclusive(() => this.flushPortableIndex());
    this.portableCheckpoint?.cancel();
    this.queryCache.clear();
    this.lifecycle.clearListeners();
  }

  private requestAutomaticProcessing(): void {
    if (
      this.automaticRunQueued
      || this.processingSuspended
      || !this.initialized
      || this.processingMutex.isLocked()
    ) return;
    this.automaticRunQueued = true;
    this.refreshLifecycle({ phase: "initializing", currentPath: null, lastError: null });
    queueMicrotask(() => {
      this.automaticRunQueued = false;
      if (!this.plugin.settings.embeddingsEnabled || this.processingSuspended || this.processingMutex.isLocked()) return;
      void this.processVault().catch((error) => this.reportLifecycleFailure(error));
    });
  }

  private setupFileWatchers(): void {
    if (this.fileWatchers.length > 0) return;
    this.fileWatchers.push(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md") this.requestFileProcessing(file, "create");
    }));
    this.fileWatchers.push(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") this.requestFileProcessing(file, "modify");
    }));
    this.fileWatchers.push(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") {
        void this.processingMutex.runExclusive(async () => {
          await this.storage.renameByPath(oldPath, file.path, file.basename);
          await this.workQueue.rename(oldPath, file.path);
          this.failedFiles.delete(oldPath);
          await this.commitPortableDestructiveMutation();
          this.requestFileProcessing(file, "rename");
        }).catch(() => undefined);
      } else {
        void this.processingMutex.runExclusive(async () => {
          await this.storage.renameByDirectory(oldPath, file.path);
          await this.workQueue.renamePrefix(oldPath, file.path);
          const oldPrefix = `${oldPath.replace(/\/$/, "")}/`;
          const newPrefix = `${file.path.replace(/\/$/, "")}/`;
          for (const [path, failure] of [...this.failedFiles]) {
            if (!path.startsWith(oldPrefix)) continue;
            this.failedFiles.delete(path);
            const nextPath = `${newPrefix}${path.slice(oldPrefix.length)}`;
            this.failedFiles.set(nextPath, { ...failure, path: nextPath });
          }
          await this.commitPortableDestructiveMutation();
        }).catch(() => undefined);
      }
    }));
    this.fileWatchers.push(this.app.vault.on("delete", (file) => {
      void this.processingMutex.runExclusive(async () => {
        if (file instanceof TFile) {
          await this.storage.removeByPath(file.path);
          await this.workQueue.remove(file.path);
          this.failedFiles.delete(file.path);
        } else {
          await this.storage.removeByDirectory(file.path);
          const prefix = `${file.path.replace(/\/$/, "")}/`;
          await this.workQueue.removePrefix(file.path);
          for (const path of [...this.failedFiles.keys()]) {
            if (path.startsWith(prefix)) this.failedFiles.delete(path);
          }
        }
        await this.commitPortableDestructiveMutation();
        this.refreshLifecycle({ phase: "idle", currentPath: null });
      }).catch(() => undefined);
    }));
  }

  private requestFileProcessing(file: TFile, reason: SemanticWorkReason): void {
    if (!this.plugin.settings.embeddingsEnabled) return;
    void this.workQueue.enqueue(file.path, reason, this.sourceMtime(file))
      .then(() => {
        this.refreshLifecycle();
        if (!this.processingSuspended) this.scheduleQueuedWork();
      })
      .catch(() => undefined);
  }

  private scheduleQueuedWork(minimumDelayMs = 0): void {
    if (this.processingSuspended || !this.plugin.settings.embeddingsEnabled) return;
    const next = this.workQueue.snapshot()
      .filter((item) => !item.failure)
      .sort((left, right) => left.readyAt - right.readyAt)[0];
    if (!next) return;
    const now = Date.now();
    const contentionBackoff = this.processingMutex.isLocked() ? QUEUED_WORK_MUTEX_BACKOFF_MS : 0;
    const delay = Math.max(
      minimumDelayMs,
      contentionBackoff,
      Math.max(0, Math.min(2_000, next.readyAt - now)),
    );
    const dueAt = now + delay;
    if (this.workTimer !== null && this.workTimerDueAt !== null && this.workTimerDueAt <= dueAt) return;
    this.clearWorkTimer();
    this.workTimerDueAt = dueAt;
    this.workTimer = window.setTimeout(() => {
      this.workTimer = null;
      this.workTimerDueAt = null;
      void this.processQueuedWork().catch((error) => this.reportLifecycleFailure(error));
    }, delay);
  }

  private clearWorkTimer(): void {
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workTimerDueAt = null;
  }

  private async processQueuedWork(): Promise<void> {
    if (this.processingSuspended || !this.plugin.settings.embeddingsEnabled) return;
    if (this.processingMutex.isLocked()) {
      this.scheduleQueuedWork(QUEUED_WORK_MUTEX_BACKOFF_MS);
      return;
    }
    const due = this.workQueue.due();
    if (due.length === 0) {
      this.scheduleQueuedWork();
      return;
    }
    await this.processingMutex.runExclusive(async () => {
      const completedWithoutEmbedding: SemanticWorkItem[] = [];
      const files: TFile[] = [];
      const workClaims = new Map<string, SemanticWorkItem>();
      let destructive = false;
      for (const item of due) {
        const abstract = this.app.vault.getAbstractFileByPath(item.path);
        if (!(abstract instanceof TFile) || abstract.extension !== "md" || this.isFileExcluded(abstract)) {
          await this.storage.removeByPath(item.path);
          completedWithoutEmbedding.push(item);
          destructive = true;
          continue;
        }
        const currentMtime = this.sourceMtime(abstract);
        if (currentMtime !== item.sourceMtime) {
          await this.workQueue.enqueueImmediate(item.path, "modify", currentMtime);
          continue;
        }
        if (this.isLocallyEmpty(abstract)) {
          await this.storage.removeByPath(item.path);
          completedWithoutEmbedding.push(item);
          this.failedFiles.delete(item.path);
          destructive = true;
          continue;
        }
        if (!this.shouldProcessFile(abstract)) {
          completedWithoutEmbedding.push(item);
          continue;
        }
        files.push(abstract);
        workClaims.set(item.path, item);
      }
      await this.workQueue.complete(completedWithoutEmbedding);
      if (files.length === 0) {
        if (destructive) await this.commitPortableDestructiveMutation();
        this.refreshLifecycle({ phase: "idle", currentPath: null });
        return;
      }

      this.refreshLifecycle({
        phase: "reconciling",
        total: files.length,
        completed: 0,
        currentPath: files[0]?.path ?? null,
        lastError: null,
      });
      this.emit("embeddings:processing-start", { scope: "queue", total: files.length, reason: "vault-change" });
      const sourceRevisions = this.buildSourceRevisions(files, workClaims);
      const result = await this.processor.processFiles(files, this.app, (progress) => {
        this.refreshLifecycle({
          phase: "reconciling",
          total: progress.total,
          completed: progress.current,
          currentPath: progress.currentFile ?? null,
        });
      }, { sourceRevisions });
      await this.recordFailures(result.failedPaths, workClaims, result.failedDetails, result.fatalError);
      const completedPaths = new Set(result.completedPaths);
      await this.workQueue.complete(
        [...completedPaths]
          .map((path) => workClaims.get(path))
          .filter((claim): claim is SemanticWorkItem => Boolean(claim)),
      );
      for (const path of completedPaths) this.failedFiles.delete(path);
      const completedCleanly = !result.fatalError
        && !result.cancelled
        && result.failed === 0
        && result.completedPaths.length === files.length;
      const committed = completedCleanly
        ? await this.commitSearchNamespaceIfComplete()
        : false;
      const pruned = committed ? await this.pruneInactiveManagedNamespaces() : 0;
      if (destructive || result.failed > 0 || pruned > 0) {
        await this.commitPortableDestructiveMutation();
      } else if (completedPaths.size > 0) {
        this.markPortableIndexChanged();
      }
      const firstFailure = result.failedDetails?.[result.failedPaths[0] ?? ""];
      this.refreshLifecycle({
        phase: result.fatalError || result.failed > 0
          ? "error"
          : this.processingSuspended
            ? "paused"
            : "idle",
        currentPath: null,
        lastError: result.fatalError
          ? { code: result.fatalError.code, message: result.fatalError.message }
          : firstFailure
            ? { code: firstFailure.code, message: firstFailure.message }
            : null,
      });
      this.emit("embeddings:processing-complete", {
        scope: "queue",
        processed: result.completed,
        failed: result.failed,
        status: result.fatalError
          ? "error"
          : result.cancelled
            ? "aborted"
            : result.failed > 0
              ? "partial"
              : "success",
      });
    });
    this.scheduleQueuedWork();
  }

  private async recordFailures(
    paths: string[],
    workClaims: ReadonlyMap<string, SemanticWorkItem>,
    details: Record<string, { code: string; message: string; status?: number }> | undefined,
    fatalError: ManagedEmbeddingsError | null,
  ): Promise<void> {
    const failedAt = Date.now();
    for (const path of paths) {
      const detail = details?.[path];
      const error = {
        code: detail?.code || fatalError?.code || "invalid_response",
        message: detail?.message || fatalError?.message || "Managed embeddings failed.",
      };
      const claim = workClaims.get(path);
      if (!claim) continue;
      const recorded = await this.workQueue.fail(claim, {
        ...error,
        ...(typeof detail?.status === "number" ? { status: detail.status } : {}),
      }, failedAt);
      if (!recorded) continue;
      this.failedFiles.set(path, {
        path,
        error,
        failedAt,
      });
    }
  }

  private async captureWorkClaims(
    files: Iterable<TFile>,
    reason: SemanticWorkReason,
  ): Promise<Map<string, SemanticWorkItem>> {
    const claims = new Map<string, SemanticWorkItem>();
    for (const file of files) {
      const sourceMtime = this.sourceMtime(file);
      const existing = this.workQueue.get(file.path);
      if (existing && !existing.failure && existing.sourceMtime === sourceMtime) {
        claims.set(file.path, existing);
        continue;
      }
      const claim = await this.workQueue.enqueueImmediate(file.path, reason, sourceMtime);
      if (claim) claims.set(file.path, claim);
    }
    return claims;
  }

  private buildSourceRevisions(
    files: Iterable<TFile>,
    claims: ReadonlyMap<string, SemanticWorkItem>,
  ): ReadonlyMap<TFile, EmbeddingSourceRevision> {
    const revisions = new Map<TFile, EmbeddingSourceRevision>();
    for (const file of files) {
      const claim = claims.get(file.path);
      if (!claim) continue;
      revisions.set(file, {
        path: claim.path,
        basename: file.basename,
        mtime: claim.sourceMtime ?? Date.now(),
      });
    }
    return revisions;
  }

  private sourceMtime(file: TFile): number | null {
    return typeof file.stat?.mtime === "number" && Number.isFinite(file.stat.mtime)
      ? file.stat.mtime
      : null;
  }

  private getIndexingNamespace(): string | null {
    if (this.gateway.activeGeneration?.indexNamespace) return this.gateway.activeGeneration.indexNamespace;
    if (this.searchNamespace && isManagedNamespace(this.searchNamespace)) return this.searchNamespace;
    const inferred = typeof this.storage.peekCurrentManagedNamespace === "function"
      ? this.storage.peekCurrentManagedNamespace()
      : null;
    return inferred && isManagedNamespace(inferred) ? inferred : null;
  }

  private getSearchNamespace(): string | null {
    return this.searchNamespace && isManagedNamespace(this.searchNamespace)
      ? this.searchNamespace
      : null;
  }

  private async hydrateManagedIdentityFromStorage(): Promise<void> {
    const inferred = this.storage.peekCurrentManagedNamespace();
    const listNamespaces = (this.storage as EmbeddingsStorage & {
      listManagedRootNamespaces?: EmbeddingsStorage["listManagedRootNamespaces"];
    }).listManagedRootNamespaces;
    const available = typeof listNamespaces === "function"
      ? listNamespaces.call(this.storage).filter(isManagedNamespace)
      : inferred && isManagedNamespace(inferred)
        ? [inferred]
        : [];
    const candidates = [inferred, ...available]
      .filter((namespace): namespace is string => Boolean(namespace && isManagedNamespace(namespace)))
      .filter((namespace, index, all) => all.indexOf(namespace) === index);

    const committed = await this.readCommittedNamespace();
    let searchNamespace = committed && candidates.includes(committed)
      ? committed
      : null;
    if (!searchNamespace) {
      searchNamespace = candidates.find((namespace) => this.namespaceCoversEligibleCorpus(namespace)) ?? null;
      if (searchNamespace) await this.writeCommittedNamespace(searchNamespace);
    }
    this.searchNamespace = searchNamespace;

    // The indexing generation may be partial; it is never queryable until the
    // durable commit above exists (or full corpus coverage was revalidated).
    const namespace = inferred && isManagedNamespace(inferred)
      ? inferred
      : searchNamespace ?? candidates[0] ?? null;
    if (!namespace) return;
    const dimension = parseNamespaceDimension(namespace);
    if (!dimension) return;
    this.gateway.expectedDimension = dimension;
    this.gateway.activeGeneration = {
      id: MANAGED_EMBEDDING_GENERATION,
      indexSchemaVersion: MANAGED_EMBEDDING_INDEX_SCHEMA_VERSION,
      indexNamespace: namespace,
      dimensions: dimension,
      limits: MANAGED_EMBEDDING_LIMITS,
    };
  }

  private namespaceCoversEligibleCorpus(namespace: string): boolean {
    const files = this.eligibleFiles().filter((file) => !this.isLocallyEmpty(file));
    return files.length > 0 && files.every((file) => this.isFileCoveredByNamespace(file, namespace));
  }

  private async readCommittedNamespace(): Promise<string | null> {
    const readState = (this.storage as EmbeddingsStorage & {
      readState?: EmbeddingsStorage["readState"];
    }).readState;
    if (typeof readState !== "function") return null;
    const stored = await readState.call(this.storage, COMMITTED_NAMESPACE_STATE_KEY) as CommittedNamespaceState | null;
    return stored?.version === 1 && isManagedNamespace(stored.namespace)
      ? stored.namespace
      : null;
  }

  private async writeCommittedNamespace(namespace: string): Promise<void> {
    const writeState = (this.storage as EmbeddingsStorage & {
      writeState?: EmbeddingsStorage["writeState"];
    }).writeState;
    if (typeof writeState !== "function") return;
    const state: CommittedNamespaceState = {
      version: 1,
      namespace,
      committedAt: Date.now(),
    };
    await writeState.call(this.storage, COMMITTED_NAMESPACE_STATE_KEY, state);
  }

  private async deleteCommittedNamespace(): Promise<void> {
    const deleteState = (this.storage as EmbeddingsStorage & {
      deleteState?: EmbeddingsStorage["deleteState"];
    }).deleteState;
    if (typeof deleteState === "function") {
      await deleteState.call(this.storage, COMMITTED_NAMESPACE_STATE_KEY);
    }
  }

  private shouldProcessFile(file: TFile): boolean {
    return this.evaluateFileProcessingState(file).needsProcessing;
  }

  private evaluateFileProcessingState(file: TFile): FileState {
    if (this.isFileExcluded(file)) return { needsProcessing: false, reason: "excluded" };
    if (!file.stat || typeof file.stat.mtime !== "number") {
      return { needsProcessing: true, reason: "metadata-missing", lastEmbedded: null };
    }
    if (this.isLocallyEmpty(file)) {
      return { needsProcessing: false, reason: "empty", lastEmbedded: null };
    }
    const localEmptyMarker = this.storage.getVectorSync(localEmptyEmbeddingMarkerId(file.path));
    if (isCurrentLocalEmptyEmbeddingMarker(localEmptyMarker, file)) {
      return {
        needsProcessing: false,
        reason: "empty",
        lastEmbedded: localEmptyMarker?.metadata.mtime ?? null,
        existingNamespace: localEmptyMarker?.metadata.namespace,
      };
    }
    const namespace = this.getIndexingNamespace();
    if (!namespace) {
      return {
        needsProcessing: true,
        reason: "missing",
        lastEmbedded: null,
      };
    }
    const existing = this.storage.getVectorSync(buildVectorId(namespace, file.path, 0));
    if (!existing) {
      return {
        needsProcessing: true,
        reason: "missing",
        lastEmbedded: null,
      };
    }
    if (
      !isManagedNamespace(existing.metadata.namespace)
      || existing.metadata.generation !== MANAGED_EMBEDDING_GENERATION
    ) {
      return {
        needsProcessing: true,
        reason: "schema-mismatch",
        lastEmbedded: existing.metadata.mtime ?? null,
        existingNamespace: existing.metadata.namespace,
      };
    }
    if (existing.metadata.complete !== true) {
      return {
        needsProcessing: true,
        reason: "incomplete",
        lastEmbedded: existing.metadata.mtime ?? null,
        existingNamespace: existing.metadata.namespace,
      };
    }
    if (existing.metadata.mtime >= file.stat.mtime) {
      return {
        needsProcessing: false,
        reason: "up-to-date",
        lastEmbedded: existing.metadata.mtime,
        existingNamespace: existing.metadata.namespace,
      };
    }
    return {
      needsProcessing: true,
      reason: "modified",
      lastEmbedded: existing.metadata.mtime ?? null,
      existingNamespace: existing.metadata.namespace,
    };
  }

  private eligibleFiles(): TFile[] {
    const cached = this.plugin.vaultFileCache?.getMarkdownFiles();
    const files = Array.isArray(cached) ? cached : this.app.vault.getMarkdownFiles();
    return files.filter((file): file is TFile => file instanceof TFile && !this.isFileExcluded(file));
  }

  private isFileExcluded(file: TFile): boolean {
    return this.isPathExcluded(file.path);
  }

  private isLocallyEmpty(file: TFile): boolean {
    return typeof file.stat?.size === "number" && file.stat.size <= 1;
  }

  private isPathExcluded(path: string): boolean {
    const normalizedPath = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedPath) return false;
    for (const folder of this.config.exclusions.folders) {
      const prefix = String(folder || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/?$/, "/");
      if (prefix && normalizedPath.startsWith(prefix)) return true;
    }
    const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
    for (const pattern of this.config.exclusions.patterns) {
      if (this.matchesGlob(pattern.includes("/") ? normalizedPath : basename, pattern)) return true;
    }
    if (this.config.exclusions.ignoreChatHistory) {
      const chatDirectories = [this.plugin.settings.chatsDirectory, this.plugin.settings.savedChatsDirectory]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.replace(/^\/+/, "").replace(/\/?$/, "/").toLowerCase());
      const lower = normalizedPath.toLowerCase();
      if (chatDirectories.some((directory) => lower.startsWith(directory))) return true;
      if (lower.includes("systemsculpt") && (lower.includes("/saved chats/") || lower.includes("/chats/"))) return true;
    }
    if (this.config.exclusions.respectObsidianExclusions !== false) {
      const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
      const filters = vault.getConfig?.("userIgnoreFilters");
      if (Array.isArray(filters) && filters.some((filter) => typeof filter === "string" && normalizedPath.includes(filter))) {
        return true;
      }
    }
    return false;
  }

  private matchesGlob(target: string, pattern: string): boolean {
    if (!pattern) return false;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(`^${escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`, "i").test(target);
    } catch {
      return false;
    }
  }

  private async cleanupExcludedEmbeddings(): Promise<void> {
    await this.awaitReady();
    await this.processingMutex.runExclusive(async () => {
      let changed = false;
      for (const path of this.storage.getDistinctPaths()) {
        if (this.isPathExcluded(path)) {
          await this.storage.removeByPath(path);
          await this.workQueue.remove(path);
          this.failedFiles.delete(path);
          changed = true;
        }
      }
      if (changed) await this.commitPortableDestructiveMutation();
      this.refreshLifecycle();
    });
  }

  private async pruneInactiveManagedNamespaces(): Promise<number> {
    const namespace = this.getSearchNamespace();
    if (!namespace) return 0;
    const prune = (this.storage as EmbeddingsStorage & {
      removeNamespacesExcept?: EmbeddingsStorage["removeNamespacesExcept"];
    }).removeNamespacesExcept;
    return typeof prune === "function"
      ? prune.call(this.storage, MANAGED_EMBEDDING_FAMILY_PREFIX, namespace)
      : 0;
  }

  private collectSearchableRootPaths(vectors: EmbeddingVector[]): Set<string> {
    const paths = new Set<string>();
    for (const vector of vectors) {
      if (vector.chunkId !== 0 || vector.metadata.isEmpty === true || vector.metadata.complete === false) continue;
      if (this.getFileIndexSnapshot(vector.path).ready) paths.add(vector.path);
    }
    return paths;
  }

  private async searchIndexedNamespace(
    namespace: string,
    queries: Float32Array[],
    limit: number,
    signal?: AbortSignal,
    excludedPath?: string,
  ): Promise<SearchResult[][]> {
    const storage = this.storage as EmbeddingsStorage & {
      scanVectorsByNamespace?: EmbeddingsStorage["scanVectorsByNamespace"];
    };
    const scan = storage.scanVectorsByNamespace;
    if (typeof scan !== "function") {
      const vectors = await this.storage.getVectorsByNamespace(namespace);
      if (signal?.aborted) return queries.map(() => []);
      const eligiblePaths = this.collectSearchableRootPaths(vectors);
      const candidates = vectors.filter((vector) => (
        vector.path !== excludedPath
        && vector.metadata.isEmpty !== true
        && eligiblePaths.has(vector.path)
        && !this.isPathExcluded(vector.path)
      ));
      const sets: SearchResult[][] = [];
      for (const query of queries) {
        if (signal?.aborted) return queries.map(() => []);
        sets.push(await this.search.findSimilarAsync(query, candidates, limit, { signal }));
      }
      return sets;
    }

    const eligiblePaths = new Set(
      this.storage.getDistinctPaths().filter((path) => (
        path !== excludedPath && this.getFileIndexSnapshot(path).ready
      )),
    );
    const sets = queries.map(() => [] as SearchResult[]);
    await scan.call(this.storage, namespace, (batch: EmbeddingVector[]) => {
      if (signal?.aborted) return;
      const candidates = batch.filter((vector) => (
        vector.metadata.isEmpty !== true
        && eligiblePaths.has(vector.path)
        && !this.isPathExcluded(vector.path)
      ));
      queries.forEach((query, index) => {
        const additions = this.search.findSimilar(query, candidates, limit);
        sets[index] = [...sets[index], ...additions]
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
      });
    }, { batchSize: 250, signal });
    return signal?.aborted ? queries.map(() => []) : sets;
  }

  private selectQueryVectors(vectors: EmbeddingVector[]): EmbeddingVector[] {
    const selected: EmbeddingVector[] = [];
    const ordered = [...vectors].sort((left, right) => {
      if (left.chunkId === 0) return -1;
      if (right.chunkId === 0) return 1;
      return (right.metadata.chunkLength ?? 0) - (left.metadata.chunkLength ?? 0);
    });
    for (const vector of ordered) {
      if (!selected.some((entry) => entry.id === vector.id)) selected.push(vector);
      if (selected.length === 3) break;
    }
    return selected;
  }

  private mergeChunkResults(resultSets: SearchResult[][], limit: number, excludedPath?: string): SearchResult[] {
    const combined = new Map<string, { result: SearchResult; reciprocalRank: number }>();
    for (const results of resultSets) {
      results.forEach((result, rank) => {
        if (result.path === excludedPath) return;
        const existing = combined.get(result.path);
        const reciprocalRank = 1 / (61 + rank);
        if (!existing) {
          combined.set(result.path, { result, reciprocalRank });
        } else {
          existing.reciprocalRank += reciprocalRank;
          if (result.score > existing.result.score) existing.result = result;
        }
      });
    }
    const maxRank = Math.max(1 / 61, resultSets.length / 61);
    return [...combined.values()]
      .map(({ result, reciprocalRank }) => ({
        ...result,
        score: Math.min(1, 0.65 * result.score + 0.35 * Math.min(1, reciprocalRank / maxRank)),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, limit));
  }

  private applyLexicalSignals(query: string, results: SearchResult[]): SearchResult[] {
    const normalized = query.toLowerCase().trim();
    const tokens = [...new Set(normalized.split(/\s+/).map((token) => token.replace(/[^a-z0-9]/gi, "")).filter((token) => token.length > 1))];
    if (tokens.length === 0) return results;
    return results.map((result) => {
      const haystack = `${result.path} ${result.metadata.title} ${result.metadata.excerpt}`.toLowerCase();
      const lexicalScore = haystack.includes(normalized)
        ? 1
        : tokens.filter((token) => haystack.includes(token)).length / tokens.length;
      return {
        ...result,
        score: Math.min(1, 0.85 * result.score + 0.15 * lexicalScore),
        metadata: { ...result.metadata, lexicalScore },
      };
    }).sort((left, right) => right.score - left.score);
  }

  private hashQuery(query: string): string {
    let hash = 2166136261;
    for (let index = 0; index < query.length; index += 1) {
      hash ^= query.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  private rememberQuery(key: string, vector: Float32Array, namespace: string): void {
    if (this.queryCache.size >= 32) {
      const oldest = this.queryCache.keys().next().value;
      if (typeof oldest === "string") this.queryCache.delete(oldest);
    }
    this.queryCache.set(key, { vector, namespace, expiresAt: Date.now() + 60_000 });
  }

  private nextIdempotencyKey(scope: string): string {
    this.operationSequence = (this.operationSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `emb:${scope}:${Date.now().toString(36)}:${this.operationSequence.toString(36)}`;
  }

  private buildConfig(overrides?: Partial<EmbeddingsManagerConfig>): EmbeddingsManagerConfig {
    const exclusions = this.plugin.settings.embeddingsExclusions;
    return {
      exclusions: {
        folders: overrides?.exclusions?.folders ?? exclusions.folders ?? [],
        patterns: overrides?.exclusions?.patterns ?? exclusions.patterns ?? [],
        ignoreChatHistory: overrides?.exclusions?.ignoreChatHistory ?? exclusions.ignoreChatHistory ?? true,
        respectObsidianExclusions:
          overrides?.exclusions?.respectObsidianExclusions ?? exclusions.respectObsidianExclusions ?? true,
      },
    };
  }

  private async migrateToManagedNamespaceContract(): Promise<void> {
    const version = 7;
    if ((this.plugin.settings.embeddingsVectorFormatVersion || 0) >= version) return;

    const vectors = await this.storage.getAllVectors();
    const legacyIds = vectors
      .filter((vector) => (
        !isLocalEmptyEmbeddingMarker(vector)
        && (
          !isManagedNamespace(vector.metadata.namespace)
          || vector.metadata.generation !== MANAGED_EMBEDDING_GENERATION
        )
      ))
      .map((vector) => vector.id);
    if (legacyIds.length > 0) {
      await this.storage.removeIds(legacyIds);
      await this.commitPortableDestructiveMutation();
    }

    await this.plugin.getSettingsManager().updateSettings({ embeddingsVectorFormatVersion: version });
  }

  private isPortableIndexEnabled(): boolean {
    return this.plugin.settings.embeddingsPortableIndex !== false;
  }

  private getPortableIndexFile(): EmbeddingsIndexFile | null {
    if (!this.isPortableIndexEnabled() || !this.app.vault.adapter) return null;
    this.portableIndexFile ??= new EmbeddingsIndexFile(this.app.vault.adapter);
    return this.portableIndexFile;
  }

  private async restorePortableIndexIfEmpty(): Promise<void> {
    const file = this.getPortableIndexFile();
    if (!file) return;
    try { await restoreEmbeddingsIndexIfEmpty({ store: this.storage, file }); } catch { /* best effort */ }
  }

  private getPortableCheckpoint(): PortableCheckpointCoordinator | null {
    const file = this.getPortableIndexFile();
    if (!file) return null;
    this.portableCheckpoint ??= new PortableCheckpointCoordinator({ store: this.storage, file });
    return this.portableCheckpoint;
  }

  private markPortableIndexChanged(): void {
    this.getPortableCheckpoint()?.markChanged();
  }

  private async flushPortableIndex(): Promise<void> {
    try { await this.getPortableCheckpoint()?.flush(); } catch { /* local index remains authoritative */ }
  }

  private async commitPortableDestructiveMutation(): Promise<void> {
    try {
      await this.getPortableCheckpoint()?.commitDestructiveMutation();
    } catch (error) {
      this.refreshLifecycle({
        phase: "error",
        lastError: {
          code: "checkpoint_failed",
          message: "The portable semantic index could not be updated.",
        },
      });
      throw error;
    }
  }

  private hydrateFailuresFromWorkQueue(): void {
    this.failedFiles.clear();
    for (const item of this.workQueue.snapshot()) {
      if (!item.failure) continue;
      this.failedFiles.set(item.path, {
        path: item.path,
        error: { code: item.failure.code, message: item.failure.message },
        failedAt: item.failure.failedAt,
      });
    }
  }

  private generationSnapshotForNamespace(namespace: string): SemanticIndexSnapshot["generation"] {
    const dimensions = parseNamespaceDimension(namespace);
    if (!dimensions) return null;
    return {
      id: MANAGED_EMBEDDING_GENERATION,
      namespace,
      dimensions,
    };
  }

  private isFileReadyInNamespace(file: TFile, namespace: string): boolean {
    if (this.workQueue.get(file.path)) return false;
    const root = this.storage.getVectorSync(buildVectorId(namespace, file.path, 0));
    return Boolean(
      root
      && root.metadata.namespace === namespace
      && root.metadata.generation === MANAGED_EMBEDDING_GENERATION
      && root.metadata.complete === true
      && root.metadata.partial !== true
      && typeof root.metadata.mtime === "number"
      && root.metadata.mtime >= file.stat.mtime
    );
  }

  private isFileCoveredByNamespace(file: TFile, namespace: string): boolean {
    const emptyMarker = this.storage.getVectorSync(localEmptyEmbeddingMarkerId(file.path));
    return isCurrentLocalEmptyEmbeddingMarker(emptyMarker, file)
      || this.isFileReadyInNamespace(file, namespace);
  }

  /** Promote a generation only after every searchable note has a complete root record. */
  private async commitSearchNamespaceIfComplete(): Promise<boolean> {
    const namespace = this.gateway.activeGeneration?.indexNamespace;
    if (!namespace || !isManagedNamespace(namespace)) return false;
    const files = this.eligibleFiles().filter((file) => !this.isLocallyEmpty(file));
    if (files.length === 0 || !files.every((file) => this.isFileCoveredByNamespace(file, namespace))) {
      return false;
    }
    await this.writeCommittedNamespace(namespace);
    if (this.searchNamespace !== namespace) this.queryCache.clear();
    this.searchNamespace = namespace;
    return true;
  }

  private reportLifecycleFailure(error: unknown): void {
    const managed = error instanceof ManagedEmbeddingsError ? error : null;
    if (managed?.code === "request_cancelled" || this.processingSuspended) return;
    this.refreshLifecycle({
      phase: "error",
      currentPath: null,
      lastError: {
        code: managed?.code ?? "temporarily_unavailable",
        message: managed?.message ?? "The semantic index could not connect to SystemSculpt.",
      },
    });
  }

  private currentGenerationSnapshot(): SemanticIndexSnapshot["generation"] {
    const generation = this.gateway.activeGeneration;
    if (!generation) return null;
    return {
      id: generation.id,
      namespace: generation.indexNamespace,
      dimensions: generation.dimensions,
    };
  }

  private refreshLifecycle(
    patch: Partial<Omit<SemanticIndexSnapshot, "updatedAt">> = {},
  ): void {
    const searchNamespace = this.getSearchNamespace();
    let total = 0;
    let completed = 0;
    let pending = this.workQueue.size;
    if (this.initialized) {
      const stats = this.getStats();
      total = stats.total;
      completed = stats.processed;
      pending = Math.max(stats.needsProcessing, this.workQueue.size);
    }
    this.lifecycle.update({
      ready: this.initialized,
      generation: searchNamespace
        ? this.generationSnapshotForNamespace(searchNamespace)
        : this.currentGenerationSnapshot(),
      total,
      completed,
      pending,
      failed: this.failedFiles.size,
      ...patch,
    });
  }

  private async setRebuildPending(pending: boolean): Promise<void> {
    if (this.plugin.settings.embeddingsRebuildPending === pending) return;
    try {
      await this.plugin.getSettingsManager().updateSettings({ embeddingsRebuildPending: pending });
    } catch {
      this.plugin.settings.embeddingsRebuildPending = pending;
    }
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    try { this.plugin.emitter?.emit(event, payload); } catch { /* observers are optional */ }
  }
}
