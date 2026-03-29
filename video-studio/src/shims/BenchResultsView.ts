export class BenchResultsView {
  containerEl: HTMLDivElement;
  containerElRoot: HTMLElement | null;
  leaderboardEl: HTMLDivElement;
  renderer: {
    render: (target: HTMLElement, result: { status?: string; error?: { message?: string }; data?: { leaderboard?: unknown[] } }) => void;
  };

  constructor() {
    this.containerEl = document.createElement("div");
    this.containerEl.addClass("systemsculpt-benchresults-shell");

    const header = document.createElement("div");
    header.addClass("systemsculpt-benchresults-header");

    const content = document.createElement("div");
    content.addClass("systemsculpt-benchresults-content");

    this.containerEl.append(header, content);
    this.containerElRoot = content;
    this.leaderboardEl = document.createElement("div");
    this.leaderboardEl.addClass("systemsculpt-benchresults-leaderboard");
    this.renderer = {
      render: (target, result) => {
        target.empty();

        const rows = result.data?.leaderboard ?? [];
        if (result.status === "error") {
          target.createDiv({
            cls: "systemsculpt-benchresults-error",
            text: result.error?.message ?? "Unable to load benchmark results.",
          });
          return;
        }

        if (!rows.length) {
          target.createDiv({
            cls: "systemsculpt-benchresults-empty",
            text: "No benchmark runs available yet.",
          });
          return;
        }

        rows.forEach((entry: any, index) => {
          const row = target.createDiv({ cls: "systemsculpt-benchresults-row" });
          row.createSpan({ cls: "systemsculpt-benchresults-rank", text: `#${index + 1}` });
          row.createSpan({
            cls: "systemsculpt-benchresults-model",
            text: entry.modelDisplayName ?? entry.modelId ?? "Unknown model",
          });
          row.createSpan({
            cls: "systemsculpt-benchresults-score",
            text: `${entry.scorePercent ?? 0}%`,
          });
        });
      },
    };
  }

  buildHeader() {
    const header = this.containerEl.children[0] as HTMLElement | undefined;
    if (!header) {
      return;
    }

    header.empty();
    header.createDiv({
      cls: "systemsculpt-benchresults-title",
      text: "Benchmark leaderboard",
    });
    header.createDiv({
      cls: "systemsculpt-benchresults-subtitle",
      text: "Compare model runs inside the plugin surface.",
    });
  }

  buildContent() {
    const content = (this.containerElRoot ??
      (this.containerEl.children[1] as HTMLElement | undefined)) as HTMLElement | undefined;
    if (!content) {
      return;
    }

    content.empty();
    content.appendChild(this.leaderboardEl);
  }
}
