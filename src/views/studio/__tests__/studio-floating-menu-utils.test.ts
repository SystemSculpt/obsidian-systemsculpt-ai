import { resolveStudioAnchoredMenuPosition } from "../StudioFloatingMenuUtils";

describe("StudioFloatingMenuUtils", () => {
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
