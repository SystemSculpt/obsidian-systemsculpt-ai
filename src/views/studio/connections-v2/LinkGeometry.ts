export type LinkPoint = {
  x: number;
  y: number;
};

export type CubicLinkCurve = {
  path: string;
  startAngleDeg: number;
  endAngleDeg: number;
};

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function buildCubicLinkCurve(start: LinkPoint, end: LinkPoint): CubicLinkCurve {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const direction = dx >= 0 ? 1 : -1;

  const horizontalDistance = Math.abs(dx);
  const verticalDistance = Math.abs(dy);
  const handleDistance = Math.min(
    260,
    Math.max(56, horizontalDistance * 0.42 + verticalDistance * 0.2)
  );

  const controlStart = {
    x: start.x + handleDistance * direction,
    y: start.y + dy * 0.2,
  };
  const controlEnd = {
    x: end.x - handleDistance * direction,
    y: end.y - dy * 0.2,
  };

  return {
    path: `M ${start.x} ${start.y} C ${controlStart.x} ${controlStart.y}, ${controlEnd.x} ${controlEnd.y}, ${end.x} ${end.y}`,
    startAngleDeg: toDegrees(Math.atan2(controlStart.y - start.y, controlStart.x - start.x)),
    endAngleDeg: toDegrees(Math.atan2(end.y - controlEnd.y, end.x - controlEnd.x)),
  };
}
