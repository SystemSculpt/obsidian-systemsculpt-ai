import { App, normalizePath } from "obsidian";
import fs from "node:fs/promises";
import type SystemSculptPlugin from "../../main";
import type { BenchmarkRunResult } from "../../types/benchmark";
import type { LeaderboardEntry, LoadResult } from "./types";
import {
  isHiddenSystemPath,
  readAdapterText,
  resolveAdapterPath,
} from "../../mcp-tools/filesystem/utils";

const BENCH_VERSION = "v2";

/**
 * Loads and aggregates benchmark results from disk for the leaderboard view.
 */
export class BenchResultsDataLoader {
  private app: App;
  private plugin: SystemSculptPlugin;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  /**
   * Load all benchmark results and aggregate into a leaderboard.
   * Returns only the latest run per model, sorted by score descending.
   */
  async loadLeaderboard(): Promise<LoadResult> {
    try {
      const runsPath = await this.getRunsPath();
      if (!runsPath) {
        return { status: "empty", entries: [] };
      }

      const runDirs = await this.listRunDirectories(runsPath);
      if (runDirs.length === 0) {
        return { status: "empty", entries: [] };
      }

      const allRuns: BenchmarkRunResult[] = [];
      for (const runDir of runDirs) {
        const runJsonPath = normalizePath(`${runDir}/run.json`);
        const runResult = await this.readRunResult(runJsonPath);
        if (runResult) {
          allRuns.push(runResult);
        }
      }

      if (allRuns.length === 0) {
        return { status: "empty", entries: [] };
      }

      const latestByModel = this.aggregateByModel(allRuns);
      const entries = await this.buildLeaderboardEntries(latestByModel);

      return { status: "success", entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[BenchResultsDataLoader] Error loading leaderboard:", error);
      return { status: "error", entries: [], errorMessage: message };
    }
  }

  /**
   * Get the path to the runs directory.
   */
  private async getRunsPath(): Promise<string | null> {
    try {
      const storage = this.plugin.storage;
      await storage.initialize();
      return storage.getPath("benchmarks", BENCH_VERSION, "runs");
    } catch {
      return null;
    }
  }

  /**
   * List all run directories in the runs path.
   */
  private async listRunDirectories(runsPath: string): Promise<string[]> {
    const adapter: any = this.app.vault.adapter as any;

    if (isHiddenSystemPath(runsPath)) {
      const fullPath = resolveAdapterPath(adapter, runsPath);
      if (!fullPath) return [];

      try {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => normalizePath(`${runsPath}/${entry.name}`));
      } catch {
        return [];
      }
    }

    // Fallback for non-hidden paths
    if (typeof adapter?.list !== "function") {
      return [];
    }

    try {
      const listing = await adapter.list(runsPath);
      return Array.isArray(listing?.folders) ? listing.folders : [];
    } catch {
      return [];
    }
  }

  /**
   * Read and parse a run.json file.
   * Returns null if the file doesn't exist or is invalid.
   */
  private async readRunResult(runJsonPath: string): Promise<BenchmarkRunResult | null> {
    try {
      const adapter: any = this.app.vault.adapter as any;
      let content: string;

      if (isHiddenSystemPath(runJsonPath)) {
        content = await readAdapterText(adapter, runJsonPath);
      } else {
        content = await this.app.vault.adapter.read(runJsonPath);
      }

      const parsed = JSON.parse(content) as BenchmarkRunResult;

      // Validate required fields
      if (!parsed.runId || !parsed.modelId) {
        console.warn(`[BenchResultsDataLoader] Invalid run.json at ${runJsonPath}: missing required fields`);
        return null;
      }

      return parsed;
    } catch (error) {
      // File might not exist or be invalid JSON - skip silently
      return null;
    }
  }

  /**
   * Aggregate runs by model, keeping only the latest run per model.
   */
  private aggregateByModel(runs: BenchmarkRunResult[]): Map<string, BenchmarkRunResult> {
    const byModel = new Map<string, BenchmarkRunResult>();

    for (const run of runs) {
      const existing = byModel.get(run.modelId);
      if (!existing) {
        byModel.set(run.modelId, run);
        continue;
      }

      // Compare by startedAt timestamp - keep the later one
      const existingDate = existing.startedAt ? new Date(existing.startedAt).getTime() : 0;
      const runDate = run.startedAt ? new Date(run.startedAt).getTime() : 0;

      if (runDate > existingDate) {
        byModel.set(run.modelId, run);
      }
    }

    return byModel;
  }

  /**
   * Build leaderboard entries from aggregated runs.
   */
  private async buildLeaderboardEntries(
    byModel: Map<string, BenchmarkRunResult>
  ): Promise<LeaderboardEntry[]> {
    const entries: LeaderboardEntry[] = [];

    for (const [modelId, run] of byModel) {
      const scorePercent = this.calculateScorePercent(run);
      const displayName = await this.resolveModelDisplayName(modelId);

      entries.push({
        rank: 0, // Will be assigned after sorting
        modelId,
        modelDisplayName: displayName,
        scorePercent,
        totalPointsEarned: run.totalPointsEarned ?? 0,
        totalMaxPoints: run.totalMaxPoints ?? 0,
        runId: run.runId,
        runDate: run.startedAt ? new Date(run.startedAt) : new Date(),
        suiteId: run.suiteId,
        suiteVersion: run.suiteVersion,
      });
    }

    // Sort by score descending
    entries.sort((a, b) => b.scorePercent - a.scorePercent);

    // Assign ranks
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    return entries;
  }

  /**
   * Calculate score percentage from a run result.
   * Uses scorePercent if available, otherwise calculates from points.
   */
  private calculateScorePercent(run: BenchmarkRunResult): number {
    if (typeof run.scorePercent === "number" && Number.isFinite(run.scorePercent)) {
      return Math.max(0, Math.min(100, run.scorePercent));
    }

    const earned = run.totalPointsEarned ?? 0;
    const max = run.totalMaxPoints ?? 0;

    if (max <= 0) return 0;
    return Math.max(0, Math.min(100, (earned / max) * 100));
  }

  /**
   * Resolve a human-readable display name for a model.
   */
  private async resolveModelDisplayName(modelId: string): Promise<string> {
    try {
      const model = await this.plugin.modelService.getModelById(modelId);
      if (model?.name) {
        return model.name;
      }
    } catch {
      // Model not found in service
    }

    // Fallback: extract readable name from modelId
    return this.extractDisplayName(modelId);
  }

  /**
   * Extract a displayable name from a model ID.
   * Handles formats like "provider:model-name" or "model-name".
   */
  private extractDisplayName(modelId: string): string {
    // Remove provider prefix if present (e.g., "anthropic:claude-3-opus")
    const parts = modelId.split(":");
    const name = parts.length > 1 ? parts.slice(1).join(":") : modelId;

    // Clean up the name
    return name
      .replace(/-/g, " ")
      .replace(/_/g, " ")
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
}
