/**
 * Pure geometry for the Studio image board.
 *
 * Board boxes are stored normalized to the base image (0..1 spans the image,
 * values outside hang off it) with a rotation in degrees about the box
 * centre. Every calculation that involves rotation happens in base pixels so
 * a rotated box stays rectangular on non-square images.
 */

export type StudioImageBoardPoint = { x: number; y: number };
export type StudioImageBoardSize = { width: number; height: number };
export type StudioImageBoardFrame = { x: number; y: number; width: number; height: number };
export type StudioImageBoardBox = StudioImageBoardFrame & { rotation: number };

/** Canvas `setTransform` order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type StudioImageBoardAffine = readonly [number, number, number, number, number, number];

/** -1 / 0 / 1 per axis: which side of the box a resize handle sits on. */
export type StudioImageBoardHandle = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

export const STUDIO_IMAGE_BOARD_UNIT_FRAME: StudioImageBoardFrame = { x: 0, y: 0, width: 1, height: 1 };

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

/** Degrees folded into (-180, 180]. */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) {
    return 0;
  }
  const folded = ((degrees % 360) + 360) % 360;
  const signed = folded > 180 ? folded - 360 : folded;
  return Math.round(signed * 100) / 100;
}

export function translateAffine(x: number, y: number): StudioImageBoardAffine {
  return [1, 0, 0, 1, x, y];
}

export function scaleAffine(x: number, y: number): StudioImageBoardAffine {
  return [x, 0, 0, y, 0, 0];
}

export function rotateAffine(degrees: number): StudioImageBoardAffine {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

/** `outer ∘ inner`: a point is transformed by `inner` first. */
export function multiplyAffine(
  outer: StudioImageBoardAffine,
  inner: StudioImageBoardAffine
): StudioImageBoardAffine {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

export function invertAffine(matrix: StudioImageBoardAffine): StudioImageBoardAffine | null {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return null;
  }
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

export function applyAffine(
  matrix: StudioImageBoardAffine,
  point: StudioImageBoardPoint
): StudioImageBoardPoint {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5],
  };
}

export function boxSizePx(box: StudioImageBoardFrame, base: StudioImageBoardSize): StudioImageBoardSize {
  return {
    width: Math.max(0, box.width * base.width),
    height: Math.max(0, box.height * base.height),
  };
}

export function boxCenterPx(box: StudioImageBoardFrame, base: StudioImageBoardSize): StudioImageBoardPoint {
  return {
    x: (box.x + box.width / 2) * base.width,
    y: (box.y + box.height / 2) * base.height,
  };
}

/** Box-local pixels (origin at the box centre) → base pixels. */
export function boxLocalTransform(
  box: StudioImageBoardBox,
  base: StudioImageBoardSize
): StudioImageBoardAffine {
  const center = boxCenterPx(box, base);
  return multiplyAffine(translateAffine(center.x, center.y), rotateAffine(box.rotation));
}

/** Base pixels → target pixels for a target that shows exactly `view`. */
export function viewTransform(
  view: StudioImageBoardFrame,
  base: StudioImageBoardSize,
  target: StudioImageBoardSize
): StudioImageBoardAffine {
  const scaleX = target.width / Math.max(1e-6, view.width * base.width);
  const scaleY = target.height / Math.max(1e-6, view.height * base.height);
  return multiplyAffine(
    scaleAffine(scaleX, scaleY),
    translateAffine(-view.x * base.width, -view.y * base.height)
  );
}

/** The four corners in normalized board units, clockwise from top-left. */
export function boxCorners(
  box: StudioImageBoardBox,
  base: StudioImageBoardSize
): StudioImageBoardPoint[] {
  const size = boxSizePx(box, base);
  const local = boxLocalTransform(box, base);
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((corner) => {
    const point = applyAffine(local, corner);
    return { x: point.x / base.width, y: point.y / base.height };
  });
}

/** Axis-aligned bounds of a (possibly rotated) box, normalized. */
export function boxBounds(
  box: StudioImageBoardBox,
  base: StudioImageBoardSize
): StudioImageBoardFrame {
  const corners = boxCorners(box, base);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export function unionFrames(frames: StudioImageBoardFrame[]): StudioImageBoardFrame {
  if (frames.length === 0) {
    return { ...STUDIO_IMAGE_BOARD_UNIT_FRAME };
  }
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * `frame` moved the least distance that puts it inside `within`. On an axis
 * where it is too large to fit, it is centred instead.
 */
export function keepFrameWithin(
  frame: StudioImageBoardFrame,
  within: StudioImageBoardFrame
): StudioImageBoardFrame {
  const along = (start: number, extent: number, from: number, room: number): number =>
    extent > room ? from + (room - extent) / 2 : Math.min(Math.max(start, from), from + room - extent);
  return {
    ...frame,
    x: along(frame.x, frame.width, within.x, within.width),
    y: along(frame.y, frame.height, within.y, within.height),
  };
}

export function padFrame(frame: StudioImageBoardFrame, ratio: number): StudioImageBoardFrame {
  const padX = frame.width * ratio;
  const padY = frame.height * ratio;
  return {
    x: frame.x - padX,
    y: frame.y - padY,
    width: frame.width + padX * 2,
    height: frame.height + padY * 2,
  };
}

/** A normalized point expressed in the box's own unrotated pixel frame. */
export function pointInBoxLocal(
  box: StudioImageBoardBox,
  base: StudioImageBoardSize,
  point: StudioImageBoardPoint
): StudioImageBoardPoint {
  const inverse = invertAffine(boxLocalTransform(box, base));
  const pixel = { x: point.x * base.width, y: point.y * base.height };
  return inverse ? applyAffine(inverse, pixel) : pixel;
}

/** `slopPx` widens the hit area so thin boxes stay grabbable. */
export function hitTestBox(
  box: StudioImageBoardBox,
  base: StudioImageBoardSize,
  point: StudioImageBoardPoint,
  slopPx: number = 0
): boolean {
  const size = boxSizePx(box, base);
  const local = pointInBoxLocal(box, base, point);
  return (
    Math.abs(local.x) <= size.width / 2 + slopPx &&
    Math.abs(local.y) <= size.height / 2 + slopPx
  );
}

/**
 * Drags one handle of `box` to `pointer` while the opposite side stays put,
 * exactly like a design tool: the anchor is fixed in base pixels, so the
 * result is correct for rotated boxes too.
 */
export function resizeBox(
  box: StudioImageBoardBox,
  base: StudioImageBoardSize,
  handle: StudioImageBoardHandle,
  pointer: StudioImageBoardPoint,
  options: { keepAspect?: boolean; minPx?: number } = {}
): StudioImageBoardBox {
  const size = boxSizePx(box, base);
  const minPx = Math.max(1, options.minPx ?? 4);
  const local = pointInBoxLocal(box, base, pointer);
  const anchor = { x: (-handle.x * size.width) / 2, y: (-handle.y * size.height) / 2 };

  let width = handle.x === 0 ? size.width : Math.max(minPx, handle.x * (local.x - anchor.x));
  let height = handle.y === 0 ? size.height : Math.max(minPx, handle.y * (local.y - anchor.y));
  if (options.keepAspect && size.width > 0 && size.height > 0) {
    const aspect = size.width / size.height;
    if (handle.x !== 0 && handle.y !== 0) {
      // Follow whichever axis the pointer pushed further.
      if (width / size.width >= height / size.height) {
        height = width / aspect;
      } else {
        width = height * aspect;
      }
    } else if (handle.x !== 0) {
      height = width / aspect;
    } else if (handle.y !== 0) {
      width = height * aspect;
    }
  }

  const centerLocal = {
    x: handle.x === 0 ? 0 : anchor.x + (handle.x * width) / 2,
    y: handle.y === 0 ? 0 : anchor.y + (handle.y * height) / 2,
  };
  const center = applyAffine(boxLocalTransform(box, base), centerLocal);
  return {
    x: (center.x - width / 2) / base.width,
    y: (center.y - height / 2) / base.height,
    width: width / base.width,
    height: height / base.height,
    rotation: box.rotation,
  };
}

/** Angle in degrees of `pointer` around the box centre; 0 points straight up. */
export function rotationToward(
  box: StudioImageBoardFrame,
  base: StudioImageBoardSize,
  pointer: StudioImageBoardPoint
): number {
  const center = boxCenterPx(box, base);
  const dx = pointer.x * base.width - center.x;
  const dy = pointer.y * base.height - center.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    return 0;
  }
  return normalizeRotation((Math.atan2(dy, dx) * 180) / Math.PI + 90);
}

/** A box spanning two points along its own x axis: how arrows are drawn. */
export function boxBetweenPoints(
  start: StudioImageBoardPoint,
  end: StudioImageBoardPoint,
  base: StudioImageBoardSize,
  thicknessPx: number
): StudioImageBoardBox {
  const startPx = { x: start.x * base.width, y: start.y * base.height };
  const endPx = { x: end.x * base.width, y: end.y * base.height };
  const length = Math.max(1, Math.hypot(endPx.x - startPx.x, endPx.y - startPx.y));
  const center = { x: (startPx.x + endPx.x) / 2, y: (startPx.y + endPx.y) / 2 };
  return {
    x: (center.x - length / 2) / base.width,
    y: (center.y - thicknessPx / 2) / base.height,
    width: length / base.width,
    height: thicknessPx / base.height,
    rotation: normalizeRotation((Math.atan2(endPx.y - startPx.y, endPx.x - startPx.x) * 180) / Math.PI),
  };
}

export function frameFromPoints(
  start: StudioImageBoardPoint,
  end: StudioImageBoardPoint
): StudioImageBoardFrame {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** True when two boxes overlap or touch, within `slopPx` base pixels, whatever their rotation. */
export function boxesTouch(
  a: StudioImageBoardBox,
  b: StudioImageBoardBox,
  base: StudioImageBoardSize,
  slopPx: number = 0.5
): boolean {
  const cornersPx = (box: StudioImageBoardBox): StudioImageBoardPoint[] =>
    boxCorners(box, base).map((corner) => ({ x: corner.x * base.width, y: corner.y * base.height }));
  const first = cornersPx(a);
  const second = cornersPx(b);
  // Separating axes: two rectangles are apart only if one of their four edge
  // directions shows a gap between them.
  for (const corners of [first, second]) {
    for (let index = 0; index < 2; index += 1) {
      const edge = { x: corners[index + 1].x - corners[index].x, y: corners[index + 1].y - corners[index].y };
      const length = Math.hypot(edge.x, edge.y);
      if (length <= 0) {
        continue;
      }
      const axis = { x: edge.x / length, y: edge.y / length };
      const span = (points: StudioImageBoardPoint[]): [number, number] => {
        const along = points.map((point) => point.x * axis.x + point.y * axis.y);
        return [Math.min(...along), Math.max(...along)];
      };
      const [firstMin, firstMax] = span(first);
      const [secondMin, secondMax] = span(second);
      if (firstMin > secondMax + slopPx || secondMin > firstMax + slopPx) {
        return false;
      }
    }
  }
  return true;
}

/** Edges a box may line up with while it is moved, resized or drawn; normalized. */
export type StudioImageBoardSnapLines = { x: readonly number[]; y: readonly number[] };

export type StudioImageBoardSnap<T> = {
  value: T;
  /** The line landed on along each axis, for drawing a guide; null when free. */
  guideX: number | null;
  guideY: number | null;
};

function nearestLine(value: number, lines: readonly number[], reach: number): number | null {
  let best: number | null = null;
  for (const line of lines) {
    const distance = Math.abs(line - value);
    if (distance <= reach && (best === null || distance < Math.abs(best - value))) {
      best = line;
    }
  }
  return best;
}

/** Snaps a point to the nearest line on each axis independently. */
export function snapPointToLines(
  point: StudioImageBoardPoint,
  lines: StudioImageBoardSnapLines,
  reach: StudioImageBoardPoint
): StudioImageBoardSnap<StudioImageBoardPoint> {
  const guideX = nearestLine(point.x, lines.x, reach.x);
  const guideY = nearestLine(point.y, lines.y, reach.y);
  return { value: { x: guideX ?? point.x, y: guideY ?? point.y }, guideX, guideY };
}

/** Moves a frame, without resizing it, so its nearest edge on each axis lands on a line. */
export function snapFrameMove(
  frame: StudioImageBoardFrame,
  lines: StudioImageBoardSnapLines,
  reach: StudioImageBoardPoint
): StudioImageBoardSnap<StudioImageBoardFrame> {
  const along = (start: number, extent: number, candidates: readonly number[], within: number) => {
    const near = nearestLine(start, candidates, within);
    const far = nearestLine(start + extent, candidates, within);
    if (near !== null && (far === null || Math.abs(near - start) <= Math.abs(far - start - extent))) {
      return { start: near, guide: near };
    }
    return far !== null ? { start: far - extent, guide: far } : { start, guide: null };
  };
  const x = along(frame.x, frame.width, lines.x, reach.x);
  const y = along(frame.y, frame.height, lines.y, reach.y);
  return { value: { ...frame, x: x.start, y: y.start }, guideX: x.guide, guideY: y.guide };
}

/** Lands the edges a resize handle drags on the nearest lines; the opposite edges stay put. */
export function snapFrameResize(
  frame: StudioImageBoardFrame,
  handle: StudioImageBoardHandle,
  lines: StudioImageBoardSnapLines,
  reach: StudioImageBoardPoint,
  minSize: StudioImageBoardSize
): StudioImageBoardSnap<StudioImageBoardFrame> {
  const along = (
    start: number,
    extent: number,
    side: -1 | 0 | 1,
    candidates: readonly number[],
    within: number,
    least: number
  ) => {
    if (side === 0) {
      return { start, extent, guide: null };
    }
    const line = nearestLine(side < 0 ? start : start + extent, candidates, within);
    const next = line === null ? extent : side < 0 ? start + extent - line : line - start;
    if (line === null || next < least) {
      return { start, extent, guide: null };
    }
    return { start: side < 0 ? line : start, extent: next, guide: line };
  };
  const x = along(frame.x, frame.width, handle.x, lines.x, reach.x, minSize.width);
  const y = along(frame.y, frame.height, handle.y, lines.y, reach.y, minSize.height);
  return {
    value: { x: x.start, y: y.start, width: x.extent, height: y.extent },
    guideX: x.guide,
    guideY: y.guide,
  };
}

export function framesOverlap(a: StudioImageBoardFrame, b: StudioImageBoardFrame): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/** The smallest convex outline around `points`, in order around it. */
export function convexHull(points: readonly StudioImageBoardPoint[]): StudioImageBoardPoint[] {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) {
    return sorted;
  }
  const turn = (o: StudioImageBoardPoint, a: StudioImageBoardPoint, b: StudioImageBoardPoint): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  // Andrew's monotone chain: one pass along the bottom, one back along the top.
  const half = (ordered: readonly StudioImageBoardPoint[]): StudioImageBoardPoint[] => {
    const chain: StudioImageBoardPoint[] = [];
    for (const point of ordered) {
      while (chain.length >= 2 && turn(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half(sorted.slice().reverse())];
}
