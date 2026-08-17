import type { StudioShapeInstance } from "../../../studio/types";
import type { LinkPoint } from "../connections-v3/LinkGeometry";
import { buildStudioShapeOutline } from "./StudioShapeOutline";

/**
 * Diagram arrow geometry. Shapes have no ports, so an arrow has no pinned
 * anchor; it is derived from the two shapes every time either one moves.
 *
 * Deriving it well is what separates a diagram from a pile of line segments:
 *
 *   side snap  -> the dominant axis picks one side (N/S/E/W) for both ends, so
 *                 arrows leave and enter squarely instead of at a random angle
 *   ray cast   -> the anchor is where that ray leaves the kind's own outline,
 *                 so a diamond and a cylinder each get their true border
 *   straight   -> near-aligned shapes snap to one exact line; only a genuine
 *                 diagonal is drawn as a curve
 *   fan        -> arrows sharing a pair of shapes spread apart instead of
 *                 stacking on the same pixels
 *   end gap    -> the head stops just short of the border it points at
 */

const STUDIO_SHAPE_ARROW_HEAD_LENGTH = 10;
const STUDIO_SHAPE_ARROW_HEAD_HALF_WIDTH = 4.5;
const STUDIO_SHAPE_ARROW_END_GAP = 3;
const STUDIO_SHAPE_ARROW_FAN_SPACING = 16;
const STUDIO_SHAPE_ARROW_STRAIGHT_SNAP_PX = 8;
const STUDIO_SHAPE_ARROW_MIN_BEND = 24;
const STUDIO_SHAPE_ARROW_MAX_BEND = 140;
/** How far off-center an anchor may slide before it would leave the outline. */
const STUDIO_SHAPE_ANCHOR_SPREAD_RATIO = 0.35;

/** Position of one arrow inside the set of arrows joining the same two shapes. */
export type StudioShapeArrowFan = { index: number; count: number };

export type StudioShapeArrowPath = {
  line: string;
  head: string;
  start: LinkPoint;
  end: LinkPoint;
  /** Point on the drawn line halfway along it; where a label sits. */
  mid: LinkPoint;
};

export function studioShapeCenter(shape: StudioShapeInstance): LinkPoint {
  return {
    x: shape.position.x + shape.size.width / 2,
    y: shape.position.y + shape.size.height / 2,
  };
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function format(value: number): string {
  return value.toFixed(2);
}

/** The shape's outline in canvas coordinates. */
function outlinePolygon(shape: StudioShapeInstance): LinkPoint[] {
  return buildStudioShapeOutline(shape.shape, shape.size).polygon.map((point) => ({
    x: point.x + shape.position.x,
    y: point.y + shape.position.y,
  }));
}

/** Nearest crossing of the ray `origin + t·direction` (t > 0) with the outline. */
function rayHit(polygon: LinkPoint[], origin: LinkPoint, direction: LinkPoint): LinkPoint | null {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const denominator = cross(direction.x, direction.y, edgeX, edgeY);
    if (Math.abs(denominator) < 1e-9) {
      continue;
    }
    const toEdgeX = a.x - origin.x;
    const toEdgeY = a.y - origin.y;
    const t = cross(toEdgeX, toEdgeY, edgeX, edgeY) / denominator;
    const u = cross(toEdgeX, toEdgeY, direction.x, direction.y) / denominator;
    if (t > 0 && u >= 0 && u <= 1 && t < nearest) {
      nearest = t;
    }
  }
  if (!Number.isFinite(nearest)) {
    return null;
  }
  return { x: origin.x + direction.x * nearest, y: origin.y + direction.y * nearest };
}

/** Bounding-box crossing: the fallback when an origin sits outside its outline. */
function boundingBoxHit(
  shape: StudioShapeInstance,
  origin: LinkPoint,
  direction: LinkPoint
): LinkPoint {
  const left = shape.position.x;
  const top = shape.position.y;
  const right = left + shape.size.width;
  const bottom = top + shape.size.height;
  const spans: number[] = [];
  if (direction.x !== 0) {
    spans.push(((direction.x > 0 ? right : left) - origin.x) / direction.x);
  }
  if (direction.y !== 0) {
    spans.push(((direction.y > 0 ? bottom : top) - origin.y) / direction.y);
  }
  const t = spans.filter((span) => span > 0).sort((a, b) => a - b)[0] ?? 0;
  return { x: origin.x + direction.x * t, y: origin.y + direction.y * t };
}

function anchorPoint(
  shape: StudioShapeInstance,
  origin: LinkPoint,
  direction: LinkPoint
): LinkPoint {
  return rayHit(outlinePolygon(shape), origin, direction) ?? boundingBoxHit(shape, origin, direction);
}

/**
 * Point where the ray from the shape's center toward `towards` leaves the
 * outline. Falls back to the center when the two points coincide.
 */
export function studioShapeBorderPoint(
  shape: StudioShapeInstance,
  towards: LinkPoint
): LinkPoint {
  const center = studioShapeCenter(shape);
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return center;
  }
  return anchorPoint(shape, center, { x: dx / length, y: dy / length });
}

function buildHeadPath(tip: LinkPoint, direction: LinkPoint): string {
  const backX = tip.x - direction.x * STUDIO_SHAPE_ARROW_HEAD_LENGTH;
  const backY = tip.y - direction.y * STUDIO_SHAPE_ARROW_HEAD_LENGTH;
  const wingX = -direction.y * STUDIO_SHAPE_ARROW_HEAD_HALF_WIDTH;
  const wingY = direction.x * STUDIO_SHAPE_ARROW_HEAD_HALF_WIDTH;
  return [
    `M ${format(tip.x)} ${format(tip.y)}`,
    `L ${format(backX + wingX)} ${format(backY + wingY)}`,
    `L ${format(backX - wingX)} ${format(backY - wingY)}`,
    "Z",
  ].join(" ");
}

function straightLine(start: LinkPoint, end: LinkPoint): string {
  return `M ${format(start.x)} ${format(start.y)} L ${format(end.x)} ${format(end.y)}`;
}

function midpoint(start: LinkPoint, end: LinkPoint): LinkPoint {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

function curvedLine(
  start: LinkPoint,
  end: LinkPoint,
  direction: LinkPoint
): { d: string; mid: LinkPoint } {
  const span = Math.abs(direction.x !== 0 ? end.x - start.x : end.y - start.y);
  const bend = clamp(span * 0.4, STUDIO_SHAPE_ARROW_MIN_BEND, STUDIO_SHAPE_ARROW_MAX_BEND);
  const firstX = start.x + direction.x * bend;
  const firstY = start.y + direction.y * bend;
  const secondX = end.x - direction.x * bend;
  const secondY = end.y - direction.y * bend;
  return {
    d: [
      `M ${format(start.x)} ${format(start.y)}`,
      `C ${format(firstX)} ${format(firstY)}`,
      `${format(secondX)} ${format(secondY)}`,
      `${format(end.x)} ${format(end.y)}`,
    ].join(" "),
    // The cubic evaluated at t = 0.5, so the label sits on the drawn curve.
    mid: {
      x: (start.x + 3 * firstX + 3 * secondX + end.x) / 8,
      y: (start.y + 3 * firstY + 3 * secondY + end.y) / 8,
    },
  };
}

function fanOffset(fan: StudioShapeArrowFan | undefined): number {
  if (!fan || fan.count <= 1) {
    return 0;
  }
  return (fan.index - (fan.count - 1) / 2) * STUDIO_SHAPE_ARROW_FAN_SPACING;
}

/** Slides an anchor origin off-center without letting it leave the outline. */
function spreadOrigin(
  shape: StudioShapeInstance,
  center: LinkPoint,
  horizontal: boolean,
  offset: number
): LinkPoint {
  const extent = (horizontal ? shape.size.height : shape.size.width) / 2;
  const limit = extent * STUDIO_SHAPE_ANCHOR_SPREAD_RATIO;
  const applied = clamp(offset, -limit, limit);
  return horizontal
    ? { x: center.x, y: center.y + applied }
    : { x: center.x + applied, y: center.y };
}

/**
 * Arrow between two shapes. `fan` spreads arrows that share the same pair of
 * shapes — without it the two directions of a round trip draw the same pixels.
 */
export function buildStudioShapeArrowPath(
  from: StudioShapeInstance,
  to: StudioShapeInstance,
  fan?: StudioShapeArrowFan
): StudioShapeArrowPath {
  const fromCenter = studioShapeCenter(from);
  const toCenter = studioShapeCenter(to);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const direction: LinkPoint = horizontal
    ? { x: dx >= 0 ? 1 : -1, y: 0 }
    : { x: 0, y: dy >= 0 ? 1 : -1 };

  const offset = fanOffset(fan);
  let fromOrigin = spreadOrigin(from, fromCenter, horizontal, offset);
  let toOrigin = spreadOrigin(to, toCenter, horizontal, offset);

  // Shapes that are within a few pixels of aligned are meant to be aligned:
  // share one exact line rather than drawing a barely visible kink.
  const drift = horizontal ? fromOrigin.y - toOrigin.y : fromOrigin.x - toOrigin.x;
  const aligned = Math.abs(drift) <= STUDIO_SHAPE_ARROW_STRAIGHT_SNAP_PX;
  if (aligned) {
    const shared = horizontal
      ? (fromOrigin.y + toOrigin.y) / 2
      : (fromOrigin.x + toOrigin.x) / 2;
    const originAt = (shape: StudioShapeInstance, center: LinkPoint): LinkPoint =>
      spreadOrigin(shape, center, horizontal, shared - (horizontal ? center.y : center.x));
    fromOrigin = originAt(from, fromCenter);
    toOrigin = originAt(to, toCenter);
  }

  const start = anchorPoint(from, fromOrigin, direction);
  const border = anchorPoint(to, toOrigin, { x: -direction.x, y: -direction.y });
  const end = {
    x: border.x - direction.x * STUDIO_SHAPE_ARROW_END_GAP,
    y: border.y - direction.y * STUDIO_SHAPE_ARROW_END_GAP,
  };

  const curve = aligned ? null : curvedLine(start, end, direction);
  return {
    line: curve ? curve.d : straightLine(start, end),
    head: buildHeadPath(end, direction),
    start,
    end,
    mid: curve ? curve.mid : midpoint(start, end),
  };
}

/** In-flight arrow: anchored on the source shape, chasing the cursor. */
export function buildStudioShapeArrowPreviewPath(
  from: StudioShapeInstance,
  cursor: LinkPoint
): StudioShapeArrowPath {
  const center = studioShapeCenter(from);
  const dx = cursor.x - center.x;
  const dy = cursor.y - center.y;
  const length = Math.hypot(dx, dy);
  const direction: LinkPoint =
    length < 1e-6 ? { x: 1, y: 0 } : { x: dx / length, y: dy / length };
  const start = studioShapeBorderPoint(from, cursor);
  return {
    line: straightLine(start, cursor),
    head: buildHeadPath(cursor, direction),
    start,
    end: cursor,
    mid: midpoint(start, cursor),
  };
}
