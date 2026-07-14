/** First-party semantic-index records and managed execution contracts. */

export interface EmbeddingVector {
  /**
   * Unique identifier for the vector. Includes the managed generation namespace
   * so incompatible generations can never collide during an upgrade.
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
    /** Opaque first-party generation identity. Required for generation-safe reuse. */
    generation?: string;
    /** Dimensionality of the vector */
    dimension: number;
    /** Creation timestamp for this vector */
    createdAt: number;
    /** Concrete first-party generation namespace, including vector dimensions. */
    namespace: string;
    /** Optional section title derived from the note's heading hierarchy */
    sectionTitle?: string;
    /** Heading breadcrumb trail for the chunk */
    headingPath?: string[];
    /** Raw character length for the chunk (post-preprocessing) */
    chunkLength?: number;
    /** Marks that all chunks for the file were embedded successfully (set on chunk 0). */
    complete?: boolean;
    /** Marks partial file-level embedding execution (set on chunk 0). */
    partial?: boolean;
    /** Number of chunks that failed and were not regenerated in this pass (set on chunk 0). */
    failedChunkCount?: number;
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
  completedPaths: string[];
  failed: number;
  failedPaths: string[];
  cancelled: boolean;
  fatalError: import('./gateway/ManagedEmbeddingsAdapter').ManagedEmbeddingsError | null;
  failedDetails?: Record<string, FailedProcessingDetail>;
}

export interface EmbeddingsGenerateOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface ManagedEmbeddingLimits {
  maxTexts: number;
  maxCharsPerText: number;
  maxTotalChars: number;
}

export interface ManagedEmbeddingGeneration {
  id: string;
  indexSchemaVersion: number;
  indexNamespace: string;
  dimensions: number;
  limits: ManagedEmbeddingLimits;
}

/** The one managed execution seam used by the semantic index. */
export interface ManagedEmbeddingsGateway {
  readonly limits: ManagedEmbeddingLimits;
  expectedDimension?: number;
  activeGeneration?: ManagedEmbeddingGeneration;
  initializeContract?(): Promise<void>;
  generateEmbeddings(texts: string[], options: EmbeddingsGenerateOptions): Promise<number[][]>;
}

export interface EmbeddingsManagerConfig {
  exclusions: {
    folders: string[];
    patterns: string[];
    ignoreChatHistory: boolean;
    respectObsidianExclusions: boolean;
  };
  // Search behavior is now fixed internally; no user-configurable fields
}
