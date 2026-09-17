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
  it("creates a visible path for each edge with dynamic stroke inline", () => {
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
    // The base stroke is inline (through --ss-studio-edge-stroke with
    // fallbacks) so no stylesheet regression can blank the line; static
    // presentation and run-state visuals live on .ss-studio-edge-* rules in
    // src/css/views/studio/connections.css and activity.css.
    expect(line!.style.stroke).toContain("--ss-studio-edge-stroke");
    expect(line!.style.display).not.toBe("none");

    const group = layer.querySelector(".ss-studio-edge-group") as SVGGElement;
    expect(group.dataset.activity).toBe("idle");
    // hit target, glow, energy, and arrow are present too
    expect(layer.querySelector(".ss-studio-edge-hit")).not.toBeNull();
    expect(layer.querySelector(".ss-studio-edge-glow")?.getAttribute("d")).toBe(line!.getAttribute("d"));
    expect(layer.querySelector(".ss-studio-edge-energy")?.getAttribute("d")).toBe(line!.getAttribute("d"));
    expect(layer.querySelector(".ss-studio-edge-arrow")).not.toBeNull();
  });

  it("stamps activity on new groups from the resolver and patches existing ones in place", () => {
    const store = new StudioLinkStore();
    const layer = makeLayer();
    let phase: "idle" | "surging" | "delivered" | "failed" = "surging";
    const renderer = new StudioEdgeRenderer({
      store,
      layer,
      resolvePortAnchorPoint: (_anchor, direction) =>
        direction === "out" ? { x: 0, y: 0 } : { x: 100, y: 100 },
      getCursorAnchorPoint: () => null,
      resolveEdgeActivity: () => phase,
    });
    store.setEdges([edge("e1")]);
    renderer.render();
    const group = layer.querySelector(".ss-studio-edge-group") as SVGGElement;
    expect(group.dataset.activity).toBe("surging");

    phase = "delivered";
    renderer.applyEdgeActivity("e1", "delivered", { pulse: true });
    expect(group.dataset.activity).toBe("delivered");
    expect(group.dataset.activityPulse).toBe("delivered");
    // Geometry re-renders keep the same group and its phase.
    renderer.render();
    expect(layer.querySelector(".ss-studio-edge-group")).toBe(group);
    expect(group.dataset.activity).toBe("delivered");
    expect(() => renderer.applyEdgeActivity("missing", "failed")).not.toThrow();
  });

  it("creates every SVG node in the edge layer owner document", () => {
    const ownerDocument = document.implementation.createHTMLDocument("Studio popout");
    const layer = ownerDocument.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const store = new StudioLinkStore();
    const renderer = new StudioEdgeRenderer({
      store,
      layer,
      resolvePortAnchorPoint: (_anchor, direction) =>
        direction === "out" ? { x: 40, y: 50 } : { x: 200, y: 160 },
      getCursorAnchorPoint: () => null,
    });

    store.setEdges([edge("popout-edge")]);
    renderer.render();

    const group = layer.querySelector(".ss-studio-edge-group");
    expect(group?.ownerDocument).toBe(ownerDocument);
    expect(group?.querySelector(".ss-studio-edge-line")?.ownerDocument).toBe(ownerDocument);
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
