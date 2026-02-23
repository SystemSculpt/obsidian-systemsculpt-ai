import type { StudioEdge, StudioJsonValue, StudioProjectV1 } from "./types";
import { nowIso } from "./utils";

const PATH_ONLY_PORTS_MIGRATION_ID = "studio.path-only-ports.v1";

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

export function migrateStudioProjectToPathOnlyPorts(project: StudioProjectV1): {
  project: StudioProjectV1;
  changed: boolean;
} {
  let changed = false;

  const nodesById = new Map(project.graph.nodes.map((node) => [node.id, node]));
  const nodes = project.graph.nodes.map((node) => {
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

  const remappedEdges = project.graph.edges.map((edge) => {
    const sourceKind = nodesById.get(edge.fromNodeId)?.kind || "";
    const targetKind = nodesById.get(edge.toNodeId)?.kind || "";
    const nextEdge = mapEdgePorts(edge, sourceKind, targetKind);
    if (nextEdge.fromPortId !== edge.fromPortId || nextEdge.toPortId !== edge.toPortId) {
      changed = true;
    }
    return nextEdge;
  });
  const edges = dedupeEdges(remappedEdges);
  if (edges.length !== remappedEdges.length) {
    changed = true;
  }

  if (!changed) {
    return { project, changed: false };
  }

  const migrationAlreadyApplied = project.migrations.applied.some(
    (entry) => entry.id === PATH_ONLY_PORTS_MIGRATION_ID
  );
  const migrations = migrationAlreadyApplied
    ? project.migrations
    : {
        ...project.migrations,
        applied: [
          ...project.migrations.applied,
          {
            id: PATH_ONLY_PORTS_MIGRATION_ID,
            at: nowIso(),
          },
        ],
      };

  return {
    changed: true,
    project: {
      ...project,
      graph: {
        ...project.graph,
        nodes,
        edges,
      },
      migrations,
    },
  };
}
