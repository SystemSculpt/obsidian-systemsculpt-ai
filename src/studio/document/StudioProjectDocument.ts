import type { DataAdapter } from "obsidian";
import { parseAndMigrateStudioProject, parseStudioProject, serializeStudioProject } from "../schema";
import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";
import { validateStudioProjectForAgentEdit } from "../StudioProjectAgentContract";
import type { StudioProjectV1 } from "../types";
import { reconcileStudioProject, type StudioProjectReconciliation } from "../StudioProjectReconciliation";
import { cloneStudioProjectSnapshot } from "../StudioProjectSnapshots";
import { resolveStudioEntry, type StudioEntryResolution } from "../StudioEntry";
import { deriveStudioAssetsDir, deriveStudioPolicyPath } from "../paths";
import { RETIRED_STUDIO_NODE_KINDS } from "../StudioGraphMigrations";
import { sha256HexFromArrayBuffer } from "../../utils/sha256";
import { entitiesToProject, projectToEntities, type StudioProjectEntities } from "./StudioProjectEntities";
import {
  cloneStudioClock, emptyStudioClock, isStudioClockCurrent, mergeStudioExternalEntities, mergeStudioTombstones, newestStudioClockStamp,
  parseStudioClock, pruneStudioClock, recordStudioChanges, serializeStudioClock, studioStamp,
  type StudioDocumentClockState, type StudioHybridClock, type StudioIncomingWriter, type StudioPendingBase,
} from "./StudioDocumentClock";
import { writeStudioDocumentAtomically } from "./StudioDocumentAtomicWrite";

type Accepted = {
  /** The file bytes this state was imported from or published as. */
  source: string;
  /** Canonical v2 text of `project`; its SHA-256 is the agent revision. */
  text: string;
  project: StudioProjectV1;
  entities: StudioProjectEntities;
  /** This device's stamps for the accepted values, all known tombstones, and its file watermarks. */
  clock: StudioDocumentClockState;
  /** This device's clock file as last read or written; null before it exists. */
  stored: string | null;
  /** Values this device changed since the last external merge, as they were before: the diff3 base. */
  pending: Map<string, StudioPendingBase>;
  /** `source` is a pre-v2 dialect or embeds 6.10 merge state; its first rewrite keeps a backup. */
  legacy: boolean;
  documentState: boolean;
  /** The import combined this device's content with the file's, so the file must be rewritten. */
  rewrite: boolean;
  /** Notices from the import that produced this state, reported once. */
  warnings: string[];
};
const accepted = new WeakMap<object, Map<string, Accepted>>();
const revisions = new WeakMap<object, Map<string, Map<string, string>>>();
const tails = new WeakMap<object, Map<string, Promise<unknown>>>();
/** Recent agent revisions stay resolvable; the newest is always kept. */
const MAX_REVISIONS = 16, MAX_REVISION_CHARS = 4_000_000;
export type StudioDocumentEdit = {entityId: string; kind?: "set" | "create" | "delete" | "restore"; path?: string[]; value?: unknown; remove?: boolean};
export type StudioDocumentEditResult = StudioProjectReconciliation & {revision: string};
/** The untouched bytes of an older file, kept before Studio first republishes it as plain v2. */
export type StudioLegacyOriginalCopy = Readonly<{projectPath: string; copyPath: string; retiredNodes: readonly Readonly<{title: string; kind: string}>[]}>;
const LEGACY_ORIGINAL_SUFFIX = "-v1-original.json";
const DOCUMENT_STATE_ORIGINAL_SUFFIX = "-document-state-original.json";
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];
class StudioWriteRace extends Error {}

/** An agent revision: the SHA-256 of the canonical document text. */
export async function studioDocumentRevision(text: string): Promise<string> {
  return sha256HexFromArrayBuffer(new TextEncoder().encode(text).buffer);
}

/** Each device writes only its own clock file, so synchronization never makes two devices overwrite one. */
export function studioClockFolder(projectPath: string): string {
  return `${deriveStudioAssetsDir(projectPath)}/clock`;
}
export function studioClockPath(projectPath: string, device: string): string {
  return `${studioClockFolder(projectPath)}/${device}.json`;
}

/**
 * One readable file and one shared mutation service. UI saves and agent edits
 * merge by entity and field against the state each was based on. A whole-file
 * copy from another writer merges field by field by hybrid-clock stamps kept
 * in small per-device clock files beside the project; deletions leave only
 * keys there, so a stale copy cannot bring a deleted entity back.
 */
export class StudioProjectDocument {
  private readonly cache: Map<string, Accepted>;
  private readonly clock: StudioHybridClock;
  private readonly onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void;
  constructor(private readonly adapter: DataAdapter, private readonly path: string, options: {clock: StudioHybridClock; onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void}) {
    let cache = accepted.get(adapter); if (!cache) {cache = new Map(); accepted.set(adapter, cache);} this.cache = cache;
    this.clock = options.clock;
    this.onLegacyOriginalCopied = options.onLegacyOriginalCopied;
  }
  async forget(): Promise<void> {
    await this.exclusive(async () => { this.cache.delete(this.path); });
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let paths = tails.get(this.adapter); if (!paths) {paths = new Map(); tails.set(this.adapter, paths);}
    const queues = paths;
    // An entry file and its linked projection publish the same physical document: queue on that path.
    const run = async (): Promise<T> => {
      let key = this.path;
      try { key = (await resolveStudioEntry(this.adapter, this.path)).path; } catch { /* Missing files queue on their own path. */ }
      const task = (queues.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
        for (let attempt = 0; ; attempt++) {
          try { return await operation(); } catch (error) { if (!(error instanceof StudioWriteRace) || attempt >= 7) throw error; }
        }
      });
      queues.set(key, task);
      return task.finally(() => {if (queues.get(key) === task) queues.delete(key);});
    };
    return run();
  }
  private revisions(): Map<string, string> {
    let paths = revisions.get(this.adapter); if (!paths) {paths = new Map(); revisions.set(this.adapter, paths);}
    let texts = paths.get(this.path); if (!texts) {texts = new Map(); paths.set(this.path, texts);}
    return texts;
  }
  /** Revisions handed to agents stay resolvable while recently used. */
  private async handOut(text: string): Promise<string> {
    const revision = await studioDocumentRevision(text), texts = this.revisions();
    texts.delete(revision); texts.set(revision, text);
    let chars = 0;
    for (const kept of texts.values()) chars += kept.length;
    for (const [oldest, kept] of texts) {
      if (texts.size <= 1 || (texts.size <= MAX_REVISIONS && chars <= MAX_REVISION_CHARS)) break;
      texts.delete(oldest); chars -= kept.length;
    }
    return revision;
  }
  private revisionText(revision: string): string | undefined {
    const texts = this.revisions(), text = texts.get(revision);
    if (text !== undefined) { texts.delete(revision); texts.set(revision, text); }
    return text;
  }
  /** Every write replaces the resolved file; an older format first keeps its original bytes. */
  private async publish(entry: StudioEntryResolution, value: Accepted, next: string): Promise<boolean> {
    if (next !== entry.raw) {
      if (value.legacy && !await this.keepOriginal(entry, LEGACY_ORIGINAL_SUFFIX)) return false;
      if (value.documentState && !await this.keepOriginal(entry, DOCUMENT_STATE_ORIGINAL_SUFFIX)) return false;
    }
    return writeStudioDocumentAtomically(this.adapter, entry.path, entry.raw, next);
  }
  /**
   * v1 migration retires node kinds and drops their configuration, so its bytes are copied once per
   * distinct original. Dropping 6.10 merge state loses only history (the readable canvas is the
   * content), so the first such file of a project is copied once.
   */
  private async keepOriginal(entry: StudioEntryResolution, suffix: string): Promise<boolean> {
    const original = await this.adapter.readBinary(entry.path), bytes = new Uint8Array(original);
    // Copy only the bytes that were imported; a concurrent writer makes the caller retry.
    if (await this.adapter.read(entry.path) !== entry.raw) return false;
    const folder = `${deriveStudioAssetsDir(this.path)}/legacy`;
    if (await this.adapter.exists(folder)) {
      for (const file of (await this.adapter.list(folder)).files) {
        if (!file.endsWith(suffix)) continue;
        if (suffix === DOCUMENT_STATE_ORIGINAL_SUFFIX) return true;
        const kept = new Uint8Array(await this.adapter.readBinary(file));
        if (kept.length === bytes.length && kept.every((byte, index) => byte === bytes[index])) return true;
      }
    }
    await this.ensureFolder(folder);
    // JSON, not .systemsculpt: the copy must never be listed, opened, or migrated as a project itself.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let copyPath = `${folder}/${stamp}${suffix}`;
    for (let index = 2; await this.adapter.exists(copyPath); index++) copyPath = `${folder}/${stamp}-${index}${suffix}`;
    await this.adapter.writeBinary(copyPath, original);
    const retiredNodes = suffix === LEGACY_ORIGINAL_SUFFIX
      ? parseStudioProject(entry.raw).graph.nodes.filter(node => RETIRED_STUDIO_NODE_KINDS.has(node.kind)).map(node => ({title: node.title.trim() || node.kind, kind: node.kind}))
      : [];
    this.onLegacyOriginalCopied?.({projectPath: this.path, copyPath, retiredNodes});
    return true;
  }
  private async ensureFolder(folder: string): Promise<void> {
    let current = "";
    for (const part of folder.split("/")) { current = current ? `${current}/${part}` : part; if (!await this.adapter.exists(current)) { try { await this.adapter.mkdir(current); } catch (error) { if (!await this.adapter.exists(current)) throw error; } } }
  }
  private async readOwnClock(): Promise<{clock: StudioDocumentClockState; stored: string | null}> {
    try {
      const path = studioClockPath(this.path, this.clock.device);
      if (!await this.adapter.exists(path)) return {clock: emptyStudioClock(), stored: null};
      const raw = await this.adapter.read(path), parsed = parseStudioClock(raw);
      if (!parsed || parsed.device !== this.clock.device) return {clock: emptyStudioClock(), stored: null};
      this.clock.observe(newestStudioClockStamp(parsed.clock));
      return {clock: parsed.clock, stored: raw};
    } catch { return {clock: emptyStudioClock(), stored: null}; }
  }
  /** Other devices' clocks; one that is unreadable or abandoned only removes merge information. */
  private async readOtherClocks(): Promise<StudioDocumentClockState[]> {
    const folder = studioClockFolder(this.path), clocks: StudioDocumentClockState[] = [];
    try {
      if (!await this.adapter.exists(folder)) return clocks;
      for (const file of (await this.adapter.list(folder)).files) {
        if (!file.startsWith(`${folder}/`) || !file.endsWith(".json") || file === studioClockPath(this.path, this.clock.device)) continue;
        try {
          const parsed = parseStudioClock(await this.adapter.read(file));
          if (!parsed || file !== studioClockPath(this.path, parsed.device) || !isStudioClockCurrent(parsed.clock, this.clock.wallNow())) continue;
          this.clock.observe(newestStudioClockStamp(parsed.clock));
          clocks.push(parsed.clock);
        } catch { /* A clock still arriving is read with the next change. */ }
      }
    } catch { /* No clocks: the file's modification time dates its values. */ }
    return clocks;
  }
  private async modified(path: string): Promise<number | null> {
    try { const stat = await this.adapter.stat(path); return stat && Number.isFinite(stat.mtime) && stat.mtime > 0 ? stat.mtime : null; }
    catch { return null; }
  }
  /** Written before the file it describes: a published value, deletion or restore always has its record. */
  private async storeClock(value: Accepted): Promise<void> {
    const text = serializeStudioClock(this.clock.device, value.clock);
    if (text === value.stored) return;
    const {stamps, deleted, files} = value.clock;
    if (value.stored === null && !Object.keys(stamps).length && !Object.keys(deleted).length && !Object.keys(files).length) return;
    await this.ensureFolder(studioClockFolder(this.path));
    await this.adapter.write(studioClockPath(this.path, this.clock.device), text);
    value.stored = text;
  }
  /** The accepted state that follows `from` once `project` is published as `text`, with this device's changes stamped. */
  private async successor(from: Accepted, project: StudioProjectV1, text: string): Promise<Accepted> {
    const entities = projectToEntities(project), clock = cloneStudioClock(from.clock), now = () => this.clock.now();
    recordStudioChanges(clock, from.entities, entities, now, from.pending);
    clock.files[await studioDocumentRevision(text)] = now();
    pruneStudioClock(clock, new Set(Object.keys(entities)), this.clock.wallNow());
    // Notices from an import that a save or edit consumed are reported by the next refresh.
    return {source: text, text, project, entities, clock, stored: from.stored, pending: from.pending, legacy: false, documentState: false, rewrite: false, warnings: from.warnings};
  }
  /** Adopt authored content onto the file's runtime fields in the canonical form a reopen yields. */
  private canonical(template: StudioProjectV1, content: StudioProjectV1): {project: StudioProjectV1; text: string} {
    const text = serializeStudioProject(content), parsed = parseStudioProject(text);
    const project = {...template, name: parsed.name, graph: parsed.graph, diagram: parsed.diagram};
    validateStudioProjectForAgentEdit(project);
    return {project, text};
  }
  /**
   * Accept file bytes this device did not just write. With the state this device accepted before,
   * that state and the file merge field by field (mergeStudioExternalEntities); the file's values
   * are dated by the clock of the device that wrote it, or else by its modification time.
   */
  private async import(raw: string, filePath: string): Promise<Accepted> {
    const previous = this.cache.get(this.path);
    if (previous && previous.source === raw) return previous;
    const parsed: unknown = JSON.parse(raw);
    assertValidStudioProjectAgentDocumentStructure(parsed);
    // Older dialects migrate before validation: retired v1 node kinds only compile once rewritten.
    const candidate = parseAndMigrateStudioProject(raw, {projectPath: this.path});
    // Grants belong to the file's own location; an authored reference cannot select another project's policy.
    candidate.permissionsRef = {...candidate.permissionsRef, policyPath: deriveStudioPolicyPath(this.path)};
    validateStudioProjectForAgentEdit(candidate);
    if (previous && previous.project.projectId !== candidate.projectId) throw new Error("The edited file belongs to another Studio project.");
    const own = previous ? {clock: previous.clock, stored: previous.stored} : await this.readOwnClock();
    let clock = cloneStudioClock(own.clock);
    const others = await this.readOtherClocks();
    for (const other of others) clock.deleted = mergeStudioTombstones(clock.deleted, other.deleted);
    const hash = await studioDocumentRevision(raw);
    const writerClock = own.clock.files[hash] ? own.clock : others.find(other => other.files[hash]);
    const modified = writerClock ? null : await this.modified(filePath);
    const writer: StudioIncomingWriter = writerClock ? {kind: "clock", stamps: writerClock.stamps, watermark: writerClock.files[hash]}
      : modified !== null ? {kind: "time", watermark: studioStamp(modified)} : {kind: "unknown"};
    const warnings: string[] = [];
    // Without its content in memory, this device can only notice that a copy predates its own changes.
    const ownNewest = newestStudioClockStamp(own.clock);
    if (!previous && writer.kind !== "unknown" && ownNewest > writer.watermark) {
      warnings.push("This copy of the project is older than changes made on this device while Studio was closed. Those changes may be missing.");
    }
    const unmerged = cloneStudioClock(clock);
    const merge = mergeStudioExternalEntities({
      local: previous?.entities || Object.create(null), incoming: projectToEntities(candidate), clock, tombstones: clock.deleted,
      writer, pending: previous?.pending || new Map(), now: () => this.clock.now(),
    });
    let result = {...candidate} as StudioProjectV1, rewrite = false;
    if (merge.entities) {
      try { result = this.canonical(candidate, entitiesToProject(merge.entities, candidate)).project; rewrite = true; }
      catch {
        clock = unmerged;
        warnings.push("Studio could not combine this device's changes with a copy of this file from elsewhere and kept the file's version.");
      }
    }
    if (rewrite && previous && writer.kind !== "clock" && merge.kept) {
      warnings.push(`Studio kept ${merge.kept === 1 ? "1 newer change" : `${merge.kept} newer changes`} from this device that a copy of this file from elsewhere did not include.`);
    }
    if (rewrite && merge.dropped) warnings.push(`Studio left out ${merge.dropped === 1 ? "1 deleted item" : `${merge.dropped} deleted items`} that an older copy of this file still contained. Use Undo to bring back a deletion.`);
    const {project, text} = this.canonical(candidate, result);
    const entities = projectToEntities(project);
    pruneStudioClock(clock, new Set(Object.keys(entities)), this.clock.wallNow());
    const record = parsed as Record<string, unknown>;
    const legacy = String(record.schema ?? "").trim() !== "studio.project.v2";
    const next: Accepted = {
      source: raw, text, project, entities, clock, stored: own.stored, pending: new Map(), rewrite, warnings,
      legacy, documentState: !legacy && Object.prototype.hasOwnProperty.call(record, "document"),
    };
    this.cache.set(this.path, next);
    return next;
  }
  /** Publish `text` as the next accepted state of `value`: its watermark and clock first, then the file. */
  private async republish(entry: StudioEntryResolution, value: Accepted, text: string): Promise<Accepted> {
    const clock = cloneStudioClock(value.clock);
    clock.files[await studioDocumentRevision(text)] = this.clock.now();
    pruneStudioClock(clock, new Set(Object.keys(value.entities)), this.clock.wallNow());
    const next: Accepted = {...value, source: text, clock, legacy: false, documentState: false, rewrite: false, warnings: []};
    await this.storeClock(next);
    if (!await this.publish(entry, value, text)) throw new StudioWriteRace("Studio file changed during reconciliation; the edit remains pending.");
    this.cache.set(this.path, next);
    return next;
  }
  private async refreshLocked(): Promise<{value: Accepted; conflicts: string[]}> {
    // The file itself is imported, never an older watcher copy of it: a delayed event cannot roll back state.
    const entry = await resolveStudioEntry(this.adapter, this.path);
    let value: Accepted;
    try { value = await this.import(entry.raw, entry.path); }
    catch (error) {
      const previous = this.cache.get(this.path);
      if (!previous) throw new Error(`Studio couldn't read this project file: ${error instanceof Error ? error.message : String(error)}`);
      return {value: previous, conflicts: ["Studio is waiting for a complete valid file edit. Your open document remains intact."]};
    }
    const warnings = value.warnings;
    value.warnings = [];
    // Older dialects are upgraded at once, and a merge is published so the other writer receives it.
    // Formatting and 6.10 merge state alone are only rewritten by the next edit, so a device still
    // running 6.10 cannot trade rewrites with this one.
    if (value.text !== entry.raw && (value.legacy || value.rewrite)) value = await this.republish(entry, value, value.text);
    else {
      // Merge information only: an unwritable clock must not keep the canvas from opening.
      try { await this.storeClock(value); } catch { /* Retried by the next write. */ }
    }
    return {value, conflicts: warnings};
  }
  async refresh(): Promise<StudioProjectReconciliation> {
    return this.exclusive(async () => {
      const {value, conflicts} = await this.refreshLocked();
      return {project: cloneStudioProjectSnapshot(value.project), conflicts};
    });
  }
  /** The current document and its agent revision. */
  async read(): Promise<StudioProjectReconciliation & {revision: string}> {
    return this.exclusive(async () => {
      const {value, conflicts} = await this.refreshLocked();
      return {project: cloneStudioProjectSnapshot(value.project), conflicts, revision: await this.handOut(value.text)};
    });
  }
  /**
   * A save carries canvas intent against `baseProject`, the file state the session last accepted.
   * Changes made to the file since then merge by entity and field; a field changed on both sides
   * keeps the file's value and is reported, so the session preserves its own version.
   */
  async save(project: StudioProjectV1, options?: {onBeforeProjectWrite?: (raw: string) => void; baseProject?: StudioProjectV1}): Promise<StudioProjectReconciliation> {
    return this.exclusive(async () => {
      const entry = await resolveStudioEntry(this.adapter, this.path);
      const current = await this.import(entry.raw, entry.path);
      const base = options?.baseProject;
      const merged = !base || serializeStudioProject(base) === current.text
        ? {project, conflicts: [] as string[]}
        : reconcileStudioProject(base, project, current.project);
      const {project: saved, text} = this.canonical(current.project, merged.project);
      const next = await this.successor(current, saved, text);
      await this.storeClock(next);
      options?.onBeforeProjectWrite?.(text);
      if (!await this.publish(entry, current, text)) throw new StudioWriteRace("Another writer changed the Studio file; your edit is still pending and will be rebased on retry.");
      this.cache.set(this.path, next);
      return {project: cloneStudioProjectSnapshot(saved), conflicts: merged.conflicts};
    });
  }
  /**
   * Agent edits are scoped and serialized with UI writes; never replace the file yourself. The batch
   * applies to the revision the agent read. Changes made since then merge by entity and field; a
   * conflict with one of them rejects the whole batch so the agent can read again.
   */
  async edit(revision: string, edits: StudioDocumentEdit[]): Promise<StudioDocumentEditResult> {
    return this.exclusive(async () => {
      const entry = await resolveStudioEntry(this.adapter, this.path);
      const current = await this.import(entry.raw, entry.path);
      const latest = revision === await studioDocumentRevision(current.text);
      const basisText = latest ? current.text : this.revisionText(revision);
      if (basisText === undefined) throw new Error("This Studio revision is no longer available. Read the document again and retry.");
      const basis = latest ? current.project : parseStudioProject(basisText);
      if (!Array.isArray(edits) || edits.length > 1000) throw new Error("Provide at most 1,000 scoped edits.");
      const before = projectToEntities(basis);
      const after = applyStudioDocumentEdits(before, edits, current.clock.deleted);
      const candidate = entitiesToProject(after, current.project);
      let content = candidate;
      if (!latest) {
        const merged = reconcileStudioProject(basis, candidate, current.project);
        if (merged.conflicts.length) throw new Error(`Studio changed ${merged.conflicts.join(", ")} after this revision. Read the document again and retry.`);
        content = merged.project;
      }
      const {project, text} = this.canonical(current.project, content);
      const next = await this.successor(current, project, text);
      await this.storeClock(next);
      if (!await this.publish(entry, current, text)) throw new StudioWriteRace("Studio file changed during the edit; retry with the same revision and edits.");
      this.cache.set(this.path, next);
      return {project: cloneStudioProjectSnapshot(project), conflicts: [], revision: await this.handOut(text)};
    });
  }
}

function applyStudioDocumentEdits(before: StudioProjectEntities, edits: StudioDocumentEdit[], tombstones: Record<string, string>): StudioProjectEntities {
  const after = JSON.parse(JSON.stringify(before)) as StudioProjectEntities;
  for (const edit of edits) {
    if (!edit || typeof edit.entityId !== "string" || RESERVED_KEYS.includes(edit.entityId)) throw new Error("Invalid Studio entity ID.");
    if (edit.kind === "delete") { if (edit.entityId === "project") throw new Error("Cannot delete project identity."); delete after[edit.entityId]; continue; }
    if (edit.kind === "create" || edit.kind === "restore") {
      if (edit.kind === "create" && (before[edit.entityId] || tombstones[edit.entityId] !== undefined)) throw new Error("This entity ID is already used; choose a new ID or explicitly restore it.");
      if (after[edit.entityId]) throw new Error("An entity with this ID already exists.");
      if (!edit.value || typeof edit.value !== "object" || Array.isArray(edit.value)) throw new Error("Provide an entity object.");
      after[edit.entityId] = JSON.parse(JSON.stringify(edit.value));
      continue;
    }
    if (edit.kind && edit.kind !== "set") throw new Error("Unknown Studio edit kind.");
    if (!Array.isArray(edit.path) || !edit.path.every(key => typeof key === "string")) throw new Error("Provide a field path.");
    if (!after[edit.entityId] || !edit.path.length || edit.path.some(key => RESERVED_KEYS.includes(key))) throw new Error("Invalid Studio entity field edit.");
    let target: Record<string, unknown> = after[edit.entityId];
    for (const key of edit.path.slice(0, -1)) {
      const child = target[key];
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("Field path must address an existing object.");
      target = child as Record<string, unknown>;
    }
    const key = edit.path[edit.path.length - 1];
    if (edit.remove) delete target[key]; else target[key] = edit.value;
  }
  return after;
}
