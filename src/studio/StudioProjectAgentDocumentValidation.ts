const ROOT_REQUIRED_FIELDS = [
  "schema",
  "projectId",
  "name",
  "createdAt",
  "updatedAt",
  "engine",
  "graph",
  "permissionsRef",
  "settings",
  "migrations",
] as const;
const ROOT_FIELDS = new Set([
  ...ROOT_REQUIRED_FIELDS,
  "agentGuide",
  "nodeKindReference",
]);
const ENGINE_FIELDS = new Set(["apiMode", "minPluginVersion"]);
const GRAPH_FIELDS = new Set(["nodes", "edges", "entryNodeIds", "groups"]);
const NODE_FIELDS = new Set([
  "id",
  "kind",
  "version",
  "title",
  "position",
  "size",
  "config",
  "continueOnError",
  "disabled",
]);
const NODE_REQUIRED_FIELDS = ["id", "kind", "version", "title", "position", "config"] as const;
const NODE_POSITION_FIELDS = new Set(["x", "y"]);
const NODE_SIZE_FIELDS = new Set(["width", "height"]);
const EDGE_FIELDS = new Set(["id", "fromNodeId", "fromPortId", "toNodeId", "toPortId"]);
const GROUP_FIELDS = new Set(["id", "name", "color", "nodeIds"]);
const PERMISSIONS_FIELDS = new Set(["policyVersion", "policyPath"]);
const SETTINGS_FIELDS = new Set(["runConcurrency", "defaultFsScope", "retention"]);
const RETENTION_FIELDS = new Set(["maxRuns", "maxArtifactsMb"]);
const MIGRATIONS_FIELDS = new Set(["projectSchemaVersion", "applied"]);
const MIGRATION_FIELDS = new Set(["id", "at"]);
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const STABLE_PROJECT_FIELDS = [
  "schema",
  "projectId",
  "createdAt",
  "engine",
  "permissionsRef",
  "settings",
  "migrations",
  "agentGuide",
  "nodeKindReference",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" ? serialized : "undefined";
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  label: string
): void {
  const unsupported = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unsupported) {
    throw new Error(`${label} contains unsupported field "${unsupported}".`);
  }
}

function assertRequiredFields(
  value: Record<string, unknown>,
  requiredFields: readonly string[],
  label: string
): void {
  const missing = requiredFields.find((field) => !hasOwn(value, field));
  if (missing) {
    throw new Error(`${label}.${missing} is required.`);
  }
}

function assertClosedObject(
  value: unknown,
  fields: ReadonlySet<string>,
  requiredFields: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyFields(value, fields, label);
  assertRequiredFields(value, requiredFields, label);
  return value;
}

function assertTrimmedStringField(
  value: Record<string, unknown>,
  field: string,
  label: string
): string {
  const raw = value[field];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${label}.${field} must be a non-empty string.`);
  }
  if (raw !== raw.trim()) {
    throw new Error(`${label}.${field} must not contain surrounding whitespace.`);
  }
  return raw;
}

function assertFiniteNumberField(
  value: Record<string, unknown>,
  field: string,
  label: string
): number {
  const raw = value[field];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`${label}.${field} must be a finite number.`);
  }
  return raw;
}

function assertPositiveIntegerField(
  value: Record<string, unknown>,
  field: string,
  label: string
): void {
  const raw = value[field];
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
    throw new Error(`${label}.${field} must be a positive integer.`);
  }
}

function assertStrictNodeGeometry(
  node: Record<string, unknown>,
  nodeLabel: string
): void {
  if (!isRecord(node.position)) {
    throw new Error(`${nodeLabel}.position must be an object with finite x and y numbers.`);
  }
  const position = node.position;
  assertOnlyFields(position, NODE_POSITION_FIELDS, `${nodeLabel}.position`);
  assertFiniteNumberField(position, "x", `${nodeLabel}.position`);
  assertFiniteNumberField(position, "y", `${nodeLabel}.position`);

  if (!hasOwn(node, "size")) {
    return;
  }
  if (!isRecord(node.size)) {
    throw new Error(`${nodeLabel}.size must be an object with a finite width.`);
  }
  const size = node.size;
  assertOnlyFields(size, NODE_SIZE_FIELDS, `${nodeLabel}.size`);
  const width = assertFiniteNumberField(size, "width", `${nodeLabel}.size`);
  if (width <= 0) {
    throw new Error(`${nodeLabel}.size.width must be greater than zero.`);
  }
  if (hasOwn(size, "height")) {
    const height = assertFiniteNumberField(size, "height", `${nodeLabel}.size`);
    if (height <= 0) {
      throw new Error(`${nodeLabel}.size.height must be greater than zero.`);
    }
  }
}

function assertStrictProjectEnvelope(document: Record<string, unknown>): void {
  assertOnlyFields(document, ROOT_FIELDS, "Studio project root");
  assertRequiredFields(document, ROOT_REQUIRED_FIELDS, "Studio project root");
  if (document.schema !== "studio.project.v1") {
    throw new Error("schema must be studio.project.v1.");
  }
  for (const field of ["projectId", "name", "createdAt", "updatedAt"] as const) {
    assertTrimmedStringField(document, field, "Studio project root");
  }

  const engine = assertClosedObject(
    document.engine,
    ENGINE_FIELDS,
    ["apiMode", "minPluginVersion"],
    "engine"
  );
  if (engine.apiMode !== "systemsculpt_only") {
    throw new Error("engine.apiMode must be systemsculpt_only.");
  }
  assertTrimmedStringField(engine, "minPluginVersion", "engine");

  const permissions = assertClosedObject(
    document.permissionsRef,
    PERMISSIONS_FIELDS,
    ["policyVersion", "policyPath"],
    "permissionsRef"
  );
  assertPositiveIntegerField(permissions, "policyVersion", "permissionsRef");
  assertTrimmedStringField(permissions, "policyPath", "permissionsRef");

  const settings = assertClosedObject(
    document.settings,
    SETTINGS_FIELDS,
    ["runConcurrency", "defaultFsScope", "retention"],
    "settings"
  );
  if (settings.runConcurrency !== "adaptive") {
    throw new Error("settings.runConcurrency must be adaptive.");
  }
  if (settings.defaultFsScope !== "vault") {
    throw new Error("settings.defaultFsScope must be vault.");
  }
  const retention = assertClosedObject(
    settings.retention,
    RETENTION_FIELDS,
    ["maxRuns", "maxArtifactsMb"],
    "settings.retention"
  );
  assertPositiveIntegerField(retention, "maxRuns", "settings.retention");
  assertPositiveIntegerField(retention, "maxArtifactsMb", "settings.retention");

  const migrations = assertClosedObject(
    document.migrations,
    MIGRATIONS_FIELDS,
    ["projectSchemaVersion", "applied"],
    "migrations"
  );
  assertTrimmedStringField(migrations, "projectSchemaVersion", "migrations");
  if (!Array.isArray(migrations.applied)) {
    throw new Error("migrations.applied must be an array.");
  }
  migrations.applied.forEach((rawMigration, index) => {
    const label = `migrations.applied[${index}]`;
    const migration = assertClosedObject(rawMigration, MIGRATION_FIELDS, ["id", "at"], label);
    assertTrimmedStringField(migration, "id", label);
    assertTrimmedStringField(migration, "at", label);
  });

  if (hasOwn(document, "agentGuide")) {
    if (!isRecord(document.agentGuide) || document.agentGuide.schema !== "studio.agent-guide.v1") {
      throw new Error("agentGuide must be the generated studio.agent-guide.v1 object.");
    }
  }
  if (hasOwn(document, "nodeKindReference")) {
    if (
      !isRecord(document.nodeKindReference)
      || document.nodeKindReference.schema !== "studio.node-kind-reference.v1"
      || !Array.isArray(document.nodeKindReference.kinds)
    ) {
      throw new Error("nodeKindReference must be the generated studio.node-kind-reference.v1 object.");
    }
  }
}

/**
 * Rejects raw agent-authored structure that the compatibility parser would
 * otherwise normalize away. A successful edit must describe the same canvas
 * Studio will display, rather than silently moving nodes or dropping graph
 * data after a filesystem editor reports success.
 *
 * This module intentionally has no schema or persistence imports so the same
 * boundary can be used by ChatView file tools, direct filesystem reload, and
 * linting before any compatibility normalization occurs.
 */
export function assertValidStudioProjectAgentDocumentStructure(document: unknown): void {
  if (!isRecord(document)) {
    throw new Error("The Studio project root must be a JSON object.");
  }
  assertStrictProjectEnvelope(document);
  const graph = assertClosedObject(
    document.graph,
    GRAPH_FIELDS,
    ["nodes", "edges", "entryNodeIds", "groups"],
    "graph"
  );
  for (const field of ["nodes", "edges", "entryNodeIds", "groups"] as const) {
    if (!Array.isArray(graph[field])) {
      throw new Error(`graph.${field} must be an array.`);
    }
  }

  const nodeIds = new Set<string>();
  (graph.nodes as unknown[]).forEach((rawNode, index) => {
    const nodeLabel = `graph.nodes[${index}]`;
    const node = assertClosedObject(rawNode, NODE_FIELDS, NODE_REQUIRED_FIELDS, nodeLabel);
    const nodeId = assertTrimmedStringField(node, "id", nodeLabel);
    if (nodeIds.has(nodeId)) {
      throw new Error(`graph.nodes contains duplicate node ID "${nodeId}".`);
    }
    nodeIds.add(nodeId);
    for (const field of ["kind", "version", "title"] as const) {
      assertTrimmedStringField(node, field, nodeLabel);
    }
    if (!isRecord(node.config)) {
      throw new Error(`${nodeLabel}.config must be an object.`);
    }
    for (const field of ["continueOnError", "disabled"] as const) {
      if (hasOwn(node, field) && typeof node[field] !== "boolean") {
        throw new Error(`${nodeLabel}.${field} must be a boolean when present.`);
      }
    }
    assertStrictNodeGeometry(node, nodeLabel);
  });

  const edgeIds = new Set<string>();
  (graph.edges as unknown[]).forEach((rawEdge, index) => {
    const edgeLabel = `graph.edges[${index}]`;
    const edge = assertClosedObject(rawEdge, EDGE_FIELDS, [...EDGE_FIELDS], edgeLabel);
    const edgeId = assertTrimmedStringField(edge, "id", edgeLabel);
    if (edgeIds.has(edgeId)) {
      throw new Error(`graph.edges contains duplicate edge ID "${edgeId}".`);
    }
    edgeIds.add(edgeId);
    for (const field of ["fromNodeId", "fromPortId", "toNodeId", "toPortId"] as const) {
      assertTrimmedStringField(edge, field, edgeLabel);
    }
    if (!nodeIds.has(edge.fromNodeId as string)) {
      throw new Error(`${edgeLabel} references missing source node "${String(edge.fromNodeId)}".`);
    }
    if (!nodeIds.has(edge.toNodeId as string)) {
      throw new Error(`${edgeLabel} references missing target node "${String(edge.toNodeId)}".`);
    }
  });

  const entryNodeIds = new Set<string>();
  (graph.entryNodeIds as unknown[]).forEach((rawNodeId, index) => {
    const entryLabel = `graph.entryNodeIds[${index}]`;
    if (typeof rawNodeId !== "string" || !rawNodeId.trim()) {
      throw new Error(`${entryLabel} must be a non-empty string.`);
    }
    if (rawNodeId !== rawNodeId.trim()) {
      throw new Error(`${entryLabel} must not contain surrounding whitespace.`);
    }
    if (entryNodeIds.has(rawNodeId)) {
      throw new Error(`graph.entryNodeIds contains duplicate node ID "${rawNodeId}".`);
    }
    if (!nodeIds.has(rawNodeId)) {
      throw new Error(`${entryLabel} references missing node "${rawNodeId}".`);
    }
    entryNodeIds.add(rawNodeId);
  });

  const groupIds = new Set<string>();
  const groupByNodeId = new Map<string, string>();
  (graph.groups as unknown[]).forEach((rawGroup, index) => {
    const groupLabel = `graph.groups[${index}]`;
    const group = assertClosedObject(rawGroup, GROUP_FIELDS, ["id", "name", "nodeIds"], groupLabel);
    const groupId = assertTrimmedStringField(group, "id", groupLabel);
    if (groupIds.has(groupId)) {
      throw new Error(`graph.groups contains duplicate group ID "${groupId}".`);
    }
    groupIds.add(groupId);
    assertTrimmedStringField(group, "name", groupLabel);
    if (hasOwn(group, "color")) {
      if (
        typeof group.color !== "string"
        || group.color !== group.color.trim()
        || !HEX_COLOR_PATTERN.test(group.color)
      ) {
        throw new Error(`${groupLabel}.color must be #rgb or #rrggbb without surrounding whitespace.`);
      }
    }
    if (!Array.isArray(group.nodeIds) || group.nodeIds.length === 0) {
      throw new Error(`${groupLabel}.nodeIds must be a non-empty array.`);
    }
    const localNodeIds = new Set<string>();
    group.nodeIds.forEach((rawNodeId, nodeIndex) => {
      const memberLabel = `${groupLabel}.nodeIds[${nodeIndex}]`;
      if (typeof rawNodeId !== "string" || !rawNodeId.trim()) {
        throw new Error(`${memberLabel} must be a non-empty string.`);
      }
      if (rawNodeId !== rawNodeId.trim()) {
        throw new Error(`${memberLabel} must not contain surrounding whitespace.`);
      }
      if (localNodeIds.has(rawNodeId)) {
        throw new Error(`${groupLabel} contains duplicate node ID "${rawNodeId}".`);
      }
      localNodeIds.add(rawNodeId);
      if (!nodeIds.has(rawNodeId)) {
        throw new Error(`${groupLabel} references missing node "${rawNodeId}".`);
      }
      const existingGroupId = groupByNodeId.get(rawNodeId);
      if (existingGroupId) {
        throw new Error(
          `Node "${rawNodeId}" belongs to both group "${existingGroupId}" and group "${groupId}".`
        );
      }
      groupByNodeId.set(rawNodeId, groupId);
    });
  });
}

/**
 * Generated and identity-bearing fields are plugin-owned. An ordinary file
 * edit may change the project name, timestamp, and graph, but cannot silently
 * replace the document contract or detach it from its existing history.
 */
export function assertStableStudioProjectAgentDocumentFieldsUnchanged(
  document: unknown,
  previousDocument: unknown
): void {
  if (!isRecord(document) || !isRecord(previousDocument)) {
    throw new Error("Studio project field comparison requires two JSON objects.");
  }
  for (const field of STABLE_PROJECT_FIELDS) {
    if (stableJson(document[field]) !== stableJson(previousDocument[field])) {
      throw new Error(`${field} is Studio-owned and must remain unchanged.`);
    }
  }
}
