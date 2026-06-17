import type { StudioNodeInstance } from "../../../studio/types";
import { resolveStudioGraphNodeWidth } from "../graph-v3/StudioGraphNodeGeometry";

/**
 * Horizontal inset (world px) of a port pin's centre from the card's vertical
 * edge. Used only as a fallback before a pin has been measured: input pins sit
 * just inside the left edge, output pins just inside the right edge.
 */
export const STUDIO_PORT_EDGE_INSET = 14;

/**
 * Vertical offset (world px) of a port pin's centre from the card's top, used
 * only as a fallback before a pin has been measured. Ports sit just below the
 * card header; the measured offset replaces this on the first laid-out render.
 */
export const STUDIO_PORT_FALLBACK_LOCAL_Y = 52;

export type StudioPortAnchorDirection = "in" | "out";

/** A port pin's centre, in card-local world px (relative to the card's top-left). */
export type StudioPortLocalOffset = { dx: number; dy: number };

/**
 * Resolve a port's anchor point in canvas WORLD coordinates from the data model.
 *
 * The horizontal position is fully determined by the node's world position and
 * width (inputs on the left edge, outputs on the right). The vertical position —
 * which depends on the card's internal layout — comes from a measured offset
 * when one is available, otherwise a constant so an edge ALWAYS has a finite
 * anchor and is never dropped.
 *
 * This is deliberately independent of live DOM measurement at render time: the
 * node cards are positioned from the same `node.position`, so edges and cards
 * stay in lockstep regardless of paint timing, visibility, or whether a pin
 * element can be found by a selector. Measurement only refines the vertical
 * offset to land on the exact pin.
 */
export function resolveStudioPortAnchorWorldPoint(params: {
  node: Pick<StudioNodeInstance, "position" | "kind" | "config">;
  direction: StudioPortAnchorDirection;
  measuredOffset?: StudioPortLocalOffset | null;
}): { x: number; y: number } {
  const { node, direction, measuredOffset } = params;
  const width = resolveStudioGraphNodeWidth(node);
  const dx =
    measuredOffset?.dx ??
    (direction === "out" ? width - STUDIO_PORT_EDGE_INSET : STUDIO_PORT_EDGE_INSET);
  const dy = measuredOffset?.dy ?? STUDIO_PORT_FALLBACK_LOCAL_Y;
  return { x: node.position.x + dx, y: node.position.y + dy };
}
