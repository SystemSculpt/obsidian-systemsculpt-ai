import { removeStudioArrowsForItems } from "./StudioShapes";
import type {
  StudioJsonValue,
  StudioNodeInstance,
  StudioNodeOutputMap,
  StudioProjectV1,
} from "./types";
import {
  resolveStudioGraphNodeWidth,
  resolveStudioGraphNodeMinHeight,
} from "./StudioNodeGeometry";

export const MANAGED_MEDIA_OWNER_KEY = "__studio_managed_by";
export const MANAGED_MEDIA_OWNER = "studio.image_generation_output.v1";
export const MANAGED_MEDIA_SOURCE_NODE_ID_KEY = "__studio_source_node_id";
export const MANAGED_MEDIA_SLOT_INDEX_KEY = "__studio_source_output_index";
export const MANAGED_OUTPUT_PENDING_KEY = "__studio_pending";
export const MANAGED_OUTPUT_PENDING_RUN_ID_KEY = "__studio_pending_run_id";
const MANAGED_OUTPUT_RUN_ID_KEY = "__studio_output_run_id";
const MANAGED_OUTPUT_PENDING_AT_KEY = "__studio_pending_at";
export const MANAGED_OUTPUT_PENDING_MEDIA_KIND_KEY = "__studio_pending_media_kind";

export const MANAGED_TEXT_OWNER_KEY = "__studio_managed_by";
export const MANAGED_TEXT_OWNER = "studio.text_generation_output.v1";
export const MANAGED_TEXT_SOURCE_NODE_ID_KEY = "__studio_source_node_id";
export const MANAGED_TEXT_SLOT_INDEX_KEY = "__studio_source_output_index";

export type StudioManagedMediaKind = "image" | "video";
type ManagedMediaProfile = Readonly<{ kind: StudioManagedMediaKind; outputsKey: "images" | "videos"; fromPort: "images" | "videos"; titleNoun: string; defaultBaseTitle: string }>;
const MEDIA_PROFILES: Readonly<Record<StudioManagedMediaKind, ManagedMediaProfile>> = {
  image: { kind: "image", outputsKey: "images", fromPort: "images", titleNoun: "Image", defaultBaseTitle: "Image Generation" },
  video: { kind: "video", outputsKey: "videos", fromPort: "videos", titleNoun: "Video", defaultBaseTitle: "Video Generation" },
};
const GENERATED_MEDIA_EDGE_FROM_PORTS: readonly string[] = ["images", "videos"];
const GENERATED_MEDIA_EDGE_TO_PORT = "media";
const MANAGED_OUTPUT_NODE_HORIZONTAL_GAP = 96;

export type StudioOutputNodeMeasure = (node: StudioNodeInstance) => { width: number; height: number } | null;

type MaterializeMediaOutputsOptions = {
  runId?: string;
  measure?: StudioOutputNodeMeasure;
  project: StudioProjectV1;
  sourceNode: StudioNodeInstance;
  outputs: StudioNodeOutputMap | null | undefined;
  createNodeId: () => string;
  createEdgeId: () => string;
};

type MaterializePendingMediaOutputPlaceholdersOptions = {
  measure?: StudioOutputNodeMeasure;
  project: StudioProjectV1;
  sourceNode: StudioNodeInstance;
  runId: string;
  createdAt?: string;
  createNodeId: () => string;
  createEdgeId: () => string;
};

type RemovePendingManagedOutputNodesOptions = {
  project: StudioProjectV1;
  sourceNodeId?: string;
  runId?: string;
};

export type MaterializeManagedOutputsResult = {
  changed: boolean;
  createdNodeIds: string[];
  updatedNodeIds: string[];
  createdEdgeIds: string[];
};

export type RemovePendingManagedOutputNodesResult = {
  changed: boolean;
  removedNodeIds: string[];
  removedEdgeIds: string[];
};

function emptyMaterializeResult(): MaterializeManagedOutputsResult {
  return {
    changed: false,
    createdNodeIds: [],
    updatedNodeIds: [],
    createdEdgeIds: [],
  };
}

function emptyRemovePendingResult(): RemovePendingManagedOutputNodesResult {
  return {
    changed: false,
    removedNodeIds: [],
    removedEdgeIds: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isManagedMediaNode(node: StudioNodeInstance): boolean {
  if (node.kind !== "studio.media_ingest") {
    return false;
  }
  const config = asRecord(node.config);
  if (!config) {
    return false;
  }
  return String(config[MANAGED_MEDIA_OWNER_KEY] || "").trim() === MANAGED_MEDIA_OWNER;
}

/** Copies belong to the copied producer, or become independent media cards. */
export function remapCopiedMediaOutputOwner(
  node: StudioNodeInstance,
  nodeIdMap: ReadonlyMap<string, string>
): void {
  if (!isManagedMediaNode(node)) return;
  const sourceId = String(node.config[MANAGED_MEDIA_SOURCE_NODE_ID_KEY] || "");
  const copiedSourceId = nodeIdMap.get(sourceId);
  if (copiedSourceId) {
    node.config[MANAGED_MEDIA_SOURCE_NODE_ID_KEY] = copiedSourceId;
  } else {
    delete node.config[MANAGED_MEDIA_OWNER_KEY];
    delete node.config[MANAGED_MEDIA_SOURCE_NODE_ID_KEY];
    delete node.config[MANAGED_MEDIA_SLOT_INDEX_KEY];
  }
  // A copied card never participates in an in-flight or completed original run.
  node.config = stripManagedPendingFields(node.config);
  delete node.config[MANAGED_OUTPUT_RUN_ID_KEY];
}

function isManagedTextNode(node: StudioNodeInstance): boolean {
  if (node.kind !== "studio.text_output") {
    return false;
  }
  const config = asRecord(node.config);
  if (!config) {
    return false;
  }
  return String(config[MANAGED_TEXT_OWNER_KEY] || "").trim() === MANAGED_TEXT_OWNER;
}

function isManagedOutputNode(node: StudioNodeInstance): boolean {
  return isManagedMediaNode(node) || isManagedTextNode(node);
}

export function readManagedOutputPendingFlag(node: StudioNodeInstance): boolean {
  if (!isManagedOutputNode(node)) {
    return false;
  }
  const config = asRecord(node.config);
  if (!config) {
    return false;
  }
  return config[MANAGED_OUTPUT_PENDING_KEY] === true;
}

function readManagedOutputPendingRunId(node: StudioNodeInstance): string {
  if (!isManagedOutputNode(node)) {
    return "";
  }
  const config = asRecord(node.config);
  if (!config) {
    return "";
  }
  return String(config[MANAGED_OUTPUT_PENDING_RUN_ID_KEY] || "").trim();
}

function stripManagedPendingFields(
  config: Record<string, StudioJsonValue>
): Record<string, StudioJsonValue> {
  const next = { ...config };
  delete next[MANAGED_OUTPUT_PENDING_KEY];
  delete next[MANAGED_OUTPUT_PENDING_RUN_ID_KEY];
  delete next[MANAGED_OUTPUT_PENDING_AT_KEY];
  delete next[MANAGED_OUTPUT_PENDING_MEDIA_KIND_KEY];
  return next;
}

function extractAssetPath(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  return typeof record.path === "string" ? record.path.trim() : "";
}

function extractOutputMediaPaths(outputs: StudioNodeOutputMap | null | undefined, outputsKey: "images" | "videos"): string[] {
  if (!outputs || typeof outputs !== "object") {
    return [];
  }

  const result: string[] = [];
  const entries = Array.isArray(outputs[outputsKey]) ? (outputs[outputsKey] as unknown[]) : [];
  for (const entry of entries) {
    const path = extractAssetPath(entry);
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

function readManagedTextSourceNodeId(node: StudioNodeInstance): string {
  if (node.kind !== "studio.text_output") {
    return "";
  }
  const config = asRecord(node.config);
  if (!config) {
    return "";
  }
  if (String(config[MANAGED_TEXT_OWNER_KEY] || "").trim() !== MANAGED_TEXT_OWNER) {
    return "";
  }
  return String(config[MANAGED_TEXT_SOURCE_NODE_ID_KEY] || "").trim();
}

function buildManagedMediaTitle(profile: ManagedMediaProfile, sourceNode: StudioNodeInstance, slotIndex: number, totalCount: number): string {
  const baseTitle = String(sourceNode.title || "").trim() || profile.defaultBaseTitle;
  if (totalCount <= 1) {
    return `${baseTitle} ${profile.titleNoun}`;
  }
  return `${baseTitle} ${profile.titleNoun} ${slotIndex + 1}`;
}

function resolveManagedOutputTargetX(sourceNode: StudioNodeInstance, measure?: StudioOutputNodeMeasure): number {
  return sourceNode.position.x + (measure?.(sourceNode)?.width || resolveStudioGraphNodeWidth(sourceNode)) + MANAGED_OUTPUT_NODE_HORIZONTAL_GAP;
}

function newOutputPosition(options: Pick<MaterializeMediaOutputsOptions, "project" | "sourceNode" | "measure">): { x: number; y: number } {
  const group = options.project.graph.groups?.find(group => group.outputForNodeId === options.sourceNode.id);
  return { x: resolveManagedOutputTargetX(options.sourceNode, options.measure) + (group?.outputOffset?.x ?? 96) - 96,
    y: options.sourceNode.position.y + (group?.outputOffset?.y ?? 0) };
}

function createManagedMediaConfig(sourceNodeId: string, slotIndex: number, sourcePath: string): Record<string, StudioJsonValue> {
  return {
    sourcePath,
    [MANAGED_MEDIA_OWNER_KEY]: MANAGED_MEDIA_OWNER,
    [MANAGED_MEDIA_SOURCE_NODE_ID_KEY]: sourceNodeId,
    [MANAGED_MEDIA_SLOT_INDEX_KEY]: slotIndex,
  };
}

function createPendingManagedMediaConfig(
  mediaKind: StudioManagedMediaKind,
  sourceNodeId: string,
  slotIndex: number,
  runId: string,
  createdAt: string
): Record<string, StudioJsonValue> {
  return {
    sourcePath: "",
    [MANAGED_MEDIA_OWNER_KEY]: MANAGED_MEDIA_OWNER,
    [MANAGED_MEDIA_SOURCE_NODE_ID_KEY]: sourceNodeId,
    [MANAGED_MEDIA_SLOT_INDEX_KEY]: slotIndex,
    [MANAGED_OUTPUT_PENDING_KEY]: true,
    [MANAGED_OUTPUT_PENDING_RUN_ID_KEY]: runId,
    [MANAGED_OUTPUT_PENDING_AT_KEY]: createdAt,
    [MANAGED_OUTPUT_PENDING_MEDIA_KIND_KEY]: mediaKind,
  };
}

/** Which media a placeholder card is waiting for; image unless the producer stamped video. */
export function readManagedPendingMediaKind(node: StudioNodeInstance): StudioManagedMediaKind {
  const config = asRecord(node.config);
  return config && config[MANAGED_OUTPUT_PENDING_MEDIA_KIND_KEY] === "video" ? "video" : "image";
}

function readExpectedMediaCount(profile: ManagedMediaProfile, sourceNode: StudioNodeInstance): number {
  // Video jobs always yield a single clip; there is no count config.
  if (profile.kind === "video") return 1;
  const config = asRecord(sourceNode.config) || {};
  const countRaw = Number(config.count);
  if (!Number.isFinite(countRaw) || countRaw <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(8, Math.floor(countRaw)));
}

/** One operation owns the edge and group indexes while it attaches outputs. */
function mediaOutputLinks(
  options: Pick<MaterializeMediaOutputsOptions, "project" | "sourceNode" | "createEdgeId">,
  profile: ManagedMediaProfile,
  createdEdgeIds: string[],
): (nodeId: string) => boolean {
  const { project, sourceNode, createEdgeId } = options;
  const sourceNodeId = String(sourceNode.id || "").trim();
  const connected = new Set(project.graph.edges.filter(edge =>
    edge.fromNodeId === sourceNodeId && edge.fromPortId === profile.fromPort
    && edge.toPortId === GENERATED_MEDIA_EDGE_TO_PORT).map(edge => edge.toNodeId));
  return nodeId => {
    let changed = false;
    if (!connected.has(nodeId)) {
      const id = createEdgeId();
      project.graph.edges.push({ id, fromNodeId: sourceNodeId, fromPortId: profile.fromPort,
        toNodeId: nodeId, toPortId: GENERATED_MEDIA_EDGE_TO_PORT });
      connected.add(nodeId);
      createdEdgeIds.push(id);
      changed = true;
    }
    changed = attachOutputToContainer(project, sourceNode, nodeId) || changed;
    return changed;
  };
}

/** A generated output belongs to one producer-owned container, never the workflow frame. */
function attachOutputToContainer(project: StudioProjectV1, source: StudioNodeInstance, nodeId: string): boolean {
  const groups = project.graph.groups ||= [];
  let container = groups.find(group => group.outputForNodeId === source.id);
  let changed = false;
  if (!container) {
    const base = `outputs_${source.id}`;
    let id = base, suffix = 2;
    while (groups.some(group => group.id === id)) id = `${base}_${suffix++}`;
    container = { id, name: `${source.title || "Generation"} Outputs`, outputForNodeId: source.id, nodeIds: [] };
    groups.push(container);
    changed = true;
  }
  const ownedIds = project.graph.nodes.filter(node => readManagedMediaSourceNodeId(node) === source.id).map(node => node.id);
  const owned = new Set([...ownedIds, nodeId]);
  for (const group of groups) {
    if (group === container) continue;
    const remaining = group.nodeIds.filter(id => !owned.has(id));
    if (remaining.length !== group.nodeIds.length) { group.nodeIds = remaining; changed = true; }
  }
  for (const id of owned) if (!container.nodeIds.includes(id)) { container.nodeIds.push(id); changed = true; }
  project.graph.groups = groups.filter(group => group.nodeIds.length || group.shapeIds?.length);
  return changed;
}

/** Three columns, stable generation order, measured rows. Ordinary groups and nodes never move. */
export function arrangeManagedOutputContainers(project: StudioProjectV1, measure?: StudioOutputNodeMeasure): string[] {
  const nodeById = new Map(project.graph.nodes.map(node => [node.id, node]));
  const moved: string[] = [];
  for (const group of project.graph.groups || []) {
    if (!group.outputForNodeId || !nodeById.has(group.outputForNodeId)) continue;
    const outputs = group.nodeIds.map(id => nodeById.get(id)).filter((node): node is StudioNodeInstance =>
      Boolean(node && readManagedMediaSlot(node)?.sourceNodeId === group.outputForNodeId));
    outputs.sort((a, b) => readManagedMediaSlot(a)!.slotIndex - readManagedMediaSlot(b)!.slotIndex);
    if (!outputs.length) continue;
    const source = nodeById.get(group.outputForNodeId)!;
    const x = resolveManagedOutputTargetX(source, measure) + (group.outputOffset?.x ?? 96) - 96;
    const y = source.position.y + (group.outputOffset?.y ?? 0);
    const sizes = outputs.map(node => {
      const measured = measure?.(node);
      return { width: measured?.width || resolveStudioGraphNodeWidth(node),
        height: measured?.height || node.size?.height || resolveStudioGraphNodeMinHeight(node) };
    });
    const columns = Math.min(3, outputs.length);
    const widths = Array.from({ length: columns }, () => 0);
    const heights = Array.from({ length: Math.ceil(outputs.length / columns) }, () => 0);
    sizes.forEach((size, i) => { widths[i % columns] = Math.max(widths[i % columns], size.width); heights[Math.floor(i / columns)] = Math.max(heights[Math.floor(i / columns)], size.height); });
    let top = y;
    for (let row = 0; row < heights.length; row++) {
      let left = x;
      for (let column = 0; column < columns; column++) {
        const node = outputs[row * columns + column];
        if (node && (node.position.x !== Math.round(left) || node.position.y !== Math.round(top))) {
          node.position = { x: Math.round(left), y: Math.round(top) }; moved.push(node.id);
        }
        left += widths[column] + 48;
      }
      top += heights[row] + 48;
    }
  }
  return moved;
}

function nextManagedMediaSlotIndex(project: StudioProjectV1, sourceNodeId: string): number {
  let next = 0;
  for (const node of project.graph.nodes) {
    const managed = readManagedMediaSlot(node);
    if (!managed || managed.sourceNodeId !== sourceNodeId) {
      continue;
    }
    next = Math.max(next, managed.slotIndex + 1);
  }
  return next;
}

export function isManagedOutputPlaceholderNode(node: StudioNodeInstance): boolean {
  return readManagedOutputPendingFlag(node);
}

// Generated outputs have the same presentation references as user-created
// nodes. Retiring an output must remove those references in the same mutation.
function removeOutputPresentationReferences(project: StudioProjectV1, removed: Set<string>): void {
  removeStudioArrowsForItems(project, removed);
  if (project.graph.layout?.pinnedNodeIds) {
    project.graph.layout.pinnedNodeIds = project.graph.layout.pinnedNodeIds.filter(id => !removed.has(id));
  }
  project.graph.entryNodeIds = project.graph.entryNodeIds.filter(id => !removed.has(id));
  for (const node of project.graph.nodes) if (node.parentId && removed.has(node.parentId)) delete node.parentId;
}

export function removePendingManagedOutputNodes(
  options: RemovePendingManagedOutputNodesOptions
): RemovePendingManagedOutputNodesResult {
  const sourceNodeId = String(options.sourceNodeId || "").trim();
  const runId = String(options.runId || "").trim();
  const removalCandidates = new Set<string>();

  for (const node of options.project.graph.nodes) {
    if (!readManagedOutputPendingFlag(node)) {
      continue;
    }
    const nodeSourceId = readManagedMediaSourceNodeId(node) || readManagedTextSourceNodeId(node);
    if (sourceNodeId && nodeSourceId !== sourceNodeId) {
      continue;
    }
    const pendingRunId = readManagedOutputPendingRunId(node);
    if (runId && pendingRunId !== runId) {
      continue;
    }
    removalCandidates.add(node.id);
  }

  return removeOutputNodes(options.project, removalCandidates);
}

export function cleanupStaleManagedOutputPlaceholders(
  project: StudioProjectV1
): RemovePendingManagedOutputNodesResult {
  return removePendingManagedOutputNodes({ project });
}

export function removeManagedTextOutputNodes(options: {
  project: StudioProjectV1;
  sourceNodeId?: string;
}): RemovePendingManagedOutputNodesResult {
  const sourceNodeId = String(options.sourceNodeId || "").trim();
  const removalCandidates = new Set<string>();
  for (const node of options.project.graph.nodes) {
    if (!isManagedTextNode(node)) {
      continue;
    }
    if (sourceNodeId) {
      const managedSourceNodeId = readManagedTextSourceNodeId(node);
      if (managedSourceNodeId !== sourceNodeId) {
        continue;
      }
    }
    removalCandidates.add(node.id);
  }

  return removeOutputNodes(options.project, removalCandidates);
}

function removeOutputNodes(project: StudioProjectV1, removed: Set<string>): RemovePendingManagedOutputNodesResult {
  if (removed.size === 0) {
    return emptyRemovePendingResult();
  }

  removeOutputPresentationReferences(project, removed);
  const previousNodeCount = project.graph.nodes.length;
  const removedEdgeIds = project.graph.edges
    .filter((edge) => removed.has(edge.fromNodeId) || removed.has(edge.toNodeId))
    .map((edge) => edge.id);
  project.graph.nodes = project.graph.nodes.filter(
    (node) => !removed.has(node.id)
  );
  project.graph.edges = project.graph.edges.filter(
    (edge) => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId)
  );

  for (const group of project.graph.groups || []) {
    const nodeIds = Array.isArray(group.nodeIds) ? group.nodeIds : [];
    group.nodeIds = nodeIds.filter((nodeId) => !removed.has(nodeId));
  }
  if (Array.isArray(project.graph.groups)) {
    project.graph.groups = project.graph.groups.filter(
      (group) => group.nodeIds.length > 0 || (group.shapeIds || []).length > 0
    );
  }

  const removedNodeIds = Array.from(removed);

  return {
    changed: project.graph.nodes.length !== previousNodeCount || removedEdgeIds.length > 0,
    removedNodeIds,
    removedEdgeIds,
  };
}

export function materializePendingImageOutputPlaceholders(
  options: MaterializePendingMediaOutputPlaceholdersOptions
): MaterializeManagedOutputsResult {
  return materializePendingMediaOutputPlaceholders(MEDIA_PROFILES.image, options);
}

export function materializePendingVideoOutputPlaceholders(
  options: MaterializePendingMediaOutputPlaceholdersOptions
): MaterializeManagedOutputsResult {
  return materializePendingMediaOutputPlaceholders(MEDIA_PROFILES.video, options);
}

function materializePendingMediaOutputPlaceholders(
  profile: ManagedMediaProfile,
  options: MaterializePendingMediaOutputPlaceholdersOptions
): MaterializeManagedOutputsResult {
  const sourceNodeId = String(options.sourceNode.id || "").trim();
  const runId = String(options.runId || "").trim();
  if (!sourceNodeId || !runId) {
    return emptyMaterializeResult();
  }

  const expectedCount = readExpectedMediaCount(profile, options.sourceNode);
  const createdAt = String(options.createdAt || "").trim() || new Date().toISOString();
  const createdNodeIds: string[] = [];
  const createdEdgeIds: string[] = [];
  const linkOutput = mediaOutputLinks(options, profile, createdEdgeIds);
  let changed = false;
  const existingPendingNodes = options.project.graph.nodes.filter((node) => {
    if (!readManagedOutputPendingFlag(node)) {
      return false;
    }
    const managed = readManagedMediaSlot(node);
    if (!managed) {
      return false;
    }
    return (
      managed.sourceNodeId === sourceNodeId &&
      readManagedOutputPendingRunId(node) === runId
    );
  });
  for (const existingNode of existingPendingNodes) {
    changed = linkOutput(existingNode.id) || changed;
  }
  if (existingPendingNodes.length >= expectedCount) {
    return {
      changed,
      createdNodeIds,
      updatedNodeIds: [],
      createdEdgeIds,
    };
  }

  let nextSlotIndex = nextManagedMediaSlotIndex(options.project, sourceNodeId);
  for (let outputIndex = existingPendingNodes.length; outputIndex < expectedCount; outputIndex += 1) {
    const slotIndex = nextSlotIndex++;
    const nodeId = options.createNodeId();
    const newNode: StudioNodeInstance = {
      id: nodeId,
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: buildManagedMediaTitle(profile, options.sourceNode, slotIndex, slotIndex + 1),
      position: newOutputPosition(options),
      config: createPendingManagedMediaConfig(profile.kind, sourceNodeId, slotIndex, runId, createdAt),
      continueOnError: false,
      disabled: true,
    };
    options.project.graph.nodes.push(newNode);
    createdNodeIds.push(nodeId);
    changed = true;
    changed = linkOutput(nodeId) || changed;
  }

  changed = arrangeManagedOutputContainers(options.project, options.measure).length > 0 || changed;

  return {
    changed,
    createdNodeIds,
    updatedNodeIds: [],
    createdEdgeIds,
  };
}

export function materializeImageOutputsAsMediaNodes(
  options: MaterializeMediaOutputsOptions
): MaterializeManagedOutputsResult {
  return materializeMediaOutputsAsMediaNodes(MEDIA_PROFILES.image, options);
}

export function materializeVideoOutputsAsMediaNodes(
  options: MaterializeMediaOutputsOptions
): MaterializeManagedOutputsResult {
  return materializeMediaOutputsAsMediaNodes(MEDIA_PROFILES.video, options);
}

function materializeMediaOutputsAsMediaNodes(
  profile: ManagedMediaProfile,
  options: MaterializeMediaOutputsOptions
): MaterializeManagedOutputsResult {
  const sourceNodeId = String(options.sourceNode.id || "").trim();
  if (!sourceNodeId) {
    return emptyMaterializeResult();
  }

  const outputPaths = uniquePaths(extractOutputMediaPaths(options.outputs, profile.outputsKey));
  if (outputPaths.length === 0) {
    return emptyMaterializeResult();
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
    if (sourcePath && (!options.runId || node.config[MANAGED_OUTPUT_RUN_ID_KEY] === options.runId) && !managedNodesByPath.has(sourcePath)) {
      managedNodesByPath.set(sourcePath, node);
    }
    const managed = readManagedMediaSlot(node);
    if (managed) {
      nextManagedSlotIndex = Math.max(nextManagedSlotIndex, managed.slotIndex + 1);
    }
  }
  // Index legacy connected cards once, in edge order. Explicit managed metadata
  // wins over path-only adoption, exactly as in saved projects before indexing.
  const usedNodeIds = new Set(Array.from(managedNodesByPath.values()).map(node => node.id));
  const nodeById = new Map(options.project.graph.nodes.map(node => [node.id, node]));
  for (const edge of options.project.graph.edges) {
    if (edge.fromNodeId !== sourceNodeId || !GENERATED_MEDIA_EDGE_FROM_PORTS.includes(edge.fromPortId)
      || ![GENERATED_MEDIA_EDGE_TO_PORT, "path"].includes(edge.toPortId)) continue;
    const node = nodeById.get(edge.toNodeId);
    if (!node || node.kind !== "studio.media_ingest" || usedNodeIds.has(node.id) || readManagedMediaSlot(node)) continue;
    const path = String(node.config.sourcePath || "").trim();
    if (path && !managedNodesByPath.has(path)) managedNodesByPath.set(path, node);
  }

  const createdNodeIds: string[] = [];
  const updatedNodeIds: string[] = [];
  const createdEdgeIds: string[] = [];
  const linkOutput = mediaOutputLinks(options, profile, createdEdgeIds);
  let changed = false;

  const pending = options.runId ? options.project.graph.nodes.filter(node =>
    readManagedMediaSourceNodeId(node) === sourceNodeId && readManagedOutputPendingRunId(node) === options.runId)
    .sort((a, b) => readManagedMediaSlot(a)!.slotIndex - readManagedMediaSlot(b)!.slotIndex) : [];

  for (const sourcePath of outputPaths) {
    if (!sourcePath) {
      continue;
    }

    const existingNode = managedNodesByPath.get(sourcePath) || pending.shift();
    // Explicit connected cards remain user-owned and keep their placement.
    if (existingNode && !readManagedMediaSlot(existingNode)) continue;
    if (existingNode) {
      const existingConfig = asRecord(existingNode.config) || {};
      const existingManaged = readManagedMediaSlot(existingNode);
      const slotIndex = existingManaged?.slotIndex ?? nextManagedSlotIndex++;
      const baseConfig = stripManagedPendingFields(
        existingNode.config
      );
      const nextConfig = {
        ...baseConfig,
        sourcePath,
        [MANAGED_MEDIA_OWNER_KEY]: MANAGED_MEDIA_OWNER,
        [MANAGED_MEDIA_SOURCE_NODE_ID_KEY]: sourceNodeId,
        [MANAGED_MEDIA_SLOT_INDEX_KEY]: slotIndex,
        ...(options.runId ? { [MANAGED_OUTPUT_RUN_ID_KEY]: options.runId } : {}),
      };
      if (JSON.stringify(existingConfig) !== JSON.stringify(nextConfig)) {
        existingNode.config = nextConfig;
        changed = true;
        updatedNodeIds.push(existingNode.id);
      }
      if (existingNode.disabled === true) {
        existingNode.disabled = false;
        changed = true;
      }
      managedNodesByPath.set(sourcePath, existingNode);
      changed = linkOutput(existingNode.id) || changed;
      continue;
    }

    const nodeId = options.createNodeId();
    const slotIndex = nextManagedSlotIndex++;
    const newNode: StudioNodeInstance = {
      id: nodeId,
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: buildManagedMediaTitle(profile, options.sourceNode, slotIndex, slotIndex + 1),
      position: newOutputPosition(options),
      config: { ...createManagedMediaConfig(sourceNodeId, slotIndex, sourcePath),
        ...(options.runId ? { [MANAGED_OUTPUT_RUN_ID_KEY]: options.runId } : {}) },
      continueOnError: false,
      disabled: false,
    };

    options.project.graph.nodes.push(newNode);
    managedNodesByPath.set(sourcePath, newNode);
    changed = true;
    createdNodeIds.push(nodeId);
    changed = linkOutput(nodeId) || changed;
  }

  const moved = arrangeManagedOutputContainers(options.project, options.measure);
  changed = moved.length > 0 || changed;
  return {
    changed,
    createdNodeIds,
    updatedNodeIds,
    createdEdgeIds,
  };
}
