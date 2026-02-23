import type { StudioEdge, StudioJsonValue, StudioProjectV1 } from "./types";
import { nowIso } from "./utils";

const PATH_ONLY_PORTS_MIGRATION_ID = "studio.path-only-ports.v1";
const PROMPT_TEMPLATE_INLINE_MIGRATION_ID = "studio.inline-prompt-template.v1";

const LEGACY_OUTPUT_PORT_REMAP: Record<string, Record<string, string>> = {
  "studio.image_generation": {
    first_image: "images",
  },
  "studio.media_ingest": {
    asset: "path",
    mime: "path",
    media_kind: "path",
  },
  "studio.audio_extract": {
    audio: "path",
    asset: "path",
    mime: "path",
  },
  "studio.prompt_template": {
    prompt_text: "prompt",
    system_prompt: "prompt",
  },
};

const LEGACY_INPUT_PORT_REMAP: Record<string, Record<string, string>> = {
  "studio.media_ingest": {
    path: "media",
    asset: "media",
    image: "media",
    images: "media",
  },
  "studio.audio_extract": {
    asset: "path",
  },
  "studio.transcription": {
    audio: "path",
    asset: "path",
  },
  "studio.text_generation": {
    system_prompt: "prompt",
  },
};

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function mapEdgePorts(edge: StudioEdge, sourceKind: string, targetKind: string): StudioEdge {
  const sourceMap = LEGACY_OUTPUT_PORT_REMAP[sourceKind] || {};
  const targetMap = LEGACY_INPUT_PORT_REMAP[targetKind] || {};
  return {
    ...edge,
    fromPortId: sourceMap[edge.fromPortId] || edge.fromPortId,
    toPortId: targetMap[edge.toPortId] || edge.toPortId,
  };
}

function normalizeMediaIngestConfig(config: Record<string, StudioJsonValue>): Record<string, StudioJsonValue> {
  const sourcePath = asText(config.sourcePath).trim() || asText(config.vaultPath).trim();
  const next: Record<string, StudioJsonValue> = {
    sourcePath,
  };
  for (const [key, value] of Object.entries(config)) {
    if (key === "sourcePath" || key === "vaultPath") {
      continue;
    }
    if (key.startsWith("__studio_")) {
      next[key] = value;
    }
  }
  return next;
}

function dedupeEdges(edges: StudioEdge[]): StudioEdge[] {
  const seen = new Set<string>();
  const result: StudioEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromNodeId}:${edge.fromPortId}->${edge.toNodeId}:${edge.toPortId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function appendTemplateToSystemPrompt(
  config: Record<string, StudioJsonValue>,
  template: string
): { config: Record<string, StudioJsonValue>; changed: boolean } {
  const normalizedTemplate = String(template || "").trim();
  if (!normalizedTemplate) {
    return { config, changed: false };
  }
  const existing = asText(config.systemPrompt).trim();
  if (!existing) {
    return {
      config: {
        ...config,
        systemPrompt: normalizedTemplate,
      },
      changed: true,
    };
  }
  if (existing.includes(normalizedTemplate)) {
    return { config, changed: false };
  }
  return {
    config: {
      ...config,
      systemPrompt: `${existing}\n\n${normalizedTemplate}`,
    },
    changed: true,
  };
}

function mapPromptTemplateInboundPortToGeneration(
  inboundPortId: string,
  targetKind: string
): string | null {
  const inbound = String(inboundPortId || "").trim();
  const isImageLikeInbound = inbound === "images" || inbound === "image" || inbound === "media";
  if (targetKind === "studio.image_generation") {
    return isImageLikeInbound ? "images" : "prompt";
  }
  if (targetKind === "studio.text_generation") {
    return isImageLikeInbound ? null : "prompt";
  }
  return null;
}

function migratePromptTemplateNodes(
  nodes: StudioProjectV1["graph"]["nodes"],
  edges: StudioEdge[],
  entryNodeIds: string[],
  groups: StudioProjectV1["graph"]["groups"] | undefined
): {
  nodes: StudioProjectV1["graph"]["nodes"];
  edges: StudioEdge[];
  entryNodeIds: string[];
  groups: StudioProjectV1["graph"]["groups"] | undefined;
  changed: boolean;
} {
  const promptTemplateNodes = nodes.filter((node) => node.kind === "studio.prompt_template");
  if (promptTemplateNodes.length === 0) {
    return { nodes, edges, entryNodeIds, groups, changed: false };
  }

  const removedNodeIds = new Set(promptTemplateNodes.map((node) => node.id));
  const nextNodes = nodes.map((node) => ({
    ...node,
    config: { ...(node.config || {}) },
  }));
  const nextNodesById = new Map(nextNodes.map((node) => [node.id, node] as const));

  const retainedEdges: StudioEdge[] = [];
  const seenEdgeSignature = new Set<string>();
  const usedEdgeIds = new Set<string>();
  function addEdgeCandidate(
    fromNodeId: string,
    fromPortId: string,
    toNodeId: string,
    toPortId: string,
    edgeId?: string
  ): void {
    if (!fromNodeId || !toNodeId || !fromPortId || !toPortId) {
      return;
    }
    if (!nextNodesById.has(fromNodeId) || !nextNodesById.has(toNodeId)) {
      return;
    }
    if (removedNodeIds.has(fromNodeId) || removedNodeIds.has(toNodeId)) {
      return;
    }
    const signature = `${fromNodeId}:${fromPortId}->${toNodeId}:${toPortId}`;
    if (seenEdgeSignature.has(signature)) {
      return;
    }
    const fallbackBase = `edge_${signature.replace(/[^a-zA-Z0-9_:-]/g, "_")}`;
    let nextEdgeId = String(edgeId || "").trim();
    if (!nextEdgeId || usedEdgeIds.has(nextEdgeId)) {
      let suffix = 0;
      nextEdgeId = fallbackBase;
      while (usedEdgeIds.has(nextEdgeId)) {
        suffix += 1;
        nextEdgeId = `${fallbackBase}_${suffix}`;
      }
    }
    usedEdgeIds.add(nextEdgeId);
    seenEdgeSignature.add(signature);
    retainedEdges.push({
      id: nextEdgeId,
      fromNodeId,
      fromPortId,
      toNodeId,
      toPortId,
    });
  }

  for (const edge of edges) {
    if (removedNodeIds.has(edge.fromNodeId) || removedNodeIds.has(edge.toNodeId)) {
      continue;
    }
    addEdgeCandidate(edge.fromNodeId, edge.fromPortId, edge.toNodeId, edge.toPortId, edge.id);
  }

  for (const promptNode of promptTemplateNodes) {
    const inboundEdges = edges.filter((edge) => edge.toNodeId === promptNode.id);
    const outboundEdges = edges.filter((edge) => edge.fromNodeId === promptNode.id);
    const template = asText(promptNode.config.template).trim();

    for (const outbound of outboundEdges) {
      const targetNode = nextNodesById.get(outbound.toNodeId);
      if (!targetNode) {
        continue;
      }
      const generationPromptTarget =
        outbound.toPortId === "prompt" &&
        (targetNode.kind === "studio.text_generation" || targetNode.kind === "studio.image_generation");

      if (generationPromptTarget) {
        const appended = appendTemplateToSystemPrompt(targetNode.config || {}, template);
        if (appended.changed) {
          targetNode.config = appended.config;
        }
      }

      if (inboundEdges.length === 0) {
        continue;
      }

      for (const inbound of inboundEdges) {
        let targetPortId = outbound.toPortId;
        if (generationPromptTarget) {
          const mapped = mapPromptTemplateInboundPortToGeneration(inbound.toPortId, targetNode.kind);
          if (!mapped) {
            continue;
          }
          targetPortId = mapped;
        }
        addEdgeCandidate(inbound.fromNodeId, inbound.fromPortId, outbound.toNodeId, targetPortId);
      }
    }
  }

  const filteredNodes = nextNodes.filter((node) => !removedNodeIds.has(node.id));
  const filteredEntryNodeIds = entryNodeIds.filter((entryNodeId) => !removedNodeIds.has(entryNodeId));
  const filteredGroups = Array.isArray(groups)
    ? groups
        .map((group) => ({
          ...group,
          nodeIds: (group.nodeIds || []).filter((nodeId) => !removedNodeIds.has(nodeId)),
        }))
        .filter((group) => group.nodeIds.length > 0)
    : groups;

  return {
    nodes: filteredNodes,
    edges: dedupeEdges(retainedEdges),
    entryNodeIds: filteredEntryNodeIds,
    groups: filteredGroups,
    changed: true,
  };
}

export function migrateStudioProjectToPathOnlyPorts(project: StudioProjectV1): {
  project: StudioProjectV1;
  changed: boolean;
} {
  let changed = false;

  let nodes = project.graph.nodes.map((node) => {
    if (node.kind !== "studio.media_ingest") {
      return node;
    }
    const nextConfig = normalizeMediaIngestConfig(node.config || {});
    const currentSerialized = JSON.stringify(node.config || {});
    const nextSerialized = JSON.stringify(nextConfig);
    if (currentSerialized !== nextSerialized) {
      changed = true;
      return {
        ...node,
        config: nextConfig,
      };
    }
    return node;
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const remappedEdges = project.graph.edges.map((edge) => {
    const sourceKind = nodesById.get(edge.fromNodeId)?.kind || "";
    const targetKind = nodesById.get(edge.toNodeId)?.kind || "";
    const nextEdge = mapEdgePorts(edge, sourceKind, targetKind);
    if (nextEdge.fromPortId !== edge.fromPortId || nextEdge.toPortId !== edge.toPortId) {
      changed = true;
    }
    return nextEdge;
  });
  let edges = dedupeEdges(remappedEdges);
  if (edges.length !== remappedEdges.length) {
    changed = true;
  }

  let entryNodeIds = project.graph.entryNodeIds;
  let groups = project.graph.groups;
  const promptTemplateMigration = migratePromptTemplateNodes(nodes, edges, entryNodeIds, groups);
  if (promptTemplateMigration.changed) {
    changed = true;
    nodes = promptTemplateMigration.nodes;
    edges = promptTemplateMigration.edges;
    entryNodeIds = promptTemplateMigration.entryNodeIds;
    groups = promptTemplateMigration.groups;
  }

  if (!changed) {
    return { project, changed: false };
  }

  const appliedMigrationIds = new Set(project.migrations.applied.map((entry) => entry.id));
  const nextApplied = [...project.migrations.applied];
  if (!appliedMigrationIds.has(PATH_ONLY_PORTS_MIGRATION_ID)) {
    nextApplied.push({
      id: PATH_ONLY_PORTS_MIGRATION_ID,
      at: nowIso(),
    });
  }
  if (promptTemplateMigration.changed && !appliedMigrationIds.has(PROMPT_TEMPLATE_INLINE_MIGRATION_ID)) {
    nextApplied.push({
      id: PROMPT_TEMPLATE_INLINE_MIGRATION_ID,
      at: nowIso(),
    });
  }
  const migrations = {
    ...project.migrations,
    applied: nextApplied,
  };

  return {
    changed: true,
    project: {
      ...project,
      graph: {
        ...project.graph,
        nodes,
        edges,
        entryNodeIds,
        groups,
      },
      migrations,
    },
  };
}
