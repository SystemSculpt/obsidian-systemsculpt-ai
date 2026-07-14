import { Component, setIcon } from "obsidian";
import {
  applyPluginSurface,
  createUiAction,
  createUiState,
  updateUiAction,
  type UiStateKind,
} from "../core/ui/surface";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";
import type { ProcessingProgress, SearchResult } from "../services/embeddings/types";
import type { SemanticIndexSnapshot } from "../services/embeddings/SemanticIndexLifecycle";
import { readEmbeddingErrorMessage } from "../services/embeddings/EmbeddingErrorMessage";

export type SimilarNotesViewModel =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "disabled" }>
  | Readonly<{ state: "empty-content" }>
  | Readonly<{ state: "error"; message: string }>
  | Readonly<{ state: "index-required" }>
  | Readonly<{ state: "processing" }>
  | Readonly<{
      state: "results";
      sourceName: string;
      results: readonly SearchResult[];
      chatContext: boolean;
    }>;

export type SimilarNotesPresentationActions = Readonly<{
  onRefresh: () => void | Promise<void>;
  onOpenSettings: () => void;
  onOpenPendingFiles: () => void;
  onStartProcessing: () => void | Promise<void>;
  onOpenFile: (path: string) => void | Promise<void>;
  onAddToContext: (path: string) => void | Promise<void>;
  onDragStateChange: (dragging: boolean) => void;
  isInContext: (path: string) => boolean;
}>;

type StatePaneOptions = Readonly<{
  kind: "idle" | "disabled" | "empty" | "error" | "index" | "processing" | "no-results";
  icon: string;
  title: string;
  description: string;
}>;

const DRAG_RELEASE_TIMEOUT_MS = 5_000;

function createIconButton(parent: HTMLElement, label: string, icon: string): HTMLButtonElement {
  const button = createUiAction(parent, {
    label,
    icon,
    size: "icon",
  });
  button.addClass("ss-embeddings-view__icon-button");
  return button;
}

function stateKind(kind: StatePaneOptions["kind"]): UiStateKind {
  if (kind === "error") return "error";
  if (kind === "processing") return "loading";
  return "empty";
}

function readTitle(result: SearchResult): string {
  return result.metadata?.title?.trim() || result.path.split("/").pop() || result.path;
}

function readFolder(path: string): string | null {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
}

function similarityPercent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

/**
 * Owns the complete Similar Notes presentation state machine.
 *
 * The view coordinator supplies one view model and semantic actions; DOM shape,
 * copy, keyboard behavior, progress, result density, and drag affordances stay
 * local to this module.
 */
export class SimilarNotesPresentation extends Component {
  public readonly element: HTMLElement;

  private readonly contextEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly indexStatusEl: HTMLElement;
  private readonly resultsEl: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private currentModel: SimilarNotesViewModel = { state: "idle" };
  private sourceName: string | null = null;
  private dragReleaseTimer: number | null = null;
  private dragging = false;

  constructor(parent: HTMLElement, private readonly actions: SimilarNotesPresentationActions) {
    super();

    this.element = parent.createDiv({ cls: "ss-embeddings-view" });
    applyPluginSurface(this.element, "view");

    const header = this.element.createEl("header", { cls: "ss-embeddings-view__header" });
    const identity = header.createDiv({ cls: "ss-embeddings-view__identity" });
    const titleRow = identity.createDiv({ cls: "ss-embeddings-view__title-row" });
    const icon = titleRow.createSpan({ cls: "ss-embeddings-view__icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "network");
    titleRow.createSpan({ cls: "ss-embeddings-view__title", text: "Similar notes" });
    this.statusEl = titleRow.createSpan({ cls: "ss-embeddings-view__count" });

    this.contextEl = identity.createDiv({
      cls: "ss-embeddings-view__context",
      attr: { "aria-live": "polite" },
    });

    const toolbar = header.createDiv({ cls: "ss-embeddings-view__actions" });
    this.refreshButton = createIconButton(toolbar, "Refresh similar notes", "refresh-cw");
    const pendingButton = createIconButton(toolbar, "Remaining embeddings", "list-checks");
    const settingsButton = createIconButton(toolbar, "Embeddings settings", "settings-2");

    this.registerDomEvent(this.refreshButton, "click", () => void this.actions.onRefresh());
    this.registerDomEvent(pendingButton, "click", () => this.actions.onOpenPendingFiles());
    this.registerDomEvent(settingsButton, "click", () => this.actions.onOpenSettings());

    this.indexStatusEl = this.element.createDiv({
      cls: "ss-embeddings-view__index-status",
      attr: { "aria-live": "polite" },
    });
    this.indexStatusEl.hidden = true;
    this.registerDomEvent(this.indexStatusEl, "click", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-index-action]")
        : null;
      if (target?.dataset.indexAction === "pending") {
        this.actions.onOpenPendingFiles();
      }
    });

    this.resultsEl = this.element.createDiv({
      cls: "ss-embeddings-view__results",
      attr: { "aria-live": "polite", "aria-busy": "false" },
    });

    this.render({ state: "idle" });
  }

  public setSourceName(sourceName: string | null): void {
    this.sourceName = sourceName?.trim() || null;
    this.syncHeader();
  }

  public setRefreshing(refreshing: boolean): void {
    this.element.classList.toggle("is-refreshing", refreshing);
    updateUiAction(this.refreshButton, { disabled: refreshing, busy: refreshing });
    this.resultsEl.setAttribute("aria-busy", refreshing ? "true" : "false");
  }

  /**
   * Removes lifecycle state when semantic indexing is not an active capability.
   * This keeps a previously-rendered progress/error strip from surviving an
   * enabled -> disabled settings transition.
   */
  public clearIndexSnapshot(): void {
    this.indexStatusEl.empty();
    this.indexStatusEl.removeClass(
      "is-initializing",
      "is-processing",
      "is-paused",
      "is-error",
    );
    this.indexStatusEl.hidden = true;
  }

  public setIndexSnapshot(snapshot: Readonly<SemanticIndexSnapshot>): void {
    this.clearIndexSnapshot();

    const isSettled = snapshot.ready
      && snapshot.phase === "idle"
      && snapshot.pending === 0
      && snapshot.failed === 0
      && !snapshot.lastError;
    this.indexStatusEl.hidden = isSettled;
    if (isSettled) return;

    let iconName = "loader";
    let label = "Preparing semantic index";
    let detail = "";
    let stateClass = "is-initializing";
    let showProgress = false;
    let showPendingAction = false;

    if (snapshot.failed > 0 || snapshot.phase === "error") {
      iconName = "circle-alert";
      label = snapshot.failed > 0
        ? `${snapshot.failed} ${snapshot.failed === 1 ? "note needs" : "notes need"} attention`
        : "Semantic index needs attention";
      detail = snapshot.lastError?.message
        ? readEmbeddingErrorMessage(snapshot.lastError.message, "Try again from Remaining embeddings.")
        : "Review the remaining files and retry.";
      stateClass = "is-error";
      showPendingAction = true;
    } else if (snapshot.phase === "paused") {
      iconName = "pause";
      label = "Indexing paused";
      detail = snapshot.pending > 0
        ? `${snapshot.pending} ${snapshot.pending === 1 ? "note" : "notes"} waiting`
        : "Resume from embeddings settings.";
      stateClass = "is-paused";
    } else if (snapshot.phase === "reconciling" || snapshot.pending > 0) {
      const total = Math.max(snapshot.total, snapshot.completed + snapshot.pending);
      const completed = Math.min(snapshot.completed, total);
      label = total > 0 ? `Indexing ${completed} of ${total}` : "Updating semantic index";
      detail = snapshot.currentPath?.split("/").pop() || (
        snapshot.pending > 0
          ? `${snapshot.pending} ${snapshot.pending === 1 ? "note" : "notes"} remaining`
          : ""
      );
      stateClass = "is-processing";
      showProgress = total > 0;
    }

    this.indexStatusEl.addClass(stateClass);
    const icon = this.indexStatusEl.createSpan({
      cls: "ss-embeddings-view__index-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(icon, iconName);

    const copy = this.indexStatusEl.createDiv({ cls: "ss-embeddings-view__index-copy" });
    copy.createDiv({ cls: "ss-embeddings-view__index-label", text: label });
    if (detail) {
      copy.createDiv({ cls: "ss-embeddings-view__index-detail", text: detail, attr: { title: detail } });
    }

    if (showProgress) {
      const total = Math.max(1, snapshot.total, snapshot.completed + snapshot.pending);
      const progress = copy.createEl("progress", {
        cls: "ss-embeddings-view__index-progress",
        attr: {
          max: String(total),
          value: String(Math.min(snapshot.completed, total)),
          "aria-label": label,
        },
      });
      progress.max = total;
      progress.value = Math.min(snapshot.completed, total);
    }

    if (showPendingAction) {
      const action = createUiAction(this.indexStatusEl, {
        label: "Review",
        size: "small",
      });
      action.dataset.indexAction = "pending";
    }
  }

  public render(model: SimilarNotesViewModel): void {
    this.currentModel = model;
    this.setRefreshing(false);
    this.resultsEl.empty();

    switch (model.state) {
      case "idle":
        this.sourceName = null;
        this.renderStatePane({
          kind: "idle",
          icon: "files",
          title: "Open a note or chat",
          description: "Related notes will appear here.",
        });
        break;
      case "disabled":
        this.sourceName = null;
        this.renderStatePane({
          kind: "disabled",
          icon: "power",
          title: "Embeddings are off",
          description: "Enable them to find related notes.",
        });
        this.addStateAction("Enable embeddings", () => this.actions.onOpenSettings(), true);
        break;
      case "empty-content":
        this.renderStatePane({
          kind: "empty",
          icon: "file-x",
          title: "Nothing to compare",
          description: "Add text to this note or chat.",
        });
        break;
      case "error":
        this.renderStatePane({
          kind: "error",
          icon: "circle-alert",
          title: "Couldn’t find similar notes",
          description: readEmbeddingErrorMessage(
            model.message,
            "Similar notes are unavailable. Try again.",
          ),
        });
        this.addStateAction("Try again", () => this.actions.onRefresh(), true);
        break;
      case "index-required":
        this.renderStatePane({
          kind: "index",
          icon: "database",
          title: "Build your vault index",
          description: "Create embeddings to find related notes.",
        });
        this.addStateAction("Start", () => this.actions.onStartProcessing(), true);
        this.addStateAction("Settings", () => this.actions.onOpenSettings(), false);
        break;
      case "processing":
        this.renderProcessing();
        break;
      case "results":
        this.sourceName = model.sourceName;
        this.renderResults(model.results, model.chatContext);
        break;
    }

    this.syncHeader();
  }

  public updateProgress(progress: ProcessingProgress): void {
    if (this.currentModel.state !== "processing") return;

    const total = Math.max(0, Number.isFinite(progress.total) ? progress.total : 0);
    const current = Math.max(0, Math.min(total, Number.isFinite(progress.current) ? progress.current : 0));
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
    const progressEl = this.resultsEl.querySelector<HTMLProgressElement>(".ss-embeddings-view__progress");
    const labelEl = this.resultsEl.querySelector<HTMLElement>(".ss-embeddings-view__progress-label");

    if (progressEl) {
      progressEl.max = 100;
      progressEl.value = percentage;
      progressEl.setAttribute("aria-valuetext", `${percentage}% complete`);
    }
    if (labelEl) {
      const fileName = progress.currentFile?.split("/").pop()?.trim();
      labelEl.setText(fileName ? `${percentage}% · ${fileName}` : `${percentage}%`);
      labelEl.setAttribute("title", progress.currentFile || `${percentage}% complete`);
    }
  }

  public syncContextIndicators(): void {
    if (this.currentModel.state !== "results" || !this.currentModel.chatContext) return;

    this.resultsEl.querySelectorAll<HTMLElement>(".ss-similar-note[data-note-path]").forEach((row) => {
      const path = row.dataset.notePath;
      if (!path) return;
      this.syncContextIndicator(row, path, this.actions.isInContext(path));
    });
  }

  public override onunload(): void {
    if (this.dragReleaseTimer !== null) {
      getSurfaceOwnerWindow(this.element).clearTimeout(this.dragReleaseTimer);
      this.dragReleaseTimer = null;
    }
    if (this.dragging) {
      this.dragging = false;
      this.actions.onDragStateChange(false);
    }
  }

  private syncHeader(): void {
    let count = "";
    let context = this.sourceName || "Related vault context";

    switch (this.currentModel.state) {
      case "disabled":
        context = "Semantic search is off";
        break;
      case "index-required":
        context = "Vault index required";
        break;
      case "processing":
        context = "Building vault index";
        break;
      case "error":
        context = this.sourceName || "Search failed";
        break;
      case "results":
        count = String(this.currentModel.results.length);
        context = this.currentModel.sourceName;
        break;
      case "idle":
        context = "Related vault context";
        break;
      default:
        break;
    }

    this.statusEl.setText(count);
    this.statusEl.toggleAttribute("hidden", count.length === 0);
    if (count) {
      this.statusEl.setAttribute(
        "aria-label",
        `${count} similar ${count === "1" ? "note" : "notes"}`,
      );
    } else {
      this.statusEl.removeAttribute("aria-label");
    }
    this.contextEl.setText(context);
    this.contextEl.setAttribute("title", context);
  }

  private renderStatePane(options: StatePaneOptions): HTMLElement {
    const state = createUiState(this.resultsEl, {
      kind: stateKind(options.kind),
      icon: options.icon,
      title: options.title,
      detail: options.description,
    });
    state.addClass("ss-embeddings-view__state");
    state.addClass(`ss-embeddings-view__state--${options.kind}`);
    return state;
  }

  private addStateAction(label: string, action: () => void | Promise<void>, primary: boolean): void {
    let actions = this.resultsEl.querySelector<HTMLElement>(".ss-embeddings-view__state-actions");
    if (!actions) {
      const state = this.resultsEl.querySelector<HTMLElement>(".ss-embeddings-view__state");
      if (!state) return;
      actions = state.createDiv({ cls: "ss-embeddings-view__state-actions" });
    }

    createUiAction(actions, {
      label,
      tone: primary ? "primary" : "default",
      size: "small",
      onSelect: () => void action(),
    });
  }

  private renderProcessing(): void {
    const state = this.renderStatePane({
      kind: "processing",
      icon: "database-zap",
      title: "Building vault index",
      description: "You can keep working while this finishes.",
    });
    const progressWrap = state.createDiv({ cls: "ss-embeddings-view__progress-wrap" });
    const label = progressWrap.createDiv({ cls: "ss-embeddings-view__progress-label", text: "Starting…" });
    label.setAttribute("aria-live", "polite");
    const progress = progressWrap.createEl("progress", {
      cls: "ss-embeddings-view__progress",
      attr: { max: "100", value: "0", "aria-label": "Vault indexing progress" },
    });
    progress.max = 100;
    progress.value = 0;
    this.addStateAction("Remaining files", () => this.actions.onOpenPendingFiles(), false);
  }

  private renderResults(results: readonly SearchResult[], chatContext: boolean): void {
    if (results.length === 0) {
      this.renderStatePane({
        kind: "no-results",
        icon: "search-x",
        title: "No close matches",
        description: "Try a note or chat with more detail.",
      });
      return;
    }

    const list = this.resultsEl.createEl("ul", {
      cls: "ss-embeddings-view__results-list",
      attr: { "aria-label": "Similar notes" },
    });
    for (const result of results) {
      this.renderResult(list, result, chatContext);
    }
  }

  private renderResult(container: HTMLElement, result: SearchResult, chatContext: boolean): void {
    const title = readTitle(result);
    const score = similarityPercent(result.score);
    const row = container.createEl("li", {
      cls: "ss-similar-note",
      attr: {
        "data-note-path": result.path,
      },
    });
    row.dataset.notePath = result.path;

    const content = row.createDiv({ cls: "ss-similar-note__content" });
    const heading = content.createDiv({ cls: "ss-similar-note__heading" });
    const link = heading.createEl("a", {
      cls: "ss-similar-note__title internal-link",
      text: title,
      href: result.path,
      attr: {
        "data-href": result.path,
        "aria-label": `Open ${title}, ${score}% similar`,
      },
    });

    const accessories = heading.createDiv({ cls: "ss-similar-note__accessories" });
    const scoreClass = score >= 75 ? "high" : score >= 50 ? "medium" : "low";
    accessories.createSpan({
      cls: `ss-similar-note__score ss-similar-note__score--${scoreClass}`,
      text: `${score}%`,
      attr: { title: `Similarity ${score}%`, "aria-label": `Similarity ${score}%` },
    });

    if (chatContext) {
      const contextAction = createIconButton(accessories, `Add ${title} to chat context`, "plus");
      contextAction.addClass("ss-similar-note__context-action");
      contextAction.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.actions.onAddToContext(result.path);
        this.syncContextIndicators();
      });
      row.setAttribute("draggable", "true");
      row.addClass("ss-similar-note--draggable");
      row.addEventListener("dragstart", (event) => this.startDrag(event, row, result));
      row.addEventListener("dragend", () => this.finishDrag(row));
      this.syncContextIndicator(row, result.path, this.actions.isInContext(result.path));
    }

    const sectionTitle = result.metadata?.sectionTitle?.trim();
    const excerpt = result.metadata?.excerpt?.trim();
    if (sectionTitle) {
      content.createDiv({ cls: "ss-similar-note__section", text: sectionTitle });
    }
    if (excerpt) {
      content.createDiv({ cls: "ss-similar-note__excerpt", text: excerpt });
    }

    const folder = readFolder(result.path);
    const lastModified = result.metadata?.lastModified;
    if (folder || lastModified) {
      const metadata = content.createDiv({ cls: "ss-similar-note__metadata" });
      if (folder) metadata.createSpan({ cls: "ss-similar-note__path", text: folder, attr: { title: folder } });
      if (lastModified) metadata.createSpan({ cls: "ss-similar-note__date", text: this.formatDate(lastModified) });
    }

    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.actions.onOpenFile(result.path);
    });
  }

  private startDrag(event: DragEvent, row: HTMLElement, result: SearchResult): void {
    if (!event.dataTransfer) return;

    this.dragging = true;
    this.actions.onDragStateChange(true);
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    if (this.dragReleaseTimer !== null) ownerWindow.clearTimeout(this.dragReleaseTimer);
    this.dragReleaseTimer = ownerWindow.setTimeout(() => {
      this.dragReleaseTimer = null;
      row.removeClass("is-dragging");
      if (this.dragging) {
        this.dragging = false;
        this.actions.onDragStateChange(false);
      }
    }, DRAG_RELEASE_TIMEOUT_MS);

    event.dataTransfer.setData("text/plain", result.path);
    event.dataTransfer.setData(
      "application/x-systemsculpt-similar-note",
      JSON.stringify({
        path: result.path,
        title: readTitle(result),
        score: result.score,
        source: "similar-notes",
      }),
    );
    event.dataTransfer.effectAllowed = "copy";
    row.addClass("is-dragging");
  }

  private finishDrag(row: HTMLElement): void {
    if (this.dragReleaseTimer !== null) {
      getSurfaceOwnerWindow(this.element).clearTimeout(this.dragReleaseTimer);
      this.dragReleaseTimer = null;
    }
    row.removeClass("is-dragging");
    if (this.dragging) {
      this.dragging = false;
      this.actions.onDragStateChange(false);
    }
  }

  private syncContextIndicator(row: HTMLElement, path: string, inContext: boolean): void {
    row.classList.toggle("is-in-context", inContext);
    const action = row.querySelector<HTMLButtonElement>(".ss-similar-note__context-action");
    if (!action) return;

    const title = readTitle(
      this.currentModel.state === "results"
        ? this.currentModel.results.find((result) => result.path === path) ?? ({ path, metadata: {} } as SearchResult)
        : ({ path, metadata: {} } as SearchResult),
    );
    updateUiAction(action, {
      disabled: inContext,
      label: inContext ? `${title} is in chat context` : `Add ${title} to chat context`,
      title: inContext ? "In chat context" : "Add to chat context",
      icon: inContext ? "check" : "plus",
    });
  }

  private formatDate(timestamp: number): string {
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }
}
