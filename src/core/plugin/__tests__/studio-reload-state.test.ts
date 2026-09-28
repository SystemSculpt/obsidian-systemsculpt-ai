import type { App, ViewState, WorkspaceLeaf } from "obsidian";
import { captureStudioReloadState, restoreStudioReloadState, setStudioReloadBarrier } from "../StudioReloadState";
import { SYSTEMSCULPT_STUDIO_VIEW_TYPE as TYPE } from "../viewTypes";

function fixture() {
  const restored = jest.fn(async () => undefined);
  const editing = { base: { name: "before" }, project: { name: "pending edit" } };
  const states: ViewState[] = [0, 1].map(i => ({ type: TYPE, state: { file: `Studio/${i}.systemsculpt`, graphViewByProject: { [`Studio/${i}.systemsculpt`]: { zoom: 0.75, scrollLeft: 200, scrollTop: 150 } } } }));
  const leaves = states.map((state, i) => ({
    view: { getState: () => state.state, captureReloadSnapshot: () => editing, restoreReloadSnapshot: restored },
    getViewState: () => states[i],
    setViewState: jest.fn(async (next: ViewState) => { states[i] = next; }),
  })) as unknown as WorkspaceLeaf[];
  const app = { workspace: {
    getMostRecentLeaf: () => leaves[1],
    getLeavesOfType: () => leaves,
    iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => { leaves.forEach(callback); },
    getLeaf: jest.fn(), setActiveLeaf: jest.fn(), requestSaveLayout: jest.fn(),
  } } as unknown as App;
  return { app, leaves, states, restored, editing };
}

describe("Studio hot reload", () => {
  it("waits for teardown and restores both original leaves with their project and viewport", async () => {
    const { app, leaves, states, restored, editing } = fixture();
    const saved = JSON.parse(JSON.stringify(states));
    captureStudioReloadState(app);
    let finish!: () => void;
    setStudioReloadBarrier(app, new Promise<void>(resolve => { finish = resolve; }));
    states[0] = { type: "empty" }; states[1] = { type: "empty" };
    const restoration = restoreStudioReloadState(app);
    await Promise.resolve();
    expect(leaves[0].setViewState).not.toHaveBeenCalled();
    finish();
    await restoration;
    expect(states).toEqual(saved);
    expect(restored).toHaveBeenCalledTimes(2);
    expect(restored).toHaveBeenCalledWith(editing);
    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(leaves[1], { focus: true });
    await restoreStudioReloadState(app);
    expect(restored).toHaveBeenCalledTimes(2);
  });
});
