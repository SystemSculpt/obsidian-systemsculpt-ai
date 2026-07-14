/**
 * EmbeddingsProcessor - High-performance batch processor
 * 
 * Features:
 * - Bounded managed dispatch
 * - Published-limit managed batching
 * - Progress tracking and cancellation
 * - One managed dispatch per prepared batch
 */

import { App, TFile } from 'obsidian';
import {
  EmbeddingVector,
  ProcessingProgress,
  ProcessingResult,
  FailedProcessingDetail,
  ManagedEmbeddingsGateway
} from '../types';
import { EmbeddingsStorage } from '../storage/EmbeddingsStorage';
import {
  buildManagedNamespace,
  isManagedNamespace,
} from '../utils/namespace';
import { buildVectorId } from "../utils/vectorId";
import { normalizeInPlace, toFloat32Array } from '../utils/vector';
import { ContentPreprocessor, PreparedChunk } from "./ContentPreprocessor";
import { errorLogger } from '../../../utils/errorLogger';
import { ManagedEmbeddingsError } from '../gateway/ManagedEmbeddingsAdapter';
import {
  createLocalEmptyEmbeddingMarkerForRevision,
  isLocalEmptyEmbeddingMarker,
} from "../LocalEmptyEmbeddingMarker";
import { MANAGED_EMBEDDING_LIMITS } from "../ManagedEmbeddingsContract";

type PendingChunkWork = {
  revision: EmbeddingSourceRevision;
  content: string;
  hash: string;
  chunkId: number;
  sectionTitle?: string;
  headingPath?: string[];
  length: number;
};

/** Stable source identity captured before remote inference begins. */
export interface EmbeddingSourceRevision {
  path: string;
  basename: string;
  mtime: number;
}

export interface EmbeddingsProcessingOptions {
  sourceRevisions?: ReadonlyMap<TFile, EmbeddingSourceRevision>;
}

export class EmbeddingsProcessor {
  private cancelled = false;
  private failedBatchPaths: Set<string> = new Set();
  private failedBatchDetails: Map<string, FailedProcessingDetail> = new Map();
  private operationController = new AbortController();
  private runId = "";

  constructor(
    private readonly gateway: ManagedEmbeddingsGateway,
    private readonly storage: EmbeddingsStorage,
    private readonly preprocessor: ContentPreprocessor,
  ) {}

  /**
   * Process files with progress tracking
   */
  async processFiles(
    files: TFile[],
    app: App,
    onProgress?: (progress: ProcessingProgress) => void,
    options: EmbeddingsProcessingOptions = {},
  ): Promise<ProcessingResult> {
    this.cancelled = false;
    this.operationController = new AbortController();
    this.runId = this.createRunId();
    this.failedBatchPaths.clear();
    this.failedBatchDetails.clear();
    const totalFiles = files.length;
    const limits = this.gateway.limits ?? MANAGED_EMBEDDING_LIMITS;
    const safeBatchSize = Math.max(1, limits.maxTexts);
    const maxConcurrency = 1;
    const flushThreshold = Math.max(safeBatchSize * maxConcurrency * 6, safeBatchSize * 4);

    let completedFiles = 0;
    const completedPaths = new Set<string>();

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
    const sourceByPath = new Map<string, EmbeddingSourceRevision>();

    const finalizePath = async (path: string): Promise<void> => {
      const keepChunkIds = keepChunkIdsByPath.get(path);
      const namespace = namespaceByPath.get(path);
      const source = sourceByPath.get(path);
      const chunkCount = chunkCountsByPath.get(path) ?? 0;
      const hadFailures = this.failedBatchPaths.has(path);

      // Remove bookkeeping before awaiting to avoid double-finalize.
      pendingChunksByPath.delete(path);
      keepChunkIdsByPath.delete(path);
      namespaceByPath.delete(path);
      chunkCountsByPath.delete(path);
      sourceByPath.delete(path);

      if (!source || !keepChunkIds || !namespace) {
        return;
      }

      await this.finalizeFile(source, chunkCount, namespace, keepChunkIds, hadFailures);
      completedPaths.add(path);
      completedFiles += 1;
      reportProgress();
    };

    let nextBatchIndex = 0;

    const flushPendingWork = async (): Promise<void> => {
      if (pendingWork.length === 0 || this.cancelled) return;

      const work = pendingWork.splice(0, pendingWork.length);
      const batches: PendingChunkWork[][] = [];
      let batch: PendingChunkWork[] = [];
      let batchChars = 0;
      for (const item of work) {
        const exceedsCount = batch.length >= safeBatchSize;
        const exceedsChars = batch.length > 0
          && batchChars + item.content.length > limits.maxTotalChars;
        if (exceedsCount || exceedsChars) {
          batches.push(batch);
          batch = [];
          batchChars = 0;
        }
        batch.push(item);
        batchChars += item.content.length;
      }
      if (batch.length > 0) batches.push(batch);

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
              const path = item.revision.path;
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
      const revision = options.sourceRevisions?.get(file) ?? this.captureSourceRevision(file);
      const path = revision.path;
      sourceByPath.set(path, revision);

      try {
        const content = await app.vault.read(file);

        const processed = this.preprocessor.process(content, file);

        if (!processed) {
          await this.sealLocallyEmptyFile(revision, content);
          sourceByPath.delete(path);
          completedPaths.add(path);
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
          await this.sealLocallyEmptyFile(revision, content);
          sourceByPath.delete(path);
          completedPaths.add(path);
          completedFiles += 1;
          reportProgress();
          continue;
        }

        const existingVectors = await this.storage.getVectorsByPath(path);
        const localEmptyMarkerIds = existingVectors
          .filter(isLocalEmptyEmbeddingMarker)
          .map((vector) => vector.id);
        if (localEmptyMarkerIds.length > 0) {
          await this.storage.removeIds(localEmptyMarkerIds);
        }
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
            targetId = buildVectorId(targetNamespace, path, chunkId);

            namespaceByPath.set(path, targetNamespace);

            const existingNamespace = typeof existing.metadata?.namespace === "string" ? existing.metadata.namespace : "";
            if (existingNamespace === targetNamespace && existing.id !== targetId) {
              await this.storage.moveVectorId(existing.id, targetId, chunkId);
              existing = { ...existing, id: targetId, path, chunkId };
            }
          } else {
            if (expectedDimension && expectedDimension > 0) {
              targetNamespace = buildManagedNamespace(expectedDimension);
              targetId = buildVectorId(targetNamespace, path, chunkId);
              existing = this.storage.getVectorSync(targetId);
              if (targetNamespace) {
                namespaceByPath.set(path, targetNamespace);
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
            const refresh = this.buildMetadataRefreshVector(existing, revision, chunk, sectionTitle);
            if (refresh) {
              metadataUpdates.push(refresh);
              if (existing.id !== refresh.id) {
                idsToRemove.push(existing.id);
              }
            }
            continue;
          }

          pendingWork.push({
            revision,
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

        if (pendingCount > 0) {
          const activeNamespace = this.gateway.activeGeneration?.indexNamespace;
          const activeRoot = existingVectors.find((vector) => (
            (vector.chunkId ?? 0) === 0
            && vector.metadata.namespace === activeNamespace
            && vector.metadata.isEmpty !== true
          ));
          if (activeRoot?.metadata.complete === true) {
            await this.storage.storeVectors([{
              ...activeRoot,
              metadata: { ...activeRoot.metadata, complete: false, partial: true },
            }]);
          }
        }

        keepChunkIdsByPath.set(path, keepChunkIds);
        pendingChunksByPath.set(path, pendingCount);
        chunkCountsByPath.set(path, chunks.length);

        if (pendingCount === 0) {
          await finalizePath(path);
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
        this.failedBatchPaths.add(path);
        this.failedBatchDetails.set(path, {
          code: failure.code,
          message: failure.message,
          status: failure.status,
        });
        errorLogger.warn('Failed to prepare file for embeddings processing', {
          source: 'EmbeddingsProcessor',
          method: 'processFiles',
          metadata: {
            path,
            message: error instanceof Error ? error.message : String(error)
          }
        });
        pendingChunksByPath.delete(path);
        keepChunkIdsByPath.delete(path);
        namespaceByPath.delete(path);
        chunkCountsByPath.delete(path);
        sourceByPath.delete(path);
        continue;
      }
    }

    if (!this.cancelled) {
      await flushPendingWork();
    }

    const failedPaths = Array.from(this.failedBatchPaths);
    for (const path of failedPaths) {
      // A failed note is removed rather than leaving a stale complete root searchable.
      await this.storage.removeByPath(path);
    }
    const result: ProcessingResult = {
      completed: completedFiles,
      completedPaths: [...completedPaths],
      failed: failedPaths.length,
      failedPaths,
      cancelled: this.cancelled,
      fatalError: null,
      failedDetails: this.failedBatchDetails.size > 0 ? Object.fromEntries(this.failedBatchDetails.entries()) : undefined,
    };

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
    if (batch.every((item) => this.failedBatchPaths.has(item.revision.path))) return false;

    const texts = batch.map((item) => item.content);
    errorLogger.debug('Embeddings batch prepared', {
      source: 'EmbeddingsProcessor',
      method: 'processBatch',
      metadata: {
        batchIndex,
        batchSize: batch.length,
        sampleItems: batch.slice(0, 10).map((item) => ({
          path: item.revision.path,
          chunkId: item.chunkId,
          hash: item.hash,
          length: item.content.length,
        })),
      }
    });

    try {
      const embeddings = await this.gateway.generateEmbeddings(texts, {
        idempotencyKey: this.batchIdempotencyKey(batchIndex),
        signal: this.operationController.signal,
      });
      if (this.cancelled) return false;
      if (embeddings.length !== texts.length) {
        throw new ManagedEmbeddingsError("invalid_response", "Embedding count mismatch.", 200);
      }
      const generation = this.gateway.activeGeneration;
      const namespace = generation?.indexNamespace;
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
        const id = buildVectorId(namespace, item.revision.path, item.chunkId);
        const excerpt = this.buildExcerpt(item.content, item.sectionTitle);

        namespaceByPath.set(item.revision.path, namespace);
        vectors.push({
          id,
          path: item.revision.path,
          chunkId: item.chunkId,
          vector,
          metadata: {
            title: item.revision.basename,
            excerpt,
            mtime: item.revision.mtime,
            contentHash: item.hash,
            generation: generation.id,
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
      const uniquePaths = [...new Set(batch.map((item) => item.revision.path))];
      for (const path of uniquePaths) {
        this.failedBatchPaths.add(path);
        this.failedBatchDetails.set(path, {
          code: managedError.code,
          message: managedError.message,
          status: managedError.status,
        });
      }
      errorLogger.warn("Managed embeddings batch stopped", {
        source: "EmbeddingsProcessor",
        method: "processBatch",
        metadata: { batchIndex, batchSize: batch.length, code: managedError.code, status: managedError.status },
      });
      return false;
    }
  }

  private async sealLocallyEmptyFile(revision: EmbeddingSourceRevision, source: string): Promise<void> {
    await this.storage.removeByPath(revision.path);
    await this.storage.storeVectors([createLocalEmptyEmbeddingMarkerForRevision(revision, source)]);
  }


  private async finalizeFile(
    revision: EmbeddingSourceRevision,
    chunkCount: number,
    namespace: string,
    keepChunkIds: Set<number>,
    hadFailures: boolean
  ): Promise<void> {
    const rootId = buildVectorId(namespace, revision.path, 0);
    const root = this.storage.getVectorSync(rootId);
    let finalizedRoot: EmbeddingVector | null = root;
    if (root) {
      const failedChunkCount = Math.max(0, chunkCount - keepChunkIds.size);
      const needsUpdate =
        (hadFailures ? root.metadata.complete !== false : root.metadata.complete !== true)
        || root.metadata.chunkCount !== chunkCount
        || root.metadata.title !== revision.basename
        || root.metadata.mtime !== revision.mtime
        || root.metadata.partial !== hadFailures
        || (hadFailures ? (root.metadata.failedChunkCount ?? 0) !== failedChunkCount : (root.metadata.failedChunkCount ?? 0) !== 0);

      if (needsUpdate) {
        finalizedRoot = {
          ...root,
          id: rootId,
          path: revision.path,
          chunkId: 0,
          metadata: {
            ...root.metadata,
            title: revision.basename,
            mtime: revision.mtime,
            complete: hadFailures ? false : true,
            partial: hadFailures,
            failedChunkCount: failedChunkCount,
            chunkCount
          }
        };
      }
    }

    const keepIds = new Set<string>();
    for (const chunkId of keepChunkIds) {
      keepIds.add(buildVectorId(namespace, revision.path, chunkId));
    }

    if (finalizedRoot) {
      const finalizer = (this.storage as EmbeddingsStorage & {
        finalizePath?: EmbeddingsStorage["finalizePath"];
      }).finalizePath;
      if (typeof finalizer === "function") {
        await finalizer.call(this.storage, revision.path, namespace, finalizedRoot, keepIds);
      } else {
        await this.storage.storeVectors([finalizedRoot]);
        await this.storage.removeByPathExceptIds(revision.path, namespace, keepIds);
      }
    } else {
      await this.storage.removeByPathExceptIds(revision.path, namespace, keepIds);
    }
  }

  private isReusableCandidate(
    vector: EmbeddingVector,
    expectedDimension: number | null
  ): boolean {
    if (!vector || !vector.metadata || vector.metadata.isEmpty === true) return false;
    const generationId = this.gateway.activeGeneration?.id;
    if (!generationId || vector.metadata.generation !== generationId) return false;
    if (!isManagedNamespace(vector.metadata.namespace)) return false;

    const dim = vector.vector instanceof Float32Array ? vector.vector.length : 0;
    if (!Number.isFinite(dim) || dim <= 0) return false;
    if (expectedDimension && expectedDimension > 0 && dim !== expectedDimension) return false;
    if (vector.metadata.namespace !== buildManagedNamespace(dim)) return false;

    return true;
  }

  private buildMetadataRefreshVector(
    existing: EmbeddingVector,
    revision: EmbeddingSourceRevision,
    chunk: PreparedChunk,
    sectionTitle: string | undefined
  ): EmbeddingVector | null {
    const headingPath = Array.isArray(chunk.headingPath) ? [...chunk.headingPath] : [];
    const excerpt = this.buildExcerpt(chunk.text, sectionTitle);
    const dimension = existing.vector.length;
    const createdAt = typeof existing.metadata?.createdAt === 'number' ? existing.metadata.createdAt : Date.now();
    const namespace = buildManagedNamespace(dimension);
    const existingHeading = Array.isArray(existing.metadata?.headingPath) ? existing.metadata.headingPath : [];
    const headingChanged = this.headingPathChanged(existingHeading, headingPath);
    const sectionChanged = (existing.metadata?.sectionTitle || undefined) !== sectionTitle;
    const excerptChanged = (existing.metadata?.excerpt || '') !== excerpt;
    const titleChanged = (existing.metadata?.title || '') !== revision.basename;
    const chunkLengthChanged = (existing.metadata?.chunkLength ?? null) !== chunk.length;
    const mtimeChanged = (existing.metadata?.mtime ?? null) !== revision.mtime;
    const generationChanged = existing.metadata?.generation !== this.gateway.activeGeneration?.id;
    const namespaceChanged = (existing.metadata?.namespace || '') !== namespace;

    const needsUpdate = headingChanged
      || sectionChanged
      || excerptChanged
      || titleChanged
      || chunkLengthChanged
      || mtimeChanged
      || generationChanged
      || namespaceChanged;

    if (!needsUpdate) {
      return null;
    }

    const targetId = buildVectorId(namespace, revision.path, chunk.index);
    return {
      ...existing,
      id: targetId,
      path: revision.path,
      chunkId: chunk.index,
      metadata: {
        ...existing.metadata,
        title: revision.basename,
        excerpt,
        mtime: revision.mtime,
        contentHash: chunk.hash,
        generation: this.gateway.activeGeneration?.id,
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

  private captureSourceRevision(file: TFile): EmbeddingSourceRevision {
    return {
      path: file.path,
      basename: file.basename,
      mtime: typeof file.stat?.mtime === "number" ? file.stat.mtime : Date.now(),
    };
  }

  /**
   * A dimension only becomes authoritative after a validated managed response.
   */
  private getExpectedDimensionHint(): number | null {
    const dimension = this.gateway.expectedDimension;
    if (typeof dimension === 'number' && Number.isInteger(dimension) && dimension > 0) {
      return dimension;
    }
    return null;
  }

  private batchIdempotencyKey(batchIndex: number): string {
    return `emb:${this.runId}:${batchIndex}`;
  }

  private createRunId(): string {
    const randomUUID = window.crypto?.randomUUID;
    if (typeof randomUUID === "function") {
      return randomUUID.call(window.crypto).replace(/-/g, "").slice(0, 32);
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

}
