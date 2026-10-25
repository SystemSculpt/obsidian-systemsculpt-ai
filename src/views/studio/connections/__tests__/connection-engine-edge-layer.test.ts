/** @jest-environment jsdom */
import { StudioGraphConnectionEngine } from "../StudioGraphConnectionEngine";

const SVG_NS = "http://www.w3.org/2000/svg";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

it("measures pins on a full edge render and reuses those offsets on drag frames", () => {
  const project = {
    graph: {
      nodes: [
        { id: "a", kind: "studio.text", version: "1.0.0", title: "A", position: { x: 0, y: 0 }, config: {} },
        { id: "b", kind: "studio.text", version: "1.0.0", title: "B", position: { x: 600, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", fromNodeId: "a", fromPortId: "out", toNodeId: "b", toPortId: "in" }],
      groups: [],
    },
  };
  const engine = new StudioGraphConnectionEngine({
    isBusy: () => false,
    getCurrentProject: () => project as any,
    setError: jest.fn(),
    commitProjectMutation: jest.fn(() => true),
    requestRender: jest.fn(),
    getGraphZoom: () => 1,
  } as any);
  const world = document.createElement("div");
  document.body.appendChild(world);
  const layer = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  world.appendChild(layer);
  engine.registerCanvasElement(world);
  engine.registerEdgesLayerElement(layer);

  let reads = 0;
  const card = (nodeId: string, direction: "in" | "out", pinTop: number) => {
    const cardEl = world.appendChild(document.createElement("div"));
    cardEl.className = "ss-studio-node-card";
    const pin = cardEl.appendChild(document.createElement("button"));
    pin.className = `ss-studio-port-pin ${direction === "in" ? "is-input" : "is-output"}`;
    cardEl.getBoundingClientRect = () => { reads += 1; return rect(0, 0, 280, 200); };
    pin.getBoundingClientRect = () => { reads += 1; return rect(direction === "in" ? -5 : 275, pinTop, 10, 10); };
    engine.registerPortElement(nodeId, direction, direction === "in" ? "in" : "out", pin);
    return pin;
  };
  const source = card("a", "out", 95);
  card("b", "in", 45);

  engine.renderEdgeLayer();
  expect(reads).toBe(4);
  const line = () => layer.querySelector(".ss-studio-edge-line")?.getAttribute("d") ?? "";
  expect(line().startsWith("M 280 100")).toBe(true);
  expect(source.classList.contains("is-linked")).toBe(true);

  // A drag frame: node A moved; nothing is measured and the cable follows.
  reads = 0;
  project.graph.nodes[0].position = { x: 40, y: 30 };
  engine.renderEdgeLayer({ translating: true });
  expect(reads).toBe(0);
  expect(line().startsWith("M 320 130")).toBe(true);

  // The next full render measures again.
  engine.renderEdgeLayer();
  expect(reads).toBe(4);
  world.remove();
});
