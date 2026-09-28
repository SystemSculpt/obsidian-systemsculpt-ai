import type {
  StudioNodeInstance,
  StudioNodeOutputMap,
  StudioProjectV1,
  StudioRunEvent,
} from "./types";
import { isStudioManagedOutputProducerKind, resolveStudioManagedOutputKind } from "./StudioNodeKinds";
import {
  DATASET_OUTPUT_FIELDS_CONFIG_KEY,
  deriveDatasetOutputFieldsFromOutputs,
  readDatasetOutputFields,
} from "./nodes/datasetNode";
import {
  type StudioOutputNodeMeasure,
  materializeImageOutputsAsMediaNodes,
  materializePendingImageOutputPlaceholders,
  materializePendingVideoOutputPlaceholders,
  materializeVideoOutputsAsMediaNodes,
  removeManagedTextOutputNodes,
} from "./StudioManagedOutputNodes";

type NodeOutputEvent = Extract<StudioRunEvent, { type: "node.output" }>;
type NodeStartedEvent = Extract<StudioRunEvent, { type: "node.started" }>;

function isTextGenerationOutputLocked(node: StudioNodeInstance | null): boolean {
  if (!node || node.kind !== "studio.text_generation") {
    return false;
  }
  return node.config.lockOutput === true;
}

function resolveMediaMaterializer(kind: string): typeof materializeImageOutputsAsMediaNodes | null {
  const outputKind = resolveStudioManagedOutputKind(kind);
  if (outputKind === "video") return materializeVideoOutputsAsMediaNodes;
  if (outputKind === "image") return materializeImageOutputsAsMediaNodes;
  return null;
}

function findNode(project: StudioProjectV1, nodeId: string): StudioNodeInstance | null {
  return project.graph.nodes.find((candidate) => candidate.id === nodeId) || null;
}

export function syncInlineTextOutputToProjectNodeConfig(options: {
  project: StudioProjectV1;
  event: NodeOutputEvent;
}): boolean {
  const sourceNode = findNode(options.project, options.event.nodeId);
  if (!sourceNode) {
    return false;
  }
  if (sourceNode.kind !== "studio.text_generation" && sourceNode.kind !== "studio.transcription") {
    return false;
  }
  if (sourceNode.kind === "studio.text_generation" && isTextGenerationOutputLocked(sourceNode)) {
    return false;
  }
  const outputText = typeof options.event.outputs?.text === "string" ? options.event.outputs.text : "";
  if (!outputText.trim()) {
    return false;
  }
  if (String(sourceNode.config.value || "") === outputText) {
    return false;
  }
  sourceNode.config.value = outputText;
  return true;
}

export function syncDatasetOutputFieldsToProjectNodeConfig(options: {
  project: StudioProjectV1;
  event: NodeOutputEvent;
}): boolean {
  const sourceNode = findNode(options.project, options.event.nodeId);
  if (!sourceNode || sourceNode.kind !== "studio.dataset") {
    return false;
  }

  const nextFields = deriveDatasetOutputFieldsFromOutputs(options.event.outputs);
  const currentFields = readDatasetOutputFields(
    sourceNode.config[DATASET_OUTPUT_FIELDS_CONFIG_KEY]
  );
  const unchanged =
    nextFields.length === currentFields.length &&
    nextFields.every((field, index) => field === currentFields[index]);
  if (unchanged) {
    return false;
  }

  if (nextFields.length === 0) {
    delete sourceNode.config[DATASET_OUTPUT_FIELDS_CONFIG_KEY];
  } else {
    sourceNode.config[DATASET_OUTPUT_FIELDS_CONFIG_KEY] = nextFields;
  }
  return true;
}

export function materializeManagedOutputPlaceholdersForStartedNode(options: {
  project: StudioProjectV1;
  event: NodeStartedEvent;
  measure?: StudioOutputNodeMeasure;
  createNodeId: () => string;
  createEdgeId: () => string;
}): boolean {
  const sourceNode = findNode(options.project, options.event.nodeId);
  if (!sourceNode || !isStudioManagedOutputProducerKind(sourceNode.kind)) {
    return false;
  }

  const outputKind = resolveStudioManagedOutputKind(sourceNode.kind);
  const materializePlaceholders = outputKind === "video"
    ? materializePendingVideoOutputPlaceholders
    : outputKind === "image" ? materializePendingImageOutputPlaceholders : null;
  if (!materializePlaceholders) return false;
  return materializePlaceholders({
    project: options.project,
    sourceNode,
    runId: options.event.runId,
    createdAt: options.event.at,
    measure: options.measure,
    createNodeId: options.createNodeId,
    createEdgeId: options.createEdgeId,
  }).changed;
}

export function materializeManagedOutputNodesForNodeOutput(options: {
  project: StudioProjectV1;
  event: NodeOutputEvent;
  measure?: StudioOutputNodeMeasure;
  createNodeId: () => string;
  createEdgeId: () => string;
}): boolean {
  const sourceNode = findNode(options.project, options.event.nodeId);
  if (!sourceNode) {
    return false;
  }

  let changed = false;
  const materializeMedia = resolveMediaMaterializer(sourceNode.kind);
  if (materializeMedia) {
    const materializedMedia = materializeMedia({
      project: options.project,
      sourceNode,
      outputs: options.event.outputs || null,
      runId: options.event.runId,
      measure: options.measure,
      createNodeId: options.createNodeId,
      createEdgeId: options.createEdgeId,
    });
    changed = changed || materializedMedia.changed;
  }
  if (sourceNode.kind === "studio.text_generation") {
    const removedManagedText = removeManagedTextOutputNodes({
      project: options.project,
      sourceNodeId: sourceNode.id,
    });
    changed = changed || removedManagedText.changed;
  }

  return changed;
}

export function materializeManagedOutputNodesFromCacheEntries(options: {
  project: StudioProjectV1;
  entries: Record<string, { outputs: StudioNodeOutputMap; updatedAt?: string }> | null;
  measure?: StudioOutputNodeMeasure;
  createNodeId: () => string;
  createEdgeId: () => string;
}): boolean {
  if (!options.entries) {
    return false;
  }

  let changed = false;
  for (const node of options.project.graph.nodes) {
    if (!isStudioManagedOutputProducerKind(node.kind)) {
      continue;
    }

    const cacheEntry = options.entries[node.id];
    if (!cacheEntry || !cacheEntry.outputs || typeof cacheEntry.outputs !== "object") {
      continue;
    }

    const materializeMedia = resolveMediaMaterializer(node.kind);
    if (materializeMedia) {
      const materializedMedia = materializeMedia({
        project: options.project,
        sourceNode: node,
        outputs: cacheEntry.outputs,
        measure: options.measure,
        createNodeId: options.createNodeId,
        createEdgeId: options.createEdgeId,
      });
      if (materializedMedia.changed) {
        changed = true;
      }
    }
  }

  return changed;
}
