import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";

const NODE_WIDTH = 280;
const DEFAULT_NODE_HEIGHT = 164;
const DEFAULT_LAYER_GAP_X = 90;
const DEFAULT_NODE_GAP_Y = 20;
const EPSILON = 0.5;

type NodeMeta = {
  id: string;
  node: StudioNodeInstance;
  height: number;
};

type LayerLayoutEntry = {
  id: string;
  layerIndex: number;
};

export type GroupAutoAlignOptions = {
  layerGapX?: number;
  nodeGapY?: number;
  getNodeHeight?: (nodeId: string) => number | null | undefined;
};

export type GroupAutoAlignResult = {
  changed: boolean;
  movedNodeIds: string[];
};

function normalizeNodeHeight(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_NODE_HEIGHT;
  }
  return Math.max(80, Math.round(Number(value)));
}

function normalizeSpacing(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Number(value));
}

function getStableNodeSortKey(node: StudioNodeInstance): string {
  return `${Math.round(node.position.y)}:${Math.round(node.position.x)}:${node.id}`;
}

function buildNodeMap(project: StudioProjectV1): Map<string, StudioNodeInstance> {
  return new Map(project.graph.nodes.map((node) => [node.id, node] as const));
}

function buildPredecessors(edgeMap: Map<string, Set<string>>): Map<string, Set<string>> {
  const predecessors = new Map<string, Set<string>>();
  for (const [fromId, toSet] of edgeMap.entries()) {
    for (const toId of toSet) {
      const set = predecessors.get(toId) || new Set<string>();
      set.add(fromId);
      predecessors.set(toId, set);
    }
  }
  return predecessors;
}

function computeLayerAssignments(
  nodeMetas: NodeMeta[],
  successors: Map<string, Set<string>>
): LayerLayoutEntry[] {
  const nodeIds = nodeMetas.map((entry) => entry.id);
  const indegree = new Map<string, number>();
  const layerById = new Map<string, number>();

  for (const nodeId of nodeIds) {
    indegree.set(nodeId, 0);
    layerById.set(nodeId, 0);
  }

  for (const [, toSet] of successors.entries()) {
    for (const toId of toSet) {
      indegree.set(toId, (indegree.get(toId) || 0) + 1);
    }
  }

  const unresolved = new Set(nodeIds);
  const stableSort = (ids: string[]): string[] => {
    const byId = new Map(nodeMetas.map((entry) => [entry.id, entry.node] as const));
    return ids.slice().sort((left, right) => {
      const leftNode = byId.get(left);
      const rightNode = byId.get(right);
      if (!leftNode || !rightNode) {
        return left.localeCompare(right);
      }
      return getStableNodeSortKey(leftNode).localeCompare(getStableNodeSortKey(rightNode));
    });
  };

  while (unresolved.size > 0) {
    const zeroIndegreeIds = stableSort(
      Array.from(unresolved).filter((nodeId) => (indegree.get(nodeId) || 0) === 0)
    );

    const batch = zeroIndegreeIds.length > 0 ? zeroIndegreeIds : [
      stableSort(Array.from(unresolved))[0],
    ];

    for (const nodeId of batch) {
      if (!unresolved.has(nodeId)) {
        continue;
      }
      unresolved.delete(nodeId);
      const fromLayer = layerById.get(nodeId) || 0;
      for (const successorId of successors.get(nodeId) || []) {
        if (!unresolved.has(successorId)) {
          continue;
        }
        indegree.set(successorId, Math.max(0, (indegree.get(successorId) || 0) - 1));
        const successorLayer = layerById.get(successorId) || 0;
        layerById.set(successorId, Math.max(successorLayer, fromLayer + 1));
      }
    }
  }

  return nodeIds.map((id) => ({ id, layerIndex: layerById.get(id) || 0 }));
}

function sortLayerByBarycenter(
  layerNodeIds: string[],
  predecessors: Map<string, Set<string>>,
  prevOrderIndex: Map<string, number>,
  fallbackNodesById: Map<string, StudioNodeInstance>
): string[] {
  return layerNodeIds.slice().sort((leftId, rightId) => {
    const leftPredecessors = predecessors.get(leftId) || new Set<string>();
    const rightPredecessors = predecessors.get(rightId) || new Set<string>();

    const computeBarycenter = (ids: Set<string>): number | null => {
      const values = Array.from(ids)
        .map((nodeId) => prevOrderIndex.get(nodeId))
        .filter((value): value is number => Number.isFinite(value));
      if (values.length === 0) {
        return null;
      }
      const total = values.reduce((sum, value) => sum + value, 0);
      return total / values.length;
    };

    const leftBarycenter = computeBarycenter(leftPredecessors);
    const rightBarycenter = computeBarycenter(rightPredecessors);

    if (leftBarycenter !== null && rightBarycenter !== null && Math.abs(leftBarycenter - rightBarycenter) > EPSILON) {
      return leftBarycenter - rightBarycenter;
    }
    if (leftBarycenter !== null && rightBarycenter === null) {
      return -1;
    }
    if (leftBarycenter === null && rightBarycenter !== null) {
      return 1;
    }

    const leftNode = fallbackNodesById.get(leftId);
    const rightNode = fallbackNodesById.get(rightId);
    if (!leftNode || !rightNode) {
      return leftId.localeCompare(rightId);
    }
    return getStableNodeSortKey(leftNode).localeCompare(getStableNodeSortKey(rightNode));
  });
}

export function autoAlignGroupNodes(
  project: StudioProjectV1,
  groupId: string,
  options?: GroupAutoAlignOptions
): GroupAutoAlignResult {
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) {
    return { changed: false, movedNodeIds: [] };
  }

  const group = (project.graph.groups || []).find((entry) => entry.id === normalizedGroupId);
  if (!group || !Array.isArray(group.nodeIds) || group.nodeIds.length < 2) {
    return { changed: false, movedNodeIds: [] };
  }

  const nodeMap = buildNodeMap(project);
  const groupNodeIds = Array.from(
    new Set(
      group.nodeIds
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => nodeId.length > 0 && nodeMap.has(nodeId))
    )
  );
  if (groupNodeIds.length < 2) {
    return { changed: false, movedNodeIds: [] };
  }

  const getNodeHeight = options?.getNodeHeight;
  const nodeMetas = groupNodeIds.map((nodeId) => {
    const node = nodeMap.get(nodeId);
    if (!node) {
      return null;
    }
    return {
      id: nodeId,
      node,
      height: normalizeNodeHeight(getNodeHeight?.(nodeId)),
    } satisfies NodeMeta;
  }).filter((entry): entry is NodeMeta => entry !== null);

  if (nodeMetas.length < 2) {
    return { changed: false, movedNodeIds: [] };
  }

  const successors = new Map<string, Set<string>>();
  const groupNodeSet = new Set(nodeMetas.map((entry) => entry.id));
  for (const nodeId of groupNodeSet) {
    successors.set(nodeId, new Set<string>());
  }

  for (const edge of project.graph.edges) {
    if (!groupNodeSet.has(edge.fromNodeId) || !groupNodeSet.has(edge.toNodeId)) {
      continue;
    }
    if (edge.fromNodeId === edge.toNodeId) {
      continue;
    }
    const toSet = successors.get(edge.fromNodeId);
    toSet?.add(edge.toNodeId);
  }

  const layerAssignments = computeLayerAssignments(nodeMetas, successors);
  const nodesByLayer = new Map<number, string[]>();
  for (const assignment of layerAssignments) {
    const layer = nodesByLayer.get(assignment.layerIndex) || [];
    layer.push(assignment.id);
    nodesByLayer.set(assignment.layerIndex, layer);
  }

  const layers = Array.from(nodesByLayer.keys()).sort((left, right) => left - right);
  if (layers.length === 0) {
    return { changed: false, movedNodeIds: [] };
  }

  const predecessors = buildPredecessors(successors);
  const fallbackNodesById = new Map(nodeMetas.map((entry) => [entry.id, entry.node] as const));
  const orderedLayers: string[][] = [];
  let previousLayerOrderIndex = new Map<string, number>();

  for (const layerIndex of layers) {
    const layerNodeIds = nodesByLayer.get(layerIndex) || [];
    const sorted = sortLayerByBarycenter(
      layerNodeIds,
      predecessors,
      previousLayerOrderIndex,
      fallbackNodesById
    );
    orderedLayers.push(sorted);
    previousLayerOrderIndex = new Map(sorted.map((id, index) => [id, index] as const));
  }

  const minX = Math.min(...nodeMetas.map((entry) => entry.node.position.x));
  const minY = Math.min(...nodeMetas.map((entry) => entry.node.position.y));
  const layerGapX = normalizeSpacing(options?.layerGapX, DEFAULT_LAYER_GAP_X);
  const nodeGapY = normalizeSpacing(options?.nodeGapY, DEFAULT_NODE_GAP_Y);

  const movedNodeIds: string[] = [];
  for (let layerOffset = 0; layerOffset < orderedLayers.length; layerOffset += 1) {
    const layerNodeIds = orderedLayers[layerOffset] || [];
    const targetX = Math.round(minX + layerOffset * (NODE_WIDTH + layerGapX));
    let cursorY = minY;
    for (const nodeId of layerNodeIds) {
      const nodeMeta = nodeMetas.find((entry) => entry.id === nodeId);
      if (!nodeMeta) {
        continue;
      }

      const targetY = Math.round(cursorY);
      cursorY += nodeMeta.height + nodeGapY;

      const node = nodeMeta.node;
      const nextX = Math.max(24, targetX);
      const nextY = Math.max(24, targetY);
      if (node.position.x !== nextX || node.position.y !== nextY) {
        node.position.x = nextX;
        node.position.y = nextY;
        movedNodeIds.push(node.id);
      }
    }
  }

  return {
    changed: movedNodeIds.length > 0,
    movedNodeIds,
  };
}
