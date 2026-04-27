export type LinkPoint = {
  x: number;
  y: number;
};

export type CubicLinkCurve = {
  path: string;
  start: LinkPoint;
  end: LinkPoint;
  controlStart: LinkPoint;
  controlEnd: LinkPoint;
  handleDistance: number;
  startAngleDeg: number;
  endAngleDeg: number;
};

export type CubicLinkCurveOptions = {
  tension?: number;
};

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function buildCubicLinkCurve(
  start: LinkPoint,
  end: LinkPoint,
  options?: CubicLinkCurveOptions
): CubicLinkCurve {
  const tension = Math.max(0, Math.min(1, options?.tension ?? 1));
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const direction = dx >= 0 ? 1 : -1;

  const horizontalDistance = Math.abs(dx);
  const verticalDistance = Math.abs(dy);
  const baseHandleDistance = Math.min(
    260,
    Math.max(56, horizontalDistance * 0.42 + verticalDistance * 0.2)
  );
  const handleDistance = baseHandleDistance * tension;

  const controlStart: LinkPoint = {
    x: start.x + handleDistance * direction,
    y: start.y + dy * 0.2,
  };
  const controlEnd: LinkPoint = {
    x: end.x - handleDistance * direction,
    y: end.y - dy * 0.2,
  };

  return {
    path: `M ${start.x} ${start.y} C ${controlStart.x} ${controlStart.y}, ${controlEnd.x} ${controlEnd.y}, ${end.x} ${end.y}`,
    start,
    end,
    controlStart,
    controlEnd,
    handleDistance,
    startAngleDeg: toDegrees(Math.atan2(controlStart.y - start.y, controlStart.x - start.x)),
    endAngleDeg: toDegrees(Math.atan2(end.y - controlEnd.y, end.x - controlEnd.x)),
  };
}

export function curveTangentAtEnd(curve: CubicLinkCurve): number {
  return Math.atan2(curve.end.y - curve.controlEnd.y, curve.end.x - curve.controlEnd.x);
}

export function buildChevronPath(end: LinkPoint, tangentRad: number, size: number): string {
  const backAngleA = tangentRad + Math.PI - Math.PI / 6;
  const backAngleB = tangentRad + Math.PI + Math.PI / 6;
  const ax = end.x + Math.cos(backAngleA) * size;
  const ay = end.y + Math.sin(backAngleA) * size;
  const bx = end.x + Math.cos(backAngleB) * size;
  const by = end.y + Math.sin(backAngleB) * size;
  return `M ${ax.toFixed(2)} ${ay.toFixed(2)} L ${end.x} ${end.y} L ${bx.toFixed(2)} ${by.toFixed(2)}`;
}
