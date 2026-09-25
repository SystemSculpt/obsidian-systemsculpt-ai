import type { StudioProjectEntities } from "./StudioProjectEntities";
import { isStudioProseFieldPath, mergeStudioText } from "./StudioTextMerge";

/**
 * Hybrid logical clock stamps: wall milliseconds, a counter, then the device
 * ID, each fixed width, so plain string order is causal-then-wall order. The
 * empty string is older than every stamp and marks an unknown or pruned time.
 */
const WALL_DIGITS = 9, COUNTER_DIGITS = 4;
export const STUDIO_CLOCK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 1000, MAX_FILES = 16, MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SCHEMA = "studio.document-clock.v1";
const NESTED_FIELDS = new Set(["config", "nodes", "shapes"]);
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function studioStamp(wall: number, counter = 0, device = ""): string {
  return `${Math.max(0, Math.floor(wall)).toString(36).padStart(WALL_DIGITS, "0")}${counter.toString(36).padStart(COUNTER_DIGITS, "0")}${device}`;
}
const stampWall = (stamp: string): number => stamp ? parseInt(stamp.slice(0, WALL_DIGITS), 36) : 0;
const later = (left: string, right: string): string => left > right ? left : right;

export class StudioHybridClock {
  private wall = 0;
  private counter = 0;
  constructor(readonly device: string, private readonly time: () => number = Date.now) {}
  wallNow(): number { return this.time(); }
  now(): string {
    const time = this.time();
    if (time > this.wall) { this.wall = time; this.counter = 0; } else this.counter++;
    return studioStamp(this.wall, this.counter, this.device);
  }
  /** Stamps seen from other devices order this device's later stamps after them. */
  observe(stamp: string): void {
    const wall = stampWall(stamp), counter = parseInt(stamp.slice(WALL_DIGITS, WALL_DIGITS + COUNTER_DIGITS), 36);
    if (!Number.isFinite(wall) || !Number.isFinite(counter) || wall > this.time() + MAX_FUTURE_MS) return;
    if (wall > this.wall || (wall === this.wall && counter > this.counter)) { this.wall = wall; this.counter = counter; }
  }
}

/** Per entity key: "" is when it was created or restored; other keys stamp its fields. */
export type StudioEntityStamps = Record<string, string | Record<string, string>>;
export type StudioDocumentClockState = {
  stamps: Record<string, StudioEntityStamps>;
  /** Entity key to deletion stamp. */
  deleted: Record<string, string>;
  /** SHA-256 of a file text this device wrote to its stamp at that time. */
  files: Record<string, string>;
};

export function emptyStudioClock(): StudioDocumentClockState {
  return {stamps: Object.create(null), deleted: Object.create(null), files: Object.create(null)};
}

const isStamp = (value: unknown): value is string => typeof value === "string" && /^[0-9a-z]{13}[0-9a-z_-]{0,32}$/.test(value);
function stringMap(value: unknown, accept: (key: string, item: unknown) => boolean): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return map;
  for (const [key, item] of Object.entries(value)) if (!RESERVED_KEYS.has(key) && isStamp(item) && accept(key, item)) map[key] = item;
  return map;
}

/** A damaged or foreign clock file only removes merge information; it never blocks opening the canvas. */
export function parseStudioClock(raw: string): {device: string; clock: StudioDocumentClockState} | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as {schema?: unknown; device?: unknown; stamps?: unknown; deleted?: unknown; files?: unknown};
  if (value.schema !== CLOCK_SCHEMA || typeof value.device !== "string" || !/^[0-9a-z_-]{1,32}$/.test(value.device)) return null;
  const clock = emptyStudioClock();
  clock.deleted = stringMap(value.deleted, key => key.includes(":"));
  clock.files = stringMap(value.files, key => /^[0-9a-f]{64}$/.test(key));
  if (value.stamps && typeof value.stamps === "object" && !Array.isArray(value.stamps)) {
    for (const [key, fields] of Object.entries(value.stamps as Record<string, unknown>)) {
      if (RESERVED_KEYS.has(key) || !key.includes(":") || !fields || typeof fields !== "object" || Array.isArray(fields)) continue;
      const entity: StudioEntityStamps = Object.create(null);
      for (const [field, stamp] of Object.entries(fields)) {
        if (RESERVED_KEYS.has(field)) continue;
        if (isStamp(stamp)) entity[field] = stamp;
        else if (NESTED_FIELDS.has(field)) entity[field] = stringMap(stamp, () => true);
      }
      clock.stamps[key] = entity;
    }
  }
  return {device: value.device, clock};
}

export function serializeStudioClock(device: string, clock: StudioDocumentClockState): string {
  const sorted = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
    : value;
  return `${JSON.stringify({schema: CLOCK_SCHEMA, device, stamps: sorted(clock.stamps), deleted: sorted(clock.deleted), files: sorted(clock.files)})}\n`;
}

export function cloneStudioClock(clock: StudioDocumentClockState): StudioDocumentClockState {
  return JSON.parse(JSON.stringify(clock), (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.assign(Object.create(null), value) : value) as StudioDocumentClockState;
}

/** The newest stamp a clock file carries; an abandoned device's file ages out. */
export function newestStudioClockStamp(clock: StudioDocumentClockState): string {
  let newest = "";
  for (const stamp of [...Object.values(clock.deleted), ...Object.values(clock.files)]) newest = later(newest, stamp);
  for (const fields of Object.values(clock.stamps)) for (const value of Object.values(fields)) {
    if (typeof value === "string") newest = later(newest, value); else for (const stamp of Object.values(value)) newest = later(newest, stamp);
  }
  return newest;
}

/** A device that has not written for the retention period no longer informs merges. */
export function isStudioClockCurrent(clock: StudioDocumentClockState, nowWall: number): boolean {
  return nowWall - stampWall(newestStudioClockStamp(clock)) <= STUDIO_CLOCK_MAX_AGE_MS;
}

/** Tombstones from every device; the later deletion time wins. */
export function mergeStudioTombstones(left: Record<string, string>, right: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = Object.assign(Object.create(null), left);
  for (const [key, stamp] of Object.entries(right)) merged[key] = later(merged[key] || "", stamp);
  return merged;
}

/**
 * Keep the clock small: stamps and tombstones expire by age, stamps of
 * entities no longer present go with them, tombstones keep the newest 1,000,
 * and file watermarks keep this device's newest 16 writes.
 */
export function pruneStudioClock(clock: StudioDocumentClockState, present: ReadonlySet<string>, nowWall: number): void {
  const expired = (stamp: string) => nowWall - stampWall(stamp) > STUDIO_CLOCK_MAX_AGE_MS;
  for (const [key, fields] of Object.entries(clock.stamps)) {
    if (!present.has(key)) { delete clock.stamps[key]; continue; }
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === "string") { if (expired(value)) delete fields[field]; continue; }
      for (const [sub, stamp] of Object.entries(value)) if (expired(stamp)) delete value[sub];
      if (!Object.keys(value).length) delete fields[field];
    }
    if (!Object.keys(fields).length) delete clock.stamps[key];
  }
  for (const [key, stamp] of Object.entries(clock.deleted)) if (present.has(key) || expired(stamp)) delete clock.deleted[key];
  const tombstones = Object.keys(clock.deleted).sort((a, b) => clock.deleted[b].localeCompare(clock.deleted[a]));
  for (const key of tombstones.slice(MAX_TOMBSTONES)) delete clock.deleted[key];
  const files = Object.keys(clock.files).sort((a, b) => clock.files[b].localeCompare(clock.files[a]));
  for (const hash of files.slice(MAX_FILES)) delete clock.files[hash];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Entity = StudioProjectEntities[string];
type Leaf = {top: string; sub?: string};

const canonical = (value: unknown): string => value === undefined ? "\u0000" : JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const record = (value: unknown): value is Record<string, Json> => !!value && typeof value === "object" && !Array.isArray(value);

/** Entity fields at merge granularity: config keys and group members individually, everything else whole. */
function leaves(entity: Entity | undefined): Map<string, {leaf: Leaf; value: Json}> {
  const result = new Map<string, {leaf: Leaf; value: Json}>();
  for (const [top, value] of Object.entries(entity || {})) {
    if (NESTED_FIELDS.has(top) && record(value)) for (const [sub, item] of Object.entries(value)) result.set(`${top}\u0000${sub}`, {leaf: {top, sub}, value: item});
    else result.set(top, {leaf: {top}, value});
  }
  return result;
}
function setLeaf(entity: Entity, leaf: Leaf, value: Json | undefined): void {
  if (leaf.sub === undefined) { if (value === undefined) delete entity[leaf.top]; else entity[leaf.top] = copy(value); return; }
  if (value === undefined) { const container = entity[leaf.top]; if (record(container)) delete container[leaf.sub]; return; }
  const container = record(entity[leaf.top]) ? entity[leaf.top] as Record<string, Json> : (entity[leaf.top] = {}) as Record<string, Json>;
  container[leaf.sub] = copy(value);
}
const presence = (stamps: StudioDocumentClockState["stamps"], key: string): string => {
  const value = stamps[key]?.[""];
  return typeof value === "string" ? value : "";
};
function leafStamp(stamps: StudioDocumentClockState["stamps"], key: string, leaf: Leaf): string {
  const value = stamps[key]?.[leaf.top];
  const own = leaf.sub === undefined ? (typeof value === "string" ? value : undefined) : (value && typeof value === "object" ? value[leaf.sub] : undefined);
  return own || presence(stamps, key);
}
function setLeafStamp(stamps: StudioDocumentClockState["stamps"], key: string, leaf: Leaf, stamp: string): void {
  const fields = stamps[key] ||= Object.create(null) as StudioEntityStamps;
  if (leaf.sub === undefined) { fields[leaf.top] = stamp; return; }
  const nested = fields[leaf.top];
  (nested && typeof nested === "object" ? nested : (fields[leaf.top] = Object.create(null) as Record<string, string>))[leaf.sub] = stamp;
}
function newestOf(stamps: StudioDocumentClockState["stamps"], key: string): string {
  let newest = "";
  for (const value of Object.values(stamps[key] || {})) {
    if (typeof value === "string") newest = later(newest, value); else for (const stamp of Object.values(value)) newest = later(newest, stamp);
  }
  return newest;
}

/** A local value's pre-change state since the last external merge: the common base for diff3. */
export type StudioPendingBase = {value: Json | undefined; stamp: string};
const pendingKey = (key: string, leaf: Leaf) => `${key}\u0000${leaf.top}\u0000${leaf.sub ?? ""}`;

/**
 * Stamp what this device changed between two accepted states: new or restored
 * entities, changed fields, and deletions. The first local change of a field
 * since the last external merge remembers the prior value for diff3.
 */
export function recordStudioChanges(
  clock: StudioDocumentClockState,
  before: StudioProjectEntities,
  after: StudioProjectEntities,
  now: () => string,
  pending: Map<string, StudioPendingBase>
): void {
  for (const key of Object.keys(before)) if (!(key in after)) {
    clock.deleted[key] = now();
    delete clock.stamps[key];
  }
  for (const [key, entity] of Object.entries(after)) {
    if (!(key in before)) {
      clock.stamps[key] = Object.assign(Object.create(null), {"": now()});
      delete clock.deleted[key];
      continue;
    }
    const previous = leaves(before[key]), next = leaves(entity);
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const leaf = (next.get(id) || previous.get(id))!.leaf;
      if (canonical(previous.get(id)?.value) === canonical(next.get(id)?.value)) continue;
      const slot = pendingKey(key, leaf);
      if (!pending.has(slot)) pending.set(slot, {value: copy(previous.get(id)?.value), stamp: leafStamp(clock.stamps, key, leaf)});
      setLeafStamp(clock.stamps, key, leaf, now());
    }
  }
}

/** Who wrote an incoming file and how its values are dated. */
export type StudioIncomingWriter =
  /** The writer's clock file names this file: its stamps date each value, up to the file's watermark. */
  | {kind: "clock"; stamps: StudioDocumentClockState["stamps"]; watermark: string}
  /** No clock names this file: its modification time bounds every value in it. */
  | {kind: "time"; watermark: string}
  /** Nothing dates the file: its values win, and entities it lacks are kept. */
  | {kind: "unknown"};

export type StudioExternalMerge = {
  /** Null when the incoming entities are the result unchanged. */
  entities: StudioProjectEntities | null;
  /** Local fields or entities kept over the incoming file's values. */
  kept: number;
  /** Deleted entities the incoming file still contained. */
  dropped: number;
};

/**
 * Merge a whole-file copy from another writer into this device's accepted
 * state, field by field. The newer stamp wins; prose both sides changed since
 * their common base combines with diff3. An entity the file lacks is deleted
 * when a tombstone says so, kept when this device created it after the file
 * was written or the writer never knew it, and otherwise deleted by the file.
 * Updates `clock` with the stamps of adopted values and new tombstones.
 */
export function mergeStudioExternalEntities(options: {
  local: StudioProjectEntities;
  incoming: StudioProjectEntities;
  clock: StudioDocumentClockState;
  tombstones: Record<string, string>;
  writer: StudioIncomingWriter;
  pending: ReadonlyMap<string, StudioPendingBase>;
  now: () => string;
}): StudioExternalMerge {
  const {local, incoming, clock, tombstones, writer, pending, now} = options;
  const merged = copy(incoming);
  let kept = 0, dropped = 0;
  // The stamp an incoming value carries. A writer stamp newer than its file belongs to a later file.
  const incomingStamp = (key: string, leaf?: Leaf): string => {
    if (writer.kind === "unknown") return "\uffff";
    if (writer.kind === "time") return writer.watermark;
    const stamp = leaf ? leafStamp(writer.stamps, key, leaf) : presence(writer.stamps, key);
    return stamp > writer.watermark ? writer.watermark : stamp;
  };
  for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
    const mine = local[key], theirs = incoming[key];
    if (mine && theirs) {
      const a = leaves(mine), b = leaves(theirs);
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        const leaf = (a.get(id) || b.get(id))!.leaf, ours = a.get(id)?.value, other = b.get(id)?.value;
        if (canonical(ours) === canonical(other)) continue;
        const ourStamp = leafStamp(clock.stamps, key, leaf), theirStamp = incomingStamp(key, leaf);
        const base = pending.get(pendingKey(key, leaf));
        // Both sides changed prose since their common value: combine separate changes.
        if (base && typeof base.value === "string" && typeof ours === "string" && typeof other === "string" && ours !== base.value && other !== base.value
          && theirStamp > base.stamp && isStudioProseFieldPath(leaf.sub ?? leaf.top)) {
          const text = mergeStudioText(base.value, ours, other);
          if (text !== null) { setLeaf(merged[key], leaf, text); setLeafStamp(clock.stamps, key, leaf, now()); kept++; continue; }
        }
        if (ourStamp > theirStamp) { setLeaf(merged[key], leaf, ours); kept++; }
        else if (writer.kind !== "unknown") setLeafStamp(clock.stamps, key, leaf, theirStamp);
      }
    } else if (mine) {
      const created = presence(clock.stamps, key), tombstone = tombstones[key];
      const keep = tombstone && tombstone > created ? false
        : writer.kind === "unknown" ? true
        : writer.kind === "time" ? newestOf(clock.stamps, key) > writer.watermark
        : created > writer.watermark || (!!created && !writer.stamps[key]);
      if (keep) { merged[key] = copy(mine); kept++; }
      else { clock.deleted[key] = now(); delete clock.stamps[key]; }
    } else if (theirs) {
      const tombstone = tombstones[key];
      if (tombstone && !(incomingStamp(key) > tombstone && writer.kind === "clock")) { delete merged[key]; dropped++; continue; }
      if (writer.kind === "clock" && writer.stamps[key]) clock.stamps[key] = copy(writer.stamps[key]);
      else if (writer.kind === "time") clock.stamps[key] = Object.assign(Object.create(null), {"": writer.watermark});
      delete clock.deleted[key];
    }
  }
  return {entities: canonical(merged) === canonical(incoming) ? null : merged, kept, dropped};
}

export { canonical as canonicalStudioEntities };
