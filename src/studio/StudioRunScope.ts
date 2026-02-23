import type { StudioEdge, StudioProjectV1 } from "./types";

export function scopeProjectForRun(
  project: StudioProjectV1,
  entryNodeIds?: string[]
): StudioProjectV1 {
  const scopedEntries = Array.from(
    new Set((entryNodeIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  if (scopedEntries.length === 0) {
    return project;
  }

  const nodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
  for (const nodeId of scopedEntries) {
    if (!nodeById.has(nodeId)) {
      throw new Error(`Cannot run from node "${nodeId}" because it does not exist in this graph.`);
    }
  }

  const outboundByNode = new Map<string, StudioEdge[]>();
  const inboundByNode = new Map<string, StudioEdge[]>();
  for (const edge of project.graph.edges) {
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

  const scopedNodes = project.graph.nodes.filter((node) => keepNodeIds.has(node.id));
  const scopedEdges = project.graph.edges.filter(
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
  const scopedGroups = (project.graph.groups || [])
    .map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((nodeId) => scopedNodeIds.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length > 0);

  return {
    ...project,
    graph: {
      ...project.graph,
      nodes: scopedNodes,
      edges: scopedEdges,
      entryNodeIds: scopedEntryNodeIds,
      groups: scopedGroups,
    },
  };
}
