/** @jest-environment jsdom */
import { StudioActivityDomApplier, applyStudioNodeActivity, type StudioEdgeActivityUpdate } from "../StudioActivityDomApplier";
import { renderStudioActivityBadge } from "../StudioActivityBadge";
import { createNodeActivity, IDLE_NODE_ACTIVITY, type StudioNodeActivity } from "../StudioActivity";
import type { StudioActivitySnapshot } from "../StudioActivityProjector";

function card(): HTMLElement {
  const nodeEl = document.body.createDiv({ cls: "ss-studio-node-card" });
  renderStudioActivityBadge(nodeEl, { activity: IDLE_NODE_ACTIVITY });
  return nodeEl;
}

function snapshot(input: { nodes?: Record<string, StudioNodeActivity>; edges?: Record<string, "idle" | "surging" | "delivered" | "failed">; ports?: Record<string, "emitting" | "receiving"> }): StudioActivitySnapshot {
  return {
    nodes: new Map(Object.entries(input.nodes || {})),
    edges: new Map(Object.entries(input.edges || {})),
    ports: new Map(Object.entries(input.ports || {})),
  };
}

describe("applyStudioNodeActivity", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("writes the phase, busy state, progress contract, and badge in place", () => {
    const nodeEl = card();
    applyStudioNodeActivity(nodeEl, createNodeActivity("active", { detail: "Rendering", progress: 0.25 }));
    expect(nodeEl.dataset.activity).toBe("active");
    expect(nodeEl.getAttribute("aria-busy")).toBe("true");
    expect(nodeEl.style.getPropertyValue("--ss-activity-progress")).toBe("0.250");
    expect(nodeEl.dataset.activityProgress).toBe("determinate");
    const badge = nodeEl.querySelector<HTMLElement>(".ss-studio-node-activity")!;
    expect(badge.hidden).toBe(false);
    expect(badge.dataset.activity).toBe("active");
    expect(badge.querySelector(".ss-studio-node-activity-label")?.textContent).toBe("Running");
    expect(badge.querySelector(".ss-studio-node-activity-progress")?.textContent).toBe("25%");
    expect(badge.querySelector(".ss-studio-node-activity-detail")?.textContent).toBe("Rendering");

    applyStudioNodeActivity(nodeEl, createNodeActivity("done"));
    expect(nodeEl.getAttribute("aria-busy")).toBeNull();
    expect(nodeEl.style.getPropertyValue("--ss-activity-progress")).toBe("");
    expect(nodeEl.dataset.activityProgress).toBeUndefined();
    expect(badge.querySelector(".ss-studio-node-activity-progress")?.textContent).toBe("");

    applyStudioNodeActivity(nodeEl, IDLE_NODE_ACTIVITY);
    expect(badge.hidden).toBe(true);
  });
});

describe("StudioActivityDomApplier", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  function harness() {
    const nodes = new Map<string, HTMLElement>([["n1", card()], ["n2", card()]]);
    const pins = new Map<string, HTMLElement>([
      ["n1:out:text", document.body.createEl("button", { cls: "ss-studio-port-pin" })],
      ["n2:in:prompt", document.body.createEl("button", { cls: "ss-studio-port-pin" })],
    ]);
    const edgeCalls: Array<Map<string, StudioEdgeActivityUpdate>> = [];
    const applier = new StudioActivityDomApplier(() => ({
      getNodeElement: (id) => nodes.get(id) ?? null,
      getPortElement: (nodeId, direction, portId) => pins.get(`${nodeId}:${direction}:${portId}`) ?? null,
      setEdgeActivity: (edges) => edgeCalls.push(new Map(edges)),
    }));
    return { nodes, pins, edgeCalls, applier };
  }

  it("patches nodes, ports, and cables and pulses only on real transitions", () => {
    const { nodes, pins, edgeCalls, applier } = harness();
    applier.apply(snapshot({
      nodes: { n1: createNodeActivity("active"), n2: createNodeActivity("queued") },
      edges: { e1: "surging" },
      ports: { "n1:out:text": "emitting", "n2:in:prompt": "receiving" },
    }));
    expect(nodes.get("n1")?.dataset.activity).toBe("active");
    expect(nodes.get("n2")?.dataset.activity).toBe("queued");
    expect(pins.get("n1:out:text")?.dataset.activity).toBe("emitting");
    expect(pins.get("n2:in:prompt")?.dataset.activity).toBe("receiving");
    expect(edgeCalls[0].get("e1")).toEqual({ phase: "surging", pulse: false });
    expect(nodes.get("n1")?.dataset.activityPulse).toBeUndefined();

    applier.apply(snapshot({
      nodes: { n1: createNodeActivity("done"), n2: createNodeActivity("active") },
      edges: { e1: "delivered" },
      ports: { "n2:out:text": "emitting" },
    }));
    expect(nodes.get("n1")?.dataset.activityPulse).toBe("done");
    expect(nodes.get("n2")?.dataset.activityPulse).toBeUndefined();
    expect(pins.get("n1:out:text")?.dataset.activity).toBeUndefined();
    expect(pins.get("n2:in:prompt")?.dataset.activity).toBeUndefined();
    expect(edgeCalls[1].get("e1")).toEqual({ phase: "delivered", pulse: true });

    // Re-applying the same snapshot (e.g. after a structural re-render) never replays the pulse.
    const fresh = card();
    nodes.set("n1", fresh);
    applier.apply(snapshot({ nodes: { n1: createNodeActivity("done"), n2: createNodeActivity("active") }, edges: { e1: "delivered" } }));
    expect(fresh.dataset.activityPulse).toBeUndefined();
    expect(edgeCalls[2].get("e1")).toEqual({ phase: "delivered", pulse: false });
  });

  it("clears a pulse when its animation ends and forgets memory on reset", () => {
    const { nodes, applier } = harness();
    applier.apply(snapshot({ nodes: { n1: createNodeActivity("active") } }));
    applier.apply(snapshot({ nodes: { n1: createNodeActivity("failed") } }));
    const nodeEl = nodes.get("n1")!;
    expect(nodeEl.dataset.activityPulse).toBe("failed");
    const ended = new Event("animationend", { bubbles: true });
    Object.defineProperty(ended, "animationName", { value: "ss-studio-activity-pulse-card" });
    nodeEl.dispatchEvent(ended);
    expect(nodeEl.dataset.activityPulse).toBeUndefined();

    applier.reset();
    applier.apply(snapshot({ nodes: { n1: createNodeActivity("done") } }));
    expect(nodeEl.dataset.activityPulse).toBeUndefined();
  });

  it("ignores animations bubbling from children", () => {
    const { nodes, applier } = harness();
    applier.apply(snapshot({ nodes: { n1: createNodeActivity("active") } }));
    applier.apply(snapshot({ nodes: { n1: createNodeActivity("done") } }));
    const nodeEl = nodes.get("n1")!;
    const child = nodeEl.querySelector(".ss-studio-node-activity-dot")!;
    const spin = new Event("animationend", { bubbles: true });
    Object.defineProperty(spin, "animationName", { value: "ss-spin" });
    child.dispatchEvent(spin);
    expect(nodeEl.dataset.activityPulse).toBe("done");
  });
});
