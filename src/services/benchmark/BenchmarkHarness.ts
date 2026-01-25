import { App, TFile, TFolder, normalizePath } from "obsidian";
import fs from "node:fs/promises";
import type SystemSculptPlugin from "../../main";
import type { ChatMessage } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import type {
  BenchmarkCase,
  BenchmarkCaseMetrics,
  BenchmarkCaseResult,
  BenchmarkEfficiencyBudget,
  BenchmarkFileDiff,
  BenchmarkRunResult,
  BenchmarkScoreBreakdown,
  BenchmarkSuite,
  BenchmarkWeights,
} from "../../types/benchmark";
import { generateDiff } from "../../utils/diffUtils";
import { countMessagesTokens } from "../../utils/tokenCounting";
import {
  normalizeLineEndings,
  isHiddenSystemPath,
  listAdapterFiles,
  readAdapterText,
  writeAdapterText,
  resolveAdapterPath,
} from "../../mcp-tools/filesystem/utils";

const BENCH_VERSION = "v2";
const RUNS_TO_KEEP = 10;

export interface BenchmarkPaths {
  root: string;
  active: string;
  runs: string;
  run: string;
}

export class BenchmarkHarness {
  private app: App;
  private plugin: SystemSculptPlugin;
  private suite: BenchmarkSuite;

  constructor(plugin: SystemSculptPlugin, suite: BenchmarkSuite) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.suite = suite;
  }

  private shouldUseAdapter(path: string): boolean {
    return isHiddenSystemPath(path);
  }

  public getSuite(): BenchmarkSuite {
    return this.suite;
  }

  public async ensureBenchmarkDirs(runId: string): Promise<BenchmarkPaths> {
    const storage = this.plugin.storage;
    await storage.initialize();

    const root = storage.getPath("benchmarks", BENCH_VERSION);
    const active = storage.getPath("benchmarks", BENCH_VERSION, "active");
    const runs = storage.getPath("benchmarks", BENCH_VERSION, "runs");
    const run = storage.getPath("benchmarks", BENCH_VERSION, "runs", runId);

    await this.ensureFolder(root);
    await this.ensureFolder(active);
    await this.ensureFolder(runs);
    await this.ensureFolder(run);

    return { root, active, runs, run };
  }

  public async resetActiveSandbox(activeRoot: string): Promise<void> {
    const normalizedRoot = normalizePath(activeRoot);
    const fixture = this.suite.fixture;

    await this.clearFolderContents(normalizedRoot);

    // Write fixture files (create or overwrite)
    for (const [relativePath, content] of Object.entries(fixture)) {
      const fullPath = normalizePath(`${normalizedRoot}/${relativePath}`);
      await this.ensureFileWithContent(fullPath, content);
    }
  }

  public async evaluateCase(
    activeRoot: string,
    benchmarkCase: BenchmarkCase,
    startedAt?: string,
    messages?: ChatMessage[]
  ): Promise<BenchmarkCaseResult> {
    const startStamp = startedAt ?? new Date().toISOString();
    const expected = buildExpectedSnapshot(this.suite.fixture, benchmarkCase.expectedUpdates);
    const actual = await this.readSnapshot(activeRoot);

    const diffs: BenchmarkFileDiff[] = [];
    const expectedPaths = new Set(Object.keys(expected));
    const actualPaths = new Set(Object.keys(actual));

    for (const path of expectedPaths) {
      const expectedContent = expected[path];
      const actualContent = actual[path] ?? null;
      if (actualContent === null) {
        diffs.push({
          path,
          expected: normalizeBenchmarkContent(expectedContent),
          actual: null,
          diff: generateDiff(normalizeBenchmarkContent(expectedContent), "")
        });
        continue;
      }
      const normalizedExpected = normalizeBenchmarkContent(expectedContent);
      const normalizedActual = normalizeBenchmarkContent(actualContent);
      if (normalizedExpected !== normalizedActual) {
        diffs.push({
          path,
          expected: normalizedExpected,
          actual: normalizedActual,
          diff: generateDiff(normalizedExpected, normalizedActual)
        });
      }
    }

    for (const path of actualPaths) {
      if (!expectedPaths.has(path)) {
        const normalizedActual = normalizeBenchmarkContent(actual[path]);
        diffs.push({
          path,
          expected: null,
          actual: normalizedActual,
          diff: generateDiff("", normalizedActual)
        });
      }
    }

    const endedAt = new Date().toISOString();
    const durationMs = Date.parse(endedAt) - Date.parse(startStamp);

    const metrics = collectBenchmarkMetrics(messages);
    metrics.wallTimeMs = durationMs;

    const { pointsEarned, maxPoints, scorePercent, breakdown } = computeCaseScore({
      suite: this.suite,
      benchmarkCase,
      expectedPaths,
      actualPaths,
      diffs,
      metrics,
    });

    const status = diffs.length === 0 ? "pass" : "fail";
    return {
      caseId: benchmarkCase.id,
      status,
      startedAt: startStamp,
      endedAt,
      durationMs,
      pointsEarned,
      maxPoints,
      scorePercent,
      breakdown,
      metrics,
      diffs,
    };
  }

  public async writeCaseArtifacts(
    runPath: string,
    caseId: string,
    payload: { result?: BenchmarkCaseResult; messages?: unknown; [key: string]: any }
  ): Promise<void> {
    const caseFolder = normalizePath(`${runPath}/cases/${caseId}`);
    await this.ensureFolder(caseFolder);
    const payloadPath = normalizePath(`${caseFolder}/result.json`);
    const resultPayload = payload?.result ?? payload;
    await this.writeFile(payloadPath, JSON.stringify(resultPayload, null, 2));
    if (payload?.messages) {
      const transcriptPath = normalizePath(`${caseFolder}/transcript.json`);
      await this.writeFile(transcriptPath, JSON.stringify(payload.messages, null, 2));
    }
  }

  public async writeRunSummary(runPath: string, run: BenchmarkRunResult): Promise<void> {
    const summaryPath = normalizePath(`${runPath}/run.json`);
    await this.writeFile(summaryPath, JSON.stringify(run, null, 2));
  }

  public async exportRunReport(run: BenchmarkRunResult, outputDir: string): Promise<string> {
    const reportName = `bench-${run.runId}.md`;
    const reportPath = normalizePath(`${outputDir}/${reportName}`);
    const lines: string[] = [];
    lines.push(`# SystemSculpt Benchmark Report`);
    lines.push("");
    lines.push(`- Run ID: ${run.runId}`);
    lines.push(`- Model: ${run.modelId}`);
    lines.push(`- Suite: ${run.suiteId} (${run.suiteVersion})`);
    lines.push(`- Started: ${run.startedAt}`);
    if (run.endedAt) lines.push(`- Completed: ${run.endedAt}`);
    if (run.durationMs != null) lines.push(`- Duration: ${Math.round(run.durationMs / 1000)}s`);
    lines.push("");

    const passCount = run.cases.filter((c) => c.status === "pass").length;
    const totalPointsEarned = run.totalPointsEarned ?? run.cases.reduce((sum, c) => sum + (c.pointsEarned ?? 0), 0);
    const totalMaxPoints = run.totalMaxPoints ?? run.cases.reduce((sum, c) => sum + (c.maxPoints ?? 0), 0);
    const scorePercent = run.scorePercent ?? (totalMaxPoints > 0 ? (totalPointsEarned / totalMaxPoints) * 100 : 0);

    lines.push(`**Result:** ${passCount}/${run.cases.length} passed`);
    if (totalMaxPoints > 0) {
      lines.push(`**Score:** ${totalPointsEarned.toFixed(2)}/${totalMaxPoints.toFixed(2)} (${scorePercent.toFixed(1)}%)`);
    }
    lines.push("");

    for (const caseResult of run.cases) {
      const caseDef = this.suite.cases.find((c) => c.id === caseResult.caseId);
      lines.push(`## ${caseDef?.title ?? caseResult.caseId}`);
      if (caseDef && caseDef.id !== caseDef.title) {
        lines.push(`- Case ID: ${caseDef.id}`);
      }
      lines.push(`- Status: ${caseResult.status}`);
      if (caseResult.maxPoints != null && caseResult.pointsEarned != null) {
        const pct = typeof caseResult.scorePercent === "number"
          ? caseResult.scorePercent
          : (caseResult.maxPoints > 0 ? (caseResult.pointsEarned / caseResult.maxPoints) * 100 : 0);
        lines.push(`- Score: ${caseResult.pointsEarned.toFixed(2)}/${caseResult.maxPoints.toFixed(2)} (${pct.toFixed(1)}%)`);
      }
      if (caseResult.durationMs != null) {
        lines.push(`- Duration: ${Math.round(caseResult.durationMs / 1000)}s`);
      }
      if (caseResult.metrics?.toolCallsTotal != null) {
        lines.push(`- Tool calls: ${caseResult.metrics.toolCallsTotal}`);
      }
      if (caseResult.errors?.length) {
        lines.push(`- Errors: ${caseResult.errors.join("; ")}`);
      }
      if (caseResult.diffs?.length) {
        lines.push("");
        lines.push("### Mismatches");
        for (const diff of caseResult.diffs) {
          lines.push(`- ${diff.path}`);
        }
      }
      lines.push("");
    }

    await this.ensureFolder(outputDir);
    await this.writeFile(reportPath, lines.join("\n"));
    return reportPath;
  }

  public async snapshotActiveCase(activeRoot: string, runPath: string, caseId: string): Promise<void> {
    const sourceRoot = normalizePath(activeRoot);
    const destinationRoot = normalizePath(`${runPath}/cases/${caseId}/vault`);
    await this.ensureFolder(destinationRoot);

    if (this.shouldUseAdapter(sourceRoot)) {
      const adapter: any = this.app.vault.adapter as any;
      const files = await listAdapterFiles(adapter, sourceRoot);
      for (const filePath of files) {
        const rel = normalizePath(filePath.replace(`${sourceRoot}/`, ""));
        const destPath = normalizePath(`${destinationRoot}/${rel}`);
        const content = await readAdapterText(adapter, filePath);
        await this.ensureFileWithContent(destPath, content);
      }
      return;
    }

    const files = this.app.vault.getFiles().filter((file) => file.path.startsWith(`${sourceRoot}/`));
    for (const file of files) {
      const rel = normalizePath(file.path.replace(`${sourceRoot}/`, ""));
      const destPath = normalizePath(`${destinationRoot}/${rel}`);
      const content = await this.app.vault.read(file);
      await this.ensureFileWithContent(destPath, content);
    }
  }

  public async pruneOldRuns(runsPath: string): Promise<void> {
    const adapter: any = this.app.vault.adapter as any;
    if (this.shouldUseAdapter(runsPath)) {
      const fullPath = resolveAdapterPath(adapter, runsPath);
      if (!fullPath) return;
      let entries: Array<import("node:fs").Dirent> = [];
      try {
        entries = await fs.readdir(fullPath, { withFileTypes: true });
      } catch {
        return;
      }
      const folders = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => normalizePath(`${runsPath}/${entry.name}`));
      const sorted = folders.sort().reverse();
      const toRemove = sorted.slice(RUNS_TO_KEEP);
      for (const folder of toRemove) {
        await fs.rm(resolveAdapterPath(adapter, folder) || folder, { recursive: true, force: true });
      }
      return;
    }
    if (typeof adapter?.list !== "function") {
      return;
    }
    const listing = await adapter.list(runsPath);
    const folders: string[] = Array.isArray(listing?.folders) ? listing.folders : [];
    const sorted = folders.sort().reverse();
    const toRemove = sorted.slice(RUNS_TO_KEEP);
    for (const folder of toRemove) {
      await this.removeFolderRecursive(folder);
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    if (this.shouldUseAdapter(path)) {
      const adapter: any = this.app.vault.adapter as any;
      await writeAdapterText(adapter, path, content);
      return;
    }
    await this.app.vault.adapter.write(path, content);
  }

  private async readSnapshot(activeRoot: string): Promise<Record<string, string>> {
    const normalizedRoot = normalizePath(activeRoot);
    const snapshot: Record<string, string> = {};
    if (this.shouldUseAdapter(normalizedRoot)) {
      const adapter: any = this.app.vault.adapter as any;
      const files = await listAdapterFiles(adapter, normalizedRoot);
      for (const filePath of files) {
        const rel = normalizePath(filePath.replace(`${normalizedRoot}/`, ""));
        snapshot[rel] = await readAdapterText(adapter, filePath);
      }
      return snapshot;
    }

    const files = this.app.vault.getFiles().filter((file) => file.path.startsWith(`${normalizedRoot}/`));
    for (const file of files) {
      const rel = normalizePath(file.path.replace(`${normalizedRoot}/`, ""));
      snapshot[rel] = await this.app.vault.read(file);
    }
    return snapshot;
  }

  private async ensureFileWithContent(path: string, content: string): Promise<void> {
    const folderPath = path.split("/").slice(0, -1).join("/");
    if (folderPath) {
      await this.ensureFolder(folderPath);
    }

    if (this.shouldUseAdapter(path)) {
      const adapter: any = this.app.vault.adapter as any;
      await writeAdapterText(adapter, path, content);
      return;
    }

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }

    await this.app.vault.create(path, content);
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (this.shouldUseAdapter(normalized)) {
      const parts = normalized.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("already exists")) {
            throw error;
          }
        }
      }
      return;
    }
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing instanceof TFile) {
        await this.app.vault.adapter.remove(current);
      }
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        // ignore folder exists errors
      }
    }
  }

  private async clearFolderContents(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (this.shouldUseAdapter(normalized)) {
      const adapter: any = this.app.vault.adapter as any;
      const fullPath = resolveAdapterPath(adapter, normalized);
      if (fullPath) {
        await fs.rm(fullPath, { recursive: true, force: true });
      }
      await this.ensureFolder(normalized);
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    const adapter: any = this.app.vault.adapter as any;
    if (existing instanceof TFile) {
      await adapter.remove(normalized);
      await this.ensureFolder(normalized);
    } else if (existing instanceof TFolder) {
      await this.removeFolderContents(normalized);
    } else if (typeof adapter?.exists === "function" && await adapter.exists(normalized)) {
      try {
        await this.removeFolderContents(normalized);
      } catch {
        await adapter.remove(normalized);
      }
      await this.ensureFolder(normalized);
    }
    await this.ensureFolder(normalized);
  }

  private async removeFolderContents(path: string): Promise<void> {
    const adapter: any = this.app.vault.adapter as any;
    if (typeof adapter?.list !== "function" || typeof adapter?.remove !== "function") {
      return;
    }
    const listing = await adapter.list(path);
    const files: string[] = Array.isArray(listing?.files) ? listing.files : [];
    const folders: string[] = Array.isArray(listing?.folders) ? listing.folders : [];

    for (const file of files) {
      await adapter.remove(file);
    }
    for (const folder of folders) {
      await this.removeFolderRecursive(folder);
    }
  }

  private async removeFolderRecursive(path: string): Promise<void> {
    const adapter: any = this.app.vault.adapter as any;
    if (typeof adapter?.list !== "function" || typeof adapter?.remove !== "function") {
      return;
    }
    const listing = await adapter.list(path);
    const files: string[] = Array.isArray(listing?.files) ? listing.files : [];
    const folders: string[] = Array.isArray(listing?.folders) ? listing.folders : [];

    for (const file of files) {
      await adapter.remove(file);
    }
    for (const folder of folders) {
      await this.removeFolderRecursive(folder);
    }
    if (typeof adapter?.rmdir === "function") {
      try {
        await adapter.rmdir(path, true);
        return;
      } catch {}
    }
    try {
      await adapter.remove(path);
    } catch {
      // If the adapter cannot remove directories, leave the empty folder.
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeWeights(weights: BenchmarkWeights | undefined): BenchmarkWeights {
  const fallback: BenchmarkWeights = { correctness: 0.7, efficiency: 0.3 };
  if (!weights) return fallback;
  const correctness = Number(weights.correctness);
  const efficiency = Number(weights.efficiency);
  if (!Number.isFinite(correctness) || !Number.isFinite(efficiency)) return fallback;
  if (correctness < 0 || efficiency < 0) return fallback;
  const sum = correctness + efficiency;
  if (sum <= 0) return fallback;
  return { correctness: correctness / sum, efficiency: efficiency / sum };
}

function collectBenchmarkMetrics(messages?: ChatMessage[]): BenchmarkCaseMetrics {
  const metrics: BenchmarkCaseMetrics = {};
  if (!messages || messages.length === 0) {
    return metrics;
  }

  const toolCalls = collectUniqueToolCalls(messages);
  metrics.toolCallsTotal = toolCalls.length;

  const toolCallsByName: Record<string, number> = {};
  let toolExecutionMs = 0;
  let readChars = 0;
  let writeChars = 0;

  for (const tc of toolCalls) {
    const name = String(tc?.request?.function?.name ?? "").trim();
    if (name.length > 0) {
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
    }

    const started = typeof tc.executionStartedAt === "number" ? tc.executionStartedAt : undefined;
    const completed = typeof tc.executionCompletedAt === "number" ? tc.executionCompletedAt : undefined;
    if (started != null && completed != null && completed >= started) {
      toolExecutionMs += completed - started;
    }

    // Best-effort IO metrics (deterministic, derived from tool inputs/outputs).
    try {
      if (name === "mcp-filesystem_read") {
        const files = (tc.result as any)?.data?.files;
        if (Array.isArray(files)) {
          for (const f of files) {
            const meta = (f as any)?.metadata;
            const windowStart = Number(meta?.windowStart ?? 0);
            const windowEnd = Number(meta?.windowEnd ?? 0);
            if (Number.isFinite(windowStart) && Number.isFinite(windowEnd) && windowEnd >= windowStart) {
              readChars += windowEnd - windowStart;
            } else if (typeof (f as any)?.content === "string") {
              readChars += (f as any).content.length;
            }
          }
        }
      }

      if (name === "mcp-filesystem_write") {
        const args = safeJsonParse(tc.request?.function?.arguments);
        if (args && typeof args.content === "string") {
          writeChars += args.content.length;
        }
      }

      if (name === "mcp-filesystem_edit") {
        const args = safeJsonParse(tc.request?.function?.arguments);
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        for (const edit of edits) {
          if (edit && typeof edit.newText === "string") {
            writeChars += edit.newText.length;
          }
        }
      }
    } catch {
      // ignore metrics extraction errors
    }
  }

  metrics.toolCallsByName = Object.keys(toolCallsByName).length > 0 ? toolCallsByName : undefined;
  metrics.toolExecutionMs = toolExecutionMs;
  metrics.readChars = readChars > 0 ? readChars : undefined;
  metrics.writeChars = writeChars > 0 ? writeChars : undefined;

  try {
    metrics.estimatedTokens = countMessagesTokens(messages);
  } catch {
    // ignore token estimation failures
  }

  return metrics;
}

function collectUniqueToolCalls(messages: ChatMessage[]): ToolCall[] {
  const map = new Map<string, ToolCall>();
  for (const msg of messages) {
    const list = Array.isArray((msg as any)?.tool_calls) ? ((msg as any).tool_calls as ToolCall[]) : [];
    for (const tc of list) {
      const id = String((tc as any)?.id ?? "").trim();
      if (!id) continue;
      map.set(id, tc);
    }
  }
  return Array.from(map.values());
}

function safeJsonParse(raw: unknown): any | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function computeBudgetScore(actual: number | undefined, max: number | undefined): number | null {
  if (max == null || !Number.isFinite(max) || max <= 0) return null;
  if (actual == null || !Number.isFinite(actual) || actual < 0) return null;
  if (actual <= max) return 1;
  return clamp(max / actual, 0, 1);
}

function computeEfficiencyFraction(metrics: BenchmarkCaseMetrics, budget: BenchmarkEfficiencyBudget | undefined): number {
  const parts: number[] = [];

  const toolCallsScore = computeBudgetScore(metrics.toolCallsTotal, budget?.maxToolCalls);
  if (toolCallsScore != null) parts.push(toolCallsScore);

  const wallTimeScore = computeBudgetScore(metrics.wallTimeMs, budget?.maxWallTimeMs);
  if (wallTimeScore != null) parts.push(wallTimeScore);

  const toolExecScore = computeBudgetScore(metrics.toolExecutionMs, budget?.maxToolExecutionMs);
  if (toolExecScore != null) parts.push(toolExecScore);

  const tokensScore = computeBudgetScore(metrics.estimatedTokens, budget?.maxEstimatedTokens);
  if (tokensScore != null) parts.push(tokensScore);

  const readScore = computeBudgetScore(metrics.readChars, budget?.maxReadChars);
  if (readScore != null) parts.push(readScore);

  const writeScore = computeBudgetScore(metrics.writeChars, budget?.maxWriteChars);
  if (writeScore != null) parts.push(writeScore);

  if (parts.length === 0) return 1;
  const sum = parts.reduce((acc, n) => acc + n, 0);
  return clamp(sum / parts.length, 0, 1);
}

function computeCaseScore(params: {
  suite: BenchmarkSuite;
  benchmarkCase: BenchmarkCase;
  expectedPaths: Set<string>;
  actualPaths: Set<string>;
  diffs: BenchmarkFileDiff[];
  metrics: BenchmarkCaseMetrics;
}): { pointsEarned: number; maxPoints: number; scorePercent: number; breakdown: BenchmarkScoreBreakdown } {
  const maxPoints = Math.max(0, Number(params.benchmarkCase.maxPoints ?? params.suite.defaultMaxPoints ?? 0));

  const weights = normalizeWeights(params.suite.weights);
  const correctnessMax = maxPoints * weights.correctness;
  const efficiencyMax = maxPoints - correctnessMax;

  const requiredPaths = new Set<string>(Object.keys(params.benchmarkCase.expectedUpdates ?? {}));
  const diffsByPath = new Map<string, BenchmarkFileDiff>(params.diffs.map((d) => [d.path, d]));

  const computeDiffSimilarity = (diff: BenchmarkFileDiff): number => {
    if (diff.expected == null) return 0;
    if (diff.actual == null) return 0;

    const expectedLineCount = diff.expected.length > 0 ? diff.expected.split("\n").length : 0;
    if (expectedLineCount <= 0) return 0;

    const stats = diff.diff?.stats;
    const mismatchLines = (stats?.additions ?? 0) + (stats?.deletions ?? 0);
    return clamp(1 - mismatchLines / expectedLineCount, 0, 1);
  };

  const scoredItems: number[] = [];

  for (const path of requiredPaths) {
    const diff = diffsByPath.get(path);
    scoredItems.push(diff ? computeDiffSimilarity(diff) : 1);
  }

  for (const diff of params.diffs) {
    if (requiredPaths.has(diff.path)) continue;
    scoredItems.push(0);
  }

  let correctnessFraction = 1;
  if (scoredItems.length > 0) {
    const sum = scoredItems.reduce((acc, n) => acc + n, 0);
    correctnessFraction = clamp(sum / scoredItems.length, 0, 1);
  } else {
    correctnessFraction = params.diffs.length === 0 ? 1 : 0;
  }

  const budget = params.benchmarkCase.efficiencyBudget ?? params.suite.defaultEfficiencyBudget;
  const efficiencyFraction = computeEfficiencyFraction(params.metrics, budget);

  const correctnessPoints = correctnessMax * correctnessFraction;
  const efficiencyPoints = efficiencyMax * efficiencyFraction;
  const penaltyPoints = 0;

  const pointsEarned = clamp(correctnessPoints + efficiencyPoints + penaltyPoints, 0, maxPoints);
  const scorePercent = maxPoints > 0 ? clamp((pointsEarned / maxPoints) * 100, 0, 100) : 0;

  return {
    pointsEarned,
    maxPoints,
    scorePercent,
    breakdown: {
      correctnessPoints,
      efficiencyPoints,
      penaltyPoints,
      pointsEarned,
      maxPoints,
      correctnessFraction,
      efficiencyFraction,
    },
  };
}

function normalizeBenchmarkContent(text: string): string {
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split("\n").map((line) => line.replace(/\s+$/g, ""));
  if (lines.length === 0) return "";

  let bodyStart = 0;
  if (lines[0] === "---") {
    const endIndex = lines.indexOf("---", 1);
    if (endIndex > 0) {
      bodyStart = endIndex + 1;
    }
  }

  const frontmatter = lines.slice(0, bodyStart);
  const body = lines.slice(bodyStart);
  const bodyWithoutBlankLines = body.filter((line) => line.trim().length > 0);
  const combined = frontmatter.length > 0 ? frontmatter.concat(bodyWithoutBlankLines) : bodyWithoutBlankLines;
  while (combined.length > 0 && combined[0] === "") combined.shift();
  while (combined.length > 0 && combined[combined.length - 1] === "") combined.pop();
  return combined.join("\n");
}

export function buildExpectedSnapshot(
  fixture: Record<string, string>,
  updates: Record<string, string | null>
): Record<string, string> {
  const expected: Record<string, string> = { ...fixture };
  for (const [path, content] of Object.entries(updates)) {
    if (content === null) {
      delete expected[path];
    } else {
      expected[path] = content;
    }
  }
  return expected;
}
