/**
 * EmbeddingsProcessor - High-performance batch processor
 * 
 * Features:
 * - Parallel processing with concurrency control
 * - Smart batching for optimal API usage
 * - Progress tracking and cancellation
 * - One managed dispatch per prepared batch
 */

import { App, TFile } from 'obsidian';
import {
  EmbeddingVector,
  ProcessingProgress,
  ProcessingResult,
  FailedProcessingDetail,
  EmbeddingsProvider,
  EmbeddingBatchMetadata
} from '../types';
import { EmbeddingsStorage } from '../storage/EmbeddingsStorage';
import {
  buildManagedNamespace,
  isManagedNamespace,
  MANAGED_EMBEDDING_MODEL,
  MANAGED_EMBEDDING_PROVIDER,
} from '../utils/namespace';
import { buildVectorId } from "../utils/vectorId";
import { normalizeInPlace, toFloat32Array } from '../utils/vector';
import { ContentPreprocessor, PreparedChunk } from "./ContentPreprocessor";
import { tokenCounter } from '../../../utils/TokenCounter';
import { errorLogger } from '../../../utils/errorLogger';
import { ManagedEmbeddingsError } from '../providers/ManagedEmbeddingsAdapter';

export interface ProcessorConfig {
  batchSize: number;
  maxConcurrency: number;
}

type PendingChunkWork = {
  file: TFile;
  content: string;
  hash: string;
  chunkId: number;
  sectionTitle?: string;
  headingPath?: string[];
  length: number;
};

export class EmbeddingsProcessor {
  private static readonly DEFAULT_MAX_TEXTS_PER_REQUEST = 25;
  private cancelled = false;
  private maxTextsPerRequest: number;
  private fatalError: ManagedEmbeddingsError | null = null;
  private failedBatchPaths: Set<string> = new Set();
  private failedBatchDetails: Map<string, FailedProcessingDetail> = new Map();
  private operationController = new AbortController();
  private runId = "";

  constructor(
    private readonly provider: EmbeddingsProvider,
    private readonly storage: EmbeddingsStorage,
    private readonly preprocessor: ContentPreprocessor,
    private config: ProcessorConfig
  ) {
    this.maxTextsPerRequest = this.resolveProviderBatchLimit(provider);
  }

  /**
   * Process files with progress tracking
   */
  async processFiles(
    files: TFile[],
    app: App,
    onProgress?: (progress: ProcessingProgress) => void
  ): Promise<ProcessingResult> {
    this.cancelled = false;
    this.operationController = new AbortController();
    this.runId = this.createRunId();
    this.fatalError = null;
    this.failedBatchPaths.clear();
    this.failedBatchDetails.clear();
    const totalFiles = files.length;
    const providerLimit = this.maxTextsPerRequest || EmbeddingsProcessor.DEFAULT_MAX_TEXTS_PER_REQUEST;
    const configuredBatchSize = this.config.batchSize && this.config.batchSize > 0
      ? this.config.batchSize
      : providerLimit;
    const safeBatchSize = Math.max(1, Math.min(configuredBatchSize, providerLimit));
    const maxConcurrency = Math.max(1, this.config.maxConcurrency || 1);
    const flushThreshold = Math.max(safeBatchSize * maxConcurrency * 6, safeBatchSize * 4);

    let completedFiles = 0;

    const reportProgress = () => {
      if (!onProgress) return;
      onProgress({
        current: completedFiles,
        total: totalFiles,
      });
    };

    const pendingWork: PendingChunkWork[] = [];
    const pendingChunksByPath: Map<string, number> = new Map();
    const keepChunkIdsByPath: Map<string, Set<number>> = new Map();
    const namespaceByPath: Map<string, string> = new Map();
    const chunkCountsByPath: Map<string, number> = new Map();
    const fileByPath: Map<string, TFile> = new Map();

    const finalizePath = async (path: string): Promise<void> => {
      const keepChunkIds = keepChunkIdsByPath.get(path);
      const namespace = namespaceByPath.get(path);
      const file = fileByPath.get(path);
      const chunkCount = chunkCountsByPath.get(path) ?? 0;
      const hadFailures = this.failedBatchPaths.has(path);

      // Remove bookkeeping before awaiting to avoid double-finalize.
      pendingChunksByPath.delete(path);
      keepChunkIdsByPath.delete(path);
      namespaceByPath.delete(path);
      chunkCountsByPath.delete(path);
      fileByPath.delete(path);

      if (!file || !keepChunkIds || !namespace) {
        return;
      }

      await this.finalizeFile(file, chunkCount, namespace, keepChunkIds, hadFailures);
      completedFiles += 1;
      reportProgress();
    };

    let nextBatchIndex = 0;

    const flushPendingWork = async (): Promise<void> => {
      if (pendingWork.length === 0 || this.cancelled) return;

      const work = pendingWork.splice(0, pendingWork.length);
      const rawBatches = tokenCounter.createOptimizedBatches(work);
      const batches = this.enforceBatchSizeLimit(rawBatches, safeBatchSize);

      const inFlight = new Set<Promise<void>>();
      let cursor = 0;

      const startNext = () => {
        while (!this.cancelled && cursor < batches.length && inFlight.size < maxConcurrency) {
          const batch = batches[cursor];
          const batchIndex = nextBatchIndex++;
          cursor += 1;

          const promise = (async () => {
            const ok = await this.processBatch(batch, batchIndex, namespaceByPath);
            if (!ok) return;

            const decrements = new Map<string, number>();
            for (const item of batch) {
              const path = item.file.path;
              decrements.set(path, (decrements.get(path) || 0) + 1);
            }

            for (const [path, dec] of decrements.entries()) {
              if (!pendingChunksByPath.has(path)) {
                continue;
              }
              const remaining = (pendingChunksByPath.get(path) || 0) - dec;
              if (remaining <= 0) {
                await finalizePath(path);
              } else {
                pendingChunksByPath.set(path, remaining);
              }
            }
          })().finally(() => {
            inFlight.delete(promise);
          });

          inFlight.add(promise);
        }
      };

      startNext();

      while (inFlight.size > 0 || (!this.cancelled && cursor < batches.length)) {
        if (inFlight.size > 0) {
          await Promise.race(inFlight);
        }
        if (!this.cancelled) {
          startNext();
        }
      }
    };

    for (const file of files) {
      if (this.cancelled) break;
      fileByPath.set(file.path, file);

      try {
        const content = await app.vault.read(file);

        const processed = this.preprocessor.process(content, file);

        if (!processed) {
          fileByPath.delete(file.path);
          completedFiles += 1;
          reportProgress();
          continue;
        }

        // Incremental: compute per-chunk hashes and reuse unchanged vectors
        const chunks = this.preprocessor.chunkContentWithHashes(
          processed.content,
          processed.source ?? content
        );

        if (chunks.length === 0) {
          fileByPath.delete(file.path);
          completedFiles += 1;
          reportProgress();
          continue;
        }

        const existingVectors = await this.storage.getVectorsByPath(file.path);
        const vectorsByHash: Map<string, EmbeddingVector[]> = new Map();
        for (const vector of existingVectors) {
          const hash = vector.metadata?.contentHash || '';
          if (!vectorsByHash.has(hash)) {
            vectorsByHash.set(hash, []);
          }
          vectorsByHash.get(hash)!.push(vector);
        }

        const metadataUpdates: EmbeddingVector[] = [];
        const keepChunkIds = new Set<number>();
        const idsToRemove: string[] = [];
        let pendingCount = 0;

        for (const chunk of chunks) {
          const chunkId = chunk.index;
          keepChunkIds.add(chunkId);
          const sectionTitle = chunk.headingPath.length > 0 ? chunk.headingPath.join(" › ") : undefined;

          let existing: EmbeddingVector | null = null;
          const candidates = vectorsByHash.get(chunk.hash) || [];
          const expectedDimension = this.getExpectedDimensionHint();
          const candidateIndex = candidates.findIndex((candidate) =>
            this.isReusableCandidate(candidate, expectedDimension)
          );

          let targetNamespace: string | null = null;
          let targetId: string | null = null;

          if (candidateIndex >= 0) {
            existing = candidates[candidateIndex];
            candidates.splice(candidateIndex, 1);
            vectorsByHash.set(chunk.hash, candidates);
            const dim = existing.vector instanceof Float32Array ? existing.vector.length : 0;
            targetNamespace = buildManagedNamespace(dim);
            targetId = buildVectorId(targetNamespace, file.path, chunkId);

            namespaceByPath.set(file.path, targetNamespace);

            const existingNamespace = typeof existing.metadata?.namespace === "string" ? existing.metadata.namespace : "";
            if (existingNamespace === targetNamespace && existing.id !== targetId) {
              await this.storage.moveVectorId(existing.id, targetId, chunkId);
              existing = { ...existing, id: targetId, path: file.path, chunkId };
            }
          } else {
            if (expectedDimension && expectedDimension > 0) {
              targetNamespace = buildManagedNamespace(expectedDimension);
              targetId = buildVectorId(targetNamespace, file.path, chunkId);
              existing = this.storage.getVectorSync(targetId);
              if (targetNamespace) {
                namespaceByPath.set(file.path, targetNamespace);
              }
            } else {
              existing = null;
            }
          }

          const sameHash = !!existing && existing.metadata?.contentHash === chunk.hash;
          const reusable =
            !!existing &&
            sameHash &&
            this.isReusableCandidate(existing, expectedDimension);

          if (existing && reusable) {
            const refresh = this.buildMetadataRefreshVector(existing, file, chunk, sectionTitle);
            if (refresh) {
              metadataUpdates.push(refresh);
              if (existing.id !== refresh.id) {
                idsToRemove.push(existing.id);
              }
            }
            continue;
          }

          pendingWork.push({
            file,
            content: chunk.text,
            hash: chunk.hash,
            chunkId,
            sectionTitle,
            headingPath: chunk.headingPath,
            length: chunk.length
          });
          pendingCount += 1;
        }

        if (metadataUpdates.length > 0) {
          await this.storage.storeVectors(metadataUpdates);
          if (idsToRemove.length > 0) {
            await this.storage.removeIds(idsToRemove);
          }
        }

        keepChunkIdsByPath.set(file.path, keepChunkIds);
        pendingChunksByPath.set(file.path, pendingCount);
        chunkCountsByPath.set(file.path, chunks.length);

        if (pendingCount === 0) {
          await finalizePath(file.path);
          continue;
        }

        if (pendingWork.length >= flushThreshold) {
          await flushPendingWork();
          if (this.cancelled) break;
        }
      } catch (error) {
        const failure = new ManagedEmbeddingsError(
          "local_preparation_failed",
          "A note could not be prepared for managed embeddings.",
          0,
        );
        this.failedBatchPaths.add(file.path);
        this.failedBatchDetails.set(file.path, {
          code: failure.code,
          message: failure.message,
          status: failure.status,
        });
        this.fatalError = failure;
        errorLogger.warn('Failed to prepare file for embeddings processing', {
          source: 'EmbeddingsProcessor',
          method: 'processFiles',
          providerId: this.provider.id,
          metadata: {
            path: file.path,
            message: error instanceof Error ? error.message : String(error)
          }
        });
        this.cancel();
      }
    }

    if (!this.cancelled) {
      await flushPendingWork();
    }

    const failedPaths = Array.from(this.failedBatchPaths);
    const result: ProcessingResult = {
      completed: completedFiles,
      failed: failedPaths.length,
      failedPaths,
      cancelled: this.cancelled,
      fatalError: this.fatalError,
      failedDetails: this.failedBatchDetails.size > 0 ? Object.fromEntries(this.failedBatchDetails.entries()) : undefined,
    };

    this.fatalError = null;
    return result;
  }

  /**
   * Cancel processing
   */
  cancel(): void {
    this.cancelled = true;
    this.operationController.abort();
  }

  /**
   * Update managed batching configuration.
   */
  setConfig(config: ProcessorConfig): void {
    this.config = config;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.cancel();
  }

  // Private methods

  private async processBatch(
    batch: PendingChunkWork[],
    batchIndex: number,
    namespaceByPath: Map<string, string>
  ): Promise<boolean> {
    if (this.cancelled) return false;

    const texts = batch.map(item => {
      const truncated = tokenCounter.truncateToTokenLimit(item.content);
      return truncated;
    });
    const metadata = this.buildBatchMetadata(batch, texts, batchIndex);
    const batchStats = tokenCounter.getBatchStatistics(texts);
    errorLogger.debug('Embeddings batch prepared', {
      source: 'EmbeddingsProcessor',
      method: 'processBatch',
      providerId: this.provider.id,
      metadata: {
        batchIndex,
        batchSize: metadata.batchSize,
        estimatedTotalTokens: metadata.estimatedTotalTokens,
        maxEstimatedTokens: metadata.maxEstimatedTokens,
        truncatedCount: metadata.truncatedCount,
        stats: batchStats,
        sampleItems: metadata.items.slice(0, 10)
      }
    });

    try {
      const embeddings = await this.provider.generateEmbeddings(texts, {
        inputType: "document",
        batchMetadata: metadata,
        idempotencyKey: this.batchIdempotencyKey(metadata),
        signal: this.operationController.signal,
      });
      if (this.cancelled) return false;
      if (embeddings.length !== texts.length) {
        throw new ManagedEmbeddingsError("invalid_response", "Embedding count mismatch.", 200);
      }
      const namespace = this.provider.activeNamespace;
      if (!namespace || !isManagedNamespace(namespace)) {
        throw new ManagedEmbeddingsError("invalid_response", "Managed embedding namespace is unavailable.", 200);
      }

      // Create embedding vectors
      const vectors: EmbeddingVector[] = [];
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index];
        const raw = embeddings[index];
        if (!raw) throw new ManagedEmbeddingsError("invalid_response", "Managed embedding vector is missing.", 200);
        const vector = toFloat32Array(raw);
        const dimension = vector.length;
        if (!normalizeInPlace(vector)) {
          throw new ManagedEmbeddingsError("invalid_response", "Managed embedding vector is invalid.", 200);
        }
        if (namespace !== buildManagedNamespace(dimension)) {
          throw new ManagedEmbeddingsError("invalid_response", "Managed embedding dimension changed.", 200);
        }
        const id = buildVectorId(namespace, item.file.path, item.chunkId);
        const excerpt = this.buildExcerpt(item.content, item.sectionTitle);

        namespaceByPath.set(item.file.path, namespace);
        vectors.push({
          id,
          path: item.file.path,
          chunkId: item.chunkId,
          vector,
          metadata: {
            title: item.file.basename,
            excerpt,
            mtime: item.file.stat?.mtime || Date.now(),
            contentHash: item.hash,
            provider: MANAGED_EMBEDDING_PROVIDER,
            model: MANAGED_EMBEDDING_MODEL,
            dimension,
            createdAt: Date.now(),
            namespace,
            sectionTitle: item.sectionTitle,
            headingPath: item.headingPath,
            chunkLength: item.length
          }
        });
      }

      // Store embeddings
      if (vectors.length > 0) {
        await this.storage.storeVectors(vectors);
      }
      return true;

    } catch (error) {
      const managedError = error instanceof ManagedEmbeddingsError
        ? error
        : new ManagedEmbeddingsError("invalid_response", "Managed embeddings request failed.", 0);
      if (this.cancelled || managedError.code === "request_cancelled") {
        return false;
      }
      const uniquePaths = [...new Set(batch.map(item => item.file.path))];
      for (const path of uniquePaths) {
        this.failedBatchPaths.add(path);
        this.failedBatchDetails.set(path, {
          code: managedError.code,
          message: managedError.message,
          status: managedError.status,
        });
      }
      this.fatalError = managedError;
      this.cancel();
      errorLogger.warn("Managed embeddings batch stopped", {
        source: "EmbeddingsProcessor",
        method: "processBatch",
        metadata: { batchIndex, batchSize: metadata.batchSize, code: managedError.code, status: managedError.status },
      });
      return false;
    }
  }


  private async finalizeFile(
    file: TFile,
    chunkCount: number,
    namespace: string,
    keepChunkIds: Set<number>,
    hadFailures: boolean
  ): Promise<void> {
    const rootId = buildVectorId(namespace, file.path, 0);
    const root = this.storage.getVectorSync(rootId);
    if (root) {
      const mtime = file.stat?.mtime || Date.now();
      const failedChunkCount = Math.max(0, chunkCount - keepChunkIds.size);
      const needsUpdate =
        (hadFailures ? root.metadata.complete !== false : root.metadata.complete !== true)
        || root.metadata.chunkCount !== chunkCount
        || root.metadata.title !== file.basename
        || root.metadata.mtime !== mtime
        || root.metadata.partial !== hadFailures
        || (hadFailures ? (root.metadata.failedChunkCount ?? 0) !== failedChunkCount : (root.metadata.failedChunkCount ?? 0) !== 0);

      if (needsUpdate) {
        await this.storage.storeVectors([{
          ...root,
          id: rootId,
          path: file.path,
          chunkId: 0,
          metadata: {
            ...root.metadata,
            title: file.basename,
            mtime,
            complete: hadFailures ? false : true,
            partial: hadFailures,
            failedChunkCount: failedChunkCount,
            chunkCount
          }
        }]);
      }
    }

    const keepIds = new Set<string>();
    for (const chunkId of keepChunkIds) {
      keepIds.add(buildVectorId(namespace, file.path, chunkId));
    }

    await this.storage.removeByPathExceptIds(file.path, namespace, keepIds);
  }

  private isReusableCandidate(
    vector: EmbeddingVector,
    expectedDimension: number | null
  ): boolean {
    if (!vector || !vector.metadata || vector.metadata.isEmpty === true) return false;
    if (vector.metadata.provider !== MANAGED_EMBEDDING_PROVIDER) return false;
    if (vector.metadata.model !== MANAGED_EMBEDDING_MODEL) return false;
    if (!isManagedNamespace(vector.metadata.namespace)) return false;

    const dim = vector.vector instanceof Float32Array ? vector.vector.length : 0;
    if (!Number.isFinite(dim) || dim <= 0) return false;
    if (expectedDimension && expectedDimension > 0 && dim !== expectedDimension) return false;
    if (vector.metadata.namespace !== buildManagedNamespace(dim)) return false;

    return true;
  }

  private buildMetadataRefreshVector(
    existing: EmbeddingVector,
    file: TFile,
    chunk: PreparedChunk,
    sectionTitle: string | undefined
  ): EmbeddingVector | null {
    const headingPath = Array.isArray(chunk.headingPath) ? [...chunk.headingPath] : [];
    const excerpt = this.buildExcerpt(chunk.text, sectionTitle);
    const mtime = file.stat?.mtime || Date.now();
    const dimension = existing.vector.length;
    const createdAt = typeof existing.metadata?.createdAt === 'number' ? existing.metadata.createdAt : Date.now();
    const namespace = buildManagedNamespace(dimension);
    const existingHeading = Array.isArray(existing.metadata?.headingPath) ? existing.metadata.headingPath : [];
    const headingChanged = this.headingPathChanged(existingHeading, headingPath);
    const sectionChanged = (existing.metadata?.sectionTitle || undefined) !== sectionTitle;
    const excerptChanged = (existing.metadata?.excerpt || '') !== excerpt;
    const titleChanged = (existing.metadata?.title || '') !== file.basename;
    const chunkLengthChanged = (existing.metadata?.chunkLength ?? null) !== chunk.length;
    const mtimeChanged = (existing.metadata?.mtime ?? null) !== mtime;
    const providerChanged = (existing.metadata?.provider || '') !== MANAGED_EMBEDDING_PROVIDER;
    const modelChanged = (existing.metadata?.model || '') !== MANAGED_EMBEDDING_MODEL;
    const namespaceChanged = (existing.metadata?.namespace || '') !== namespace;

    const needsUpdate = headingChanged
      || sectionChanged
      || excerptChanged
      || titleChanged
      || chunkLengthChanged
      || mtimeChanged
      || providerChanged
      || modelChanged
      || namespaceChanged;

    if (!needsUpdate) {
      return null;
    }

    const targetId = buildVectorId(namespace, file.path, chunk.index);
    return {
      ...existing,
      id: targetId,
      path: file.path,
      chunkId: chunk.index,
      metadata: {
        ...existing.metadata,
        title: file.basename,
        excerpt,
        mtime,
        contentHash: chunk.hash,
        provider: MANAGED_EMBEDDING_PROVIDER,
        model: MANAGED_EMBEDDING_MODEL,
        dimension,
        createdAt,
        namespace,
        sectionTitle,
        headingPath,
        chunkLength: chunk.length
      }
    };
  }

  private headingPathChanged(existing: string[] | undefined, incoming: string[]): boolean {
    const baseExisting = Array.isArray(existing) ? existing : [];
    if (baseExisting.length !== incoming.length) return true;
    for (let idx = 0; idx < incoming.length; idx++) {
      if (baseExisting[idx] !== incoming[idx]) return true;
    }
    return false;
  }

  private resolveProviderBatchLimit(provider: EmbeddingsProvider): number {
    try {
      const candidate = provider.getMaxBatchSize();
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.max(1, Math.floor(candidate));
      }
    } catch {
      // A malformed local limit must not change the managed contract limit.
    }
    return EmbeddingsProcessor.DEFAULT_MAX_TEXTS_PER_REQUEST;
  }

  /**
   * A dimension only becomes authoritative after a validated managed response.
   */
  private getExpectedDimensionHint(): number | null {
    const dimension = this.provider.expectedDimension;
    if (typeof dimension === 'number' && Number.isInteger(dimension) && dimension > 0) {
      return dimension;
    }
    return null;
  }

  private batchIdempotencyKey(metadata: EmbeddingBatchMetadata): string {
    return `emb:${this.runId}:${metadata.batchIndex ?? 0}`;
  }

  private createRunId(): string {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") {
      return randomUUID.call(globalThis.crypto).replace(/-/g, "").slice(0, 32);
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }

  private buildExcerpt(content: string, sectionTitle?: string): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    const base = normalized.length > 220 ? `${normalized.substring(0, 220)}...` : normalized;
    if (sectionTitle && sectionTitle.length > 0) {
      const heading = sectionTitle.length > 80 ? `${sectionTitle.substring(0, 77)}...` : sectionTitle;
      return `${heading} — ${base}`;
    }
    return base;
  }

  private buildBatchMetadata(
    batch: PendingChunkWork[],
    texts: string[],
    batchIndex: number
  ): EmbeddingBatchMetadata {
    const items = batch.map((item, idx) => {
      const processed = texts[idx] || '';
      const originalTokens = tokenCounter.estimateTokens(item.content);
      const processedTokens = tokenCounter.estimateTokens(processed);
      return {
        path: item.file.path,
        chunkId: item.chunkId,
        hash: item.hash,
        originalLength: item.content.length,
        processedLength: processed.length,
        originalEstimatedTokens: originalTokens,
        estimatedTokens: processedTokens,
        truncated: processed !== item.content
      };
    });

    const estimatedTotalTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    const maxEstimatedTokens = items.reduce((max, item) => Math.max(max, item.estimatedTokens), 0);
    const truncatedCount = items.reduce((count, item) => count + (item.truncated ? 1 : 0), 0);

    return {
      batchIndex,
      batchSize: batch.length,
      estimatedTotalTokens,
      maxEstimatedTokens,
      truncatedCount,
      items
    };
  }

  private enforceBatchSizeLimit(
    batches: PendingChunkWork[][],
    limit: number
  ): PendingChunkWork[][] {
    const bounded: PendingChunkWork[][] = [];
    const providerLimit = this.maxTextsPerRequest || EmbeddingsProcessor.DEFAULT_MAX_TEXTS_PER_REQUEST;
    const effectiveLimit = Math.max(1, Math.min(limit, providerLimit));
    for (const batch of batches) {
      if (batch.length <= effectiveLimit) {
        bounded.push(batch);
        continue;
      }

      for (let idx = 0; idx < batch.length; idx += effectiveLimit) {
        bounded.push(batch.slice(idx, idx + effectiveLimit));
      }
    }
    return bounded;
  }
}
