import {
  resolveStudioGraphNodeWidth,
  STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT,
} from "../graph-v3/StudioGraphNodeGeometry";
import {
  SYSTEMSCULPT_CONCRETE_IMAGE_ASPECT_RATIOS,
  inferClosestSystemSculptAspectRatio,
} from "../../../services/canvasflow/SystemSculptImageAspectRatio";
import type {
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../../studio/types";

const AI_IMAGE_EDIT_NODE_GAP_X = 96;
const AI_IMAGE_EDIT_NODE_GAP_Y = 72;

export const SUPPORTED_AI_IMAGE_EDIT_ASPECT_RATIOS = SYSTEMSCULPT_CONCRETE_IMAGE_ASPECT_RATIOS;

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

export function insertAiImageEditNodes(options: {
  project: StudioProjectV1;
  sourceNode: StudioNodeInstance;
  prompt: string;
  aspectRatio: string;
  textDefinition: StudioNodeDefinition;
  imageGenerationDefinition: StudioNodeDefinition;
  nextNodeId: () => string;
  nextEdgeId: () => string;
  cloneConfigDefaults: (definition: StudioNodeDefinition) => Record<string, unknown>;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
}): {
  promptNodeId: string;
  imageGenerationNodeId: string;
  createdNodeIds: string[];
  createdEdgeIds: string[];
} {
  const {
    project,
    sourceNode,
    prompt,
    aspectRatio,
    textDefinition,
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
  const promptNodePosition = normalizeNodePosition({
    x: imageNodePosition.x,
    y: imageNodePosition.y - (STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT + AI_IMAGE_EDIT_NODE_GAP_Y),
  });

  const promptNodeId = nextNodeId();
  const imageGenerationNodeId = nextNodeId();
  const promptNode: StudioNodeInstance = {
    id: promptNodeId,
    kind: textDefinition.kind,
    version: textDefinition.version,
    title: `${baseTitle} Edit Prompt`,
    position: promptNodePosition,
    config: {
      ...cloneConfigDefaults(textDefinition),
      value: prompt,
    },
    continueOnError: false,
    disabled: false,
  };

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

  const promptEdgeId = nextEdgeId();
  const imageEdgeId = nextEdgeId();

  project.graph.nodes.push(promptNode, imageGenerationNode);
  project.graph.edges.push(
    {
      id: promptEdgeId,
      fromNodeId: promptNodeId,
      fromPortId: "text",
      toNodeId: imageGenerationNodeId,
      toPortId: "prompt",
    },
    {
      id: imageEdgeId,
      fromNodeId: sourceNode.id,
      fromPortId: "path",
      toNodeId: imageGenerationNodeId,
      toPortId: "images",
    }
  );

  addNodeIdsToSourceGroups(project, sourceNode.id, [promptNodeId, imageGenerationNodeId]);

  return {
    promptNodeId,
    imageGenerationNodeId,
    createdNodeIds: [promptNodeId, imageGenerationNodeId],
    createdEdgeIds: [promptEdgeId, imageEdgeId],
  };
}
