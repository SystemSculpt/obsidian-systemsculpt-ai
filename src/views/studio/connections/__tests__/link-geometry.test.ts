import {
  buildCubicLinkCurve,
  buildChevronPath,
  curveTangentAtEnd,
} from "../LinkGeometry";

describe("buildCubicLinkCurve", () => {
  it("returns a valid cubic path string", () => {
    const curve = buildCubicLinkCurve({ x: 100, y: 120 }, { x: 320, y: 200 });
    expect(curve.path.startsWith("M 100 120 C ")).toBe(true);
    expect(Number.isFinite(curve.startAngleDeg)).toBe(true);
    expect(Number.isFinite(curve.endAngleDeg)).toBe(true);
  });

  it("produces non-horizontal endpoint tangents when nodes are vertically offset", () => {
    const curve = buildCubicLinkCurve({ x: 50, y: 40 }, { x: 280, y: 210 });
    expect(Math.abs(curve.startAngleDeg)).toBeGreaterThan(0.1);
    expect(Math.abs(curve.endAngleDeg)).toBeGreaterThan(0.1);
  });

  it("keeps horizontal tangents for perfectly horizontal links", () => {
    const curve = buildCubicLinkCurve({ x: 50, y: 100 }, { x: 300, y: 100 });
    expect(Math.abs(curve.startAngleDeg)).toBeLessThan(0.0001);
    expect(Math.abs(curve.endAngleDeg)).toBeLessThan(0.0001);
  });

  it("applies tension multiplier to handle length", () => {
    const loose = buildCubicLinkCurve({ x: 0, y: 0 }, { x: 200, y: 0 }, { tension: 0.2 });
    const taut = buildCubicLinkCurve({ x: 0, y: 0 }, { x: 200, y: 0 }, { tension: 1 });
    expect(loose.handleDistance).toBeLessThan(taut.handleDistance);
  });
});

describe("curveTangentAtEnd", () => {
  it("returns a radian angle pointing from the end control toward the end point", () => {
    const curve = buildCubicLinkCurve({ x: 0, y: 0 }, { x: 200, y: 0 });
    const angle = curveTangentAtEnd(curve);
    expect(angle).toBeCloseTo(0, 3);
  });
});

describe("buildChevronPath", () => {
  it("produces a two-segment path anchored at the end point", () => {
    const path = buildChevronPath({ x: 200, y: 100 }, 0, 6);
    expect(path.startsWith("M ")).toBe(true);
    expect(path.includes(" L 200 100")).toBe(true);
  });
});
