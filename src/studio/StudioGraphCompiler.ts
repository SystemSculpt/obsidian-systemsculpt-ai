import type {
  StudioEdge,
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioNodeInputMap,
  StudioNodeOutputMap,
  StudioProjectV1,
} from "./types";
import { planStudioRun } from "./StudioRunScope";
import { validateNodeConfig } from "./StudioNodeConfigValidation";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { resolveNodeDefinitionPorts } from "./StudioNodePortResolution";

export type StudioCompiledNode = {
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  inboundEdges: StudioEdge[];
  outboundEdges: StudioEdge[];
  dependencyNodeIds: string[];
  dependentNodeIds: string[];
};

export type StudioCompiledGraph = {
  project: StudioProjectV1;
  nodesById: Map<string, StudioCompiledNode>;
  executionOrder: string[];
};

export type StudioCompiledRun = StudioCompiledGraph & {
  executeNodeIds: string[];
  providedNodeIds: ReadonlySet<string>;
  inputNodeId?: string;
  resolveInputs: (nodeId: string, outputs: ReadonlyMap<string, StudioNodeOutputMap>) => StudioNodeInputMap;
};

export type StudioGraphCompileOptions = {
  /**
   * "run" (default) enforces run readiness: node configs must satisfy their
   * schemas and required input ports must be connected.
   * "document" checks only structural integrity (IDs, kinds, edges, ports,
   * cycles). It must accept every state Studio itself can persist — nodes
   * with unfinished configs and unwired required inputs are normal canvas
   * states, so persistence and agent-edit gates use this mode.
   */
  validation?: "run" | "document";
  /** Recorded-output boundaries participate in structure but will not execute. */
  providedNodeIds?: ReadonlySet<string>;
};

function typeCompatible(source: string, target: string): boolean {
  if (source === "any" || target === "any") return true;
  return source === target;
}

export class StudioGraphCompiler {
  compileRun(project: StudioProjectV1, registry: StudioNodeRegistry, options?: { entryNodeIds?: string[]; prepareInputsFor?: string }): StudioCompiledRun {
    const inputNodeId = options?.prepareInputsFor;
    const plan = planStudioRun(project, inputNodeId ? [inputNodeId] : options?.entryNodeIds, node => registry.get(node.kind, node.version)?.cachePolicy);
    const providedNodeIds = new Set(plan.providedNodeIds);
    const compiled = this.compile(plan.project, registry, {
      providedNodeIds: inputNodeId ? new Set([...providedNodeIds, inputNodeId]) : providedNodeIds,
    });
    return {
      ...compiled, inputNodeId, providedNodeIds,
      executeNodeIds: plan.executeNodeIds.filter(id => id !== inputNodeId),
      resolveInputs: (nodeId, outputs) => {
        const node = compiled.nodesById.get(nodeId);
        if (!node) throw new Error(`Unknown Studio node "${nodeId}".`);
        const valuesByPort = new Map<string, StudioNodeInputMap[string][]>();
        for (const edge of node.inboundEdges) {
          if (providedNodeIds.has(edge.fromNodeId) && !outputs.has(edge.fromNodeId)) {
            const upstream = compiled.nodesById.get(edge.fromNodeId)?.node;
            throw new Error(`Run "${upstream?.title || edge.fromNodeId}" first. It has no output yet, and Studio does not rerun it on your behalf.`);
          }
          const value = outputs.get(edge.fromNodeId)?.[edge.fromPortId];
          if (value === undefined) continue;
          const values = valuesByPort.get(edge.toPortId) || [];
          values.push(value);
          valuesByPort.set(edge.toPortId, values);
        }
        for (const port of node.definition.inputPorts) {
          if (port.required && !valuesByPort.has(port.id)) throw new Error(`Required input "${port.id}" has no output for node "${node.node.title || nodeId}".`);
        }
        // Array-valued outputs remain one producer's value, never a mutable accumulator.
        return Object.fromEntries([...valuesByPort].map(([port, values]) => [port, values.length === 1 ? values[0] : values]));
      },
    };
  }

  compile(
    project: StudioProjectV1,
    registry: StudioNodeRegistry,
    options?: StudioGraphCompileOptions
  ): StudioCompiledGraph {
    const enforceRunReadiness = options?.validation !== "document";
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

      if (enforceRunReadiness && !options?.providedNodeIds?.has(node.id)) {
        const configValidation = validateNodeConfig(baseDefinition, node.config);
        if (!configValidation.isValid) {
          const firstError = configValidation.errors[0];
          throw new Error(
            `Graph compile failed: invalid config on node "${node.id}" field "${firstError.fieldKey}" (${firstError.message}).`
          );
        }
      }

      const definition = resolveNodeDefinitionPorts(node, baseDefinition);
      nodesById.set(node.id, {
        node,
        definition,
        inboundEdges: [],
        outboundEdges: [],
        dependencyNodeIds: [],
        dependentNodeIds: [],
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
        fromNode.dependentNodeIds.push(toNode.node.id);
      }
    }

    if (enforceRunReadiness) {
      for (const compiled of nodesById.values()) {
        if (options?.providedNodeIds?.has(compiled.node.id)) continue;
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
      // In-degree counts predecessor nodes, not individual port connections.
      for (const dependentId of node.dependentNodeIds) {
        const nextDegree = (inDegree.get(dependentId) || 0) - 1;
        inDegree.set(dependentId, nextDegree);
        if (nextDegree === 0) {
          ready.push(dependentId);
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
