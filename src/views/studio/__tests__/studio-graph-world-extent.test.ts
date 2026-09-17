import {
  computeStudioWorldExtent,
  STUDIO_WORLD_EXTENT_MIN_CHUNK,
  worldExtentContains,
  type StudioWorldExtent,
} from "../canvas/StudioGraphWorldExtent";

const view = { left: 0, top: 0, right: 1200, bottom: 800 };
const margin = { x: 1200, y: 800 };
const slack = { x: 2400, y: 1600 };

describe("computeStudioWorldExtent", () => {
  it("lays out room around an empty project in every direction", () => {
    const extent = computeStudioWorldExtent({ current: null, content: null, view, margin, slack });
    expect(extent.left).toBeLessThan(-margin.x);
    expect(extent.top).toBeLessThan(-margin.y);
    expect(extent.left + extent.width).toBeGreaterThan(view.right + margin.x);
    expect(extent.top + extent.height).toBeGreaterThan(view.bottom + margin.y);
    expect(worldExtentContains(extent, view)).toBe(true);
  });

  it("returns the same extent while the view and content still fit", () => {
    const current = computeStudioWorldExtent({ current: null, content: null, view, margin, slack });
    const nudged = { left: 500, top: 300, right: 1700, bottom: 1100 };
    expect(computeStudioWorldExtent({ current, content: null, view: nudged, margin, slack })).toBe(current);
  });

  it("grows only toward the edge the view approaches, by a chunk", () => {
    const current: StudioWorldExtent = { left: -2000, top: -2000, width: 6000, height: 6000 };
    const nearLeft = { left: -1500, top: 0, right: -300, bottom: 800 };
    const next = computeStudioWorldExtent({ current, content: null, view: nearLeft, margin, slack });
    expect(next).not.toBe(current);
    expect(next.left).toBe(-1500 - margin.x - slack.x);
    expect(next.top).toBe(current.top);
    expect(next.left + next.width).toBe(current.left + current.width);
    expect(next.top + next.height).toBe(current.top + current.height);
  });

  it("covers content that sits far outside the view", () => {
    const current: StudioWorldExtent = { left: -2000, top: -2000, width: 6000, height: 6000 };
    const content = { left: 9000, top: -7000, right: 9300, bottom: -6800 };
    const next = computeStudioWorldExtent({ current, content, view, margin, slack });
    expect(worldExtentContains(next, content)).toBe(true);
    expect(worldExtentContains(next, view)).toBe(true);
    expect(next.top).toBe(-7000 - margin.y - slack.y);
    expect(next.left + next.width).toBe(9300 + margin.x + slack.x);
  });

  it("never shrinks below a chunk when slack is tiny", () => {
    const next = computeStudioWorldExtent({ current: null, content: null, view, margin: { x: 0, y: 0 }, slack: { x: 1, y: 1 } });
    expect(next.width).toBeGreaterThanOrEqual(view.right + 2 * STUDIO_WORLD_EXTENT_MIN_CHUNK);
  });

  it("caps the extent and keeps the view inside by trimming the far side", () => {
    const current: StudioWorldExtent = { left: -100, top: -100, width: 1000, height: 1000 };
    const farView = { left: 40_000, top: 0, right: 41_200, bottom: 800 };
    const next = computeStudioWorldExtent({ current, content: null, view: farView, margin, slack, maxSize: 10_000 });
    expect(next.width).toBe(10_000);
    expect(worldExtentContains(next, farView)).toBe(true);
    expect(next.left).toBeGreaterThan(current.left);
  });

  it("keeps the viewport reachable when distant content spans both sides of the cap", () => {
    const next = computeStudioWorldExtent({
      current: null,
      content: { left: -100_000, top: -100_000, right: 100_000, bottom: 100_000 },
      view, margin, slack, maxSize: 10_000,
    });
    expect(next.width).toBe(10_000);
    expect(next.height).toBe(10_000);
    expect(worldExtentContains(next, view)).toBe(true);
  });
});
