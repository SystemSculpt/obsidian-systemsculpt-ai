/**
 * TokenEstimator - Estimates token counts for OpenAI embeddings
 * 
 * OpenAI's text-embedding models have a maximum context length of 8191 tokens.
 * This utility helps estimate token counts and optimize batch sizes.
 */

export class TokenEstimator {
  // Average characters per token (conservative estimate)
  private static readonly CHARS_PER_TOKEN = 4;
  
  // OpenAI embeddings model limits
  private static readonly MAX_TOKENS_PER_REQUEST = 8191;
  
  // Safety margin to avoid edge cases (10% buffer)
  private static readonly SAFETY_MARGIN = 0.9;
  
  // Maximum batch size (API limit)
  private static readonly MAX_BATCH_SIZE = 25;

  /**
   * Estimate token count for a text
   * Uses a conservative estimate of 4 characters per token
   */
  static estimateTokens(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const charCount = text.length;

    const urlMatchesRaw = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
    const urlMatches = urlMatchesRaw as string[];
    const urlChars = urlMatches.reduce((sum: number, m: string) => sum + m.length, 0);

    const cjkMatchesRaw = text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF]/g) ?? [];
    const cjkMatches = cjkMatchesRaw as string[];
    const cjkChars = cjkMatches.length;

    const emojiMatchesRaw = text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? [];
    const emojiMatches = emojiMatchesRaw as string[];
    const emojiCount = emojiMatches.length;

    const urlTokens = urlChars > 0 ? urlChars / 3.2 : 0;
    const cjkTokens = cjkChars;
    const emojiTokens = emojiCount * 2;

    const nonSpecialChars = Math.max(0, charCount - urlChars - cjkChars - emojiCount);
    const baseTokens = nonSpecialChars / this.CHARS_PER_TOKEN;

    const charBasedEstimate = urlTokens + cjkTokens + emojiTokens + baseTokens;
    const wordBasedEstimate = wordCount * 1.3;

    return Math.ceil(Math.max(wordBasedEstimate, charBasedEstimate));
  }

  /**
   * Calculate optimal batch size based on text lengths
   */
  static calculateOptimalBatchSize(texts: string[]): number {
    if (texts.length === 0) return 0;
    
    // Calculate token estimates for all texts
    const tokenCounts = texts.map(text => this.estimateTokens(text));
    
    // Sort by size to handle edge cases better
    tokenCounts.sort((a, b) => b - a);
    
    // Find the maximum batch size that fits within token limit
    const maxTokensAllowed = this.MAX_TOKENS_PER_REQUEST * this.SAFETY_MARGIN;
    let batchSize = 0;
    let totalTokens = 0;
    
    for (const tokens of tokenCounts) {
      if (totalTokens + tokens <= maxTokensAllowed && batchSize < this.MAX_BATCH_SIZE) {
        totalTokens += tokens;
        batchSize++;
      } else {
        break;
      }
    }
    
    // Ensure at least 1 if there are texts
    return Math.max(1, batchSize);
  }

  /**
   * Create optimized batches that respect token limits
   */
  static createOptimizedBatches<T extends { content: string }>(
    items: T[]
  ): T[][] {
    if (items.length === 0) return [];
    
    const batches: T[][] = [];
    let currentBatch: T[] = [];
    let currentTokenCount = 0;
    const maxTokensAllowed = this.MAX_TOKENS_PER_REQUEST * this.SAFETY_MARGIN;
    
    // Sort items by content length (ascending) for better packing
    const sortedItems = [...items].sort((a, b) => 
      a.content.length - b.content.length
    );
    
    for (const item of sortedItems) {
      const itemTokens = this.estimateTokens(item.content);
      
      // If single item exceeds limit, it needs its own batch (will be truncated)
      if (itemTokens > maxTokensAllowed) {
        // Finish current batch if it has items
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentTokenCount = 0;
        }
        // Add oversized item as its own batch
        batches.push([item]);
        continue;
      }
      
      // Check if adding this item would exceed limits
      if (
        currentTokenCount + itemTokens > maxTokensAllowed ||
        currentBatch.length >= this.MAX_BATCH_SIZE
      ) {
        // Start new batch
        batches.push(currentBatch);
        currentBatch = [item];
        currentTokenCount = itemTokens;
      } else {
        // Add to current batch
        currentBatch.push(item);
        currentTokenCount += itemTokens;
      }
    }
    
    // Add final batch if not empty
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
    
    return batches;
  }

  /**
   * Truncate text to fit within token limit
   */
  static truncateToTokenLimit(text: string, maxTokens?: number): string {
    const limit = maxTokens || (this.MAX_TOKENS_PER_REQUEST * this.SAFETY_MARGIN);
    const estimatedTokens = this.estimateTokens(text);
    
    if (estimatedTokens <= limit) {
      return text;
    }
    
    // Calculate approximate character limit
    const charLimit = Math.floor(limit * this.CHARS_PER_TOKEN * 0.9);
    
    // Truncate and add ellipsis
    return text.substring(0, charLimit) + '...';
  }

  /**
   * Get statistics for batch optimization
   */
  static getBatchStatistics(texts: string[]): {
    totalTexts: number;
    totalEstimatedTokens: number;
    averageTokensPerText: number;
    maxTokensInSingleText: number;
    recommendedBatchSize: number;
    estimatedBatches: number;
  } {
    if (texts.length === 0) {
      return {
        totalTexts: 0,
        totalEstimatedTokens: 0,
        averageTokensPerText: 0,
        maxTokensInSingleText: 0,
        recommendedBatchSize: 0,
        estimatedBatches: 0
      };
    }
    
    const tokenCounts = texts.map(text => this.estimateTokens(text));
    const totalTokens = tokenCounts.reduce((sum, count) => sum + count, 0);
    const maxTokens = Math.max(...tokenCounts);
    const avgTokens = totalTokens / texts.length;
    
    const recommendedBatchSize = this.calculateOptimalBatchSize(texts);
    const estimatedBatches = Math.ceil(texts.length / recommendedBatchSize);
    
    return {
      totalTexts: texts.length,
      totalEstimatedTokens: totalTokens,
      averageTokensPerText: Math.round(avgTokens),
      maxTokensInSingleText: maxTokens,
      recommendedBatchSize,
      estimatedBatches
    };
  }
}
