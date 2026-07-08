import {
  resolveStudioCanvasDelta,
  STUDIO_GRAPH_NODE_MIN_WIDTH,
  STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
} from "../../../../studio/StudioNodeGeometry";
import {
  computeStudioSelectionBounds,
  resolveStudioSelectionGroupResize,
  resolveStudioSelectionResizePatches,
  STUDIO_SELECTION_MIN_GROUP_SCALE,
  type StudioSelectionResizeNodeSnapshot,
} from "../StudioGraphSelectionTransform";

/**
 * Pure group-transform math for the multi-select resize frame:
 * group-bounds derivation, edge/corner anchoring, per-mode node levers,
 * relative-layout preservation, and clamp interaction.
 */

function snapshot(
  overrides: Partial<StudioSelectionResizeNodeSnapshot> &
    Pick<StudioSelectionResizeNodeSnapshot, "nodeId" | "rect">
): StudioSelectionResizeNodeSnapshot {
  return {
    kind: "studio.http_request",
    fontSize: 16,
    ...overrides,
  };
}

function patchFor(
  result: ReturnType<typeof resolveStudioSelectionResizePatches>,
  nodeId: string
) {
  return result.patches.find((entry) => entry.nodeId === nodeId)?.patch;
}

describe("computeStudioSelectionBounds", () => {
  it("derives the min/max envelope over node rects", () => {
    const bounds = computeStudioSelectionBounds([
      { left: 100, top: 100, width: 400, height: 400 },
      { left: 700, top: 300, width: 300, height: 200 },
    ]);
    expect(bounds).toEqual({ left: 100, top: 100, width: 900, height: 400 });
  });

  it("returns null for an empty selection", () => {
    expect(computeStudioSelectionBounds([])).toBeNull();
  });

  it("ignores rects with non-finite coordinates", () => {
    const bounds = computeStudioSelectionBounds([
      { left: Number.NaN, top: 0, width: 100, height: 100 },
      { left: 10, top: 20, width: 30, height: 40 },
    ]);
    expect(bounds).toEqual({ left: 10, top: 20, width: 30, height: 40 });
  });
});

describe("resolveStudioSelectionGroupResize", () => {
  const startBounds = { left: 100, top: 100, width: 900, height: 400 };

  it("grows from the anchored left edge on an east drag", () => {
    const result = resolveStudioSelectionGroupResize({
      zone: "e",
      deltaX: 90,
      deltaY: 999,
      startBounds,
    });
    expect(result.bounds).toEqual({ left: 100, top: 100, width: 990, height: 400 });
    expect(result.scaleX).toBeCloseTo(1.1);
    expect(result.scaleY).toBe(1);
  });

  it("anchors the right edge on a west drag", () => {
    const result = resolveStudioSelectionGroupResize({
      zone: "w",
      deltaX: -90,
      deltaY: 0,
      startBounds,
    });
    expect(result.bounds).toEqual({ left: 10, top: 100, width: 990, height: 400 });
    expect(result.scaleX).toBeCloseTo(1.1);
  });

  it("anchors the bottom edge on a north drag", () => {
    const result = resolveStudioSelectionGroupResize({
      zone: "n",
      deltaX: 0,
      deltaY: -100,
      startBounds,
    });
    expect(result.bounds).toEqual({ left: 100, top: 0, width: 900, height: 500 });
    expect(result.scaleY).toBeCloseTo(1.25);
  });

  it("scales both axes on a corner drag", () => {
    const result = resolveStudioSelectionGroupResize({
      zone: "se",
      deltaX: 90,
      deltaY: 100,
      startBounds,
    });
    expect(result.bounds).toEqual({ left: 100, top: 100, width: 990, height: 500 });
    expect(result.scaleX).toBeCloseTo(1.1);
    expect(result.scaleY).toBeCloseTo(1.25);
  });

  it("floors the group scale so bounds can never invert", () => {
    const result = resolveStudioSelectionGroupResize({
      zone: "e",
      deltaX: -10000,
      deltaY: 0,
      startBounds,
    });
    expect(result.scaleX).toBeCloseTo(STUDIO_SELECTION_MIN_GROUP_SCALE);
    expect(result.bounds.width).toBeCloseTo(900 * STUDIO_SELECTION_MIN_GROUP_SCALE);
    expect(result.bounds.width).toBeGreaterThan(0);
  });
});

describe("resolveStudioSelectionResizePatches", () => {
  describe("box + min-height selection", () => {
    const nodes: StudioSelectionResizeNodeSnapshot[] = [
      snapshot({
        nodeId: "terminal",
        kind: "studio.terminal",
        rect: { left: 100, top: 100, width: 400, height: 400 },
      }),
      snapshot({
        nodeId: "generic",
        rect: { left: 700, top: 300, width: 300, height: 200 },
      }),
    ];
    const startBounds = { left: 100, top: 100, width: 900, height: 400 };

    it("scales width and interpolates x positions on an east drag", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "e",
        deltaX: 90,
        deltaY: 0,
        startBounds,
        nodes,
      });

      expect(result.bounds).toEqual({ left: 100, top: 100, width: 990, height: 400 });
      expect(patchFor(result, "terminal")).toEqual({
        size: { width: 440 },
        position: { x: 100, y: 100 },
      });
      expect(patchFor(result, "generic")).toEqual({
        size: { width: 330 },
        position: { x: 760, y: 300 },
      });
    });

    it("keeps the right edge anchored on a west drag", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "w",
        deltaX: -90,
        deltaY: 0,
        startBounds,
        nodes,
      });

      expect(result.bounds).toEqual({ left: 10, top: 100, width: 990, height: 400 });
      // Raw interpolated x is 10 — the shared 24px canvas floor applies.
      expect(patchFor(result, "terminal")).toEqual({
        size: { width: 440 },
        position: { x: 24, y: 100 },
      });
      expect(patchFor(result, "generic")).toEqual({
        size: { width: 330 },
        position: { x: 670, y: 300 },
      });
    });

    it("scales heights and interpolates y positions on a north drag", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "n",
        deltaX: 0,
        deltaY: -100,
        startBounds,
        nodes,
      });

      expect(result.bounds).toEqual({ left: 100, top: 0, width: 900, height: 500 });
      expect(patchFor(result, "terminal")).toEqual({
        size: { height: 500 },
        position: { x: 100, y: 24 },
      });
      expect(patchFor(result, "generic")).toEqual({
        size: { height: 250 },
        position: { x: 700, y: 250 },
      });
    });

    it("preserves relative layout on a corner drag driven by zoomed pointer travel", () => {
      // zoom 2: pointer travel (180, 200) is canvas delta (90, 100).
      const delta = resolveStudioCanvasDelta({
        startClientX: 0,
        startClientY: 0,
        clientX: 180,
        clientY: 200,
        zoom: 2,
      });
      const result = resolveStudioSelectionResizePatches({
        zone: "se",
        deltaX: delta.deltaX,
        deltaY: delta.deltaY,
        startBounds,
        nodes,
      });

      expect(result.bounds).toEqual({ left: 100, top: 100, width: 990, height: 500 });
      expect(patchFor(result, "terminal")).toEqual({
        size: { width: 440, height: 500 },
        position: { x: 100, y: 100 },
      });
      // Normalized offsets preserved: (700-100)/900 → ×990, (300-100)/400 → ×500.
      expect(patchFor(result, "generic")).toEqual({
        size: { width: 330, height: 250 },
        position: { x: 760, y: 350 },
      });
    });
  });

  describe("text semantics", () => {
    const nodes: StudioSelectionResizeNodeSnapshot[] = [
      snapshot({
        nodeId: "text",
        kind: "studio.text",
        fontSize: 16,
        rect: { left: 100, top: 100, width: 300, height: 200 },
      }),
      snapshot({
        nodeId: "generic",
        rect: { left: 500, top: 100, width: 300, height: 400 },
      }),
    ];
    const startBounds = { left: 100, top: 100, width: 700, height: 400 };

    it("scales wrap width by the x-factor and fontSize by the y-factor on a corner drag", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "se",
        deltaX: 350,
        deltaY: 100,
        startBounds,
        nodes,
      });

      expect(patchFor(result, "text")).toEqual({
        size: { width: 450 },
        fontSize: 20,
        position: { x: 100, y: 100 },
      });
    });

    it("scales fontSize by the y-factor on a pure vertical drag", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "s",
        deltaX: 0,
        deltaY: 100,
        startBounds,
        nodes,
      });

      expect(patchFor(result, "text")).toEqual({
        fontSize: 20,
        position: { x: 100, y: 100 },
      });
    });

    it("changes wrap width only on a pure horizontal drag", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "e",
        deltaX: 350,
        deltaY: 0,
        startBounds,
        nodes,
      });

      expect(patchFor(result, "text")).toEqual({
        size: { width: 450 },
        position: { x: 100, y: 100 },
      });
    });

    it("scales fontSize unclamped well past the old 48px ceiling", () => {
      // sy = (400 + 1000) / 400 = 3.5 → fontSize 16 × 3.5 = 56, no clamp.
      const result = resolveStudioSelectionResizePatches({
        zone: "s",
        deltaX: 0,
        deltaY: 1000,
        startBounds,
        nodes,
      });

      expect(patchFor(result, "text")?.fontSize).toBe(56);
      // The sibling's min-height floor scales with the raw group factor.
      expect(patchFor(result, "generic")?.size?.height).toBe(1400);
    });

    it("clamps each node to its own module bounds while positions keep interpolating", () => {
      // sy = (400 + 16000) / 400 = 41 → raw fontSize 656 clamps to 512;
      // the sibling's raw floor 16400 clamps to its own 2000 max.
      const result = resolveStudioSelectionResizePatches({
        zone: "s",
        deltaX: 0,
        deltaY: 16000,
        startBounds,
        nodes,
      });

      expect(patchFor(result, "text")?.fontSize).toBe(STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE);
      expect(patchFor(result, "generic")?.size?.height).toBe(2000);
    });
  });

  describe("aspect-width semantics", () => {
    const nodes: StudioSelectionResizeNodeSnapshot[] = [
      snapshot({
        nodeId: "media",
        kind: "studio.media_ingest",
        hasAspectMediaContent: true,
        rect: { left: 100, top: 100, width: 300, height: 150 },
      }),
      snapshot({
        nodeId: "generic",
        rect: { left: 100, top: 400, width: 300, height: 300 },
      }),
    ];
    const startBounds = { left: 100, top: 100, width: 300, height: 600 };

    it("routes a pure vertical drag through the y-factor onto the width lever", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "s",
        deltaX: 0,
        deltaY: 150,
        startBounds,
        nodes,
      });

      expect(patchFor(result, "media")).toEqual({
        size: { width: 375 },
        position: { x: 100, y: 100 },
      });
      expect(patchFor(result, "generic")).toEqual({
        size: { height: 375 },
        position: { x: 100, y: 475 },
      });
    });

    it("uses the x-factor on corner drags", () => {
      const result = resolveStudioSelectionResizePatches({
        zone: "se",
        deltaX: 150,
        deltaY: 600,
        startBounds,
        nodes,
      });

      // sx 1.5 vs sy 2.0 — aspect media follows the x-factor.
      expect(patchFor(result, "media")?.size).toEqual({ width: 450 });
      expect(patchFor(result, "media")?.size?.height).toBeUndefined();
    });
  });

  describe("clamp and lock interaction", () => {
    it("stops clamped nodes shrinking while their positions keep interpolating", () => {
      const nodes: StudioSelectionResizeNodeSnapshot[] = [
        snapshot({
          nodeId: "small",
          rect: { left: 100, top: 100, width: 240, height: 200 },
        }),
        snapshot({
          nodeId: "wide",
          rect: { left: 600, top: 100, width: 300, height: 200 },
        }),
      ];
      const result = resolveStudioSelectionResizePatches({
        zone: "e",
        deltaX: -400,
        deltaY: 0,
        startBounds: { left: 100, top: 100, width: 800, height: 200 },
        nodes,
      });

      // Raw widths (120 / 150) clamp to the per-node minimum...
      expect(patchFor(result, "small")?.size?.width).toBe(STUDIO_GRAPH_NODE_MIN_WIDTH);
      expect(patchFor(result, "wide")?.size?.width).toBe(STUDIO_GRAPH_NODE_MIN_WIDTH);
      // ...but positions still interpolate from the raw group transform.
      expect(patchFor(result, "small")?.position).toEqual({ x: 100, y: 100 });
      expect(patchFor(result, "wide")?.position).toEqual({ x: 350, y: 100 });
    });

    it("floors interpolated positions at the canvas minimum", () => {
      const nodes: StudioSelectionResizeNodeSnapshot[] = [
        snapshot({ nodeId: "a", rect: { left: 30, top: 40, width: 200, height: 100 } }),
        snapshot({ nodeId: "b", rect: { left: 330, top: 40, width: 200, height: 100 } }),
      ];
      const result = resolveStudioSelectionResizePatches({
        zone: "w",
        deltaX: -100,
        deltaY: 0,
        startBounds: { left: 30, top: 40, width: 500, height: 100 },
        nodes,
      });

      expect(patchFor(result, "a")?.position?.x).toBe(24);
    });

    it("excludes interaction-locked nodes from patches", () => {
      const nodes: StudioSelectionResizeNodeSnapshot[] = [
        snapshot({
          nodeId: "locked",
          interactionLocked: true,
          rect: { left: 100, top: 100, width: 300, height: 200 },
        }),
        snapshot({
          nodeId: "free",
          rect: { left: 500, top: 100, width: 300, height: 200 },
        }),
      ];
      const result = resolveStudioSelectionResizePatches({
        zone: "e",
        deltaX: 70,
        deltaY: 0,
        startBounds: { left: 100, top: 100, width: 700, height: 200 },
        nodes,
      });

      expect(result.patches.map((entry) => entry.nodeId)).toEqual(["free"]);
    });
  });
});
