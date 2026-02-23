import { normalizePath } from "obsidian";
import {
  STUDIO_POLICY_SCHEMA_V1,
  STUDIO_PROJECT_SCHEMA_V1,
  type StudioCapabilityGrant,
  type StudioPermissionPolicyV1,
  type StudioProjectV1,
} from "./types";
import { asNumber, asString, ensureArray, isRecord, nowIso, randomId } from "./utils";

const DEFAULT_MAX_RUNS = 100;
const DEFAULT_MAX_ARTIFACTS_MB = 1024;

function readNode(raw: unknown): StudioProjectV1["graph"]["nodes"][number] {
  if (!isRecord(raw)) {
    throw new Error("Invalid node entry: expected object.");
  }

  const id = asString(raw.id).trim();
  const kind = asString(raw.kind).trim();
  const version = asString(raw.version).trim() || "1.0.0";
  const title = asString(raw.title).trim() || kind || id;
  const x = asNumber((raw.position as any)?.x) ?? 0;
  const y = asNumber((raw.position as any)?.y) ?? 0;
  const config = isRecord(raw.config) ? (raw.config as Record<string, any>) : {};
  const continueOnError = raw.continueOnError === true;
  const disabled = raw.disabled === true;

  if (!id) {
    throw new Error("Invalid node entry: node.id is required.");
  }
  if (!kind) {
    throw new Error(`Invalid node "${id}": node.kind is required.`);
  }

  return {
    id,
    kind,
    version,
    title,
    position: { x, y },
    config,
    continueOnError,
    disabled,
  };
}

function readEdge(raw: unknown): StudioProjectV1["graph"]["edges"][number] {
  if (!isRecord(raw)) {
    throw new Error("Invalid edge entry: expected object.");
  }

  const id = asString(raw.id).trim();
  const fromNodeId = asString(raw.fromNodeId).trim();
  const fromPortId = asString(raw.fromPortId).trim();
  const toNodeId = asString(raw.toNodeId).trim();
  const toPortId = asString(raw.toPortId).trim();

  if (!id) {
    throw new Error("Invalid edge entry: edge.id is required.");
  }
  if (!fromNodeId || !fromPortId || !toNodeId || !toPortId) {
    throw new Error(`Invalid edge "${id}": from/to node+port IDs are required.`);
  }

  return { id, fromNodeId, fromPortId, toNodeId, toPortId };
}

function readProjectV1(raw: Record<string, unknown>): StudioProjectV1 {
  const schema = asString(raw.schema).trim();
  if (schema !== STUDIO_PROJECT_SCHEMA_V1) {
    throw new Error(`Unsupported Studio project schema "${schema || "(missing)"}".`);
  }

  const projectId = asString(raw.projectId).trim();
  if (!projectId) {
    throw new Error("Invalid Studio project: projectId is required.");
  }

  const name = asString(raw.name).trim();
  if (!name) {
    throw new Error("Invalid Studio project: name is required.");
  }

  const createdAt = asString(raw.createdAt).trim() || nowIso();
  const updatedAt = asString(raw.updatedAt).trim() || createdAt;
  const graphRaw = isRecord(raw.graph) ? raw.graph : {};
  const nodesRaw = ensureArray<unknown>((graphRaw as Record<string, unknown>).nodes);
  const edgesRaw = ensureArray<unknown>((graphRaw as Record<string, unknown>).edges);
  const entryNodeIdsRaw = ensureArray<unknown>((graphRaw as Record<string, unknown>).entryNodeIds);

  const nodes = nodesRaw.map(readNode);
  const nodeIdSet = new Set(nodes.map((node) => node.id));
  const edges = edgesRaw.map(readEdge);
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.fromNodeId)) {
      throw new Error(`Invalid edge "${edge.id}": source node "${edge.fromNodeId}" not found.`);
    }
    if (!nodeIdSet.has(edge.toNodeId)) {
      throw new Error(`Invalid edge "${edge.id}": target node "${edge.toNodeId}" not found.`);
    }
  }

  const entryNodeIds = entryNodeIdsRaw
    .map((value) => asString(value).trim())
    .filter((value) => value.length > 0)
    .filter((value, index, arr) => arr.indexOf(value) === index);

  const permissionsRefRaw = isRecord(raw.permissionsRef) ? raw.permissionsRef : {};
  const policyPath = normalizePath(asString(permissionsRefRaw.policyPath).trim());
  if (!policyPath) {
    throw new Error("Invalid Studio project: permissionsRef.policyPath is required.");
  }

  const policyVersion = asNumber((permissionsRefRaw as Record<string, unknown>).policyVersion) ?? 1;
  const settingsRaw = isRecord(raw.settings) ? raw.settings : {};
  const retentionRaw = isRecord((settingsRaw as Record<string, unknown>).retention)
    ? ((settingsRaw as Record<string, unknown>).retention as Record<string, unknown>)
    : {};

  const maxRuns = Math.max(
    1,
    Math.floor(asNumber(retentionRaw.maxRuns) ?? DEFAULT_MAX_RUNS)
  );
  const maxArtifactsMb = Math.max(
    1,
    Math.floor(asNumber(retentionRaw.maxArtifactsMb) ?? DEFAULT_MAX_ARTIFACTS_MB)
  );

  const project: StudioProjectV1 = {
    schema: STUDIO_PROJECT_SCHEMA_V1,
    projectId,
    name,
    createdAt,
    updatedAt,
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: asString((raw.engine as any)?.minPluginVersion).trim() || "0.0.0",
    },
    graph: {
      nodes,
      edges,
      entryNodeIds,
    },
    permissionsRef: {
      policyVersion: Math.max(1, Math.floor(policyVersion)),
      policyPath,
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns,
        maxArtifactsMb,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: ensureArray<unknown>((raw.migrations as any)?.applied)
        .filter(isRecord)
        .map((entry) => ({
          id: asString(entry.id).trim(),
          at: asString(entry.at).trim() || nowIso(),
        }))
        .filter((entry) => entry.id.length > 0),
    },
  };

  return project;
}

function migrateLegacyProject(raw: Record<string, unknown>): StudioProjectV1 | null {
  const nodesRaw = ensureArray<unknown>(raw.nodes);
  const edgesRaw = ensureArray<unknown>(raw.edges);
  if (nodesRaw.length === 0 && edgesRaw.length === 0) {
    return null;
  }

  const now = nowIso();
  const nodes = nodesRaw
    .filter(isRecord)
    .map((node, index) => {
      const id = asString(node.id).trim() || randomId(`node${index}`);
      return {
        id,
        kind: "studio.input",
        version: "1.0.0",
        title: asString(node.title).trim() || asString((node as any).text).trim() || `Node ${index + 1}`,
        position: {
          x: asNumber((node as any).x) ?? 0,
          y: asNumber((node as any).y) ?? 0,
        },
        config: {},
        continueOnError: false,
        disabled: false,
      };
    });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = edgesRaw
    .filter(isRecord)
    .map((edge, index) => {
      const fromNodeId = asString((edge as any).fromNodeId || (edge as any).fromNode).trim();
      const toNodeId = asString((edge as any).toNodeId || (edge as any).toNode).trim();
      if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) {
        return null;
      }

      return {
        id: asString(edge.id).trim() || randomId(`edge${index}`),
        fromNodeId,
        fromPortId: "out",
        toNodeId,
        toPortId: "in",
      };
    })
    .filter(Boolean) as StudioProjectV1["graph"]["edges"];

  const projectId = asString(raw.projectId).trim() || randomId("proj");
  const name = asString(raw.name).trim() || "Untitled Studio Project";
  const fallbackPolicyPath = normalizePath(`${name}.systemsculpt-assets/policy/grants.json`);

  return {
    schema: STUDIO_PROJECT_SCHEMA_V1,
    projectId,
    name,
    createdAt: now,
    updatedAt: now,
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes,
      edges,
      entryNodeIds: nodes.length > 0 ? [nodes[0].id] : [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: fallbackPolicyPath,
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: DEFAULT_MAX_RUNS,
        maxArtifactsMb: DEFAULT_MAX_ARTIFACTS_MB,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [{ id: "legacy-auto-migration", at: now }],
    },
  };
}

export function parseStudioProject(rawText: string): StudioProjectV1 {
  const parsed: unknown = JSON.parse(rawText);
  if (!isRecord(parsed)) {
    throw new Error("Invalid Studio project: root JSON value must be an object.");
  }

  const schema = asString(parsed.schema).trim();
  if (!schema || schema !== STUDIO_PROJECT_SCHEMA_V1) {
    const migrated = migrateLegacyProject(parsed);
    if (!migrated) {
      throw new Error(
        `Unsupported Studio project schema "${schema || "(missing)"}"; expected "${STUDIO_PROJECT_SCHEMA_V1}".`
      );
    }
    return migrated;
  }

  return readProjectV1(parsed);
}

export function serializeStudioProject(project: StudioProjectV1): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function createEmptyStudioProject(options: {
  name: string;
  policyPath: string;
  minPluginVersion: string;
  maxRuns: number;
  maxArtifactsMb: number;
}): StudioProjectV1 {
  const now = nowIso();
  return {
    schema: STUDIO_PROJECT_SCHEMA_V1,
    projectId: randomId("proj"),
    name: options.name,
    createdAt: now,
    updatedAt: now,
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: options.minPluginVersion,
    },
    graph: {
      nodes: [],
      edges: [],
      entryNodeIds: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: normalizePath(options.policyPath),
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: Math.max(1, Math.floor(options.maxRuns)),
        maxArtifactsMb: Math.max(1, Math.floor(options.maxArtifactsMb)),
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

export function createDefaultStudioPolicy(): StudioPermissionPolicyV1 {
  return {
    schema: STUDIO_POLICY_SCHEMA_V1,
    version: 1,
    updatedAt: nowIso(),
    grants: [],
  };
}

export function parseStudioPolicy(rawText: string): StudioPermissionPolicyV1 {
  const parsed: unknown = JSON.parse(rawText);
  if (!isRecord(parsed)) {
    throw new Error("Invalid Studio policy: root JSON value must be an object.");
  }

  const schema = asString(parsed.schema).trim();
  if (schema !== STUDIO_POLICY_SCHEMA_V1) {
    throw new Error(
      `Unsupported Studio policy schema "${schema || "(missing)"}"; expected "${STUDIO_POLICY_SCHEMA_V1}".`
    );
  }

  const grantsRaw = ensureArray<unknown>(parsed.grants);
  const grants: StudioCapabilityGrant[] = grantsRaw
    .filter(isRecord)
    .map((rawGrant) => {
      const capability = asString(rawGrant.capability).trim() as StudioCapabilityGrant["capability"];
      const id = asString(rawGrant.id).trim() || randomId("grant");
      if (capability !== "cli" && capability !== "filesystem" && capability !== "network") {
        throw new Error(`Invalid Studio policy grant "${id}": unsupported capability.`);
      }

      const scope = isRecord(rawGrant.scope) ? rawGrant.scope : {};
      return {
        id,
        capability,
        scope: {
          allowedPaths: ensureArray<unknown>(scope.allowedPaths).map((entry) => asString(entry).trim()).filter(Boolean),
          allowedCommandPatterns: ensureArray<unknown>(scope.allowedCommandPatterns)
            .map((entry) => asString(entry).trim())
            .filter(Boolean),
          allowedDomains: ensureArray<unknown>(scope.allowedDomains).map((entry) => asString(entry).trim()).filter(Boolean),
        },
        grantedAt: asString(rawGrant.grantedAt).trim() || nowIso(),
        grantedByUser: rawGrant.grantedByUser === true,
      };
    });

  return {
    schema: STUDIO_POLICY_SCHEMA_V1,
    version: 1,
    updatedAt: asString(parsed.updatedAt).trim() || nowIso(),
    grants,
  };
}

export function serializeStudioPolicy(policy: StudioPermissionPolicyV1): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

