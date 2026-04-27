import { StudioLinkStore } from "../StudioLinkStore";

describe("StudioLinkStore", () => {
  it("setEdges emits to subscribers only when the identity set changes", () => {
    const store = new StudioLinkStore();
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls += 1;
    });
    store.setEdges([
      { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" } },
    ]);
    expect(calls).toBe(1);
    store.setEdges([
      { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" } },
    ]);
    expect(calls).toBe(1);
    store.setEdges([]);
    expect(calls).toBe(2);
    unsub();
  });

  it("setEdgeStatus resets flare when transitioning to flowing", () => {
    const store = new StudioLinkStore();
    store.setEdges([
      { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" } },
    ]);
    store.setEdgeStatus("e1", "completed", { flareT: 1 });
    expect(store.getEdge("e1")?.flareT).toBe(1);
    store.setEdgeStatus("e1", "flowing");
    const edge = store.getEdge("e1");
    expect(edge?.status).toBe("flowing");
    expect(edge?.flareT).toBe(0);
    expect(edge?.flowPhase).toBe(0);
  });

  it("setDragState replaces the drag slice and emits", () => {
    const store = new StudioLinkStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.setDragState({
      source: { nodeId: "a", portId: "out" },
      cursorWorld: { x: 1, y: 2 },
      snapTarget: null,
      snapConfidence: 0,
      validity: "invalid",
    });
    expect(store.getDragState()?.cursorWorld).toEqual({ x: 1, y: 2 });
    expect(calls).toBe(1);
    store.setDragState(null);
    expect(store.getDragState()).toBeNull();
    expect(calls).toBe(2);
  });

  it("removeEdgesForNode purges edges touching the node", () => {
    const store = new StudioLinkStore();
    store.setEdges([
      { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" } },
      { id: "e2", source: { nodeId: "b", portId: "out" }, target: { nodeId: "c", portId: "in" } },
      { id: "e3", source: { nodeId: "x", portId: "out" }, target: { nodeId: "y", portId: "in" } },
    ]);
    store.removeEdgesForNode("b");
    expect(store.listEdges().map((e) => e.id)).toEqual(["e3"]);
  });
});
