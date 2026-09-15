import type { StudioService } from "../../studio/StudioService";
import type { StudioRunUpdate } from "../../studio/StudioRunObserver";
import type { StudioRunEvent } from "../../studio/types";

type RunSource = Pick<StudioService, "subscribeRunEvents" | "getActiveRun" | "getLatestRunEvents">;
type Host = {
  getProjectPath: () => string | null;
  beginRun: (nodeIds: string[], fromNodeId: string | null) => void;
  setBusy: (busy: boolean) => void;
  clearError: () => void;
  onEvent: (event: StudioRunEvent) => void;
  restoreEvent: (event: StudioRunEvent) => void;
};

export class StudioRunObservationController {
  private source: RunSource | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: Host) {}

  bind(source: RunSource): void {
    this.dispose();
    this.source = source;
    this.unsubscribe = source.subscribeRunEvents((update) => this.apply(update));
  }

  async restore(projectPath: string, nodeIds: string[]): Promise<void> {
    const source = this.source;
    if (!source || projectPath !== this.host.getProjectPath()) return;
    let active = source.getActiveRun(projectPath);
    const savedEvents = active ? [] : await source.getLatestRunEvents(projectPath);
    if (this.source !== source || projectPath !== this.host.getProjectPath()) return;
    active = source.getActiveRun(projectPath);
    const allowed = new Set(nodeIds);
    const events = (active?.events || savedEvents).filter((event) => !("nodeId" in event) || allowed.has(event.nodeId));
    if (!events.length) return;
    const scope = active?.nodeIds || [...new Set(events.flatMap((event) => "nodeId" in event ? [event.nodeId] : []))];
    this.host.beginRun([...scope], active?.fromNodeId || null);
    this.host.setBusy(active != null);
    // Restore presentation without replaying graph mutations or provider calls.
    for (const event of events) this.host.restoreEvent(event);
  }

  private apply(update: StudioRunUpdate): void {
    if (update.projectPath !== this.host.getProjectPath()) return;
    if (update.event.type === "run.started") {
      this.host.beginRun([...update.nodeIds], update.fromNodeId);
      this.host.setBusy(true);
      this.host.clearError();
    }
    if (update.event.type === "run.completed") this.host.setBusy(false);
    this.host.onEvent(update.event);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.source = null;
  }
}
