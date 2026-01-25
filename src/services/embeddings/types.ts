/**
 * Embeddings System Types and Interfaces
 * 
 * Core types for the embeddings architecture:
 * - Provider abstraction for different embedding sources
 * - Efficient data structures for embeddings storage
 * - Configuration options for optimal performance
 */

export interface EmbeddingVector {
  /**
   * Unique identifier for the vector. Includes namespace so multiple
   * providers/models/dimensions can coexist for the same file.
   * Format: `${namespace}::${path}#${chunkId}`.
   */
  id: string;
  /** Original file path in the vault */
  path: string;
  /** Zero-based chunk identifier within the file (0 for single-vector files) */
  chunkId?: number;
  /** The embedding vector */
  vector: Float32Array;
  /** Metadata kept intentionally compact – no full content persistence */
  metadata: {
    /** Basename of the file */
    title: string;
    /** Short excerpt for previewing results (no full content stored) */
    excerpt?: string;
    /** Last modified time of the source file at embedding time */
    mtime: number;
    /** Hash of the processed content used for staleness checks */
    contentHash: string;
    /** Marks intentionally empty vectors for tiny files */
    isEmpty?: boolean;
    /** Provider id used to generate this vector (e.g. "systemsculpt", "custom") */
    provider: string;
    /** Model identifier used at generation time */
    model: string;
    /** Dimensionality of the vector */
    dimension: number;
    /** Creation timestamp for this vector */
    createdAt: number;
    /** Convenience namespace key: `${provider}:${model}:v${schema}:${dimension}` */
    namespace: string;
    /** Optional section title derived from the note's heading hierarchy */
    sectionTitle?: string;
    /** Heading breadcrumb trail for the chunk */
    headingPath?: string[];
    /** Raw character length for the chunk (post-preprocessing) */
    chunkLength?: number;
    /** Marks that all chunks for the file were embedded successfully (set on chunk 0). */
    complete?: boolean;
    /** Total chunk count for the file at embedding time (set on chunk 0). */
    chunkCount?: number;
  };
}

export interface SearchResult {
  path: string;
  score: number;
  chunkId?: number;
  metadata: {
    title: string;
    excerpt: string;
    lastModified: number;
    sectionTitle?: string;
    lexicalScore?: number;
  };
}

export interface ProcessingProgress {
  current: number;
  total: number;
  currentFile?: string;
  batchProgress?: {
    completed: number;
    total: number;
  };
}

export interface FailedProcessingDetail {
  code: string;
  message: string;
  status?: number;
  retryInMs?: number;
  chunkId?: number;
  sectionTitle?: string;
  headingPath?: string[];
  signals?: string[];
}

export interface ProcessingResult {
  completed: number;
  failed: number;
  failedPaths: string[];
  fatalError: import('./providers/ProviderError').EmbeddingsProviderError | null;
  failedDetails?: Record<string, FailedProcessingDetail>;
}

export interface EmbeddingBatchItemMetadata {
  path: string;
  chunkId: number;
  hash: string;
  originalLength: number;
  processedLength: number;
  originalEstimatedTokens: number;
  estimatedTokens: number;
  truncated: boolean;
}

export interface EmbeddingBatchMetadata {
  batchIndex?: number;
  batchSize: number;
  estimatedTotalTokens: number;
  maxEstimatedTokens: number;
  truncatedCount: number;
  items: EmbeddingBatchItemMetadata[];
}

export interface EmbeddingsGenerateOptions {
  inputType?: 'document' | 'query';
  batchMetadata?: EmbeddingBatchMetadata;
}

export interface EmbeddingsProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsModels: boolean;
  /** Best-effort hint of the embedding vector dimension produced by this provider. */
  expectedDimension?: number;

  generateEmbeddings(texts: string[], options?: EmbeddingsGenerateOptions): Promise<number[][]>;
  validateConfiguration(): Promise<boolean>;
  getModels?(): Promise<string[]>;
  /**
   * Maximum number of texts the provider accepts per embeddings request.
   * Implementations should return a conservative limit; callers will fall back
   * to sensible defaults when undefined.
   */
  getMaxBatchSize?(): number;
}

export interface EmbeddingsProviderConfig {
  providerId: 'systemsculpt' | 'custom';
  customEndpoint?: string;
  customApiKey?: string;
  customModel?: string;
  model: string;
}

export interface EmbeddingsManagerConfig {
  provider: EmbeddingsProviderConfig;
  batchSize: number;
  maxConcurrency: number;
  autoProcess: boolean;
  exclusions: {
    folders: string[];
    patterns: string[];
    ignoreChatHistory: boolean;
    respectObsidianExclusions: boolean;
  };
  // Search behavior is now fixed internally; no user-configurable fields
}
