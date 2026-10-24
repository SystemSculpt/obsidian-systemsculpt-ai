/**
 * @jest-environment jsdom
 */

import { statusBarBottomOverlap } from "../desktopStatusBar";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("statusBarBottomOverlap", () => {
  afterEach(() => document.body.empty());

  function setup(barRect: DOMRect | null, position = "fixed") {
    const element = document.body.createDiv();
    element.getBoundingClientRect = () => rect(700, 500, 320, 300);
    if (barRect) {
      const bar = document.body.createDiv({ cls: "status-bar" });
      bar.style.position = position;
      bar.getBoundingClientRect = () => barRect;
    }
    return element;
  }

  it("reserves the part of the element the floating status bar covers", () => {
    expect(statusBarBottomOverlap(setup(rect(660, 773, 364, 27)))).toBe(27);
  });

  it("ignores a hidden, docked, or distant status bar", () => {
    expect(statusBarBottomOverlap(setup(null))).toBe(0);
    expect(statusBarBottomOverlap(setup(rect(0, 0, 0, 0)))).toBe(0);
    expect(statusBarBottomOverlap(setup(rect(660, 773, 364, 27), "static"))).toBe(0);
    // A chat in the left half of the window sits beside the bar.
    expect(statusBarBottomOverlap(setup(rect(1100, 773, 300, 27)))).toBe(0);
  });
});
