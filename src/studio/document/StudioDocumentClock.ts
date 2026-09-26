import type { StudioProjectEntities } from "./StudioProjectEntities";
import { isStudioProseFieldPath, mergeStudioText } from "./StudioTextMerge";

/**
 * Hybrid logical clock stamps: wall milliseconds, a counter, then the device
 * ID, each fixed width, so plain string order is causal-then-wall order. The
 * empty string is older than every stamp and marks an unknown or pruned time.
 */
const WALL_DIGITS = 9, COUNTER_DIGITS = 4, MAX_COUNTER = 36 ** COUNTER_DIGITS - 1;
export const STUDIO_MERGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 1000, MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const NESTED_FIELDS = new Set(["config", "nodes", "shapes"]);
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STAMP = "[0-9a-z]{13}[0-9a-z_-]{0,32}";
const STAMP_PATTERN = new RegExp(`^${STAMP}$`);
/** A field's stamp and, after "/", the stamp of the value it replaced. */
const FIELD_STAMP_PATTERN = new RegExp(`^${STAMP}(/${STAMP})?$`);

export function studioStamp(wall: number, counter = 0, device = ""): string {
  return `${Math.max(0, Math.floor(wall)).toString(36).padStart(WALL_DIGITS, "0")}${counter.toString(36).padStart(COUNTER_DIGITS, "0")}${device}`;
}
const stampWall = (stamp: string): number => stamp ? parseInt(stamp.slice(0, WALL_DIGITS), 36) : 0;
const later = (left: string, right: string): string => left > right ? left : right;
/** The stamp of a field entry, without the stamp of the value it replaced. */
const stampOf = (entry: string | undefined): string => entry ? entry.split("/", 1)[0] : "";

export class StudioHybridClock {
  private wall = 0;
  private counter = 0;
  constructor(readonly device: string, private readonly time: () => number = Date.now) {}
  wallNow(): number { return this.time(); }
  now(): string {
    const time = this.time();
    if (time > this.wall) { this.wall = time; this.counter = 0; } else this.counter++;
    // The counter has a fixed width so string order stays clock order: past it, the clock moves on a millisecond.
    if (this.counter > MAX_COUNTER) { this.wall++; this.counter = 0; }
    return studioStamp(this.wall, this.counter, this.device);
  }
  /** Stamps seen from other devices order this device's later stamps after them. */
  observe(stamp: string): void {
    const wall = stampWall(stamp), counter = parseInt(stamp.slice(WALL_DIGITS, WALL_DIGITS + COUNTER_DIGITS), 36);
    if (!Number.isFinite(wall) || !Number.isFinite(counter) || wall > this.time() + MAX_FUTURE_MS) return;
    if (wall > this.wall || (wall === this.wall && counter > this.counter)) { this.wall = wall; this.counter = counter; }
  }
}

/**
 * Per entity key: "" is when it was created or restored; other keys stamp its
 * fields, each as "stamp" or "stamp/replaced", where `replaced` stamps the
 * value that change replaced.
 */
export type StudioEntityStamps = Record<string, string | Record<string, string>>;
export type StudioDocumentClockState = {
  stamps: Record<string, StudioEntityStamps>;
  /** Entity key to deletion stamp. */
  deleted: Record<string, string>;
};
/**
 * The merge record a published file carries: when it was written, the agent
 * revision of its canvas, and the stamps and tombstones its writer knew then.
 */
export type StudioMergeBlock = StudioDocumentClockState & {at: string; canvas: string};

export function emptyStudioClock(): StudioDocumentClockState {
  return {stamps: Object.create(null), deleted: Object.create(null)};
}

const isStamp = (value: unknown): value is string => typeof value === "string" && STAMP_PATTERN.test(value);
function stampMap(value: unknown, pattern: RegExp, accept: (key: string) => boolean = () => true): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  if (!record(value)) return map;
  for (const [key, item] of Object.entries(value)) if (!RESERVED_KEYS.has(key) && typeof item === "string" && pattern.test(item) && accept(key)) map[key] = item;
  return map;
}

/** A damaged or foreign merge record only removes merge information; it never blocks opening the canvas. */
export function readStudioMergeBlock(value: unknown): StudioMergeBlock | null {
  if (!record(value) || !isStamp(value.at) || typeof value.canvas !== "string" || !/^[0-9a-f]{64}$/.test(value.canvas)) return null;
  const block: StudioMergeBlock = {...emptyStudioClock(), at: value.at, canvas: value.canvas};
  block.deleted = stampMap(value.deleted, STAMP_PATTERN, key => key.includes(":"));
  if (record(value.stamps)) {
    for (const [key, fields] of Object.entries(value.stamps)) {
      if (RESERVED_KEYS.has(key) || !key.includes(":") && key !== "project" || !record(fields)) continue;
      const entity: StudioEntityStamps = Object.create(null);
      for (const [field, entry] of Object.entries(fields)) {
        if (RESERVED_KEYS.has(field)) continue;
        if (field === "" ? isStamp(entry) : typeof entry === "string" && FIELD_STAMP_PATTERN.test(entry)) entity[field] = entry as string;
        else if (NESTED_FIELDS.has(field)) entity[field] = stampMap(entry, FIELD_STAMP_PATTERN);
      }
      block.stamps[key] = entity;
    }
  }
  return block;
}

/** The merge record for a file this device publishes, with keys sorted so equal state writes equal bytes. */
export function studioMergeBlock(clock: StudioDocumentClockState, at: string, canvas: string): StudioMergeBlock {
  const sorted = <T>(value: T): T => (record(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
    : value) as T;
  return {at, canvas, stamps: sorted(clock.stamps), deleted: sorted(clock.deleted)};
}

export function cloneStudioClock(clock: StudioDocumentClockState): StudioDocumentClockState {
  const revive = (_key: string, value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.assign(Object.create(null), value) : value;
  return {stamps: JSON.parse(JSON.stringify(clock.stamps), revive), deleted: JSON.parse(JSON.stringify(clock.deleted), revive)};
}

/** The newest stamp a clock carries. */
export function newestStudioClockStamp(clock: StudioDocumentClockState): string {
  let newest = "";
  for (const stamp of Object.values(clock.deleted)) newest = later(newest, stamp);
  for (const key of Object.keys(clock.stamps)) newest = later(newest, newestOf(clock.stamps, key));
  return newest;
}

/** Tombstones from both sides; the later deletion time wins. */
export function mergeStudioTombstones(left: Record<string, string>, right: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = Object.assign(Object.create(null), left);
  for (const [key, stamp] of Object.entries(right)) merged[key] = later(merged[key] || "", stamp);
  return merged;
}

/**
 * Keep the record small: stamps and tombstones expire by age, stamps of
 * entities no longer present go with them, and tombstones keep the newest 1,000.
 */
export function pruneStudioClock(clock: StudioDocumentClockState, present: ReadonlySet<string>, nowWall: number): void {
  const expired = (entry: string) => nowWall - stampWall(stampOf(entry)) > STUDIO_MERGE_RETENTION_MS;
  for (const [key, fields] of Object.entries(clock.stamps)) {
    if (!present.has(key)) { delete clock.stamps[key]; continue; }
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === "string") { if (expired(value)) delete fields[field]; continue; }
      for (const [sub, entry] of Object.entries(value)) if (expired(entry)) delete value[sub];
      if (!Object.keys(value).length) delete fields[field];
    }
    if (!Object.keys(fields).length) delete clock.stamps[key];
  }
  for (const [key, stamp] of Object.entries(clock.deleted)) if (present.has(key) || expired(stamp)) delete clock.deleted[key];
  const tombstones = Object.keys(clock.deleted).sort((a, b) => clock.deleted[b].localeCompare(clock.deleted[a]));
  for (const key of tombstones.slice(MAX_TOMBSTONES)) delete clock.deleted[key];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Entity = StudioProjectEntities[string];
type Leaf = {top: string; sub?: string};

const canonical = (value: unknown): string => value === undefined ? "\u0000" : JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
function record(value: unknown): value is Record<string, Json> { return !!value && typeof value === "object" && !Array.isArray(value); }

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
/** A field's own entry ("stamp" or "stamp/replaced"), if it has one. */
function fieldEntry(stamps: StudioDocumentClockState["stamps"], key: string, leaf: Leaf): string | undefined {
  const value = stamps[key]?.[leaf.top];
  return leaf.sub === undefined ? (typeof value === "string" ? value : undefined) : (value && typeof value === "object" ? value[leaf.sub] : undefined);
}
/** When a field's value was set: its own stamp, or else when its entity was created. */
function leafStamp(stamps: StudioDocumentClockState["stamps"], key: string, leaf: Leaf): string {
  return stampOf(fieldEntry(stamps, key, leaf)) || presence(stamps, key);
}
/** The stamp of the value a field's latest change replaced; "" when it replaced an undated value. */
function replacedStamp(stamps: StudioDocumentClockState["stamps"], key: string, leaf: Leaf): string {
  const entry = fieldEntry(stamps, key, leaf) || "", slash = entry.indexOf("/");
  return slash < 0 ? "" : entry.slice(slash + 1);
}
function setLeafStamp(stamps: StudioDocumentClockState["stamps"], key: string, leaf: Leaf, entry: string): void {
  const fields = stamps[key] ||= Object.create(null) as StudioEntityStamps;
  if (leaf.sub === undefined) { fields[leaf.top] = entry; return; }
  const nested = fields[leaf.top];
  (nested && typeof nested === "object" ? nested : (fields[leaf.top] = Object.create(null) as Record<string, string>))[leaf.sub] = entry;
}
function newestOf(stamps: StudioDocumentClockState["stamps"], key: string): string {
  let newest = "";
  for (const value of Object.values(stamps[key] || {})) {
    if (typeof value === "string") newest = later(newest, stampOf(value)); else for (const entry of Object.values(value)) newest = later(newest, stampOf(entry));
  }
  return newest;
}

/**
 * A field this device changed since the last merge of another device's file,
 * as it was before: the common base for diff3, with the stamp of that value.
 */
export type StudioPendingBase = {value: Json | undefined; stamp: string};
const pendingKey = (key: string, leaf: Leaf) => `${key}\u0000${leaf.top}\u0000${leaf.sub ?? ""}`;

/**
 * Stamp what this device changed between two accepted states: new or restored
 * entities, changed fields, and deletions. Each changed field also records the
 * stamp of the value it replaced, and its first change since the last merge
 * remembers the prior value for diff3.
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
      const replaced = stampOf(fieldEntry(clock.stamps, key, leaf));
      const slot = pendingKey(key, leaf);
      if (!pending.has(slot)) pending.set(slot, {value: copy(previous.get(id)?.value), stamp: replaced});
      setLeafStamp(clock.stamps, key, leaf, replaced ? `${now()}/${replaced}` : now());
    }
  }
}

/** Who wrote an incoming file, and so how its values are dated. */
export type StudioIncomingWriter =
  /** A published file's merge record: its stamps date each value as its writer knew it. */
  | {kind: "stamped"; stamps: StudioDocumentClockState["stamps"]; at: string}
  /** A file from SystemSculpt 6.10, which dates nothing: whatever this device dated stays. */
  | {kind: "undated"};

export type StudioExternalMerge = {
  /** Null when the incoming entities are the result unchanged. */
  entities: StudioProjectEntities | null;
  /** Local fields or entities kept over the incoming file's values. */
  kept: number;
  /** Deleted entities the incoming file still contained. */
  dropped: number;
};

/**
 * Merge another writer's file into this device's accepted state, field by
 * field. The newer stamp wins. When this device changed a field back to its
 * earlier value, the other change stands; when both sides changed the same
 * earlier value of a prose field, separate changes combine with diff3.
 *
 * Every deletion leaves a tombstone, so an entity the file lacks is deleted
 * only when a tombstone newer than its creation says so; otherwise the file was
 * written before its writer knew the entity. An entity only the file has is
 * dropped when a tombstone is newer than its writer's creation or restore stamp.
 * Updates `clock` with the stamps of adopted values and the tombstones applied.
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
  for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
    const mine = local[key], theirs = incoming[key];
    if (mine && theirs) {
      const a = leaves(mine), b = leaves(theirs);
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        const leaf = (a.get(id) || b.get(id))!.leaf, ours = a.get(id)?.value, other = b.get(id)?.value;
        if (canonical(ours) === canonical(other)) continue;
        if (writer.kind === "undated") {
          if (fieldEntry(clock.stamps, key, leaf)) { setLeaf(merged[key], leaf, ours); kept++; }
          continue;
        }
        const theirEntry = fieldEntry(writer.stamps, key, leaf) || presence(writer.stamps, key);
        const base = pending.get(pendingKey(key, leaf));
        // Changed and changed back here: the other side's change stands.
        if (base && canonical(ours) === canonical(base.value)) { if (theirEntry) setLeafStamp(clock.stamps, key, leaf, theirEntry); continue; }
        // Both sides changed the same earlier value of prose: combine separate changes.
        if (base && typeof base.value === "string" && typeof ours === "string" && typeof other === "string" && other !== base.value
          && replacedStamp(writer.stamps, key, leaf) === base.stamp && isStudioProseFieldPath(leaf.sub ?? leaf.top)) {
          const text = mergeStudioText(base.value, ours, other);
          if (text !== null) { setLeaf(merged[key], leaf, text); setLeafStamp(clock.stamps, key, leaf, `${now()}/${stampOf(theirEntry)}`); kept++; continue; }
        }
        if (leafStamp(clock.stamps, key, leaf) > stampOf(theirEntry)) { setLeaf(merged[key], leaf, ours); kept++; }
        else if (theirEntry) setLeafStamp(clock.stamps, key, leaf, theirEntry);
      }
    } else if (mine) {
      if (writer.kind === "undated") { merged[key] = copy(mine); kept++; continue; }
      const tombstone = tombstones[key];
      if (!tombstone || tombstone <= presence(clock.stamps, key)) { merged[key] = copy(mine); kept++; continue; }
      // The deletion keeps its own time, so a later restore on any device still wins.
      clock.deleted[key] = later(clock.deleted[key] || "", tombstone);
      delete clock.stamps[key];
    } else if (theirs) {
      const tombstone = tombstones[key];
      if (writer.kind === "undated") { if (tombstone) { delete merged[key]; dropped++; } continue; }
      if (tombstone && !(presence(writer.stamps, key) > tombstone)) { delete merged[key]; dropped++; continue; }
      if (writer.stamps[key]) clock.stamps[key] = copy(writer.stamps[key]);
      delete clock.deleted[key];
    }
  }
  return {entities: canonical(merged) === canonical(incoming) ? null : merged, kept, dropped};
}

export { canonical as canonicalStudioEntities };
