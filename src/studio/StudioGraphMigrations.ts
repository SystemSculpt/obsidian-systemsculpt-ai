import type { StudioEdge, StudioJsonValue, StudioProjectV1 } from "./types";
import { nowIso } from "./utils";
import { ensureStudioNoteConfigItems } from "./StudioNoteConfig";
import { resolveStudioNodeDefaultSize } from "./StudioNodeGeometry";

const PATH_ONLY_PORTS_MIGRATION_ID = "studio.path-only-ports.v1";
const PROMPT_TEMPLATE_INLINE_MIGRATION_ID = "studio.inline-prompt-template.v1";
const RESEND_TO_HTTP_REQUEST_MIGRATION_ID = "studio.resend-http-request.v1";
const NOTE_NODE_CANONICAL_MIGRATION_ID = "studio.note-canonical-config.v1";
const LEGACY_TEXT_NODE_MODEL_MIGRATION_ID = "studio.pi-text-model-selector.v1";
const IMAGE_NODE_LEVERS_MIGRATION_ID = "studio.image-node-levers.v1";
const MANAGED_NODE_CONFIG_MIGRATION_ID = "studio.managed-node-config.v1";
export const RETIRED_HTTP_NODE_MIGRATION_ID = "studio.retire-http-request.v1";
export const TEXT_NODE_KINDS_MIGRATION_ID = "studio.text-node-kinds.v1";

/**
 * One-shot kind renames applied as a single atomic lookup: every node kind is
 * mapped through this table at most once, so a project persisted with BOTH
 * legacy kinds can never chain studio.label -> studio.text ->
 * studio.text_output. The pass is gated on TEXT_NODE_KINDS_MIGRATION_ID
 * because "studio.text" is reused: pre-migration it names the port-bearing
 * text-output node, post-migration it names the visual canvas Text node
 * (formerly "studio.label"). Once the stamp is present the pass never runs
 * again, and the stamp is recorded even for projects that contained neither
 * legacy kind so text nodes created later are never falsely renamed.
 */
const LEGACY_TEXT_NODE_KIND_RENAMES: Record<string, string> = {
  "studio.text": "studio.text_output",
  "studio.label": "studio.text",
};

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
    ...config,
    sourcePath,
  };
  delete next.vaultPath;
  delete next.sourceMode;
  delete next.assetMode;
  delete next.mediaKind;
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

function asFiniteGeometryNumber(value: StudioJsonValue | undefined): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim() || Number.NaN)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Moves legacy canvas geometry out of node config and into the first-class
 * node.size field.
 *
 * Deliberately stampless and unconditional: "size is absent while
 * config.width/config.height hold numbers" is unambiguous (unlike the text
 * kind rename, where a kind id was reused and only a stamp could
 * disambiguate), the pass is a no-op on already-migrated nodes, and no
 * production write path emits config geometry anymore (guarded by
 * studio-geometry-architecture-lint.test.ts). Migration is lossless: values
 * move unclamped — the geometry resolvers clamp at read time.
 */
function migrateNodeGeometryToSize(
  nodes: StudioProjectV1["graph"]["nodes"]
): {
  nodes: StudioProjectV1["graph"]["nodes"];
  changed: boolean;
} {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    const config = (node.config || {}) as Record<string, StudioJsonValue>;
    const hasWidthKey = Object.prototype.hasOwnProperty.call(config, "width");
    const hasHeightKey = Object.prototype.hasOwnProperty.call(config, "height");
    if (!hasWidthKey && !hasHeightKey) {
      return node;
    }

    changed = true;
    const nextConfig: Record<string, StudioJsonValue> = { ...config };
    delete nextConfig.width;
    delete nextConfig.height;

    // An existing first-class size is authoritative; only strip the stale keys.
    if (node.size) {
      return {
        ...node,
        config: nextConfig,
      };
    }

    const width = asFiniteGeometryNumber(config.width);
    const height = asFiniteGeometryNumber(config.height);

    // Non-numeric garbage is dropped without minting a size; partial data
    // fills the missing dimension with the kind's default rendered value so
    // rendering stays identical to the pre-migration read path.
    if (width === null && height === null) {
      return {
        ...node,
        config: nextConfig,
      };
    }

    const defaults = resolveStudioNodeDefaultSize(node.kind);
    return {
      ...node,
      size: {
        width: width ?? defaults.width,
        height: height ?? defaults.height,
      },
      config: nextConfig,
    };
  });

  return {
    nodes: nextNodes,
    changed,
  };
}

function migrateTextGenerationNodes(
  nodes: StudioProjectV1["graph"]["nodes"]
): {
  nodes: StudioProjectV1["graph"]["nodes"];
  changed: boolean;
} {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.kind !== "studio.text_generation") {
      return node;
    }

    const currentConfig = (node.config || {}) as Record<string, StudioJsonValue>;
    const nextConfig: Record<string, StudioJsonValue> = { ...currentConfig };
    for (const key of [
      "sourceMode", "localModelId", "modelId", "reasoningEffort", "provider", "providerId",
      "endpoint", "apiKey", "oauth", "fallback", "price", "pricing",
    ]) delete nextConfig[key];

    if (JSON.stringify(nextConfig) !== JSON.stringify(currentConfig)) {
      changed = true;
      return {
        ...node,
        config: nextConfig,
      };
    }

    return node;
  });

  return {
    nodes: nextNodes,
    changed,
  };
}

function migrateImageGenerationNodes(
  nodes: StudioProjectV1["graph"]["nodes"]
): {
  nodes: StudioProjectV1["graph"]["nodes"];
  changed: boolean;
} {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.kind !== "studio.image_generation") {
      return node;
    }

    const currentConfig = (node.config || {}) as Record<string, StudioJsonValue>;
    const nextConfig: Record<string, StudioJsonValue> = { ...currentConfig };
    for (const key of [
      "modelId", "provider", "providerId", "endpoint", "apiKey", "oauth", "fallback", "price", "pricing",
    ]) delete nextConfig[key];
    // Seed is intentionally left absent, which the node treats as "random".
    if (typeof nextConfig.imageSize !== "string") {
      nextConfig.imageSize = "";
    }
    // Older projects could save count 5-8 under the previous schema (max 8). The
    // new max is 4, and config validation rejects out-of-range values before the
    // node's runtime clamp runs, so normalize legacy counts here or the flow
    // would fail to compile instead of being capped.
    const countValue = nextConfig.count;
    const countNumeric =
      typeof countValue === "number"
        ? countValue
        : typeof countValue === "string"
          ? Number(countValue.trim())
          : Number.NaN;
    if (Number.isFinite(countNumeric)) {
      // Floor as well as clamp: the schema is integer-constrained, so a stray
      // decimal would also fail validation, not just an out-of-range integer.
      const normalizedCount = Math.min(4, Math.floor(countNumeric));
      if (normalizedCount !== countValue) {
        nextConfig.count = normalizedCount;
      }
    }

    if (JSON.stringify(nextConfig) !== JSON.stringify(currentConfig)) {
      changed = true;
      return {
        ...node,
        config: nextConfig,
      };
    }

    return node;
  });

  return {
    nodes: nextNodes,
    changed,
  };
}

function retireHttpRequestNodes(
  nodes: StudioProjectV1["graph"]["nodes"]
): { nodes: StudioProjectV1["graph"]["nodes"]; changed: boolean } {
  let changed = false;
  const nextNodes = nodes.map(node => {
    if (node.kind !== "studio.http_request") return node;
    changed = true;
    return {
      ...node,
      kind: "studio.retired_http_request",
      version: "1.0.0",
      title: "Retired HTTP Request",
      config: {
        reason: "HTTP Request nodes are retired. Replace this node with a retained managed capability.",
      },
    };
  });
  return { nodes: nextNodes, changed };
}

function migrateResendAudienceSyncNodes(
  nodes: StudioProjectV1["graph"]["nodes"],
  edges: StudioEdge[]
): {
  nodes: StudioProjectV1["graph"]["nodes"];
  edges: StudioEdge[];
  changed: boolean;
} {
  const convertedNodeIds = new Set<string>();
  let changed = false;

  const nextNodes = nodes.map((node) => {
    if (node.kind !== "studio.resend_audience_sync") {
      return node;
    }
    changed = true;
    convertedNodeIds.add(node.id);

    return {
      ...node,
      kind: "studio.retired_http_request",
      version: "1.0.0",
      title: "Retired HTTP Request",
      config: {
        reason: "HTTP Request nodes are retired. Replace this node with a retained managed capability.",
      },
    };
  });

  if (convertedNodeIds.size === 0) {
    return { nodes, edges, changed: false };
  }

  const nextEdges: StudioEdge[] = [];
  for (const edge of edges) {
    if (convertedNodeIds.has(edge.toNodeId)) {
      if (edge.toPortId === "segmentId") {
        changed = true;
        continue;
      }
      if (edge.toPortId === "emails") {
        changed = true;
        // Dropped intentionally: the retired placeholder does not consume payload data.
        continue;
      }
    }

    if (convertedNodeIds.has(edge.fromNodeId)) {
      if (edge.fromPortId === "emails") {
        changed = true;
        nextEdges.push({
          ...edge,
          fromPortId: "json",
        });
        continue;
      }
      if (edge.fromPortId === "synced") {
        changed = true;
        // Dropped intentionally: the retired placeholder has no success result.
        continue;
      }
    }

    nextEdges.push(edge);
  }

  return {
    nodes: nextNodes,
    edges: dedupeEdges(nextEdges),
    changed,
  };
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
      const textGenerationPromptTarget =
        outbound.toPortId === "prompt" && targetNode.kind === "studio.text_generation";

      if (textGenerationPromptTarget) {
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
  let noteMigrationChanged = false;

  const textKindStampApplied = project.migrations.applied.some(
    (entry) => entry.id === TEXT_NODE_KINDS_MIGRATION_ID
  );
  let textKindMigrationRan = false;
  let sourceNodes = project.graph.nodes;
  if (!textKindStampApplied) {
    textKindMigrationRan = true;
    // Force a rewrite even when no node needed renaming: the stamp itself is
    // the guard that keeps future (post-rename) "studio.text" nodes intact.
    changed = true;
    sourceNodes = sourceNodes.map((node) => {
      const renamedKind = LEGACY_TEXT_NODE_KIND_RENAMES[node.kind];
      if (!renamedKind) {
        return node;
      }
      return {
        ...node,
        kind: renamedKind,
      };
    });
  }

  let nodes = sourceNodes.map((node) => {
    if (node.kind === "studio.media_ingest") {
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
    }

    if (node.kind === "studio.note") {
      const normalized = ensureStudioNoteConfigItems(node.config || {});
      if (normalized.changed) {
        changed = true;
        noteMigrationChanged = true;
        return {
          ...node,
          config: normalized.nextConfig,
        };
      }
      return node;
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

  // Geometry must be promoted before any retirement pass replaces config.
  // Retired nodes keep first-class canvas size, while their legacy request
  // fields (including width/height-adjacent secrets) are discarded below.
  const geometryMigration = migrateNodeGeometryToSize(nodes);
  if (geometryMigration.changed) {
    changed = true;
    nodes = geometryMigration.nodes;
  }

  const resendMigration = migrateResendAudienceSyncNodes(nodes, edges);
  if (resendMigration.changed) {
    changed = true;
    nodes = resendMigration.nodes;
    edges = resendMigration.edges;
  }

  const retiredHttpMigration = retireHttpRequestNodes(nodes);
  if (retiredHttpMigration.changed) {
    changed = true;
    nodes = retiredHttpMigration.nodes;
  }

  const textGenerationMigration = migrateTextGenerationNodes(nodes);
  if (textGenerationMigration.changed) {
    changed = true;
    nodes = textGenerationMigration.nodes;
  }

  const imageGenerationMigration = migrateImageGenerationNodes(nodes);
  if (imageGenerationMigration.changed) {
    changed = true;
    nodes = imageGenerationMigration.nodes;
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
  if (textKindMigrationRan && !appliedMigrationIds.has(TEXT_NODE_KINDS_MIGRATION_ID)) {
    nextApplied.push({
      id: TEXT_NODE_KINDS_MIGRATION_ID,
      at: nowIso(),
    });
  }
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
  if (resendMigration.changed && !appliedMigrationIds.has(RESEND_TO_HTTP_REQUEST_MIGRATION_ID)) {
    nextApplied.push({
      id: RESEND_TO_HTTP_REQUEST_MIGRATION_ID,
      at: nowIso(),
    });
  }
  if (noteMigrationChanged && !appliedMigrationIds.has(NOTE_NODE_CANONICAL_MIGRATION_ID)) {
    nextApplied.push({
      id: NOTE_NODE_CANONICAL_MIGRATION_ID,
      at: nowIso(),
    });
  }
  if (textGenerationMigration.changed && !appliedMigrationIds.has(LEGACY_TEXT_NODE_MODEL_MIGRATION_ID)) {
    nextApplied.push({
      id: LEGACY_TEXT_NODE_MODEL_MIGRATION_ID,
      at: nowIso(),
    });
  }
  if (imageGenerationMigration.changed && !appliedMigrationIds.has(IMAGE_NODE_LEVERS_MIGRATION_ID)) {
    nextApplied.push({
      id: IMAGE_NODE_LEVERS_MIGRATION_ID,
      at: nowIso(),
    });
  }
  if (
    (textGenerationMigration.changed || imageGenerationMigration.changed) &&
    !appliedMigrationIds.has(MANAGED_NODE_CONFIG_MIGRATION_ID)
  ) {
    nextApplied.push({ id: MANAGED_NODE_CONFIG_MIGRATION_ID, at: nowIso() });
  }
  if (retiredHttpMigration.changed && !appliedMigrationIds.has(RETIRED_HTTP_NODE_MIGRATION_ID)) {
    nextApplied.push({ id: RETIRED_HTTP_NODE_MIGRATION_ID, at: nowIso() });
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
