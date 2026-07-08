import { resolveStudioGraphNodeWidth } from "../../../studio/StudioNodeGeometry";
import { inferClosestSystemSculptAspectRatio } from "../../../services/images/SystemSculptImageAspectRatio";
import type {
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../../studio/types";

const AI_IMAGE_EDIT_NODE_GAP_X = 96;

function baseTitleForSourceNode(sourceNode: StudioNodeInstance): string {
  return String(sourceNode.title || "").trim() || "Image";
}

function addNodeIdsToSourceGroups(
  project: StudioProjectV1,
  sourceNodeId: string,
  nodeIdsToAdd: string[]
): void {
  const normalizedSourceNodeId = String(sourceNodeId || "").trim();
  const normalizedNodeIds = Array.from(
    new Set(nodeIdsToAdd.map((nodeId) => String(nodeId || "").trim()).filter(Boolean))
  );
  if (!normalizedSourceNodeId || normalizedNodeIds.length === 0) {
    return;
  }

  const groups = project.graph.groups || [];
  for (const group of groups) {
    const nodeIds = Array.isArray(group.nodeIds) ? group.nodeIds : [];
    if (!nodeIds.includes(normalizedSourceNodeId)) {
      continue;
    }
    for (const nodeId of normalizedNodeIds) {
      if (!nodeIds.includes(nodeId)) {
        nodeIds.push(nodeId);
      }
    }
    group.nodeIds = nodeIds;
  }
}

export function inferAiImageEditAspectRatio(width: number, height: number): string {
  return inferClosestSystemSculptAspectRatio(width, height);
}

/**
 * "Edit with AI" on an image node adds ONE image-generation node wired to the
 * source image. The prompt lives in the generation node's own Prompt box —
 * no companion text node, no modal.
 */
export function insertAiImageEditNode(options: {
  project: StudioProjectV1;
  sourceNode: StudioNodeInstance;
  aspectRatio: string;
  imageGenerationDefinition: StudioNodeDefinition;
  nextNodeId: () => string;
  nextEdgeId: () => string;
  cloneConfigDefaults: (definition: StudioNodeDefinition) => Record<string, unknown>;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
}): {
  imageGenerationNodeId: string;
  createdNodeIds: string[];
  createdEdgeIds: string[];
} {
  const {
    project,
    sourceNode,
    aspectRatio,
    imageGenerationDefinition,
    nextNodeId,
    nextEdgeId,
    cloneConfigDefaults,
    normalizeNodePosition,
  } = options;

  const baseTitle = baseTitleForSourceNode(sourceNode);
  const imageNodePosition = normalizeNodePosition({
    x: sourceNode.position.x + resolveStudioGraphNodeWidth(sourceNode) + AI_IMAGE_EDIT_NODE_GAP_X,
    y: sourceNode.position.y,
  });

  const imageGenerationNodeId = nextNodeId();
  const imageGenerationNode: StudioNodeInstance = {
    id: imageGenerationNodeId,
    kind: imageGenerationDefinition.kind,
    version: imageGenerationDefinition.version,
    title: `${baseTitle} AI Edit`,
    position: imageNodePosition,
    config: {
      ...cloneConfigDefaults(imageGenerationDefinition),
      count: 1,
      aspectRatio,
    },
    continueOnError: false,
    disabled: false,
  };

  const imageEdgeId = nextEdgeId();

  project.graph.nodes.push(imageGenerationNode);
  project.graph.edges.push({
    id: imageEdgeId,
    fromNodeId: sourceNode.id,
    fromPortId: "path",
    toNodeId: imageGenerationNodeId,
    toPortId: "images",
  });

  addNodeIdsToSourceGroups(project, sourceNode.id, [imageGenerationNodeId]);

  return {
    imageGenerationNodeId,
    createdNodeIds: [imageGenerationNodeId],
    createdEdgeIds: [imageEdgeId],
  };
}
