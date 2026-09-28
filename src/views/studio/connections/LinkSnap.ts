import type { PortAnchor } from "./StudioLinkStore";

export type SnapCandidate = {
  portKey: string;
  nodeId: string;
  portId: string;
  center: { x: number; y: number };
  compatible: boolean;
};

export type SnapResolveInput = {
  cursorWorld: { x: number; y: number };
  candidates: SnapCandidate[];
  radius: number;
};

export type SnapResolveResult = {
  snapTarget: PortAnchor;
  confidence: number;
  magnetisedCursor: { x: number; y: number };
};

const MAGNET_LERP = 0.6;

export function resolveSnapTarget(input: SnapResolveInput): SnapResolveResult | null {
  const { cursorWorld, candidates, radius } = input;
  if (!Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  let best: { candidate: SnapCandidate; distance: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.compatible) {
      continue;
    }
    const dx = candidate.center.x - cursorWorld.x;
    const dy = candidate.center.y - cursorWorld.y;
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  if (!best) {
    return null;
  }
  const confidence = Math.max(0, Math.min(1, 1 - best.distance / radius));
  const magnetisedCursor = {
    x: cursorWorld.x + (best.candidate.center.x - cursorWorld.x) * MAGNET_LERP,
    y: cursorWorld.y + (best.candidate.center.y - cursorWorld.y) * MAGNET_LERP,
  };
  return {
    snapTarget: { nodeId: best.candidate.nodeId, portId: best.candidate.portId },
    confidence,
    magnetisedCursor,
  };
}
