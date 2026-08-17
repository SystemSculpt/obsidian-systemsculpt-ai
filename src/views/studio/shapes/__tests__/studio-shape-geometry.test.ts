import type { StudioShapeInstance, StudioShapeKind } from "../../../../studio/types";
import { STUDIO_SHAPE_KINDS } from "../../../../studio/StudioShapes";
import {
  buildStudioShapeArrowPath,
  buildStudioShapeArrowPreviewPath,
  studioShapeBorderPoint,
} from "../StudioShapeGeometry";
import { buildStudioShapeOutline } from "../StudioShapeOutline";

function shape(
  kind: StudioShapeKind,
  x: number,
  y: number,
  width = 100,
  height = 100
): StudioShapeInstance {
  return { id: `${kind}-${x}-${y}`, shape: kind, position: { x, y }, size: { width, height }, label: "" };
}

function lineEnd(path: string): { x: number; y: number } {
  const numbers = path.match(/-?\d+\.\d+/g) ?? [];
  return {
    x: Number(numbers[numbers.length - 2]),
    y: Number(numbers[numbers.length - 1]),
  };
}

describe("studio shape outlines", () => {
  it("gives every kind a drawable body and a closed polygon", () => {
    for (const kind of STUDIO_SHAPE_KINDS) {
      const outline = buildStudioShapeOutline(kind, { width: 160, height: 100 });
      expect(outline.body.startsWith("M ")).toBe(true);
      expect(outline.polygon.length).toBeGreaterThanOrEqual(4);
      for (const point of outline.polygon) {
        expect(point.x).toBeGreaterThanOrEqual(-0.01);
        expect(point.x).toBeLessThanOrEqual(160.01);
        expect(point.y).toBeGreaterThanOrEqual(-0.01);
        expect(point.y).toBeLessThanOrEqual(100.01);
      }
    }
  });

  it("draws a diamond as its four mid-edge points", () => {
    expect(buildStudioShapeOutline("diamond", { width: 200, height: 100 }).polygon).toEqual([
      { x: 100, y: 0 },
      { x: 200, y: 50 },
      { x: 100, y: 100 },
      { x: 0, y: 50 },
    ]);
  });

  it("cuts the note corner and keeps the fold as a stroke-only detail", () => {
    const outline = buildStudioShapeOutline("note", { width: 200, height: 200 });

    expect(outline.polygon).toHaveLength(5);
    // The corner is gone from the body, so the fold line has something to fold.
    expect(outline.polygon).not.toContainEqual({ x: 200, y: 0 });
    expect(outline.detail).not.toBe("");
  });

  it("keeps the cylinder rim out of the filled body", () => {
    const outline = buildStudioShapeOutline("cylinder", { width: 120, height: 160 });

    expect(outline.detail).not.toBe("");
    expect(outline.body).not.toBe(outline.detail);
  });

  it("only kinds with an interior line carry a detail path", () => {
    for (const kind of ["rectangle", "ellipse", "diamond", "pill", "hexagon"] as const) {
      expect(buildStudioShapeOutline(kind, { width: 120, height: 80 }).detail).toBe("");
    }
  });
});

describe("studio shape arrows", () => {
  it("runs straight between aligned shapes, stopping short of the target border", () => {
    const path = buildStudioShapeArrowPath(
      shape("rectangle", 100, 100),
      shape("rectangle", 400, 100)
    );

    // Right border of the source to 3px before the left border of the target.
    expect(path.line).toBe("M 200.00 150.00 L 397.00 150.00");
    expect(path.head).toContain("Z");
  });

  it("snaps a near-aligned pair onto one exact line instead of a visible kink", () => {
    const path = buildStudioShapeArrowPath(
      shape("rectangle", 100, 100),
      shape("rectangle", 400, 106)
    );

    expect(path.start.y).toBeCloseTo(path.end.y, 5);
    expect(path.line).not.toContain("C");
  });

  it("curves a real diagonal and still leaves and enters on one axis", () => {
    const path = buildStudioShapeArrowPath(
      shape("rectangle", 100, 100),
      shape("rectangle", 500, 400)
    );

    expect(path.line).toContain("C");
    // Dominant axis is horizontal: the arrow leaves the right side and enters
    // the left side, both at the shapes' own mid-height.
    expect(path.start).toEqual({ x: 200, y: 150 });
    expect(path.end.y).toBeCloseTo(450, 5);
    expect(path.end.x).toBeCloseTo(497, 5);
  });

  it("switches to the top and bottom sides when the vertical gap dominates", () => {
    const path = buildStudioShapeArrowPath(
      shape("rectangle", 100, 100),
      shape("rectangle", 140, 500)
    );

    expect(path.start).toEqual({ x: 150, y: 200 });
    expect(path.end.y).toBeCloseTo(497, 5);
  });

  it("fans arrows that share the same pair of shapes", () => {
    const from = shape("rectangle", 100, 100);
    const to = shape("rectangle", 400, 100);

    const first = buildStudioShapeArrowPath(from, to, { index: 0, count: 2 });
    const second = buildStudioShapeArrowPath(to, from, { index: 1, count: 2 });

    expect(first.start.y).toBeCloseTo(142, 5);
    expect(second.start.y).toBeCloseTo(158, 5);
    expect(first.start.y).not.toBeCloseTo(second.start.y, 1);
  });

  it("anchors on each kind's own outline, not on its bounding box", () => {
    const diamond = shape("diamond", 0, 0);
    const target = shape("rectangle", 400, 0);

    const path = buildStudioShapeArrowPath(diamond, target);

    // The right vertex of the diamond, which a bounding box would miss by 50px.
    expect(path.start).toEqual({ x: 100, y: 50 });
    expect(studioShapeBorderPoint(diamond, { x: 50, y: -200 })).toEqual({ x: 50, y: 0 });
  });

  it("ends the in-flight preview exactly under the cursor", () => {
    const preview = buildStudioShapeArrowPreviewPath(shape("ellipse", 0, 0), { x: 300, y: 50 });

    expect(preview.start.x).toBeCloseTo(100, 5);
    expect(preview.start.y).toBeCloseTo(50, 5);
    expect(lineEnd(preview.line)).toEqual({ x: 300, y: 50 });
  });
});
