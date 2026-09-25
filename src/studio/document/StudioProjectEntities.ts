import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";
import { parseStudioProject, serializeStudioProject } from "../schema";
import type { StudioProjectV1 } from "../types";

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type StudioProjectEntities = Record<string, Record<string, Value>>;

/** Stable entity keys, never array offsets, are the unit of authored intent. */
export function projectToEntities(project: StudioProjectV1): StudioProjectEntities {
  const raw = JSON.parse(serializeStudioProject(project));
  const entities: StudioProjectEntities = Object.create(null);
  entities.project = { name: raw.name };
  for (const [collection, kind] of [["nodes", "node"], ["groups", "group"], ["shapes", "shape"]] as const) {
    for (const entity of raw.canvas[collection] || []) {
      entities[`${kind}:${entity.id}`] = kind === "group" ? {
        ...entity,
        nodes: Object.fromEntries((entity.nodes || []).map((id: string) => [id, true])),
        shapes: Object.fromEntries((entity.shapes || []).map((id: string) => [id, true])),
      } : entity;
    }
  }
  for (const edge of raw.canvas.edges || []) entities[`edge:${edge}`] = { value: edge };
  for (const rawArrow of raw.canvas.arrows || []) {
    const [from, to] = typeof rawArrow === "string" ? rawArrow.split(" -> ") : [];
    const arrow = typeof rawArrow === "string" ? {from, to} : rawArrow;
    entities[`arrow:${JSON.stringify([arrow.from, arrow.to])}`] = arrow;
  }
  return entities;
}

/** The entity keys of projectToEntities without copying any content. */
export function studioEntityKeys(project: StudioProjectV1): Set<string> {
  const keys = new Set<string>();
  for (const node of project.graph.nodes) keys.add(`node:${node.id}`);
  for (const group of project.graph.groups || []) keys.add(`group:${group.id}`);
  for (const shape of project.diagram?.shapes || []) keys.add(`shape:${shape.id}`);
  for (const edge of project.graph.edges) keys.add(`edge:${edge.fromNodeId}.${edge.fromPortId} -> ${edge.toNodeId}.${edge.toPortId}`);
  for (const arrow of project.diagram?.arrows || []) keys.add(`arrow:${JSON.stringify([arrow.fromShapeId, arrow.toShapeId])}`);
  return keys;
}

/** Runtime settings remain outside authored entities; parsing validates references. */
export function entitiesToProject(entities: StudioProjectEntities, template: StudioProjectV1): StudioProjectV1 {
  const select = (prefix: string) => Object.entries(entities).filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  if (!entities.project || typeof entities.project.name !== "string") throw new Error("A Studio document requires its project name.");
  for (const [key, value] of Object.entries(entities)) {
    if (key === "project") {
      if (Object.keys(value).some(field => field !== "name")) throw new Error("Unsupported project field.");
    } else if (/^(node|group|shape):/.test(key)) {
      if (value.id !== key.slice(key.indexOf(":") + 1)) throw new Error("Entity key and ID must match.");
    } else if (key.startsWith("edge:")) {
      if (key !== `edge:${String(value.value)}` || Object.keys(value).some(field => field !== "value")) throw new Error("Invalid edge entity.");
    } else if (key.startsWith("arrow:")) {
      if (key !== `arrow:${JSON.stringify([value.from, value.to])}`) throw new Error("Invalid arrow entity.");
    } else throw new Error(`Unknown Studio entity ${key}.`);
  }
  const nodes = select("node:").map(node => ({...node}));
  const nodeIds = new Set(nodes.map(node => node.id));
  for (const node of nodes) if (node.parent && !nodeIds.has(node.parent)) delete node.parent;
  const shapes = select("shape:");
  const shapeIds = new Set(shapes.map(shape => shape.id));
  // References are projections: removing a node cannot be undone by a stale edge.
  const edges = select("edge:").map(edge => edge.value).filter(edge => {
    if (typeof edge !== "string") return false;
    const match = /^(.*?)\.[^ ]+ -> (.*?)\.[^ ]+$/.exec(edge);
    return match && nodeIds.has(match[1]) && nodeIds.has(match[2]);
  });
  const groups = select("group:").map(group => {
    const members = (value: Value | undefined): Value[] => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(member => member !== true)) throw new Error("Group membership must map entity IDs to true.");
      return Object.keys(value);
    };
    const next: Record<string, Value> = {...group, nodes: members(group.nodes), shapes: members(group.shapes || {})};
    if (Array.isArray(next.nodes)) next.nodes = next.nodes.filter(id => nodeIds.has(id));
    if (Array.isArray(next.shapes)) next.shapes = next.shapes.filter(id => shapeIds.has(id));
    if (next.outputFor && !nodeIds.has(next.outputFor)) { delete next.outputFor; delete next.outputOffset; }
    return next;
  }).filter(group => (Array.isArray(group.nodes) && group.nodes.length) || (Array.isArray(group.shapes) && group.shapes.length));
  const readable = {
    schema: "studio.project.v2", id: template.projectId,
    name: entities.project?.name || template.name,
    canvas: { nodes, edges, groups, shapes,
      arrows: select("arrow:").filter(arrow => (shapeIds.has(arrow.from) || nodeIds.has(arrow.from)) && (shapeIds.has(arrow.to) || nodeIds.has(arrow.to))), layout: { mode: "manual" } },
  };
  assertValidStudioProjectAgentDocumentStructure(readable);
  const parsed = parseStudioProject(JSON.stringify(readable));
  return { ...template, name: parsed.name, graph: parsed.graph, diagram: parsed.diagram };
}
