import type {
  StudioEdge,
  StudioJsonValue,
  StudioNodeInstance,
  StudioNodeOutputMap,
  StudioProjectV1,
} from "../../studio/types";

export const MANAGED_MEDIA_OWNER_KEY = "__studio_managed_by";
export const MANAGED_MEDIA_OWNER = "studio.image_generation_output.v1";
export const MANAGED_MEDIA_SOURCE_NODE_ID_KEY = "__studio_source_node_id";
export const MANAGED_MEDIA_SLOT_INDEX_KEY = "__studio_source_output_index";
const GENERATED_EDGE_FROM_PORT = "images";
const GENERATED_EDGE_TO_PORT = "media";
const MEDIA_NODE_X_OFFSET = 360;
const MEDIA_NODE_Y_GAP = 220;

type MaterializeImageOutputsOptions = {
  project: StudioProjectV1;
  sourceNode: StudioNodeInstance;
  outputs: StudioNodeOutputMap | null | undefined;
  createNodeId: () => string;
  createEdgeId: () => string;
};

export type MaterializeImageOutputsResult = {
  changed: boolean;
  createdNodeIds: string[];
  updatedNodeIds: string[];
  createdEdgeIds: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractAssetPath(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  return typeof record.path === "string" ? record.path.trim() : "";
}

function extractOutputImagePaths(outputs: StudioNodeOutputMap | null | undefined): string[] {
  if (!outputs || typeof outputs !== "object") {
    return [];
  }

  const result: string[] = [];
  const images = Array.isArray(outputs.images) ? outputs.images : [];
  for (const image of images) {
    const path = extractAssetPath(image);
    if (path) {
      result.push(path);
    }
  }

  return result;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = String(path || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function readManagedMediaSourceNodeId(node: StudioNodeInstance): string {
  if (node.kind !== "studio.media_ingest") {
    return "";
  }
  const config = asRecord(node.config);
  if (!config) {
    return "";
  }
  if (String(config[MANAGED_MEDIA_OWNER_KEY] || "").trim() !== MANAGED_MEDIA_OWNER) {
    return "";
  }
  return String(config[MANAGED_MEDIA_SOURCE_NODE_ID_KEY] || "").trim();
}

function readManagedMediaSlot(node: StudioNodeInstance): { sourceNodeId: string; slotIndex: number } | null {
  const sourceNodeId = readManagedMediaSourceNodeId(node);
  const config = asRecord(node.config);
  if (!sourceNodeId || !config) {
    return null;
  }
  const slotIndexRaw = Number(config[MANAGED_MEDIA_SLOT_INDEX_KEY]);
  const slotIndex = Number.isInteger(slotIndexRaw) && slotIndexRaw >= 0 ? slotIndexRaw : -1;
  if (slotIndex < 0) {
    return null;
  }

  return {
    sourceNodeId,
    slotIndex,
  };
}

function buildManagedMediaTitle(sourceNode: StudioNodeInstance, slotIndex: number, totalCount: number): string {
  const baseTitle = String(sourceNode.title || "").trim() || "Image Generation";
  if (totalCount <= 1) {
    return `${baseTitle} Image`;
  }
  return `${baseTitle} Image ${slotIndex + 1}`;
}

function createManagedMediaConfig(sourceNodeId: string, slotIndex: number, sourcePath: string): Record<string, StudioJsonValue> {
  return {
    sourcePath,
    [MANAGED_MEDIA_OWNER_KEY]: MANAGED_MEDIA_OWNER,
    [MANAGED_MEDIA_SOURCE_NODE_ID_KEY]: sourceNodeId,
    [MANAGED_MEDIA_SLOT_INDEX_KEY]: slotIndex,
  };
}

function findConnectedMediaNodeByPath(options: {
  project: StudioProjectV1;
  sourceNodeId: string;
  sourcePath: string;
  usedNodeIds: Set<string>;
}): StudioNodeInstance | undefined {
  const sourcePath = String(options.sourcePath || "").trim();
  if (!sourcePath) {
    return undefined;
  }

  const nodeById = new Map(options.project.graph.nodes.map((node) => [node.id, node] as const));
  for (const edge of options.project.graph.edges) {
    if (edge.fromNodeId !== options.sourceNodeId) {
      continue;
    }
    if (edge.fromPortId !== GENERATED_EDGE_FROM_PORT) {
      continue;
    }
    if (!(edge.toPortId === GENERATED_EDGE_TO_PORT || edge.toPortId === "path")) {
      continue;
    }
    const candidate = nodeById.get(edge.toNodeId);
    if (!candidate || candidate.kind !== "studio.media_ingest") {
      continue;
    }
    if (options.usedNodeIds.has(candidate.id)) {
      continue;
    }
    const candidateConfig = asRecord(candidate.config) || {};
    const candidatePath = String(candidateConfig.sourcePath || "").trim();
    if (candidatePath !== sourcePath) {
      continue;
    }
    return candidate;
  }

  return undefined;
}

function hasManagedEdge(
  edges: StudioEdge[],
  sourceNodeId: string,
  targetNodeId: string
): boolean {
  return edges.some(
    (edge) =>
      edge.fromNodeId === sourceNodeId &&
      edge.fromPortId === GENERATED_EDGE_FROM_PORT &&
      edge.toNodeId === targetNodeId &&
      edge.toPortId === GENERATED_EDGE_TO_PORT
  );
}

function ensureManagedEdge(options: {
  project: StudioProjectV1;
  sourceNodeId: string;
  targetNodeId: string;
  createEdgeId: () => string;
  createdEdgeIds: string[];
}): boolean {
  if (
    hasManagedEdge(
      options.project.graph.edges,
      options.sourceNodeId,
      options.targetNodeId
    )
  ) {
    return false;
  }

  const edgeId = options.createEdgeId();
  options.project.graph.edges.push({
    id: edgeId,
    fromNodeId: options.sourceNodeId,
    fromPortId: GENERATED_EDGE_FROM_PORT,
    toNodeId: options.targetNodeId,
    toPortId: GENERATED_EDGE_TO_PORT,
  });
  options.createdEdgeIds.push(edgeId);
  return true;
}

export function materializeImageOutputsAsMediaNodes(
  options: MaterializeImageOutputsOptions
): MaterializeImageOutputsResult {
  const sourceNodeId = String(options.sourceNode.id || "").trim();
  if (!sourceNodeId) {
    return {
      changed: false,
      createdNodeIds: [],
      updatedNodeIds: [],
      createdEdgeIds: [],
    };
  }

  const outputPaths = uniquePaths(extractOutputImagePaths(options.outputs));
  if (outputPaths.length === 0) {
    return {
      changed: false,
      createdNodeIds: [],
      updatedNodeIds: [],
      createdEdgeIds: [],
    };
  }

  const managedNodesByPath = new Map<string, StudioNodeInstance>();
  let nextManagedSlotIndex = 0;
  for (const node of options.project.graph.nodes) {
    const managedSourceNodeId = readManagedMediaSourceNodeId(node);
    if (!managedSourceNodeId || managedSourceNodeId !== sourceNodeId) {
      continue;
    }
    const config = asRecord(node.config) || {};
    const sourcePath = String(config.sourcePath || "").trim();
    if (sourcePath && !managedNodesByPath.has(sourcePath)) {
      managedNodesByPath.set(sourcePath, node);
    }
    const managed = readManagedMediaSlot(node);
    if (managed) {
      nextManagedSlotIndex = Math.max(nextManagedSlotIndex, managed.slotIndex + 1);
    }
  }
  const usedNodeIds = new Set(Array.from(managedNodesByPath.values()).map((node) => node.id));

  const createdNodeIds: string[] = [];
  const updatedNodeIds: string[] = [];
  const createdEdgeIds: string[] = [];
  let changed = false;

  for (let index = 0; index < outputPaths.length; index += 1) {
    const sourcePath = outputPaths[index];
    if (!sourcePath) {
      continue;
    }

    let existingNode = managedNodesByPath.get(sourcePath);
    if (!existingNode) {
      existingNode = findConnectedMediaNodeByPath({
        project: options.project,
        sourceNodeId,
        sourcePath,
        usedNodeIds,
      });
      if (existingNode) {
        managedNodesByPath.set(sourcePath, existingNode);
      }
    }
    if (existingNode) {
      usedNodeIds.add(existingNode.id);
      const existingConfig = asRecord(existingNode.config) || {};
      const existingManaged = readManagedMediaSlot(existingNode);
      const slotIndex = existingManaged?.slotIndex ?? nextManagedSlotIndex++;
      const nextConfig = {
        ...(existingNode.config as Record<string, StudioJsonValue>),
        sourcePath,
        [MANAGED_MEDIA_OWNER_KEY]: MANAGED_MEDIA_OWNER,
        [MANAGED_MEDIA_SOURCE_NODE_ID_KEY]: sourceNodeId,
        [MANAGED_MEDIA_SLOT_INDEX_KEY]: slotIndex,
      };
      if (JSON.stringify(existingConfig) !== JSON.stringify(nextConfig)) {
        existingNode.config = nextConfig;
        changed = true;
        updatedNodeIds.push(existingNode.id);
      }
      if (
        ensureManagedEdge({
          project: options.project,
          sourceNodeId,
          targetNodeId: existingNode.id,
          createEdgeId: options.createEdgeId,
          createdEdgeIds,
        })
      ) {
        changed = true;
      }
      continue;
    }

    const nodeId = options.createNodeId();
    const slotIndex = nextManagedSlotIndex++;
    const newNode: StudioNodeInstance = {
      id: nodeId,
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: buildManagedMediaTitle(options.sourceNode, slotIndex, slotIndex + 1),
      position: {
        x: options.sourceNode.position.x + MEDIA_NODE_X_OFFSET,
        y: options.sourceNode.position.y + slotIndex * MEDIA_NODE_Y_GAP,
      },
      config: createManagedMediaConfig(sourceNodeId, slotIndex, sourcePath),
      continueOnError: false,
      disabled: false,
    };

    options.project.graph.nodes.push(newNode);
    managedNodesByPath.set(sourcePath, newNode);
    usedNodeIds.add(nodeId);
    changed = true;
    createdNodeIds.push(nodeId);
    if (
      ensureManagedEdge({
        project: options.project,
        sourceNodeId,
        targetNodeId: nodeId,
        createEdgeId: options.createEdgeId,
        createdEdgeIds,
      })
    ) {
      changed = true;
    }
  }

  return {
    changed,
    createdNodeIds,
    updatedNodeIds,
    createdEdgeIds,
  };
}
