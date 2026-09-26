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
  cloneStudioClock, emptyStudioClock, mergeStudioExternalEntities, mergeStudioTombstones, newestStudioClockStamp,
  pruneStudioClock, readStudioMergeBlock, recordStudioChanges, studioMergeBlock,
  type StudioDocumentClockState, type StudioHybridClock, type StudioPendingBase,
} from "./StudioDocumentClock";
import { writeStudioDocumentAtomically } from "./StudioDocumentAtomicWrite";

type Accepted = {
  /** The file bytes this state was imported from or published as. */
  source: string;
  /** Canonical v2 text of `project`, without the merge record; its SHA-256 is the agent revision. */
  text: string;
  project: StudioProjectV1;
  entities: StudioProjectEntities;
  /** Stamps for the accepted values and every tombstone known here. */
  clock: StudioDocumentClockState;
  /** The merge record's `at` in the file this state came from or was published as; "" when it had none. */
  at: string;
  /** Values this device changed since it last merged another writer's file, as they were before: the diff3 base. */
  pending: Map<string, StudioPendingBase>;
  /** `source` is a pre-v2 dialect or embeds 6.10 merge state; its first rewrite keeps a backup. */
  legacy: boolean;
  documentState: boolean;
  /** The import changed the file's content or its merge record, so the file must be rewritten. */
  rewrite: boolean;
};
const accepted = new WeakMap<object, Map<string, Accepted>>();
const revisions = new WeakMap<object, Map<string, Map<string, string>>>();
const tails = new WeakMap<object, Map<string, Promise<unknown>>>();
/** Recent agent revisions stay resolvable; the newest is always kept. */
const MAX_REVISIONS = 16, MAX_REVISION_CHARS = 4_000_000;
export type StudioDocumentEdit = {entityId: string; kind?: "set" | "create" | "delete" | "restore"; path?: string[]; value?: unknown; remove?: boolean};
/** Accepted content and its exact published bytes belong to the same file version. */
export type StudioDocumentReconciliation = StudioProjectReconciliation & {source: string};
export type StudioDocumentEditResult = StudioDocumentReconciliation & {revision: string};
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

/**
 * One readable file and one shared mutation service. UI saves and agent edits
 * merge by entity and field against the state each was based on. Every
 * published file carries a `merge` record: the hybrid-clock stamps of its
 * recently changed fields and its deletion tombstones. A whole-file copy from
 * another device is merged field by field by the stamps it carries, so it can
 * neither revert newer edits here nor delete entities its writer never saw.
 */
export class StudioProjectDocument {
  private readonly cache: Map<string, Accepted>;
  private readonly clock: StudioHybridClock;
  private readonly onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void;
  /** Reported the moment a merge is accepted, whichever path read the file. */
  private readonly onMergeNotice?: (projectPath: string, message: string) => void;
  constructor(private readonly adapter: DataAdapter, private readonly path: string, options: {
    clock: StudioHybridClock;
    onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void;
    onMergeNotice?: (projectPath: string, message: string) => void;
  }) {
    let cache = accepted.get(adapter); if (!cache) {cache = new Map(); accepted.set(adapter, cache);} this.cache = cache;
    this.clock = options.clock;
    this.onLegacyOriginalCopied = options.onLegacyOriginalCopied;
    this.onMergeNotice = options.onMergeNotice;
  }
  async forget(): Promise<void> {
    await this.exclusive(async () => {
      this.cache.delete(this.path);
      revisions.get(this.adapter)?.delete(this.path);
    });
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
  /** The bytes that publish `project`: its canonical canvas, then the merge record other devices read. */
  private async bytes(project: StudioProjectV1, text: string, clock: StudioDocumentClockState, at: string): Promise<string> {
    return serializeStudioProject(project, studioMergeBlock(clock, at, await studioDocumentRevision(text)));
  }
  /** The accepted state that follows `from` once `project` is published, with this device's changes stamped. */
  private async successor(from: Accepted, project: StudioProjectV1, text: string): Promise<Accepted> {
    const entities = projectToEntities(project), clock = cloneStudioClock(from.clock), now = () => this.clock.now();
    // A compare-and-swap retry must start from accepted history, not this tentative edit.
    const pending = new Map(from.pending);
    recordStudioChanges(clock, from.entities, entities, now, pending);
    pruneStudioClock(clock, new Set(Object.keys(entities)), this.clock.wallNow());
    const at = now();
    return {source: await this.bytes(project, text, clock, at), text, project, entities, clock, at, pending, legacy: false, documentState: false, rewrite: false};
  }
  /** Adopt authored content onto the file's runtime fields in the canonical form a reopen yields. */
  private canonical(template: StudioProjectV1, content: StudioProjectV1): {project: StudioProjectV1; text: string} {
    const text = serializeStudioProject(content), parsed = parseStudioProject(text);
    const project = {...template, name: parsed.name, graph: parsed.graph, diagram: parsed.diagram};
    validateStudioProjectForAgentEdit(project);
    return {project, text};
  }
  /**
   * Accept file bytes this device did not just write. Against the state this device accepted before:
   * - a publication from any device merges field by field by the stamps its merge record carries;
   * - that publication, or a file without a merge record, edited outside Studio's merge (an agent's
   *   file tools, a text editor) is this device's own edit, deletions included;
   * - a file from SystemSculpt 6.10 carries no stamps, so whatever this device dated stays.
   */
  private async import(raw: string): Promise<Accepted> {
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
    const record = parsed as Record<string, unknown>;
    const legacy = String(record.schema ?? "").trim() !== "studio.project.v2";
    const documentState = !legacy && Object.prototype.hasOwnProperty.call(record, "document");
    const block = legacy ? null : readStudioMergeBlock(record.merge);
    if (block) { this.clock.observe(block.at); this.clock.observe(newestStudioClockStamp(block)); }
    const incoming = projectToEntities(candidate);
    const notices: string[] = [];
    let clock: StudioDocumentClockState, merged: StudioProjectEntities | null = null, rewrite = false;
    let pending = new Map<string, StudioPendingBase>();
    if (!previous) {
      // The first read here: the file is what this device has.
      clock = block ? cloneStudioClock(block) : emptyStudioClock();
    } else if (block ? block.at === previous.at : !documentState) {
      // The publication this device accepted, or a file without a merge record, edited outside Studio's merge
      // (an agent's file tools, a text editor): its differences are this device's edits, deletions included.
      // They are stamped here and published with the next save, so the editor's file is not rewritten under it.
      clock = cloneStudioClock(previous.clock);
      pending = previous.pending;
      recordStudioChanges(clock, previous.entities, incoming, () => this.clock.now(), pending);
    } else {
      clock = cloneStudioClock(previous.clock);
      if (block) clock.deleted = mergeStudioTombstones(clock.deleted, block.deleted);
      const merge = mergeStudioExternalEntities({
        local: previous.entities, incoming, clock, tombstones: clock.deleted,
        writer: block ? {kind: "stamped", stamps: block.stamps, at: block.at} : {kind: "undated"},
        pending: previous.pending, now: () => this.clock.now(),
      });
      merged = merge.entities;
      if (!block && merge.kept) {
        notices.push(`SystemSculpt 6.10 on another device changed this project. Studio kept ${merge.kept === 1 ? "1 change" : `${merge.kept} changes`} made on this device; update SystemSculpt on every device.`);
      }
      if (merged && merge.dropped) notices.push(`Studio left out ${merge.dropped === 1 ? "1 deleted item" : `${merge.dropped} deleted items`} that an older copy of this file still contained. Use Undo to bring back a deletion.`);
    }
    let result = candidate;
    if (merged) {
      try { result = this.canonical(candidate, entitiesToProject(merged, candidate)).project; rewrite = true; }
      catch {
        clock = block ? cloneStudioClock(block) : cloneStudioClock(previous!.clock);
        notices.push("Studio could not combine this device's changes with a copy of this file from elsewhere and kept the file's version.");
      }
    }
    const {project, text} = this.canonical(candidate, result);
    const entities = projectToEntities(project);
    pruneStudioClock(clock, new Set(Object.keys(entities)), this.clock.wallNow());
    if (previous && block && block.at !== previous.at) {
      // A merge can retain a deletion or a newer stamp without changing the incoming canvas.
      // Publish that knowledge in the same file so it survives restart and reaches other devices.
      rewrite ||= JSON.stringify(studioMergeBlock(clock, block.at, block.canvas)) !== JSON.stringify(studioMergeBlock(block, block.at, block.canvas));
    }
    const next: Accepted = {source: raw, text, project, entities, clock, at: block?.at ?? "", pending, rewrite, legacy, documentState};
    this.cache.set(this.path, next);
    for (const notice of notices) this.onMergeNotice?.(this.path, notice);
    return next;
  }
  /** Publish `value` with a fresh merge record, so other devices receive what this device accepted. */
  private async republish(entry: StudioEntryResolution, value: Accepted): Promise<Accepted> {
    const at = this.clock.now();
    const next: Accepted = {...value, source: await this.bytes(value.project, value.text, value.clock, at), at, legacy: false, documentState: false, rewrite: false};
    if (!await this.publish(entry, value, next.source)) throw new StudioWriteRace("Studio file changed during reconciliation; the edit remains pending.");
    this.cache.set(this.path, next);
    return next;
  }
  private async refreshLocked(): Promise<{value: Accepted; conflicts: string[]}> {
    // The file itself is imported, never an older watcher copy of it: a delayed event cannot roll back state.
    const entry = await resolveStudioEntry(this.adapter, this.path);
    let value: Accepted;
    try { value = await this.import(entry.raw); }
    catch (error) {
      const previous = this.cache.get(this.path);
      if (!previous) throw new Error(`Studio couldn't read this project file: ${error instanceof Error ? error.message : String(error)}`);
      return {value: previous, conflicts: ["Studio is waiting for a complete valid file edit. Your open document remains intact."]};
    }
    // Older dialects are upgraded at once, and a merge is published so the other writer receives it.
    // Formatting and 6.10 merge state alone are only rewritten by the next edit.
    if (value.legacy || value.rewrite) value = await this.republish(entry, value);
    return {value, conflicts: []};
  }
  async refresh(): Promise<StudioDocumentReconciliation> {
    return this.exclusive(async () => {
      const {value, conflicts} = await this.refreshLocked();
      return {project: cloneStudioProjectSnapshot(value.project), conflicts, source: value.source};
    });
  }
  /** The file bytes of the current document, as a watcher reports them. */
  async source(): Promise<string> {
    return this.exclusive(async () => (await this.refreshLocked()).value.source);
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
      const current = await this.import(entry.raw);
      const base = options?.baseProject;
      const merged = !base || serializeStudioProject(base) === current.text
        ? {project, conflicts: [] as string[]}
        : reconcileStudioProject(base, project, current.project);
      const {project: saved, text} = this.canonical(current.project, merged.project);
      const next = await this.successor(current, saved, text);
      options?.onBeforeProjectWrite?.(next.source);
      if (!await this.publish(entry, current, next.source)) throw new StudioWriteRace("Another writer changed the Studio file; your edit is still pending and will be rebased on retry.");
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
      const current = await this.import(entry.raw);
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
      if (!await this.publish(entry, current, next.source)) throw new StudioWriteRace("Studio file changed during the edit; retry with the same revision and edits.");
      this.cache.set(this.path, next);
      return {project: cloneStudioProjectSnapshot(project), conflicts: [], source: next.source, revision: await this.handOut(text)};
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
