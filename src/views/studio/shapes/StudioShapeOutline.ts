import type { StudioShapeKind } from "../../../studio/types";

/**
 * Per-kind shape outlines, in local coordinates: (0,0) is the shape's top-left
 * corner and (width,height) its bottom-right.
 *
 * One builder serves both jobs a shape has, so the drawn silhouette and the
 * arrow anchoring can never disagree:
 *
 *   body    -> the filled, stroked silhouette drawn into the shape's <svg>
 *   detail  -> a stroke-only interior line (cylinder rim, sticky-note fold)
 *   polygon -> the silhouette as a closed polygon, which is what arrows
 *              ray-cast against to find where they meet the shape
 *
 * A CSS border can only ever draw a rounded box, which is why the body lives
 * in SVG: a diamond, a cylinder and a folded note are all outline, not chrome.
 */

export type StudioShapeOutlinePoint = { x: number; y: number };

export type StudioShapeOutlineSize = { width: number; height: number };

export type StudioShapeOutline = {
  body: string;
  detail: string;
  polygon: StudioShapeOutlinePoint[];
};

/** Corner rounding of the plain rectangle; the pill rounds to a half-height. */
const RECTANGLE_CORNER_RADIUS = 7;
const ELLIPSE_POLYGON_SEGMENTS = 48;
const ARC_POLYGON_SEGMENTS = 12;

function format(value: number): string {
  return value.toFixed(2);
}

function polygonPath(points: readonly StudioShapeOutlinePoint[]): string {
  const [first, ...rest] = points;
  const head = `M ${format(first.x)} ${format(first.y)}`;
  const tail = rest.map((point) => `L ${format(point.x)} ${format(point.y)}`).join(" ");
  return `${head} ${tail} Z`;
}

/** Samples an elliptical arc, angles measured in screen space (y grows down). */
function sampleArc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fromAngle: number,
  toAngle: number,
  segments: number
): StudioShapeOutlinePoint[] {
  const points: StudioShapeOutlinePoint[] = [];
  for (let step = 0; step <= segments; step += 1) {
    const angle = fromAngle + ((toAngle - fromAngle) * step) / segments;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return points;
}

function roundedRectOutline(
  width: number,
  height: number,
  radius: number
): StudioShapeOutline {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r <= 0.5) {
    const corners = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
    return { body: polygonPath(corners), detail: "", polygon: corners };
  }

  const body = [
    `M ${format(r)} 0`,
    `L ${format(width - r)} 0`,
    `A ${format(r)} ${format(r)} 0 0 1 ${format(width)} ${format(r)}`,
    `L ${format(width)} ${format(height - r)}`,
    `A ${format(r)} ${format(r)} 0 0 1 ${format(width - r)} ${format(height)}`,
    `L ${format(r)} ${format(height)}`,
    `A ${format(r)} ${format(r)} 0 0 1 0 ${format(height - r)}`,
    `L 0 ${format(r)}`,
    `A ${format(r)} ${format(r)} 0 0 1 ${format(r)} 0`,
    "Z",
  ].join(" ");

  const half = Math.PI / 2;
  const polygon = [
    ...sampleArc(width - r, r, r, r, -half, 0, ARC_POLYGON_SEGMENTS),
    ...sampleArc(width - r, height - r, r, r, 0, half, ARC_POLYGON_SEGMENTS),
    ...sampleArc(r, height - r, r, r, half, Math.PI, ARC_POLYGON_SEGMENTS),
    ...sampleArc(r, r, r, r, Math.PI, Math.PI * 1.5, ARC_POLYGON_SEGMENTS),
  ];
  return { body, detail: "", polygon };
}

function ellipseOutline(width: number, height: number): StudioShapeOutline {
  const rx = width / 2;
  const ry = height / 2;
  const body = [
    `M 0 ${format(ry)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 ${format(width)} ${format(ry)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 0 ${format(ry)}`,
    "Z",
  ].join(" ");
  const polygon = sampleArc(
    rx,
    ry,
    rx,
    ry,
    0,
    Math.PI * 2 - (Math.PI * 2) / ELLIPSE_POLYGON_SEGMENTS,
    ELLIPSE_POLYGON_SEGMENTS - 1
  );
  return { body, detail: "", polygon };
}

function cylinderOutline(width: number, height: number): StudioShapeOutline {
  const rx = width / 2;
  const ry = Math.max(6, Math.min(height * 0.16, 26, height / 3));
  const body = [
    `M 0 ${format(ry)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 ${format(width)} ${format(ry)}`,
    `L ${format(width)} ${format(height - ry)}`,
    `A ${format(rx)} ${format(ry)} 0 0 1 0 ${format(height - ry)}`,
    "Z",
  ].join(" ");
  // The rim's near half: what makes a stack of ellipses read as a cylinder.
  const detail = [
    `M 0 ${format(ry)}`,
    `A ${format(rx)} ${format(ry)} 0 0 0 ${format(width)} ${format(ry)}`,
  ].join(" ");
  const polygon = [
    ...sampleArc(rx, ry, rx, ry, Math.PI, Math.PI * 2, ARC_POLYGON_SEGMENTS),
    ...sampleArc(rx, height - ry, rx, ry, 0, Math.PI, ARC_POLYGON_SEGMENTS),
  ];
  return { body, detail, polygon };
}

function noteOutline(width: number, height: number): StudioShapeOutline {
  const cut = Math.min(
    Math.max(10, Math.min(width, height) * 0.28),
    26,
    width / 2,
    height / 2
  );
  const polygon = [
    { x: 0, y: 0 },
    { x: width - cut, y: 0 },
    { x: width, y: cut },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const detail = [
    `M ${format(width - cut)} 0`,
    `L ${format(width - cut)} ${format(cut)}`,
    `L ${format(width)} ${format(cut)}`,
  ].join(" ");
  return { body: polygonPath(polygon), detail, polygon };
}

function diamondOutline(width: number, height: number): StudioShapeOutline {
  const polygon = [
    { x: width / 2, y: 0 },
    { x: width, y: height / 2 },
    { x: width / 2, y: height },
    { x: 0, y: height / 2 },
  ];
  return { body: polygonPath(polygon), detail: "", polygon };
}

function hexagonOutline(width: number, height: number): StudioShapeOutline {
  const inset = Math.min(width * 0.22, width / 2);
  const polygon = [
    { x: inset, y: 0 },
    { x: width - inset, y: 0 },
    { x: width, y: height / 2 },
    { x: width - inset, y: height },
    { x: inset, y: height },
    { x: 0, y: height / 2 },
  ];
  return { body: polygonPath(polygon), detail: "", polygon };
}

export function buildStudioShapeOutline(
  kind: StudioShapeKind,
  size: StudioShapeOutlineSize
): StudioShapeOutline {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  switch (kind) {
    case "ellipse":
      return ellipseOutline(width, height);
    case "diamond":
      return diamondOutline(width, height);
    case "pill":
      return roundedRectOutline(width, height, Math.min(width, height) / 2);
    case "cylinder":
      return cylinderOutline(width, height);
    case "note":
      return noteOutline(width, height);
    case "hexagon":
      return hexagonOutline(width, height);
    default:
      return roundedRectOutline(width, height, RECTANGLE_CORNER_RADIUS);
  }
}
