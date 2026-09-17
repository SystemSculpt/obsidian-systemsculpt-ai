import {
  resolveStudioPortAnchorWorldPoint,
  STUDIO_PORT_EDGE_INSET,
  STUDIO_PORT_FALLBACK_LOCAL_Y,
} from "../StudioPortAnchorGeometry";

// A generic node kind (not label/terminal/dataset/expanded-text) resolves to the
// default 280px width via resolveStudioGraphNodeWidth.
const node = (x: number, y: number, config: Record<string, unknown> = {}) =>
  ({ position: { x, y }, kind: "studio.generic", config }) as any;

describe("resolveStudioPortAnchorWorldPoint", () => {
  it("anchors an input port at the node's left edge in world coordinates", () => {
    const point = resolveStudioPortAnchorWorldPoint({ node: node(1000, 500), direction: "in" });
    expect(point).toEqual({
      x: 1000 + STUDIO_PORT_EDGE_INSET,
      y: 500 + STUDIO_PORT_FALLBACK_LOCAL_Y,
    });
  });

  it("anchors an output port at the node's right edge (position + width)", () => {
    const point = resolveStudioPortAnchorWorldPoint({ node: node(1000, 500), direction: "out" });
    // default width 280, output sits just inside the right edge
    expect(point).toEqual({
      x: 1000 + 280 - STUDIO_PORT_EDGE_INSET,
      y: 500 + STUDIO_PORT_FALLBACK_LOCAL_Y,
    });
  });

  it("uses the configured node width for the output edge", () => {
    const point = resolveStudioPortAnchorWorldPoint({
      node: node(0, 0, { width: 400 }),
      direction: "out",
    });
    expect(point.x).toBe(400 - STUDIO_PORT_EDGE_INSET);
  });

  it("prefers a measured offset over the fallback, for both axes", () => {
    const measuredOffset = { dx: 42, dy: 137 };
    const inPoint = resolveStudioPortAnchorWorldPoint({
      node: node(200, 300),
      direction: "in",
      measuredOffset,
    });
    const outPoint = resolveStudioPortAnchorWorldPoint({
      node: node(200, 300),
      direction: "out",
      measuredOffset,
    });
    expect(inPoint).toEqual({ x: 242, y: 437 });
    // measured dx overrides the right-edge default even for an output port
    expect(outPoint).toEqual({ x: 242, y: 437 });
  });

  it("always returns finite coordinates so an edge is never dropped", () => {
    const point = resolveStudioPortAnchorWorldPoint({ node: node(-5, -9), direction: "in" });
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });
});
