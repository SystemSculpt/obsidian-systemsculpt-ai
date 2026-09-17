import type { StudioNodeDefinition, StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import {
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
  STUDIO_GRAPH_DEFAULT_NODE_HEIGHT,
  STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
} from "../../../studio/StudioNodeGeometry";

/** Horizontal breathing room between a selected node and the one added beside it. */
export const STUDIO_NEW_NODE_GAP = 64;
const MAX_OVERLAP_STEPS = 32;

export type StudioNodeMeasure = (node: StudioNodeInstance) => { width: number; height: number } | null;

export type StudioNewNodePlacementInput = {
  project: StudioProjectV1;
  definition?: Pick<StudioNodeDefinition, "kind">;
  /** Currently selected node IDs; a single selection anchors the new node. */
  selectedNodeIds: readonly string[];
  /** World-space viewport centre, or null when no viewport is bound. */
  viewportCenter: { x: number; y: number } | null;
  /** Rendered card size in world px; stored size or kind defaults apply otherwise. */
  measure?: StudioNodeMeasure;
};

type Rect = { x: number; y: number; width: number; height: number };

function nodeRect(node: StudioNodeInstance, measure?: StudioNodeMeasure): Rect {
  const measured = measure?.(node);
  if (measured && measured.width > 0 && measured.height > 0) {
    return { x: node.position.x, y: node.position.y, width: measured.width, height: measured.height };
  }
  const width = node.size?.width ?? resolveStudioGraphNodeWidth(node) ?? STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
  const height = node.size?.height ?? Math.max(STUDIO_GRAPH_DEFAULT_NODE_HEIGHT, resolveStudioGraphNodeMinHeight(node));
  return { x: node.position.x, y: node.position.y, width, height };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function estimateNewNodeSize(definition?: Pick<StudioNodeDefinition, "kind">): { width: number; height: number } {
  const sample = { kind: definition?.kind || "studio.input", config: {} } as Pick<StudioNodeInstance, "kind" | "config">;
  return {
    width: resolveStudioGraphNodeWidth(sample) || STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
    height: Math.max(STUDIO_GRAPH_DEFAULT_NODE_HEIGHT, resolveStudioGraphNodeMinHeight(sample)),
  };
}

/** Slide a candidate downward until it stops overlapping existing nodes. */
function settle(candidate: Rect, nodes: readonly StudioNodeInstance[], measure?: StudioNodeMeasure): { x: number; y: number } {
  const rects = nodes.map(node => nodeRect(node, measure));
  let y = candidate.y;
  for (let step = 0; step < MAX_OVERLAP_STEPS; step += 1) {
    const probe = { ...candidate, y };
    const hit = rects.find(rect => overlaps(probe, rect));
    if (!hit) break;
    y = hit.y + hit.height + STUDIO_NEW_NODE_GAP;
  }
  return { x: Math.round(candidate.x), y: Math.round(y) };
}

/**
 * Where a node added without an explicit point should land: beside the single
 * selected node (same row, to its right), else centred in the viewport. Both
 * anchors slide down past anything already occupying that spot. Without a
 * viewport, fall back to a deterministic grid from the origin so headless
 * hosts stay predictable.
 */
export function computeStudioNewNodePosition(input: StudioNewNodePlacementInput): { x: number; y: number } {
  const nodes = input.project.graph.nodes;
  const size = estimateNewNodeSize(input.definition);
  const anchor = input.selectedNodeIds.length === 1
    ? nodes.find(node => node.id === input.selectedNodeIds[0]) ?? null
    : null;
  if (anchor) {
    const rect = nodeRect(anchor, input.measure);
    return settle({ x: rect.x + rect.width + STUDIO_NEW_NODE_GAP, y: rect.y, ...size }, nodes, input.measure);
  }
  if (input.viewportCenter) {
    return settle({
      x: input.viewportCenter.x - size.width / 2,
      y: input.viewportCenter.y - size.height / 2,
      ...size,
    }, nodes, input.measure);
  }
  const index = nodes.length;
  const columns = 3;
  return {
    x: 120 + (index % columns) * (size.width + 88),
    y: 120 + Math.floor(index / columns) * (size.height + 64),
  };
}

/**
 * User placement is authoritative. In managed layout an unpinned card is
 * reflowed to wherever the structural layout puts it, which read as "the new
 * node appeared far away"; pin it where it landed, exactly as a drag does.
 */
export function pinStudioNodeForManagedLayout(project: StudioProjectV1, nodeId: string): boolean {
  const layout = project.graph.layout;
  if (layout?.mode !== "managed") return false;
  const pinned = new Set(layout.pinnedNodeIds || []);
  if (pinned.has(nodeId)) return false;
  pinned.add(nodeId);
  project.graph.layout = { ...layout, pinnedNodeIds: [...pinned] };
  return true;
}
