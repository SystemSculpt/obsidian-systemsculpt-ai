/** Alignment targets, gentle movement snapping, and measured spacing. */

export type StudioGuideRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type StudioAlignmentGuideLine = {
  /** "x": vertical line at `position`; "y": horizontal line at `position`. */
  axis: "x" | "y";
  position: number;
  /** Remaining canvas-space movement to align; absent for an exact match. */
  offset?: number;
  labelCross?: number;
  /** Span along the perpendicular axis. */
  start: number;
  end: number;
};

export type StudioDistanceBadge = {
  /** "x": gap measured horizontally; "y": vertically. */
  axis: "x" | "y";
  /** Gap span along `axis`. */
  start: number;
  end: number;
  /** Perpendicular coordinate the badge centers on. */
  cross: number;
  label: string;
};

export type StudioAlignmentGuides = {
  guides: StudioAlignmentGuideLine[];
  gaps: StudioDistanceBadge[];
};

/** Guide radius in SCREEN pixels — divide by zoom for canvas-space use. */
export const STUDIO_GUIDE_THRESHOLD_PX = 8;
export const STUDIO_ALIGNMENT_SNAP_THRESHOLD_PX = 5;
export type StudioMovementSnap = (delta: { x: number; y: number }) => { x: number; y: number };

const GUIDE_MATCH_EPSILON = 0.51;

type AxisName = "x" | "y";

type AxisSpan = {
  min: number;
  max: number;
};

type AxisCandidate = {
  adjustment: number;
};

type AlignmentCandidate = AxisCandidate & {
  position: number;
};

function axisSpan(rect: StudioGuideRect, axis: AxisName): AxisSpan {
  return axis === "x"
    ? { min: rect.left, max: rect.right }
    : { min: rect.top, max: rect.bottom };
}

function crossSpan(rect: StudioGuideRect, axis: AxisName): AxisSpan {
  return axisSpan(rect, axis === "x" ? "y" : "x");
}

function spansOverlap(a: AxisSpan, b: AxisSpan): boolean {
  return a.min < b.max && b.min < a.max;
}

function overlapCenter(a: AxisSpan, b: AxisSpan): number {
  return (Math.max(a.min, b.min) + Math.min(a.max, b.max)) / 2;
}

function anchors(span: AxisSpan): number[] {
  return [span.min, (span.min + span.max) / 2, span.max];
}

function isFiniteRect(rect: StudioGuideRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom) && rect.right >= rect.left && rect.bottom >= rect.top
  );
}

function resolveAlignmentCandidate(
  moving: StudioGuideRect,
  others: StudioGuideRect[],
  axis: AxisName,
  threshold: number
): AlignmentCandidate | null {
  const movingAnchors = anchors(axisSpan(moving, axis));
  let best: AlignmentCandidate | null = null;
  for (const other of others) {
    for (const target of anchors(axisSpan(other, axis))) {
      for (const anchor of movingAnchors) {
        const adjustment = target - anchor;
        if (Math.abs(adjustment) > threshold) {
          continue;
        }
        if (!best || Math.abs(adjustment) < Math.abs(best.adjustment)) {
          best = { adjustment, position: target };
        }
      }
    }
  }
  return best;
}

/** Actual nearest gaps on either side, measured in canvas pixels at every zoom. */
function measureGaps(moving: StudioGuideRect, others: StudioGuideRect[], axis: AxisName): StudioDistanceBadge[] {
  const span = axisSpan(moving, axis);
  const cross = crossSpan(moving, axis);
  let before: StudioGuideRect | undefined;
  let after: StudioGuideRect | undefined;
  for (const other of others) {
    if (!spansOverlap(cross, crossSpan(other, axis))) continue;
    const target = axisSpan(other, axis);
    if (target.max <= span.min && (!before || target.max > axisSpan(before, axis).max)) before = other;
    if (target.min >= span.max && (!after || target.min < axisSpan(after, axis).min)) after = other;
  }
  const badges: StudioDistanceBadge[] = [];
  for (const [other, preceding] of [[before, true], [after, false]] as const) {
    if (!other) continue;
    const start = preceding ? axisSpan(other, axis).max : span.max;
    const end = preceding ? span.min : axisSpan(other, axis).min;
    badges.push({ axis, start, end, cross: overlapCenter(cross, crossSpan(other, axis)), label: `${Math.round(end - start)} px` });
  }
  return badges;
}

function buildAlignmentGuide(
  moving: StudioGuideRect,
  others: StudioGuideRect[],
  axis: AxisName,
  position: number,
  adjustment: number
): StudioAlignmentGuideLine {
  const perpendicular = crossSpan(moving, axis);
  let start = perpendicular.min;
  let end = perpendicular.max;
  for (const other of others) {
    const matches = anchors(axisSpan(other, axis)).some(
      (value) => Math.abs(value - position) <= GUIDE_MATCH_EPSILON
    );
    if (!matches) {
      continue;
    }
    const otherPerpendicular = crossSpan(other, axis);
    start = Math.min(start, otherPerpendicular.min);
    end = Math.max(end, otherPerpendicular.max);
  }
  return { axis, position, start, end, ...(Math.abs(adjustment) > 0.01 ? { offset: adjustment, labelCross: perpendicular.max } : {}) };
}

/** Show alignment of the resized edges without adjusting their position. */
export function resolveStudioResizeGuides(params: {
  /** Candidate rect with the raw drag deltas already applied. */
  moving: StudioGuideRect;
  others: StudioGuideRect[];
  threshold: number;
  /** Which edges the active zone drags: -1 = left/top, 1 = right/bottom. */
  edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
}): StudioAlignmentGuides {
  const empty: StudioAlignmentGuides = { guides: [], gaps: [] };
  const { moving } = params;
  const threshold = Number.isFinite(params.threshold) ? Math.max(0, params.threshold) : 0;
  if (threshold === 0 || !isFiniteRect(moving)) {
    return empty;
  }
  const others = params.others.filter(isFiniteRect);
  if (others.length === 0) {
    return empty;
  }

  const resolveEdge = (axis: AxisName, edge: -1 | 0 | 1): AlignmentCandidate | null => {
    if (edge === 0) {
      return null;
    }
    const span = axisSpan(moving, axis);
    const anchor = edge === 1 ? span.max : span.min;
    let best: AlignmentCandidate | null = null;
    for (const other of others) {
      for (const target of anchors(axisSpan(other, axis))) {
        const adjustment = target - anchor;
        if (Math.abs(adjustment) > threshold) {
          continue;
        }
        if (!best || Math.abs(adjustment) < Math.abs(best.adjustment)) {
          best = { adjustment, position: target };
        }
      }
    }
    return best;
  };

  const xCandidate = resolveEdge("x", params.edges.x);
  const yCandidate = resolveEdge("y", params.edges.y);
  const guides: StudioAlignmentGuideLine[] = [];
  if (xCandidate) {
    guides.push(buildAlignmentGuide(moving, others, "x", xCandidate.position, xCandidate.adjustment));
  }
  if (yCandidate) {
    guides.push(buildAlignmentGuide(moving, others, "y", yCandidate.position, yCandidate.adjustment));
  }

  return { guides, gaps: [] };
}

export function resolveStudioMovementGuides(params: {
  moving: StudioGuideRect;
  others: StudioGuideRect[];
  threshold: number;
}): StudioAlignmentGuides {
  const empty: StudioAlignmentGuides = { guides: [], gaps: [] };
  const { moving } = params;
  const threshold = Number.isFinite(params.threshold) ? Math.max(0, params.threshold) : 0;
  if (threshold === 0 || !isFiniteRect(moving)) {
    return empty;
  }
  const others = params.others.filter(isFiniteRect);
  if (others.length === 0) {
    return empty;
  }

  const guides: StudioAlignmentGuideLine[] = [];
  for (const axis of ["x", "y"] as const) {
    const candidate = resolveAlignmentCandidate(moving, others, axis, threshold);
    if (candidate) guides.push(buildAlignmentGuide(moving, others, axis, candidate.position, candidate.adjustment));
  }
  return { guides, gaps: [...measureGaps(moving, others, "x"), ...measureGaps(moving, others, "y")] };
}

/** Resolve from the unsnapped pointer delta every time, so dragging away releases the snap. */
export function createStudioMovementSnap(params: {
  moving: StudioGuideRect;
  others: StudioGuideRect[];
  threshold: number;
}): StudioMovementSnap {
  const others = params.others.filter(isFiniteRect);
  const threshold = Number.isFinite(params.threshold) ? Math.max(0, params.threshold) : 0;
  return delta => {
    if (!isFiniteRect(params.moving) || !Number.isFinite(delta.x) || !Number.isFinite(delta.y) || threshold === 0) return delta;
    const moving = { left: params.moving.left + delta.x, right: params.moving.right + delta.x,
      top: params.moving.top + delta.y, bottom: params.moving.bottom + delta.y };
    return {
      x: delta.x + (resolveAlignmentCandidate(moving, others, "x", threshold)?.adjustment || 0),
      y: delta.y + (resolveAlignmentCandidate(moving, others, "y", threshold)?.adjustment || 0),
    };
  };
}
