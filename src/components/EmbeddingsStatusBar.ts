import { Component, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { EmbeddingsManager } from "../services/embeddings/EmbeddingsManager";
import type { SemanticIndexSnapshot } from "../services/embeddings/SemanticIndexLifecycle";
import { applyPluginSurface } from "../core/ui/surface";

/**
 * Compact projection of the semantic-index lifecycle.
 *
 * The Similar Notes view owns index controls and details. This item only
 * reflects the manager's observable snapshot and opens that canonical view.
 */
export class EmbeddingsStatusBar extends Component {
  private readonly statusBarEl: HTMLElement;
  private readonly valueEl: HTMLElement;
  private unsubscribeLifecycle: (() => void) | null = null;
  private manager: EmbeddingsManager | null = null;

  constructor(private readonly plugin: SystemSculptPlugin) {
    super();

    this.statusBarEl = plugin.addStatusBarItem();
    applyPluginSurface(this.statusBarEl, "embedded");
    this.statusBarEl.addClass("mod-clickable", "ss-embeddings-status-bar");
    this.statusBarEl.setAttr("role", "button");
    this.statusBarEl.setAttr("tabindex", "0");

    const icon = this.statusBarEl.createSpan({
      cls: "ss-embeddings-status-bar__icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(icon, "network");
    this.valueEl = this.statusBarEl.createSpan({
      cls: "ss-embeddings-status-bar__value",
      text: "Starting",
    });

    this.statusBarEl.addEventListener("click", () => this.openSimilarNotes());
    this.statusBarEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openSimilarNotes();
    });

    if (plugin.settings.embeddingsEnabled) {
      this.startMonitoring(plugin.embeddingsManager);
    } else {
      this.stopMonitoring();
    }
  }

  public startMonitoring(manager: EmbeddingsManager | null = this.plugin.embeddingsManager): void {
    this.setVisibility(true);
    if (manager && manager === this.manager && this.unsubscribeLifecycle) {
      this.render(manager.getLifecycleSnapshot());
      return;
    }

    this.unbindManager();
    this.manager = manager;
    if (!manager) {
      this.renderStarting();
      return;
    }

    this.unsubscribeLifecycle = manager.subscribeLifecycle((snapshot) => {
      this.render(snapshot);
    });
  }

  public stopMonitoring(): void {
    this.unbindManager();
    this.setVisibility(false);
  }

  public override onunload(): void {
    this.unbindManager();
    this.statusBarEl.remove();
  }

  private unbindManager(): void {
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
    this.manager = null;
  }

  private renderStarting(): void {
    this.setText("Starting", "Semantic index starting");
    this.statusBarEl.title = "Semantic index is starting. Open similar notes.";
  }

  private render(snapshot: Readonly<SemanticIndexSnapshot>): void {
    if (!snapshot.ready || snapshot.phase === "initializing") {
      this.renderStarting();
      return;
    }

    if (snapshot.phase === "paused") {
      this.setText("Paused", "Semantic index paused");
      this.statusBarEl.title = "Semantic index is paused. Open similar notes.";
      return;
    }

    if (snapshot.phase === "error" || snapshot.failed > 0) {
      const label = snapshot.failed > 0 ? `${snapshot.failed} failed` : "Error";
      this.setText(label, `Semantic index ${label}`);
      this.statusBarEl.title = snapshot.lastError?.message
        ? `${snapshot.lastError.message} Open Similar notes.`
        : "Semantic index needs attention. Open similar notes.";
      return;
    }

    if (snapshot.phase === "reconciling" || snapshot.pending > 0) {
      const total = Math.max(snapshot.total, snapshot.completed + snapshot.pending);
      const label = total > 0
        ? `${Math.min(snapshot.completed, total)}/${total}`
        : `${snapshot.pending} pending`;
      this.setText(label, `Semantic index ${label}`);
      const current = snapshot.currentPath?.split("/").pop();
      this.statusBarEl.title = current
        ? `Indexing ${current}. Open similar notes.`
        : "Updating semantic index. Open similar notes.";
      return;
    }

    const label = snapshot.total > 0 ? this.formatCompact(snapshot.completed) : "Ready";
    this.setText(label, snapshot.total > 0
      ? `Semantic index ready, ${snapshot.completed} notes`
      : "Semantic index ready");
    this.statusBarEl.title = snapshot.total > 0
      ? `${snapshot.completed} notes indexed. Open similar notes.`
      : "Semantic index is ready. Open similar notes.";
  }

  private setText(value: string, accessibleName: string): void {
    this.valueEl.setText(value);
    this.statusBarEl.setAttr("aria-label", accessibleName);
  }

  private setVisibility(visible: boolean): void {
    this.statusBarEl.toggleAttribute("hidden", !visible);
    this.statusBarEl.toggleAttribute("aria-hidden", !visible);
  }

  private formatCompact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
    return String(Math.max(0, value));
  }

  private openSimilarNotes(): void {
    void this.plugin.getViewManager().activateEmbeddingsView();
  }
}
