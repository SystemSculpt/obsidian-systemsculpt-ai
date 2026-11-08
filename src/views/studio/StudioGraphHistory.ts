import type { StudioProjectV1 } from "../../studio/types";
import { captureStudioProjectSnapshot, cloneStudioProjectSnapshot } from "../../studio/StudioProjectSnapshots";
import { reconcileStudioProject } from "../../studio/StudioProjectReconciliation";

type RestoreSnapshot = (candidate: StudioGraphHistorySnapshot) => StudioGraphHistorySnapshot | null;
export type StudioGraphHistorySnapshot = { project: StudioProjectV1; selectedNodeIds: string[] };
type Edit = { before: StudioGraphHistorySnapshot; after: StudioGraphHistorySnapshot };

function snapshot(project: StudioProjectV1, selectedNodeIds: string[], previous?: StudioProjectV1): StudioGraphHistorySnapshot {
  return { project: captureStudioProjectSnapshot(project, previous), selectedNodeIds: [...new Set(selectedNodeIds.map(id => String(id || "").trim()).filter(Boolean))] };
}
function equal(left: StudioGraphHistorySnapshot, right: StudioGraphHistorySnapshot): boolean {
  return captureStudioProjectSnapshot(right.project, left.project) === left.project;
}
function detached(value: StudioGraphHistorySnapshot): StudioGraphHistorySnapshot {
  return { project: cloneStudioProjectSnapshot(value.project), selectedNodeIds: [...value.selectedNodeIds] };
}

function rebase(base: StudioGraphHistorySnapshot, target: StudioGraphHistorySnapshot, canvas: StudioGraphHistorySnapshot): StudioProjectV1 {
  if (equal(base, canvas)) return target.project;
  const project = reconcileStudioProject(base.project, target.project, canvas.project, { preferLocalConflicts: true }).project;
  // The portable file dialect derives edge IDs from endpoints. A history
  // transition must retain in-memory IDs used by the active canvas selection.
  const key = (edge: StudioProjectV1["graph"]["edges"][number]) => JSON.stringify([edge.fromNodeId, edge.fromPortId, edge.toNodeId, edge.toPortId]);
  const ids = new Map([...target.project.graph.edges, ...canvas.project.graph.edges].map(edge => [key(edge), edge.id]));
  for (const edge of project.graph.edges) edge.id = ids.get(key(edge)) ?? edge.id;
  return project;
}

/** Per-view local edit transactions, rebased onto the current shared canvas. */
export class StudioGraphHistory {
  private applying = false;
  private current: StudioGraphHistorySnapshot | null = null;
  private undoEdits: Edit[] = [];
  private redoEdits: Edit[] = [];
  private latestEdit: Edit | null = null;
  private latestEditGroup: string | symbol | null = null;
  private redoBeforeLatestEdit: Edit[] = [];

  constructor(private readonly capacity = 120) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("History capacity must be a positive safe integer.");
  }

  reset(project: StudioProjectV1 | null, selectedNodeIds: string[] = []): void {
    this.assertNotApplying();
    this.undoEdits = [];
    this.redoEdits = [];
    this.clearLatestEdit();
    this.current = project ? snapshot(project, selectedNodeIds) : null;
  }

  /** Synchronize an externally adopted project without recording it as a local edit. */
  synchronize(project: StudioProjectV1, selectedNodeIds: string[]): void {
    this.assertNotApplying();
    this.current = snapshot(project, selectedNodeIds, this.current?.project);
  }

  /** Called only for an actual local mutation; unrelated peer edits are not history. */
  recordEdit(before: StudioGraphHistorySnapshot, after: StudioGraphHistorySnapshot, group?: string | symbol): void {
    this.assertNotApplying();
    const previous = snapshot(before.project, before.selectedNodeIds, this.current?.project);
    const next = snapshot(after.project, after.selectedNodeIds, previous.project);
    if (previous.project === next.project) return;
    const grouped = group && this.latestEditGroup === group && this.latestEdit === this.undoEdits[this.undoEdits.length - 1] ? this.latestEdit : null;
    // Rebase only when another writer intervened. Ordinary continued input
    // shares the first before snapshot and copies only changed JSON branches.
    const prior = grouped
      ? snapshot(rebase(grouped.after, grouped.before, previous), grouped.before.selectedNodeIds, grouped.before.project)
      : previous;
    const edit = { before: prior, after: next };
    if (grouped) this.undoEdits.pop();
    else this.redoBeforeLatestEdit = this.redoEdits;
    this.push(this.undoEdits, edit);
    this.latestEdit = edit;
    this.latestEditGroup = group ?? null;
    this.redoEdits = [];
    this.current = next;
  }

  finishGroup(group?: string | symbol): void {
    this.assertNotApplying();
    if (group === undefined || this.latestEditGroup === group) this.latestEditGroup = null;
  }

  /** Finish a deferred local edit, such as an active text editing session. */
  checkpoint(project: StudioProjectV1, selectedNodeIds: string[]): void {
    this.assertNotApplying();
    if (!this.current) { this.synchronize(project, selectedNodeIds); return; }
    this.recordEdit(this.current, { project, selectedNodeIds });
  }

  /** Keep the local canvas recoverable after accepting a competing file edit. */
  preserve(project: StudioProjectV1, selectedNodeIds: string[]): void {
    this.assertNotApplying();
    if (this.current) this.recordEdit({ project, selectedNodeIds }, this.current);
  }

  undo(restore: RestoreSnapshot = candidate => candidate, canvas?: StudioGraphHistorySnapshot): StudioGraphHistorySnapshot | null {
    return this.navigate("undo", restore, canvas);
  }

  redo(restore: RestoreSnapshot = candidate => candidate, canvas?: StudioGraphHistorySnapshot): StudioGraphHistorySnapshot | null {
    return this.navigate("redo", restore, canvas);
  }

  /** Apply empty-node cleanup without a nested checkpoint, canceling a net-zero creation. */
  completeRemoval(remove: () => StudioGraphHistorySnapshot | null, canvas?: StudioGraphHistorySnapshot, group?: string): boolean {
    const before = canvas ? snapshot(canvas.project, canvas.selectedNodeIds, this.current?.project) : this.current;
    const removed = this.apply(remove);
    if (!removed) return false;
    const latest = this.undoEdits[this.undoEdits.length - 1];
    if (latest && latest === this.latestEdit && this.current && equal(this.current, latest.after) && equal(removed, latest.before)) {
      this.undoEdits.pop();
      this.redoEdits = this.redoBeforeLatestEdit;
      this.current = snapshot(removed.project, removed.selectedNodeIds);
      this.clearLatestEdit();
    } else if (before) this.recordEdit(before, removed, group);
    else this.synchronize(removed.project, removed.selectedNodeIds);
    return true;
  }

  private navigate(direction: "undo" | "redo", restore: RestoreSnapshot, canvas?: StudioGraphHistorySnapshot): StudioGraphHistorySnapshot | null {
    this.assertNotApplying();
    const from = direction === "undo" ? this.undoEdits : this.redoEdits;
    const to = direction === "undo" ? this.redoEdits : this.undoEdits;
    const edit = from[from.length - 1];
    const liveCurrent = canvas ?? this.current;
    if (!edit || !liveCurrent) return null;
    // Restoring now patches the shared project identity in place so mounted
    // cards keep stable entity handles. Freeze the inverse before restore;
    // otherwise that in-place patch also mutates the redo snapshot.
    const current = snapshot(liveCurrent.project, liveCurrent.selectedNodeIds, this.current?.project);
    const target = direction === "undo" ? edit.before : edit.after;
    const base = direction === "undo" ? edit.after : edit.before;
    const candidate = rebase(base, target, current);
    const restored = this.apply(() => restore(detached({ project: candidate, selectedNodeIds: target.selectedNodeIds })));
    if (!restored) return null;
    const accepted = snapshot(restored.project, restored.selectedNodeIds, target.project);
    // Record the actual applied transition for its inverse, including any
    // normalization by the host, while retaining independent peer changes.
    this.push(to, direction === "undo"
      ? { before: accepted, after: current }
      : { before: current, after: accepted });
    from.pop();
    this.current = accepted;
    this.clearLatestEdit();
    return detached(accepted);
  }

  private clearLatestEdit(): void { this.latestEdit = null; this.latestEditGroup = null; this.redoBeforeLatestEdit = []; }
  private apply<T>(operation: () => T): T {
    this.assertNotApplying();
    this.applying = true;
    try { return operation(); } finally { this.applying = false; }
  }
  private assertNotApplying(): void {
    if (this.applying) throw new Error("History cannot change inside a restore or removal operation.");
  }
  private push(stack: Edit[], edit: Edit): void {
    stack.push(edit);
    while (stack.length > this.capacity) stack.shift();
  }
}
