import type {
  StudioEdge,
  StudioNodeGroup,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../../studio/types";

export const STUDIO_GRAPH_CLIPBOARD_SCHEMA = "systemsculpt.studio.clipboard.v1" as const;

export type StudioGraphClipboardPayload = {
  schema: typeof STUDIO_GRAPH_CLIPBOARD_SCHEMA;
  createdAt: string;
  nodes: StudioNodeInstance[];
  edges: StudioEdge[];
  groups: StudioNodeGroup[];
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

export function cloneProjectSnapshot(project: StudioProjectV1): StudioProjectV1 {
  return JSON.parse(JSON.stringify(project)) as StudioProjectV1;
}

export function serializeProjectSnapshot(project: StudioProjectV1): string {
  return JSON.stringify(project);
}

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

export function resolveClipboardAnchor(nodes: StudioNodeInstance[]): { x: number; y: number } {
  if (nodes.length === 0) {
    return { x: 0, y: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, Number(node.position?.x) || 0);
    minY = Math.min(minY, Number(node.position?.y) || 0);
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
}): StudioGraphClipboardPayload | null {
  const { project, selectedNodeIds } = options;
  const nodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  const normalizedSelection = normalizeNodeIdList(selectedNodeIds).filter((nodeId) =>
    nodeById.has(nodeId)
  );
  if (normalizedSelection.length === 0) {
    return null;
  }

  const selectedNodeIdSet = new Set(normalizedSelection);
  const nodes = normalizedSelection
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is StudioNodeInstance => Boolean(node))
    .map((node) => JSON.parse(JSON.stringify(node)) as StudioNodeInstance);
  if (nodes.length === 0) {
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
      if (groupNodeIds.length < 2) {
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
      } satisfies StudioNodeGroup;
    })
    .filter((group): group is StudioNodeGroup => Boolean(group));

  return {
    schema: STUDIO_GRAPH_CLIPBOARD_SCHEMA,
    createdAt: new Date().toISOString(),
    nodes,
    edges,
    groups,
    selectedNodeIds: normalizedSelection,
    anchor: resolveClipboardAnchor(nodes),
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
  if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) {
    return null;
  }

  return {
    schema: STUDIO_GRAPH_CLIPBOARD_SCHEMA,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
    nodes: payload.nodes as StudioNodeInstance[],
    edges: Array.isArray(payload.edges) ? (payload.edges as StudioEdge[]) : [],
    groups: Array.isArray(payload.groups) ? (payload.groups as StudioNodeGroup[]) : [],
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
