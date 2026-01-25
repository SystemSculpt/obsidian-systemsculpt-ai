/**
 * EmbeddingsManager - Core embeddings orchestrator
 * 
 * Manages the embeddings lifecycle:
 * - Provider abstraction for different embedding sources
 * - Efficient parallel processing with worker threads
 * - Smart caching and deduplication
 * - Automatic file watching and updates
 */

import { App, TFile, Notice } from 'obsidian';
import SystemSculptPlugin from '../../main';
import { 
  EmbeddingVector, 
  SearchResult, 
  ProcessingProgress, 
  EmbeddingsProvider,
  EmbeddingsManagerConfig 
} from './types';
import { EmbeddingsStorage } from './storage/EmbeddingsStorage';
import { SystemSculptProvider } from './providers/SystemSculptProvider';
import { CustomProvider } from './providers/CustomProvider';
import { EmbeddingsProcessor } from './processing/EmbeddingsProcessor';
import { ContentPreprocessor } from './processing/ContentPreprocessor';
import { VectorSearch } from './search/VectorSearch';
import { buildNamespace, buildNamespacePrefix, namespaceMatchesCurrentVersion, parseNamespace, parseNamespaceDimension } from './utils/namespace';
import { buildVectorId } from "./utils/vectorId";
import { normalizeInPlace, toFloat32Array } from './utils/vector';
import { SystemSculptEnvironment } from '../api/SystemSculptEnvironment';
import { EmbeddingsHealthMonitor, EmbeddingsHealthSnapshot } from './EmbeddingsHealthMonitor';
import { EmbeddingsProviderError, isEmbeddingsProviderError } from './providers/ProviderError';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSION, EMBEDDING_SCHEMA_VERSION } from '../../constants/embeddings';
import type { SystemSculptSettings } from '../../types';
import { Mutex } from 'async-mutex';

export type EmbeddingsRunStatus = 'complete' | 'aborted' | 'cooldown';

export interface EmbeddingsRunResult {
  status: EmbeddingsRunStatus;
  processed: number;
  failure?: EmbeddingsProviderError;
  retryAt?: number;
  message?: string;
  partialSuccess?: boolean;
}

export type PendingEmbeddingReason =
  | 'missing'
  | 'modified'
  | 'schema-mismatch'
  | 'metadata-missing'
  | 'incomplete'
  | 'empty'
  | 'failed';

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

export interface FailedEmbeddingFile {
  path: string;
  error: { code: string; message: string };
  failedAt: number;
  retryable: boolean;
}

export class EmbeddingsManager {
  private storage: EmbeddingsStorage;
  private provider: EmbeddingsProvider;
  private processor: EmbeddingsProcessor;
  private preprocessor: ContentPreprocessor;
  private search: VectorSearch;
  private bestNamespaceByPrefix: Map<string, string> = new Map();
  private fileWatchers: any[] = [];
  private readonly processingMutex = new Mutex();
  private processingSuspended = false;
  private config: EmbeddingsManagerConfig;
  private initializationPromise: Promise<void> | null = null;
  private initialized: boolean = false;
  private perPathTimers: Map<string, any> = new Map();
  private inFlightPaths: Set<string> = new Set();
  private modelMigrationCooldownUntil: number = 0;
  private queryCache: Map<string, { vector: Float32Array; expiresAt: number }> = new Map();
  private queryGenerationInFlight: Map<string, Promise<Float32Array>> = new Map();
  private readonly QUERY_CACHE_TTL_MS = 60 * 1000; // 60 seconds
  private readonly QUERY_CACHE_MAX = 64;
  private readonly MAX_FILE_QUERY_QUERIES = 3;
  private healthMonitor: EmbeddingsHealthMonitor;
  private vaultCooldownUntil: number = 0;
  private scheduledVaultRun: ReturnType<typeof setTimeout> | null = null;
  private scheduledVaultRunAt: number | null = null;
  private queryCooldownUntil: number = 0;
  private lastDimensionNoticeAt: number = 0;
  private failedFiles: Map<string, FailedEmbeddingFile> = new Map();

  constructor(
    private app: App,
    private plugin: SystemSculptPlugin,
    config?: Partial<EmbeddingsManagerConfig>
  ) {
    this.config = this.buildConfig(config);
    this.healthMonitor = new EmbeddingsHealthMonitor(plugin);
    this.storage = new EmbeddingsStorage(EmbeddingsStorage.buildDbName(this.plugin.settings.vaultInstanceId || ""));
    this.preprocessor = new ContentPreprocessor();
    this.search = new VectorSearch();
    this.provider = this.createProvider();
    this.processor = new EmbeddingsProcessor(
      this.provider,
      this.storage,
      this.preprocessor,
      {
        batchSize: this.config.batchSize,
        maxConcurrency: this.config.maxConcurrency,
        rateLimitPerMinute: this.plugin.settings.embeddingsRateLimitPerMinute
      }
    );
  }

  /**
   * Initialize the embeddings system
   */
  async initialize(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      try {
        await this.storage.initialize();
        await this.migrateEmbeddingsStorageIfNeeded();
        await this.storage.loadEmbeddings();

        const repairSummary = await this.storage.purgeCorruptedVectors();
        if (repairSummary.removedCount > 0 || repairSummary.correctedCount > 0) {
          try {
            const details: string[] = [];
            if (repairSummary.removedCount > 0) details.push(`${repairSummary.removedCount} removed`);
            if (repairSummary.correctedCount > 0) details.push(`${repairSummary.correctedCount} corrected`);
            new Notice(`SystemSculpt repaired embeddings (${details.join(', ')}).`);
          } catch {}
          if (repairSummary.removedPaths.length > 0) {
            this.queueReprocessForPaths(repairSummary.removedPaths);
          }
        }

        if (this.plugin.settings.embeddingsEnabled && this.config.autoProcess) {
          this.scheduleAutoProcessing();
        }

        this.setupFileWatchers();
        this.initialized = true;
      } catch (error) {
        // Re-throw to allow callers to handle, but keep the promise for subsequent awaits
        throw error;
      }
    })();
    return this.initializationPromise;
  }

  private clearNamespaceLookupCache(): void {
    this.bestNamespaceByPrefix.clear();
  }

  private resolveLookupNamespace(): { model: string; prefix: string; namespace: string | null } {
    const model = (this.provider as any).model || 'unknown';
    const prefix = buildNamespacePrefix(this.provider.id, model);

    const expectedDim = this.getExpectedDimensionHint();
    if (typeof expectedDim === 'number' && expectedDim > 0) {
      return { model, prefix, namespace: buildNamespace(this.provider.id, model, expectedDim) };
    }

    const cached = this.bestNamespaceByPrefix.get(prefix);
    if (cached) return { model, prefix, namespace: cached };

    const inferred = this.storage.peekBestNamespaceForPrefix(prefix);
    if (inferred) this.bestNamespaceByPrefix.set(prefix, inferred);
    return { model, prefix, namespace: inferred || null };
  }

  private async migrateEmbeddingsStorageIfNeeded(): Promise<void> {
    const settings = this.plugin.settings as any as SystemSculptSettings;

    const CURRENT_FORMAT_VERSION = 4;

    if ((settings.embeddingsVectorFormatVersion || 0) >= CURRENT_FORMAT_VERSION) {
      return;
    }

    const eligiblePaths = new Set<string>();
    const files = this.plugin.vaultFileCache ? this.plugin.vaultFileCache.getMarkdownFiles() : this.app.vault.getMarkdownFiles();
    for (const file of files as any[]) {
      if (file instanceof TFile && !this.isFileExcluded(file)) {
        eligiblePaths.add(file.path);
      }
    }

    // Only import from the legacy global DB when this vault-scoped DB is empty.
    // This avoids overwriting newer per-vault vectors with stale legacy data.
    let shouldAttemptLegacyImport = false;
    try {
      const currentCount = await this.storage.countVectors();
      shouldAttemptLegacyImport = currentCount === 0;
    } catch {
      // If we can't reliably count, err on the side of not overwriting existing data.
      shouldAttemptLegacyImport = false;
    }

    if (shouldAttemptLegacyImport) {
      let imported = 0;
      try {
        const result = await this.storage.importFromLegacyGlobalDb(eligiblePaths);
        imported = result.imported;
        if (imported > 0) {
          try {
            new Notice(`SystemSculpt imported ${imported} embeddings from legacy storage.`, 5000);
          } catch {}
        }
      } catch {
        // Import is best-effort; failure shouldn't block embeddings from functioning.
      }
    }

    const summary = await this.storage.upgradeVectorsToCanonicalFormat();
    if (summary.updated > 0 || summary.removed > 0) {
      try {
        const parts: string[] = [];
        if (summary.updated > 0) parts.push(`${summary.updated} updated`);
        if (summary.removed > 0) parts.push(`${summary.removed} removed`);
        new Notice(`SystemSculpt optimized embeddings storage (${parts.join(", ")}).`, 5000);
      } catch {}
    }

    try {
      await this.storage.backfillRootCompleteness();
    } catch {}

    try {
      await this.plugin.getSettingsManager().updateSettings({ embeddingsVectorFormatVersion: CURRENT_FORMAT_VERSION });
    } catch {}
  }

  /**
   * Process entire vault
   */
  async processVault(onProgress?: (progress: ProcessingProgress) => void): Promise<EmbeddingsRunResult> {
    await this.awaitReady();

    const now = Date.now();
    if (now < this.vaultCooldownUntil) {
      const message = this.buildFriendlyCooldownMessage(this.vaultCooldownUntil - now);
      return {
        status: 'cooldown',
        processed: 0,
        retryAt: this.vaultCooldownUntil,
        message,
      };
    }

    if (this.processingSuspended) {
      return {
        status: 'cooldown',
        processed: 0,
        retryAt: this.vaultCooldownUntil > now ? this.vaultCooldownUntil : undefined,
        message: 'Embeddings processing is currently paused.',
      };
    }

    if (!this.isProviderReady()) {
      throw new Error('Embeddings provider is not ready. Check your license/provider settings.');
    }

    if (this.processingMutex.isLocked()) {
      throw new Error('Processing already in progress');
    }

    return this.processingMutex.runExclusive(() => this.processVaultInternal({ trigger: 'manual', onProgress }));
  }

  private async processVaultInternal(options: {
    trigger: 'manual' | 'auto';
    onProgress?: (progress: ProcessingProgress) => void;
  }): Promise<EmbeddingsRunResult> {
    await this.awaitReady();

    const now = Date.now();
    if (now < this.vaultCooldownUntil) {
      const message = this.buildFriendlyCooldownMessage(this.vaultCooldownUntil - now);
      return {
        status: 'cooldown',
        processed: 0,
        retryAt: this.vaultCooldownUntil,
        message,
      };
    }

    if (this.processingSuspended) {
      return {
        status: 'cooldown',
        processed: 0,
        retryAt: this.vaultCooldownUntil > now ? this.vaultCooldownUntil : undefined,
        message: 'Embeddings processing is currently paused.',
      };
    }

    if (options.trigger === 'auto' && !this.isProviderReady()) {
      return { status: 'complete', processed: 0 };
    }

    let processedCount = 0;
    let failure: EmbeddingsProviderError | undefined;

    try {
      // Block processing if custom provider is selected but not fully configured
      if (this.config.provider.providerId === 'custom') {
        const endpoint = (this.config.provider.customEndpoint || '').trim();
        const model = (this.config.provider.customModel || this.config.provider.model || '').trim();
        if (!endpoint || !model) {
          throw new Error('Custom embeddings provider is not configured. Set API Endpoint and Model before processing.');
        }
      }

      const files = this.app.vault.getMarkdownFiles();
      const filesToProcess = files.filter(file => this.shouldProcessFile(file));

      if (filesToProcess.length === 0) {
        this.handleProcessingSuccess('vault');
        return {
          status: 'complete',
          processed: 0,
        };
      }

      // Notify UI/listeners that vault-wide processing is starting
      try {
        this.plugin.emitter?.emit('embeddings:processing-start', {
          scope: 'vault',
          total: filesToProcess.length,
          reason: options.trigger
        });
      } catch {}

      const forwardProgress = (progress: ProcessingProgress) => {
        try {
          this.plugin.emitter?.emit('embeddings:processing-progress', {
            scope: 'vault',
            total: filesToProcess.length,
            current: progress.current,
            batch: progress.batchProgress
          });
        } catch {}
        if (options.onProgress) options.onProgress(progress);
      };

      const result = await this.processor.processFiles(filesToProcess, this.app, (progress) => {
        processedCount = Math.max(processedCount, progress.current);
        forwardProgress(progress);
      });

      processedCount = result.completed;

      if (result.failedPaths.length > 0) {
        const failedAt = Date.now();
        for (const path of result.failedPaths) {
          const detail = result.failedDetails?.[path];
          this.failedFiles.set(path, {
            path,
            error: {
              code: detail?.code || result.fatalError?.code || 'TRANSIENT_ERROR',
              message: detail?.message || result.fatalError?.message || 'Batch processing failed'
            },
            failedAt,
            retryable: !result.fatalError
          });
        }
      }

      if (result.fatalError) {
        throw result.fatalError;
      }

      this.handleProcessingSuccess('vault');

      // If the provider signaled a model change, schedule a follow-up refresh (respect autoProcess)
      if ((this.provider as any).lastModelChanged === true) {
        try {
          const now = Date.now();
          if (now >= this.modelMigrationCooldownUntil) {
            this.modelMigrationCooldownUntil = now + 6 * 60 * 60 * 1000; // 6h cooldown
            (this.provider as any).lastModelChanged = false;
            this.queryCache.clear();
            this.queryGenerationInFlight.clear();
            if (this.plugin.settings.embeddingsEnabled && this.config.autoProcess && this.isProviderReady()) {
              this.scheduleVaultProcessing(5000);
            } else {
              try { new Notice('SystemSculpt embeddings model changed. Run embeddings processing to refresh.', 6000); } catch {}
            }
          } else {
            (this.provider as any).lastModelChanged = false;
          }
        } catch {}
      }
    } catch (error) {
      const providerError = this.ensureProviderError(error);
      failure = providerError;
      await this.handleVaultFailure(providerError, processedCount);
    } finally {
      const failedCount = this.failedFiles.size;
      const hasFailures = failedCount > 0;
      try {
        this.plugin.emitter?.emit('embeddings:processing-complete', {
          scope: 'vault',
          total: undefined,
          processed: processedCount,
          failed: failedCount,
          status: failure ? 'error' : (hasFailures ? 'partial' : 'success')
        });
      } catch {}

      if (!failure && hasFailures) {
        try {
          const { showNoticeWhenReady } = await import('../../core/ui/notifications');
          showNoticeWhenReady(
            this.app,
            `Processed ${processedCount} files. ${failedCount} file${failedCount === 1 ? '' : 's'} failed and can be retried.`,
            { type: 'warning', duration: 8000 }
          );
        } catch {}
      }
    }

    if (failure) {
      return {
        status: 'aborted',
        processed: processedCount,
        failure,
        retryAt: this.vaultCooldownUntil > 0 ? this.vaultCooldownUntil : undefined,
        message: this.buildFriendlyErrorMessage(failure, Math.max(0, this.vaultCooldownUntil - Date.now()))
      };
    }

    return {
      status: 'complete',
      processed: processedCount,
      partialSuccess: this.failedFiles.size > 0
    };
  }

  /**
   * Search for similar content
   */
  async searchSimilar(query: string, limit: number = 20): Promise<SearchResult[]> {
    const currentModel = (this.provider as any).model || 'unknown';
    const nsPrefix = buildNamespacePrefix(this.provider.id, currentModel);
    const prefixMatches = await this.storage.getVectorsByNamespacePrefix(nsPrefix);
    const candidates = prefixMatches.filter((v) => v && v.metadata?.isEmpty !== true && !this.isPathExcluded(v.path));

    if (candidates.length === 0) {
      return [];
    }

    // Use a small cache for query embeddings to avoid repeated API calls for identical content
    const cacheKey = this.buildQueryCacheKey(query, this.provider.id, currentModel);
    const now = Date.now();

    if (this.queryCooldownUntil && now < this.queryCooldownUntil) {
      throw new Error(this.buildFriendlyCooldownMessage(this.queryCooldownUntil - now));
    }

    const cached = this.queryCache.get(cacheKey);
    let queryVec: Float32Array;
    if (cached && cached.expiresAt > now) {
      queryVec = cached.vector;
    } else {
      const inFlight = this.queryGenerationInFlight.get(cacheKey);
      if (inFlight) {
        try {
          queryVec = await inFlight;
        } catch (error) {
          const providerError = this.ensureProviderError(error);
          await this.handleQueryError(providerError);
          return [];
        }
      } else {
        const generationPromise = (async (): Promise<Float32Array> => {
          const queryEmbedding = await this.provider.generateEmbeddings([query], { inputType: 'query' });
          const raw = queryEmbedding[0];
          if (!raw || raw.length === 0) {
            throw new Error('Embedding provider returned an empty query vector.');
          }
          const vec = toFloat32Array(raw);
          if (!normalizeInPlace(vec)) {
            throw new Error('Embedding provider returned an invalid query vector (non-finite or zero-norm).');
          }
          this.insertQueryCache(cacheKey, vec, Date.now() + this.QUERY_CACHE_TTL_MS);
          return vec;
        })();

        this.queryGenerationInFlight.set(cacheKey, generationPromise);
        try {
          queryVec = await generationPromise;
          this.handleProcessingSuccess('query');
        } catch (error) {
          const providerError = this.ensureProviderError(error);
          await this.handleQueryError(providerError);
          return [];
        } finally {
          this.queryGenerationInFlight.delete(cacheKey);
        }
      }
    }

    // Constrain to exact namespace based on actual vector dimensionality
    const targetNamespace = buildNamespace(this.provider.id, currentModel, queryVec.length);
    const finalCandidates = candidates.filter(v => v.metadata?.namespace === targetNamespace);
    const dimensionMismatch = candidates.length > 0 && finalCandidates.length === 0;
    if (finalCandidates.length === 0) {
      if (this.storage.size() > 0 && this.plugin.settings.embeddingsEnabled) {
        try {
          if (dimensionMismatch) {
            this.showDimensionMismatchNotice();
          }
        } catch {}
      }
      return [];
    }

    // Exclude files that don't have a "root" vector (chunkId=0) or are marked incomplete.
    // This avoids showing stale/partial paths (e.g. during deletes/renames, WAF-skipped chunks).
    const eligiblePaths = new Set<string>();
    for (const vector of finalCandidates) {
      if (!vector?.path) continue;
      if (this.isPathExcluded(vector.path)) continue;
      const chunkId = typeof vector.chunkId === "number" ? vector.chunkId : -1;
      if (chunkId !== 0) continue;
      if (vector.metadata?.isEmpty === true) continue;
      if (vector.metadata?.complete !== true) continue;
      eligiblePaths.add(vector.path);
    }
    const eligibleCandidates = finalCandidates.filter((v) => v?.path && eligiblePaths.has(v.path));
    if (eligibleCandidates.length === 0) {
      return [];
    }

    const rawResults = await this.search.findSimilarAsync(queryVec, eligibleCandidates, limit * 4);
    const merged = this.mergeChunkResults([rawResults], limit);
    return this.applyLexicalSignals(query, merged);
  }

  private showDimensionMismatchNotice(): void {
    const now = Date.now();
    if (now - this.lastDimensionNoticeAt < 120000) return; // 2-minute cooldown
    this.lastDimensionNoticeAt = now;
    try {
      new Notice('Embeddings appear out of date for the current embeddings model. Run embeddings processing to refresh.');
    } catch {}
  }

  /**
   * Find similar notes to a specific file
   */
  async findSimilar(filePath: string, limit: number = 15): Promise<SearchResult[]> {
    if (!filePath) return [];
    if (this.isPathExcluded(filePath)) return [];

    const { model: currentModel, namespace: targetNamespace } = this.resolveLookupNamespace();
    if (!targetNamespace) return [];

    const vectors = await this.storage.getVectorsByPath(filePath);
    const fileVectors = vectors.filter(
      (v) => v && v.metadata?.namespace === targetNamespace && v.metadata?.isEmpty !== true
    );
    if (fileVectors.length === 0) {
      const nsPrefix = buildNamespacePrefix(this.provider.id, currentModel);
      const hasOtherNamespace = vectors.some(
        (v) =>
          v &&
          v.metadata?.isEmpty !== true &&
          typeof v.metadata?.namespace === "string" &&
          v.metadata.namespace.startsWith(nsPrefix)
      );
      if (hasOtherNamespace) {
        try {
          this.showDimensionMismatchNotice();
        } catch {}
      }
      return [];
    }

    const queryVectors = this.selectQueryVectors(fileVectors);
    if (queryVectors.length === 0) return [];

    const nsVectors = await this.storage.getVectorsByNamespace(targetNamespace);
    const eligiblePaths = new Set<string>();
    for (const vector of nsVectors) {
      if (!vector?.path) continue;
      if (this.isPathExcluded(vector.path)) continue;
      const chunkId = typeof vector.chunkId === "number" ? vector.chunkId : -1;
      if (chunkId !== 0) continue;
      if (vector.metadata?.isEmpty === true) continue;
      if (vector.metadata?.complete !== true) continue;
      eligiblePaths.add(vector.path);
    }

    const candidates = nsVectors.filter(
      (v) =>
        v &&
        v.path !== filePath &&
        v.metadata?.isEmpty !== true &&
        eligiblePaths.has(v.path) &&
        !this.isPathExcluded(v.path)
    );
    if (candidates.length === 0) return [];

    const resultSets: SearchResult[][] = [];
    for (const queryVector of queryVectors) {
      const raw = await this.runVectorSearch(queryVector, candidates, limit * 4);
      if (raw.length > 0) resultSets.push(raw);
    }
    if (resultSets.length === 0) return [];

    return this.mergeChunkResults(resultSets, limit, filePath);
  }

  /**
   * Get processing statistics
   */
  getStats(): { total: number; processed: number; present: number; needsProcessing: number; failed: number } {
    // PERFORMANCE: Avoid scanning the entire vault on each call
    // Prefer the plugin's VaultFileCache if available
    // Compute total eligible files respecting exclusions
    let totalFiles = 0;
    const cached = this.plugin.vaultFileCache ? this.plugin.vaultFileCache.getMarkdownFiles() : this.app.vault.getMarkdownFiles();
    if (Array.isArray(cached)) {
      totalFiles = cached.reduce((acc, f) => acc + (this.isFileExcluded(f as any) ? 0 : 1), 0);
    }

    const expectedDimension = this.getExpectedDimensionHint() || undefined;
    let processed = 0;
    let present = 0;

    const eligiblePaths = new Set<string>();
    if (Array.isArray(cached)) {
      for (const f of cached) {
        if (f instanceof TFile && !this.isFileExcluded(f)) {
          eligiblePaths.add(f.path);
        }
      }
    }

    try {
      const { model: currentModel, namespace: targetNamespace } = this.resolveLookupNamespace();
      const paths = this.storage.getDistinctPaths();
      for (const path of paths) {
        if (!path) continue;
        if (!eligiblePaths.has(path)) continue;
        if (!targetNamespace) continue;
        const root = this.storage.getVectorSync(buildVectorId(targetNamespace, path, 0));
        if (!root) continue;
        if (!namespaceMatchesCurrentVersion(root.metadata?.namespace, this.provider.id, currentModel, expectedDimension)) {
          continue;
        }
        present += 1;
        if (root.metadata?.complete === true) {
          processed += 1;
        }
      }
    } catch {
      processed = 0;
      present = 0;
    }
    const needsProcessing = Math.max(0, totalFiles - processed);

    return {
      total: totalFiles,
      processed,
      present,
      needsProcessing,
      failed: this.failedFiles.size
    };
  }

  /**
   * Enumerate files that still require processing for embeddings.
   */
  async listPendingFiles(): Promise<PendingEmbeddingFile[]> {
    await this.awaitReady();

    const files = this.app.vault.getMarkdownFiles();
    const pending: PendingEmbeddingFile[] = [];
    const addedPaths = new Set<string>();

    for (const [path, failureInfo] of this.failedFiles.entries()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        this.failedFiles.delete(path);
        continue;
      }
      addedPaths.add(path);
      pending.push({
        path,
        reason: 'failed',
        lastModified: file.stat?.mtime ?? null,
        lastEmbedded: null,
        size: file.stat?.size ?? null,
        failureInfo: {
          code: failureInfo.error.code,
          message: failureInfo.error.message,
          failedAt: failureInfo.failedAt
        }
      });
    }

    for (const file of files) {
      if (addedPaths.has(file.path)) continue;

      const state = this.evaluateFileProcessingState(file);
      if (!state.needsProcessing) continue;
      if (state.reason === 'excluded' || state.reason === 'up-to-date') continue;

      pending.push({
        path: file.path,
        reason: state.reason as PendingEmbeddingReason,
        lastModified: file.stat?.mtime ?? null,
        lastEmbedded: state.lastEmbedded ?? null,
        size: file.stat?.size ?? null,
        existingNamespace: state.existingNamespace
      });
    }

    pending.sort((a, b) => {
      if (a.reason === 'failed' && b.reason !== 'failed') return -1;
      if (a.reason !== 'failed' && b.reason === 'failed') return 1;
      const aTime = a.lastModified ?? 0;
      const bTime = b.lastModified ?? 0;
      return bTime - aTime;
    });

    return pending;
  }

  /**
   * Retry processing for files that previously failed.
   */
  async retryFailedFiles(): Promise<EmbeddingsRunResult> {
    const retryablePaths = Array.from(this.failedFiles.values())
      .filter(f => f.retryable)
      .map(f => f.path);

    if (retryablePaths.length === 0) {
      return { status: 'complete', processed: 0 };
    }

    const files = retryablePaths
      .map(path => this.app.vault.getAbstractFileByPath(path))
      .filter((f): f is TFile => f instanceof TFile);

    if (files.length === 0) {
      this.failedFiles.clear();
      return { status: 'complete', processed: 0 };
    }

    for (const path of retryablePaths) {
      this.failedFiles.delete(path);
    }

    return this.processingMutex.runExclusive(async () => {
      try {
        this.plugin.emitter?.emit('embeddings:processing-start', {
          scope: 'vault',
          total: files.length,
          reason: 'retry'
        });
      } catch {}

      let processedCount = 0;
      let failure: EmbeddingsProviderError | undefined;

      try {
        const result = await this.processor.processFiles(files, this.app, (progress) => {
          processedCount = Math.max(processedCount, progress.current);
          try {
            this.plugin.emitter?.emit('embeddings:processing-progress', {
              scope: 'vault',
              total: files.length,
              current: progress.current,
              batch: progress.batchProgress
            });
          } catch {}
        });

        processedCount = result.completed;

        if (result.failedPaths.length > 0) {
          const failedAt = Date.now();
          for (const path of result.failedPaths) {
            const detail = result.failedDetails?.[path];
            this.failedFiles.set(path, {
              path,
              error: {
                code: detail?.code || result.fatalError?.code || 'TRANSIENT_ERROR',
                message: detail?.message || result.fatalError?.message || 'Batch processing failed'
              },
              failedAt,
              retryable: !result.fatalError
            });
          }
        }

        if (result.fatalError) {
          throw result.fatalError;
        }

        this.handleProcessingSuccess('vault');
      } catch (error) {
        const providerError = this.ensureProviderError(error);
        failure = providerError;
        await this.handleVaultFailure(providerError, processedCount);
      } finally {
        const failedCount = this.failedFiles.size;
        const hasFailures = failedCount > 0;
        try {
          this.plugin.emitter?.emit('embeddings:processing-complete', {
            scope: 'vault',
            total: files.length,
            processed: processedCount,
            failed: failedCount,
            status: failure ? 'error' : (hasFailures ? 'partial' : 'success')
          });
        } catch {}

        if (!failure && processedCount > 0) {
          try {
            const { showNoticeWhenReady } = await import('../../core/ui/notifications');
            const message = hasFailures
              ? `Retry complete: ${processedCount} files processed, ${failedCount} still failing.`
              : `Retry complete: ${processedCount} files processed successfully.`;
            showNoticeWhenReady(this.app, message, { type: hasFailures ? 'warning' : 'success', duration: 6000 });
          } catch {}
        }
      }

      if (failure) {
        return {
          status: 'aborted',
          processed: processedCount,
          failure,
          retryAt: this.vaultCooldownUntil > 0 ? this.vaultCooldownUntil : undefined,
          message: this.buildFriendlyErrorMessage(failure, Math.max(0, this.vaultCooldownUntil - Date.now()))
        };
      }

      return {
        status: 'complete',
        processed: processedCount,
        partialSuccess: this.failedFiles.size > 0
      };
    });
  }

  /**
   * Clear all tracked file failures.
   */
  clearFailedFiles(): void {
    this.failedFiles.clear();
  }

  /**
   * Get the count of failed files.
   */
  getFailedFileCount(): number {
    return this.failedFiles.size;
  }

  /**
   * Check if currently processing
   */
  isCurrentlyProcessing(): boolean {
    return this.processingMutex.isLocked();
  }

  /**
   * Fast check: do we have any embeddings stored at all?
   */
  public hasAnyEmbeddings(): boolean {
    try {
      const expectedDimension = this.getExpectedDimensionHint() || undefined;
      const { model: currentModel, namespace: targetNamespace } = this.resolveLookupNamespace();
      if (!targetNamespace) return false;
      const paths = this.storage.getDistinctPaths();
      for (const path of paths) {
        if (!path) continue;
        if (this.isPathExcluded(path)) continue;
        const root = this.storage.getVectorSync(buildVectorId(targetNamespace, path, 0));
        if (!root) continue;
        if (root.metadata?.isEmpty === true) continue;
        if (!namespaceMatchesCurrentVersion(root.metadata?.namespace, this.provider.id, currentModel, expectedDimension)) {
          continue;
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Await manager readiness (storage initialized and embeddings loaded)
   */
  public async awaitReady(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }
    // If initialize() hasn't been called yet, initialize now
    await this.initialize();
  }

  /**
   * Report initialization state
   */
  public isReady(): boolean {
    return this.initialized;
  }

  /**
   * Temporarily pause all embeddings processing and cancel any in-flight batches.
   * File watchers remain registered but will no-op while suspended.
   */
  suspendProcessing(): void {
    this.processingSuspended = true;
    try { this.processor.cancel(); } catch {}
  }

  /**
   * Reset the license-related cooldown. Call this when a user successfully re-validates
   * their license after it was previously invalid/expired.
   */
  resetLicenseCooldown(): void {
    this.vaultCooldownUntil = 0;
    this.queryCooldownUntil = 0;
  }

  /**
   * Resume processing after a prior suspension.
   */
  resumeProcessing(): void {
    this.processingSuspended = false;
  }

  /**
   * Report current suspension state.
   */
  isSuspended(): boolean {
    return this.processingSuspended;
  }

  /**
   * Apply the latest plugin settings to the embeddings subsystem.
   * Keeps provider + processing configuration in sync without requiring reload.
   */
  public syncFromSettings(): void {
    const nextConfig = this.buildConfig(undefined, this.plugin.settings);
    const prevConfig = this.config;

    const providerChanged =
      prevConfig.provider.providerId !== nextConfig.provider.providerId
      || (prevConfig.provider.customEndpoint || "") !== (nextConfig.provider.customEndpoint || "")
      || (prevConfig.provider.customApiKey || "") !== (nextConfig.provider.customApiKey || "")
      || (prevConfig.provider.customModel || "") !== (nextConfig.provider.customModel || "")
      || (prevConfig.provider.model || "") !== (nextConfig.provider.model || "");

    const processingChanged =
      prevConfig.batchSize !== nextConfig.batchSize
      || prevConfig.maxConcurrency !== nextConfig.maxConcurrency
      || prevConfig.autoProcess !== nextConfig.autoProcess;

    const exclusionsChanged =
      JSON.stringify(prevConfig.exclusions) !== JSON.stringify(nextConfig.exclusions);

    this.config = nextConfig;

    if (providerChanged) {
      this.provider = this.createProvider();
      this.processor.setProvider(this.provider);
      this.queryCache.clear();
      this.queryGenerationInFlight.clear();
      this.clearNamespaceLookupCache();
    }

    if (exclusionsChanged) {
      // Remove stored embeddings that are now excluded so they don't continue to appear in Similar Notes/search.
      // Run under the same mutex as processing to avoid concurrent IndexedDB writes.
      void this.processingMutex.runExclusive(async () => {
        try {
          await this.cleanupExcludedEmbeddings();
        } catch {}
      });
    }

    if (providerChanged || processingChanged) {
      this.processor.setConfig({
        batchSize: this.config.batchSize,
        maxConcurrency: this.config.maxConcurrency,
        rateLimitPerMinute: this.plugin.settings.embeddingsRateLimitPerMinute
      });
    }

    const shouldRearm = providerChanged || processingChanged || exclusionsChanged;
    if (shouldRearm && this.plugin.settings.embeddingsEnabled && this.config.autoProcess) {
      this.scheduleAutoProcessing();
    } else {
      this.cancelScheduledVaultProcessing();
    }
  }

  /**
   * Current health snapshot used for monitoring surfaces.
   */
  public getHealthSnapshot(): EmbeddingsHealthSnapshot {
    return this.healthMonitor.getSnapshot();
  }

  /**
   * Fast check: do we have any vectors stored at all (any namespace)?
   * Used for UX to distinguish "never processed" vs "processed for a different model/provider".
   */
  public hasAnyStoredVectors(): boolean {
    return this.storage.size() > 0;
  }

  /**
   * Fast check: does a vector already exist for this path?
   */
  public hasVector(path: string): boolean {
    if (!path) return false;
    if (this.isPathExcluded(path)) return false;
    const { namespace: targetNamespace } = this.resolveLookupNamespace();
    if (!targetNamespace) return false;
    const root = this.storage.getVectorSync(buildVectorId(targetNamespace, path, 0));
    return !!root && root.metadata?.isEmpty !== true && root.metadata?.complete === true;
  }

  /**
   * Clear all embeddings
   */
  async clearAll(): Promise<void> {
    await this.storage.clear();
    this.clearNamespaceLookupCache();
  }

  /**
   * Switch provider
   */
  async switchProvider(
    config: EmbeddingsManagerConfig['provider'],
    options?: { clearExisting?: boolean; requireConfirm?: boolean }
  ): Promise<void> {
    this.config.provider = config;
    this.provider = this.createProvider();
    this.processor.setProvider(this.provider);
    this.queryCache.clear();
    this.queryGenerationInFlight.clear();
    this.clearNamespaceLookupCache();
    // Never auto-delete embeddings on provider switch.
    // If auto-process is enabled, processing will run and incrementally update as needed.
    if (this.plugin.settings.embeddingsEnabled && this.config.autoProcess) {
      this.scheduleAutoProcessing();
    }
  }

  /**
   * Reset database
   */
  async resetDatabase(): Promise<void> {
    await this.storage.reset();
    await this.storage.initialize();
    this.clearNamespaceLookupCache();
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.unregisterWatchers();
    this.processor.cleanup();
  }

  /** Public: Describe the active namespace components */
  public getCurrentNamespaceDescriptor(): { provider: string; model: string; schema: number } {
    const model = (this.provider as any).model || 'unknown';
    return { provider: this.provider.id, model, schema: EMBEDDING_SCHEMA_VERSION };
  }

  /** Public: List available namespaces with counts */
  public async getNamespaceStats(): Promise<Array<{ namespace: string; provider: string; model: string; schema: number; dimension: number; vectors: number; files: number }>> {
    await this.awaitReady();
    const vectors = await this.storage.getAllVectors();
    const map = new Map<string, { vectors: number; files: Set<string> }>();
    for (const v of vectors) {
      const ns = String(v.metadata?.namespace || '');
      if (!ns) continue;
      if (!map.has(ns)) map.set(ns, { vectors: 0, files: new Set() });
      const entry = map.get(ns)!;
      entry.vectors += 1;
      if (v.path) entry.files.add(v.path);
    }
    const results: Array<{ namespace: string; provider: string; model: string; schema: number; dimension: number; vectors: number; files: number }> = [];
    for (const [ns, data] of map.entries()) {
      const parsed = parseNamespace(ns);
      if (!parsed || parsed.dimension === null) continue;
      const { provider, model, schema, dimension } = parsed;
      results.push({ namespace: ns, provider, model, schema, dimension, vectors: data.vectors, files: data.files.size });
    }
    // Sort by provider->model->schema->dimension for stable UI
    results.sort((a, b) => (a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.schema - b.schema || a.dimension - b.dimension));
    return results;
  }

  /**
   * Force refresh embeddings for the current provider/model/schema by
   * removing all vectors in the current namespace and reprocessing the vault.
   */
  async forceRefreshCurrentNamespace(): Promise<void> {
    await this.awaitReady();
    const currentModel = (this.provider as any).model || 'unknown';
    const nsPrefix = buildNamespacePrefix(this.provider.id, currentModel);
    // Suspend ongoing processing and serialize the delete to avoid races with in-flight writes.
    this.suspendProcessing();
    try {
      await this.processingMutex.runExclusive(async () => {
        await this.storage.removeByNamespacePrefix(nsPrefix);
      });
    } finally {
      this.resumeProcessing();
    }
    await this.processVault();
  }

  // Private methods

  private handleProcessingSuccess(scope: 'vault' | 'file' | 'query'): void {
    if (scope === 'query') {
      this.queryCooldownUntil = 0;
    } else {
      this.vaultCooldownUntil = 0;
      this.cancelScheduledVaultProcessing();
    }
    this.healthMonitor.recordSuccess(scope);
  }

  private ensureProviderError(error: unknown): EmbeddingsProviderError {
    if (isEmbeddingsProviderError(error)) {
      return error;
    }
    const message = error instanceof Error && typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : 'Embeddings processing failed';
    return new EmbeddingsProviderError(message, {
      code: 'HTTP_ERROR',
      providerId: this.provider.id,
      endpoint: undefined,
      cause: error
    });
  }

  private async handleQueryError(error: EmbeddingsProviderError): Promise<never> {
    const fallbackMs = (error.status === 502 || error.status === 503 || error.status === 504)
      ? 15 * 1000
      : error.code === 'HOST_UNAVAILABLE'
        ? 2 * 60 * 1000
        : 60 * 1000;
    const retryMs = Math.min(Math.max(error.retryInMs ?? fallbackMs, 1000), 15 * 60 * 1000);
    this.queryCooldownUntil = Date.now() + retryMs;

    await this.healthMonitor.recordFailure('query', error, { attempt: 0 });
    const message = this.buildFriendlyErrorMessage(error, retryMs);
    throw new Error(message);
  }

  private async handleVaultFailure(error: EmbeddingsProviderError, processedCount: number): Promise<void> {
    // On license/auth errors, don't auto-retry - user needs to fix their license
    const isLicenseError = error.licenseRelated || error.code === 'LICENSE_INVALID' || error.status === 401 || error.status === 403;

    const fallbackMs = isLicenseError
      ? 24 * 60 * 60 * 1000 // 24 hour cooldown for license errors - don't spam
      : (error.status === 502 || error.status === 503 || error.status === 504)
        ? 15 * 1000
        : error.code === 'HOST_UNAVAILABLE'
          ? 2 * 60 * 1000
          : 60 * 1000;
    const retryMs = Math.min(Math.max(error.retryInMs ?? fallbackMs, 1000), isLicenseError ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000);
    this.vaultCooldownUntil = Date.now() + retryMs;

    await this.healthMonitor.recordFailure('vault', error, { attempt: 0 });

    try {
      this.plugin.emitter?.emit('embeddings:retry-scheduled', {
        scope: 'vault',
        retryInMs: isLicenseError ? undefined : retryMs, // Don't signal retry for license errors
        attempt: 0,
        processed: processedCount,
        timestamp: Date.now()
      });
    } catch {}

    // Don't auto-reschedule on license errors - user action required
    if (!isLicenseError) {
      this.scheduleVaultProcessing(retryMs);
    }
  }

  private scheduleVaultProcessing(delayMs: number): void {
    if (!this.config.autoProcess) return;
    if (!this.plugin.settings.embeddingsEnabled) return;

    const now = Date.now();
    const runAt = now + Math.max(0, delayMs);

    if (this.scheduledVaultRun && this.scheduledVaultRunAt !== null && this.scheduledVaultRunAt <= runAt) {
      return;
    }

    if (this.scheduledVaultRun) {
      try { clearTimeout(this.scheduledVaultRun); } catch {}
      this.scheduledVaultRun = null;
      this.scheduledVaultRunAt = null;
    }

    const scheduler = typeof window !== 'undefined' && window?.setTimeout ? window.setTimeout.bind(window) : setTimeout;
    this.scheduledVaultRunAt = runAt;
    this.scheduledVaultRun = scheduler(async () => {
      this.scheduledVaultRun = null;
      this.scheduledVaultRunAt = null;

      try {
        await this.awaitReady();
      } catch {
        return;
      }

      if (!this.plugin.settings.embeddingsEnabled) return;
      if (!this.config.autoProcess) return;
      if (this.processingSuspended) return;
      if (!this.isProviderReady()) return;

      const now = Date.now();
      if (now < this.vaultCooldownUntil) {
        this.scheduleVaultProcessing(this.vaultCooldownUntil - now);
        return;
      }

      void this.processingMutex
        .runExclusive(() => this.processVaultInternal({ trigger: 'auto' }))
        .catch(() => {});
    }, Math.max(0, runAt - now));
  }

  private cancelScheduledVaultProcessing(): void {
    if (this.scheduledVaultRun) {
      try { clearTimeout(this.scheduledVaultRun); } catch {}
      this.scheduledVaultRun = null;
      this.scheduledVaultRunAt = null;
    }
  }

  private buildFriendlyErrorMessage(error: EmbeddingsProviderError, retryMs: number): string {
    if (error.code === 'HOST_UNAVAILABLE') {
      const seconds = Math.max(1, Math.ceil(retryMs / 1000));
      return `SystemSculpt embeddings are temporarily unavailable. Automatically retrying in ~${seconds}s.`;
    }
    if (error.code === 'NETWORK_ERROR') {
      return 'Network issue while contacting SystemSculpt embeddings. Check your connection and try again shortly.';
    }
    if (error.licenseRelated) {
      return `SystemSculpt license error: ${error.message}`;
    }
    if (error.status === 429) {
      return 'SystemSculpt embeddings rate limit reached. Please wait a moment before retrying.';
    }
    return error.message;
  }

  private buildFriendlyCooldownMessage(remainingMs: number): string {
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return `SystemSculpt embeddings are cooling down. Automatically retrying in ~${seconds}s.`;
  }

  /**
   * Best-effort guess of the expected embedding dimension for the active provider.
   * Keeps this conservative to avoid false positives for custom providers.
   */
  private getExpectedDimensionHint(): number | null {
    const providerAny: any = this.provider as any;
    if (typeof providerAny.expectedDimension === 'number' && providerAny.expectedDimension > 0) {
      return providerAny.expectedDimension;
    }
    const providerId = this.config.provider.providerId;
    if (providerId === 'systemsculpt') {
      return DEFAULT_EMBEDDING_DIMENSION;
    }
    return null;
  }

  private buildConfig(partial?: Partial<EmbeddingsManagerConfig>): EmbeddingsManagerConfig;
  private buildConfig(partial: Partial<EmbeddingsManagerConfig> | undefined, settings: SystemSculptSettings): EmbeddingsManagerConfig;
  private buildConfig(
    partial: Partial<EmbeddingsManagerConfig> | undefined,
    settings: SystemSculptSettings = this.plugin.settings
  ): EmbeddingsManagerConfig {
    const providerId = settings.embeddingsProvider || 'systemsculpt';
    const maxConcurrency = providerId === 'systemsculpt' ? 1 : 3;
    return {
      provider: {
        providerId,
        customEndpoint: settings.embeddingsCustomEndpoint,
        customApiKey: settings.embeddingsCustomApiKey,
        customModel: settings.embeddingsCustomModel,
        // Force multilingual for SystemSculpt; allow configured model only for custom provider
        model: providerId === 'systemsculpt'
          ? DEFAULT_EMBEDDING_MODEL
          : (settings.embeddingsCustomModel || settings.embeddingsModel || DEFAULT_EMBEDDING_MODEL)
      },
      batchSize: settings.embeddingsBatchSize || 20,
      maxConcurrency,
      autoProcess: settings.embeddingsAutoProcess !== false,
      exclusions: settings.embeddingsExclusions || {
        folders: [],
        patterns: [],
        ignoreChatHistory: true,
        respectObsidianExclusions: true
      },
      ...partial
    };
  }

  private createProvider(): EmbeddingsProvider {
    const { provider } = this.config;
    
    if (provider.providerId === 'custom') {
      const endpoint = (provider.customEndpoint || '').trim();
      const model = (provider.customModel || provider.model || '').trim();
      return new CustomProvider({
        endpoint,
        apiKey: provider.customApiKey || '',
        model
      });
    }

    if (provider.providerId === 'systemsculpt') {
      const baseUrl = SystemSculptEnvironment.resolveBaseUrl(this.plugin.settings);
      return new SystemSculptProvider(
        this.plugin.settings.licenseKey,
        baseUrl,
        DEFAULT_EMBEDDING_MODEL
      );
    }

    throw new Error(
      `Unknown embeddings provider: ${provider.providerId}. Supported providers: systemsculpt, custom.`
    );
  }

  private queueReprocessForPaths(paths: string[]): void {
    const unique = Array.from(
      new Set(
        paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
      )
    );
    if (unique.length === 0) return;
    this.scheduleRepairsForPaths(unique);
  }

  private scheduleRepairsForPaths(paths: string[]): void {
    setTimeout(() => {
      for (const path of paths) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile && file.extension === 'md') {
          this.processFileIfNeeded(file, 'manual');
        } else {
          // Remove dangling vectors for files that no longer exist / are no longer eligible.
          void this.storage.removeByPath(path).catch(() => {});
        }
      }
    }, 0);
  }

  private scheduleAutoProcessing(): void {
    this.scheduleVaultProcessing(3000);
  }

  private setupFileWatchers(): void {
    // Ensure idempotency: clear existing watcher refs first
    this.unregisterWatchers();
    const refs: any[] = [];
    // Watch for file changes
    refs.push(this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.processFileIfNeeded(file, 'modify');
      }
    }));
    // Watch for new files
    refs.push(this.app.vault.on('create', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.processFileIfNeeded(file, 'create');
      }
    }));
    // Watch for renamed files
    refs.push(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        if (this.isFileExcluded(file)) {
          // If the file is now excluded, remove embeddings associated with the old path.
          void this.storage.removeByPath(oldPath).catch(() => {});
        } else {
          void this.storage.renameByPath(oldPath, file.path, file.basename).catch(() => {});
        }
        const oldTimer = this.perPathTimers.get(oldPath);
        if (oldTimer) { try { clearTimeout(oldTimer); } catch {} this.perPathTimers.delete(oldPath); }
        const newTimer = this.perPathTimers.get(file.path);
        if (newTimer) { try { clearTimeout(newTimer); } catch {} this.perPathTimers.delete(file.path); }
      }
    }));
    // Watch for deleted files
    refs.push(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        void this.storage.removeByPath(file.path).catch(() => {});
      }
    }));
    // Watch for folder renames and deletions using app.vault events where path is a folder
    refs.push(this.app.vault.on('rename', (file, oldPath) => {
      // Folders come through as TAbstractFile not TFile; guard by absence of extension
      if (!(file instanceof TFile)) {
        const newPath = (file as any)?.path || '';
        if (typeof oldPath === 'string' && typeof newPath === 'string') {
          const oldDir = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
          const newDir = newPath.endsWith('/') ? newPath : `${newPath}/`;
          if (this.isDirectoryExcluded(newDir)) {
            void this.storage.removeByDirectory(oldDir).catch(() => {});
          } else {
            void this.storage.renameByDirectory(oldDir, newDir).catch(() => {});
          }
        }
      }
    }));
    refs.push(this.app.vault.on('delete', (file) => {
      if (!(file instanceof TFile)) {
        const path = (file as any)?.path || '';
        if (typeof path === 'string') {
          void this.storage.removeByDirectory(path.endsWith('/') ? path : `${path}/`).catch(() => {});
        }
      }
    }));
    this.fileWatchers = refs;
  }

  private unregisterWatchers(): void {
    if (this.fileWatchers && this.fileWatchers.length > 0) {
      for (const ref of this.fileWatchers) {
        try { this.app.vault.offref(ref); } catch {}
      }
      this.fileWatchers = [];
    }
  }

  private async processFileIfNeeded(file: TFile, reason: 'modify' | 'create' | 'rename' | 'manual' | 'auto' = 'manual'): Promise<void> {
    if (!this.plugin.settings.embeddingsEnabled) return;
    if (this.processingSuspended) return;
    if (!this.isProviderReady()) return;
    const path = file.path;
    const delaySetting = this.plugin.settings.embeddingsQuietPeriodMs ?? 1200;
    const delay = reason === 'modify' ? delaySetting : 300;
    const existing = this.perPathTimers.get(path);
    if (existing) { try { clearTimeout(existing); } catch {} }
    const timer = setTimeout(async () => {
      this.perPathTimers.delete(path);
      if (!this.plugin.settings.embeddingsEnabled) return;
      if (this.processingSuspended) return;
      if (this.inFlightPaths.has(path)) return;
      if (!this.shouldProcessFile(file)) return;
      this.inFlightPaths.add(path);
      try {
        await this.processFile(file, reason);
      } catch (error) {
      } finally {
        this.inFlightPaths.delete(path);
      }
    }, delay);
    this.perPathTimers.set(path, timer);
  }

  private isProviderReady(): boolean {
    const p = this.config.provider;
    if (p.providerId === 'custom') {
      const endpoint = (p.customEndpoint || '').trim();
      const model = (p.customModel || p.model || '').trim();
      return !!endpoint && !!model;
    }
    // For SystemSculpt, require license key
    return !!this.plugin.settings.licenseKey?.trim() && this.plugin.settings.licenseValid === true;
  }

  private async processFile(file: TFile, reason: 'modify' | 'create' | 'rename' | 'manual' | 'auto' = 'manual'): Promise<void> {
    const now = Date.now();
    if (now < this.vaultCooldownUntil) {
      if (this.config.autoProcess) {
        this.scheduleVaultProcessing(this.vaultCooldownUntil - now);
      }
      return;
    }

    try {
      await this.processingMutex.runExclusive(async () => {
        if (!this.plugin.settings.embeddingsEnabled) return;
        if (this.processingSuspended) return;
        if (!this.isProviderReady()) return;

        const now = Date.now();
        if (now < this.vaultCooldownUntil) return;

        try {
          this.plugin.emitter?.emit('embeddings:processing-start', {
            scope: 'file',
            path: file.path,
            reason
          });
        } catch {}

        await this.processor.processFiles([file], this.app);
        this.handleProcessingSuccess('file');

        try {
          this.plugin.emitter?.emit('embeddings:processing-complete', {
            scope: 'file',
            path: file.path
          });
        } catch {}
      });
    } catch (error) {
      const providerError = this.ensureProviderError(error);
      await this.handleVaultFailure(providerError, 0);
    }
  }

  private shouldProcessFile(file: TFile): boolean {
    return this.evaluateFileProcessingState(file).needsProcessing;
  }

  private evaluateFileProcessingState(
    file: TFile
  ): {
    needsProcessing: boolean;
    reason: PendingEmbeddingReason | 'excluded' | 'up-to-date';
    lastEmbedded?: number | null;
    existingNamespace?: string;
  } {
    if (this.isFileExcluded(file)) {
      return { needsProcessing: false, reason: 'excluded' };
    }

    const isEmptyFile = typeof file.stat?.size === 'number' && file.stat.size <= 1;

    if (!file.stat || typeof file.stat.mtime !== 'number') {
      return { needsProcessing: true, reason: 'metadata-missing', lastEmbedded: null };
    }

    const expectedDimension = this.getExpectedDimensionHint() || undefined;
    const { model: currentModel, namespace: targetNamespace } = this.resolveLookupNamespace();
    const existing = targetNamespace ? this.storage.getVectorSync(buildVectorId(targetNamespace, file.path, 0)) : null;
    if (!existing) {
      return {
        needsProcessing: true,
        reason: isEmptyFile ? 'empty' : 'missing',
        lastEmbedded: null
      };
    }

    const nsOk = namespaceMatchesCurrentVersion(
      existing.metadata?.namespace,
      this.provider.id,
      currentModel,
      expectedDimension
    );
    if (!nsOk) {
      return {
        needsProcessing: true,
        reason: 'schema-mismatch',
        lastEmbedded: existing.metadata?.mtime ?? null,
        existingNamespace: existing.metadata?.namespace
      };
    }

    if (existing.metadata?.complete !== true) {
      return {
        needsProcessing: true,
        reason: 'incomplete',
        lastEmbedded: existing.metadata?.mtime ?? null,
        existingNamespace: existing.metadata?.namespace
      };
    }

    const embeddedMtime = typeof existing.metadata?.mtime === 'number' ? existing.metadata.mtime : null;

    if (embeddedMtime !== null && embeddedMtime >= file.stat.mtime) {
      return {
        needsProcessing: false,
        reason: 'up-to-date',
        lastEmbedded: embeddedMtime,
        existingNamespace: existing.metadata?.namespace
      };
    }

    return {
      needsProcessing: true,
      reason: 'modified',
      lastEmbedded: embeddedMtime
    };
  }

  private isFileExcluded(file: TFile): boolean {
    return this.isPathExcluded(file.path);
  }

  private isDirectoryExcluded(dir: string): boolean {
    const prefix = String(dir || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!prefix) return false;
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;

    // Folder exclusions apply to all descendants.
    for (const folder of this.config.exclusions.folders) {
      if (!folder) continue;
      const folderPrefix = folder.endsWith("/") ? folder : `${folder}/`;
      if (normalized.startsWith(folderPrefix)) return true;
    }

    const lower = normalized.toLowerCase();

    // Chat history exclusions apply to all descendants.
    if (this.config.exclusions.ignoreChatHistory) {
      const normalizeDir = (dirVal: unknown): string | null => {
        if (typeof dirVal !== "string") return null;
        const trimmed = dirVal.trim().replace(/^\/+/, "");
        if (!trimmed) return null;
        return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
      };

      const chatsDir = normalizeDir((this.plugin.settings as any).chatsDirectory);
      const savedChatsDir = normalizeDir((this.plugin.settings as any).savedChatsDirectory);
      const candidates = [chatsDir, savedChatsDir].filter((d): d is string => !!d);
      for (const dirPrefix of candidates) {
        if (lower.startsWith(dirPrefix.toLowerCase())) return true;
      }

      if (
        lower.includes("systemsculpt")
        && (lower.includes("/saved chats/") || lower.includes("/chats/"))
      ) {
        return true;
      }
    }

    // Vault ignore filters apply to all descendants.
    if (this.config.exclusions.respectObsidianExclusions !== false) {
      try {
        const userIgnoreFilters: string[] | undefined = (this.app as any).vault?.getConfig?.("userIgnoreFilters");
        if (Array.isArray(userIgnoreFilters) && userIgnoreFilters.length > 0) {
          for (const filter of userIgnoreFilters) {
            if (!filter || typeof filter !== "string") continue;
            if (normalized.includes(filter)) return true;
          }
        }
      } catch {}
    }

    return false;
  }

  private isPathExcluded(path: string): boolean {
    const filePath = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!filePath) return false;

    const { exclusions } = this.config;

    // Check folder exclusions
    for (const folder of exclusions.folders) {
      if (!folder) continue;
      const normalized = folder.endsWith("/") ? folder : `${folder}/`;
      if (filePath.startsWith(normalized)) return true;
    }

    // Check pattern exclusions (glob-like). Patterns containing "/" match full path,
    // otherwise match against the file's basename.
    const basename = filePath.substring(filePath.lastIndexOf("/") + 1);
    for (const pattern of exclusions.patterns) {
      if (!pattern || typeof pattern !== "string") continue;
      const target = pattern.includes("/") ? filePath : basename;
      if (this.matchesGlob(target, pattern)) return true;
    }

    // Exclude chat history directories (both live chat logs + saved chats).
    if (exclusions.ignoreChatHistory) {
      const normalizeDir = (dir: unknown): string | null => {
        if (typeof dir !== "string") return null;
        const trimmed = dir.trim().replace(/^\/+/, "");
        if (!trimmed) return null;
        return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
      };

      const chatsDir = normalizeDir((this.plugin.settings as any).chatsDirectory);
      const savedChatsDir = normalizeDir((this.plugin.settings as any).savedChatsDirectory);
      const candidates = [chatsDir, savedChatsDir].filter((d): d is string => !!d);
      const lowerPath = filePath.toLowerCase();
      for (const dir of candidates) {
        if (lowerPath.startsWith(dir.toLowerCase())) return true;
      }

      // Extra safety: some users move SystemSculpt chat transcripts under other folders
      // (e.g. "90 - system/systemsculpt-operations/Saved Chats/…"). If chat history exclusion
      // is enabled, treat any SystemSculpt-related "Saved Chats"/"Chats" folder as excluded.
      if (
        lowerPath.includes("systemsculpt")
        && (lowerPath.includes("/saved chats/") || lowerPath.includes("/chats/"))
      ) {
        return true;
      }
    }

    // Respect Obsidian native exclusions if enabled
    if (exclusions.respectObsidianExclusions !== false) {
      try {
        // Obsidian exposes 'userIgnoreFilters' array in vault config
        const userIgnoreFilters: string[] | undefined = (this.app as any).vault?.getConfig?.("userIgnoreFilters");
        if (Array.isArray(userIgnoreFilters) && userIgnoreFilters.length > 0) {
          for (const filter of userIgnoreFilters) {
            if (!filter || typeof filter !== "string") continue;
            if (filePath.includes(filter)) return true;
          }
        }
      } catch {}
    }

    return false;
  }

  private async cleanupExcludedEmbeddings(): Promise<void> {
    await this.awaitReady();
    if (this.storage.size() === 0) return;

    const { exclusions } = this.config;

    const normalizeDir = (dir: unknown): string | null => {
      if (typeof dir !== "string") return null;
      const trimmed = dir.trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (!trimmed) return null;
      return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    };

    const dirs = new Set<string>();

    for (const folder of exclusions.folders) {
      const normalized = normalizeDir(folder);
      if (normalized) dirs.add(normalized);
    }

    if (exclusions.ignoreChatHistory) {
      const chatsDir = normalizeDir((this.plugin.settings as any).chatsDirectory);
      const savedChatsDir = normalizeDir((this.plugin.settings as any).savedChatsDirectory);
      if (chatsDir) dirs.add(chatsDir);
      if (savedChatsDir) dirs.add(savedChatsDir);
    }

    // Remove whole excluded directories efficiently.
    for (const dir of dirs) {
      try {
        await this.storage.removeByDirectory(dir);
      } catch {}
      try {
        for (const path of Array.from(this.failedFiles.keys())) {
          if (path.startsWith(dir)) {
            this.failedFiles.delete(path);
          }
        }
      } catch {}
    }

    // Remove any remaining excluded paths (patterns, vault ignore filters, etc.).
    const paths = this.storage.getDistinctPaths();
    for (const path of paths) {
      if (!path) continue;
      if (!this.isPathExcluded(path)) continue;
      try {
        await this.storage.removeByPath(path);
      } catch {}
      this.failedFiles.delete(path);
    }

    this.clearNamespaceLookupCache();
  }

  private matchesGlob(target: string, pattern: string): boolean {
    if (!pattern) return false;
    // Escape regex special chars, then reintroduce glob tokens.
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regexSource = `^${escaped
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".")}$`;
    try {
      return new RegExp(regexSource, "i").test(target);
    } catch {
      return false;
    }
  }

  private async runVectorSearch(
    queryVector: EmbeddingVector,
    candidates: EmbeddingVector[],
    limit: number
  ): Promise<SearchResult[]> {
    if (candidates.length === 0) return [];
    return this.search.findSimilarAsync(queryVector.vector, candidates, limit);
  }

  private async findSimilarToVector(vector: EmbeddingVector, limit: number): Promise<SearchResult[]> {
    const allVectors = await this.storage.getAllVectors();
    const namespace = vector.metadata?.namespace;
    if (!namespace) return [];
    const candidates = allVectors.filter(
      (v) => v.path !== vector.path && !v.metadata.isEmpty && v.metadata?.namespace === namespace
    );
    if (candidates.length === 0) return [];
    const raw = await this.runVectorSearch(vector, candidates, limit * 4);
    if (raw.length === 0) return [];
    return this.mergeChunkResults([raw], limit, vector.path);
  }

  private selectQueryVectors(vectors: EmbeddingVector[]): EmbeddingVector[] {
    if (vectors.length <= 1) return vectors;

    const selected: EmbeddingVector[] = [];
    const addUnique = (vec: EmbeddingVector | undefined) => {
      if (!vec) return;
      if (selected.some((existing) => existing.id === vec.id)) return;
      selected.push(vec);
    };

    addUnique(vectors.find((v) => typeof v.chunkId === 'number' && v.chunkId === 0));

    const lengthSorted = [...vectors].sort((a, b) => {
      const lenA = a.metadata?.chunkLength ?? 0;
      const lenB = b.metadata?.chunkLength ?? 0;
      return lenB - lenA;
    });

    for (const vector of lengthSorted) {
      if (selected.length >= this.MAX_FILE_QUERY_QUERIES) break;
      addUnique(vector);
    }

    if (selected.length < Math.min(this.MAX_FILE_QUERY_QUERIES, vectors.length)) {
      for (const vector of vectors) {
        if (selected.length >= this.MAX_FILE_QUERY_QUERIES) break;
        addUnique(vector);
      }
    }

    return selected.slice(0, this.MAX_FILE_QUERY_QUERIES);
  }

  private mergeChunkResults(
    resultSets: SearchResult[][],
    limit: number,
    excludePath?: string
  ): SearchResult[] {
    if (resultSets.length === 0) return [];

    const K = 60;
    const accumulator = new Map<string, { best: SearchResult; bestScore: number; rrf: number }>();

    resultSets.forEach((results) => {
      results.forEach((result, rank) => {
        if (excludePath && result.path === excludePath) return;
        const key = result.path;
        const rrfScore = 1 / (K + rank + 1);
        const entry = accumulator.get(key);
        if (!entry) {
          accumulator.set(key, {
            best: result,
            bestScore: result.score,
            rrf: rrfScore
          });
          return;
        }
        entry.rrf += rrfScore;
        if (result.score > entry.bestScore) {
          entry.best = result;
          entry.bestScore = result.score;
        }
      });
    });

    if (accumulator.size === 0) return [];
    const maxPossible = resultSets.length * (1 / (K + 1));

    const merged = Array.from(accumulator.values()).map((entry) => {
      const normalizedRrf = maxPossible > 0 ? Math.min(1, entry.rrf / maxPossible) : 0;
      const combinedScore = Math.min(1, (0.65 * entry.bestScore) + (0.35 * normalizedRrf));
      return {
        ...entry.best,
        score: combinedScore
      };
    });

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }

  private applyLexicalSignals(query: string, results: SearchResult[]): SearchResult[] {
    const normalized = (query || '').toLowerCase().trim();
    if (!normalized || results.length === 0) {
      return results;
    }
    const sanitizedTokens = Array.from(
      new Set(
        normalized
          .split(/\s+/)
          .map((token) => token.replace(/[^a-z0-9]/gi, ''))
          .filter((token) => token.length > 1)
      )
    );
    if (sanitizedTokens.length === 0) {
      return results;
    }

    const boosted = results.map((result) => {
      const haystack = [
        result.path,
        result.metadata?.title ?? '',
        result.metadata?.excerpt ?? ''
      ]
        .join(' ')
        .toLowerCase();

      const fullMatch = haystack.includes(normalized);
      let matches = 0;
      for (const token of sanitizedTokens) {
        if (haystack.includes(token)) {
          matches++;
        }
      }
      const lexicalScore = fullMatch ? 1 : matches / sanitizedTokens.length;
      const baseScore = Math.max(0, Math.min(1, result.score ?? 0));
      const boostedScore = Math.min(1, (0.85 * baseScore) + (0.15 * lexicalScore));

      return {
        ...result,
        score: boostedScore,
        metadata: {
          ...result.metadata,
          lexicalScore,
        },
      };
    });

    boosted.sort((a, b) => b.score - a.score);
    return boosted;
  }

  private buildQueryCacheKey(query: string, providerId: string, model: string): string {
    let hash = 2166136261;
    const add = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
    };
    add(providerId + '|' + model + '|');
    add(query);
    return (hash >>> 0).toString(36);
  }

  private insertQueryCache(key: string, vector: Float32Array, expiresAt: number): void {
    if (this.queryCache.size >= this.QUERY_CACHE_MAX) {
      // Simple eviction: delete oldest by expiresAt
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.queryCache.entries()) {
        if (v.expiresAt < oldest) { oldest = v.expiresAt; oldestKey = k; }
      }
      if (oldestKey) this.queryCache.delete(oldestKey);
    }
    this.queryCache.set(key, { vector, expiresAt });
  }

  // confirmProviderSwitch removed: switching providers no longer deletes embeddings
}
