import { StudioRunObserver } from "../StudioRunObserver";

describe("Studio run observation", () => {
  it("keeps project runs separate and lets a late observer recover compact progress", () => {
    const observer = new StudioRunObserver(jest.fn());
    const first = jest.fn();
    const unsubscribe = observer.subscribe(first);
    observer.begin({ projectPath: "A.systemsculpt", runId: "run-a", nodeIds: ["image"], fromNodeId: null });
    observer.begin({ projectPath: "B.systemsculpt", runId: "run-b", nodeIds: ["text"], fromNodeId: "text" });
    observer.publish("A.systemsculpt", { type: "run.started", runId: "run-a", at: "now" });
    for (let percent = 0; percent < 100; percent++) {
      observer.publish("A.systemsculpt", { type: "node.progress", runId: "run-a", nodeId: "image", percent, at: "now" });
    }
    const active = observer.getActiveRun("A.systemsculpt")!;
    expect(active.events).toHaveLength(2);
    expect(active.events[1]).toMatchObject({ percent: 99 });
    expect(observer.getActiveRun("B.systemsculpt")).toMatchObject({ runId: "run-b", events: [] });
    (active.nodeIds as string[]).push("mutated");
    expect(observer.getActiveRun("A.systemsculpt")?.nodeIds).toEqual(["image"]);
    unsubscribe();
    first.mockClear();
    observer.publish("A.systemsculpt", { type: "run.completed", runId: "run-a", status: "success", at: "now" });
    expect(first).not.toHaveBeenCalled();
    expect(observer.getActiveRun("A.systemsculpt")).toBeNull();
    expect(observer.getActiveRun("B.systemsculpt")).not.toBeNull();
  });

  it("isolates a failing view and ignores events from an obsolete run", () => {
    const error = jest.fn();
    const observer = new StudioRunObserver(error);
    const healthy = jest.fn();
    observer.subscribe(() => { throw new Error("closed view"); });
    observer.subscribe(healthy);
    observer.begin({ projectPath: "A.systemsculpt", runId: "new", nodeIds: [], fromNodeId: null });
    observer.publish("A.systemsculpt", { type: "run.completed", runId: "old", status: "success", at: "now" });
    expect(healthy).not.toHaveBeenCalled();
    observer.publish("A.systemsculpt", { type: "run.started", runId: "new", at: "now" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
