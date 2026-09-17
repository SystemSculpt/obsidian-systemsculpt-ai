import type { StudioEdge, StudioNodeCachePolicy, StudioNodeInstance, StudioProjectV1 } from "./types";
import { isStudioVisualOnlyNodeKind } from "./StudioNodeKinds";

/**
 * What one run will touch. `executeNodeIds` run (subject to by-inputs
 * caching); `providedNodeIds` are upstream nodes whose latest recorded
 * outputs feed the run without executing again.
 */
export type StudioRunPlan = {
  project: StudioProjectV1;
  executeNodeIds: string[];
  providedNodeIds: string[];
};

function restrictProject(project: StudioProjectV1, keep: Set<string>): StudioProjectV1 {
  const nodes = project.graph.nodes.filter(node => keep.has(node.id));
  const edges = project.graph.edges.filter(edge => keep.has(edge.fromNodeId) && keep.has(edge.toNodeId));
  const inbound = new Set(edges.map(edge => edge.toNodeId));
  return { ...project, graph: {
    ...project.graph, nodes, edges,
    entryNodeIds: nodes.filter(node => !inbound.has(node.id)).map(node => node.id),
    groups: (project.graph.groups || []).map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => keep.has(id)) })).filter(group => group.nodeIds.length > 0),
  } };
}

function normalizeEntries(project: StudioProjectV1, entryNodeIds?: string[]): string[] {
  const scopedEntries = Array.from(
    new Set((entryNodeIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  const nodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  for (const nodeId of scopedEntries) {
    const node = nodeById.get(nodeId);
    if (!node) {
      throw new Error(`Cannot run from node "${nodeId}" because it does not exist in this graph.`);
    }
    if (isStudioVisualOnlyNodeKind(node.kind)) {
      throw new Error(`Cannot run from node "${nodeId}" because "${node.kind}" is visual-only.`);
    }
  }
  return scopedEntries;
}

/**
 * Plans a run. With no entry nodes the whole executable graph runs. With
 * entry nodes, those nodes run, and upstream nodes are walked only through
 * nodes that cache by inputs (cheap, deterministic, reused when unchanged).
 * An upstream node that never caches (generation, Codex, processes, notes,
 * datasets) is a boundary: it is never re-executed on the user's behalf; its
 * latest recorded outputs are provided instead, and nothing beyond it is
 * touched. "Run" on a video card therefore never regenerates the image that
 * feeds it.
 */
export function planStudioRun(
  project: StudioProjectV1,
  entryNodeIds: string[] | undefined,
  cachePolicyOf: (node: StudioNodeInstance) => StudioNodeCachePolicy | undefined,
): StudioRunPlan {
  const scopedEntries = normalizeEntries(project, entryNodeIds);
  const nodes = project.graph.nodes.filter(node => !isStudioVisualOnlyNodeKind(node.kind));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  if (scopedEntries.length === 0) {
    return {
      project: nodes.length === project.graph.nodes.length ? project : restrictProject(project, new Set(nodeById.keys())),
      executeNodeIds: nodes.map(node => node.id), providedNodeIds: [],
    };
  }

  const inboundByNode = new Map<string, StudioEdge[]>();
  for (const edge of project.graph.edges) {
    const inbound = inboundByNode.get(edge.toNodeId) || [];
    inbound.push(edge);
    inboundByNode.set(edge.toNodeId, inbound);
  }

  const targets = new Set(scopedEntries);
  const execute = new Set<string>(scopedEntries);
  const provided = new Set<string>();
  const queue = [...scopedEntries];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    for (const edge of inboundByNode.get(nodeId) || []) {
      const upstreamId = edge.fromNodeId;
      if (execute.has(upstreamId) || provided.has(upstreamId)) continue;
      const upstream = nodeById.get(upstreamId);
      if (!upstream) continue;
      if (!targets.has(upstreamId) && (cachePolicyOf(upstream) || "by_inputs") === "never") {
        provided.add(upstreamId);
        continue;
      }
      execute.add(upstreamId);
      queue.push(upstreamId);
    }
  }

  const keep = new Set<string>([...execute, ...provided]);
  return {
    project: restrictProject(project, keep),
    executeNodeIds: nodes.filter((node) => execute.has(node.id)).map((node) => node.id),
    providedNodeIds: nodes.filter((node) => provided.has(node.id)).map((node) => node.id),
  };
}

/** Legacy shape: the entry nodes plus every upstream ancestor, all executable. */
export function scopeProjectForRun(
  project: StudioProjectV1,
  entryNodeIds?: string[]
): StudioProjectV1 {
  return planStudioRun(project, entryNodeIds, () => "by_inputs").project;
}
