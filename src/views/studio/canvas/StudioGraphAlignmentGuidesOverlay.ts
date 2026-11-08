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
function exposedGuideSegments(guide: StudioAlignmentGuideLine, occlusions: Occlusions, padding: number): Interval[] {
  const blocked: Interval[] = [];
  for (const rect of rectangles(occlusions)) {
    const min = guide.axis === "x" ? rect.left : rect.top;
    const max = guide.axis === "x" ? rect.right : rect.bottom;
    if (guide.position < min - padding || guide.position > max + padding) continue;
    blocked.push({ start: (guide.axis === "x" ? rect.top : rect.left) - padding,
      end: (guide.axis === "x" ? rect.bottom : rect.right) + padding });
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

/** Find the nearest free point on one axis using cached world boxes, not peer DOM reads. */
function nearestBadgeCoordinate(
  axis: "x" | "y", desired: StudioGuideRect, occlusions: Occlusions, placed: readonly StudioGuideRect[], gap: number
): number {
  const intervals: Interval[] = [];
  const width = desired.right - desired.left, height = desired.bottom - desired.top;
  for (const rect of rectangles(occlusions, placed)) {
    const crosses = axis === "x"
      ? desired.top < rect.bottom + gap && desired.bottom > rect.top - gap
      : desired.left < rect.right + gap && desired.right > rect.left - gap;
    if (!crosses) continue;
    intervals.push(axis === "x"
      ? { start: rect.left - width - gap, end: rect.right + gap }
      : { start: rect.top - height - gap, end: rect.bottom + gap });
  }
  const coordinate = axis === "x" ? desired.left : desired.top;
  for (const interval of mergeIntervals(intervals)) {
    if (coordinate > interval.start && coordinate < interval.end) {
      return coordinate - interval.start <= interval.end - coordinate ? interval.start : interval.end;
    }
  }
  return coordinate;
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
  occlusions: Occlusions = []
): void {
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  if (!result || (result.guides.length === 0 && result.gaps.length === 0)) return;

  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const placed: StudioGuideRect[] = [];
  const placeBadge = (badge: HTMLElement, anchor: { x: number; y: number }, kind: "x" | "y" | "offset"): void => {
    layer.appendChild(badge);
    const width = badge.offsetWidth / scale, height = badge.offsetHeight / scale;
    if (!width || !height) return;
    const gap = BADGE_GAP_PX / scale;
    const left = anchor.x - (kind === "y" ? width + gap : width / 2);
    const top = kind === "offset" ? anchor.y + gap : anchor.y - (kind === "x" ? height + gap : height / 2);
    const desired = { left, top, right: left + width, bottom: top + height };
    const nextX = nearestBadgeCoordinate("x", desired, occlusions, placed, gap);
    const nextY = nearestBadgeCoordinate("y", desired, occlusions, placed, gap);
    const resolved = Math.abs(nextX - left) <= Math.abs(nextY - top)
      ? { left: nextX, top, right: nextX + width, bottom: top + height }
      : { left, top: nextY, right: left + width, bottom: nextY + height };
    placed.push(resolved);
    badge.classList.add("is-positioned");
    badge.style.left = `${(resolved.left + origin.x) * scale}px`;
    badge.style.top = `${(resolved.top + origin.y) * scale}px`;
  };

  for (const guide of result.guides) {
    for (const segment of exposedGuideSegments(guide, occlusions, 2 / scale)) {
      const line = layer.createDiv();
      line.className = `ss-studio-alignment-guide ${guide.axis === "x" ? "is-vertical" : "is-horizontal"}`;
      if (guide.offset !== undefined) line.classList.add("is-near");
      const length = Math.max(0, (segment.end - segment.start) * scale);
      if (guide.axis === "x") {
        line.style.left = `${(guide.position + origin.x) * scale}px`;
        line.style.top = `${(segment.start + origin.y) * scale}px`;
        line.style.height = `${length}px`;
      } else {
        line.style.left = `${(segment.start + origin.x) * scale}px`;
        line.style.top = `${(guide.position + origin.y) * scale}px`;
        line.style.width = `${length}px`;
      }
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
      placeBadge(badge, anchor, "offset");
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
    const badge = layer.createDiv();
    badge.className = `ss-studio-distance-badge ${gap.axis === "x" ? "is-horizontal-gap" : "is-vertical-gap"}`;
    badge.textContent = gap.label;
    const mid = (gap.start + gap.end) / 2;
    const anchor = { x: gap.axis === "x" ? mid : gap.cross, y: gap.axis === "x" ? gap.cross : mid };
    badge.style.left = `${(anchor.x + origin.x) * scale}px`;
    badge.style.top = `${(anchor.y + origin.y) * scale}px`;
    placeBadge(badge, anchor, gap.axis);
  }
}
