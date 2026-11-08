/** @jest-environment jsdom */
import { renderStudioGraphAlignmentGuidesLayer } from "../StudioGraphAlignmentGuidesOverlay";
import type { StudioGuideRect } from "../StudioGraphAlignmentGuides";

function intersects(a: StudioGuideRect, b: StudioGuideRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function badgeRect(element: HTMLElement): StudioGuideRect {
  const left = Number.parseFloat(element.style.left), top = Number.parseFloat(element.style.top);
  return { left, top, right: left + 40, bottom: top + 18 };
}

beforeEach(() => {
  jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains("ss-studio-distance-badge")) throw new Error("Measured a peer instead of the badge");
    return 40;
  });
  jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains("ss-studio-distance-badge")) throw new Error("Measured a peer instead of the badge");
    return 18;
  });
});
afterEach(() => jest.restoreAllMocks());

it.each([0.8, 1, 2])("leaves transparent card text clear of smart guides at zoom %s", (zoom) => {
  const layer = document.createElement("div");
  const card = { left: 0, top: 80, right: 100, bottom: 100 };
  renderStudioGraphAlignmentGuidesLayer(layer, {
    guides: [{ axis: "x", position: 50, start: 0, end: 200, offset: 3, labelCross: 100 }], gaps: [],
  }, zoom, { x: 10, y: 20 }, [new Map([["text", card]])]);
  const lines = Array.from(layer.querySelectorAll<HTMLElement>(".ss-studio-alignment-guide"));
  expect(lines).toHaveLength(1);
  expect(Number.parseFloat(lines[0].style.height)).toBe(200 * zoom);
  const stops = [...lines[0].style.maskImage.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1]));
  expect(stops.some(stop => Math.abs(stop - (80 * zoom - 2)) < 0.001)).toBe(true);
  expect(stops.some(stop => Math.abs(stop - (100 * zoom + 2)) < 0.001)).toBe(true);
  expect(lines.every(line => line.classList.contains("is-near"))).toBe(true);
  expect(layer.textContent).toBe("3 px to align");
});

it("keeps one guide element across a thousand cached occluders", () => {
  const layer = document.createElement("div");
  const cards = Array.from({ length: 1000 }, (_, index) => ({ left: 0, right: 100, top: index * 100 + 20, bottom: index * 100 + 40 }));
  renderStudioGraphAlignmentGuidesLayer(layer, {
    guides: [{ axis: "x", position: 50, start: 0, end: 100000 }], gaps: [],
  }, 1, { x: 0, y: 0 }, [cards]);
  expect(layer.querySelectorAll(".ss-studio-alignment-guide")).toHaveLength(1);
  expect(layer.querySelector<HTMLElement>(".ss-studio-alignment-guide")?.style.maskImage).toContain("99942px");
});

it.each([0.8, 1, 2])("places vertical gap badges clear of connector labels at zoom %s", (zoom) => {
  const layer = document.createElement("div");
  const label = { left: 709.3, top: 313, right: 755.7, bottom: 327 };
  const origin = { x: 50, y: -40 };
  renderStudioGraphAlignmentGuidesLayer(layer, { guides: [], gaps: [
    { axis: "y", start: 300, end: 340, cross: 732.5, label: "40 px" },
    { axis: "y", start: 300, end: 340, cross: 732.5, label: "27 px" },
  ] }, zoom, origin, [new Map([["outline", label]])]);
  const badges = Array.from(layer.querySelectorAll<HTMLElement>(".ss-studio-distance-badge"));
  const screenLabel = { left: (label.left + origin.x) * zoom, top: (label.top + origin.y) * zoom,
    right: (label.right + origin.x) * zoom, bottom: (label.bottom + origin.y) * zoom };
  expect(badges.every(badge => badge.classList.contains("is-positioned"))).toBe(true);
  const span = layer.querySelector<HTMLElement>(".ss-studio-distance-span")!;
  expect(span.style.maskImage).toContain("linear-gradient(to bottom");
  expect(badges.map(badgeRect).some(rect => intersects(rect, screenLabel))).toBe(false);
  expect(intersects(badgeRect(badges[0]), badgeRect(badges[1]))).toBe(false);
});

it("avoids multiline labels and adjacent cards without rebuilding or measuring their geometry", () => {
  const layer = document.createElement("div");
  const obstacles = new Map([
    ["label", { left: 690, top: 280, right: 800, bottom: 380 }],
    ["card", { left: 600, top: 280, right: 680, bottom: 400 }],
  ]);
  const original = [...obstacles.values()];
  renderStudioGraphAlignmentGuidesLayer(layer, { guides: [], gaps: [
    { axis: "y", start: 300, end: 340, cross: 732.5, label: "40 px" },
  ] }, 1, { x: 0, y: 0 }, [obstacles]);
  const badge = layer.querySelector<HTMLElement>(".ss-studio-distance-badge")!;
  expect(original.some(rect => intersects(rect, badgeRect(badge)))).toBe(false);
  expect([...obstacles.values()]).toEqual(original);
  renderStudioGraphAlignmentGuidesLayer(layer, null, 1);
  expect(layer.children).toHaveLength(0);
});
