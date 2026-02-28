import {
  normalizeStudioMenuScale,
  resolveStudioAnchoredMenuPosition,
} from "../StudioFloatingMenuUtils";
import {
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "../StudioGraphInteractionTypes";

describe("StudioFloatingMenuUtils", () => {
  it("normalizes non-finite menu scale to 1", () => {
    expect(normalizeStudioMenuScale(Number.NaN)).toBe(1);
    expect(normalizeStudioMenuScale(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("clamps menu scale to graph zoom limits", () => {
    expect(normalizeStudioMenuScale(STUDIO_GRAPH_MIN_ZOOM - 0.5)).toBe(STUDIO_GRAPH_MIN_ZOOM);
    expect(normalizeStudioMenuScale(STUDIO_GRAPH_MAX_ZOOM + 0.5)).toBe(STUDIO_GRAPH_MAX_ZOOM);
  });

  it("clamps anchored position to viewport minimum bounds", () => {
    const viewport = {
      scrollLeft: 100,
      scrollTop: 200,
      clientWidth: 320,
      clientHeight: 180,
    } as unknown as HTMLElement;

    const positioned = resolveStudioAnchoredMenuPosition({
      viewportEl: viewport,
      anchorX: 0,
      anchorY: 0,
      visualWidth: 160,
      visualHeight: 100,
    });

    expect(positioned).toEqual({ x: 108, y: 208 });
  });

  it("clamps anchored position to viewport maximum bounds", () => {
    const viewport = {
      scrollLeft: 100,
      scrollTop: 200,
      clientWidth: 320,
      clientHeight: 180,
    } as unknown as HTMLElement;

    const positioned = resolveStudioAnchoredMenuPosition({
      viewportEl: viewport,
      anchorX: 800,
      anchorY: 700,
      visualWidth: 160,
      visualHeight: 100,
    });

    expect(positioned).toEqual({ x: 252, y: 272 });
  });
});
