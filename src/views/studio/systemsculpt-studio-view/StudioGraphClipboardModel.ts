import { cloneStudioProjectSnapshot, serializeStudioProjectSnapshot } from "../../../studio/StudioProjectSnapshots";
import { readStudioDiagramFromProject } from "../../../studio/StudioShapes";
import type {
  StudioEdge,
  StudioNodeGroup,
  StudioNodeInstance,
  StudioProjectV1,
  StudioShapeArrow,
  StudioShapeInstance,
} from "../../../studio/types";

export const STUDIO_GRAPH_CLIPBOARD_SCHEMA = "systemsculpt.studio.clipboard.v1" as const;

/**
 * One clipboard for the whole canvas. Nodes and shapes are different data, but
 * copy, cut, and paste are one user action, so a payload carries both halves
 * and either half may be empty.
 */
export type StudioGraphClipboardPayload = {
  schema: typeof STUDIO_GRAPH_CLIPBOARD_SCHEMA;
  createdAt: string;
  nodes: StudioNodeInstance[];
  edges: StudioEdge[];
  groups: StudioNodeGroup[];
  shapes: StudioShapeInstance[];
  arrows: StudioShapeArrow[];
  selectedNodeIds: string[];
  anchor: {
    x: number;
    y: number;
  };
};

export type StudioGraphHistorySnapshot = {
  project: StudioProjectV1;
  selectedNodeIds: string[];
};

export function normalizeNodeIdList(nodeIds: string[]): string[] {
  return Array.from(
    new Set(
      nodeIds
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => nodeId.length > 0)
    )
  );
}

export const cloneProjectSnapshot = cloneStudioProjectSnapshot;
export const serializeProjectSnapshot = serializeStudioProjectSnapshot;

export function cloneHistorySnapshot(snapshot: StudioGraphHistorySnapshot): StudioGraphHistorySnapshot {
  return {
    project: cloneProjectSnapshot(snapshot.project),
    selectedNodeIds: [...snapshot.selectedNodeIds],
  };
}

export function trimHistorySnapshots(
  snapshots: StudioGraphHistorySnapshot[],
  maxSnapshots: number
): void {
  while (snapshots.length > maxSnapshots) {
    snapshots.shift();
  }
}

function resolveClipboardAnchor(
  positioned: ReadonlyArray<{ position?: { x?: number; y?: number } }>
): { x: number; y: number } {
  if (positioned.length === 0) {
    return { x: 0, y: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const entry of positioned) {
    minX = Math.min(minX, Number(entry.position?.x) || 0);
    minY = Math.min(minY, Number(entry.position?.y) || 0);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0 };
  }
  return {
    x: minX,
    y: minY,
  };
}

export function buildGraphClipboardPayload(options: {
  project: StudioProjectV1;
  selectedNodeIds: string[];
  selectedShapeIds?: string[];
}): StudioGraphClipboardPayload | null {
  const { project, selectedNodeIds } = options;
  const nodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  const normalizedSelection = normalizeNodeIdList(selectedNodeIds).filter((nodeId) =>
    nodeById.has(nodeId)
  );

  const selectedNodeIdSet = new Set(normalizedSelection);
  const nodes = normalizedSelection
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is StudioNodeInstance => Boolean(node))
    .map((node) => JSON.parse(JSON.stringify(node)) as StudioNodeInstance);

  const diagram = readStudioDiagramFromProject(project);
  const shapeById = new Map(diagram.shapes.map((shape) => [shape.id, shape] as const));
  const selectedShapeIds = normalizeNodeIdList(options.selectedShapeIds || []).filter((shapeId) =>
    shapeById.has(shapeId)
  );
  const selectedShapeIdSet = new Set(selectedShapeIds);
  const shapes = selectedShapeIds
    .map((shapeId) => shapeById.get(shapeId))
    .filter((shape): shape is StudioShapeInstance => Boolean(shape))
    .map((shape) => JSON.parse(JSON.stringify(shape)) as StudioShapeInstance);

  // An arrow travels only when both of its shapes travel, exactly like an edge.
  const arrows = diagram.arrows
    .filter(
      (arrow) =>
        selectedShapeIdSet.has(arrow.fromShapeId) && selectedShapeIdSet.has(arrow.toShapeId)
    )
    .map((arrow) => ({ ...arrow }));

  if (nodes.length === 0 && shapes.length === 0) {
    return null;
  }

  const edges = project.graph.edges
    .filter(
      (edge) =>
        selectedNodeIdSet.has(edge.fromNodeId) &&
        selectedNodeIdSet.has(edge.toNodeId)
    )
    .map((edge) => ({ ...edge }));

  const groups = (project.graph.groups || [])
    .map((group) => {
      const groupNodeIds = normalizeNodeIdList(group.nodeIds || []).filter((nodeId) =>
        selectedNodeIdSet.has(nodeId)
      );
      const groupShapeIds = normalizeNodeIdList(group.shapeIds || []).filter((shapeId) =>
        selectedShapeIdSet.has(shapeId)
      );
      // A group is worth copying only when at least two of its members came.
      if (groupNodeIds.length + groupShapeIds.length < 2) {
        return null;
      }
      const groupName = String(group.name || "").trim();
      const groupId = String(group.id || "").trim();
      if (!groupName || !groupId) {
        return null;
      }
      const groupColor = String(group.color || "").trim();
      return {
        id: groupId,
        name: groupName,
        ...(groupColor ? { color: groupColor } : {}),
        nodeIds: groupNodeIds,
        ...(groupShapeIds.length > 0 ? { shapeIds: groupShapeIds } : {}),
      } satisfies StudioNodeGroup;
    })
    .filter((group): group is StudioNodeGroup => Boolean(group));

  return {
    schema: STUDIO_GRAPH_CLIPBOARD_SCHEMA,
    createdAt: new Date().toISOString(),
    nodes,
    edges,
    groups,
    shapes,
    arrows,
    selectedNodeIds: normalizedSelection,
    anchor: resolveClipboardAnchor([...nodes, ...shapes]),
  };
}

export function parseGraphClipboardPayload(raw: string): StudioGraphClipboardPayload | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const payload = parsed as Partial<StudioGraphClipboardPayload>;
  if (payload.schema !== STUDIO_GRAPH_CLIPBOARD_SCHEMA) {
    return null;
  }
  const nodes = Array.isArray(payload.nodes) ? (payload.nodes as StudioNodeInstance[]) : [];
  const shapes = Array.isArray(payload.shapes) ? (payload.shapes as StudioShapeInstance[]) : [];
  if (nodes.length === 0 && shapes.length === 0) {
    return null;
  }

  return {
    schema: STUDIO_GRAPH_CLIPBOARD_SCHEMA,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
    nodes,
    edges: Array.isArray(payload.edges) ? (payload.edges as StudioEdge[]) : [],
    groups: Array.isArray(payload.groups) ? (payload.groups as StudioNodeGroup[]) : [],
    shapes,
    arrows: Array.isArray(payload.arrows) ? (payload.arrows as StudioShapeArrow[]) : [],
    selectedNodeIds: Array.isArray(payload.selectedNodeIds)
      ? normalizeNodeIdList(payload.selectedNodeIds as string[])
      : [],
    anchor: {
      x:
        payload.anchor && Number.isFinite(Number(payload.anchor.x))
          ? Number(payload.anchor.x)
          : 0,
      y:
        payload.anchor && Number.isFinite(Number(payload.anchor.y))
          ? Number(payload.anchor.y)
          : 0,
    },
  };
}
