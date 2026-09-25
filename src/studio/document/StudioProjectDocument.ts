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
import { entitiesToProject, projectToEntities, studioEntityKeys, type StudioProjectEntities } from "./StudioProjectEntities";
import { mergeStudioTombstones, parseStudioTombstones, sameStudioTombstones, serializeStudioTombstones, updateStudioTombstones, type StudioTombstones } from "./StudioProjectTombstones";
import { writeStudioDocumentAtomically } from "./StudioDocumentAtomicWrite";

type Accepted = {
  /** The file bytes this state was imported from or published as. */
  source: string;
  /** Canonical v2 text of `project`; its SHA-256 is the agent revision. */
  text: string;
  project: StudioProjectV1;
  keys: ReadonlySet<string>;
  tombstones: StudioTombstones;
  /** The sidecar content last read or written; null before the first read. */
  stored: StudioTombstones | null;
  /** `source` is a pre-v2 dialect or embeds 6.10 merge state; its first rewrite keeps a backup. */
  legacy: boolean;
  documentState: boolean;
  /** Stale copies of deleted entities this import left out; the file must be rewritten. */
  dropped: number;
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

export function studioTombstonesPath(projectPath: string): string {
  return `${deriveStudioAssetsDir(projectPath)}/tombstones.json`;
}

/**
 * One readable file and one shared mutation service. UI saves, agent edits and
 * external replacements merge by entity and field against the state each was
 * based on; deletions leave only keys in a small sidecar so a stale copy of the
 * file cannot bring a deleted entity back.
 */
export class StudioProjectDocument {
  private readonly cache: Map<string, Accepted>;
  constructor(private readonly adapter: DataAdapter, private readonly path: string, private readonly onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void) {
    let cache = accepted.get(adapter); if (!cache) {cache = new Map(); accepted.set(adapter, cache);} this.cache = cache;
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
  private async readTombstones(): Promise<StudioTombstones> {
    const path = studioTombstonesPath(this.path);
    try { return await this.adapter.exists(path) ? parseStudioTombstones(await this.adapter.read(path)) : Object.create(null); }
    catch { return Object.create(null); }
  }
  /** Written before the file it protects, so a published deletion or restore is never without its record. */
  private async storeTombstones(value: Accepted): Promise<void> {
    if (sameStudioTombstones(value.tombstones, value.stored || {})) return;
    const path = studioTombstonesPath(this.path);
    await this.ensureFolder(deriveStudioAssetsDir(this.path));
    await this.adapter.write(path, serializeStudioTombstones(value.tombstones));
    value.stored = value.tombstones;
  }
  /** The accepted state that follows `from` once `project` is published as `text`. */
  private successor(from: Accepted, project: StudioProjectV1, text: string): Accepted {
    const keys = studioEntityKeys(project);
    return {source: text, text, project, keys, tombstones: updateStudioTombstones(from.tombstones, from.keys, keys, Date.now()), stored: from.stored, legacy: false, documentState: false, dropped: 0};
  }
  /** Adopt authored content onto the file's runtime fields in the canonical form a reopen yields. */
  private canonical(template: StudioProjectV1, content: StudioProjectV1): {project: StudioProjectV1; text: string} {
    const text = serializeStudioProject(content), parsed = parseStudioProject(text);
    const project = {...template, name: parsed.name, graph: parsed.graph, diagram: parsed.diagram};
    validateStudioProjectForAgentEdit(project);
    return {project, text};
  }
  private async import(raw: string): Promise<Accepted> {
    const previous = this.cache.get(this.path);
    if (previous && previous.source === raw) return previous;
    const parsed: unknown = JSON.parse(raw);
    assertValidStudioProjectAgentDocumentStructure(parsed);
    // Older dialects migrate before validation: retired v1 node kinds only compile once rewritten.
    let candidate = parseAndMigrateStudioProject(raw, {projectPath: this.path});
    // Grants belong to the file's own location; an authored reference cannot select another project's policy.
    candidate.permissionsRef = {...candidate.permissionsRef, policyPath: deriveStudioPolicyPath(this.path)};
    validateStudioProjectForAgentEdit(candidate);
    if (previous && previous.project.projectId !== candidate.projectId) throw new Error("The edited file belongs to another Studio project.");
    const stored = await this.readTombstones();
    const tombstones = mergeStudioTombstones(previous?.tombstones || Object.create(null), stored);
    // Only Studio's own Undo or restore brings a deleted entity back; a stale copy of the file cannot.
    const stale = [...studioEntityKeys(candidate)].filter(key => tombstones[key] !== undefined && !previous?.keys.has(key));
    if (stale.length) {
      const entities = projectToEntities(candidate);
      for (const key of stale) delete entities[key];
      candidate = entitiesToProject(entities, candidate);
    }
    const {project, text} = this.canonical(candidate, candidate);
    const keys = studioEntityKeys(project);
    const record = parsed as Record<string, unknown>;
    const legacy = String(record.schema ?? "").trim() !== "studio.project.v2";
    const next: Accepted = {
      source: raw, text, project, keys, stored,
      tombstones: updateStudioTombstones(tombstones, previous ? previous.keys : null, keys, Date.now()),
      legacy, documentState: !legacy && Object.prototype.hasOwnProperty.call(record, "document"), dropped: stale.length,
    };
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
    // Protection only: an unwritable sidecar must not keep the canvas from opening.
    try { await this.storeTombstones(value); } catch { /* Retried by the next write. */ }
    // Older dialects are upgraded at once. Formatting and 6.10 merge state are only rewritten by the
    // next edit, so a device still running 6.10 cannot trade rewrites with this one.
    const dropped = value.dropped;
    if (value.text !== entry.raw && (value.legacy || dropped)) {
      if (!await this.publish(entry, value, value.text)) throw new StudioWriteRace("Studio file changed during reconciliation; the edit remains pending.");
      value = {...value, source: value.text, legacy: false, documentState: false, dropped: 0};
      this.cache.set(this.path, value);
    }
    return {value, conflicts: dropped ? [`Studio left out ${dropped === 1 ? "1 deleted item" : `${dropped} deleted items`} that an older copy of this file still contained. Use Undo to bring back a deletion.`] : []};
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
      const current = await this.import(entry.raw);
      const base = options?.baseProject;
      const merged = !base || serializeStudioProject(base) === current.text
        ? {project, conflicts: [] as string[]}
        : reconcileStudioProject(base, project, current.project);
      const {project: saved, text} = this.canonical(current.project, merged.project);
      const next = this.successor(current, saved, text);
      await this.storeTombstones(next);
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
      const current = await this.import(entry.raw);
      const latest = revision === await studioDocumentRevision(current.text);
      const basisText = latest ? current.text : this.revisionText(revision);
      if (basisText === undefined) throw new Error("This Studio revision is no longer available. Read the document again and retry.");
      const basis = latest ? current.project : parseStudioProject(basisText);
      if (!Array.isArray(edits) || edits.length > 1000) throw new Error("Provide at most 1,000 scoped edits.");
      const before = projectToEntities(basis);
      const after = applyStudioDocumentEdits(before, edits, current.tombstones);
      const candidate = entitiesToProject(after, current.project);
      let content = candidate;
      if (!latest) {
        const merged = reconcileStudioProject(basis, candidate, current.project);
        if (merged.conflicts.length) throw new Error(`Studio changed ${merged.conflicts.join(", ")} after this revision. Read the document again and retry.`);
        content = merged.project;
      }
      const {project, text} = this.canonical(current.project, content);
      const next = this.successor(current, project, text);
      await this.storeTombstones(next);
      if (!await this.publish(entry, current, text)) throw new StudioWriteRace("Studio file changed during the edit; retry with the same revision and edits.");
      this.cache.set(this.path, next);
      return {project: cloneStudioProjectSnapshot(project), conflicts: [], revision: await this.handOut(text)};
    });
  }
}

function applyStudioDocumentEdits(before: StudioProjectEntities, edits: StudioDocumentEdit[], tombstones: StudioTombstones): StudioProjectEntities {
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
