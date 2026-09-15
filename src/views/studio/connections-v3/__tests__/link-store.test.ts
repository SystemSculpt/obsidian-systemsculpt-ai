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

  it("keeps the same edge object when an identity is unchanged", () => {
    const store = new StudioLinkStore();
    store.setEdges([
      { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" } },
    ]);
    const before = store.getEdge("e1");
    store.setEdges([
      { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "in" } },
      { id: "e2", source: { nodeId: "b", portId: "out" }, target: { nodeId: "c", portId: "in" } },
    ]);
    expect(store.getEdge("e1")).toBe(before);
    expect(store.listEdges().map((edge) => edge.id)).toEqual(["e1", "e2"]);
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
