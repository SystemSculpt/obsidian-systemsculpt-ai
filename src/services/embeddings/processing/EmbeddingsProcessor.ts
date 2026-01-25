/**
 * EmbeddingsProcessor - High-performance batch processor
 * 
 * Features:
 * - Parallel processing with concurrency control
 * - Smart batching for optimal API usage
 * - Progress tracking and cancellation
 * - Error recovery and retry logic
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
import { buildNamespace, namespaceMatchesCurrentVersion, normalizeModelForNamespace, parseNamespace } from '../utils/namespace';
import { buildVectorId } from "../utils/vectorId";
import { normalizeInPlace, toFloat32Array } from '../utils/vector';
import { DEFAULT_EMBEDDING_DIMENSION } from '../../../constants/embeddings';
import { ContentPreprocessor, PreparedChunk } from "./ContentPreprocessor";
import { tokenCounter } from '../../../utils/TokenCounter';
import { errorLogger } from '../../../utils/errorLogger';
import { EmbeddingsProviderError, isEmbeddingsProviderError } from '../providers/ProviderError';

export interface ProcessorConfig {
  batchSize: number;
  maxConcurrency: number;
  rateLimitPerMinute?: number;
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
  private static readonly MAX_TRANSIENT_ERRORS = 10;
  private cancelled = false;
  private maxTextsPerRequest: number;
  private fatalError: EmbeddingsProviderError | null = null;
  private rateLimitMutex: Promise<void> = Promise.resolve();
  private lastRequestAt: number = 0;
  private failedBatchPaths: Set<string> = new Set();
  private failedBatchDetails: Map<string, FailedProcessingDetail> = new Map();
  private transientErrorCount: number = 0;
  private htmlForbiddenProbeMode: "unknown" | "content" | "global" = "unknown";
  private htmlForbiddenProbePromise: Promise<"content" | "global"> | null = null;

  constructor(
    private provider: EmbeddingsProvider,
    private storage: EmbeddingsStorage,
    private preprocessor: ContentPreprocessor,
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
    this.fatalError = null;
    this.failedBatchPaths.clear();
    this.failedBatchDetails.clear();
    this.transientErrorCount = 0;
    this.htmlForbiddenProbeMode = "unknown";
    this.htmlForbiddenProbePromise = null;
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

        const wafCheck = this.shouldSkipForWafPatterns(content);
        if (wafCheck.skip) {
          errorLogger.debug(`Skipping file with WAF-triggering content: ${file.path}`, {
            source: "EmbeddingsProcessor",
            method: "processFiles",
            providerId: this.provider.id,
            metadata: { path: file.path, signals: wafCheck.signals }
          });
          completedFiles += 1;
          reportProgress();
          continue;
        }

        const processed = this.preprocessor.process(content, file);

        // File too small - store empty embedding sentinel to mark as processed
        if (!processed) {
          const modelId = (this.provider as any).model || 'unknown';
          const dimension = this.getExpectedDimensionHint() || DEFAULT_EMBEDDING_DIMENSION;
          const namespace = buildNamespace(this.provider.id, modelId, dimension);
          const id = buildVectorId(namespace, file.path, 0);
          const emptyVector: EmbeddingVector = {
            id,
            path: file.path,
            chunkId: 0,
            vector: new Float32Array(dimension),
            metadata: {
              title: file.basename,
              excerpt: '',
              mtime: file.stat?.mtime || Date.now(),
              contentHash: 'empty',
              isEmpty: true,
              provider: this.provider.id,
              model: modelId,
              dimension,
              createdAt: Date.now(),
              namespace,
              complete: true,
              chunkCount: 0
            }
          };
          await this.storage.storeVectors([emptyVector]);
          keepChunkIdsByPath.set(file.path, new Set<number>([0]));
          namespaceByPath.set(file.path, namespace);
          pendingChunksByPath.set(file.path, 0);
          chunkCountsByPath.set(file.path, 0);
          await finalizePath(file.path);
          continue;
        }

        // Incremental: compute per-chunk hashes and reuse unchanged vectors
        const chunks = this.preprocessor.chunkContentWithHashes(
          processed.content,
          processed.source ?? content
        );

        if (chunks.length === 0) {
          const modelId = (this.provider as any).model || 'unknown';
          const dimension = this.getExpectedDimensionHint() || DEFAULT_EMBEDDING_DIMENSION;
          const namespace = buildNamespace(this.provider.id, modelId, dimension);
          const id = buildVectorId(namespace, file.path, 0);
          const sentinel: EmbeddingVector = {
            id,
            path: file.path,
            chunkId: 0,
            vector: new Float32Array(dimension),
            metadata: {
              title: file.basename,
              excerpt: '',
              mtime: file.stat?.mtime || Date.now(),
              contentHash: 'empty',
              isEmpty: true,
              provider: this.provider.id,
              model: modelId,
              dimension,
              createdAt: Date.now(),
              namespace,
              complete: true,
              chunkCount: 0
            }
          };
          await this.storage.storeVectors([sentinel]);
          keepChunkIdsByPath.set(file.path, new Set<number>([0]));
          namespaceByPath.set(file.path, namespace);
          pendingChunksByPath.set(file.path, 0);
          chunkCountsByPath.set(file.path, 0);
          await finalizePath(file.path);
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

        const rawModel = (this.provider as any).model || 'unknown';
        const currentModel = normalizeModelForNamespace(this.provider.id, rawModel);
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
          const findCandidateIndex = (requireCurrentSchema: boolean): number => {
            return candidates.findIndex((candidate) => {
              if (!this.isReusableCandidate(candidate, this.provider.id, currentModel, expectedDimension)) {
                return false;
              }
              if (!requireCurrentSchema) return true;
              return namespaceMatchesCurrentVersion(
                candidate.metadata?.namespace,
                this.provider.id,
                currentModel,
                expectedDimension || undefined
              );
            });
          };

          let candidateIndex = findCandidateIndex(true);
          if (candidateIndex < 0) {
            candidateIndex = findCandidateIndex(false);
          }

          let targetNamespace: string | null = null;
          let targetId: string | null = null;

          if (candidateIndex >= 0) {
            existing = candidates[candidateIndex];
            candidates.splice(candidateIndex, 1);
            vectorsByHash.set(chunk.hash, candidates);
            const dim = existing.vector instanceof Float32Array ? existing.vector.length : 0;
            targetNamespace = buildNamespace(this.provider.id, currentModel, dim);
            targetId = buildVectorId(targetNamespace, file.path, chunkId);

            namespaceByPath.set(file.path, targetNamespace);

            const existingNamespace = typeof existing.metadata?.namespace === "string" ? existing.metadata.namespace : "";
            if (existingNamespace === targetNamespace && existing.id !== targetId) {
              await this.storage.moveVectorId(existing.id, targetId, chunkId);
              existing = { ...existing, id: targetId, path: file.path, chunkId };
            }
          } else {
            if (expectedDimension && expectedDimension > 0) {
              targetNamespace = buildNamespace(this.provider.id, currentModel, expectedDimension);
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
            this.isReusableCandidate(existing, this.provider.id, currentModel, expectedDimension);

          if (existing && reusable) {
            const refresh = this.buildMetadataRefreshVector(existing, file, chunk, sectionTitle, currentModel);
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
        errorLogger.warn('Failed to prepare file for embeddings processing', {
          source: 'EmbeddingsProcessor',
          method: 'processFiles',
          providerId: this.provider.id,
          metadata: {
            path: file.path,
            message: error instanceof Error ? error.message : String(error)
          }
        });
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
  }

  /**
   * Set provider dynamically
   */
  setProvider(provider: EmbeddingsProvider): void {
    this.provider = provider;
    this.maxTextsPerRequest = this.resolveProviderBatchLimit(provider);
  }

  /**
   * Update processing configuration (batch size, concurrency, rate limiting).
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
	      // Log token statistics for this batch
	      const embeddings = await this.generateEmbeddingsWithHtmlForbiddenIsolation(batch, texts, metadata);
	      if (embeddings.length !== texts.length) {
	        throw new Error(`Embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`);
	      }

      const rawModel = (this.provider as any).model || "unknown";
      const modelId = normalizeModelForNamespace(this.provider.id, rawModel);

      // Create embedding vectors
      const vectors: EmbeddingVector[] = [];
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index];
        const raw = embeddings[index];
        if (!raw) {
          this.failedBatchPaths.add(item.file.path);
          if (!this.failedBatchDetails.has(item.file.path)) {
            const signals = this.detectWafSignals(item.content);
            this.failedBatchDetails.set(item.file.path, {
              code: "HOST_UNAVAILABLE",
              message: `Embeddings request blocked by gateway/WAF; skipped chunk ${item.chunkId}.`,
              chunkId: item.chunkId,
              sectionTitle: item.sectionTitle,
              headingPath: item.headingPath,
              signals,
            });
          }
          continue;
        }
        const vector = toFloat32Array(raw);
        const dimension = vector.length;
        if (!normalizeInPlace(vector)) {
          throw new Error(`Invalid embedding vector (zero-norm) for ${item.file.path}#${item.chunkId}`);
        }
        const namespace = buildNamespace(this.provider.id, modelId, dimension);
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
            provider: this.provider.id,
            model: modelId,
            dimension,
            createdAt: Date.now(),
            namespace,
            sectionTitle: item.sectionTitle,
            headingPath: item.headingPath,
	            chunkLength: item.length
	          }
	        } as EmbeddingVector);
	      }

      // Store embeddings
      if (vectors.length > 0) {
        await this.storage.storeVectors(vectors);
      }
      return true;

    } catch (error) {
      const detailsMetadata = metadata;
      const providerError = isEmbeddingsProviderError(error)
        ? error
        : new EmbeddingsProviderError(
            error instanceof Error ? error.message : String(error),
            {
              code: "UNEXPECTED_RESPONSE",
              providerId: this.provider.id,
              transient: false,
              details: { batchIndex, kind: "unexpected", errorType: (error as any)?.constructor?.name },
              cause: error
            }
          );

      const uniquePaths = [...new Set(batch.map(item => item.file.path))];
      const action = this.handleBatchError(providerError, uniquePaths, batchIndex, detailsMetadata);

      if (action === 'stop') {
        const maxPaths = 40;
        const fileList = uniquePaths.length > maxPaths
          ? [...uniquePaths.slice(0, maxPaths), `(+${uniquePaths.length - maxPaths} more)`]
          : uniquePaths;
        const summary = fileList.join(', ').slice(0, 1400);

        errorLogger.error(`Embeddings batch failed with fatal error; stopping. Files: ${summary}`, providerError, {
          source: 'EmbeddingsProcessor',
          method: 'processBatch',
          providerId: this.provider.id,
          metadata: {
            batchIndex,
            batchSize: detailsMetadata.batchSize,
            uniqueFiles: uniquePaths.length,
            estimatedTotalTokens: detailsMetadata.estimatedTotalTokens,
            maxEstimatedTokens: detailsMetadata.maxEstimatedTokens,
            truncatedCount: detailsMetadata.truncatedCount,
            items: detailsMetadata.items.slice(0, 10),
            files: fileList,
            status: providerError.status,
            code: providerError.code,
            endpoint: providerError.endpoint,
            retryInMs: providerError.retryInMs
          }
        });
      }
      return false;
    }
  }

  private isHtmlForbiddenError(error: EmbeddingsProviderError): boolean {
    if (error.status !== 403) return false;

    const details: any = error.details as any;
    const kind = typeof details?.kind === "string" ? details.kind : "";
    if (kind === "html-response") return true;
    const sample = typeof details?.sample === "string" ? details.sample : "";
    if (sample.trim().startsWith("<")) return true;
    const text = typeof details?.text === "string" ? details.text : "";
    if (text.trim().startsWith("<")) return true;

    const msg = (error.message || "").toLowerCase();
    return msg.includes("received html") && msg.includes("403");
  }

  private static readonly WAF_BLOCK_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: "phpunit", pattern: /\bphpunit\b/i },
    { name: "eval-stdin", pattern: /eval-stdin/i },
    { name: "traversal", pattern: /\.\.(\/|\\)|%2e%2e|%252e%252e/i },
    { name: "php-exploit", pattern: /\\think\\app|invokefunction|call_user_func|pearcmd/i },
    { name: "wp-exploit", pattern: /wp-file-manager.*connector|wp-content.*plugins.*php/i },
    { name: "fortinet-exploit", pattern: /fgt_lang.*sslvpn|cmdb.*sslvpn/i },
  ];

  private shouldSkipForWafPatterns(text: string): { skip: boolean; signals: string[] } {
    const signals: string[] = [];
    for (const { name, pattern } of EmbeddingsProcessor.WAF_BLOCK_PATTERNS) {
      if (pattern.test(text)) {
        signals.push(name);
      }
    }
    return { skip: signals.length > 0, signals };
  }

  private detectWafSignals(text: string): string[] {
    const signals: string[] = [];
    const push = (name: string, condition: boolean) => {
      if (condition) signals.push(name);
    };

    push("pem", /-----BEGIN [^-]{0,80}-----/i.test(text));
    push("ssh-key", /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{80,}/.test(text));
    push("jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text));
    push("base64", /[A-Za-z0-9+/]{200,}={0,2}/.test(text));

    push("phpunit", /\bphpunit\b/i.test(text));
    push("sqlmap", /\bsqlmap\b/i.test(text));
    push("nmap", /\bnmap\b/i.test(text));
    push("metasploit", /\bmetasploit\b/i.test(text));
    push("hashcat", /\bhashcat\b/i.test(text));
    push("hydra", /\bhydra\b/i.test(text));

    push("script-tag", /<\s*\/?\s*script\b/i.test(text));
    push("php-tag", /<\?\s*php/i.test(text));
    push("traversal", /\.\.(\/|\\)/.test(text));
    push("union-select", /\bunion\s+select\b/i.test(text));
    push("base64_decode", /\bbase64_decode\b/i.test(text));

    push("openai-key", /\bsk-[A-Za-z0-9]{20,}\b/.test(text));
    push("gh-token", /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text));
    push("bearer", /\bBearer\s+[A-Za-z0-9._-]{30,}\b/i.test(text));

    push("cve", /\bCVE-\d{4}-\d{3,7}\b/i.test(text));
    push("curl", /\bcurl\b/i.test(text));
    push("wget", /\bwget\b/i.test(text));
    push("powershell", /\bpowershell\b/i.test(text));
    push("cmd", /\bcmd\.exe\b/i.test(text));
    push("rm-rf", /\brm\s+-rf\b/i.test(text));
    push("chmod", /\bchmod\b/i.test(text));
    push("chown", /\bchown\b/i.test(text));
    push("etc-passwd", /\/etc\/passwd\b/i.test(text));
    push("xss", /\bxss\b/i.test(text));
    push("csrf", /\bcsrf\b/i.test(text));
    push("sql-injection", /\bsql\s+injection\b/i.test(text));

    return signals;
  }

  private formatWafSignalsLabel(signals: string[]): string {
    if (!Array.isArray(signals) || signals.length === 0) return "";
    const maxSignals = 6;
    const clipped = signals.slice(0, maxSignals);
    const suffix = signals.length > maxSignals ? ` +${signals.length - maxSignals}` : "";
    return ` (${clipped.join(", ")}${suffix})`;
  }

  private async classifyHtmlForbiddenMode(): Promise<"content" | "global"> {
    if (this.htmlForbiddenProbeMode !== "unknown") {
      return this.htmlForbiddenProbeMode;
    }
    if (this.htmlForbiddenProbePromise) {
      return await this.htmlForbiddenProbePromise;
    }

    this.htmlForbiddenProbePromise = (async () => {
      try {
        await this.enforceRateLimit();
        const probe = await this.provider.generateEmbeddings(["hello"], { inputType: "document" });
        if (Array.isArray(probe) && probe.length === 1) {
          this.htmlForbiddenProbeMode = "content";
          return "content";
        }
      } catch {
        this.htmlForbiddenProbeMode = "global";
        return "global";
      } finally {
        this.htmlForbiddenProbePromise = null;
      }

      this.htmlForbiddenProbeMode = "global";
      return "global";
    })();

    return await this.htmlForbiddenProbePromise;
  }

  private async generateEmbeddingsWithHtmlForbiddenIsolation(
    batch: PendingChunkWork[],
    texts: string[],
    metadata: EmbeddingBatchMetadata
  ): Promise<Array<number[] | null>> {
    await this.enforceRateLimit();
    if (this.cancelled) return texts.map(() => null);

    try {
      const embeddings = await this.provider.generateEmbeddings(texts, { inputType: "document", batchMetadata: metadata });
      if (embeddings.length !== texts.length) {
        throw new Error(`Embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`);
      }
      return embeddings;
    } catch (error) {
      const providerError = isEmbeddingsProviderError(error)
        ? error
        : new EmbeddingsProviderError(
            error instanceof Error ? error.message : String(error),
            {
              code: "UNEXPECTED_RESPONSE",
              providerId: this.provider.id,
              transient: false,
              details: { batchSize: texts.length, kind: "unexpected", errorType: (error as any)?.constructor?.name },
              cause: error,
            }
          );

      if (!this.isHtmlForbiddenError(providerError)) {
        throw providerError;
      }

      const mode = await this.classifyHtmlForbiddenMode();
      if (mode === "global") {
        throw providerError;
      }

      if (batch.length <= 1) {
        const only = batch[0];
        if (only) {
          const signals = this.detectWafSignals(only.content);
          this.failedBatchPaths.add(only.file.path);
          this.failedBatchDetails.set(only.file.path, {
            code: providerError.code,
            message: `Embeddings request blocked by gateway/WAF (HTML 403) for chunk ${only.chunkId}. Consider excluding this note or removing exploit-signature strings and retrying.`,
            status: providerError.status,
            retryInMs: providerError.retryInMs,
            chunkId: only.chunkId,
            sectionTitle: only.sectionTitle,
            headingPath: only.headingPath,
            signals,
          });
          errorLogger.warn(
            `Embeddings chunk blocked by gateway/WAF; skipping ${only.file.path}#${only.chunkId}${this.formatWafSignalsLabel(signals)}`,
            {
              source: "EmbeddingsProcessor",
              method: "processBatch",
              providerId: this.provider.id,
              metadata: {
                path: only.file.path,
                chunkId: only.chunkId,
                sectionTitle: only.sectionTitle,
                headingPath: only.headingPath,
                signals,
                status: providerError.status,
                code: providerError.code,
              },
            }
          );
        }
        return [null];
      }

      const mid = Math.ceil(batch.length / 2);
      const leftBatch = batch.slice(0, mid);
      const leftTexts = texts.slice(0, mid);
      const rightBatch = batch.slice(mid);
      const rightTexts = texts.slice(mid);

      const leftMeta = this.buildBatchMetadata(leftBatch, leftTexts, metadata.batchIndex ?? 0);
      const rightMeta = this.buildBatchMetadata(rightBatch, rightTexts, metadata.batchIndex ?? 0);

      const leftEmbeddings = await this.generateEmbeddingsWithHtmlForbiddenIsolation(leftBatch, leftTexts, leftMeta);
      const rightEmbeddings = await this.generateEmbeddingsWithHtmlForbiddenIsolation(rightBatch, rightTexts, rightMeta);
      return [...leftEmbeddings, ...rightEmbeddings];
    }
  }

  private handleBatchError(
    error: EmbeddingsProviderError,
    affectedPaths: string[],
    batchIndex: number,
    metadata: EmbeddingBatchMetadata
  ): 'continue' | 'stop' {
    const isFatal = !error.transient || error.licenseRelated;

    if (isFatal) {
      this.fatalError = error;
      this.cancel();
      return 'stop';
    }

    const shouldStopForGlobalBackoff = error.code === "HOST_UNAVAILABLE"
      || error.code === "RATE_LIMITED"
      || error.status === 429
      || (typeof error.retryInMs === "number" && error.retryInMs > 0);

    // Provider-wide cooldown/rate-limit/host disablement errors are not "try next file" errors.
    // Stop immediately so the manager can schedule a retry instead of spamming warnings.
    if (shouldStopForGlobalBackoff) {
      this.fatalError = error;
      this.cancel();
      return 'stop';
    }

    this.transientErrorCount++;
    for (const path of affectedPaths) {
      this.failedBatchPaths.add(path);
      if (!this.failedBatchDetails.has(path)) {
        this.failedBatchDetails.set(path, {
          code: error.code,
          message: error.message,
          status: error.status,
          retryInMs: error.retryInMs
        });
      }
    }

    if (this.transientErrorCount >= EmbeddingsProcessor.MAX_TRANSIENT_ERRORS) {
      const aggregateError = new EmbeddingsProviderError(
        `Too many transient errors (${this.transientErrorCount}). Stopping to prevent further issues.`,
        {
          code: "UNEXPECTED_RESPONSE",
          providerId: this.provider.id,
          transient: false,
          details: { transientErrorCount: this.transientErrorCount, lastErrorCode: error.code }
        }
      );
      this.fatalError = aggregateError;
      this.cancel();

      errorLogger.error('Embeddings processing stopped due to excessive transient errors', aggregateError, {
        source: 'EmbeddingsProcessor',
        method: 'handleBatchError',
        providerId: this.provider.id,
        metadata: {
          transientErrorCount: this.transientErrorCount,
          totalFailedFiles: this.failedBatchPaths.size,
          lastBatchIndex: batchIndex
        }
      });
      return 'stop';
    }

    errorLogger.warn('Transient batch error, continuing with remaining files', {
      source: 'EmbeddingsProcessor',
      method: 'handleBatchError',
      providerId: this.provider.id,
      metadata: {
        batchIndex,
        errorCode: error.code,
        errorMessage: error.message,
        transientErrorCount: this.transientErrorCount,
        affectedFiles: affectedPaths.length,
        batchSize: metadata.batchSize
      }
    });

    return 'continue';
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      const needsUpdate =
        (hadFailures ? root.metadata.complete !== false : root.metadata.complete !== true)
        || root.metadata.chunkCount !== chunkCount
        || root.metadata.title !== file.basename
        || root.metadata.mtime !== mtime;

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

  private resolveProviderAndModel(vector: EmbeddingVector): { provider: string; model: string } {
    const metadata: any = vector?.metadata as any;
    const rawProvider = typeof metadata?.provider === "string" ? metadata.provider.trim() : "";
    const rawModel = typeof metadata?.model === "string" ? metadata.model.trim() : "";

    if (rawProvider && rawModel) {
      return {
        provider: rawProvider,
        model: normalizeModelForNamespace(rawProvider, rawModel),
      };
    }

    const parsed = parseNamespace(typeof metadata?.namespace === "string" ? metadata.namespace : "");
    const provider = rawProvider || parsed?.provider || "unknown";
    const model = normalizeModelForNamespace(provider, rawModel || parsed?.model || "unknown");
    return { provider, model };
  }

  private isReusableCandidate(
    vector: EmbeddingVector,
    providerId: string,
    normalizedModel: string,
    expectedDimension: number | null
  ): boolean {
    if (!vector || !vector.metadata || vector.metadata.isEmpty === true) return false;

    const resolved = this.resolveProviderAndModel(vector);
    if (resolved.provider !== providerId) return false;
    if (resolved.model !== normalizedModel) return false;

    const dim = vector.vector instanceof Float32Array ? vector.vector.length : 0;
    if (!Number.isFinite(dim) || dim <= 0) return false;
    if (expectedDimension && expectedDimension > 0 && dim !== expectedDimension) return false;

    return true;
  }

  private buildMetadataRefreshVector(
    existing: EmbeddingVector,
    file: TFile,
    chunk: PreparedChunk,
    sectionTitle: string | undefined,
    currentModel: string
  ): EmbeddingVector | null {
    const headingPath = Array.isArray(chunk.headingPath) ? [...chunk.headingPath] : [];
    const excerpt = this.buildExcerpt(chunk.text, sectionTitle);
    const mtime = file.stat?.mtime || Date.now();
    const dimension = existing.vector.length;
    const createdAt = typeof existing.metadata?.createdAt === 'number' ? existing.metadata.createdAt : Date.now();
    const namespace = buildNamespace(this.provider.id, currentModel, dimension);
    const existingHeading = Array.isArray(existing.metadata?.headingPath) ? existing.metadata.headingPath as string[] : [];
    const headingChanged = this.headingPathChanged(existingHeading, headingPath);
    const sectionChanged = (existing.metadata?.sectionTitle || undefined) !== sectionTitle;
    const excerptChanged = (existing.metadata?.excerpt || '') !== excerpt;
    const titleChanged = (existing.metadata?.title || '') !== file.basename;
    const chunkLengthChanged = (existing.metadata?.chunkLength ?? null) !== chunk.length;
    const mtimeChanged = (existing.metadata?.mtime ?? null) !== mtime;
    const providerChanged = (existing.metadata?.provider || '') !== this.provider.id;
    const modelChanged = (existing.metadata?.model || '') !== currentModel;
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
        provider: this.provider.id,
        model: currentModel,
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
      const candidate = typeof provider.getMaxBatchSize === 'function'
        ? provider.getMaxBatchSize()
        : undefined;
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.max(1, Math.floor(candidate));
      }
    } catch {
      // Ignore provider errors and fall back to default limit.
    }
    return EmbeddingsProcessor.DEFAULT_MAX_TEXTS_PER_REQUEST;
  }

  /**
   * Best-effort expected embedding dimension for the active provider.
   * Uses provider hint when available, otherwise the SystemSculpt default.
   */
  private getExpectedDimensionHint(): number | null {
    const providerAny: any = this.provider as any;
    if (typeof providerAny.expectedDimension === 'number' && providerAny.expectedDimension > 0) {
      return providerAny.expectedDimension;
    }
    if (providerAny.id === 'systemsculpt') {
      return DEFAULT_EMBEDDING_DIMENSION;
    }
    return null;
  }

  private async enforceRateLimit(): Promise<void> {
    const limit = this.config.rateLimitPerMinute;
    if (!limit || limit <= 0) return;

    const previous = this.rateLimitMutex;
    let release: () => void;
    this.rateLimitMutex = new Promise<void>(resolve => { release = resolve; });

    await previous;

    const minIntervalMs = Math.max(1, Math.ceil(60000 / limit));
    const now = Date.now();
    const nextAllowedAt = this.lastRequestAt > 0 ? this.lastRequestAt + minIntervalMs : 0;
    const waitMs = Math.max(0, nextAllowedAt - now);
    if (waitMs > 0) {
      await this.delay(waitMs);
    }
    this.lastRequestAt = Date.now();
    release!();
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
