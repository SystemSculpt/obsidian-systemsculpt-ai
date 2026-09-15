import type { StudioProjectV1 } from "../../../studio/types";
import { isManagedOutputPlaceholderNode } from "../../../studio/StudioManagedOutputNodes";
import type { StudioRunPresentationState } from "../StudioRunPresentationState";
import type { StudioNodeActivity } from "./StudioActivity";
import { StudioActivityDomApplier, type StudioActivityDomTargets } from "./StudioActivityDomApplier";
import {
  EMPTY_ACTIVITY_SNAPSHOT,
  projectStudioActivity,
  type StudioActivityAgentRun,
  type StudioActivitySnapshot,
} from "./StudioActivityProjector";

export type StudioActivityRunSource = Readonly<{
  list: (projectId: string) => ReadonlyArray<StudioActivityAgentRun>;
  subscribe: (listener: (projectId: string) => void) => () => void;
}>;

export type StudioActivityControllerHost = Readonly<{
  getProject: () => StudioProjectV1 | null;
  presentation: Pick<StudioRunPresentationState, "getProgress" | "getNodeState">;
  /** Resolved lazily: the interaction engine is constructed after the view's fields. */
  targets: () => StudioActivityDomTargets;
}>;

/**
 * The view's one seam into run-state presentation. It projects the current
 * run, native Codex runs, and graph into a snapshot, hands cards their
 * first-paint activity, and patches the live canvas in place afterwards.
 */
export class StudioActivityController {
  private snapshot: StudioActivitySnapshot = EMPTY_ACTIVITY_SNAPSHOT;
  private readonly applier: StudioActivityDomApplier;
  private runs: StudioActivityRunSource | null = null;
  private detachRuns: (() => void) | null = null;

  constructor(private readonly host: StudioActivityControllerHost) {
    this.applier = new StudioActivityDomApplier(host.targets);
  }

  /** Follow native Codex run changes for the open project. */
  bind(runs: StudioActivityRunSource): void {
    this.detachRuns?.();
    this.runs = runs;
    this.detachRuns = runs.subscribe((projectId) => {
      if (this.host.getProject()?.projectId === projectId) this.refresh();
    });
  }

  dispose(): void {
    this.detachRuns?.();
    this.detachRuns = null;
    this.runs = null;
  }

  /** Forget transition memory, e.g. when another project opens. */
  reset(): void {
    this.snapshot = EMPTY_ACTIVITY_SNAPSHOT;
    this.applier.reset();
  }

  getNodeActivity(nodeId: string): StudioNodeActivity | undefined {
    return this.snapshot.nodes.get(nodeId);
  }

  /** Recompute the snapshot; call before a structural render so cards paint right. */
  project(): StudioActivitySnapshot {
    const project = this.host.getProject();
    if (!project) {
      this.snapshot = EMPTY_ACTIVITY_SNAPSHOT;
      return this.snapshot;
    }
    this.snapshot = projectStudioActivity({
      graph: project.graph,
      runStatus: this.host.presentation.getProgress().status,
      getNodeRunState: (nodeId) => this.host.presentation.getNodeState(nodeId),
      agentRuns: this.runs?.list(project.projectId) ?? [],
      isPlaceholder: (nodeId) => {
        const node = project.graph.nodes.find((candidate) => candidate.id === nodeId);
        return node ? isManagedOutputPlaceholderNode(node) : false;
      },
    });
    return this.snapshot;
  }

  /** Patch the last snapshot into the live DOM; call after a structural render. */
  apply(): void {
    this.applier.apply(this.snapshot);
  }

  /** Activity-only update: no DOM rebuild, animations keep their phase. */
  refresh(): void {
    this.project();
    this.apply();
  }
}
