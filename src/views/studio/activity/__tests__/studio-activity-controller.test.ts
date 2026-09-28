/** @jest-environment jsdom */
import { StudioActivityController } from "../StudioActivityController";
import { StudioRunPresentationState } from "../../StudioRunPresentationState";
import { renderStudioActivityBadge } from "../StudioActivityBadge";
import { IDLE_NODE_ACTIVITY } from "../StudioActivity";
import type { StudioProjectV1 } from "../../../../studio/types";
import type { StudioEdgeActivityUpdate } from "../StudioActivityDomApplier";

const AT = "2026-09-13T00:00:00.000Z";

function fixture() {
  const project = {
    projectId: "p1",
    graph: {
      nodes: [
        { id: "n1", kind: "studio.text", config: {} },
        { id: "n2", kind: "studio.codex", config: {} },
      ],
      edges: [{ id: "e1", fromNodeId: "n1", fromPortId: "text", toNodeId: "n2", toPortId: "input" }],
    },
  } as unknown as StudioProjectV1;
  const presentation = new StudioRunPresentationState();
  const cards = new Map<string, HTMLElement>();
  for (const node of project.graph.nodes) {
    const el = document.body.createDiv({ cls: "ss-studio-node-card" });
    renderStudioActivityBadge(el, { activity: IDLE_NODE_ACTIVITY });
    cards.set(node.id, el);
  }
  const edgeUpdates: Array<Map<string, StudioEdgeActivityUpdate>> = [];
  const controller = new StudioActivityController({
    getProject: () => project,
    presentation,
    targets: () => ({
      getNodeElement: (id) => cards.get(id) ?? null,
      getPortElement: () => null,
      setEdgeActivity: (edges) => edgeUpdates.push(new Map(edges)),
    }),
  });
  const listeners = new Set<(projectId: string) => void>();
  let runs: Array<{ nodeId: string; status: "running" | "completed"; currentActivity: string; updatedAt: string }> = [];
  controller.bind({
    list: (projectId) => (projectId === "p1" ? runs : []),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  return { project, presentation, cards, edgeUpdates, controller, listeners, setRuns: (next: typeof runs) => { runs = next; } };
}

describe("StudioActivityController", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("projects before paint, applies after, and refreshes in place for run events", () => {
    const { presentation, cards, edgeUpdates, controller } = fixture();
    presentation.beginRun(["n1", "n2"]);
    presentation.applyEvent({ type: "run.started", runId: "r", at: AT });
    presentation.applyEvent({ type: "node.started", runId: "r", nodeId: "n1", at: AT });

    const snapshot = controller.project();
    expect(controller.getNodeActivity("n1")?.phase).toBe("active");
    expect(snapshot.edges.get("e1")).toBe("surging");
    expect(cards.get("n1")?.dataset.activity).toBeUndefined();

    controller.apply();
    expect(cards.get("n1")?.dataset.activity).toBe("active");
    expect(edgeUpdates[0].get("e1")).toEqual({ phase: "surging", pulse: false });

    presentation.applyEvent({ type: "node.progress", runId: "r", nodeId: "n1", percent: 80, message: "Rendering", at: AT });
    controller.refresh();
    expect(cards.get("n1")?.style.getPropertyValue("--ss-activity-progress")).toBe("0.800");
    expect(cards.get("n1")?.querySelector(".ss-studio-node-activity-detail")?.textContent).toBe("Rendering");
  });

  it("follows native Codex runs for the open project only and stops after dispose", () => {
    const { cards, controller, listeners, setRuns } = fixture();
    setRuns([{ nodeId: "n2", status: "running", currentActivity: "Codex is working", updatedAt: AT }]);
    for (const listener of listeners) listener("other-project");
    expect(cards.get("n2")?.dataset.activity).toBeUndefined();
    for (const listener of listeners) listener("p1");
    expect(cards.get("n2")?.dataset.activity).toBe("active");
    expect(cards.get("n2")?.querySelector(".ss-studio-node-activity-detail")?.textContent).toBe("Codex is working");

    controller.dispose();
    expect(listeners.size).toBe(0);
    controller.refresh();
    expect(cards.get("n2")?.dataset.activity).toBe("idle");
  });

  it("reset clears the snapshot and transition memory", () => {
    const { presentation, cards, controller } = fixture();
    presentation.beginRun(["n1"]);
    presentation.applyEvent({ type: "run.started", runId: "r", at: AT });
    presentation.applyEvent({ type: "node.started", runId: "r", nodeId: "n1", at: AT });
    controller.refresh();
    presentation.applyEvent({ type: "node.failed", runId: "r", nodeId: "n1", error: "boom", at: AT });
    controller.refresh();
    expect(cards.get("n1")?.dataset.activityPulse).toBe("failed");

    controller.reset();
    expect(controller.getNodeActivity("n1")).toBeUndefined();
    delete cards.get("n1")!.dataset.activityPulse;
    controller.refresh();
    expect(cards.get("n1")?.dataset.activityPulse).toBeUndefined();
  });
});
