import type { StudioRunEvent } from "./types";

export type StudioObservedRun = Readonly<{
  projectPath: string;
  runId: string;
  nodeIds: readonly string[];
  fromNodeId: string | null;
  events: readonly StudioRunEvent[];
}>;

export type StudioRunUpdate = Omit<StudioObservedRun, "events"> & { event: StudioRunEvent };

/** Local presentation of the existing runtime, shared by UI and programmatic callers. */
export class StudioRunObserver {
  private readonly active = new Map<string, {
    context: Omit<StudioObservedRun, "events">;
    events: Map<string, StudioRunEvent>;
  }>();
  private readonly listeners = new Set<(update: StudioRunUpdate) => void>();

  constructor(private readonly onListenerError: (error: unknown) => void) {}

  begin(context: Omit<StudioObservedRun, "events">): void {
    this.active.set(context.projectPath, { context, events: new Map() });
  }

  subscribe(listener: (update: StudioRunUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getActiveRun(projectPath: string): StudioObservedRun | null {
    const run = this.active.get(projectPath);
    return run ? JSON.parse(JSON.stringify({ ...run.context, events: [...run.events.values()] })) : null;
  }

  publish(projectPath: string, event: StudioRunEvent): void {
    const run = this.active.get(projectPath);
    if (!run || run.context.runId !== event.runId) return;
    // Keep only presentation state, bounded by node count, rather than a second log.
    const nodeId = "nodeId" in event ? event.nodeId : "";
    run.events.set(`${nodeId}:${event.type}`, event);
    if (event.type === "run.completed") this.active.delete(projectPath);
    for (const listener of this.listeners) {
      try { listener({ ...run.context, event }); }
      catch (error) { this.onListenerError(error); }
    }
  }
}
