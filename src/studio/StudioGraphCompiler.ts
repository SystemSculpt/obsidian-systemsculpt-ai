import type {
  StudioEdge,
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioProjectV1,
} from "./types";
import { validateNodeConfig } from "./StudioNodeConfigValidation";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { resolveNodeDefinitionPorts } from "./StudioNodePortResolution";

export type StudioCompiledNode = {
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  inboundEdges: StudioEdge[];
  outboundEdges: StudioEdge[];
  dependencyNodeIds: string[];
};

export type StudioCompiledGraph = {
  project: StudioProjectV1;
  nodesById: Map<string, StudioCompiledNode>;
  executionOrder: string[];
};

function typeCompatible(source: string, target: string): boolean {
  if (source === "any" || target === "any") return true;
  return source === target;
}

export class StudioGraphCompiler {
  compile(project: StudioProjectV1, registry: StudioNodeRegistry): StudioCompiledGraph {
    const nodesById = new Map<string, StudioCompiledNode>();
    const edgeIds = new Set<string>();

    for (const node of project.graph.nodes) {
      if (nodesById.has(node.id)) {
        throw new Error(`Graph compile failed: duplicate node ID "${node.id}".`);
      }

      const baseDefinition = registry.get(node.kind, node.version);
      if (!baseDefinition) {
        throw new Error(
          `Graph compile failed: missing node definition for "${node.kind}@${node.version}".`
        );
      }

      const configValidation = validateNodeConfig(baseDefinition, node.config);
      if (!configValidation.isValid) {
        const firstError = configValidation.errors[0];
        throw new Error(
          `Graph compile failed: invalid config on node "${node.id}" field "${firstError.fieldKey}" (${firstError.message}).`
        );
      }

      const definition = resolveNodeDefinitionPorts(node, baseDefinition);
      nodesById.set(node.id, {
        node,
        definition,
        inboundEdges: [],
        outboundEdges: [],
        dependencyNodeIds: [],
      });
    }

    for (const edge of project.graph.edges) {
      if (edgeIds.has(edge.id)) {
        throw new Error(`Graph compile failed: duplicate edge ID "${edge.id}".`);
      }
      edgeIds.add(edge.id);

      const fromNode = nodesById.get(edge.fromNodeId);
      const toNode = nodesById.get(edge.toNodeId);
      if (!fromNode) {
        throw new Error(`Graph compile failed: edge "${edge.id}" source node missing.`);
      }
      if (!toNode) {
        throw new Error(`Graph compile failed: edge "${edge.id}" target node missing.`);
      }

      const sourcePort = fromNode.definition.outputPorts.find((port) => port.id === edge.fromPortId);
      if (!sourcePort) {
        throw new Error(
          `Graph compile failed: edge "${edge.id}" source port "${edge.fromPortId}" is invalid for node "${edge.fromNodeId}".`
        );
      }

      const targetPort = toNode.definition.inputPorts.find((port) => port.id === edge.toPortId);
      if (!targetPort) {
        throw new Error(
          `Graph compile failed: edge "${edge.id}" target port "${edge.toPortId}" is invalid for node "${edge.toNodeId}".`
        );
      }

      if (!typeCompatible(sourcePort.type, targetPort.type)) {
        throw new Error(
          `Graph compile failed: type mismatch on edge "${edge.id}" (${sourcePort.type} -> ${targetPort.type}).`
        );
      }

      fromNode.outboundEdges.push(edge);
      toNode.inboundEdges.push(edge);
      if (!toNode.dependencyNodeIds.includes(fromNode.node.id)) {
        toNode.dependencyNodeIds.push(fromNode.node.id);
      }
    }

    for (const compiled of nodesById.values()) {
      for (const port of compiled.definition.inputPorts) {
        if (port.required !== true) continue;
        const hasIncoming = compiled.inboundEdges.some((edge) => edge.toPortId === port.id);
        if (!hasIncoming) {
          throw new Error(
            `Graph compile failed: required input "${port.id}" missing on node "${compiled.node.id}".`
          );
        }
      }
    }

    const inDegree = new Map<string, number>();
    for (const [nodeId, compiled] of nodesById.entries()) {
      inDegree.set(nodeId, compiled.dependencyNodeIds.length);
    }

    const ready = Array.from(inDegree.entries())
      .filter(([, degree]) => degree === 0)
      .map(([nodeId]) => nodeId);
    const order: string[] = [];

    while (ready.length > 0) {
      const nodeId = ready.shift()!;
      order.push(nodeId);
      const node = nodesById.get(nodeId)!;
      for (const edge of node.outboundEdges) {
        const nextDegree = (inDegree.get(edge.toNodeId) || 0) - 1;
        inDegree.set(edge.toNodeId, nextDegree);
        if (nextDegree === 0) {
          ready.push(edge.toNodeId);
        }
      }
    }

    if (order.length !== nodesById.size) {
      throw new Error("Graph compile failed: cycle detected in Studio graph.");
    }

    return {
      project,
      nodesById,
      executionOrder: order,
    };
  }
}
