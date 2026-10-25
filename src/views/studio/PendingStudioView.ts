import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { applyPluginSurface } from "../../core/ui/surface";
import { resolveStudioViewTitle } from "./studio-view-title";

export type StudioViewCreator = (leaf: WorkspaceLeaf) => ItemView;

/**
 * Holds a Studio tab while Studio's code loads. Obsidian creates views
 * synchronously, and the Studio view is evaluated only when something first
 * opens it, so a tab Obsidian opens by itself (a restored layout, a
 * .systemsculpt file) starts here. Obsidian opens this view and then hands it
 * the tab's state; this view then opens the real Studio view in the same leaf
 * with that state, the order setViewState itself uses.
 */
export class PendingStudioView extends ItemView {
  private state: Record<string, unknown> = {};
  private studio: ItemView | null = null;
  private closed = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly loadStudioView: () => Promise<StudioViewCreator>
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SYSTEMSCULPT_STUDIO_VIEW_TYPE;
  }

  getDisplayText(): string {
    return resolveStudioViewTitle(typeof this.state.file === "string" ? this.state.file : null);
  }

  getIcon(): string {
    return "bot";
  }

  /** A layout save during the load keeps the tab's project and viewport. */
  getState(): Record<string, unknown> {
    return { ...this.state };
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    applyPluginSurface(this.contentEl.createDiv({ cls: "ss-studio-view" }), "view");
    // Obsidian calls setState as soon as this resolves; load first so the
    // swap happens in that call.
    await this.loadStudioView().catch(() => undefined);
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.state = state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
    await super.setState(state, result);
    if (this.studio) {
      if (this.leaf.view === this.studio) await this.studio.setState(this.state, result);
      return;
    }
    let create: StudioViewCreator;
    try {
      create = await this.loadStudioView();
    } catch (error) {
      this.showLoadFailure(error);
      return;
    }
    if (this.closed || this.leaf.view !== this) return;
    this.studio = create(this.leaf);
    await this.leaf.open(this.studio);
    await this.studio.setState(this.state, result);
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.contentEl.empty();
  }

  private showLoadFailure(error: unknown): void {
    if (this.closed) return;
    const detail = error instanceof Error ? error.message : String(error);
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "ss-studio-view" });
    applyPluginSurface(root, "view");
    root.createDiv({ cls: "ss-studio-error", text: `Studio could not load: ${detail}` });
  }
}
