import { StudioRunObservationController } from "../StudioRunObservationController";
import { StudioRunObserver } from "../../../studio/StudioRunObserver";
import type { StudioRunEvent } from "../../../studio/types";

function fixture() {
  const observer = new StudioRunObserver(jest.fn());
  const host = { getProjectPath: () => "A.systemsculpt", beginRun: jest.fn(), setBusy: jest.fn(), clearError: jest.fn(), onEvent: jest.fn(), restoreEvent: jest.fn() };
  const controller = new StudioRunObservationController(host);
  controller.bind({ subscribeRunEvents: listener => observer.subscribe(listener), getActiveRun: path => observer.getActiveRun(path), getLatestRunEvents: async () => [] });
  observer.begin({ projectPath: "A.systemsculpt", runId: "run-a", nodeIds: ["image"], fromNodeId: "image" });
  return { observer, host, controller };
}

describe("Studio programmatic run presentation", () => {
  it("shows agent-started runs and unlocks the canvas after publication", () => {
    const { observer, host } = fixture();
    const started = { type: "run.started" as const, runId: "run-a", at: "now" };
    observer.publish("A.systemsculpt", started);
    expect(host.beginRun).toHaveBeenCalledWith(["image"], "image");
    expect(host.setBusy).toHaveBeenLastCalledWith(true);
    expect(host.clearError).toHaveBeenCalled();
    expect(host.onEvent).toHaveBeenCalledWith(started);
    const completed = { type: "run.completed" as const, runId: "run-a", status: "success" as const, at: "now" };
    observer.publish("A.systemsculpt", completed);
    expect(host.setBusy).toHaveBeenLastCalledWith(false);
    expect(host.onEvent).toHaveBeenCalledWith(completed);
  });

  it("restores an active run after opening the project and detaches on close", async () => {
    const { observer, host, controller } = fixture();
    observer.publish("A.systemsculpt", { type: "node.started", runId: "run-a", nodeId: "image", at: "now" });
    host.onEvent.mockClear();
    await controller.restore("A.systemsculpt", ["image"]);
    expect(host.beginRun).toHaveBeenCalledWith(["image"], "image");
    expect(host.restoreEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "node.started" }));
    controller.dispose();
    host.onEvent.mockClear();
    observer.publish("A.systemsculpt", { type: "run.completed", runId: "run-a", status: "failed", at: "now" });
    expect(host.onEvent).not.toHaveBeenCalled();
  });

  it("does not apply another project's run to the visible canvas", async () => {
    const { observer, host, controller } = fixture();
    observer.begin({ projectPath: "B.systemsculpt", runId: "run-b", nodeIds: [], fromNodeId: null });
    observer.publish("B.systemsculpt", { type: "run.started", runId: "run-b", at: "now" });
    await controller.restore("B.systemsculpt", []);
    expect(host.onEvent).not.toHaveBeenCalled();
    expect(host.beginRun).not.toHaveBeenCalled();
  });
  it("restores saved image outputs without replaying view mutations or another generation", async () => {
    const { host, controller } = fixture();
    const output = { type: "node.output" as const, runId: "saved", nodeId: "image", at: "now", outputRef: "saved:image", outputs: { images: [{ path: "saved.png" }] } };
    controller.bind({
      subscribeRunEvents: () => () => {},
      getActiveRun: () => null,
      getLatestRunEvents: async () => [output, { ...output, nodeId: "deleted-node" }, { type: "run.completed", runId: "saved", status: "success", at: "now" }],
    });
    await controller.restore("A.systemsculpt", ["image"]);
    expect(host.beginRun).toHaveBeenCalledWith(["image"], null);
    expect(host.setBusy).toHaveBeenLastCalledWith(false);
    expect(host.restoreEvent).toHaveBeenCalledWith(output);
    expect(host.restoreEvent).toHaveBeenCalledTimes(2);
    expect(host.onEvent).not.toHaveBeenCalled();
  });

  it("keeps a newer completed run when an older history read finishes late", async () => {
    const { observer, host, controller } = fixture();
    observer.publish("A.systemsculpt", { type: "run.completed", runId: "run-a", status: "success", at: "now" });
    let resolveHistory!: (events: StudioRunEvent[]) => void;
    controller.bind({
      subscribeRunEvents: listener => observer.subscribe(listener),
      getActiveRun: path => observer.getActiveRun(path),
      getLatestRunEvents: () => new Promise(resolve => { resolveHistory = resolve; }),
    });
    const restore = controller.restore("A.systemsculpt", ["image"]);
    observer.begin({ projectPath: "A.systemsculpt", runId: "newer", nodeIds: ["image"], fromNodeId: "image" });
    observer.publish("A.systemsculpt", { type: "run.started", runId: "newer", at: "now" });
    observer.publish("A.systemsculpt", { type: "run.completed", runId: "newer", status: "success", at: "now" });
    host.beginRun.mockClear();
    resolveHistory([{ type: "run.completed", runId: "older", status: "failed", at: "before" }]);
    await restore;
    expect(host.restoreEvent).not.toHaveBeenCalled();
    expect(host.beginRun).not.toHaveBeenCalled();
    expect(host.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "newer" }));
  });

  it("invalidates a pending restore when rebinding the same service", async () => {
    const { host, controller } = fixture();
    let resolveHistory!: (events: StudioRunEvent[]) => void;
    const source = {
      subscribeRunEvents: () => () => {},
      getActiveRun: () => null,
      getLatestRunEvents: () => new Promise<StudioRunEvent[]>(resolve => { resolveHistory = resolve; }),
    };
    controller.bind(source);
    const restore = controller.restore("A.systemsculpt", ["image"]);
    controller.bind(source);
    resolveHistory([{ type: "run.completed", runId: "older", status: "failed", at: "before" }]);
    await restore;
    expect(host.restoreEvent).not.toHaveBeenCalled();
  });

});
