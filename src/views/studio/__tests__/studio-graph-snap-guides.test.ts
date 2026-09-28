import {
  resolveStudioResizeGuides,
  resolveStudioMovementGuides,
  STUDIO_GUIDE_THRESHOLD_PX,
  type StudioGuideRect,
} from "../canvas/StudioGraphAlignmentGuides";

const THRESHOLD = STUDIO_GUIDE_THRESHOLD_PX;

function rect(left: number, top: number, width: number, height: number): StudioGuideRect {
  return { left, top, right: left + width, bottom: top + height };
}

describe("resolveStudioMovementGuides alignment", () => {
  it("guides a left edge to a nearby static left edge and emits a vertical guide", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(103, 300, 100, 80),
      others: [rect(100, 100, 120, 90)],
      threshold: THRESHOLD,
    });

    expect(result.guides).toMatchObject([
      // Spans from the static's top to the actual moving rect's bottom.
      { axis: "x", position: 100, start: 100, end: 380 },
    ]);
  });

  it("guides horizontal centers", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(146, 300, 100, 80), // centerX = 196
      others: [rect(100, 100, 200, 90)], // centerX = 200
      threshold: THRESHOLD,
    });

    expect(result.guides).toMatchObject([{ axis: "x", position: 200, start: 100, end: 380 }]);
  });

  it("guides both axes independently", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(103, 195, 100, 80),
      others: [rect(100, 200, 100, 80)],
      threshold: THRESHOLD,
    });

    expect(result.guides).toHaveLength(2);
  });

  it("does not snap outside the threshold", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(120, 300, 100, 80),
      others: [rect(100, 100, 100, 90)],
      threshold: THRESHOLD,
    });

    expect(result.guides).toMatchObject([]);
    expect(result.gaps).toEqual([expect.objectContaining({ axis: "y", label: "110 px" })]);
  });

  it("prefers the closest alignment candidate", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(103, 300, 100, 80),
      others: [rect(106, 100, 100, 90), rect(97, 500, 100, 90)],
      threshold: THRESHOLD,
    });

    // 106 - 103 = +3 beats 97 - 103 = -6.
    expect(result.guides[0]?.position).toBe(106);
  });

  it("extends the guide span across every static aligned at the actual position", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(102, 300, 100, 80),
      others: [rect(100, 100, 100, 50), rect(100, 600, 100, 50)],
      threshold: THRESHOLD,
    });

    expect(result.guides).toMatchObject([{ axis: "x", position: 100, start: 100, end: 650 }]);
  });
});

describe("resolveStudioMovementGuides spacing", () => {
  it("guides between two flanking neighbors with actual distance badges", () => {
    // Neighbors: [0..100] and [400..500]; moving 100 wide → equal gap = 100.
    const result = resolveStudioMovementGuides({
      moving: rect(195, 10, 100, 80),
      others: [rect(0, 0, 100, 100), rect(400, 0, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.gaps).toHaveLength(2);
    expect(result.gaps[0]).toMatchObject({ axis: "x", start: 100, end: 195, label: "95 px" });
    expect(result.gaps[1]).toMatchObject({ axis: "x", start: 295, end: 400, label: "105 px" });
  });

  it("measures only the nearest neighbor when dragging beyond a row", () => {
    // Statics [0..100] and [150..250] with a 50px gap; moving lands at 300.
    const result = resolveStudioMovementGuides({
      moving: rect(296, 10, 100, 80),
      others: [rect(0, 0, 100, 100), rect(150, 0, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ axis: "x", start: 250, end: 296, label: "46 px" });
  });

  it("ignores statics without perpendicular overlap for spacing", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(195, 500, 100, 80),
      others: [rect(0, 0, 100, 100), rect(400, 0, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.gaps).toEqual([]);
  });

  it("guides vertical spacing with y-axis badges", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(10, 195, 80, 100),
      others: [rect(0, 0, 100, 100), rect(0, 400, 100, 100)],
      threshold: THRESHOLD,
    });

    expect(result.gaps).toHaveLength(2);
    expect(result.gaps[0]).toMatchObject({ axis: "y", start: 100, end: 195, label: "95 px" });
  });
});

describe("resolveStudioMovementGuides guardrails", () => {
  it("returns identity when there are no other rects", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(0, 0, 100, 100),
      others: [],
      threshold: THRESHOLD,
    });

    expect(result).toEqual({ guides: [], gaps: [] });
  });

  it("returns identity for a non-positive threshold", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(103, 300, 100, 80),
      others: [rect(100, 100, 100, 90)],
      threshold: 0,
    });

    expect(result).toEqual({ guides: [], gaps: [] });
  });

  it("ignores non-finite static rects", () => {
    const result = resolveStudioMovementGuides({
      moving: rect(103, 300, 100, 80),
      others: [{ left: NaN, top: 0, right: 100, bottom: 100 }],
      threshold: THRESHOLD,
    });

    expect(result).toEqual({ guides: [], gaps: [] });
  });
});

describe("resolveStudioResizeGuides", () => {
  it("guides the dragged east edge to a static anchor with a guide and no spacing gaps", () => {
    const result = resolveStudioResizeGuides({
      moving: rect(300, 300, 97, 80), // right edge at 397
      others: [rect(400, 100, 100, 90)], // left anchor at 400
      threshold: THRESHOLD,
      edges: { x: 1, y: 0 },
    });

    // Guide spans from the static's top to the actual moving rect's bottom.
    expect(result.guides).toMatchObject([{ axis: "x", position: 400, start: 100, end: 380 }]);
    // Spacing gaps are a move-drag concept; resize never emits them.
    expect(result.gaps).toEqual([]);
  });

  it("never guides off the anchored edge — only dragged edges are candidates", () => {
    // The static's left anchor (297) sits 3px from the moving LEFT edge (300),
    // but an east drag anchors the left edge, so nothing may snap.
    const result = resolveStudioResizeGuides({
      moving: rect(300, 300, 100, 80),
      others: [rect(297, 500, 50, 80)],
      threshold: THRESHOLD,
      edges: { x: 1, y: 0 },
    });

    expect(result).toEqual({ guides: [], gaps: [] });
  });

  it("guides both axes independently on a corner drag", () => {
    const result = resolveStudioResizeGuides({
      moving: rect(100, 100, 103, 77), // right 203, bottom 177
      others: [rect(200, 300, 80, 80), rect(400, 180, 80, 100)],
      threshold: THRESHOLD,
      edges: { x: 1, y: 1 },
    });

    expect(result.guides).toHaveLength(2);
    expect(result.gaps).toEqual([]);
  });

  it("returns identity when no edge is being dragged", () => {
    const result = resolveStudioResizeGuides({
      moving: rect(100, 100, 100, 90),
      others: [rect(100, 300, 100, 90)],
      threshold: THRESHOLD,
      edges: { x: 0, y: 0 },
    });

    expect(result).toEqual({ guides: [], gaps: [] });
  });

  it("returns identity for a non-positive threshold", () => {
    const result = resolveStudioResizeGuides({
      moving: rect(300, 300, 97, 80),
      others: [rect(400, 100, 100, 90)],
      threshold: 0,
      edges: { x: 1, y: 0 },
    });

    expect(result).toEqual({ guides: [], gaps: [] });
  });
});
