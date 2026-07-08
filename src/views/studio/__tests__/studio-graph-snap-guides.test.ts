import {
  resolveStudioGraphSnap,
  STUDIO_SNAP_THRESHOLD_PX,
  type StudioSnapRect,
} from "../graph-v3/StudioGraphSnapGuides";

const THRESHOLD = STUDIO_SNAP_THRESHOLD_PX;

function rect(left: number, top: number, width: number, height: number): StudioSnapRect {
  return { left, top, right: left + width, bottom: top + height };
}

describe("resolveStudioGraphSnap alignment", () => {
  it("snaps a left edge to a nearby static left edge and emits a vertical guide", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(103, 300, 100, 80),
      others: [rect(100, 100, 120, 90)],
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(-3);
    expect(result.deltaY).toBe(0);
    expect(result.guides).toEqual([
      // Spans from the static's top to the snapped moving rect's bottom.
      { axis: "x", position: 100, start: 100, end: 380 },
    ]);
  });

  it("snaps horizontal centers", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(146, 300, 100, 80), // centerX = 196
      others: [rect(100, 100, 200, 90)], // centerX = 200
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(4);
    expect(result.guides).toEqual([{ axis: "x", position: 200, start: 100, end: 380 }]);
  });

  it("snaps both axes independently", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(103, 195, 100, 80),
      others: [rect(100, 200, 100, 80)],
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(-3);
    expect(result.deltaY).toBe(5);
    expect(result.guides).toHaveLength(2);
  });

  it("does not snap outside the threshold", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(120, 300, 100, 80),
      others: [rect(100, 100, 100, 90)],
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(0);
    expect(result.deltaY).toBe(0);
    expect(result.guides).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it("prefers the closest alignment candidate", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(103, 300, 100, 80),
      others: [rect(106, 100, 100, 90), rect(97, 500, 100, 90)],
      threshold: THRESHOLD,
    });

    // 106 - 103 = +3 beats 97 - 103 = -6.
    expect(result.deltaX).toBe(3);
    expect(result.guides[0]?.position).toBe(106);
  });

  it("extends the guide span across every static aligned at the snapped position", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(102, 300, 100, 80),
      others: [rect(100, 100, 100, 50), rect(100, 600, 100, 50)],
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(-2);
    expect(result.guides).toEqual([{ axis: "x", position: 100, start: 100, end: 650 }]);
  });
});

describe("resolveStudioGraphSnap spacing", () => {
  it("snaps to the midpoint between two flanking neighbors with equal-gap badges", () => {
    // Neighbors: [0..100] and [400..500]; moving 100 wide → equal gap = 100.
    const result = resolveStudioGraphSnap({
      moving: rect(195, 10, 100, 80),
      others: [rect(0, 0, 100, 100), rect(400, 0, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(5);
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps[0]).toMatchObject({ axis: "x", start: 100, end: 200, label: "100" });
    expect(result.gaps[1]).toMatchObject({ axis: "x", start: 300, end: 400, label: "100" });
  });

  it("repeats an existing neighbor-pair gap when dragging beyond a row", () => {
    // Statics [0..100] and [150..250] with a 50px gap; moving lands at 300.
    const result = resolveStudioGraphSnap({
      moving: rect(296, 10, 100, 80),
      others: [rect(0, 0, 100, 100), rect(150, 0, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(4);
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps.map((gap) => gap.label)).toEqual(["50", "50"]);
    expect(result.gaps[1]).toMatchObject({ axis: "x", start: 250, end: 300 });
  });

  it("ignores statics without perpendicular overlap for spacing", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(195, 500, 100, 80),
      others: [rect(0, 0, 100, 100), rect(400, 0, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.deltaX).toBe(0);
    expect(result.gaps).toEqual([]);
  });

  it("snaps vertical spacing with y-axis badges", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(10, 195, 80, 100),
      others: [rect(0, 0, 100, 100), rect(0, 400, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.deltaY).toBe(5);
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps[0]).toMatchObject({ axis: "y", start: 100, end: 200, label: "100" });
  });
});

describe("resolveStudioGraphSnap guardrails", () => {
  it("returns identity when there are no other rects", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(0, 0, 100, 100),
      others: [],
      threshold: THRESHOLD,
    });

    expect(result).toEqual({ deltaX: 0, deltaY: 0, guides: [], gaps: [] });
  });

  it("returns identity for a non-positive threshold", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(103, 300, 100, 80),
      others: [rect(100, 100, 100, 90)],
      threshold: 0,
    });

    expect(result).toEqual({ deltaX: 0, deltaY: 0, guides: [], gaps: [] });
  });

  it("ignores non-finite static rects", () => {
    const result = resolveStudioGraphSnap({
      moving: rect(103, 300, 100, 80),
      others: [{ left: NaN, top: 0, right: 100, bottom: 100 }],
      threshold: THRESHOLD,
    });

    expect(result).toEqual({ deltaX: 0, deltaY: 0, guides: [], gaps: [] });
  });
});
