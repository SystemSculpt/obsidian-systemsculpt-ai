import type { StudioNodeGroup, StudioProjectV1 } from "../../../studio/types";

export const STUDIO_GRAPH_GROUP_NODE_WIDTH = 280;
export const STUDIO_GRAPH_GROUP_MIN_NODE_HEIGHT = 80;
export const STUDIO_GRAPH_GROUP_FALLBACK_NODE_HEIGHT = 164;
export const STUDIO_GRAPH_GROUP_PADDING_X = 20;
export const STUDIO_GRAPH_GROUP_PADDING_TOP = 18;
export const STUDIO_GRAPH_GROUP_PADDING_BOTTOM = 32;
export const STUDIO_GRAPH_GROUP_MIN_WIDTH = 180;
export const STUDIO_GRAPH_GROUP_MIN_HEIGHT = 120;

export type StudioGraphGroupBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function computeStudioGraphGroupBounds(
  project: StudioProjectV1,
  group: StudioNodeGroup,
  options?: {
    getNodeHeight?: (nodeId: string) => number | null;
    getNodeWidth?: (nodeId: string) => number | null;
  }
): StudioGraphGroupBounds | null {
  const nodeMap = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nodeId of group.nodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) {
      continue;
    }
    const resolvedHeight = options?.getNodeHeight?.(nodeId);
    const resolvedWidth = options?.getNodeWidth?.(nodeId);
    const nodeWidth = Number.isFinite(resolvedWidth)
      ? Math.max(120, Number(resolvedWidth))
      : STUDIO_GRAPH_GROUP_NODE_WIDTH;
    const nodeHeight = Number.isFinite(resolvedHeight)
      ? Math.max(STUDIO_GRAPH_GROUP_MIN_NODE_HEIGHT, Number(resolvedHeight))
      : STUDIO_GRAPH_GROUP_FALLBACK_NODE_HEIGHT;

    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + nodeWidth);
    maxY = Math.max(maxY, node.position.y + nodeHeight);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  const left = minX - STUDIO_GRAPH_GROUP_PADDING_X;
  const top = minY - STUDIO_GRAPH_GROUP_PADDING_TOP;
  const width = Math.max(
    STUDIO_GRAPH_GROUP_MIN_WIDTH,
    maxX - minX + STUDIO_GRAPH_GROUP_PADDING_X * 2
  );
  const height = Math.max(
    STUDIO_GRAPH_GROUP_MIN_HEIGHT,
    maxY - minY + STUDIO_GRAPH_GROUP_PADDING_TOP + STUDIO_GRAPH_GROUP_PADDING_BOTTOM
  );
  return { left, top, width, height };
}
