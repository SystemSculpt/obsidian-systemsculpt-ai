/** @jest-environment jsdom */
import { renderStudioGraphAlignmentGuidesLayer } from "../StudioGraphAlignmentGuidesOverlay";
import type { StudioAlignmentGuides, StudioGuideRect } from "../StudioGraphAlignmentGuides";

function intersects(a: StudioGuideRect, b: StudioGuideRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function badgeRect(element: HTMLElement): StudioGuideRect {
  const left = Number.parseFloat(element.style.left), top = Number.parseFloat(element.style.top);
  return { left, top, right: left + 40, bottom: top + 18 };
}

function badgeFixture(desired: StudioGuideRect, zoom: number, kind: "x" | "y" | "offset" = "x"): StudioAlignmentGuides {
  const midX = (desired.left + desired.right) / 2, midY = (desired.top + desired.bottom) / 2;
  if (kind === "offset") return {
    guides: [{ axis: "x", position: midX, start: desired.top - 10, end: desired.bottom + 10,
      offset: 3, labelCross: desired.top - 8 / zoom }], gaps: [],
  };
  return { guides: [], gaps: [{ axis: kind, start: (kind === "x" ? midX : midY) - 10,
    end: (kind === "x" ? midX : midY) + 10,
    cross: kind === "x" ? desired.bottom + 8 / zoom : desired.right + 8 / zoom, label: "20 px" }] };
}

function worldBadgeRect(element: HTMLElement, zoom: number, origin: { x: number; y: number }): StudioGuideRect {
  const screen = badgeRect(element);
  return { left: screen.left / zoom - origin.x, right: screen.right / zoom - origin.x,
    top: screen.top / zoom - origin.y, bottom: screen.bottom / zoom - origin.y };
}

function expectInside(rect: StudioGuideRect, viewport: StudioGuideRect): void {
  expect(rect.left).toBeGreaterThanOrEqual(viewport.left - 0.0001);
  expect(rect.top).toBeGreaterThanOrEqual(viewport.top - 0.0001);
  expect(rect.right).toBeLessThanOrEqual(viewport.right + 0.0001);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom + 0.0001);
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

it.each([0.8, 1, 2])("bounds every badge kind at all camera edges with world offsets at zoom %s", zoom => {
  const origin = { x: 730, y: -190 };
  for (const camera of [{ left: 140, top: 260 }, { left: -430, top: -275 }]) {
    const viewport = { ...camera, right: camera.left + 300 / zoom, bottom: camera.top + 220 / zoom };
    const width = 40 / zoom, height = 18 / zoom;
    const middle = { left: camera.left + 120 / zoom, top: camera.top + 100 / zoom };
    for (const edge of [
      { ...middle, left: viewport.left - width },
      { ...middle, left: viewport.right },
      { ...middle, top: viewport.top - height },
      { ...middle, top: viewport.bottom },
    ]) {
      const desired = { ...edge, right: edge.left + width, bottom: edge.top + height };
      for (const kind of ["x", "y", "offset"] as const) {
        const layer = document.createElement("div");
        renderStudioGraphAlignmentGuidesLayer(layer, badgeFixture(desired, zoom, kind), zoom, origin, [], viewport);
        const badge = layer.querySelector<HTMLElement>(".ss-studio-distance-badge")!;
        expect(badge).not.toBeNull();
        const rect = worldBadgeRect(badge, zoom, origin);
        expectInside(rect, viewport);
        expect(rect.left).toBeCloseTo(Math.min(viewport.right - width, Math.max(viewport.left, desired.left)));
        expect(rect.top).toBeCloseTo(Math.min(viewport.bottom - height, Math.max(viewport.top, desired.top)));
      }
    }
  }
});

it.each([0.8, 1, 2])("resolves occlusion at the bounded origin instead of clamping into a label at zoom %s", zoom => {
  const layer = document.createElement("div");
  const origin = { x: 400, y: 250 };
  const viewport = { left: -300, top: -100, right: -300 + 300 / zoom, bottom: -100 + 220 / zoom };
  const width = 40 / zoom, height = 18 / zoom;
  const desired = { left: viewport.right - width + 10 / zoom, top: viewport.top - 10 / zoom,
    right: viewport.right + 10 / zoom, bottom: viewport.top - 10 / zoom + height };
  const label = { left: viewport.right - width - 5 / zoom, top: viewport.top,
    right: viewport.right, bottom: viewport.top + height + 5 / zoom };
  renderStudioGraphAlignmentGuidesLayer(layer, badgeFixture(desired, zoom), zoom, origin, [[label]], viewport);
  const rect = worldBadgeRect(layer.querySelector<HTMLElement>(".ss-studio-distance-badge")!, zoom, origin);
  expectInside(rect, viewport);
  expect(intersects(rect, label)).toBe(false);
  expect(rect.left).toBeCloseTo(viewport.right - width);
  expect(rect.top).toBeCloseTo(label.bottom + 8 / zoom);
});

it.each([0.8, 1, 2])("uses free camera-edge projections when both preferred axes are blocked at zoom %s", zoom => {
  const layer = document.createElement("div");
  const origin = { x: -90, y: 630 };
  const viewport = { left: -360, top: 140, right: -360 + 200 / zoom, bottom: 140 + 200 / zoom };
  const desired = { left: viewport.left + 70 / zoom, right: viewport.left + 110 / zoom,
    top: viewport.top + 90 / zoom, bottom: viewport.top + 108 / zoom };
  const obstacles = [
    { left: viewport.left + 80 / zoom, right: viewport.left + 120 / zoom, top: viewport.top, bottom: viewport.bottom },
    { left: viewport.left, right: viewport.right, top: viewport.top + 80 / zoom, bottom: viewport.top + 120 / zoom },
  ];
  renderStudioGraphAlignmentGuidesLayer(layer, badgeFixture(desired, zoom), zoom, origin, [obstacles], viewport);
  const rect = worldBadgeRect(layer.querySelector<HTMLElement>(".ss-studio-distance-badge")!, zoom, origin);
  expectInside(rect, viewport);
  expect(obstacles.some(obstacle => intersects(obstacle, rect))).toBe(false);
  expect(rect.left).toBeCloseTo(viewport.left);
  expect(rect.top).toBeCloseTo(viewport.top + 54 / zoom);
});

it.each([0.8, 1, 2])("keeps badges separate when their anchors clamp to the same camera corner at zoom %s", zoom => {
  const layer = document.createElement("div");
  const viewport = { left: -80, top: 120, right: -80 + 300 / zoom, bottom: 120 + 220 / zoom };
  const origin = { x: 350, y: -70 };
  const desired = { left: viewport.right, right: viewport.right + 40 / zoom,
    top: viewport.top - 18 / zoom, bottom: viewport.top };
  const fixture = badgeFixture(desired, zoom);
  renderStudioGraphAlignmentGuidesLayer(layer, { guides: [], gaps: [...fixture.gaps, ...fixture.gaps] }, zoom, origin, [], viewport);
  const badges = Array.from(layer.querySelectorAll<HTMLElement>(".ss-studio-distance-badge"));
  expect(badges).toHaveLength(2);
  const rects = badges.map(badge => worldBadgeRect(badge, zoom, origin));
  rects.forEach(rect => expectInside(rect, viewport));
  expect(intersects(rects[0], rects[1])).toBe(false);
  expect(layer.children).toHaveLength(4);
});

it("keeps spans but omits a badge when no clear bounded candidate is found among dense occluders", () => {
  const layer = document.createElement("div");
  const viewport = { left: -100, top: -200, right: 200, bottom: 100 };
  const desired = { left: 0, top: 0, right: 40, bottom: 18 };
  const obstacles = Array.from({ length: 1000 }, () => ({ ...viewport }));
  renderStudioGraphAlignmentGuidesLayer(layer, badgeFixture(desired, 1), 1, { x: 500, y: 600 }, [obstacles], viewport);
  expect(layer.querySelectorAll(".ss-studio-distance-badge")).toHaveLength(0);
  expect(layer.querySelectorAll(".ss-studio-distance-span")).toHaveLength(1);
  expect(layer.children).toHaveLength(1);
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
