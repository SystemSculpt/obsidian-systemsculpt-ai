import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { BenchResultsDataLoader } from "./BenchResultsDataLoader";
import { LeaderboardRenderer } from "./LeaderboardRenderer";

export const BENCH_RESULTS_VIEW_TYPE = "systemsculpt-bench-results-view";

/**
 * View displaying a leaderboard of benchmark results.
 * Shows the latest run per model, ranked by score.
 */
export class BenchResultsView extends ItemView {
  private plugin: SystemSculptPlugin;
  private dataLoader: BenchResultsDataLoader;
  private renderer: LeaderboardRenderer;

  private containerElRoot: HTMLElement;
  private headerEl: HTMLElement;
  private leaderboardEl: HTMLElement;
  private refreshBtn: HTMLButtonElement;

  private isLoading = false;

  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.dataLoader = new BenchResultsDataLoader(plugin);
    this.renderer = new LeaderboardRenderer();
  }

  getViewType(): string {
    return BENCH_RESULTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Benchmark Results";
  }

  getIcon(): string {
    return "trophy";
  }

  async onOpen(): Promise<void> {
    this.containerElRoot = this.containerEl.children[1] as HTMLElement;
    this.containerElRoot.empty();
    this.containerElRoot.addClass("systemsculpt-benchresults-view");

    this.buildHeader();
    this.buildContent();

    await this.refresh();
  }

  async onClose(): Promise<void> {
    // Cleanup if needed
  }

  /**
   * Build the header section.
   */
  private buildHeader(): void {
    this.headerEl = this.containerElRoot.createDiv({ cls: "benchresults-header" });

    const titleEl = this.headerEl.createDiv({ cls: "benchresults-title" });
    titleEl.textContent = "Benchmark Results";

    this.refreshBtn = this.headerEl.createEl("button", {
      cls: "benchresults-refresh-btn clickable-icon",
      attr: { "aria-label": "Refresh results" },
    });
    setIcon(this.refreshBtn, "refresh-cw");
    this.refreshBtn.addEventListener("click", () => this.refresh());
  }

  /**
   * Build the content area.
   */
  private buildContent(): void {
    this.leaderboardEl = this.containerElRoot.createDiv({ cls: "benchresults-content" });
  }

  /**
   * Refresh the leaderboard data.
   */
  private async refresh(): Promise<void> {
    if (this.isLoading) return;

    this.isLoading = true;
    this.refreshBtn.disabled = true;
    this.refreshBtn.addClass("is-loading");

    this.renderer.renderLoading(this.leaderboardEl);

    try {
      const result = await this.dataLoader.loadLeaderboard();
      this.renderer.render(this.leaderboardEl, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.renderer.render(this.leaderboardEl, {
        status: "error",
        entries: [],
        errorMessage: message,
      });
    } finally {
      this.isLoading = false;
      this.refreshBtn.disabled = false;
      this.refreshBtn.removeClass("is-loading");
    }
  }
}
