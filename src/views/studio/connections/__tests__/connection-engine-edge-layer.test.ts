/** @jest-environment jsdom */
import { StudioGraphConnectionEngine } from "../StudioGraphConnectionEngine";

const SVG_NS = "http://www.w3.org/2000/svg";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

it("measures pins on a full render and on a drag's first frame, then reuses those offsets for the drag", () => {
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

  // The card grew after that render (an image loaded): its pin moved down 20 px.
  source.getBoundingClientRect = () => { reads += 1; return rect(275, 115, 10, 10); };
  // The first drag frame measures once, so the cable lands on the moved pin.
  reads = 0;
  project.graph.nodes[0].position = { x: 20, y: 10 };
  engine.renderEdgeLayer({ translating: true });
  expect(reads).toBe(4);
  expect(line().startsWith("M 300 130")).toBe(true);

  // Later drag frames: node A moved again; nothing is measured and the cable follows.
  reads = 0;
  project.graph.nodes[0].position = { x: 40, y: 30 };
  engine.renderEdgeLayer({ translating: true });
  engine.renderEdgeLayer({ translating: true });
  expect(reads).toBe(0);
  expect(line().startsWith("M 320 150")).toBe(true);

  // The next full render measures again.
  engine.renderEdgeLayer();
  expect(reads).toBe(4);
  world.remove();
});

it("draws an armed connection's moves as one preview redraw per frame and leaves the cables alone", () => {
  const frames: FrameRequestCallback[] = [];
  const requestFrame = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
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
    getPortType: () => "text",
    portTypeCompatible: () => true,
  } as any);
  const viewport = document.body.appendChild(document.createElement("div"));
  const world = viewport.appendChild(document.createElement("div"));
  const layer = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  world.appendChild(layer);
  engine.registerViewportElement(viewport);
  engine.registerCanvasElement(world);
  engine.registerEdgesLayerElement(layer);
  let pinReads = 0;
  for (const [nodeId, direction] of [["a", "out"], ["b", "in"]] as const) {
    const cardEl = world.appendChild(document.createElement("div"));
    cardEl.className = "ss-studio-node-card";
    const pin = cardEl.appendChild(document.createElement("button"));
    cardEl.getBoundingClientRect = () => { pinReads += 1; return rect(0, 0, 280, 200); };
    pin.getBoundingClientRect = () => { pinReads += 1; return rect(direction === "in" ? -5 : 275, 95, 10, 10); };
    engine.registerPortElement(nodeId, direction, direction, pin);
  }
  engine.renderEdgeLayer();
  engine.beginConnection("a", "out");

  const cable = [...layer.querySelectorAll(".ss-studio-edge-group path")];
  const cableWrites = cable.map((path) => jest.spyOn(path, "setAttribute"));
  const preview = layer.querySelector(".ss-studio-edge-preview")!;
  const previewWrites = jest.spyOn(preview, "setAttribute");
  const worldReads = jest.spyOn(world, "getBoundingClientRect");
  pinReads = 0;

  for (const x of [320, 340, 360, 380]) {
    viewport.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: 400 }));
  }
  expect(frames).toHaveLength(1);
  expect(previewWrites).not.toHaveBeenCalled();

  frames.shift()!(0);

  // One frame: the world is measured once and the preview is redrawn once, to
  // the last point. Only the preview's source pin is measured, not the cable's two.
  expect(worldReads).toHaveBeenCalledTimes(1);
  expect(pinReads).toBe(2);
  const previewPaths = previewWrites.mock.calls.filter(([name]) => name === "d").map(([, d]) => d);
  expect(previewPaths).toHaveLength(1);
  expect(previewPaths[0].endsWith("380 400")).toBe(true);
  for (const writes of cableWrites) expect(writes).not.toHaveBeenCalled();
  expect(layer.querySelectorAll(".ss-studio-edge-group")).toHaveLength(1);

  engine.clearPendingConnection();
  expect(layer.querySelector(".ss-studio-edge-preview")).toBeNull();
  requestFrame.mockRestore();
  viewport.remove();
});
