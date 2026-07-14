import type { StudioNodeGroup, StudioProjectV1 } from "../../../studio/types";
import {
  STUDIO_GRAPH_DEFAULT_NODE_HEIGHT,
  STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
  STUDIO_GRAPH_MEASURED_NODE_MIN_HEIGHT,
  STUDIO_GRAPH_MEASURED_NODE_MIN_WIDTH,
} from "../../../studio/StudioNodeGeometry";

const STUDIO_GRAPH_GROUP_PADDING_X = 20;
const STUDIO_GRAPH_GROUP_PADDING_TOP = 18;
const STUDIO_GRAPH_GROUP_PADDING_BOTTOM = 32;
const STUDIO_GRAPH_GROUP_MIN_WIDTH = 180;
const STUDIO_GRAPH_GROUP_MIN_HEIGHT = 120;

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
      ? Math.max(STUDIO_GRAPH_MEASURED_NODE_MIN_WIDTH, Number(resolvedWidth))
      : STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
    const nodeHeight = Number.isFinite(resolvedHeight)
      ? Math.max(STUDIO_GRAPH_MEASURED_NODE_MIN_HEIGHT, Number(resolvedHeight))
      : STUDIO_GRAPH_DEFAULT_NODE_HEIGHT;

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
