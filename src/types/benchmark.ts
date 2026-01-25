export interface BenchmarkCase {
  id: string;
  difficulty: "easy" | "medium" | "hard";
  title: string;
  description: string;
  tags?: string[];
  prompts: string[];
  /**
   * Expected updates relative to the benchmark root.
   * Use null to indicate the file should be deleted.
   */
  expectedUpdates: Record<string, string | null>;
  /**
   * Maximum points available for this case. If omitted, the suite default applies.
   */
  maxPoints?: number;
  /**
   * Optional efficiency budgets for this case. If omitted, the suite default applies.
   */
  efficiencyBudget?: BenchmarkEfficiencyBudget;
}

export interface BenchmarkWeights {
  /**
   * Weight of correctness scoring, 0..1.
   */
  correctness: number;
  /**
   * Weight of efficiency scoring, 0..1.
   */
  efficiency: number;
}

export interface BenchmarkEfficiencyBudget {
  maxToolCalls?: number;
  maxWallTimeMs?: number;
  maxToolExecutionMs?: number;
  maxEstimatedTokens?: number;
  maxReadChars?: number;
  maxWriteChars?: number;
}

export interface BenchmarkSuite {
  id: string;
  title: string;
  description: string;
  /**
   * Schema version for run artifacts and scoring semantics (e.g., "v2").
   */
  version: string;
  /**
   * Default scoring weights for cases in this suite.
   */
  weights: BenchmarkWeights;
  /**
   * Default max points for cases in this suite (used when a case omits maxPoints).
   */
  defaultMaxPoints: number;
  /**
   * Default efficiency budgets for cases in this suite (used when a case omits efficiencyBudget).
   */
  defaultEfficiencyBudget?: BenchmarkEfficiencyBudget;
  fixture: Record<string, string>;
  cases: BenchmarkCase[];
}

export type BenchmarkCaseStatus = "pending" | "running" | "pass" | "fail" | "error" | "skipped";

import type { DiffResult } from "../utils/diffUtils";

export interface BenchmarkFileDiff {
  path: string;
  expected: string | null;
  actual: string | null;
  diff?: DiffResult;
}

export interface BenchmarkCaseMetrics {
  wallTimeMs?: number;
  toolCallsTotal?: number;
  toolCallsByName?: Record<string, number>;
  toolExecutionMs?: number;
  estimatedTokens?: number;
  readChars?: number;
  writeChars?: number;
}

export interface BenchmarkScoreBreakdown {
  correctnessPoints: number;
  efficiencyPoints: number;
  penaltyPoints: number;
  pointsEarned: number;
  maxPoints: number;
  correctnessFraction: number;
  efficiencyFraction: number;
}

export interface BenchmarkCaseResult {
  caseId: string;
  status: BenchmarkCaseStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  pointsEarned?: number;
  maxPoints?: number;
  scorePercent?: number;
  breakdown?: BenchmarkScoreBreakdown;
  metrics?: BenchmarkCaseMetrics;
  errors?: string[];
  diffs?: BenchmarkFileDiff[];
  messages?: any[];
}

export interface BenchmarkRunResult {
  runId: string;
  modelId: string;
  suiteId: string;
  suiteVersion: string;
  totalPointsEarned?: number;
  totalMaxPoints?: number;
  scorePercent?: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  cases: BenchmarkCaseResult[];
}
