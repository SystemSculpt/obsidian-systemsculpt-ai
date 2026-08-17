import { normalizePath } from "obsidian";
import {
  STUDIO_POLICY_SCHEMA_V1,
  STUDIO_PROJECT_SCHEMA_V1,
  STUDIO_PROJECT_SCHEMA_V2,
  type StudioCapabilityGrant,
  type StudioDiagram,
  type StudioEdge,
  type StudioNodeGroup,
  type StudioPermissionPolicyV1,
  type StudioProjectV1,
} from "./types";
import {
  asNumber,
  asString,
  ensureArray,
  isBlanketCliCommandPattern,
  isRecord,
  nowIso,
  randomId,
} from "./utils";
import { ALL_STUDIO_GRAPH_MIGRATION_IDS } from "./StudioGraphMigrations";
import { deriveStudioPolicyPath } from "./paths";
import {
  convertLegacyShapeNodesToDiagram,
  createEmptyStudioDiagram,
  readStudioDiagram,
} from "./StudioShapes";
import {
  STUDIO_AGENT_DOCS_PATH,
  compactStudioNodeKind,
  expandStudioNodeKind,
  findBuiltInStudioNodeDefinition,
  resolveBuiltInStudioNodeVersion,
} from "./StudioProjectAgentContract";
import { resolveNodeDefinitionPorts } from "./StudioNodePortResolution";

/**
 * Optional origin of the raw text being parsed. When the project path is
 * known, the v2 reader derives the policy path from it; without it the reader
 * falls back to a name-derived path (lint and previews have no file yet).
 */
export type StudioProjectParseContext = {
  projectPath?: string;
};

const DEFAULT_MAX_RUNS = 100;
const DEFAULT_MAX_ARTIFACTS_MB = 1024;
const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHexColor(value: string): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.length === 4) {
    const r = lower.charAt(1);
    const g = lower.charAt(2);
    const b = lower.charAt(3);
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
}

function readNodeSize(raw: unknown): { width: number; height?: number } | null {
  if (!isRecord(raw)) {
    return null;
  }
  const width = asNumber(raw.width);
  const height = asNumber(raw.height);
  // Width is required; height is OPTIONAL — matching StudioNodeSize. Kinds
  // with intrinsic height (text reflow) or aspect-driven height (image/video
  // media cards) deliberately persist width only, so a width-only size must
  // survive normalization instead of being dropped as "partial" (dropping it
  // silently reset every resized image back to the default width on the next
  // load). Only a size with no usable width is discarded.
  if (width === null) {
    return null;
  }
  return { width, ...(height !== null ? { height } : {}) };
}

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
  const size = readNodeSize(raw.size);
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
    ...(size ? { size } : {}),
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

function readGroup(raw: unknown): StudioNodeGroup {
  if (!isRecord(raw)) {
    throw new Error("Invalid group entry: expected object.");
  }

  const id = asString(raw.id).trim();
  const name = asString(raw.name).trim();
  const colorRaw = asString(raw.color).trim();
  const color = normalizeHexColor(colorRaw);
  const nodeIds = ensureArray<unknown>(raw.nodeIds)
    .map((value) => asString(value).trim())
    .filter((value) => value.length > 0)
    .filter((value, index, array) => array.indexOf(value) === index);
  const shapeIds = ensureArray<unknown>(raw.shapeIds)
    .map((value) => asString(value).trim())
    .filter((value) => value.length > 0)
    .filter((value, index, array) => array.indexOf(value) === index);

  if (!id) {
    throw new Error("Invalid group entry: group.id is required.");
  }
  if (!name) {
    throw new Error(`Invalid group "${id}": group.name is required.`);
  }
  if (colorRaw && !color) {
    throw new Error(`Invalid group "${id}": group.color must be a valid hex color.`);
  }

  return {
    id,
    name,
    ...(color ? { color } : {}),
    nodeIds,
    ...(shapeIds.length > 0 ? { shapeIds } : {}),
  };
}

function mergeStudioDiagrams(
  persisted: StudioDiagram,
  lifted?: StudioDiagram
): StudioDiagram {
  if (!lifted) {
    return persisted;
  }
  const shapeIds = new Set(persisted.shapes.map((shape) => shape.id));
  const arrowIds = new Set(persisted.arrows.map((arrow) => arrow.id));
  return {
    shapes: [...persisted.shapes, ...lifted.shapes.filter((shape) => !shapeIds.has(shape.id))],
    arrows: [...persisted.arrows, ...lifted.arrows.filter((arrow) => !arrowIds.has(arrow.id))],
  };
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
  const groupsRaw = ensureArray<unknown>((graphRaw as Record<string, unknown>).groups);

  // Shapes are lifted out of the graph BEFORE edge validation: a project
  // written by the build where shapes were still a node kind carries shape
  // nodes and shape edges that no longer belong to the executable graph.
  const parsedNodes = nodesRaw.map(readNode);
  const parsedEdges = edgesRaw.map(readEdge);
  const lifted = convertLegacyShapeNodesToDiagram({ nodes: parsedNodes, edges: parsedEdges });
  const nodes = lifted ? lifted.nodes : parsedNodes;
  const edges = lifted ? lifted.edges : parsedEdges;
  const diagram = mergeStudioDiagrams(readStudioDiagram(raw.diagram), lifted?.diagram);
  const nodeIdSet = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.fromNodeId)) {
      throw new Error(`Invalid edge "${edge.id}": source node "${edge.fromNodeId}" not found.`);
    }
    if (!nodeIdSet.has(edge.toNodeId)) {
      throw new Error(`Invalid edge "${edge.id}": target node "${edge.toNodeId}" not found.`);
    }
  }

  // Entry IDs are derived data (the canvas recomputes them and runs
  // re-derive real entry points), so heal rather than reject: drop
  // references to nodes that no longer exist. Kind-based filtering is
  // deliberately absent — the executable/visual-only split changes across
  // plugin versions, and pruning by kind here would fight files persisted
  // by a newer build.
  const entryNodeIds = entryNodeIdsRaw
    .map((value) => asString(value).trim())
    .filter((value) => value.length > 0)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .filter((value) => nodeIdSet.has(value));

  // A group frames nodes, shapes, or both, so it survives while either half
  // still resolves.
  const diagramShapeIdSet = new Set(diagram.shapes.map((shape) => shape.id));
  const groups = groupsRaw
    .map(readGroup)
    .map((group) => {
      const shapeIds = (group.shapeIds || []).filter((shapeId) => diagramShapeIdSet.has(shapeId));
      const next = { ...group, nodeIds: group.nodeIds.filter((nodeId) => nodeIdSet.has(nodeId)) };
      if (shapeIds.length > 0) {
        next.shapeIds = shapeIds;
      } else {
        delete next.shapeIds;
      }
      return next;
    })
    .filter((group) => group.nodeIds.length > 0 || (group.shapeIds || []).length > 0);

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
      groups,
    },
    diagram,
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

function readNodeV2(raw: unknown): StudioProjectV1["graph"]["nodes"][number] {
  if (!isRecord(raw)) {
    throw new Error("Invalid node entry: expected object.");
  }
  const id = asString(raw.id).trim();
  if (!id) {
    throw new Error("Invalid node entry: node.id is required.");
  }
  const kind = expandStudioNodeKind(asString(raw.kind));
  if (!kind) {
    throw new Error(`Invalid node "${id}": node.kind is required.`);
  }
  const width = asNumber(raw.width);
  const height = asNumber(raw.height);
  return {
    id,
    kind,
    version: resolveBuiltInStudioNodeVersion(kind) || "1.0.0",
    title: asString(raw.title).trim() || compactStudioNodeKind(kind),
    position: { x: asNumber(raw.x) ?? 0, y: asNumber(raw.y) ?? 0 },
    ...(width !== null ? { size: { width, ...(height !== null ? { height } : {}) } } : {}),
    config: isRecord(raw.config) ? (raw.config as Record<string, any>) : {},
    continueOnError: raw.continueOnError === true,
    disabled: raw.disabled === true,
  };
}

function resolveEdgeEndpointV2(
  side: string,
  nodesById: Map<string, StudioProjectV1["graph"]["nodes"][number]>,
  direction: "from" | "to",
  edgeText: string
): { nodeId: string; portId: string } {
  const trimmed = side.trim();
  if (!trimmed) {
    throw new Error(`Invalid edge "${edgeText}": both sides need a node.`);
  }
  let nodeId = trimmed;
  let portId = "";
  if (!nodesById.has(trimmed)) {
    const dot = trimmed.lastIndexOf(".");
    if (dot > 0) {
      nodeId = trimmed.slice(0, dot);
      portId = trimmed.slice(dot + 1);
    }
  }
  const node = nodesById.get(nodeId);
  if (!node) {
    throw new Error(`Invalid edge "${edgeText}": node "${nodeId}" not found.`);
  }
  if (!portId) {
    const definition = findBuiltInStudioNodeDefinition(node.kind);
    const ports = definition
      ? (direction === "from"
        ? resolveNodeDefinitionPorts(node, definition).outputPorts
        : resolveNodeDefinitionPorts(node, definition).inputPorts)
      : [];
    if (ports.length !== 1) {
      const portNames = ports.map((port) => `"${nodeId}.${port.id}"`).join(", ");
      throw new Error(
        `Invalid edge "${edgeText}": specify the ${direction === "from" ? "output" : "input"} port on "${nodeId}"${portNames ? ` (${portNames})` : ""}.`
      );
    }
    portId = ports[0].id;
  }
  return { nodeId, portId };
}

function readEdgeV2(
  raw: unknown,
  nodesById: Map<string, StudioProjectV1["graph"]["nodes"][number]>
): StudioEdge {
  // Object edges are accepted for compatibility with v1-styled hand edits;
  // canonical v2 form is the arrow string.
  if (isRecord(raw)) {
    const edge = readEdge(raw);
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      if (!nodesById.has(nodeId)) {
        throw new Error(`Invalid edge "${edge.id}": node "${nodeId}" not found.`);
      }
    }
    return edge;
  }
  const text = asString(raw).trim();
  const parts = text.split("->");
  if (!text || parts.length !== 2) {
    throw new Error(`Invalid edge entry: expected "fromNode.port -> toNode.port", got ${JSON.stringify(raw)}.`);
  }
  const from = resolveEdgeEndpointV2(parts[0], nodesById, "from", text);
  const to = resolveEdgeEndpointV2(parts[1], nodesById, "to", text);
  return {
    id: `${from.nodeId}.${from.portId}->${to.nodeId}.${to.portId}`,
    fromNodeId: from.nodeId,
    fromPortId: from.portId,
    toNodeId: to.nodeId,
    toPortId: to.portId,
  };
}

function liftShapeV2(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }
  return {
    id: raw.id,
    shape: raw.shape,
    position: { x: raw.x, y: raw.y },
    size: { width: raw.width, height: raw.height },
    label: raw.label,
    ...(isRecord(raw.style) ? { style: raw.style } : {}),
  };
}

/**
 * An unlabeled arrow is the string "a -> b"; a labeled one is the object
 * { from, to, label }, so a label never needs escaping inside the string form.
 */
function liftArrowV2(raw: unknown): unknown {
  if (isRecord(raw)) {
    const from = asString(raw.from ?? raw.fromShapeId).trim();
    const to = asString(raw.to ?? raw.toShapeId).trim();
    if (!from || !to) {
      return null;
    }
    const label = asString(raw.label);
    return {
      id: asString(raw.id).trim() || `${from}->${to}`,
      fromShapeId: from,
      toShapeId: to,
      ...(label ? { label } : {}),
    };
  }
  const text = asString(raw).trim();
  const parts = text.split("->").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { id: `${parts[0]}->${parts[1]}`, fromShapeId: parts[0], toShapeId: parts[1] };
}

function readGroupV2(raw: unknown): StudioNodeGroup {
  if (!isRecord(raw)) {
    throw new Error("Invalid group entry: expected object.");
  }
  return readGroup({
    id: raw.id,
    name: raw.name,
    color: raw.color,
    nodeIds: raw.nodes ?? raw.nodeIds,
    shapeIds: raw.shapes ?? raw.shapeIds,
  });
}

/**
 * The v2 document is pure canvas content. Identity travels as "id"; every
 * other v1 envelope field (timestamps, engine, permissions ref, settings,
 * migration history) is machine bookkeeping that lives in the project's
 * assets directory or is derived, so the reader synthesizes the in-memory
 * model's values here.
 */
function readProjectV2(
  raw: Record<string, unknown>,
  context?: StudioProjectParseContext
): StudioProjectV1 {
  const projectId = asString(raw.id).trim();
  if (!projectId) {
    throw new Error("Invalid Studio project: id is required.");
  }
  const name = asString(raw.name).trim();
  if (!name) {
    throw new Error("Invalid Studio project: name is required.");
  }

  const canvas = isRecord(raw.canvas) ? raw.canvas : {};
  const nodes = ensureArray<unknown>(canvas.nodes).map(readNodeV2);
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));

  const edges: StudioEdge[] = [];
  const edgeIds = new Set<string>();
  for (const rawEdge of ensureArray<unknown>(canvas.edges)) {
    const edge = readEdgeV2(rawEdge, nodesById);
    if (edgeIds.has(edge.id)) {
      continue;
    }
    edgeIds.add(edge.id);
    edges.push(edge);
  }

  const diagram = readStudioDiagram({
    shapes: ensureArray<unknown>(canvas.shapes).map(liftShapeV2),
    arrows: ensureArray<unknown>(canvas.arrows).map(liftArrowV2).filter(Boolean),
  });

  const nodeIdSet = new Set(nodes.map((node) => node.id));
  const diagramShapeIdSet = new Set(diagram.shapes.map((shape) => shape.id));
  const groups = ensureArray<unknown>(canvas.groups)
    .map(readGroupV2)
    .map((group) => {
      const shapeIds = (group.shapeIds || []).filter((shapeId) => diagramShapeIdSet.has(shapeId));
      const next = { ...group, nodeIds: group.nodeIds.filter((nodeId) => nodeIdSet.has(nodeId)) };
      if (shapeIds.length > 0) {
        next.shapeIds = shapeIds;
      } else {
        delete next.shapeIds;
      }
      return next;
    })
    .filter((group) => group.nodeIds.length > 0 || (group.shapeIds || []).length > 0);

  const now = nowIso();
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
      // Derived data: the canvas recomputes entry points and runs re-derive
      // them from executable-graph structure, so v2 never persists them.
      entryNodeIds: [],
      groups,
    },
    diagram,
    permissionsRef: {
      policyVersion: 1,
      policyPath: context?.projectPath
        ? deriveStudioPolicyPath(context.projectPath)
        : normalizePath(`${name}.systemsculpt-assets/policy/grants.json`),
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
      // v2 content is written in the current dialect by definition, so every
      // known migration is stamped to keep the migration pass from rewriting
      // freshly parsed projects.
      applied: ALL_STUDIO_GRAPH_MIGRATION_IDS.map((id) => ({ id, at: now })),
    },
  };
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
      groups: [],
    },
    diagram: createEmptyStudioDiagram(),
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

export function parseStudioProject(
  rawText: string,
  context?: StudioProjectParseContext
): StudioProjectV1 {
  const parsed: unknown = JSON.parse(rawText);
  if (!isRecord(parsed)) {
    throw new Error("Invalid Studio project: root JSON value must be an object.");
  }

  const schema = asString(parsed.schema).trim();
  if (schema === STUDIO_PROJECT_SCHEMA_V2) {
    return readProjectV2(parsed, context);
  }
  if (schema !== STUDIO_PROJECT_SCHEMA_V1) {
    const migrated = migrateLegacyProject(parsed);
    if (!migrated) {
      throw new Error(
        `Unsupported Studio project schema "${schema || "(missing)"}"; expected "${STUDIO_PROJECT_SCHEMA_V2}".`
      );
    }
    return migrated;
  }

  return readProjectV1(parsed);
}

function serializeNodeV2(node: StudioProjectV1["graph"]["nodes"][number]): Record<string, unknown> {
  const hasConfig = Object.keys(node.config || {}).length > 0;
  return {
    id: node.id,
    kind: compactStudioNodeKind(node.kind),
    title: node.title,
    x: node.position.x,
    y: node.position.y,
    ...(node.size ? { width: node.size.width } : {}),
    ...(node.size && typeof node.size.height === "number" ? { height: node.size.height } : {}),
    ...(hasConfig ? { config: node.config } : {}),
    ...(node.continueOnError === true ? { continueOnError: true } : {}),
    ...(node.disabled === true ? { disabled: true } : {}),
  };
}

/**
 * Serialization always writes the v2 dialect: pure canvas content plus the
 * project identity and a pointer to the generated agent reference document.
 * Opening any older file and saving it upgrades it in place.
 */
export function serializeStudioProject(project: StudioProjectV1): string {
  const document = {
    schema: STUDIO_PROJECT_SCHEMA_V2,
    id: project.projectId,
    name: project.name,
    docs: STUDIO_AGENT_DOCS_PATH,
    canvas: {
      nodes: project.graph.nodes.map(serializeNodeV2),
      edges: project.graph.edges.map(
        (edge) => `${edge.fromNodeId}.${edge.fromPortId} -> ${edge.toNodeId}.${edge.toPortId}`
      ),
      groups: (project.graph.groups || []).map((group) => ({
        id: group.id,
        name: group.name,
        ...(group.color ? { color: group.color } : {}),
        nodes: group.nodeIds,
        ...((group.shapeIds || []).length > 0 ? { shapes: group.shapeIds } : {}),
      })),
      shapes: (project.diagram?.shapes || []).map((shape) => ({
        id: shape.id,
        shape: shape.shape,
        x: shape.position.x,
        y: shape.position.y,
        width: shape.size.width,
        height: shape.size.height,
        label: shape.label,
        ...(shape.style ? { style: shape.style } : {}),
      })),
      arrows: (project.diagram?.arrows || []).map((arrow) =>
        arrow.label
          ? { from: arrow.fromShapeId, to: arrow.toShapeId, label: arrow.label }
          : `${arrow.fromShapeId} -> ${arrow.toShapeId}`
      ),
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
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
      groups: [],
    },
    diagram: createEmptyStudioDiagram(),
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
      // Fresh projects are born in the current dialect, so every known
      // migration is stamped up front; otherwise the first load would treat
      // their canonical kinds and configs as legacy input and rewrite them.
      applied: ALL_STUDIO_GRAPH_MIGRATION_IDS.map((id) => ({ id, at: now })),
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
    .flatMap<StudioCapabilityGrant>((rawGrant) => {
      const rawCapability = asString(rawGrant.capability).trim();
      const id = asString(rawGrant.id).trim() || randomId("grant");
      if (rawCapability === "network") {
        return [];
      }
      if (rawCapability !== "cli" && rawCapability !== "filesystem") {
        throw new Error(`Invalid Studio policy grant "${id}": unsupported capability.`);
      }

      const scope = isRecord(rawGrant.scope) ? rawGrant.scope : {};
      return [{
        id,
        capability: rawCapability,
        scope: {
          allowedPaths: ensureArray<unknown>(scope.allowedPaths).map((entry) => asString(entry).trim()).filter(Boolean),
          allowedCommandPatterns: ensureArray<unknown>(scope.allowedCommandPatterns)
            .map((entry) => asString(entry).trim())
            .filter(Boolean)
            // SEC-03: a (syncable) policy must never grant arbitrary commands via
            // a bare "*". Drop it here so a shared project still opens, just
            // without the blanket grant; legitimate per-command patterns survive.
            .filter((pattern) => !isBlanketCliCommandPattern(pattern)),
        },
        grantedAt: asString(rawGrant.grantedAt).trim() || nowIso(),
        grantedByUser: rawGrant.grantedByUser === true,
      }];
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
