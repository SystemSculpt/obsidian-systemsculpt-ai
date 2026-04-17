import { resolveSnapTarget } from "../LinkSnap";

const CANDIDATES = [
  { portKey: "n1:in:in", nodeId: "n1", portId: "in", center: { x: 100, y: 100 }, compatible: true },
  { portKey: "n2:in:in", nodeId: "n2", portId: "in", center: { x: 200, y: 200 }, compatible: true },
  { portKey: "n3:in:in", nodeId: "n3", portId: "in", center: { x: 110, y: 105 }, compatible: false },
];

describe("resolveSnapTarget", () => {
  it("returns the nearest compatible port within radius", () => {
    const result = resolveSnapTarget({
      cursorWorld: { x: 105, y: 102 },
      candidates: CANDIDATES,
      radius: 50,
    });
    expect(result?.snapTarget).toEqual({ nodeId: "n1", portId: "in" });
    expect(result?.magnetisedCursor.x).toBeLessThan(105);
  });

  it("ignores incompatible ports even when closer", () => {
    const result = resolveSnapTarget({
      cursorWorld: { x: 110, y: 106 },
      candidates: CANDIDATES,
      radius: 50,
    });
    expect(result?.snapTarget).toEqual({ nodeId: "n1", portId: "in" });
  });

  it("returns null when nothing is within radius", () => {
    const result = resolveSnapTarget({
      cursorWorld: { x: 0, y: 0 },
      candidates: CANDIDATES,
      radius: 50,
    });
    expect(result).toBeNull();
  });

  it("confidence scales from 0 at the radius edge to 1 at center", () => {
    const edge = resolveSnapTarget({
      cursorWorld: { x: 140, y: 100 },
      candidates: CANDIDATES,
      radius: 40,
    });
    expect(edge?.confidence).toBeCloseTo(0, 2);
    const center = resolveSnapTarget({
      cursorWorld: { x: 100, y: 100 },
      candidates: CANDIDATES,
      radius: 40,
    });
    expect(center?.confidence).toBeCloseTo(1, 2);
  });
});
