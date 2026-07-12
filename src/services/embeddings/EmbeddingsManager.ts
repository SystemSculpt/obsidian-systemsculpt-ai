import { App, EventRef, TFile } from "obsidian";
import { Mutex } from "async-mutex";
import SystemSculptPlugin from "../../main";
import type {
  EmbeddingVector,
  EmbeddingsManagerConfig,
  ProcessingProgress,
  SearchResult,
} from "./types";
import { ManagedEmbeddingsAdapter, ManagedEmbeddingsError } from "./providers/ManagedEmbeddingsAdapter";
import { EmbeddingsProcessor } from "./processing/EmbeddingsProcessor";
import { ContentPreprocessor } from "./processing/ContentPreprocessor";
import { VectorSearch } from "./search/VectorSearch";
import { EmbeddingsStorage } from "./storage/EmbeddingsStorage";
import { EmbeddingsIndexFile } from "./storage/EmbeddingsIndexFile";
import {
  restoreEmbeddingsIndexIfEmpty,
  writeEmbeddingsIndexSnapshot,
} from "./storage/EmbeddingsPortableIndex";
import {
  buildManagedNamespace,
  isManagedNamespace,
  MANAGED_EMBEDDING_NAMESPACE_PREFIX,
  parseNamespaceDimension,
} from "./utils/namespace";
import { buildVectorId } from "./utils/vectorId";
import { normalizeInPlace, toFloat32Array } from "./utils/vector";

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

type FileState = {
  needsProcessing: boolean;
  reason: PendingEmbeddingReason | "excluded" | "up-to-date";
  lastEmbedded?: number | null;
  existingNamespace?: string;
};

/**
 * Managed-only embeddings coordinator.
 *
 * Provider selection, endpoint/model configuration, client retries, cooldowns,
 * and entitlement decisions intentionally do not exist here. Admission and
 * transport ownership live in ManagedCapabilityClient.
 */
export class EmbeddingsManager {
  private readonly storage: EmbeddingsStorage;
  private readonly provider: ManagedEmbeddingsAdapter;
  private readonly processor: EmbeddingsProcessor;
  private readonly preprocessor = new ContentPreprocessor();
  private readonly search = new VectorSearch();
  private readonly processingMutex = new Mutex();
  private readonly failedFiles = new Map<string, FailedEmbeddingFile>();
  private readonly queryCache = new Map<string, { vector: Float32Array; expiresAt: number }>();
  private config: EmbeddingsManagerConfig;
  private initializationPromise: Promise<void> | null = null;
  private initialized = false;
  private processingSuspended = false;
  private automaticRunQueued = false;
  private operationSequence = 0;
  private fileWatchers: EventRef[] = [];
  private portableIndexFile: EmbeddingsIndexFile | null = null;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    config?: Partial<EmbeddingsManagerConfig>,
  ) {
    this.config = this.buildConfig(config);
    this.storage = new EmbeddingsStorage(
      EmbeddingsStorage.buildDbName(this.plugin.settings.vaultInstanceId || ""),
    );
    this.provider = new ManagedEmbeddingsAdapter(this.plugin.getManagedCapabilityClient());
    this.processor = new EmbeddingsProcessor(
      this.provider,
      this.storage,
      this.preprocessor,
      { batchSize: this.config.batchSize, maxConcurrency: this.config.maxConcurrency },
    );
  }

  async initialize(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeStorage();
    }
    await this.initializationPromise;
    if (
      this.plugin.settings.embeddingsEnabled
      && (this.config.autoProcess || this.plugin.settings.embeddingsRebuildPending === true)
    ) {
      this.requestAutomaticProcessing();
    }
  }

  private async initializeStorage(): Promise<void> {
    await this.storage.initialize();
    await this.restorePortableIndexIfEmpty();
    await this.storage.loadEmbeddings();
    await this.migrateToManagedNamespaceContract();
    this.hydrateManagedIdentityFromStorage();
    const repair = await this.storage.purgeCorruptedVectors();
    for (const path of repair.removedPaths) {
      this.failedFiles.set(path, {
        path,
        error: { code: "invalid_response", message: "Stored vector was invalid." },
        failedAt: Date.now(),
      });
    }
    this.setupFileWatchers();
    this.initialized = true;
  }

  async processVault(onProgress?: (progress: ProcessingProgress) => void): Promise<EmbeddingsRunResult> {
    await this.awaitReady();
    if (this.processingSuspended) {
      return { status: "aborted", processed: 0, message: "Embeddings processing is paused." };
    }
    if (this.processingMutex.isLocked()) {
      throw new Error("Embeddings processing is already in progress.");
    }

    return this.processingMutex.runExclusive(async () => {
      await this.setRebuildPending(true);
      const files = this.app.vault.getMarkdownFiles().filter((file) => this.shouldProcessFile(file));
      if (files.length === 0) {
        await this.setRebuildPending(false);
        return { status: "complete", processed: 0 };
      }

      this.emit("embeddings:processing-start", { scope: "vault", total: files.length, reason: "managed" });
      const result = await this.processor.processFiles(files, this.app, (progress) => {
        this.emit("embeddings:processing-progress", {
          scope: "vault",
          total: files.length,
          current: progress.current,
          batch: progress.batchProgress,
        });
        onProgress?.(progress);
      });
      this.recordFailures(result.failedPaths, result.failedDetails, result.fatalError);

      if (result.cancelled) {
        this.emit("embeddings:processing-complete", {
          scope: "vault",
          processed: result.completed,
          failed: result.failed,
          status: "aborted",
        });
        return {
          status: "aborted",
          processed: result.completed,
          message: "Embeddings processing was stopped locally.",
          partialSuccess: result.completed > 0,
        };
      }

      if (result.fatalError) {
        this.emit("embeddings:processing-complete", {
          scope: "vault",
          processed: result.completed,
          failed: result.failed,
          status: "error",
        });
        return {
          status: "aborted",
          processed: result.completed,
          failure: result.fatalError,
          message: result.fatalError.message,
          partialSuccess: result.completed > 0,
        };
      }

      for (const file of files) this.failedFiles.delete(file.path);
      await this.setRebuildPending(false);
      await this.writePortableIndexSnapshot();
      this.emit("embeddings:processing-complete", {
        scope: "vault",
        processed: result.completed,
        failed: result.failed,
        status: result.failed > 0 ? "partial" : "success",
      });
      return {
        status: "complete",
        processed: result.completed,
        partialSuccess: result.failed > 0,
      };
    });
  }

  async retryFailedFiles(): Promise<EmbeddingsRunResult> {
    this.failedFiles.clear();
    return this.processVault();
  }

  async searchSimilar(query: string, limit = 20, signal?: AbortSignal): Promise<SearchResult[]> {
    await this.awaitReady();
    const prepared = String(query || "").trim();
    if (!prepared || signal?.aborted) return [];

    const cacheKey = this.hashQuery(prepared);
    const cached = this.queryCache.get(cacheKey);
    let queryVector: Float32Array;
    if (cached && cached.expiresAt > Date.now()) {
      queryVector = cached.vector;
    } else {
      const vectors = await this.provider.generateEmbeddings([prepared], {
        inputType: "query",
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
      this.rememberQuery(cacheKey, queryVector);
    }

    const namespace = buildManagedNamespace(queryVector.length);
    const vectors = await this.storage.getVectorsByNamespace(namespace);
    const eligiblePaths = this.collectSearchableRootPaths(vectors);
    const candidates = vectors.filter((vector) => (
      vector.metadata.isEmpty !== true
      && eligiblePaths.has(vector.path)
      && !this.isPathExcluded(vector.path)
    ));
    if (signal?.aborted) return [];
    const rawResults = await this.search.findSimilarAsync(queryVector, candidates, Math.max(limit * 4, limit));
    if (signal?.aborted) return [];
    return this.applyLexicalSignals(prepared, this.mergeChunkResults([rawResults], limit));
  }

  async findSimilar(filePath: string, limit = 15): Promise<SearchResult[]> {
    await this.awaitReady();
    if (!filePath || this.isPathExcluded(filePath)) return [];
    const namespace = this.getActiveNamespace();
    if (!namespace) return [];

    const sourceVectors = (await this.storage.getVectorsByPath(filePath)).filter((vector) => (
      vector.metadata.namespace === namespace && vector.metadata.isEmpty !== true
    ));
    const queryVectors = this.selectQueryVectors(sourceVectors);
    if (queryVectors.length === 0) return [];

    const allVectors = await this.storage.getVectorsByNamespace(namespace);
    const eligiblePaths = this.collectSearchableRootPaths(allVectors);
    const candidates = allVectors.filter((vector) => (
      vector.path !== filePath
      && vector.metadata.isEmpty !== true
      && eligiblePaths.has(vector.path)
      && !this.isPathExcluded(vector.path)
    ));
    if (candidates.length === 0) return [];

    const sets: SearchResult[][] = [];
    for (const vector of queryVectors) {
      sets.push(await this.search.findSimilarAsync(vector.vector, candidates, Math.max(limit * 4, limit)));
    }
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

  isCurrentlyProcessing(): boolean {
    return this.processingMutex.isLocked();
  }

  suspendProcessing(): void {
    this.processingSuspended = true;
    this.processor.cancel();
  }

  resumeProcessing(): void {
    this.processingSuspended = false;
  }

  isSuspended(): boolean {
    return this.processingSuspended;
  }

  public syncFromSettings(): void {
    const previous = this.config;
    this.config = this.buildConfig();
    this.processor.setConfig({
      batchSize: this.config.batchSize,
      maxConcurrency: this.config.maxConcurrency,
    });
    if (JSON.stringify(previous.exclusions) !== JSON.stringify(this.config.exclusions)) {
      void this.cleanupExcludedEmbeddings().catch(() => undefined);
    }
    if (this.plugin.settings.embeddingsEnabled && this.config.autoProcess) {
      this.requestAutomaticProcessing();
    }
  }

  public hasAnyStoredVectors(): boolean {
    return this.storage.size() > 0;
  }

  public hasAnyEmbeddings(): boolean {
    const namespace = this.getActiveNamespace();
    if (!namespace) return false;
    return this.storage.getDistinctPaths().some((path) => {
      if (this.isPathExcluded(path)) return false;
      const root = this.storage.getVectorSync(buildVectorId(namespace, path, 0));
      return Boolean(root && root.metadata.isEmpty !== true && root.metadata.complete !== false);
    });
  }

  public hasVector(path: string): boolean {
    if (!path || this.isPathExcluded(path)) return false;
    const namespace = this.getActiveNamespace();
    if (!namespace) return false;
    const root = this.storage.getVectorSync(buildVectorId(namespace, path, 0));
    return Boolean(root && root.metadata.isEmpty !== true && root.metadata.complete !== false);
  }

  async clearAll(): Promise<void> {
    await this.awaitReady();
    this.processor.cancel();
    await this.processingMutex.runExclusive(async () => {
      await this.storage.clear();
      this.failedFiles.clear();
      this.queryCache.clear();
      await this.setRebuildPending(false);
      await this.writePortableIndexSnapshot();
    });
  }

  async resetDatabase(): Promise<void> {
    await this.storage.reset();
    this.initialized = false;
    this.initializationPromise = null;
    await this.initialize();
  }

  async forceRefreshCurrentNamespace(): Promise<void> {
    await this.awaitReady();
    this.suspendProcessing();
    try {
      await this.processingMutex.runExclusive(async () => {
        await this.storage.removeByNamespacePrefix(MANAGED_EMBEDDING_NAMESPACE_PREFIX);
      });
    } finally {
      this.resumeProcessing();
    }
    await this.processVault();
  }

  cleanup(): void {
    this.processor.cleanup();
    for (const ref of this.fileWatchers) {
      try { this.app.vault.offref(ref); } catch { /* Obsidian may already have detached it. */ }
    }
    this.fileWatchers = [];
    this.queryCache.clear();
  }

  private requestAutomaticProcessing(): void {
    if (this.automaticRunQueued || this.processingSuspended || !this.initialized) return;
    this.automaticRunQueued = true;
    queueMicrotask(() => {
      this.automaticRunQueued = false;
      if (!this.plugin.settings.embeddingsEnabled || this.processingSuspended || this.processingMutex.isLocked()) return;
      void this.processVault().catch(() => undefined);
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
        void this.storage.renameByPath(oldPath, file.path, file.basename)
          .then(() => this.requestFileProcessing(file, "rename"))
          .catch(() => undefined);
      } else {
        void this.storage.renameByDirectory(oldPath, file.path).catch(() => undefined);
      }
    }));
    this.fileWatchers.push(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) {
        void this.storage.removeByPath(file.path).catch(() => undefined);
      } else {
        void this.storage.removeByDirectory(file.path).catch(() => undefined);
      }
    }));
  }

  private requestFileProcessing(file: TFile, reason: string): void {
    if (!this.plugin.settings.embeddingsEnabled || this.processingSuspended) return;
    if (!this.shouldProcessFile(file)) return;
    void this.processingMutex.runExclusive(async () => {
      if (!this.plugin.settings.embeddingsEnabled || this.processingSuspended || !this.shouldProcessFile(file)) return;
      this.emit("embeddings:processing-start", { scope: "file", path: file.path, reason });
      const result = await this.processor.processFiles([file], this.app);
      this.recordFailures(result.failedPaths, result.failedDetails, result.fatalError);
      if (!result.cancelled && !result.fatalError) {
        this.failedFiles.delete(file.path);
        await this.writePortableIndexSnapshot();
      }
      this.emit("embeddings:processing-complete", {
        scope: "file",
        path: file.path,
        processed: result.completed,
        failed: result.failed,
        status: result.cancelled ? "aborted" : result.fatalError ? "error" : "success",
      });
    }).catch(() => undefined);
  }

  private recordFailures(
    paths: string[],
    details: Record<string, { code: string; message: string }> | undefined,
    fatalError: ManagedEmbeddingsError | null,
  ): void {
    const failedAt = Date.now();
    for (const path of paths) {
      const detail = details?.[path];
      this.failedFiles.set(path, {
        path,
        error: {
          code: detail?.code || fatalError?.code || "invalid_response",
          message: detail?.message || fatalError?.message || "Managed embeddings failed.",
        },
        failedAt,
      });
    }
  }

  private getActiveNamespace(): string | null {
    if (this.provider.activeNamespace) return this.provider.activeNamespace;
    const inferred = this.storage.peekBestNamespaceForPrefix(MANAGED_EMBEDDING_NAMESPACE_PREFIX);
    return inferred && isManagedNamespace(inferred) ? inferred : null;
  }

  private hydrateManagedIdentityFromStorage(): void {
    const namespace = this.storage.peekBestNamespaceForPrefix(MANAGED_EMBEDDING_NAMESPACE_PREFIX);
    if (!namespace || !isManagedNamespace(namespace)) return;
    const dimension = parseNamespaceDimension(namespace);
    if (!dimension) return;
    this.provider.expectedDimension = dimension;
    this.provider.activeNamespace = namespace as `systemsculpt:managed:v1:${number}`;
  }

  private shouldProcessFile(file: TFile): boolean {
    return this.evaluateFileProcessingState(file).needsProcessing;
  }

  private evaluateFileProcessingState(file: TFile): FileState {
    if (this.isFileExcluded(file)) return { needsProcessing: false, reason: "excluded" };
    if (!file.stat || typeof file.stat.mtime !== "number") {
      return { needsProcessing: true, reason: "metadata-missing", lastEmbedded: null };
    }
    const namespace = this.getActiveNamespace();
    if (!namespace) {
      return {
        needsProcessing: true,
        reason: file.stat.size <= 1 ? "empty" : "missing",
        lastEmbedded: null,
      };
    }
    const existing = this.storage.getVectorSync(buildVectorId(namespace, file.path, 0));
    if (!existing) {
      return {
        needsProcessing: true,
        reason: file.stat.size <= 1 ? "empty" : "missing",
        lastEmbedded: null,
      };
    }
    if (!isManagedNamespace(existing.metadata.namespace)) {
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
    for (const path of this.storage.getDistinctPaths()) {
      if (this.isPathExcluded(path)) {
        await this.storage.removeByPath(path);
        this.failedFiles.delete(path);
      }
    }
  }

  private collectSearchableRootPaths(vectors: EmbeddingVector[]): Set<string> {
    const paths = new Set<string>();
    for (const vector of vectors) {
      if (vector.chunkId !== 0 || vector.metadata.isEmpty === true || vector.metadata.complete === false) continue;
      paths.add(vector.path);
    }
    return paths;
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

  private rememberQuery(key: string, vector: Float32Array): void {
    if (this.queryCache.size >= 32) {
      const oldest = this.queryCache.keys().next().value;
      if (typeof oldest === "string") this.queryCache.delete(oldest);
    }
    this.queryCache.set(key, { vector, expiresAt: Date.now() + 60_000 });
  }

  private nextIdempotencyKey(scope: string): string {
    this.operationSequence = (this.operationSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `emb:${scope}:${Date.now().toString(36)}:${this.operationSequence.toString(36)}`;
  }

  private buildConfig(overrides?: Partial<EmbeddingsManagerConfig>): EmbeddingsManagerConfig {
    const exclusions = this.plugin.settings.embeddingsExclusions;
    return {
      batchSize: overrides?.batchSize ?? 20,
      maxConcurrency: overrides?.maxConcurrency ?? 1,
      autoProcess: overrides?.autoProcess ?? this.plugin.settings.embeddingsAutoProcess,
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
    const vectors = await this.storage.getAllVectors();
    const legacyIds = vectors.filter((vector) => !isManagedNamespace(vector.metadata.namespace)).map((vector) => vector.id);
    if (legacyIds.length > 0) await this.storage.removeIds(legacyIds);

    const version = 5;
    if ((this.plugin.settings.embeddingsVectorFormatVersion || 0) < version) {
      await this.plugin.getSettingsManager().updateSettings({ embeddingsVectorFormatVersion: version });
    }
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

  private async writePortableIndexSnapshot(): Promise<void> {
    const file = this.getPortableIndexFile();
    if (!file) return;
    try { await writeEmbeddingsIndexSnapshot({ store: this.storage, file }); } catch { /* best effort */ }
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
