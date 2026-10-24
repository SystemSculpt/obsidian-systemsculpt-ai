/** @jest-environment jsdom */
import { StudioPortInteraction } from "../StudioPortInteraction";
import { StudioLinkStore } from "../StudioLinkStore";
import { StudioGraphInteractionEngine } from "../../StudioGraphInteractionEngine";
import type { StudioGraphInteractionHost } from "../../StudioGraphInteractionTypes";
import { renderNodePorts } from "../../canvas/StudioGraphNodeCardSections";
import { createEmptyStudioProject } from "../../../../studio/schema";
import { workflowNode } from "../../../../studio/nodes/workflowNode";
import { jsonNode } from "../../../../studio/nodes/jsonNode";

// jsdom has no PointerEvent and no setPointerCapture; provide minimal shims.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

type Rect = { left: number; top: number; width: number; height: number };
function rectOf(r: Rect): DOMRect {
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect;
}

function makePin(
  cls: string,
  nodeId: string,
  portId: string,
  rect: Rect
): HTMLElement {
  const el = document.createElement("button");
  el.className = cls;
  el.dataset.nodeId = nodeId;
  el.dataset.portId = portId;
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => rectOf(rect);
  (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (el as unknown as { releasePointerCapture: () => void }).releasePointerCapture =
    () => {};
  return el;
}

describe("StudioPortInteraction drag-to-connect", () => {
  it("still knows the source port when the commit callback fires", () => {
    const store = new StudioLinkStore();

    const canvas = document.createElement("div");
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });

    const sourcePin = makePin("ss-studio-port-pin is-output", "src", "out", {
      left: 0,
      top: 50,
      width: 12,
      height: 12,
    });
    const targetPin = makePin("ss-studio-port-pin is-input", "dst", "in", {
      left: 200,
      top: 200,
      width: 12,
      height: 12,
    });
    document.body.append(canvas, sourcePin, targetPin);

    const host = {
      getCurrentProject: () => null,
      isBusy: () => false,
      getGraphZoom: () => 1,
      getPortType: () => "text",
      portTypeCompatible: () => true,
      describeConnectionAutoCreate: () => null,
    };

    // The whole point: read the pending source AT THE MOMENT of commit.
    let sourceAtCommit: string | null = "UNSET";
    const interaction = new StudioPortInteraction(host as never, store, {
      onConnectionCommit: () => {
        sourceAtCommit = interaction.getPendingConnectionSourceKey();
      },
      onAutoCreateHint: () => {},
      onAutoCreateRelease: () => false,
      onDragStateChange: () => {},
    });

    interaction.registerCanvas(canvas);
    interaction.registerPortElement("dst", "in", "in", targetPin);

    const down = new FakePointerEvent("pointerdown", {
      button: 0,
      clientX: 6,
      clientY: 56,
      pointerId: 1,
    });
    interaction.startDrag("src", "out", down as unknown as PointerEvent, sourcePin);

    window.dispatchEvent(
      new FakePointerEvent("pointermove", {
        clientX: 206,
        clientY: 206,
        pointerId: 1,
      })
    );

    window.dispatchEvent(
      new FakePointerEvent("pointerup", {
        clientX: 206,
        clientY: 206,
        pointerId: 1,
      })
    );

    expect(sourceAtCommit).toBe("src:out:out");
  });

  it("connects when the drag is released anywhere over another node's card", () => {
    const store = new StudioLinkStore();

    const canvas = document.createElement("div");
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });

    const sourcePin = makePin("ss-studio-port-pin is-output", "src", "out", {
      left: 0,
      top: 50,
      width: 12,
      height: 12,
    });
    // Far outside the pin snap radius: only the card drop can resolve it.
    const targetPin = makePin("ss-studio-port-pin is-input", "dst", "in", {
      left: 400,
      top: 400,
      width: 12,
      height: 12,
    });
    const targetCard = document.createElement("div");
    targetCard.className = "ss-studio-node-card";
    targetCard.dataset.nodeId = "dst";
    targetCard.append(targetPin);
    document.body.append(canvas, sourcePin, targetCard);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint =
      () => targetCard;

    const host = {
      getCurrentProject: () => null,
      isBusy: () => false,
      getGraphZoom: () => 1,
      getPortType: () => "any",
      portTypeCompatible: () => true,
      describeConnectionAutoCreate: () => null,
    };

    const commits: Array<{ nodeId: string; portId: string }> = [];
    const interaction = new StudioPortInteraction(host as never, store, {
      onConnectionCommit: (target) => commits.push(target),
      onAutoCreateHint: () => {},
      onAutoCreateRelease: () => false,
      onDragStateChange: () => {},
    });

    interaction.registerCanvas(canvas);
    interaction.registerPortElement("dst", "in", "in", targetPin);

    interaction.startDrag(
      "src",
      "out",
      new FakePointerEvent("pointerdown", {
        button: 0,
        clientX: 6,
        clientY: 56,
        pointerId: 1,
      }) as unknown as PointerEvent,
      sourcePin
    );
    window.dispatchEvent(
      new FakePointerEvent("pointermove", { clientX: 500, clientY: 300, pointerId: 1 })
    );
    window.dispatchEvent(
      new FakePointerEvent("pointerup", { clientX: 500, clientY: 300, pointerId: 1 })
    );

    expect(commits).toEqual([{ nodeId: "dst", portId: "in" }]);
  });

  it("never self-connects when the drag is released over its own card", () => {
    const store = new StudioLinkStore();

    const canvas = document.createElement("div");
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });

    const sourcePin = makePin("ss-studio-port-pin is-output", "src", "out", {
      left: 0,
      top: 50,
      width: 12,
      height: 12,
    });
    const sourceInputPin = makePin("ss-studio-port-pin is-input", "src", "in", {
      left: 0,
      top: 400,
      width: 12,
      height: 12,
    });
    const sourceCard = document.createElement("div");
    sourceCard.className = "ss-studio-node-card";
    sourceCard.dataset.nodeId = "src";
    sourceCard.append(sourcePin, sourceInputPin);
    document.body.append(canvas, sourceCard);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint =
      () => sourceCard;

    const host = {
      getCurrentProject: () => null,
      isBusy: () => false,
      getGraphZoom: () => 1,
      getPortType: () => "any",
      portTypeCompatible: () => true,
      describeConnectionAutoCreate: () => null,
    };

    const commits: Array<{ nodeId: string; portId: string }> = [];
    const interaction = new StudioPortInteraction(host as never, store, {
      onConnectionCommit: (target) => commits.push(target),
      onAutoCreateHint: () => {},
      onAutoCreateRelease: () => false,
      onDragStateChange: () => {},
    });

    interaction.registerCanvas(canvas);
    interaction.registerPortElement("src", "in", "in", sourceInputPin);

    interaction.startDrag(
      "src",
      "out",
      new FakePointerEvent("pointerdown", {
        button: 0,
        clientX: 6,
        clientY: 56,
        pointerId: 1,
      }) as unknown as PointerEvent,
      sourcePin
    );
    window.dispatchEvent(
      new FakePointerEvent("pointermove", { clientX: 6, clientY: 200, pointerId: 1 })
    );
    window.dispatchEvent(
      new FakePointerEvent("pointerup", { clientX: 6, clientY: 200, pointerId: 1 })
    );

    expect(commits).toEqual([]);
  });
});

function makeConnectionHarness(targetKind: "studio.workflow" | "studio.json" = "studio.workflow") {
  const project = createEmptyStudioProject({ name: "Connections", policyPath: "Connections.systemsculpt-assets/policy/grants.json", minPluginVersion: "6.14.0", maxRuns: 10, maxArtifactsMb: 128 });
  project.graph.nodes = [
    { id: "src", kind: "studio.json", version: "1.0.0", title: "Source", position: { x: 0, y: 50 }, config: {} },
    { id: "dst", kind: targetKind, version: "1.0.0", title: "Saved work", position: { x: 200, y: 200 }, config: { description: "Keep this" } },
  ];
  const commit = jest.fn<ReturnType<StudioGraphInteractionHost["commitProjectMutation"]>, Parameters<StudioGraphInteractionHost["commitProjectMutation"]>>((_reason, mutate) => mutate(project) !== false);
  const setError = jest.fn();
  const engine = new StudioGraphInteractionEngine({
    getCurrentProject: () => project, isBusy: () => false, setError, commitProjectMutation: commit, requestRender: jest.fn(),
    getPortType: (nodeId, direction, portId) => {
      const node = project.graph.nodes.find(entry => entry.id === nodeId);
      const definition = node?.kind === "studio.workflow" ? workflowNode : jsonNode;
      return (direction === "in" ? definition.inputPorts : definition.outputPorts).find(port => port.id === portId)?.type || null;
    },
    portTypeCompatible: (source, target) => source === target,
  });
  const canvas = document.body.createDiv();
  canvas.getBoundingClientRect = () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });
  engine.registerCanvasElement(canvas);
  for (const node of project.graph.nodes) {
    const card = canvas.createDiv({ cls: "ss-studio-node-card", attr: { "data-node-id": node.id } });
    card.getBoundingClientRect = () => rectOf({ left: node.position.x, top: node.position.y, width: 280, height: 164 });
    engine.registerNodeElement(node.id, card);
    renderNodePorts({ nodeEl: card, node, definition: node.kind === "studio.workflow" ? workflowNode : jsonNode, graphInteraction: engine, interactionLocked: false });
    for (const pin of card.querySelectorAll<HTMLButtonElement>(".ss-studio-port-pin")) {
      pin.getBoundingClientRect = () => rectOf({ left: node.position.x, top: node.position.y, width: 12, height: 12 });
    }
  }
  return { project, engine, commit, setError, canvas,
    sourcePin: engine.getPortElement("src", "out", "json") as HTMLButtonElement,
    targetPin: engine.getPortElement("dst", "in", targetKind === "studio.workflow" ? "context" : "json") as HTMLButtonElement,
  };
}

describe("retired workflow connection enforcement", () => {
  let cleanup = () => {};
  afterEach(() => { cleanup(); jest.restoreAllMocks(); document.body.innerHTML = ""; });

  it.each([
    ["disabled workflow pin", "studio.workflow", true, "pin"],
    ["disabled workflow card", "studio.workflow", true, "card"],
    ["stale enabled workflow pin", "studio.workflow", false, "pin"],
    ["stale enabled workflow card", "studio.workflow", false, "card"],
    ["disabled ordinary pin", "studio.json", true, "pin"],
    ["disabled ordinary card", "studio.json", true, "card"],
  ] as const)("excludes %s from incoming drags", (_label, kind, disabled, drop) => {
    const h = makeConnectionHarness(kind);
    cleanup = () => h.engine.clearRenderBindings();
    expect(h.targetPin.disabled).toBe(kind === "studio.workflow");
    h.targetPin.disabled = disabled;
    const before = JSON.stringify(h.project);
    const card = h.targetPin.closest<HTMLElement>(".ss-studio-node-card")!;
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => card;
    try {
      h.sourcePin.dispatchEvent(new FakePointerEvent("pointerdown", { button: 0, clientX: 6, clientY: 56, pointerId: 1, bubbles: true }));
      expect(h.targetPin.classList.contains("is-drop-target")).toBe(false);
      const release = { clientX: drop === "pin" ? 206 : 450, clientY: drop === "pin" ? 206 : 320, pointerId: 1 };
      window.dispatchEvent(new FakePointerEvent("pointermove", release));
      window.dispatchEvent(new FakePointerEvent("pointerup", release));
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.setError).not.toHaveBeenCalled();
      expect(h.engine.getPendingConnection()).toBeNull();
      expect(h.engine.getPortElement("dst", "in", h.targetPin.dataset.portId!)).toBe(h.targetPin);
      expect(JSON.stringify(h.project)).toBe(before);
    } finally {
      document.elementFromPoint = originalElementFromPoint;
    }
  });

  it.each(["source", "target"])("rejects a retired workflow %s at commit even when the connection was already armed", endpoint => {
    const h = makeConnectionHarness("studio.json");
    cleanup = () => h.engine.clearRenderBindings();
    h.engine.beginConnection("src", "json");
    h.project.graph.nodes[endpoint === "source" ? 0 : 1].kind = "studio.workflow";
    h.engine.completeConnection("dst", endpoint === "target" ? "context" : "json");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.project.graph.edges).toEqual([]);
    expect(h.engine.getPendingConnection()).toBeNull();
    expect(h.setError).toHaveBeenCalledWith("Retired workflow notes cannot accept new connections.");
  });

  it("still connects ordinary nodes through the same production drag path", () => {
    const h = makeConnectionHarness("studio.json");
    cleanup = () => h.engine.clearRenderBindings();
    h.sourcePin.dispatchEvent(new FakePointerEvent("pointerdown", { button: 0, clientX: 6, clientY: 56, pointerId: 1, bubbles: true }));
    window.dispatchEvent(new FakePointerEvent("pointermove", { clientX: 206, clientY: 206, pointerId: 1 }));
    window.dispatchEvent(new FakePointerEvent("pointerup", { clientX: 206, clientY: 206, pointerId: 1 }));
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.project.graph.edges).toEqual([expect.objectContaining({ fromNodeId: "src", fromPortId: "json", toNodeId: "dst", toPortId: "json" })]);
  });

  it("keeps saved workflow connections and anchors available for rendering", () => {
    const h = makeConnectionHarness();
    cleanup = () => h.engine.clearRenderBindings();
    h.project.graph.edges.push({ id: "saved", fromNodeId: "src", fromPortId: "json", toNodeId: "dst", toPortId: "context" });
    const layer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    h.canvas.appendChild(layer);
    h.engine.registerEdgesLayerElement(layer);
    h.engine.renderEdgeLayer();
    expect(h.engine.getPortElement("dst", "in", "context")).toBe(h.targetPin);
    expect(h.targetPin.disabled).toBe(true);
    expect(h.targetPin.classList.contains("is-linked")).toBe(true);
    expect(layer.querySelector('path[data-edge-id="saved"]')).not.toBeNull();
    expect(h.project.graph.edges).toHaveLength(1);
    expect(h.commit).not.toHaveBeenCalled();
  });
});
