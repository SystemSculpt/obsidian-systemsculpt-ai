import { calculateOverlapInset } from "../OverlapInsetService";

describe("calculateOverlapInset", () => {
  it("returns 0 when there is no overlap", () => {
    const containerRect = { bottom: 500 } as DOMRect;
    const anchorRect = { top: 700 } as DOMRect;
    expect(calculateOverlapInset(containerRect, anchorRect)).toBe(0);
  });

  it("returns the rounded overlap when overlapping", () => {
    const containerRect = { bottom: 954.4 } as DOMRect;
    const anchorRect = { top: 927.1 } as DOMRect;
    expect(calculateOverlapInset(containerRect, anchorRect)).toBe(27);
  });
});
