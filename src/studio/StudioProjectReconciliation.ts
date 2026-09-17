import { parseStudioProject, serializeStudioProject } from "./schema";
import type { StudioProjectV1 } from "./types";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Value = Json | undefined;
export type StudioProjectReconciliation = { project: StudioProjectV1; conflicts: string[] };

function record(value: Value): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function equal(left: Value, right: Value): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
}

/** Rebase editing intent, by entity ID and field, onto the latest document.
 * A same-field conflict keeps the external value by default; callers preserve
 * the local snapshot before accepting that result. Positional array merging is
 * never used: arbitrary config arrays remain indivisible user values. */
export function reconcileStudioProject(
  base: StudioProjectV1,
  local: StudioProjectV1,
  external: StudioProjectV1,
  options?: { preferLocalConflicts?: boolean }
): StudioProjectReconciliation {
  if (base.projectId !== local.projectId || base.projectId !== external.projectId) throw new Error("Cannot reconcile different Studio projects.");
  const conflicts: string[] = [];
  const merge = (before: Value, ours: Value, theirs: Value, path: string): Value => {
    if (equal(ours, before)) return theirs;
    if (equal(theirs, before) || equal(ours, theirs)) return ours;
    if (record(before) && record(ours) && record(theirs)) {
      const result: { [key: string]: Json } = {};
      for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours), ...Object.keys(before)])) {
        const value = merge(before[key], ours[key], theirs[key], path ? `${path}.${key}` : key);
        if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    const entityArray = /^canvas\.(nodes|edges|groups|shapes|arrows)$/.test(path);
    const membershipArray = /^canvas\.(layout\.pinnedNodeIds|groups\[[^\]]+\]\.(nodes|shapes))$/.test(path);
    if (Array.isArray(before) && Array.isArray(ours) && Array.isArray(theirs) && (entityArray || membershipArray)) {
      const index = (values: Json[]) => new Map<string, Json>(values.map(value => {
        if (typeof value === "string") return [value, value] as const;
        if (!record(value)) throw new Error(`Invalid Studio entity in ${path}.`);
        const id = typeof value.id === "string" ? value.id
          : path === "canvas.arrows" ? `${String(value.from)} -> ${String(value.to)}` : null;
        if (!id) throw new Error(`Invalid Studio entity in ${path}.`);
        return [id, value] as const;
      }));
      const b = index(before), l = index(ours), r = index(theirs);
      const result: Json[] = [];
      for (const id of new Set([...r.keys(), ...l.keys(), ...b.keys()])) {
        const value = merge(b.get(id), l.get(id), r.get(id), `${path}[${id}]`);
        if (value !== undefined) result.push(value);
      }
      return result;
    }
    conflicts.push(path);
    return options?.preferLocalConflicts ? ours : theirs;
  };
  // The public dialect omits generated timestamps, migrations and runtime
  // metadata, which must never turn an unrelated edit into a user conflict.
  const document = (project: StudioProjectV1) => JSON.parse(serializeStudioProject(project)) as Json;
  const merged = merge(document(base), document(local), document(external), "");
  if (record(merged) && record(merged.canvas) && Array.isArray(merged.canvas.nodes) && Array.isArray(merged.canvas.edges)) {
    const ids = new Set(merged.canvas.nodes.filter(record).map(node => node.id));
    // A deletion wins over presentation references added concurrently. These
    // references carry no executable or user-authored node content.
    if (record(merged.canvas.layout) && Array.isArray(merged.canvas.layout.pinnedNodeIds)) {
      merged.canvas.layout.pinnedNodeIds = [...new Set(merged.canvas.layout.pinnedNodeIds)].filter(id => ids.has(id));
    }
    for (const node of merged.canvas.nodes.filter(record)) if (typeof node.parent === "string" && !ids.has(node.parent)) delete node.parent;

    const endpoints = new Map([...base.graph.edges, ...local.graph.edges, ...external.graph.edges].map(edge => [
      `${edge.fromNodeId}.${edge.fromPortId} -> ${edge.toNodeId}.${edge.toPortId}`, edge,
    ]));
    merged.canvas.edges = merged.canvas.edges.filter(value => {
      const edge = typeof value === "string" ? endpoints.get(value) : undefined;
      return edge && ids.has(edge.fromNodeId) && ids.has(edge.toNodeId);
    });
  }
  const project = parseStudioProject(JSON.stringify(merged));
  // Deleting a node also removes its connections, even when another editor
  // concurrently added a connection to the deleted node.
  const nodeIds = new Set(project.graph.nodes.map(node => node.id));
  project.graph.edges = project.graph.edges.filter(edge => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId));
  return { project: { ...external, name: project.name, graph: project.graph, diagram: project.diagram }, conflicts };
}
