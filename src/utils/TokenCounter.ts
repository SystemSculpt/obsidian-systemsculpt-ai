import {
  estimateTokens,
  calculateOptimalBatchSize,
  createOptimizedBatches,
  truncateToTokenLimit,
  getBatchStatistics,
} from './tokenCounting';

export interface TokenCounterBatchStats {
  totalTexts: number;
  totalEstimatedTokens: number;
  averageTokensPerText: number;
  maxTokensInSingleText: number;
  recommendedBatchSize: number;
  estimatedBatches: number;
}

export interface TokenCounter {
  estimateTokens(text: string): number;
  calculateOptimalBatchSize(texts: string[]): number;
  createOptimizedBatches<T extends { content: string }>(items: T[]): T[][];
  truncateToTokenLimit(text: string, maxTokens?: number): string;
  getBatchStatistics(texts: string[]): TokenCounterBatchStats;
}

class EstimatorTokenCounter implements TokenCounter {
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  calculateOptimalBatchSize(texts: string[]): number {
    return calculateOptimalBatchSize(texts);
  }

  createOptimizedBatches<T extends { content: string }>(items: T[]): T[][] {
    return createOptimizedBatches(items);
  }

  truncateToTokenLimit(text: string, maxTokens?: number): string {
    return truncateToTokenLimit(text, maxTokens);
  }

  getBatchStatistics(texts: string[]): TokenCounterBatchStats {
    return getBatchStatistics(texts);
  }
}

let currentTokenCounter: TokenCounter = new EstimatorTokenCounter();

export function setTokenCounter(counter: TokenCounter): void {
  currentTokenCounter = counter;
}

export const tokenCounter = {
  estimateTokens(text: string): number {
    return currentTokenCounter.estimateTokens(text);
  },
  calculateOptimalBatchSize(texts: string[]): number {
    return currentTokenCounter.calculateOptimalBatchSize(texts);
  },
  createOptimizedBatches<T extends { content: string }>(items: T[]): T[][] {
    return currentTokenCounter.createOptimizedBatches(items);
  },
  truncateToTokenLimit(text: string, maxTokens?: number): string {
    return currentTokenCounter.truncateToTokenLimit(text, maxTokens);
  },
  getBatchStatistics(texts: string[]): TokenCounterBatchStats {
    return currentTokenCounter.getBatchStatistics(texts);
  }
};


