import type { StudioNodeGroup, StudioProjectV1, StudioShapeInstance } from "../../../studio/types";
import { readStudioDiagramFromProject } from "../../../studio/StudioShapes";
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
    getNode?: (nodeId: string) => StudioProjectV1["graph"]["nodes"][number] | null;
    getShape?: (shapeId: string) => StudioShapeInstance | null;
    getNodeHeight?: (nodeId: string) => number | null;
    getNodeWidth?: (nodeId: string) => number | null;
  }
): StudioGraphGroupBounds | null {
  const nodeMap = options?.getNode ? null : new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nodeId of group.nodeIds) {
    const node = options?.getNode ? options.getNode(nodeId) : nodeMap?.get(nodeId);
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

  // A grouped shape stretches the same frame; its size is already in the model.
  if (group.shapeIds && group.shapeIds.length > 0) {
    const shapes = options?.getShape
      ? group.shapeIds.map(options.getShape).filter((shape): shape is StudioShapeInstance => Boolean(shape))
      : readStudioDiagramFromProject(project).shapes.filter(shape => group.shapeIds?.includes(shape.id));
    for (const shape of shapes) {
      minX = Math.min(minX, shape.position.x);
      minY = Math.min(minY, shape.position.y);
      maxX = Math.max(maxX, shape.position.x + shape.size.width);
      maxY = Math.max(maxY, shape.position.y + shape.size.height);
    }
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
