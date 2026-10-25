/** @jest-environment jsdom */
import { App, ItemView, type View, WorkspaceLeaf } from "obsidian";
import { SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "../../../core/plugin/viewTypes";
import { PendingStudioView, type StudioViewCreator } from "../PendingStudioView";

const PROJECT = "Studio/Launch plan.systemsculpt";
const STATE = { file: PROJECT, graphViewByProject: { [PROJECT]: { zoom: 0.75, scrollLeft: 200, scrollTop: 150 } } };

class FakeStudioView extends ItemView {
  readonly states: unknown[] = [];
  readonly events: string[] = [];
  getViewType(): string { return SYSTEMSCULPT_STUDIO_VIEW_TYPE; }
  getDisplayText(): string { return "Studio"; }
  async onOpen(): Promise<void> { this.events.push("open"); }
  async setState(state: unknown): Promise<void> { this.events.push("state"); this.states.push(state); }
}

/** Obsidian's leaf.open: close the shown view, then open the next one. The mock leaf starts with no view. */
class FakeLeaf extends WorkspaceLeaf {
  async open(view: View): Promise<View> {
    const previous = this.view;
    if (previous) await previous["onClose"]();
    this.view = view;
    await view["onOpen"]();
    return view;
  }
}

function createLeaf(): FakeLeaf {
  const leaf = new FakeLeaf(new App());
  jest.spyOn(leaf, "open");
  return leaf;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const host = ItemView.prototype as unknown as { setState?: () => Promise<void> };
const originalSetState = host.setState;
beforeAll(() => { host.setState = async () => {}; });
afterAll(() => { host.setState = originalSetState; });

describe("PendingStudioView", () => {
  it("opens the real Studio view in its own leaf with the state Obsidian handed it", async () => {
    const leaf = createLeaf();
    let studio: FakeStudioView | null = null;
    const create: StudioViewCreator = (target) => (studio = new FakeStudioView(target));
    const pending = new PendingStudioView(leaf, async () => create);

    await leaf.open(pending);
    await pending.setState(STATE, { history: false });

    expect(leaf.view).toBe(studio);
    expect(studio!.leaf).toBe(leaf);
    expect(studio!.events).toEqual(["open", "state"]);
    expect(studio!.states).toEqual([STATE]);
    expect(pending.contentEl.childElementCount).toBe(0);
  });

  it("keeps the tab's project and title for layout saves while Studio loads", async () => {
    const leaf = createLeaf();
    const load = deferred<StudioViewCreator>();
    const pending = new PendingStudioView(leaf, () => load.promise);
    const opening = leaf.open(pending);
    const handing = pending.setState(STATE, { history: false });

    const root = pending.contentEl.querySelector<HTMLElement>(".ss-studio-view");
    expect(root?.getAttribute("data-ss-surface")).toBe("view");
    expect(pending.getViewType()).toBe(SYSTEMSCULPT_STUDIO_VIEW_TYPE);
    expect(pending.getState()).toEqual(STATE);
    expect(pending.getDisplayText()).toBe("Launch plan.systemsculpt");
    load.resolve((target) => new FakeStudioView(target));
    await Promise.all([opening, handing]);
    expect(leaf.view).toBeInstanceOf(FakeStudioView);
  });

  it("shows why Studio could not load and keeps the tab's state", async () => {
    const leaf = createLeaf();
    const pending = new PendingStudioView(leaf, async () => { throw new Error("module evaluation failed"); });

    await leaf.open(pending);
    await pending.setState(STATE, { history: false });

    expect(leaf.view).toBe(pending);
    expect(pending.getState()).toEqual(STATE);
    expect(pending.contentEl.querySelector(".ss-studio-error")?.textContent)
      .toBe("Studio could not load: module evaluation failed");
  });

  it("leaves a leaf alone once it has moved on during the load", async () => {
    const leaf = createLeaf();
    const load = deferred<StudioViewCreator>();
    const create = jest.fn((target: WorkspaceLeaf) => new FakeStudioView(target));
    const pending = new PendingStudioView(leaf, () => load.promise);
    void leaf.open(pending);
    const handing = pending.setState(STATE, { history: false });
    const other = new FakeStudioView(leaf);
    await leaf.open(other);

    load.resolve(create);
    await handing;

    expect(leaf.view).toBe(other);
    expect(create).not.toHaveBeenCalled();
    expect(leaf.open).toHaveBeenCalledTimes(2);
  });

  it("forwards a later state to the Studio view it opened", async () => {
    const leaf = createLeaf();
    let studio: FakeStudioView | null = null;
    const pending = new PendingStudioView(leaf, async () => (target) => (studio = new FakeStudioView(target)));
    await leaf.open(pending);
    await pending.setState({ file: "Studio/A.systemsculpt" }, { history: false });

    await pending.setState({ file: "Studio/B.systemsculpt" }, { history: false });

    expect(leaf.open).toHaveBeenCalledTimes(2);
    expect(studio!.states).toEqual([{ file: "Studio/A.systemsculpt" }, { file: "Studio/B.systemsculpt" }]);
  });
});
