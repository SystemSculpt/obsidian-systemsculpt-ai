import type { StudioProjectV1 } from "../../../studio/types";

export const STUDIO_GRAPH_CANVAS_BASE_WIDTH = 5600;
export const STUDIO_GRAPH_CANVAS_BASE_HEIGHT = 3600;
export const STUDIO_GRAPH_CANVAS_MAX_WIDTH = 30000;
export const STUDIO_GRAPH_CANVAS_MAX_HEIGHT = 20000;
export const STUDIO_GRAPH_CANVAS_NODE_WIDTH = 280;
export const STUDIO_GRAPH_CANVAS_FALLBACK_NODE_HEIGHT = 164;
export const STUDIO_GRAPH_CANVAS_MIN_NODE_HEIGHT = 80;
export const STUDIO_GRAPH_CANVAS_MIN_NODE_WIDTH = 120;
export const STUDIO_GRAPH_CANVAS_EXPAND_PADDING_X = 1000;
export const STUDIO_GRAPH_CANVAS_EXPAND_PADDING_Y = 720;

export type StudioGraphCanvasSize = {
  width: number;
  height: number;
};

export type ComputeStudioGraphCanvasSizeOptions = {
  getNodeHeight?: (nodeId: string) => number | null | undefined;
  getNodeWidth?: (nodeId: string) => number | null | undefined;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  paddingX?: number;
  paddingY?: number;
};

function clampDimension(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeNodeHeight(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return STUDIO_GRAPH_CANVAS_FALLBACK_NODE_HEIGHT;
  }
  return Math.max(STUDIO_GRAPH_CANVAS_MIN_NODE_HEIGHT, Math.round(Number(value)));
}

function normalizeNodeWidth(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return STUDIO_GRAPH_CANVAS_NODE_WIDTH;
  }
  return Math.max(STUDIO_GRAPH_CANVAS_MIN_NODE_WIDTH, Math.round(Number(value)));
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.round(Number(value)));
}

function normalizePadding(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.round(Number(value)));
}

export function computeStudioGraphCanvasSize(
  project: StudioProjectV1 | null,
  options?: ComputeStudioGraphCanvasSizeOptions
): StudioGraphCanvasSize {
  const minWidth = normalizeDimension(options?.minWidth, STUDIO_GRAPH_CANVAS_BASE_WIDTH);
  const minHeight = normalizeDimension(options?.minHeight, STUDIO_GRAPH_CANVAS_BASE_HEIGHT);
  const maxWidth = Math.max(minWidth, normalizeDimension(options?.maxWidth, STUDIO_GRAPH_CANVAS_MAX_WIDTH));
  const maxHeight = Math.max(minHeight, normalizeDimension(options?.maxHeight, STUDIO_GRAPH_CANVAS_MAX_HEIGHT));
  const paddingX = normalizePadding(options?.paddingX, STUDIO_GRAPH_CANVAS_EXPAND_PADDING_X);
  const paddingY = normalizePadding(options?.paddingY, STUDIO_GRAPH_CANVAS_EXPAND_PADDING_Y);

  if (!project || !Array.isArray(project.graph.nodes) || project.graph.nodes.length === 0) {
    return {
      width: minWidth,
      height: minHeight,
    };
  }

  const getNodeHeight = options?.getNodeHeight;
  const getNodeWidth = options?.getNodeWidth;
  let farthestRight = 0;
  let farthestBottom = 0;

  for (const node of project.graph.nodes) {
    const nodeRight = Number(node.position?.x) + normalizeNodeWidth(getNodeWidth?.(node.id));
    const nodeBottom = Number(node.position?.y) + normalizeNodeHeight(getNodeHeight?.(node.id));
    if (Number.isFinite(nodeRight)) {
      farthestRight = Math.max(farthestRight, nodeRight);
    }
    if (Number.isFinite(nodeBottom)) {
      farthestBottom = Math.max(farthestBottom, nodeBottom);
    }
  }

  return {
    width: clampDimension(farthestRight + paddingX, minWidth, maxWidth),
    height: clampDimension(farthestBottom + paddingY, minHeight, maxHeight),
  };
}
