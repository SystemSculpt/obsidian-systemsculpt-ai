const PROJECT_SCHEMA_V1 = "studio.project.v1";
const PROJECT_SCHEMA_V2 = "studio.project.v2";
const ROOT_V2_FIELDS = new Set(["schema", "id", "name", "docs", "canvas"]);
const ROOT_V2_REQUIRED_FIELDS = ["schema", "id", "name", "canvas"] as const;
const CANVAS_FIELDS = new Set(["nodes", "edges", "groups", "shapes", "arrows"]);
const NODE_V2_FIELDS = new Set([
  "id",
  "kind",
  "title",
  "x",
  "y",
  "width",
  "height",
  "config",
  "continueOnError",
  "disabled",
]);
const NODE_V2_REQUIRED_FIELDS = ["id", "kind", "x", "y"] as const;
const SHAPE_V2_FIELDS = new Set(["id", "shape", "x", "y", "width", "height", "label", "style"]);
const SHAPE_V2_REQUIRED_FIELDS = ["id", "shape", "x", "y", "width", "height", "label"] as const;
const ARROW_V2_FIELDS = new Set(["from", "to", "label"]);
const ARROW_V2_REQUIRED_FIELDS = ["from", "to"] as const;
const GROUP_V2_FIELDS = new Set(["id", "name", "color", "nodes", "shapes"]);
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
  "diagram",
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
const GROUP_FIELDS = new Set(["id", "name", "color", "nodeIds", "shapeIds"]);
const DIAGRAM_FIELDS = new Set(["shapes", "arrows"]);
const SHAPE_FIELDS = new Set(["id", "shape", "position", "size", "label", "style"]);
const SHAPE_REQUIRED_FIELDS = ["id", "shape", "position", "size", "label"] as const;
const SHAPE_KINDS = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "pill",
  "cylinder",
  "note",
  "hexagon",
]);
const SHAPE_SIZE_FIELDS = new Set(["width", "height"]);
const ARROW_FIELDS = new Set(["id", "fromShapeId", "toShapeId", "label"]);
const ARROW_REQUIRED_FIELDS = ["id", "fromShapeId", "toShapeId"] as const;
// Mirrors src/studio/StudioShapes.ts. Duplicated on purpose: this module keeps
// zero schema imports so every entry point can validate before normalizing.
const SHAPE_MIN_SIZE = 48;
const SHAPE_MAX_SIZE = 4000;
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
] as const;
const GENERATED_PROJECT_FIELDS = [
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
  if (document.schema === PROJECT_SCHEMA_V2) {
    assertStrictProjectV2(document);
    return;
  }
  if (document.schema !== PROJECT_SCHEMA_V1) {
    throw new Error("schema must be studio.project.v2.");
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
    // Entry IDs referencing missing nodes are tolerated: entryNodeIds is
    // derived data that Studio recomputes and parse drops stale references,
    // so an edit that deletes a node without touching this list must not
    // make the document unopenable.
    entryNodeIds.add(rawNodeId);
  });

  // The diagram is validated first because a group may frame shapes, and its
  // members have to resolve against a shape list that is already known good.
  const shapeIds = assertStrictDiagram(document);

  const groupIds = new Set<string>();
  const groupByNodeId = new Map<string, string>();
  const groupByShapeId = new Map<string, string>();
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
    if (!Array.isArray(group.nodeIds)) {
      throw new Error(`${groupLabel}.nodeIds must be an array.`);
    }
    if (hasOwn(group, "shapeIds") && !Array.isArray(group.shapeIds)) {
      throw new Error(`${groupLabel}.shapeIds must be an array.`);
    }
    const groupShapeIds = Array.isArray(group.shapeIds) ? group.shapeIds : [];
    // A group frames nodes, shapes, or both, so only an entirely empty one is
    // invalid.
    if (group.nodeIds.length === 0 && groupShapeIds.length === 0) {
      throw new Error(`${groupLabel} must contain at least one node or shape.`);
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

    const localShapeIds = new Set<string>();
    groupShapeIds.forEach((rawShapeId, shapeIndex) => {
      const memberLabel = `${groupLabel}.shapeIds[${shapeIndex}]`;
      if (typeof rawShapeId !== "string" || !rawShapeId.trim()) {
        throw new Error(`${memberLabel} must be a non-empty string.`);
      }
      if (rawShapeId !== rawShapeId.trim()) {
        throw new Error(`${memberLabel} must not contain surrounding whitespace.`);
      }
      if (localShapeIds.has(rawShapeId)) {
        throw new Error(`${groupLabel} contains duplicate shape ID "${rawShapeId}".`);
      }
      localShapeIds.add(rawShapeId);
      if (!shapeIds.has(rawShapeId)) {
        throw new Error(`${groupLabel} references missing shape "${rawShapeId}".`);
      }
      const existingGroupId = groupByShapeId.get(rawShapeId);
      if (existingGroupId) {
        throw new Error(
          `Shape "${rawShapeId}" belongs to both group "${existingGroupId}" and group "${groupId}".`
        );
      }
      groupByShapeId.set(rawShapeId, groupId);
    });
  });
}

function assertStrictDiagram(document: Record<string, unknown>): Set<string> {
  if (!hasOwn(document, "diagram")) {
    return new Set<string>();
  }
  const diagram = assertClosedObject(
    document.diagram,
    DIAGRAM_FIELDS,
    ["shapes", "arrows"],
    "diagram"
  );
  for (const field of ["shapes", "arrows"] as const) {
    if (!Array.isArray(diagram[field])) {
      throw new Error(`diagram.${field} must be an array.`);
    }
  }

  const shapeIds = new Set<string>();
  (diagram.shapes as unknown[]).forEach((rawShape, index) => {
    const label = `diagram.shapes[${index}]`;
    const shape = assertClosedObject(rawShape, SHAPE_FIELDS, SHAPE_REQUIRED_FIELDS, label);
    const shapeId = assertTrimmedStringField(shape, "id", label);
    if (shapeIds.has(shapeId)) {
      throw new Error(`diagram.shapes contains duplicate shape ID "${shapeId}".`);
    }
    shapeIds.add(shapeId);
    if (typeof shape.shape !== "string" || !SHAPE_KINDS.has(shape.shape)) {
      throw new Error(
        `${label}.shape must be one of ${[...SHAPE_KINDS].map((kind) => `"${kind}"`).join(", ")}.`
      );
    }
    if (typeof shape.label !== "string") {
      throw new Error(`${label}.label must be a string.`);
    }
    if (hasOwn(shape, "style") && !isRecord(shape.style)) {
      throw new Error(`${label}.style must be an object when present.`);
    }

    const position = assertClosedObject(shape.position, NODE_POSITION_FIELDS, ["x", "y"], `${label}.position`);
    for (const axis of ["x", "y"] as const) {
      if (!Number.isSafeInteger(position[axis])) {
        throw new Error(`${label}.position.${axis} must be a whole number.`);
      }
    }

    const size = assertClosedObject(shape.size, SHAPE_SIZE_FIELDS, ["width", "height"], `${label}.size`);
    for (const dimension of ["width", "height"] as const) {
      const value = size[dimension];
      if (
        !Number.isSafeInteger(value)
        || (value as number) < SHAPE_MIN_SIZE
        || (value as number) > SHAPE_MAX_SIZE
      ) {
        throw new Error(
          `${label}.size.${dimension} must be a whole number between ${SHAPE_MIN_SIZE} and ${SHAPE_MAX_SIZE}.`
        );
      }
    }
  });

  const arrowIds = new Set<string>();
  const arrowPairs = new Set<string>();
  (diagram.arrows as unknown[]).forEach((rawArrow, index) => {
    const label = `diagram.arrows[${index}]`;
    const arrow = assertClosedObject(rawArrow, ARROW_FIELDS, [...ARROW_REQUIRED_FIELDS], label);
    const arrowId = assertTrimmedStringField(arrow, "id", label);
    if (arrowIds.has(arrowId)) {
      throw new Error(`diagram.arrows contains duplicate arrow ID "${arrowId}".`);
    }
    arrowIds.add(arrowId);
    const fromShapeId = assertTrimmedStringField(arrow, "fromShapeId", label);
    const toShapeId = assertTrimmedStringField(arrow, "toShapeId", label);
    if ("label" in arrow && typeof arrow.label !== "string") {
      throw new Error(`${label}.label must be a string.`);
    }
    for (const [field, shapeId] of [["fromShapeId", fromShapeId], ["toShapeId", toShapeId]] as const) {
      if (!shapeIds.has(shapeId)) {
        throw new Error(`${label}.${field} references missing shape "${shapeId}".`);
      }
    }
    if (fromShapeId === toShapeId) {
      throw new Error(`${label} must connect two different shapes.`);
    }
    const pair = `${fromShapeId}->${toShapeId}`;
    if (arrowPairs.has(pair)) {
      throw new Error(`diagram.arrows already connects "${fromShapeId}" to "${toShapeId}".`);
    }
    arrowPairs.add(pair);
  });

  return shapeIds;
}

type EdgeStringEndpoint = { ownerId: string };

function resolveEdgeStringEndpoint(
  side: string,
  ownerIds: ReadonlySet<string>,
  label: string,
  ownerNoun: string
): EdgeStringEndpoint {
  const trimmed = side.trim();
  if (!trimmed) {
    throw new Error(`${label} must name a ${ownerNoun} on both sides of "->".`);
  }
  if (ownerIds.has(trimmed)) {
    return { ownerId: trimmed };
  }
  const dot = trimmed.lastIndexOf(".");
  if (dot > 0 && dot < trimmed.length - 1 && ownerIds.has(trimmed.slice(0, dot))) {
    return { ownerId: trimmed.slice(0, dot) };
  }
  throw new Error(`${label} references missing ${ownerNoun} "${trimmed}".`);
}

function assertStrictProjectV2(document: Record<string, unknown>): void {
  assertOnlyFields(document, ROOT_V2_FIELDS, "Studio project root");
  assertRequiredFields(document, ROOT_V2_REQUIRED_FIELDS, "Studio project root");
  for (const field of ["id", "name"] as const) {
    assertTrimmedStringField(document, field, "Studio project root");
  }
  if (hasOwn(document, "docs") && typeof document.docs !== "string") {
    throw new Error("docs must be a string when present.");
  }

  const canvas = assertClosedObject(document.canvas, CANVAS_FIELDS, [], "canvas");
  for (const field of ["nodes", "edges", "groups", "shapes", "arrows"] as const) {
    if (hasOwn(canvas, field) && !Array.isArray(canvas[field])) {
      throw new Error(`canvas.${field} must be an array.`);
    }
  }
  const list = (field: "nodes" | "edges" | "groups" | "shapes" | "arrows"): unknown[] =>
    Array.isArray(canvas[field]) ? (canvas[field] as unknown[]) : [];

  const nodeIds = new Set<string>();
  list("nodes").forEach((rawNode, index) => {
    const nodeLabel = `canvas.nodes[${index}]`;
    const node = assertClosedObject(rawNode, NODE_V2_FIELDS, NODE_V2_REQUIRED_FIELDS, nodeLabel);
    const nodeId = assertTrimmedStringField(node, "id", nodeLabel);
    if (nodeIds.has(nodeId)) {
      throw new Error(`canvas.nodes contains duplicate node ID "${nodeId}".`);
    }
    nodeIds.add(nodeId);
    assertTrimmedStringField(node, "kind", nodeLabel);
    if (hasOwn(node, "title")) {
      assertTrimmedStringField(node, "title", nodeLabel);
    }
    assertFiniteNumberField(node, "x", nodeLabel);
    assertFiniteNumberField(node, "y", nodeLabel);
    if (hasOwn(node, "width") && assertFiniteNumberField(node, "width", nodeLabel) <= 0) {
      throw new Error(`${nodeLabel}.width must be greater than zero.`);
    }
    if (hasOwn(node, "height")) {
      if (!hasOwn(node, "width")) {
        throw new Error(`${nodeLabel}.height requires width.`);
      }
      if (assertFiniteNumberField(node, "height", nodeLabel) <= 0) {
        throw new Error(`${nodeLabel}.height must be greater than zero.`);
      }
    }
    if (hasOwn(node, "config") && !isRecord(node.config)) {
      throw new Error(`${nodeLabel}.config must be an object.`);
    }
    for (const field of ["continueOnError", "disabled"] as const) {
      if (hasOwn(node, field) && typeof node[field] !== "boolean") {
        throw new Error(`${nodeLabel}.${field} must be a boolean when present.`);
      }
    }
  });

  const edgeStrings = new Set<string>();
  list("edges").forEach((rawEdge, index) => {
    const edgeLabel = `canvas.edges[${index}]`;
    if (typeof rawEdge !== "string") {
      throw new Error(`${edgeLabel} must be the string "fromNode.port -> toNode.port".`);
    }
    const parts = rawEdge.split("->");
    if (parts.length !== 2) {
      throw new Error(`${edgeLabel} must contain exactly one "->".`);
    }
    resolveEdgeStringEndpoint(parts[0], nodeIds, edgeLabel, "node");
    resolveEdgeStringEndpoint(parts[1], nodeIds, edgeLabel, "node");
    const normalized = `${parts[0].trim()} -> ${parts[1].trim()}`;
    if (edgeStrings.has(normalized)) {
      throw new Error(`canvas.edges contains duplicate edge "${normalized}".`);
    }
    edgeStrings.add(normalized);
  });

  const shapeIds = new Set<string>();
  list("shapes").forEach((rawShape, index) => {
    const label = `canvas.shapes[${index}]`;
    const shape = assertClosedObject(rawShape, SHAPE_V2_FIELDS, SHAPE_V2_REQUIRED_FIELDS, label);
    const shapeId = assertTrimmedStringField(shape, "id", label);
    if (shapeIds.has(shapeId)) {
      throw new Error(`canvas.shapes contains duplicate shape ID "${shapeId}".`);
    }
    shapeIds.add(shapeId);
    if (typeof shape.shape !== "string" || !SHAPE_KINDS.has(shape.shape)) {
      throw new Error(
        `${label}.shape must be one of ${[...SHAPE_KINDS].map((kind) => `"${kind}"`).join(", ")}.`
      );
    }
    if (typeof shape.label !== "string") {
      throw new Error(`${label}.label must be a string.`);
    }
    if (hasOwn(shape, "style") && !isRecord(shape.style)) {
      throw new Error(`${label}.style must be an object when present.`);
    }
    for (const axis of ["x", "y"] as const) {
      if (!Number.isSafeInteger(shape[axis])) {
        throw new Error(`${label}.${axis} must be a whole number.`);
      }
    }
    for (const dimension of ["width", "height"] as const) {
      const value = shape[dimension];
      if (
        !Number.isSafeInteger(value)
        || (value as number) < SHAPE_MIN_SIZE
        || (value as number) > SHAPE_MAX_SIZE
      ) {
        throw new Error(
          `${label}.${dimension} must be a whole number between ${SHAPE_MIN_SIZE} and ${SHAPE_MAX_SIZE}.`
        );
      }
    }
  });

  const arrowPairs = new Set<string>();
  list("arrows").forEach((rawArrow, index) => {
    const label = `canvas.arrows[${index}]`;
    let fromShapeId: string;
    let toShapeId: string;
    if (typeof rawArrow === "string") {
      const parts = rawArrow.split("->");
      if (parts.length !== 2) {
        throw new Error(`${label} must contain exactly one "->".`);
      }
      fromShapeId = parts[0].trim();
      toShapeId = parts[1].trim();
    } else if (isRecord(rawArrow)) {
      const arrow = assertClosedObject(rawArrow, ARROW_V2_FIELDS, [...ARROW_V2_REQUIRED_FIELDS], label);
      fromShapeId = assertTrimmedStringField(arrow, "from", label);
      toShapeId = assertTrimmedStringField(arrow, "to", label);
      if ("label" in arrow && typeof arrow.label !== "string") {
        throw new Error(`${label}.label must be a string.`);
      }
    } else {
      throw new Error(
        `${label} must be the string "fromShape -> toShape" or an object { from, to, label }.`
      );
    }
    for (const shapeId of [fromShapeId, toShapeId]) {
      if (!shapeId || !shapeIds.has(shapeId)) {
        throw new Error(`${label} references missing shape "${shapeId}".`);
      }
    }
    if (fromShapeId === toShapeId) {
      throw new Error(`${label} must connect two different shapes.`);
    }
    const pair = `${fromShapeId}->${toShapeId}`;
    if (arrowPairs.has(pair)) {
      throw new Error(`canvas.arrows already connects "${fromShapeId}" to "${toShapeId}".`);
    }
    arrowPairs.add(pair);
  });

  const groupIds = new Set<string>();
  const groupByNodeId = new Map<string, string>();
  const groupByShapeId = new Map<string, string>();
  list("groups").forEach((rawGroup, index) => {
    const groupLabel = `canvas.groups[${index}]`;
    const group = assertClosedObject(rawGroup, GROUP_V2_FIELDS, ["id", "name"], groupLabel);
    const groupId = assertTrimmedStringField(group, "id", groupLabel);
    if (groupIds.has(groupId)) {
      throw new Error(`canvas.groups contains duplicate group ID "${groupId}".`);
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
    for (const field of ["nodes", "shapes"] as const) {
      if (hasOwn(group, field) && !Array.isArray(group[field])) {
        throw new Error(`${groupLabel}.${field} must be an array.`);
      }
    }
    const memberNodeIds = Array.isArray(group.nodes) ? group.nodes : [];
    const memberShapeIds = Array.isArray(group.shapes) ? group.shapes : [];
    if (memberNodeIds.length === 0 && memberShapeIds.length === 0) {
      throw new Error(`${groupLabel} must contain at least one node or shape.`);
    }
    const assertMembers = (
      members: unknown[],
      field: "nodes" | "shapes",
      knownIds: ReadonlySet<string>,
      claimed: Map<string, string>,
      noun: string
    ): void => {
      const local = new Set<string>();
      members.forEach((rawMemberId, memberIndex) => {
        const memberLabel = `${groupLabel}.${field}[${memberIndex}]`;
        if (typeof rawMemberId !== "string" || !rawMemberId.trim() || rawMemberId !== rawMemberId.trim()) {
          throw new Error(`${memberLabel} must be a trimmed non-empty string.`);
        }
        if (local.has(rawMemberId)) {
          throw new Error(`${groupLabel} contains duplicate ${noun} ID "${rawMemberId}".`);
        }
        local.add(rawMemberId);
        if (!knownIds.has(rawMemberId)) {
          throw new Error(`${groupLabel} references missing ${noun} "${rawMemberId}".`);
        }
        const existingGroupId = claimed.get(rawMemberId);
        if (existingGroupId) {
          throw new Error(
            `${noun[0].toUpperCase()}${noun.slice(1)} "${rawMemberId}" belongs to both group "${existingGroupId}" and group "${groupId}".`
          );
        }
        claimed.set(rawMemberId, groupId);
      });
    };
    assertMembers(memberNodeIds, "nodes", nodeIds, groupByNodeId, "node");
    assertMembers(memberShapeIds, "shapes", shapeIds, groupByShapeId, "shape");
  });
}

function documentIdentity(document: Record<string, unknown>): unknown {
  return document.schema === PROJECT_SCHEMA_V2 ? document.id : document.projectId;
}

/**
 * Generated and identity-bearing fields are plugin-owned. An ordinary file
 * edit may change the project name and canvas, but cannot silently replace
 * the document contract or detach it from its existing history. The schema
 * may only move forward: v1 documents may be rewritten as v2, never back.
 */
export function assertStableStudioProjectAgentDocumentFieldsUnchanged(
  document: unknown,
  previousDocument: unknown,
  options?: { ignoreGeneratedFields?: boolean }
): void {
  if (!isRecord(document) || !isRecord(previousDocument)) {
    throw new Error("Studio project field comparison requires two JSON objects.");
  }
  if (stableJson(documentIdentity(document)) !== stableJson(documentIdentity(previousDocument))) {
    throw new Error("The project identity is Studio-owned and must remain unchanged.");
  }
  if (document.schema === previousDocument.schema) {
    if (document.schema === PROJECT_SCHEMA_V2) {
      return;
    }
    const fields = options?.ignoreGeneratedFields === true
      ? STABLE_PROJECT_FIELDS
      : [...STABLE_PROJECT_FIELDS, ...GENERATED_PROJECT_FIELDS];
    for (const field of fields) {
      if (stableJson(document[field]) !== stableJson(previousDocument[field])) {
        throw new Error(`${field} is Studio-owned and must remain unchanged.`);
      }
    }
    return;
  }
  if (previousDocument.schema !== PROJECT_SCHEMA_V1 || document.schema !== PROJECT_SCHEMA_V2) {
    throw new Error("schema may only move from studio.project.v1 to studio.project.v2.");
  }
}

/**
 * Generated authoring references describe the current plugin rather than the
 * user's canvas. Persistence uses this signal to refresh only those blocks
 * when an older valid project file is restored over a newer generation. A
 * schema mismatch always reports stale so the store rewrites the canonical
 * dialect.
 */
export function studioProjectGeneratedFieldsMatch(
  document: unknown,
  previousDocument: unknown
): boolean {
  if (!isRecord(document) || !isRecord(previousDocument)) {
    return false;
  }
  if (document.schema !== previousDocument.schema) {
    return false;
  }
  if (document.schema === PROJECT_SCHEMA_V2) {
    return stableJson(document.docs) === stableJson(previousDocument.docs);
  }
  return GENERATED_PROJECT_FIELDS.every(
    (field) => stableJson(document[field]) === stableJson(previousDocument[field])
  );
}
