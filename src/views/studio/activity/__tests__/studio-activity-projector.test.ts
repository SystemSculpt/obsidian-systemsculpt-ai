import { StudioRunPresentationState } from "../../StudioRunPresentationState";
import { portActivityKey, projectStudioActivity, type StudioActivityAgentRun } from "../StudioActivityProjector";

const AT = "2026-09-13T00:00:00.000Z";
const graph = {
  nodes: [
    { id: "n1", kind: "studio.text" },
    { id: "n2", kind: "studio.text_generation" },
    { id: "n3", kind: "studio.codex" },
  ],
  edges: [
    { id: "e1", fromNodeId: "n1", fromPortId: "text", toNodeId: "n2", toPortId: "prompt" },
    { id: "e2", fromNodeId: "n2", fromPortId: "text", toNodeId: "n3", toPortId: "input" },
  ],
};

function project(presentation: StudioRunPresentationState, agentRuns: StudioActivityAgentRun[] = [], placeholders: string[] = []) {
  return projectStudioActivity({
    graph,
    runStatus: presentation.getProgress().status,
    getNodeRunState: (nodeId) => presentation.getNodeState(nodeId),
    agentRuns,
    isPlaceholder: (nodeId) => placeholders.includes(nodeId),
  });
}

describe("projectStudioActivity", () => {
  it("is quiet before any run, even with hydrated cache", () => {
    const presentation = new StudioRunPresentationState();
    presentation.hydrateFromCache({ n1: { outputs: { text: "hi" } } });
    const snapshot = project(presentation);
    expect(snapshot.nodes.get("n1")?.phase).toBe("cached");
    expect(snapshot.nodes.get("n2")?.phase).toBe("idle");
    expect(snapshot.edges.get("e1")).toBe("idle");
    expect(snapshot.ports.size).toBe(0);
  });

  it("surges the cables and charges the ports of a working node", () => {
    const presentation = new StudioRunPresentationState();
    presentation.beginRun(["n1", "n2", "n3"]);
    presentation.applyEvent({ type: "run.started", runId: "r", at: AT });
    presentation.applyEvent({ type: "node.started", runId: "r", nodeId: "n1", at: AT });
    presentation.applyEvent({ type: "node.output", runId: "r", nodeId: "n1", outputRef: "ref", outputs: { text: "hi" }, at: AT } as never);
    presentation.applyEvent({ type: "node.started", runId: "r", nodeId: "n2", at: AT });
    presentation.applyEvent({ type: "node.progress", runId: "r", nodeId: "n2", percent: 40, message: "Thinking", at: AT });

    const snapshot = project(presentation);
    expect(snapshot.nodes.get("n1")?.phase).toBe("done");
    expect(snapshot.nodes.get("n2")).toEqual({ phase: "active", label: "Running", detail: "Thinking", progress: 0.4 });
    expect(snapshot.nodes.get("n3")?.phase).toBe("queued");
    expect(snapshot.edges.get("e1")).toBe("delivered");
    expect(snapshot.edges.get("e2")).toBe("surging");
    expect(snapshot.ports.get(portActivityKey("n2", "out", "text"))).toBe("emitting");
    expect(snapshot.ports.get(portActivityKey("n3", "in", "input"))).toBe("receiving");
    expect(snapshot.ports.has(portActivityKey("n1", "out", "text"))).toBe(false);
  });

  it("marks failed sources and settles unfinished nodes when the run ends", () => {
    const presentation = new StudioRunPresentationState();
    presentation.beginRun(["n1", "n2", "n3"]);
    presentation.applyEvent({ type: "run.started", runId: "r", at: AT });
    presentation.applyEvent({ type: "node.started", runId: "r", nodeId: "n1", at: AT });
    presentation.applyEvent({ type: "node.failed", runId: "r", nodeId: "n1", error: "boom", at: AT });
    presentation.applyEvent({ type: "run.completed", runId: "r", status: "failed", at: AT });

    const snapshot = project(presentation);
    expect(snapshot.nodes.get("n1")).toMatchObject({ phase: "failed", detail: "boom" });
    expect(snapshot.nodes.get("n2")?.phase).toBe("idle");
    expect(snapshot.edges.get("e1")).toBe("failed");
    expect(snapshot.edges.get("e2")).toBe("idle");
    expect(snapshot.ports.size).toBe(0);
  });

  it("lets a live native Codex run own its role card and cables", () => {
    const presentation = new StudioRunPresentationState();
    const runs: StudioActivityAgentRun[] = [
      { nodeId: "n3", status: "completed", currentActivity: "Completed", updatedAt: "2026-09-13T00:00:01.000Z" },
      { nodeId: "n3", status: "waiting", currentActivity: "Waiting for your answer", updatedAt: "2026-09-13T00:00:00.000Z" },
    ];
    const snapshot = project(presentation, runs);
    expect(snapshot.nodes.get("n3")).toEqual({ phase: "waiting", label: "Waiting", detail: "Waiting for your answer", progress: null });
    expect(snapshot.edges.get("e2")).toBe("idle");
  });

  it("reports a settled native run when the graph is quiet, but a live graph run wins", () => {
    const presentation = new StudioRunPresentationState();
    const settled: StudioActivityAgentRun[] = [{ nodeId: "n3", status: "failed", currentActivity: "Stopped", error: "Transport lost", updatedAt: AT }];
    expect(project(presentation, settled).nodes.get("n3")).toMatchObject({ phase: "failed", detail: "Transport lost" });

    presentation.beginRun(["n3"]);
    presentation.applyEvent({ type: "run.started", runId: "r", at: AT });
    presentation.applyEvent({ type: "node.started", runId: "r", nodeId: "n3", at: AT });
    expect(project(presentation, settled).nodes.get("n3")?.phase).toBe("active");
  });

  it("shows managed output placeholders as generating", () => {
    const presentation = new StudioRunPresentationState();
    const snapshot = project(presentation, [], ["n2"]);
    expect(snapshot.nodes.get("n2")).toMatchObject({ phase: "active", label: "Generating" });
    expect(snapshot.edges.get("e2")).toBe("surging");
  });

  it("returns an empty snapshot without a graph", () => {
    const snapshot = projectStudioActivity({ graph: null, runStatus: "idle", getNodeRunState: () => ({ status: "idle", message: "", updatedAt: null, outputs: null }) });
    expect(snapshot.nodes.size).toBe(0);
    expect(snapshot.edges.size).toBe(0);
  });
});
