import type { StudioDistanceBadge, StudioAlignmentGuideLine, StudioGuideRect } from "./StudioGraphAlignmentGuides";

type Occlusions = readonly (ReadonlyMap<string, StudioGuideRect> | readonly StudioGuideRect[])[];
type Interval = { start: number; end: number };
const BADGE_GAP_PX = 8;

function* rectangles(occlusions: Occlusions, extra: readonly StudioGuideRect[] = []): Generator<StudioGuideRect> {
  for (const source of occlusions) yield* source.values();
  yield* extra;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  intervals.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start < previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Only the exposed portions of a smart guide paint; transparent text cards stay readable. */
function exposedGuideSegments(guide: StudioAlignmentGuideLine, occlusions: Occlusions, padding: number, endInset = 0): Interval[] {
  const blocked: Interval[] = [];
  for (const rect of rectangles(occlusions)) {
    const min = guide.axis === "x" ? rect.left : rect.top;
    const max = guide.axis === "x" ? rect.right : rect.bottom;
    if (guide.position < min - padding || guide.position > max + padding) continue;
    const start = Math.max((guide.axis === "x" ? rect.top : rect.left) - padding, guide.start + endInset);
    const end = Math.min((guide.axis === "x" ? rect.bottom : rect.right) + padding, guide.end - endInset);
    if (end > start) blocked.push({ start, end });
  }
  const segments: Interval[] = [];
  let cursor = guide.start;
  for (const interval of mergeIntervals(blocked)) {
    if (interval.end <= cursor) continue;
    if (interval.start >= guide.end) break;
    if (interval.start > cursor) segments.push({ start: cursor, end: Math.min(interval.start, guide.end) });
    cursor = Math.max(cursor, interval.end);
    if (cursor >= guide.end) break;
  }
  if (cursor < guide.end) segments.push({ start: cursor, end: guide.end });
  return segments;
}

/** A paint mask keeps DOM size constant even when a guide crosses many cards. */
function maskSegments(element: HTMLElement, guide: StudioAlignmentGuideLine, segments: Interval[], scale: number): void {
  const stops = segments.flatMap(segment => {
    const start = (segment.start - guide.start) * scale, end = (segment.end - guide.start) * scale;
    return [`transparent ${start}px`, `#000 ${start}px`, `#000 ${end}px`, `transparent ${end}px`];
  });
  const colors = ["transparent 0px", ...stops, `transparent ${(guide.end - guide.start) * scale}px`];
  element.style.maskImage = `linear-gradient(to ${guide.axis === "x" ? "bottom" : "right"}, ${colors.join(", ")})`;
}

/** Find the nearest free point on one axis using cached world boxes, not peer DOM reads. */
function nearestBadgeCoordinate(
  axis: "x" | "y", desired: StudioGuideRect, obstacles: readonly StudioGuideRect[], gap: number, bounds: Interval
): number | null {
  const intervals: Interval[] = [];
  const width = desired.right - desired.left, height = desired.bottom - desired.top;
  for (const rect of obstacles) {
    const crosses = axis === "x"
      ? desired.top < rect.bottom + gap && desired.bottom > rect.top - gap
      : desired.left < rect.right + gap && desired.right > rect.left - gap;
    if (!crosses) continue;
    intervals.push(axis === "x"
      ? { start: rect.left - width - gap, end: rect.right + gap }
      : { start: rect.top - height - gap, end: rect.bottom + gap });
  }
  const coordinate = Math.min(bounds.end, Math.max(bounds.start, axis === "x" ? desired.left : desired.top));
  for (const interval of mergeIntervals(intervals)) {
    if (coordinate > interval.start && coordinate < interval.end) {
      const before = interval.start >= bounds.start ? interval.start : null;
      const after = interval.end <= bounds.end ? interval.end : null;
      if (before === null) return after;
      if (after === null) return before;
      return coordinate - before <= after - coordinate ? before : after;
    }
  }
  return coordinate;
}

/** Search bounded axis projections before collision resolution; never clamp the result afterward. */
function nearestBadgeRect(
  desired: StudioGuideRect, occlusions: Occlusions, placed: readonly StudioGuideRect[], gap: number,
  viewport: Readonly<StudioGuideRect> | null
): StudioGuideRect | null {
  const width = desired.right - desired.left, height = desired.bottom - desired.top;
  const minX = viewport?.left ?? -Infinity, maxX = (viewport?.right ?? Infinity) - width;
  const minY = viewport?.top ?? -Infinity, maxY = (viewport?.bottom ?? Infinity) - height;
  if (maxX < minX || maxY < minY) return null;
  const obstacles = [...rectangles(occlusions, placed)].filter(rect =>
    rect.right + gap > minX && rect.left - width - gap < maxX
    && rect.bottom + gap > minY && rect.top - height - gap < maxY);
  const startX = Math.min(maxX, Math.max(minX, desired.left));
  const startY = Math.min(maxY, Math.max(minY, desired.top));
  const projections: Array<{ axis: "x" | "y"; cross: number }> = [
    { axis: "x", cross: startY }, { axis: "y", cross: startX },
  ];
  if (viewport) projections.push(
    { axis: "x", cross: minY }, { axis: "x", cross: maxY },
    { axis: "y", cross: minX }, { axis: "y", cross: maxX },
  );
  let best: StudioGuideRect | null = null;
  let distance = Infinity;
  const minDistance = (startX - desired.left) ** 2 + (startY - desired.top) ** 2;
  // At most six camera-derived projections: interval merging stays O(N log N).
  for (const { axis, cross } of projections) {
    const row = axis === "x"
      ? { left: startX, top: cross, right: startX + width, bottom: cross + height }
      : { left: cross, top: startY, right: cross + width, bottom: startY + height };
    const coordinate = nearestBadgeCoordinate(axis, row, obstacles, gap,
      axis === "x" ? { start: minX, end: maxX } : { start: minY, end: maxY });
    if (coordinate === null) continue;
    const left = axis === "x" ? coordinate : cross;
    const top = axis === "y" ? coordinate : cross;
    const candidateDistance = (left - desired.left) ** 2 + (top - desired.top) ** 2;
    if (candidateDistance < distance) {
      best = { left, top, right: left + width, bottom: top + height };
      distance = candidateDistance;
      if (distance === minDistance) break;
    }
  }
  return best;
}

/**
 * Positions use scroll-box pixels: (world + origin) * zoom. Only each small
 * badge measures itself; cards and arrow labels come from the geometry owner.
 */
export function renderStudioGraphAlignmentGuidesLayer(
  layer: HTMLElement,
  result: { guides: StudioAlignmentGuideLine[]; gaps: StudioDistanceBadge[] } | null,
  zoom: number,
  origin: { x: number; y: number } = { x: 0, y: 0 },
  occlusions: Occlusions = [],
  viewport: Readonly<StudioGuideRect> | null = null
): void {
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  if (!result || (result.guides.length === 0 && result.gaps.length === 0)) return;

  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  type Annotation = StudioAlignmentGuideLine | StudioDistanceBadge;
  const strokeWidth = 2 / scale;
  const strokeRect = (axis: "x" | "y", position: number, start: number, end: number): StudioGuideRect => axis === "x"
    ? { left: position, right: position + strokeWidth, top: start, bottom: end }
    : { left: start, right: end, top: position, bottom: position + strokeWidth };
  // Reserve all annotations before placing any badge, including later spans.
  const strokes: Array<{ owner: Annotation; rects: StudioGuideRect[] }> = result.guides.map(guide => ({
    owner: guide, rects: [strokeRect(guide.axis, guide.position, guide.start, guide.end)],
  }));
  for (const gap of result.gaps) {
    const rects = [strokeRect(gap.axis === "x" ? "y" : "x", gap.cross, gap.start, gap.end)];
    for (const start of [gap.start, gap.end - strokeWidth]) {
      rects.push(gap.axis === "x"
        ? { left: start, right: start + strokeWidth, top: gap.cross - 3 / scale, bottom: gap.cross + 5 / scale }
        : { left: gap.cross - 3 / scale, right: gap.cross + 5 / scale, top: start, bottom: start + strokeWidth });
    }
    strokes.push({ owner: gap, rects });
  }
  const placed: StudioGuideRect[] = [];
  const placeBadge = (badge: HTMLElement, anchor: { x: number; y: number }, kind: "x" | "y" | "offset", owner: Annotation): void => {
    layer.appendChild(badge);
    // offsetWidth/Height can round down fractional text boxes and clip an edge.
    const measured = badge.getBoundingClientRect();
    const width = Math.ceil(measured.width) / scale, height = Math.ceil(measured.height) / scale;
    if (!width || !height) return;
    const gap = BADGE_GAP_PX / scale;
    const left = anchor.x - (kind === "y" ? width + gap : width / 2);
    const top = kind === "offset" ? anchor.y + gap : anchor.y - (kind === "x" ? height + gap : height / 2);
    const desired = { left, top, right: left + width, bottom: top + height };
    // A label may interrupt its own annotation, never a different measurement.
    const otherStrokes = strokes.flatMap(stroke => stroke.owner === owner ? [] : stroke.rects);
    const resolved = nearestBadgeRect(desired, [...occlusions, otherStrokes], placed, gap, viewport);
    // Keep the guide/span when no clear bounded candidate is found for its label.
    if (!resolved) { badge.remove(); return; }
    placed.push(resolved);
    badge.classList.add("is-positioned");
    badge.style.left = `${(resolved.left + origin.x) * scale}px`;
    badge.style.top = `${(resolved.top + origin.y) * scale}px`;
  };

  for (const guide of result.guides) {
    const segments = exposedGuideSegments(guide, occlusions, 2 / scale);
    if (segments.length) {
      const line = layer.createDiv();
      line.className = `ss-studio-alignment-guide ${guide.axis === "x" ? "is-vertical" : "is-horizontal"}`;
      if (guide.offset !== undefined) line.classList.add("is-near");
      const length = Math.max(0, (guide.end - guide.start) * scale);
      if (guide.axis === "x") {
        line.style.left = `${(guide.position + origin.x) * scale}px`;
        line.style.top = `${(guide.start + origin.y) * scale}px`;
        line.style.height = `${length}px`;
      } else {
        line.style.left = `${(guide.start + origin.x) * scale}px`;
        line.style.top = `${(guide.position + origin.y) * scale}px`;
        line.style.width = `${length}px`;
      }
      maskSegments(line, guide, segments, scale);
    }
    if (guide.offset !== undefined) {
      const badge = layer.createDiv();
      badge.className = "ss-studio-distance-badge ss-studio-alignment-offset-badge";
      const distance = Math.round(Math.abs(guide.offset) * 10) / 10;
      badge.textContent = `${distance} px to align`;
      const cross = guide.labelCross ?? guide.end;
      const anchor = { x: guide.axis === "x" ? guide.position : cross, y: guide.axis === "x" ? cross : guide.position };
      badge.style.left = `${(anchor.x + origin.x) * scale}px`;
      badge.style.top = `${(anchor.y + origin.y) * scale}px`;
      placeBadge(badge, anchor, "offset", guide);
    }
  }

  for (const gap of result.gaps) {
    const span = layer.createDiv();
    span.className = `ss-studio-distance-span ${gap.axis === "x" ? "is-horizontal" : "is-vertical"}`;
    const length = Math.max(0, (gap.end - gap.start) * scale);
    if (gap.axis === "x") {
      span.style.left = `${(gap.start + origin.x) * scale}px`;
      span.style.top = `${(gap.cross + origin.y) * scale}px`;
      span.style.width = `${length}px`;
    } else {
      span.style.left = `${(gap.cross + origin.x) * scale}px`;
      span.style.top = `${(gap.start + origin.y) * scale}px`;
      span.style.height = `${length}px`;
    }
    if (length > 0) {
      const guide: StudioAlignmentGuideLine = { axis: gap.axis === "x" ? "y" : "x", position: gap.cross, start: gap.start, end: gap.end };
      // Preserve the existing 3px end ticks; hide strokes behind interior labels.
      maskSegments(span, guide, exposedGuideSegments(guide, occlusions, 2 / scale, 3 / scale), scale);
    }
    const badge = layer.createDiv();
    badge.className = `ss-studio-distance-badge ${gap.axis === "x" ? "is-horizontal-gap" : "is-vertical-gap"}`;
    badge.textContent = gap.label;
    const mid = (gap.start + gap.end) / 2;
    const anchor = { x: gap.axis === "x" ? mid : gap.cross, y: gap.axis === "x" ? gap.cross : mid };
    badge.style.left = `${(anchor.x + origin.x) * scale}px`;
    badge.style.top = `${(anchor.y + origin.y) * scale}px`;
    placeBadge(badge, anchor, gap.axis, gap);
  }
}
