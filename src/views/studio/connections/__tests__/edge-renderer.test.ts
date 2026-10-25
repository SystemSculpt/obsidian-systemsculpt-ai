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
      createPortAnchorResolver: () => (_anchor, direction) =>
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
      createPortAnchorResolver: () => (_anchor, direction) =>
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
      createPortAnchorResolver: () => (_anchor, direction) =>
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
      createPortAnchorResolver: () => () => ({ x: 0, y: 0 }),
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
      createPortAnchorResolver: () => (_anchor, direction) => (direction === "in" ? null : { x: 1, y: 1 }),
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
      createPortAnchorResolver: () => () => ({ x: 10, y: 10 }),
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

  it("resolves every anchor before writing any path and leaves unchanged paths untouched", () => {
    const store = new StudioLinkStore();
    const layer = makeLayer();
    const log: string[] = [];
    const targets: Record<string, { x: number; y: number }> = { b: { x: 300, y: 200 }, c: { x: 300, y: 400 } };
    const renderer = new StudioEdgeRenderer({
      store,
      layer,
      createPortAnchorResolver: () => (anchor, direction) => {
        log.push(`read:${anchor.nodeId}`);
        return direction === "out" ? { x: 0, y: 0 } : targets[anchor.nodeId];
      },
      getCursorAnchorPoint: () => null,
    });
    store.setEdges([edge("e1"), { id: "e2", source: { nodeId: "a", portId: "out" }, target: { nodeId: "c", portId: "in" } }]);
    const original = Element.prototype.setAttribute;
    const setAttribute = jest.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name: string, value: string) {
      if (name === "d") log.push(`write:${(this.parentNode as SVGGElement | null)?.dataset?.edgeId ?? "new"}`);
      original.call(this, name, value);
    });
    try {
      renderer.render();
      const firstWrite = log.findIndex(entry => entry.startsWith("write:"));
      expect(firstWrite).toBeGreaterThan(0);
      expect(log.slice(firstWrite).some(entry => entry.startsWith("read:"))).toBe(false);

      log.length = 0;
      renderer.render();
      expect(log.filter(entry => entry.startsWith("write:"))).toEqual([]);

      log.length = 0;
      targets.c = { x: 320, y: 420 };
      renderer.render();
      // Only the edge whose geometry moved is rewritten: four lines and its arrow.
      expect(log.filter(entry => entry.startsWith("write:"))).toEqual(Array(5).fill("write:e2"));
    } finally {
      setAttribute.mockRestore();
    }
    const line = layer.querySelector('.ss-studio-edge-line[data-edge-id="e2"]');
    expect(line?.getAttribute("d")?.startsWith("M 0 0")).toBe(true);
  });
});
