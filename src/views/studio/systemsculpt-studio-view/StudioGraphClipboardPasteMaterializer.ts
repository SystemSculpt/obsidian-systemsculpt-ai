import type {
  StudioEdge,
  StudioNodeGroup,
  StudioNodeInstance,
  StudioShapeArrow,
  StudioShapeInstance,
} from "../../../studio/types";
import {
  normalizeNodeIdList,
  type StudioGraphClipboardPayload,
} from "./StudioGraphClipboardModel";

export type MaterializeGraphClipboardPasteResult = {
  newNodes: StudioNodeInstance[];
  newEdges: StudioEdge[];
  newGroups: StudioNodeGroup[];
  newShapes: StudioShapeInstance[];
  newArrows: StudioShapeArrow[];
  nextSelection: string[];
  nextShapeSelection: string[];
};

export function materializeGraphClipboardPaste(options: {
  payload: StudioGraphClipboardPayload;
  anchor: { x: number; y: number };
  pasteCount: number;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
  nextNodeId: () => string;
  nextEdgeId: () => string;
  nextGroupId: () => string;
  nextShapeId: () => string;
  nextArrowId: () => string;
}): MaterializeGraphClipboardPasteResult | null {
  const {
    payload,
    anchor,
    pasteCount,
    normalizeNodePosition,
    nextNodeId,
    nextEdgeId,
    nextGroupId,
    nextShapeId,
    nextArrowId,
  } = options;

  const nodeIdMap = new Map<string, string>();
  const newNodes: StudioNodeInstance[] = [];
  const repeatedPasteOffset = pasteCount * 28;
  const deltaX = anchor.x + repeatedPasteOffset - payload.anchor.x;
  const deltaY = anchor.y + repeatedPasteOffset - payload.anchor.y;

  for (const sourceNode of payload.nodes) {
    const sourceNodeId = String(sourceNode.id || "").trim();
    if (!sourceNodeId) {
      continue;
    }
    const remappedNodeId = nextNodeId();
    nodeIdMap.set(sourceNodeId, remappedNodeId);

    const clonedNode = JSON.parse(JSON.stringify(sourceNode)) as StudioNodeInstance;
    clonedNode.id = remappedNodeId;
    clonedNode.position = normalizeNodePosition({
      x: Number(clonedNode.position?.x || 0) + deltaX,
      y: Number(clonedNode.position?.y || 0) + deltaY,
    });
    newNodes.push(clonedNode);
  }

  const shapeIdMap = new Map<string, string>();
  const newShapes: StudioShapeInstance[] = [];
  for (const sourceShape of payload.shapes || []) {
    const sourceShapeId = String(sourceShape.id || "").trim();
    if (!sourceShapeId) {
      continue;
    }
    const remappedShapeId = nextShapeId();
    shapeIdMap.set(sourceShapeId, remappedShapeId);

    const clonedShape = JSON.parse(JSON.stringify(sourceShape)) as StudioShapeInstance;
    clonedShape.id = remappedShapeId;
    clonedShape.position = {
      x: Math.round(Number(clonedShape.position?.x || 0) + deltaX),
      y: Math.round(Number(clonedShape.position?.y || 0) + deltaY),
    };
    newShapes.push(clonedShape);
  }

  if (newNodes.length === 0 && newShapes.length === 0) {
    return null;
  }

  const newArrows: StudioShapeArrow[] = [];
  for (const sourceArrow of payload.arrows || []) {
    const fromShapeId = shapeIdMap.get(String(sourceArrow.fromShapeId || "").trim());
    const toShapeId = shapeIdMap.get(String(sourceArrow.toShapeId || "").trim());
    if (!fromShapeId || !toShapeId || fromShapeId === toShapeId) {
      continue;
    }
    newArrows.push({
      id: nextArrowId(),
      fromShapeId,
      toShapeId,
      ...(sourceArrow.label ? { label: sourceArrow.label } : {}),
    });
  }

  const newEdges: StudioEdge[] = [];
  for (const sourceEdge of payload.edges || []) {
    const fromNodeId = nodeIdMap.get(String(sourceEdge.fromNodeId || "").trim());
    const toNodeId = nodeIdMap.get(String(sourceEdge.toNodeId || "").trim());
    if (!fromNodeId || !toNodeId) {
      continue;
    }
    const fromPortId = String(sourceEdge.fromPortId || "").trim();
    const toPortId = String(sourceEdge.toPortId || "").trim();
    if (!fromPortId || !toPortId) {
      continue;
    }
    newEdges.push({
      id: nextEdgeId(),
      fromNodeId,
      fromPortId,
      toNodeId,
      toPortId,
    });
  }

  const newGroups: StudioNodeGroup[] = [];
  for (const sourceGroup of payload.groups || []) {
    const groupNodeIds = normalizeNodeIdList(sourceGroup.nodeIds || [])
      .map((nodeId) => nodeIdMap.get(nodeId) || "")
      .filter((nodeId) => nodeId.length > 0);
    const groupShapeIds = normalizeNodeIdList(sourceGroup.shapeIds || [])
      .map((shapeId) => shapeIdMap.get(shapeId) || "")
      .filter((shapeId) => shapeId.length > 0);
    if (groupNodeIds.length + groupShapeIds.length < 2) {
      continue;
    }
    const groupName = String(sourceGroup.name || "").trim();
    if (!groupName) {
      continue;
    }
    const groupColor = String(sourceGroup.color || "").trim();
    newGroups.push({
      id: nextGroupId(),
      name: groupName,
      ...(groupColor ? { color: groupColor } : {}),
      nodeIds: groupNodeIds,
      ...(groupShapeIds.length > 0 ? { shapeIds: groupShapeIds } : {}),
    });
  }

  const nextSelection = normalizeNodeIdList(payload.selectedNodeIds || [])
    .map((nodeId) => nodeIdMap.get(nodeId) || "")
    .filter((nodeId) => nodeId.length > 0);
  if (nextSelection.length === 0) {
    nextSelection.push(...newNodes.map((node) => node.id));
  }

  return {
    newNodes,
    newEdges,
    newGroups,
    newShapes,
    newArrows,
    nextSelection,
    nextShapeSelection: newShapes.map((shape) => shape.id),
  };
}
