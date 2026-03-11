import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { BENCH_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { StandardModelSelectionModal } from "../../modals/StandardModelSelectionModal";
import { ensureCanonicalId } from "../../utils/modelUtils";
import { MessageRenderer } from "../chatview/MessageRenderer";
import { addMessageToContainer } from "../chatview/handlers/MessageElements";
import { OBSIDIAN_BENCHMARK_V2, BENCH_ROOT_PLACEHOLDER } from "../../benchmarks/obsidianCoreV2";
import { BenchmarkHarness } from "../../services/benchmark/BenchmarkHarness";
import type { BenchmarkCase, BenchmarkCaseResult, BenchmarkCaseStatus, BenchmarkRunResult, BenchmarkScoreBreakdown } from "../../types/benchmark";
import type { ChatMessage } from "../../types";
import { DEFAULT_SETTINGS } from "../../types";
import { attachFolderSuggester } from "../../components/FolderSuggester";
import { errorLogger } from "../../utils/errorLogger";

export { BENCH_VIEW_TYPE };

type CaseState = {
  caseDef: BenchmarkCase;
  status: BenchmarkCaseStatus;
  result?: BenchmarkCaseResult;
  messages?: ChatMessage[];
  renderedHtml?: string;
  startedAtMs?: number;
};

type DifficultyFilter = "all" | BenchmarkCase["difficulty"];

export class BenchView extends ItemView {
  private plugin: SystemSculptPlugin;
  private harness: BenchmarkHarness;
  private suite = OBSIDIAN_BENCHMARK_V2;
  private selectedModelId: string;
  private difficultyFilter: DifficultyFilter = "all";

  private containerElRoot: HTMLElement;
  private headerEl: HTMLElement;
  private caseListEl: HTMLElement;
  private inspectorEl: HTMLElement;
  private chatContainerEl: HTMLElement;
  private diffContainerEl: HTMLElement;
  private caseHeaderEl: HTMLElement;
  private modelButtonEl: HTMLButtonElement;
  private runButtonEl: HTMLButtonElement;
  private saveButtonEl: HTMLButtonElement;
  private resultsInputEl: HTMLInputElement;
  private difficultySelectEl: HTMLSelectElement;
  private totalRuntimeEl: HTMLElement;

  private caseStates = new Map<string, CaseState>();
  private activeCaseId: string | null = null;
  private runResult: BenchmarkRunResult | null = null;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private runtimeIntervalId: number | null = null;
  private runStartedAtMs: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.harness = new BenchmarkHarness(plugin, this.suite);
    this.selectedModelId = plugin.settings.selectedModelId;
  }

  getViewType(): string {
    return BENCH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "SystemSculpt Benchmark";
  }

  getIcon(): string {
    return "flask-conical";
  }

  async onOpen(): Promise<void> {
    this.containerElRoot = this.containerEl.children[1] as HTMLElement;
    this.containerElRoot.empty();
    this.containerElRoot.addClass("systemsculpt-bench-view");

    this.buildHeader();
    this.buildBody();
    await this.refreshModelLabel();
    this.populateCases();
    const visibleCases = this.getVisibleCases();
    if (visibleCases.length > 0) {
      this.selectCase(visibleCases[0].id);
    }
  }

  async onClose(): Promise<void> {
    if (this.isRunning) {
      this.abortController?.abort();
    }
    this.stopRuntimeTimers();
    this.isRunning = false;
  }

  private buildHeader(): void {
    this.headerEl = this.containerElRoot.createDiv({ cls: "benchview-header" });

    const right = this.headerEl.createDiv({ cls: "benchview-header-right" });

    this.modelButtonEl = right.createEl("button", { cls: "benchview-model-button" });
    this.modelButtonEl.addEventListener("click", () => this.openModelSelector());

    const resultsWrapper = right.createDiv({ cls: "benchview-results-wrapper" });
    resultsWrapper.createSpan({ text: "Results:" });
    this.resultsInputEl = resultsWrapper.createEl("input", {
      cls: "benchview-results-input",
      type: "text",
      value: this.plugin.settings.benchmarksDirectory,
    });
    this.resultsInputEl.addEventListener("change", () => {
      this.updateResultsDirectory(this.resultsInputEl.value);
    });
    attachFolderSuggester(
      this.resultsInputEl,
      async (selectedPath: string) => {
        this.resultsInputEl.value = selectedPath;
        await this.updateResultsDirectory(selectedPath);
      },
      this.app
    );

    const runtimeWrapper = right.createDiv({ cls: "benchview-runtime-wrapper" });
    runtimeWrapper.createSpan({ text: "Runtime:" });
    this.totalRuntimeEl = runtimeWrapper.createSpan({ cls: "benchview-runtime-total", text: "—" });

    this.runButtonEl = right.createEl("button", { cls: "benchview-run-button", text: "Run" });
    this.runButtonEl.addEventListener("click", () => this.handleRunClick());

    this.saveButtonEl = right.createEl("button", { cls: "benchview-save-button", text: "Save Results" });
    this.saveButtonEl.disabled = true;
    this.saveButtonEl.addEventListener("click", () => this.saveResults());
  }

  private buildBody(): void {
    const body = this.containerElRoot.createDiv({ cls: "benchview-body" });

    const listPane = body.createDiv({ cls: "benchview-list-pane" });
    const listHeader = listPane.createDiv({ cls: "benchview-pane-header" });
    listHeader.createDiv({ cls: "benchview-pane-title", text: "Tests" });

    this.difficultySelectEl = listHeader.createEl("select", { cls: "benchview-difficulty-select" });
    const options: Array<{ value: DifficultyFilter; label: string }> = [
      { value: "all", label: "All tests" },
      { value: "easy", label: "Easy only" },
      { value: "medium", label: "Medium only" },
      { value: "hard", label: "Hard only" },
    ];
    for (const option of options) {
      this.difficultySelectEl.createEl("option", { value: option.value, text: option.label });
    }
    this.difficultySelectEl.value = this.difficultyFilter;
    this.difficultySelectEl.addEventListener("change", () => this.handleDifficultyFilterChange());
    this.caseListEl = listPane.createDiv({ cls: "benchview-case-list" });

    const inspectorPane = body.createDiv({ cls: "benchview-inspector-pane" });
    this.caseHeaderEl = inspectorPane.createDiv({ cls: "benchview-case-header" });

    this.chatContainerEl = inspectorPane.createDiv({ cls: "benchview-chat-container systemsculpt-chat-messages" });
    this.diffContainerEl = inspectorPane.createDiv({ cls: "benchview-diff-container" });
  }

  private ensureCaseStatesInitialized(): void {
    const suiteIds = new Set<string>();
    for (const caseDef of this.suite.cases) {
      suiteIds.add(caseDef.id);
      const existing = this.caseStates.get(caseDef.id);
      if (existing) {
        existing.caseDef = caseDef;
        continue;
      }
      this.caseStates.set(caseDef.id, { caseDef, status: "pending" });
    }

    for (const id of Array.from(this.caseStates.keys())) {
      if (!suiteIds.has(id)) {
        this.caseStates.delete(id);
      }
    }
  }

  private getVisibleCases(): BenchmarkCase[] {
    if (this.difficultyFilter === "all") return this.suite.cases;
    return this.suite.cases.filter((caseDef) => caseDef.difficulty === this.difficultyFilter);
  }

  private updateRunButtonState(): void {
    if (this.isRunning) {
      this.runButtonEl.disabled = false;
      return;
    }
    this.runButtonEl.disabled = this.getVisibleCases().length === 0;
  }

  private handleDifficultyFilterChange(): void {
    const value = this.difficultySelectEl.value;
    if (value === "all" || value === "easy" || value === "medium" || value === "hard") {
      this.difficultyFilter = value;
    } else {
      this.difficultyFilter = "all";
      this.difficultySelectEl.value = "all";
    }

    this.populateCases();
    const visibleCases = this.getVisibleCases();
    if (visibleCases.length === 0) {
      this.activeCaseId = null;
      this.caseHeaderEl.empty();
      this.chatContainerEl.empty();
      this.diffContainerEl.empty();
      return;
    }

    if (!this.activeCaseId || !visibleCases.some((caseDef) => caseDef.id === this.activeCaseId)) {
      this.selectCase(visibleCases[0].id);
    }
  }

  private populateCases(): void {
    this.caseListEl.empty();
    this.ensureCaseStatesInitialized();

    const visibleCases = this.getVisibleCases();
    if (visibleCases.length === 0) {
      this.caseListEl.createDiv({ cls: "benchview-case-empty", text: "No tests for this difficulty yet." });
      this.updateRunButtonState();
      return;
    }

    let lastDifficulty: BenchmarkCase["difficulty"] | null = null;
    for (const caseDef of visibleCases) {
      if (caseDef.difficulty !== lastDifficulty) {
        lastDifficulty = caseDef.difficulty;
        const label = lastDifficulty.charAt(0).toUpperCase() + lastDifficulty.slice(1);
        this.caseListEl.createDiv({ cls: "benchview-case-group", text: label });
      }
      const state = this.caseStates.get(caseDef.id);
      if (!state) continue;

      const row = this.caseListEl.createDiv({ cls: "benchview-case-row", attr: { "data-case-id": caseDef.id } });
      row.createDiv({ cls: "benchview-case-title", text: caseDef.title });
      const meta = row.createDiv({ cls: "benchview-case-meta" });
      meta.createDiv({ cls: "benchview-case-status benchview-status-pending", text: "Pending" });
      meta.createDiv({ cls: "benchview-case-runtime", text: "" });
      if (caseDef.tags?.length) {
        const tagsEl = row.createDiv({ cls: "benchview-case-tags" });
        caseDef.tags.forEach((tag) => tagsEl.createSpan({ text: tag }));
      }
      row.addEventListener("click", () => this.selectCase(caseDef.id));
      this.renderCaseRowStatus(caseDef.id, state.status, state.result);
    }

    this.updateRunButtonState();
  }

  private selectCase(caseId: string): void {
    this.activeCaseId = caseId;
    this.caseListEl.querySelectorAll(".benchview-case-row").forEach((row) => {
      row.classList.toggle("is-active", row.getAttribute("data-case-id") === caseId);
    });

    const state = this.caseStates.get(caseId);
    if (!state) return;
    this.renderCaseHeader(state);

    if (this.isRunning && state.status === "running") {
      return;
    }

    this.renderCaseTranscript(state);
    this.renderCaseDiff(state);
  }

  private renderCaseHeader(state: CaseState): void {
    this.caseHeaderEl.empty();
    this.caseHeaderEl.createDiv({ cls: "benchview-case-name", text: state.caseDef.title });
    this.caseHeaderEl.createDiv({ cls: "benchview-case-desc", text: state.caseDef.description });
    const scorePercent = state.result?.scorePercent;
    const scoreText = typeof scorePercent === "number" && Number.isFinite(scorePercent) ? `${Math.round(scorePercent)}%` : null;
    const pillText = scoreText ? `${state.status.toUpperCase()} ${scoreText}` : state.status.toUpperCase();
    const pill = this.caseHeaderEl.createSpan({ cls: `benchview-case-pill benchview-status-${state.status}`, text: pillText });
    if (state.status === "running" && state.startedAtMs != null) {
      this.caseHeaderEl.createDiv({
        cls: "benchview-case-duration benchview-case-runtime-live",
        text: `Running: ${formatDurationMs(Date.now() - state.startedAtMs)}`,
      });
    }
    if (state.result?.pointsEarned != null && state.result?.maxPoints != null) {
      this.caseHeaderEl.createDiv({
        cls: "benchview-case-duration",
        text: `${state.result.pointsEarned.toFixed(2)}/${state.result.maxPoints.toFixed(2)} points`,
      });
    }
    if (state.result?.durationMs != null) {
      const seconds = Math.round(state.result.durationMs / 1000);
      this.caseHeaderEl.createDiv({ cls: "benchview-case-duration", text: `${seconds}s` });
    }
    pill.setAttribute("data-status", state.status);
  }

  private startRuntimeTimers(runStartedAtMs: number): void {
    this.stopRuntimeTimers();
    this.runStartedAtMs = runStartedAtMs;
    this.updateRuntimeDisplays();
    this.runtimeIntervalId = window.setInterval(() => this.updateRuntimeDisplays(), 250);
  }

  private stopRuntimeTimers(): void {
    if (this.runtimeIntervalId != null) {
      window.clearInterval(this.runtimeIntervalId);
      this.runtimeIntervalId = null;
    }
    this.runStartedAtMs = null;
  }

  private updateRuntimeDisplays(): void {
    if (!this.isRunning || this.runStartedAtMs == null) return;

    const now = Date.now();
    const totalMs = now - this.runStartedAtMs;
    this.totalRuntimeEl.textContent = formatDurationMs(totalMs);

    for (const [caseId, state] of this.caseStates) {
      if (state.status !== "running" || state.startedAtMs == null) continue;
      const elapsedMs = now - state.startedAtMs;
      this.updateCaseRuntimeRow(caseId, elapsedMs);
      if (this.activeCaseId === caseId) {
        const liveEl = this.caseHeaderEl.querySelector(".benchview-case-runtime-live") as HTMLElement | null;
        if (liveEl) {
          liveEl.textContent = `Running: ${formatDurationMs(elapsedMs)}`;
        }
      }
    }
  }

  private updateCaseRuntimeRow(caseId: string, elapsedMs?: number): void {
    const row = this.caseListEl.querySelector(`.benchview-case-row[data-case-id="${caseId}"]`);
    if (!row) return;
    const runtimeEl = row.querySelector(".benchview-case-runtime") as HTMLElement | null;
    if (!runtimeEl) return;

    const state = this.caseStates.get(caseId);
    const finishedMs = state?.result?.durationMs;

    if (state?.status === "running") {
      const ms = elapsedMs ?? (state.startedAtMs != null ? Date.now() - state.startedAtMs : undefined);
      runtimeEl.textContent = ms != null ? formatDurationMs(ms) : "";
      return;
    }

    if (typeof finishedMs === "number" && Number.isFinite(finishedMs) && finishedMs >= 0) {
      runtimeEl.textContent = formatDurationMs(finishedMs);
      return;
    }

    runtimeEl.textContent = "";
  }

  private renderCaseTranscript(state: CaseState): void {
    this.chatContainerEl.empty();
    if (state.renderedHtml) {
      this.chatContainerEl.innerHTML = state.renderedHtml;
      return;
    }
    const messages = state.messages;
    if (!messages || messages.length === 0) {
      this.chatContainerEl.createDiv({ cls: "benchview-empty", text: "No transcript yet." });
      return;
    }

    const renderer = new MessageRenderer(this.app);
    (async () => {
      for (const msg of messages) {
        const { messageEl } = await renderer.renderMessage({
          app: this.app,
          messageId: msg.message_id || "",
          role: msg.role,
          content: msg.content || "",
          annotations: (msg as any).annotations,
        });
        if (msg.role === "assistant") {
          const partList = renderer.normalizeMessageToParts(msg);
          if (partList.parts.length > 0) {
            renderer.renderUnifiedMessageParts(messageEl, partList.parts);
          }
        }
        addMessageToContainer(this.chatContainerEl, messageEl, msg.role, msg.role === "assistant");
      }
    })();
  }

  private renderCaseDiff(state: CaseState): void {
    this.diffContainerEl.empty();
    if (!state.result) {
      this.diffContainerEl.createDiv({ cls: "benchview-empty", text: "No evaluation yet." });
      return;
    }

    if (state.result.breakdown) {
      const b = state.result.breakdown;
      const pct = typeof state.result.scorePercent === "number" ? state.result.scorePercent : (b.maxPoints > 0 ? (b.pointsEarned / b.maxPoints) * 100 : 0);
      const summary = this.diffContainerEl.createDiv({ cls: "benchview-summary" });
      summary.createDiv({ text: `Score: ${b.pointsEarned.toFixed(2)}/${b.maxPoints.toFixed(2)} (${pct.toFixed(1)}%)` });
      summary.createDiv({ text: `Correctness: ${b.correctnessPoints.toFixed(2)} | Efficiency: ${b.efficiencyPoints.toFixed(2)} | Penalties: ${b.penaltyPoints.toFixed(2)}` });
      if (state.result.metrics?.toolCallsTotal != null) {
        summary.createDiv({ text: `Tool calls: ${state.result.metrics.toolCallsTotal}` });
      }
      if (state.result.durationMs != null) {
        summary.createDiv({ text: `Wall time: ${Math.round(state.result.durationMs / 1000)}s` });
      }
    }
    if (state.result.errors && state.result.errors.length > 0) {
      const errorEl = this.diffContainerEl.createDiv({ cls: "benchview-error" });
      errorEl.createDiv({ cls: "benchview-error-title", text: "Error" });
      const list = errorEl.createEl("ul", { cls: "benchview-error-list" });
      for (const err of state.result.errors) {
        list.createEl("li", { text: err });
      }
      return;
    }
    if (!state.result.diffs || state.result.diffs.length === 0) {
      this.diffContainerEl.createDiv({ cls: "benchview-pass", text: "All expected changes applied." });
      return;
    }

    const list = this.diffContainerEl.createDiv({ cls: "benchview-diff-list" });
    for (const diff of state.result.diffs) {
      const row = list.createDiv({ cls: "benchview-diff-row" });
      row.createSpan({ text: diff.path });
    }
  }

  private async refreshModelLabel(): Promise<void> {
    try {
      const model = await this.plugin.modelService.getModelById(this.selectedModelId);
      this.modelButtonEl.textContent = model?.name ? `${model.name}` : this.selectedModelId;
    } catch {
      this.modelButtonEl.textContent = this.selectedModelId || "Select Model";
    }
  }

  private async openModelSelector(): Promise<void> {
    try {
      await this.plugin.modelService.getModels();
      const modal = new StandardModelSelectionModal({
        app: this.app,
        plugin: this.plugin,
        currentModelId: this.selectedModelId || "",
        onSelect: async (result) => {
          const canonicalId = ensureCanonicalId(result.modelId);
          this.selectedModelId = canonicalId;
          await this.refreshModelLabel();
        },
      });
      modal.open();
    } catch {
      new Notice("Unable to load models.", 4000);
    }
  }

  private async updateResultsDirectory(path: string): Promise<void> {
    const nextPath = path && path.trim().length > 0 ? path.trim() : DEFAULT_SETTINGS.benchmarksDirectory;
    await this.plugin.getSettingsManager().updateSettings({ benchmarksDirectory: nextPath });
    if (this.plugin.directoryManager) {
      await this.plugin.directoryManager.handleDirectorySettingChange("benchmarksDirectory", nextPath);
    }
    this.resultsInputEl.value = nextPath;
  }

  private async handleRunClick(): Promise<void> {
    if (this.isRunning) {
      this.abortController?.abort();
      return;
    }
    new Notice(
      "Benchmark runs are temporarily unavailable while the Pi-native benchmark harness is being rebuilt.",
      7000
    );
    return;
    await this.runBenchmark();
  }

  private async runBenchmark(): Promise<void> {
    new Notice(
      "Benchmark runs are temporarily unavailable while the Pi-native benchmark harness is being rebuilt.",
      7000
    );
  }

  private renderCaseRowStatus(caseId: string, status: BenchmarkCaseStatus, result?: BenchmarkCaseResult): void {
    const row = this.caseListEl.querySelector(`.benchview-case-row[data-case-id="${caseId}"]`);
    if (!row) return;
    const statusEl = row.querySelector(".benchview-case-status") as HTMLElement | null;
    if (!statusEl) return;
    const score = result?.scorePercent ?? this.caseStates.get(caseId)?.result?.scorePercent;
    const scoreText = typeof score === "number" && Number.isFinite(score) ? `${Math.round(score)}%` : null;
    statusEl.textContent = status === "pending" ? "Pending" : status === "running" ? "Running" : scoreText ?? status.toUpperCase();
    statusEl.className = `benchview-case-status benchview-status-${status}`;

    if (status !== "running") {
      this.updateCaseRuntimeRow(caseId);
    }
  }

  private getCaseMaxPoints(caseDef: BenchmarkCase): number {
    const raw = Number(caseDef.maxPoints ?? this.suite.defaultMaxPoints ?? 0);
    return Math.max(0, raw);
  }

  private async saveResults(): Promise<void> {
    if (!this.runResult) return;
    const outputDir = this.plugin.settings.benchmarksDirectory;
    try {
      const path = await this.harness.exportRunReport(this.runResult, outputDir);
      new Notice(`Benchmark report saved: ${path}`, 6000);
    } catch {
      new Notice("Failed to save benchmark report.", 6000);
    }
  }
}

function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
