/**
 * Represents a single entry in the benchmark leaderboard.
 * Each entry corresponds to the latest benchmark run for a specific model.
 */
export interface LeaderboardEntry {
  /** Ranking position (1-based) */
  rank: number;
  /** Canonical model identifier */
  modelId: string;
  /** Human-readable model name (resolved from modelService or derived from modelId) */
  modelDisplayName: string;
  /** Overall score as percentage (0-100) */
  scorePercent: number;
  /** Total points earned across all cases */
  totalPointsEarned: number;
  /** Maximum possible points */
  totalMaxPoints: number;
  /** Unique identifier for this run (format: YYYYMMDD-HHMMSS) */
  runId: string;
  /** When the benchmark was run */
  runDate: Date;
  /** Benchmark suite identifier */
  suiteId: string;
  /** Benchmark suite version */
  suiteVersion: string;
}

/**
 * Result of loading benchmark data from disk.
 */
export interface LoadResult {
  /** Status of the load operation */
  status: "success" | "empty" | "error";
  /** Leaderboard entries sorted by score descending */
  entries: LeaderboardEntry[];
  /** Error message if status is 'error' */
  errorMessage?: string;
}
