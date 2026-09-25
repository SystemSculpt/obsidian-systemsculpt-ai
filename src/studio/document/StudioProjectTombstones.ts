/** Entity key (`node:<id>`, `edge:<a.x -> b.y>`, ...) to its deletion time in
 * epoch milliseconds. Only keys, never deleted content, are retained. */
export type StudioTombstones = Record<string, number>;

const SCHEMA = "studio.tombstones.v1";
/** Longer than any plausible offline copy; an older copy may restore a deletion. */
export const STUDIO_TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const STUDIO_TOMBSTONE_MAX_ENTRIES = 1000;

const reserved = new Set(["__proto__", "constructor", "prototype"]);

/** A damaged or foreign sidecar only removes protection; it never blocks opening the canvas. */
export function parseStudioTombstones(raw: string): StudioTombstones {
  const tombstones: StudioTombstones = Object.create(null);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return tombstones; }
  if (!parsed || typeof parsed !== "object" || (parsed as { schema?: unknown }).schema !== SCHEMA) return tombstones;
  const deleted = (parsed as { deleted?: unknown }).deleted;
  if (!deleted || typeof deleted !== "object" || Array.isArray(deleted)) return tombstones;
  for (const [key, at] of Object.entries(deleted)) {
    if (!reserved.has(key) && key.includes(":") && typeof at === "number" && Number.isFinite(at) && at > 0) tombstones[key] = at;
  }
  return tombstones;
}

export function serializeStudioTombstones(tombstones: StudioTombstones): string {
  const deleted = Object.fromEntries(Object.keys(tombstones).sort().map(key => [key, tombstones[key]]));
  return `${JSON.stringify({ schema: SCHEMA, deleted }, null, 2)}\n`;
}

/** Union by key; the later deletion time wins. */
export function mergeStudioTombstones(left: StudioTombstones, right: StudioTombstones): StudioTombstones {
  const merged: StudioTombstones = Object.assign(Object.create(null), left);
  for (const [key, at] of Object.entries(right)) if (!(merged[key] >= at)) merged[key] = at;
  return merged;
}

/**
 * Record entities that left the accepted document and forget those present in
 * it again (an explicit Undo or restore). Expired entries are pruned by age,
 * then the newest entries are kept up to the cap.
 */
export function updateStudioTombstones(
  tombstones: StudioTombstones,
  previous: ReadonlySet<string> | null,
  next: ReadonlySet<string>,
  now: number
): StudioTombstones {
  const updated: StudioTombstones = Object.create(null);
  for (const [key, at] of Object.entries(tombstones)) if (!next.has(key) && now - at <= STUDIO_TOMBSTONE_MAX_AGE_MS) updated[key] = at;
  if (previous) for (const key of previous) if (!next.has(key)) updated[key] = now;
  const keys = Object.keys(updated);
  if (keys.length <= STUDIO_TOMBSTONE_MAX_ENTRIES) return updated;
  const kept: StudioTombstones = Object.create(null);
  for (const key of keys.sort((a, b) => updated[b] - updated[a] || a.localeCompare(b)).slice(0, STUDIO_TOMBSTONE_MAX_ENTRIES)) kept[key] = updated[key];
  return kept;
}

export function sameStudioTombstones(left: StudioTombstones, right: StudioTombstones): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}
