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

describe("StudioRunPresentationState progress", () => {
  const AT = "2026-09-13T00:00:00.000Z";

  it("keeps determinate progress as a fraction and clears it when the node settles", () => {
    const state = new StudioRunPresentationState();
    state.beginRun(["n1"]);
    state.applyEvent({ type: "run.started", runId: "r", at: AT });
    state.applyEvent({ type: "node.started", runId: "r", nodeId: "n1", at: AT });
    expect(state.getNodeState("n1").progress).toBeNull();

    state.applyEvent({ type: "node.progress", runId: "r", nodeId: "n1", percent: 42.4, message: "Rendering", at: AT });
    expect(state.getNodeState("n1")).toMatchObject({ status: "running", message: "Rendering", progress: 0.424 });

    state.applyEvent({ type: "node.progress", runId: "r", nodeId: "n1", percent: 250, at: AT });
    expect(state.getNodeState("n1")).toMatchObject({ message: "", progress: 1 });

    state.applyEvent({ type: "node.output", runId: "r", nodeId: "n1", outputRef: "ref", outputs: { text: "done" }, at: AT } as never);
    expect(state.getNodeState("n1")).toMatchObject({ status: "succeeded", progress: null });
  });
});
