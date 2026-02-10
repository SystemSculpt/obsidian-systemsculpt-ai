import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { StandardModelSelectionModal } from "../../modals/StandardModelSelectionModal";
import { ensureCanonicalId } from "../../utils/modelUtils";
import { PromptBuilder } from "../../services/PromptBuilder";
import { MCPService } from "../../mcp/MCPService";
import { ToolCallManager } from "../chatview/ToolCallManager";
import { MessageRenderer } from "../chatview/MessageRenderer";
import { ScrollManagerService } from "../chatview/ScrollManagerService";
import { StreamingController } from "../chatview/controllers/StreamingController";
import { addMessageToContainer, createAssistantMessageContainer, hideStreamingStatus, showStreamingStatus, updateStreamingStatus, setStreamingFootnote, clearStreamingFootnote } from "../chatview/handlers/MessageElements";
import { toolDefinitions } from "../../mcp-tools/filesystem/toolDefinitions";
import { OBSIDIAN_BENCHMARK_V2, BENCH_ROOT_PLACEHOLDER } from "../../benchmarks/obsidianCoreV2";
import { BenchmarkHarness } from "../../services/benchmark/BenchmarkHarness";
import type { BenchmarkCase, BenchmarkCaseResult, BenchmarkCaseStatus, BenchmarkRunResult, BenchmarkScoreBreakdown } from "../../types/benchmark";
import type { ChatMessage } from "../../types";
import { DEFAULT_SETTINGS } from "../../types";
import { attachFolderSuggester } from "../../components/FolderSuggester";
import { normalizePath } from "obsidian";
import { errorLogger } from "../../utils/errorLogger";

export const BENCH_VIEW_TYPE = "systemsculpt-bench-view";

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
    await this.runBenchmark();
  }

  private async runBenchmark(): Promise<void> {
    if (this.isRunning) return;
    this.ensureCaseStatesInitialized();

    const casesToRun = this.getVisibleCases();
    if (casesToRun.length === 0) {
      new Notice("No tests selected for this difficulty filter.", 5000);
      return;
    }

    const resolvedModelId = this.selectedModelId?.trim();
    if (!resolvedModelId) {
      new Notice("Select a model before running the benchmark.", 5000);
      return;
    }
    try {
      let model = await this.plugin.modelService.getModelById(resolvedModelId);
      if (!model) {
        try {
          await this.plugin.modelService.getModels();
          model = await this.plugin.modelService.getModelById(resolvedModelId);
        } catch (_) {}
      }
      if (!model) {
        new Notice(`Model not found: ${resolvedModelId}`, 6000);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Unable to load model: ${message}`, 6000);
      return;
    }

    this.isRunning = true;
    this.runButtonEl.textContent = "Stop";
    this.saveButtonEl.disabled = true;
    this.modelButtonEl.disabled = true;
    this.resultsInputEl.disabled = true;
    this.difficultySelectEl.disabled = true;
    this.runResult = null;

    const runId = this.createRunId();
    const runStartedAt = new Date().toISOString();
    const runStartedAtMs = Date.now();
    this.totalRuntimeEl.textContent = "0s";
    this.startRuntimeTimers(runStartedAtMs);
    const caseResults: BenchmarkCaseResult[] = [];

    let paths: Awaited<ReturnType<BenchmarkHarness["ensureBenchmarkDirs"]>>;
    try {
      paths = await this.harness.ensureBenchmarkDirs(runId);
      await this.harness.pruneOldRuns(paths.runs);
      await this.harness.resetActiveSandbox(paths.active);
    } catch (error) {
      const errMsg = this.formatError(error);
      errorLogger.error("Benchmark setup failed", error as Error, {
        source: "BenchView",
        method: "runBenchmark",
        metadata: { runId, modelId: resolvedModelId },
      });
      new Notice(`Benchmark setup failed: ${errMsg}`, 7000);
      this.isRunning = false;
      this.stopRuntimeTimers();
      this.totalRuntimeEl.textContent = "—";
      this.runButtonEl.textContent = "Run";
      this.saveButtonEl.disabled = true;
      this.modelButtonEl.disabled = false;
      this.resultsInputEl.disabled = false;
      this.difficultySelectEl.disabled = false;
      this.updateRunButtonState();
      return;
    }

    const benchSettings = this.buildBenchSettings();
    const mcpService = new MCPService(this.plugin, this.app, () => benchSettings);
    const benchDisplayRoot = this.getBenchDisplayRoot();
    const systemPromptOverride = await this.buildBenchSystemPrompt(benchSettings, benchDisplayRoot);
    mcpService.setFilesystemRoot(paths.active, [benchDisplayRoot]);

    this.abortController = new AbortController();

    const plannedCaseIds = new Set(casesToRun.map((caseDef) => caseDef.id));

    for (const caseDef of casesToRun) {
      const state = this.caseStates.get(caseDef.id);
      if (!state) continue;
      state.status = "pending";
      state.result = undefined;
      state.messages = undefined;
      state.renderedHtml = undefined;
      state.startedAtMs = undefined;
      this.renderCaseRowStatus(caseDef.id, state.status);
      this.updateCaseRuntimeRow(caseDef.id);
    }

    for (const caseDef of casesToRun) {
      const state = this.caseStates.get(caseDef.id);
      if (!state) continue;
      const caseStartedAt = new Date().toISOString();
      const caseStartedAtMs = Date.now();
      state.startedAtMs = caseStartedAtMs;
      state.status = "running";
      this.renderCaseRowStatus(caseDef.id, state.status);
      this.updateCaseRuntimeRow(caseDef.id, 0);
      this.selectCase(caseDef.id);

      let caseMessages: ChatMessage[] = [];
      let caseResult: BenchmarkCaseResult | null = null;

      try {
        await this.harness.resetActiveSandbox(paths.active);
        mcpService.setFilesystemAllowedPaths([paths.active]);

        const { messages } = await this.runCaseConversation({
          caseDef,
          mcpService,
          benchSettings,
          systemPromptOverride,
          signal: this.abortController.signal,
        });

        caseMessages = messages;
        state.messages = messages;
        const evalResult = await this.harness.evaluateCase(paths.active, caseDef, caseStartedAt, messages);
        evalResult.messages = messages;
        caseResult = evalResult;
        state.result = evalResult;
        state.renderedHtml = this.chatContainerEl.innerHTML;
        state.status = evalResult.status;
        caseResults.push(evalResult);
      } catch (error) {
        try {
          caseMessages = (error as any)?.benchMessages ?? caseMessages;
          state.messages = caseMessages;
        } catch {}
        const errMsg = this.formatError(error);
        errorLogger.error("Benchmark case failed", error as Error, {
          source: "BenchView",
          method: "runBenchmark",
          metadata: { caseId: caseDef.id, runId, modelId: resolvedModelId },
        });
        state.status = this.abortController.signal.aborted ? "skipped" : "error";
        const caseEndedAt = new Date().toISOString();
        const durationMs = Date.parse(caseEndedAt) - Date.parse(caseStartedAt);
        const maxPoints = this.getCaseMaxPoints(caseDef);
        const breakdown: BenchmarkScoreBreakdown = {
          correctnessPoints: 0,
          efficiencyPoints: 0,
          penaltyPoints: 0,
          pointsEarned: 0,
          maxPoints,
          correctnessFraction: 0,
          efficiencyFraction: 0,
        };
        caseResult = {
          caseId: caseDef.id,
          status: state.status,
          startedAt: caseStartedAt,
          endedAt: caseEndedAt,
          durationMs,
          pointsEarned: 0,
          maxPoints,
          scorePercent: 0,
          breakdown,
          errors: [errMsg],
        };
        state.result = caseResult;
        caseResults.push(state.result);
      } finally {
        state.messages = caseMessages;
        if (caseResult) {
          caseResult.messages = caseResult.messages ?? caseMessages;
        }
        try {
          await this.harness.snapshotActiveCase(paths.active, paths.run, caseDef.id);
        } catch (error) {
          errorLogger.error("Benchmark snapshot failed", error as Error, {
            source: "BenchView",
            method: "runBenchmark",
            metadata: { caseId: caseDef.id, runId, modelId: resolvedModelId },
          });
        }
        try {
          if (caseResult) {
            await this.harness.writeCaseArtifacts(paths.run, caseDef.id, { result: caseResult, messages: caseMessages });
          }
        } catch (error) {
          errorLogger.error("Benchmark artifact export failed", error as Error, {
            source: "BenchView",
            method: "runBenchmark",
            metadata: { caseId: caseDef.id, runId, modelId: resolvedModelId },
          });
        }
        this.renderCaseRowStatus(caseDef.id, state.status, caseResult ?? undefined);
        this.updateCaseRuntimeRow(caseDef.id);
        this.renderCaseHeader(state);
        this.renderCaseDiff(state);
        if (this.abortController.signal.aborted) {
          break;
        }
      }
    }

    if (this.abortController.signal.aborted) {
      for (const state of this.caseStates.values()) {
        if (!plannedCaseIds.has(state.caseDef.id)) continue;
        if (state.status === "pending") {
          state.status = "skipped";
          const maxPoints = this.getCaseMaxPoints(state.caseDef);
          const breakdown: BenchmarkScoreBreakdown = {
            correctnessPoints: 0,
            efficiencyPoints: 0,
            penaltyPoints: 0,
            pointsEarned: 0,
            maxPoints,
            correctnessFraction: 0,
            efficiencyFraction: 0,
          };
          const skippedResult: BenchmarkCaseResult = {
            caseId: state.caseDef.id,
            status: "skipped",
            startedAt: runStartedAt,
            endedAt: new Date().toISOString(),
            pointsEarned: 0,
            maxPoints,
            scorePercent: 0,
            breakdown,
          };
          state.result = skippedResult;
          caseResults.push(skippedResult);
          this.renderCaseRowStatus(state.caseDef.id, state.status, skippedResult);
        }
      }
    }

    const runEndedAt = new Date().toISOString();
    const runDuration = Date.parse(runEndedAt) - Date.parse(runStartedAt);
    const totalPointsEarned = caseResults.reduce((sum, result) => sum + (result.pointsEarned ?? 0), 0);
    const totalMaxPoints = caseResults.reduce((sum, result) => sum + (result.maxPoints ?? 0), 0);
    const runScorePercent = totalMaxPoints > 0 ? Math.max(0, Math.min(100, (totalPointsEarned / totalMaxPoints) * 100)) : 0;
    this.runResult = {
      runId,
      modelId: this.selectedModelId,
      suiteId: this.suite.id,
      suiteVersion: this.suite.version,
      totalPointsEarned,
      totalMaxPoints,
      scorePercent: runScorePercent,
      startedAt: runStartedAt,
      endedAt: runEndedAt,
      durationMs: runDuration,
      cases: caseResults,
    };
    await this.harness.writeRunSummary(paths.run, this.runResult);

    this.isRunning = false;
    this.stopRuntimeTimers();
    this.totalRuntimeEl.textContent = formatDurationMs(runDuration);
    this.runButtonEl.textContent = "Run";
    this.saveButtonEl.disabled = !this.runResult;
    this.modelButtonEl.disabled = false;
    this.resultsInputEl.disabled = false;
    this.difficultySelectEl.disabled = false;
    this.updateRunButtonState();
    this.abortController = null;
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

  private async runCaseConversation({
    caseDef,
    mcpService,
    benchSettings,
    systemPromptOverride,
    signal,
  }: {
    caseDef: BenchmarkCase;
    mcpService: MCPService;
    benchSettings: any;
    systemPromptOverride: string;
    signal: AbortSignal;
  }): Promise<{ messages: ChatMessage[] }> {
    this.chatContainerEl.empty();

    const toolCallManager = new ToolCallManager(mcpService, { plugin: { settings: benchSettings } });
    const renderer = new MessageRenderer(this.app, toolCallManager);
    const scrollManager = new ScrollManagerService({ container: this.chatContainerEl });
    const liveRegion = this.chatContainerEl.createDiv({ cls: "benchview-live-region", attr: { "aria-live": "polite" } });

    const messages: ChatMessage[] = [];

    const onAssistantResponse = async (message: ChatMessage) => {
      const existingIndex = messages.findIndex((m) => m.message_id === message.message_id);
      if (existingIndex !== -1) {
        const existing = messages[existingIndex];
        let mergedToolCalls = message.tool_calls;
        if (existing.tool_calls || message.tool_calls) {
          const existingMap = new Map((existing.tool_calls || []).map((tc) => [tc.id, tc]));
          const newMap = new Map((message.tool_calls || []).map((tc) => [tc.id, tc]));
          const mergedMap = new Map([...existingMap, ...newMap]);
          for (const [id, existingTc] of existingMap) {
            if (existingTc.result && mergedMap.has(id)) {
              const mergedTc = mergedMap.get(id)!;
              if (!mergedTc.result) {
                mergedTc.result = existingTc.result;
              }
            }
          }
          mergedToolCalls = Array.from(mergedMap.values());
        }

        messages[existingIndex] = {
          ...existing,
          ...message,
          content: message.content || existing.content,
          reasoning: message.reasoning || existing.reasoning,
          reasoning_details: (message as any).reasoning_details ?? (existing as any).reasoning_details,
          tool_calls: mergedToolCalls,
          messageParts: message.messageParts || existing.messageParts,
        };
      } else {
        messages.push(message);
      }
    };

    const streamingController = new StreamingController({
      toolCallManager,
      scrollManager,
      messageRenderer: renderer,
      saveChat: async () => {},
      generateMessageId: () => this.createMessageId(),
      extractAnnotations: () => [],
      showStreamingStatus: (el) => showStreamingStatus(el, liveRegion),
      hideStreamingStatus: (el) => hideStreamingStatus(el, liveRegion),
      updateStreamingStatus: (el, status, text, metrics) => updateStreamingStatus(el, liveRegion, status, text, metrics),
      toggleStopButton: () => {},
      onAssistantResponse,
      onError: (err) => {
        if (err instanceof Error) {
          new Notice(err.message, 6000);
        }
      },
      setStreamingFootnote: (el, text) => setStreamingFootnote(el, text),
      clearStreamingFootnote: (el) => clearStreamingFootnote(el),
    });

    try {
      for (const rawPrompt of caseDef.prompts) {
        if (signal.aborted) break;
        const benchRoot = this.getBenchDisplayRoot();
        const prompt = rawPrompt.split(BENCH_ROOT_PLACEHOLDER).join(benchRoot);
        const messageId = this.createMessageId();
        const userMessage: ChatMessage = { role: "user", content: prompt, message_id: messageId };
        messages.push(userMessage);
        const { messageEl } = await renderer.renderMessage({
          app: this.app,
          messageId,
          role: "user",
          content: prompt,
        });
        addMessageToContainer(this.chatContainerEl, messageEl, "user", true);
        try {
          const container = createAssistantMessageContainer(
            this.chatContainerEl,
            () => this.createMessageId(),
            this,
            true
          );
          const assistantMessageId = container.messageEl.dataset.messageId || this.createMessageId();
          container.messageEl.dataset.messageId = assistantMessageId;

          const stream = this.plugin.aiService.streamMessage({
            messages,
            model: this.selectedModelId,
            contextFiles: new Set<string>(),
            systemPromptType: "agent",
            systemPromptOverride,
            agentMode: true,
            signal,
            toolCallManager,
            sessionId: caseDef.id,
          });

	          await streamingController.stream(
	            stream,
	            container.messageEl,
	            assistantMessageId,
	            signal
	          );
	        } catch (error: any) {
          try {
            (error as any).benchMessages = messages;
          } catch {}
          throw error;
        }
      }

      return { messages };
    } finally {
      scrollManager.destroy();
      toolCallManager.clear();
    }
  }

  private buildBenchSettings(): any {
    const base = this.plugin.settings;
    // Internal servers (mcp-filesystem) now bypass all settings checks,
    // so we only need to ensure the server is present
    return {
      ...base,
      mcpServers: [
        {
          id: "mcp-filesystem",
          name: "Filesystem",
          transport: "internal",
          isEnabled: true,
        },
      ],
    };
  }

  private async buildBenchSystemPrompt(settings: any, benchRoot: string): Promise<string> {
    const basePrompt = await PromptBuilder.buildSystemPrompt(
      this.app,
      () => settings,
      { type: "agent", agentMode: true, hasTools: true }
    );

    const normalizedRoot = normalizePath(benchRoot);
    return `${basePrompt}\n\nYou are running a deterministic benchmark inside an isolated sandbox.\nThe vault root is ${normalizedRoot}.\nTreat paths as relative to this root (e.g., Inbox/Note.md). If a path already includes the root, it is still valid.\nThe sandbox is pre-populated with all files mentioned in the prompts. Do not create new files unless explicitly instructed.\nAlways use the filesystem tools to read and modify files.`;
  }

  private getBenchDisplayRoot(): string {
    return "BenchmarkVault";
  }

  private createMessageId(): string {
    const cryptoObj: any = typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
    if (cryptoObj?.randomUUID) {
      return cryptoObj.randomUUID();
    }
    return `bench_${Math.random().toString(36).slice(2, 10)}`;
  }

  private createRunId(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${date}-${time}`;
  }

  private formatError(error: unknown): string {
    const isObject = error !== null && typeof error === "object";
    if (isObject) {
      const err: any = error as any;
      if (err?.name === "SystemSculptError") {
        const code = typeof err.code === "string" ? err.code : undefined;
        const statusCode = typeof err.statusCode === "number" ? err.statusCode : undefined;
        const metadata = err.metadata && typeof err.metadata === "object" ? err.metadata : undefined;

        const safeMetadata = metadata
          ? {
              provider: metadata.provider,
              model: metadata.model,
              statusCode: metadata.statusCode,
              requestId: metadata.requestId,
              errorType: metadata.errorType,
              errorHttpCode: metadata.errorHttpCode,
              shouldResubmit: metadata.shouldResubmit,
              shouldResubmitWithoutTools: metadata.shouldResubmitWithoutTools,
              toolSupport: metadata.toolSupport,
              upstreamMessage: metadata.upstreamMessage,
              rawError: metadata.rawError,
            }
          : undefined;

        const stringifyWithLimit = (value: unknown, maxChars: number): string => {
          try {
            const json = JSON.stringify(value, null, 2);
            if (json.length <= maxChars) return json;
            return `${json.slice(0, maxChars)}…(truncated)`;
          } catch {
            return "[unserializable]";
          }
        };

        const header = `SystemSculptError: ${String(err.message || "").trim() || "Unknown error"}`;
        const metaLine = safeMetadata ? `metadata: ${stringifyWithLimit(safeMetadata, 2000)}` : null;
        const stack = typeof err.stack === "string" && err.stack.includes("\n")
          ? err.stack.split("\n").slice(1).join("\n")
          : null;

        return [
          header,
          code ? `code: ${code}` : null,
          statusCode != null ? `status: ${statusCode}` : null,
          metaLine,
          stack,
        ]
          .filter((line): line is string => typeof line === "string" && line.length > 0)
          .join("\n");
      }
    }

    if (error instanceof Error) {
      return error.stack || error.message;
    }

    return String(error);
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
