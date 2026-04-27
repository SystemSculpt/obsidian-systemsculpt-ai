import type { StudioRunEvent } from "../../../../studio/types";
import { StudioLinkStore } from "../StudioLinkStore";
import { StudioLinkFlowBridge } from "../StudioLinkFlowBridge";

function seedStore(): StudioLinkStore {
  const store = new StudioLinkStore();
  store.setEdges([
    { id: "e1", source: { nodeId: "n1", portId: "out" }, target: { nodeId: "n2", portId: "in" } },
    { id: "e2", source: { nodeId: "n1", portId: "out2" }, target: { nodeId: "n3", portId: "in" } },
    { id: "e3", source: { nodeId: "other", portId: "out" }, target: { nodeId: "n2", portId: "in2" } },
  ]);
  return store;
}

const AT = "2026-04-18T00:00:00.000Z";
const RUN = "r1";

describe("StudioLinkFlowBridge", () => {
  it("node.started sets outgoing edges to flowing", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({ type: "node.started", runId: RUN, nodeId: "n1", at: AT });
    expect(store.getEdge("e1")?.status).toBe("flowing");
    expect(store.getEdge("e2")?.status).toBe("flowing");
    expect(store.getEdge("e3")?.status).toBe("idle");
  });

  it("node.output transitions flowing edges to completed and resets flare", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({ type: "node.started", runId: RUN, nodeId: "n1", at: AT });
    bridge.applyRunEvent({
      type: "node.output",
      runId: RUN,
      nodeId: "n1",
      outputRef: "ref",
      at: AT,
    } as StudioRunEvent);
    const e1 = store.getEdge("e1");
    expect(e1?.status).toBe("completed");
    expect(e1?.flareT).toBe(0);
  });

  it("node.cache_hit sets outgoing edges to completed", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({
      type: "node.cache_hit",
      runId: RUN,
      nodeId: "n1",
      cacheUpdatedAt: AT,
      at: AT,
    });
    expect(store.getEdge("e1")?.status).toBe("completed");
  });

  it("node.failed sets outgoing edges to failed", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({
      type: "node.failed",
      runId: RUN,
      nodeId: "n1",
      error: "boom",
      at: AT,
    });
    expect(store.getEdge("e1")?.status).toBe("failed");
    expect(store.getEdge("e2")?.status).toBe("failed");
  });

  it("run.failed defensively drops flowing edges to failed", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({ type: "node.started", runId: RUN, nodeId: "n1", at: AT });
    bridge.applyRunEvent({ type: "run.failed", runId: RUN, error: "boom", at: AT });
    expect(store.getEdge("e1")?.status).toBe("failed");
    expect(store.getEdge("e2")?.status).toBe("failed");
  });

  it("run.completed success drops flowing edges to completed", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({ type: "node.started", runId: RUN, nodeId: "n1", at: AT });
    bridge.applyRunEvent({ type: "run.completed", runId: RUN, status: "success", at: AT });
    expect(store.getEdge("e1")?.status).toBe("completed");
  });

  it("events for unknown nodes are no-ops", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({ type: "node.started", runId: RUN, nodeId: "ghost", at: AT });
    expect(store.getEdge("e1")?.status).toBe("idle");
    expect(store.getEdge("e2")?.status).toBe("idle");
  });

  it("resetAll drops all edges to idle", () => {
    const store = seedStore();
    const bridge = new StudioLinkFlowBridge(store);
    bridge.applyRunEvent({ type: "node.started", runId: RUN, nodeId: "n1", at: AT });
    bridge.resetAll();
    expect(store.getEdge("e1")?.status).toBe("idle");
    expect(store.getEdge("e2")?.status).toBe("idle");
  });
});
