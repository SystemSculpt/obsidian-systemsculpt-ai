/**
 * VectorSearch - High-performance similarity search
 * 
 * Features:
 * - Optimized dot-product similarity (unit-normalized vectors)
 * - Efficient top-k selection
 * - Parallel search capabilities
 * - Result ranking and filtering
 */

import { EmbeddingVector, SearchResult } from '../types';
import { dot } from "../utils/vector";

export class VectorSearch {
  private readonly defaultMinSimilarity = 0.1;
  private readonly defaultChunkSize = 250;
  private readonly defaultYieldMs = 0;
  private readonly defaultExcerptLength = 200;
  private minSimilarity: number;
  private excerptLength: number;

  constructor() {
    this.minSimilarity = this.defaultMinSimilarity;
    this.excerptLength = this.defaultExcerptLength;
  }
  
  /**
   * Find similar vectors using dot product (assumes unit-normalized vectors)
   */
  findSimilar(
    queryVector: Float32Array,
    vectors: EmbeddingVector[],
    limit: number = 20
  ): SearchResult[] {
    if (vectors.length === 0) return [];
    if (!(queryVector instanceof Float32Array) || queryVector.length === 0) return [];
    const k = Math.max(0, Math.floor(limit));
    if (k === 0) return [];

    const top: Array<{ vector: EmbeddingVector; score: number }> = [];

    for (const vector of vectors) {
      if (vector.metadata.isEmpty) continue;
      if (vector.vector.length !== queryVector.length) continue;
      const score = dot(queryVector, vector.vector);
      if (score > this.minSimilarity) {
        this.insertTopK(top, { vector, score }, k);
      }
    }

    return top.map(item => this.toSearchResult(item));
  }

  /**
   * Non-blocking version of findSimilar that yields to the UI thread between chunks.
   * This prevents long freezes when searching large vector sets on the main thread.
   */
  async findSimilarAsync(
    queryVector: Float32Array,
    vectors: EmbeddingVector[],
    limit: number = 20,
    options?: { chunkSize?: number; yieldMs?: number; onProgress?: (processed: number, total: number) => void }
  ): Promise<SearchResult[]> {
    if (vectors.length === 0) return [];
    if (!(queryVector instanceof Float32Array) || queryVector.length === 0) return [];

    const k = Math.max(0, Math.floor(limit));
    if (k === 0) return [];

    const top: Array<{ vector: EmbeddingVector; score: number }> = [];
    const total = vectors.length;
    const chunkSize = options?.chunkSize && options.chunkSize > 0 ? options.chunkSize : this.defaultChunkSize;
    const yieldMs = options?.yieldMs ?? this.defaultYieldMs;

    for (let start = 0; start < total; start += chunkSize) {
      const end = Math.min(start + chunkSize, total);
      for (let i = start; i < end; i++) {
        const v = vectors[i];
        // Skip empty embeddings from small files
        if (v.metadata.isEmpty) continue;

        if (v.vector.length !== queryVector.length) continue;
        const score = dot(queryVector, v.vector);
        if (score > this.minSimilarity) {
          this.insertTopK(top, { vector: v, score }, k);
        }
      }

      if (options?.onProgress) options.onProgress(end, total);

      // Yield to the event loop so the UI remains responsive
      if (end < total) {
        await new Promise<void>((resolve) => setTimeout(resolve, yieldMs));
      }
    }

    return top.map(item => this.toSearchResult(item));
  }

  /**
   * Batch search for multiple queries
   */
  batchSearch(
    queryVectors: Float32Array[],
    vectors: EmbeddingVector[],
    limit: number = 20
  ): SearchResult[][] {
    return queryVectors.map(query => this.findSimilar(query, vectors, limit));
  }

  private insertTopK(
    top: Array<{ vector: EmbeddingVector; score: number }>,
    item: { vector: EmbeddingVector; score: number },
    k: number
  ): void {
    if (k <= 0) return;

    if (top.length === 0) {
      top.push(item);
      return;
    }

    if (top.length >= k && item.score <= top[top.length - 1].score) {
      return;
    }

    const insertPos = this.binarySearchInsertPos(top, item.score);
    top.splice(insertPos, 0, item);
    if (top.length > k) {
      top.pop();
    }
  }

  private binarySearchInsertPos(
    top: Array<{ score: number }>,
    score: number
  ): number {
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (top[mid].score > score) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Convert to search result format
   */
  private toSearchResult(item: { vector: EmbeddingVector; score: number }): SearchResult {
    const rawExcerpt = item.vector.metadata.excerpt || "";
    const excerpt = rawExcerpt.substring(0, this.excerptLength);
    const needsEllipsis = rawExcerpt.length > this.excerptLength;
    const baseExcerpt = needsEllipsis ? `${excerpt}...` : excerpt;
    const sectionTitle = item.vector.metadata.sectionTitle;
    const formattedExcerpt =
      sectionTitle && baseExcerpt && !baseExcerpt.startsWith(sectionTitle)
        ? `${sectionTitle} — ${baseExcerpt}`
        : baseExcerpt;
    return {
      path: item.vector.path,
      score: item.score,
      chunkId: typeof item.vector.chunkId === "number" ? item.vector.chunkId : undefined,
      metadata: {
        title: item.vector.metadata.title,
        excerpt: formattedExcerpt,
        lastModified: item.vector.metadata.mtime || Date.now(),
        sectionTitle
      }
    };
  }
}
