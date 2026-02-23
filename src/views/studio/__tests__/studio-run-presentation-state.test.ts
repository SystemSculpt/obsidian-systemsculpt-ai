import { StudioRunPresentationState } from "../StudioRunPresentationState";

describe("StudioRunPresentationState cache hydration", () => {
  it("hydrates cached node status and outputs on load", () => {
    const state = new StudioRunPresentationState();

    state.hydrateFromCache(
      {
        node_a: {
          outputs: {
            path: "/tmp/output.wav",
          },
          updatedAt: "2026-02-22T12:00:00.000Z",
        },
        node_b: {
          outputs: {},
          updatedAt: "2026-02-22T12:00:01.000Z",
        },
      },
      {
        allowedNodeIds: ["node_a"],
      }
    );

    const hydrated = state.getNodeState("node_a");
    expect(hydrated.status).toBe("cached");
    expect(hydrated.message).toBe("Cache ready");
    expect(hydrated.updatedAt).toBe("2026-02-22T12:00:00.000Z");
    expect(hydrated.outputs).toEqual({
      path: "/tmp/output.wav",
    });

    const filtered = state.getNodeState("node_b");
    expect(filtered.status).toBe("idle");
    expect(filtered.outputs).toBeNull();
  });
});
