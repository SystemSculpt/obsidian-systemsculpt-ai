/**
 * The part of Obsidian's WorkspaceLeaf (1.14) that opening a view depends on.
 * setViewState creates a view only when the type changes, opens it, then hands
 * it the state, and ignores a nested call while the leaf is busy; open closes
 * the previous view before opening the next. The host mock's leaf only records
 * state, so bundle tests that open views through the registered factories use
 * this instead. The leaf is attached to the document, so views see it shown.
 */
type HostView = {
  containerEl: HTMLElement;
  getViewType(): string;
  getState(): Record<string, unknown>;
  setState(state: unknown, result: { history: boolean }): Promise<void>;
  onOpen(): Promise<void>;
  onClose(): Promise<void>;
  load?(): void;
  unload?(): void;
};

export type ObsidianLeaf = {
  app: unknown;
  view: HostView | null;
  containerEl: HTMLElement;
  open(view: HostView | null): Promise<HostView | null>;
  setViewState(viewState: { type: string; state?: Record<string, unknown> }): Promise<void>;
  getViewState(): { type: string; state: Record<string, unknown> };
  /** Closes the view and removes the leaf, as Obsidian's detach does. */
  detach(): Promise<void>;
};

export function createObsidianLeaf(
  host: { WorkspaceLeaf: new (app: unknown) => object },
  app: unknown,
  /** Obsidian's view registry: the creator a plugin registered for a type. */
  creatorFor: (type: string) => ((leaf: ObsidianLeaf) => HostView) | undefined,
  prepare?: (view: HostView) => void,
): ObsidianLeaf {
  const leaf = new host.WorkspaceLeaf(app) as ObsidianLeaf;
  leaf.view = null;
  leaf.containerEl = document.body.appendChild(document.createElement("div"));
  leaf.containerEl.className = "workspace-leaf";
  let working = false;
  leaf.open = async (view) => {
    const previous = leaf.view;
    if (view === previous) return view;
    if (previous) {
      previous.containerEl.remove();
      previous.unload?.();
      await previous.onClose();
    }
    leaf.view = view;
    if (!view) return null;
    leaf.containerEl.replaceChildren(view.containerEl);
    view.load?.();
    prepare?.(view);
    await view.onOpen();
    return view;
  };
  leaf.setViewState = async (viewState) => {
    if (working) return;
    working = true;
    try {
      let view = leaf.view;
      if (!view || view.getViewType() !== viewState.type) {
        const create = creatorFor(viewState.type);
        if (!create) throw new Error(`No view registered for ${viewState.type}`);
        view = create(leaf);
        await leaf.open(view);
      }
      await view.setState(viewState.state ?? {}, { history: false });
    } finally {
      working = false;
    }
  };
  leaf.detach = async () => {
    await leaf.open(null);
    leaf.containerEl.remove();
  };
  leaf.getViewState = () => ({
    type: leaf.view?.getViewType() ?? "empty",
    state: leaf.view?.getState() ?? {},
  });
  return leaf;
}
