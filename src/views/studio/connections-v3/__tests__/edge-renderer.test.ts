/** @jest-environment jsdom */
import { StudioEdgeRenderer } from "../StudioEdgeRenderer";
import { StudioLinkStore } from "../StudioLinkStore";

const SVG_NS = "http://www.w3.org/2000/svg";
const makeLayer = () => document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
const edge = (id: string) => ({
  id,
  source: { nodeId: "a", portId: "out" },
  target: { nodeId: "b", portId: "in" },
});

describe("StudioEdgeRenderer", () => {
  it("creates a visible, inline-styled path for each edge", () => {
    const store = new StudioLinkStore();
    const layer = makeLayer();
    const renderer = new StudioEdgeRenderer({
      store,
      layer,
      resolvePortAnchorPoint: (_anchor, direction) =>
        direction === "out" ? { x: 100, y: 100 } : { x: 400, y: 260 },
      getCursorAnchorPoint: () => null,
    });

    store.setEdges([edge("e1")]);
    renderer.render();

    const line = layer.querySelector(".ss-studio-edge-line") as SVGPathElement | null;
    expect(line).not.toBeNull();
    expect(line!.getAttribute("d")).toBeTruthy();
    expect(line!.getAttribute("d")!.startsWith("M 100 100")).toBe(true);
    // Inline-styled so no stylesheet rule can hide it.
    expect(line!.style.fill).toBe("none");
    expect(line!.style.strokeWidth).toBe("1.6");
    expect(line!.style.display).not.toBe("none");

    const group = layer.querySelector(".ss-studio-edge-group") as SVGGElement;
    expect(group.dataset.status).toBe("idle");
    // hit target + arrow are present too
    expect(layer.querySelector(".ss-studio-edge-hit")).not.toBeNull();
    expect(layer.querySelector(".ss-studio-edge-arrow")).not.toBeNull();
  });

  it("removes a group when its edge goes away", () => {
    const store = new StudioLinkStore();
    const layer = makeLayer();
    const renderer = new StudioEdgeRenderer({
      store,
      layer,
      resolvePortAnchorPoint: () => ({ x: 0, y: 0 }),
      getCursorAnchorPoint: () => null,
    });

    store.setEdges([edge("e1")]);
    renderer.render();
    expect(layer.querySelectorAll(".ss-studio-edge-group").length).toBe(1);

    store.setEdges([]);
    renderer.render();
    expect(layer.querySelectorAll(".ss-studio-edge-group").length).toBe(0);
  });

  it("skips an edge whose endpoint anchor cannot be resolved", () => {
    const store = new StudioLinkStore();
    const layer = makeLayer();
    const renderer = new StudioEdgeRenderer({
      store,
      layer,
      resolvePortAnchorPoint: (_anchor, direction) => (direction === "in" ? null : { x: 1, y: 1 }),
      getCursorAnchorPoint: () => null,
    });

    store.setEdges([edge("e1")]);
    renderer.render();
    expect(layer.querySelectorAll(".ss-studio-edge-line").length).toBe(0);
  });

  it("draws a dashed preview while a drag is in progress", () => {
    const store = new StudioLinkStore();
    const layer = makeLayer();
    const renderer = new StudioEdgeRenderer({
      store,
      layer,
      resolvePortAnchorPoint: () => ({ x: 10, y: 10 }),
      getCursorAnchorPoint: () => ({ x: 200, y: 200 }),
    });

    store.setDragState({
      source: { nodeId: "a", portId: "out" },
      cursorWorld: { x: 200, y: 200 },
      snapTarget: null,
      snapConfidence: 0,
      validity: "near",
    });
    renderer.render();

    const preview = layer.querySelector(".ss-studio-edge-preview") as SVGPathElement | null;
    expect(preview).not.toBeNull();
    expect(preview!.getAttribute("d")).toBeTruthy();
    expect(preview!.style.strokeDasharray).toBe("6 6");

    // clears when the drag ends
    store.setDragState(null);
    renderer.render();
    expect(layer.querySelector(".ss-studio-edge-preview")).toBeNull();
  });
});
