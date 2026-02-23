import type { StudioEdge, StudioProjectV1 } from "./types";
import { isStudioVisualOnlyNodeKind } from "./StudioNodeKinds";

function projectHasVisualOnlyNodes(project: StudioProjectV1): boolean {
  return project.graph.nodes.some((node) => isStudioVisualOnlyNodeKind(node.kind));
}

function filterVisualOnlyNodesFromProject(project: StudioProjectV1): StudioProjectV1 {
  const keepNodeIds = new Set(
    project.graph.nodes
      .filter((node) => !isStudioVisualOnlyNodeKind(node.kind))
      .map((node) => node.id)
  );
  const nodes = project.graph.nodes.filter((node) => keepNodeIds.has(node.id));
  const edges = project.graph.edges.filter(
    (edge) => keepNodeIds.has(edge.fromNodeId) && keepNodeIds.has(edge.toNodeId)
  );
  const inboundCounts = new Map<string, number>();
  for (const node of nodes) {
    inboundCounts.set(node.id, 0);
  }
  for (const edge of edges) {
    inboundCounts.set(edge.toNodeId, (inboundCounts.get(edge.toNodeId) || 0) + 1);
  }
  const entryNodeIds = nodes
    .filter((node) => (inboundCounts.get(node.id) || 0) === 0)
    .map((node) => node.id);
  const groups = (project.graph.groups || [])
    .map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((nodeId) => keepNodeIds.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length > 0);

  return {
    ...project,
    graph: {
      ...project.graph,
      nodes,
      edges,
      entryNodeIds,
      groups,
    },
  };
}

export function scopeProjectForRun(
  project: StudioProjectV1,
  entryNodeIds?: string[]
): StudioProjectV1 {
  const executableProject = projectHasVisualOnlyNodes(project)
    ? filterVisualOnlyNodesFromProject(project)
    : project;
  const scopedEntries = Array.from(
    new Set((entryNodeIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  if (scopedEntries.length === 0) {
    return executableProject;
  }

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

  const outboundByNode = new Map<string, StudioEdge[]>();
  const inboundByNode = new Map<string, StudioEdge[]>();
  for (const edge of executableProject.graph.edges) {
    const outbound = outboundByNode.get(edge.fromNodeId) || [];
    outbound.push(edge);
    outboundByNode.set(edge.fromNodeId, outbound);

    const inbound = inboundByNode.get(edge.toNodeId) || [];
    inbound.push(edge);
    inboundByNode.set(edge.toNodeId, inbound);
  }

  const keepNodeIds = new Set<string>();
  const downstreamQueue = [...scopedEntries];
  while (downstreamQueue.length > 0) {
    const nodeId = downstreamQueue.shift()!;
    if (keepNodeIds.has(nodeId)) continue;
    keepNodeIds.add(nodeId);
    const outbound = outboundByNode.get(nodeId) || [];
    for (const edge of outbound) {
      downstreamQueue.push(edge.toNodeId);
    }
  }

  const upstreamQueue = Array.from(keepNodeIds);
  while (upstreamQueue.length > 0) {
    const nodeId = upstreamQueue.shift()!;
    const inbound = inboundByNode.get(nodeId) || [];
    for (const edge of inbound) {
      if (keepNodeIds.has(edge.fromNodeId)) continue;
      keepNodeIds.add(edge.fromNodeId);
      upstreamQueue.push(edge.fromNodeId);
    }
  }

  const scopedNodes = executableProject.graph.nodes.filter((node) => keepNodeIds.has(node.id));
  const scopedEdges = executableProject.graph.edges.filter(
    (edge) => keepNodeIds.has(edge.fromNodeId) && keepNodeIds.has(edge.toNodeId)
  );
  const scopedInbound = new Map<string, number>();
  for (const node of scopedNodes) {
    scopedInbound.set(node.id, 0);
  }
  for (const edge of scopedEdges) {
    scopedInbound.set(edge.toNodeId, (scopedInbound.get(edge.toNodeId) || 0) + 1);
  }
  const scopedEntryNodeIds = scopedNodes
    .filter((node) => (scopedInbound.get(node.id) || 0) === 0)
    .map((node) => node.id);
  const scopedNodeIds = new Set(scopedNodes.map((node) => node.id));
  const scopedGroups = (executableProject.graph.groups || [])
    .map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((nodeId) => scopedNodeIds.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length > 0);

  return {
    ...executableProject,
    graph: {
      ...executableProject.graph,
      nodes: scopedNodes,
      edges: scopedEdges,
      entryNodeIds: scopedEntryNodeIds,
      groups: scopedGroups,
    },
  };
}
