import type { StudioProjectV1 } from "../types";

/** Keep existing entity handles alive while replacing their accepted values.
 * Render callbacks may retain a node handle; persistence must not strand it on
 * a detached historical object. The source is always copied, never adopted.
 */
export function updateStudioProjectIdentity(target: StudioProjectV1, source: StudioProjectV1): StudioProjectV1 {
  if (target.projectId !== source.projectId) throw new Error("Cannot patch another Studio project.");
  const patch = (previous: unknown, next: unknown): unknown => {
    if (Array.isArray(next)) {
      const old = Array.isArray(previous) ? previous : [];
      const byId = new Map(old.filter(value => value && typeof value === "object" && typeof value.id === "string").map(value => [value.id, value]));
      const values = next.map((value, index) => patch(value && typeof value === "object" && typeof value.id === "string" ? byId.get(value.id) : old[index], value));
      old.splice(0, old.length, ...values); return old;
    }
    if (next && typeof next === "object") {
      const record = previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
      const incoming = next as Record<string, unknown>;
      for (const key of Object.keys(record)) if (!Object.prototype.hasOwnProperty.call(incoming, key)) delete record[key];
      for (const key of Object.keys(incoming)) Object.defineProperty(record, key, {value: patch(record[key], incoming[key]), enumerable: true, configurable: true, writable: true});
      return record;
    }
    return next;
  };
  return patch(target, source) as StudioProjectV1;
}
