import type { App, ViewState, WorkspaceLeaf } from "obsidian";
import type { StudioProjectV1 } from "../../studio/types";
import { SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "./viewTypes";
import type { StudioSourceReloadState } from "../../views/studio/canvas/StudioNodeSourceBody";

export type StudioEditingSnapshot = { base: StudioProjectV1; project: StudioProjectV1; sourceEditors?: StudioSourceReloadState };
type ReloadView = {
  getState(): Record<string, unknown>;
  captureReloadSnapshot?(): StudioEditingSnapshot | null;
  restoreReloadSnapshot?(snapshot: StudioEditingSnapshot): Promise<void>;
};
type ReloadEntry = { leaf: WorkspaceLeaf; state: ViewState; editing: StudioEditingSnapshot | null; active: boolean };
type ReloadState = { entries: ReloadEntry[]; ready: Promise<unknown>; restoring: boolean };
// The App outlives a plugin module reload. A module-local WeakMap would lose
// this handoff at the exact moment it is needed. Nothing is synced to a vault
// or persisted into another device's workspace layout.
const RELOAD = Symbol.for("systemsculpt.studio.reload.v1");
type ReloadApp = App & { [RELOAD]?: ReloadState };

export function captureStudioReloadState(app: App): void {
  const entries = app.workspace.getLeavesOfType(SYSTEMSCULPT_STUDIO_VIEW_TYPE).map(leaf => {
    const view = leaf.view as unknown as ReloadView;
    const editing = view.captureReloadSnapshot?.() || null;
    return {
      leaf, editing, active: app.workspace.getMostRecentLeaf() === leaf,
      state: { ...leaf.getViewState(), type: SYSTEMSCULPT_STUDIO_VIEW_TYPE, state: JSON.parse(JSON.stringify(view.getState())) },
    };
  });
  if (entries.length) (app as ReloadApp)[RELOAD] = { entries, ready: Promise.resolve(), restoring: false };
}

export function setStudioReloadBarrier(app: App, ready: Promise<unknown>): void {
  const state = (app as ReloadApp)[RELOAD];
  if (state) state.ready = ready.catch(() => undefined);
}

export async function restoreStudioReloadState(app: App): Promise<void> {
  const owner = app as ReloadApp;
  const pending = owner[RELOAD];
  if (!pending || pending.restoring) return;
  pending.restoring = true;
  await pending.ready;
  try {
    for (const entry of [...pending.entries]) {
      const leaves = new Set<WorkspaceLeaf>();
      app.workspace.iterateAllLeaves(leaf => { leaves.add(leaf); });
      let leaf = entry.leaf;
      // A user may open another file while the reload is underway. Preserve
      // that action instead of replacing their new content with an old tab.
      if (!leaves.has(leaf) || !["empty", SYSTEMSCULPT_STUDIO_VIEW_TYPE].includes(leaf.getViewState().type)) leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState(entry.state);
      const view = leaf.view as unknown as ReloadView;
      if (entry.editing) await view.restoreReloadSnapshot?.(entry.editing);
      pending.entries.splice(pending.entries.indexOf(entry), 1);
      const active = app.workspace.getMostRecentLeaf();
      if (entry.active && (!active || active === entry.leaf || active.getViewState().type === "empty")) app.workspace.setActiveLeaf(leaf, { focus: true });
    }
    if (owner[RELOAD] === pending) delete owner[RELOAD];
    app.workspace.requestSaveLayout();
  } finally { pending.restoring = false; }
}
