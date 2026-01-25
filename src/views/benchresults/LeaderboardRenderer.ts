import { setIcon } from "obsidian";
import type { LeaderboardEntry, LoadResult } from "./types";

/**
 * Renders the benchmark leaderboard UI with SVG progress bars.
 */
export class LeaderboardRenderer {
  /**
   * Render the leaderboard into the given container.
   */
  render(container: HTMLElement, result: LoadResult): void {
    container.empty();

    if (result.status === "error") {
      this.renderError(container, result.errorMessage);
      return;
    }

    if (result.status === "empty" || result.entries.length === 0) {
      this.renderEmpty(container);
      return;
    }

    this.renderList(container, result.entries);
  }

  /**
   * Render loading state.
   */
  renderLoading(container: HTMLElement): void {
    container.empty();
    const loadingEl = container.createDiv({ cls: "benchresults-loading" });
    loadingEl.createSpan({ text: "Loading benchmark results..." });
  }

  /**
   * Render the leaderboard list.
   */
  private renderList(container: HTMLElement, entries: LeaderboardEntry[]): void {
    const listEl = container.createDiv({ cls: "benchresults-list" });

    for (const entry of entries) {
      this.renderEntry(listEl, entry);
    }
  }

  /**
   * Render a single leaderboard entry.
   */
  private renderEntry(container: HTMLElement, entry: LeaderboardEntry): void {
    const entryEl = container.createDiv({ cls: "benchresults-entry" });

    // Rank badge
    const rankEl = entryEl.createDiv({ cls: "benchresults-rank" });
    if (entry.rank === 1) {
      rankEl.addClass("benchresults-rank-first");
    }
    rankEl.textContent = `#${entry.rank}`;

    // Model info
    const infoEl = entryEl.createDiv({ cls: "benchresults-info" });
    const modelEl = infoEl.createDiv({ cls: "benchresults-model" });
    modelEl.textContent = entry.modelDisplayName;
    modelEl.setAttribute("title", entry.modelId);

    const metaEl = infoEl.createDiv({ cls: "benchresults-meta" });
    metaEl.createSpan({ cls: "benchresults-date", text: this.formatDate(entry.runDate) });
    metaEl.createSpan({ cls: "benchresults-points", text: `${entry.totalPointsEarned.toFixed(1)}/${entry.totalMaxPoints.toFixed(1)} pts` });

    // Score bar container
    const barContainerEl = entryEl.createDiv({ cls: "benchresults-bar-container" });
    this.renderSvgBar(barContainerEl, entry.scorePercent);

    // Score percentage
    const scoreEl = entryEl.createDiv({ cls: "benchresults-score" });
    scoreEl.textContent = `${Math.round(entry.scorePercent)}%`;
    scoreEl.addClass(this.getScoreClass(entry.scorePercent));
  }

  /**
   * Render an SVG progress bar.
   */
  private renderSvgBar(container: HTMLElement, percent: number): void {
    const width = 100;
    const height = 6;
    const safePercent = Math.max(0, Math.min(100, percent));
    const fillWidth = (safePercent / 100) * width;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("class", "benchresults-svg-bar");
    svg.setAttribute("aria-label", `Score: ${Math.round(percent)}%`);

    // Background rect
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("width", String(width));
    bgRect.setAttribute("height", String(height));
    bgRect.setAttribute("rx", "3");
    bgRect.setAttribute("class", "benchresults-bar-bg");
    svg.appendChild(bgRect);

    // Fill rect
    if (fillWidth > 0) {
      const fillRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      fillRect.setAttribute("width", String(Math.max(fillWidth, 3))); // Min width for visibility
      fillRect.setAttribute("height", String(height));
      fillRect.setAttribute("rx", "3");
      fillRect.setAttribute("class", `benchresults-bar-fill ${this.getScoreClass(percent)}`);
      svg.appendChild(fillRect);
    }

    container.appendChild(svg);
  }

  /**
   * Get CSS class for score coloring.
   */
  private getScoreClass(percent: number): string {
    if (percent >= 75) return "benchresults-score-high";
    if (percent >= 50) return "benchresults-score-medium";
    return "benchresults-score-low";
  }

  /**
   * Render empty state.
   */
  private renderEmpty(container: HTMLElement): void {
    const emptyEl = container.createDiv({ cls: "benchresults-empty" });

    const iconEl = emptyEl.createDiv({ cls: "benchresults-empty-icon" });
    setIcon(iconEl, "flask-conical");

    emptyEl.createDiv({
      cls: "benchresults-empty-title",
      text: "No benchmark results yet",
    });

    emptyEl.createDiv({
      cls: "benchresults-empty-desc",
      text: "Run the benchmark to compare model performance.",
    });
  }

  /**
   * Render error state.
   */
  private renderError(container: HTMLElement, message?: string): void {
    const errorEl = container.createDiv({ cls: "benchresults-error" });

    const iconEl = errorEl.createDiv({ cls: "benchresults-error-icon" });
    setIcon(iconEl, "alert-circle");

    errorEl.createDiv({
      cls: "benchresults-error-title",
      text: "Failed to load results",
    });

    if (message) {
      errorEl.createDiv({
        cls: "benchresults-error-message",
        text: message,
      });
    }
  }

  /**
   * Format a date for display.
   */
  private formatDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return "Today";
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
    } else {
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
      });
    }
  }
}
