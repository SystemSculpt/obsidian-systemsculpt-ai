/**
 * Smart alignment guides for canvas drags (tldraw/Figma-style).
 *
 * Pure geometry: given the union bounds of the dragged nodes and the bounds
 * of every static node, resolve the snap adjustment to apply on top of the
 * raw pointer delta, plus the guide lines and equal-gap distance badges to
 * draw. Two snap families per axis, best (smallest) adjustment wins:
 *
 * - Alignment: any moving edge/center to any static edge/center.
 * - Spacing: equalize the gap to flanking neighbors (center-between), or
 *   repeat an existing neighbor-pair gap (even rows/columns). These produce
 *   the paired distance badges.
 *
 * Holding Ctrl/Cmd during a drag bypasses snapping entirely — that gate
 * lives in the drag interaction, not here.
 */

export type StudioSnapRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type StudioSnapGuideLine = {
  /** "x": vertical line at `position`; "y": horizontal line at `position`. */
  axis: "x" | "y";
  position: number;
  /** Span along the perpendicular axis. */
  start: number;
  end: number;
};

export type StudioSnapGapBadge = {
  /** "x": gap measured horizontally; "y": vertically. */
  axis: "x" | "y";
  /** Gap span along `axis`. */
  start: number;
  end: number;
  /** Perpendicular coordinate the badge centers on. */
  cross: number;
  label: string;
};

export type StudioSnapResult = {
  deltaX: number;
  deltaY: number;
  guides: StudioSnapGuideLine[];
  gaps: StudioSnapGapBadge[];
};

/** Snap radius in SCREEN pixels — divide by zoom for canvas-space use. */
export const STUDIO_SNAP_THRESHOLD_PX = 8;

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

type GapCandidate = AxisCandidate & {
  badges: StudioSnapGapBadge[];
};

function axisSpan(rect: StudioSnapRect, axis: AxisName): AxisSpan {
  return axis === "x"
    ? { min: rect.left, max: rect.right }
    : { min: rect.top, max: rect.bottom };
}

function crossSpan(rect: StudioSnapRect, axis: AxisName): AxisSpan {
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

function isFiniteRect(rect: StudioSnapRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom)
  );
}

function resolveAlignmentCandidate(
  moving: StudioSnapRect,
  others: StudioSnapRect[],
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

function formatGapLabel(gap: number): string {
  return String(Math.round(gap));
}

/**
 * Spacing snap along one axis. Considers only statics that overlap the
 * moving rect on the perpendicular axis, then tries:
 * - center-between the nearest flanking neighbors (equal gap both sides)
 * - repeating the gap between the near neighbor and ITS next neighbor
 */
function resolveGapCandidate(
  moving: StudioSnapRect,
  others: StudioSnapRect[],
  axis: AxisName,
  threshold: number
): GapCandidate | null {
  const movingSpan = axisSpan(moving, axis);
  const movingCross = crossSpan(moving, axis);
  const laneRects = others.filter((other) => spansOverlap(crossSpan(other, axis), movingCross));
  if (laneRects.length === 0) {
    return null;
  }

  let before: StudioSnapRect | null = null;
  let after: StudioSnapRect | null = null;
  for (const rect of laneRects) {
    const span = axisSpan(rect, axis);
    if (span.max <= movingSpan.min + threshold) {
      if (!before || span.max > axisSpan(before, axis).max) {
        before = rect;
      }
    }
    if (span.min >= movingSpan.max - threshold) {
      if (!after || span.min < axisSpan(after, axis).min) {
        after = rect;
      }
    }
  }

  const candidates: GapCandidate[] = [];
  const movingSize = movingSpan.max - movingSpan.min;

  const badge = (start: number, end: number, crossWith: StudioSnapRect): StudioSnapGapBadge => ({
    axis,
    start,
    end,
    cross: overlapCenter(crossSpan(crossWith, axis), movingCross),
    label: formatGapLabel(end - start),
  });

  if (before && after && before !== after) {
    const beforeSpan = axisSpan(before, axis);
    const afterSpan = axisSpan(after, axis);
    const targetMin = (beforeSpan.max + afterSpan.min - movingSize) / 2;
    const adjustment = targetMin - movingSpan.min;
    const gap = targetMin - beforeSpan.max;
    if (Math.abs(adjustment) <= threshold && gap >= 0) {
      candidates.push({
        adjustment,
        badges: [
          badge(beforeSpan.max, targetMin, before),
          badge(targetMin + movingSize, afterSpan.min, after),
        ],
      });
    }
  }

  const neighborGap = (
    near: StudioSnapRect,
    side: "before" | "after"
  ): GapCandidate | null => {
    const nearSpan = axisSpan(near, axis);
    const nearCross = crossSpan(near, axis);
    let bestGap: { gap: number; farSpanEdge: number; far: StudioSnapRect } | null = null;
    for (const rect of laneRects) {
      if (rect === near) {
        continue;
      }
      if (!spansOverlap(crossSpan(rect, axis), nearCross)) {
        continue;
      }
      const span = axisSpan(rect, axis);
      const gap = side === "before" ? nearSpan.min - span.max : span.min - nearSpan.max;
      if (!Number.isFinite(gap) || gap < 0) {
        continue;
      }
      if (!bestGap || gap < bestGap.gap) {
        bestGap = {
          gap,
          farSpanEdge: side === "before" ? span.max : span.min,
          far: rect,
        };
      }
    }
    if (!bestGap) {
      return null;
    }
    const targetMin =
      side === "before" ? nearSpan.max + bestGap.gap : nearSpan.min - bestGap.gap - movingSize;
    const adjustment = targetMin - movingSpan.min;
    if (Math.abs(adjustment) > threshold) {
      return null;
    }
    const pairBadge =
      side === "before"
        ? badge(bestGap.farSpanEdge, nearSpan.min, near)
        : badge(nearSpan.max, bestGap.farSpanEdge, near);
    const movingBadge =
      side === "before"
        ? badge(nearSpan.max, targetMin, near)
        : badge(targetMin + movingSize, nearSpan.min, near);
    return { adjustment, badges: [pairBadge, movingBadge] };
  };

  if (before) {
    const candidate = neighborGap(before, "before");
    if (candidate) {
      candidates.push(candidate);
    }
  }
  if (after) {
    const candidate = neighborGap(after, "after");
    if (candidate) {
      candidates.push(candidate);
    }
  }

  let best: GapCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || Math.abs(candidate.adjustment) < Math.abs(best.adjustment)) {
      best = candidate;
    }
  }
  return best;
}

function buildAlignmentGuide(
  snappedMoving: StudioSnapRect,
  others: StudioSnapRect[],
  axis: AxisName,
  position: number
): StudioSnapGuideLine {
  const perpendicular = crossSpan(snappedMoving, axis);
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
  return { axis, position, start, end };
}

function offsetRect(rect: StudioSnapRect, deltaX: number, deltaY: number): StudioSnapRect {
  return {
    left: rect.left + deltaX,
    top: rect.top + deltaY,
    right: rect.right + deltaX,
    bottom: rect.bottom + deltaY,
  };
}

/**
 * Edge-anchored snapping for RESIZE drags: only the dragged edge(s) snap to
 * static alignment anchors (edges/centers), mirroring the move-drag guides.
 * Spacing/gap snapping deliberately does not apply — a resize moves an edge,
 * not the whole box, so equal-gap targets are meaningless mid-gesture.
 */
export function resolveStudioGraphResizeSnap(params: {
  /** Candidate rect with the raw drag deltas already applied. */
  moving: StudioSnapRect;
  others: StudioSnapRect[];
  threshold: number;
  /** Which edges the active zone drags: -1 = left/top, 1 = right/bottom. */
  edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
}): StudioSnapResult {
  const empty: StudioSnapResult = { deltaX: 0, deltaY: 0, guides: [], gaps: [] };
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
  const deltaX = xCandidate?.adjustment ?? 0;
  const deltaY = yCandidate?.adjustment ?? 0;
  // Only the dragged edges move; the anchored edges stay put.
  const snapped: StudioSnapRect = {
    left: moving.left + (params.edges.x === -1 ? deltaX : 0),
    right: moving.right + (params.edges.x === 1 ? deltaX : 0),
    top: moving.top + (params.edges.y === -1 ? deltaY : 0),
    bottom: moving.bottom + (params.edges.y === 1 ? deltaY : 0),
  };

  const guides: StudioSnapGuideLine[] = [];
  if (xCandidate) {
    guides.push(buildAlignmentGuide(snapped, others, "x", xCandidate.position));
  }
  if (yCandidate) {
    guides.push(buildAlignmentGuide(snapped, others, "y", yCandidate.position));
  }

  return { deltaX, deltaY, guides, gaps: [] };
}

export function resolveStudioGraphSnap(params: {
  moving: StudioSnapRect;
  others: StudioSnapRect[];
  threshold: number;
}): StudioSnapResult {
  const empty: StudioSnapResult = { deltaX: 0, deltaY: 0, guides: [], gaps: [] };
  const { moving } = params;
  const threshold = Number.isFinite(params.threshold) ? Math.max(0, params.threshold) : 0;
  if (threshold === 0 || !isFiniteRect(moving)) {
    return empty;
  }
  const others = params.others.filter(isFiniteRect);
  if (others.length === 0) {
    return empty;
  }

  const resolveAxis = (
    axis: AxisName
  ): { adjustment: number; alignment: AlignmentCandidate | null; gap: GapCandidate | null } => {
    const alignment = resolveAlignmentCandidate(moving, others, axis, threshold);
    const gap = resolveGapCandidate(moving, others, axis, threshold);
    if (alignment && (!gap || Math.abs(alignment.adjustment) <= Math.abs(gap.adjustment))) {
      return { adjustment: alignment.adjustment, alignment, gap: null };
    }
    if (gap) {
      return { adjustment: gap.adjustment, alignment: null, gap };
    }
    return { adjustment: 0, alignment: null, gap: null };
  };

  const xResult = resolveAxis("x");
  const yResult = resolveAxis("y");
  const deltaX = xResult.adjustment;
  const deltaY = yResult.adjustment;
  const snappedMoving = offsetRect(moving, deltaX, deltaY);

  const guides: StudioSnapGuideLine[] = [];
  if (xResult.alignment) {
    guides.push(buildAlignmentGuide(snappedMoving, others, "x", xResult.alignment.position));
  }
  if (yResult.alignment) {
    guides.push(buildAlignmentGuide(snappedMoving, others, "y", yResult.alignment.position));
  }

  // Badge spans are computed against the snapped position on their own axis,
  // but the perpendicular center was derived pre-snap — rebuild against the
  // cross-adjusted rect when the other axis moved.
  const gaps: StudioSnapGapBadge[] = [];
  if (xResult.gap) {
    const rebuilt =
      deltaY === 0
        ? xResult.gap
        : resolveGapCandidate(offsetRect(moving, 0, deltaY), others, "x", threshold);
    gaps.push(...(rebuilt?.badges ?? xResult.gap.badges));
  }
  if (yResult.gap) {
    const rebuilt =
      deltaX === 0
        ? yResult.gap
        : resolveGapCandidate(offsetRect(moving, deltaX, 0), others, "y", threshold);
    gaps.push(...(rebuilt?.badges ?? yResult.gap.badges));
  }

  return { deltaX, deltaY, guides, gaps };
}
