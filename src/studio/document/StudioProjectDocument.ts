import type { DataAdapter } from "obsidian";
import { isLegacyStudioProjectText, parseAndMigrateStudioProject, parseStudioProject, serializeStudioProject } from "../schema";
import { assertValidStudioProjectAgentDocumentStructure } from "../StudioProjectAgentDocumentValidation";
import { validateStudioProjectForAgentEdit } from "../StudioProjectAgentContract";
import type { StudioProjectV1 } from "../types";
import type { StudioProjectReconciliation } from "../StudioProjectReconciliation";
import { resolveStudioEntry, type StudioEntryResolution } from "../StudioEntry";
import { deriveStudioAssetsDir, deriveStudioPolicyPath } from "../paths";
import { RETIRED_STUDIO_NODE_KINDS } from "../StudioGraphMigrations";
import { entitiesToProject, projectToEntities } from "./StudioProjectEntities";
import { StudioCollaborationScope, releaseStudioCollaboration, createStudioCollaboration, loadStudioCollaboration, serializeStudioCollaboration, studioCollaborationEntities, mergeStudioCollaboration, changeStudioCollaboration, studioCollaborationAt, type StudioCollaborativeState } from "./StudioCollaborativeDocument";
import { writeStudioDocumentAtomically } from "./StudioDocumentAtomicWrite";

type Accepted = {state: StudioCollaborativeState; template: StudioProjectV1};
const accepted = new WeakMap<object, Map<string, Accepted>>();
const tails = new WeakMap<object, Map<string, Promise<unknown>>>();
export type StudioDocumentEdit = {entityId: string; kind?: "set" | "create" | "delete" | "restore"; path?: string[]; value?: unknown; remove?: boolean};
/** The untouched bytes of a pre-v2 file, kept before Studio first republishes it as v2. */
export type StudioLegacyOriginalCopy = Readonly<{projectPath: string; copyPath: string; retiredNodes: readonly Readonly<{title: string; kind: string}>[]}>;
const LEGACY_ORIGINAL_SUFFIX = "-v1-original.json";
class StudioWriteRace extends Error {}

/** One file and one shared mutation service. The canvas and merge state travel together. */
export class StudioProjectDocument {
  private readonly cache: Map<string, Accepted>;
  constructor(private readonly adapter: DataAdapter, private readonly path: string, private readonly onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void) {
    let cache = accepted.get(adapter); if (!cache) {cache = new Map(); accepted.set(adapter, cache);} this.cache = cache;
  }
  async forget(): Promise<void> {
    await this.exclusive(async () => {
    const old = this.cache.get(this.path); if (old) releaseStudioCollaboration(old.state);
    this.cache.delete(this.path);
    });
  }
  private remember(next: Accepted): void {
    const previous = this.cache.get(this.path);
    this.cache.set(this.path, next);
    if (previous && previous.state !== next.state) releaseStudioCollaboration(previous.state);
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
  /** Every write replaces the resolved file; an older dialect first keeps its original bytes. */
  private async publish(entry: StudioEntryResolution, next: string): Promise<boolean> {
    if (next !== entry.raw && isLegacyStudioProjectText(entry.raw) && !await this.keepLegacyOriginal(entry)) return false;
    return writeStudioDocumentAtomically(this.adapter, entry.path, entry.raw, next);
  }
  /** Migration retires node kinds and drops their configuration, so the v1 bytes are copied once per distinct original. */
  private async keepLegacyOriginal(entry: StudioEntryResolution): Promise<boolean> {
    const original = await this.adapter.readBinary(entry.path), bytes = new Uint8Array(original);
    // Copy only the bytes that were imported; a concurrent writer makes the caller retry.
    if (await this.adapter.read(entry.path) !== entry.raw) return false;
    const folder = `${deriveStudioAssetsDir(this.path)}/legacy`;
    if (await this.adapter.exists(folder)) {
      for (const file of (await this.adapter.list(folder)).files) {
        if (!file.endsWith(LEGACY_ORIGINAL_SUFFIX)) continue;
        const kept = new Uint8Array(await this.adapter.readBinary(file));
        if (kept.length === bytes.length && kept.every((byte, index) => byte === bytes[index])) return true;
      }
    }
    let current = "";
    for (const part of folder.split("/")) { current = current ? `${current}/${part}` : part; if (!await this.adapter.exists(current)) { try { await this.adapter.mkdir(current); } catch (error) { if (!await this.adapter.exists(current)) throw error; } } }
    // JSON, not .systemsculpt: the copy must never be listed, opened, or migrated as a project itself.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let copyPath = `${folder}/${stamp}${LEGACY_ORIGINAL_SUFFIX}`;
    for (let suffix = 2; await this.adapter.exists(copyPath); suffix++) copyPath = `${folder}/${stamp}-${suffix}${LEGACY_ORIGINAL_SUFFIX}`;
    await this.adapter.writeBinary(copyPath, original);
    const retiredNodes = parseStudioProject(entry.raw).graph.nodes.filter(node => RETIRED_STUDIO_NODE_KINDS.has(node.kind)).map(node => ({title: node.title.trim() || node.kind, kind: node.kind}));
    this.onLegacyOriginalCopied?.({projectPath: this.path, copyPath, retiredNodes});
    return true;
  }
  private project(value: Accepted): StudioProjectV1 {
    return entitiesToProject(studioCollaborationEntities(value.state), value.template, serializeStudioCollaboration(value.state));
  }
  private async import(raw: string): Promise<Accepted> {
    assertValidStudioProjectAgentDocumentStructure(JSON.parse(raw));
    // Older dialects migrate before validation: retired v1 node kinds only compile once rewritten.
    const candidate = parseAndMigrateStudioProject(raw, {projectPath: this.path});
    // Grants belong to the file's own location; an authored reference cannot select another project's policy.
    candidate.permissionsRef = {...candidate.permissionsRef, policyPath: deriveStudioPolicyPath(this.path)};
    validateStudioProjectForAgentEdit(candidate);
    const previous = this.cache.get(this.path);
    if (previous && previous.template.projectId !== candidate.projectId) throw new Error("The edited file belongs to another Studio project.");
    const scope = new StudioCollaborationScope();
    try {
      const basis = candidate.document
        ? scope.own(await loadStudioCollaboration(candidate.document, candidate.projectId))
        : previous?.state || scope.own(await createStudioCollaboration(candidate.projectId, projectToEntities(candidate)));
      const changed = scope.own(changeStudioCollaboration(basis, studioCollaborationEntities(basis), projectToEntities(candidate)));
      const state = previous ? scope.own(mergeStudioCollaboration(previous.state, changed)) : changed;
      const next = {state, template: candidate};
      validateStudioProjectForAgentEdit(this.project(next));
      this.remember(next); scope.retain(state);
      return next;
    } finally { scope.close(); }
  }
  async refresh(raw?: string): Promise<StudioProjectReconciliation> {
    return this.exclusive(async () => {
      const entry = await resolveStudioEntry(this.adapter, this.path);
      let value: Accepted;
      try { value = await this.import(raw ?? entry.raw); }
      catch (error) {
        const previous = this.cache.get(this.path);
        if (!previous) throw new Error(`Studio couldn't read this project file: ${error instanceof Error ? error.message : String(error)}`);
        return {project: this.project(previous), conflicts: ["Studio is waiting for a complete valid file edit. Your open document remains intact."]};
      }
      // Import any newer bytes too; a delayed watcher event cannot roll back state.
      if (raw !== undefined && raw !== entry.raw) {
        try { value = await this.import(entry.raw); } catch { return {project: this.project(value), conflicts: ["Studio is waiting for a complete valid file edit."]}; }
      }
      const project = this.project(value);
      if (!await this.publish(entry, serializeStudioProject(project))) throw new StudioWriteRace("Studio file changed during reconciliation; the edit remains pending.");
      return {project, conflicts: []};
    });
  }
  async save(project: StudioProjectV1, options?: {onBeforeProjectWrite?: (raw: string) => void; baseProject?: StudioProjectV1; restoreDeletedEntities?: boolean}): Promise<StudioProjectReconciliation> {
    // A save carries canvas intent; reconnecting previously removed ports is allowed here, not on import.
    return this.exclusive(async () => {
      const entry = await resolveStudioEntry(this.adapter, this.path);
      const current = await this.import(entry.raw);
      const scope = new StudioCollaborationScope();
      try {
      const base = options?.baseProject || project;
      const basis = project.document ? scope.own(await loadStudioCollaboration(project.document, project.projectId)) : current.state;
      const before = project.document ? studioCollaborationEntities(basis) : options?.baseProject ? projectToEntities(base) : studioCollaborationEntities(basis);
      const changed = scope.own(changeStudioCollaboration(basis, before, projectToEntities(project), {restoreDeletedEntities: options?.restoreDeletedEntities, reconnectProjections: true}));
      const next = {state: scope.own(mergeStudioCollaboration(current.state, changed)), template: current.template};
      const saved = this.project(next);
      validateStudioProjectForAgentEdit(saved);
      const text = serializeStudioProject(saved);
      options?.onBeforeProjectWrite?.(text);
      const wrote = await this.publish(entry, text);
      if (!wrote) { throw new StudioWriteRace("Another writer changed the Studio file; your edit is still pending and will be rebased on retry."); }
      this.remember(next); scope.retain(next.state);
      return {project: saved, conflicts: []};
      } finally { scope.close(); }
    });
  }
  /** Agent edits are scoped and serialized with UI writes; never replace the file yourself. */
  async edit(heads: string[], edits: StudioDocumentEdit[]): Promise<StudioProjectReconciliation> {
    return this.exclusive(async () => {
      const entry = await resolveStudioEntry(this.adapter, this.path);
      const current = await this.import(entry.raw);
      const scope = new StudioCollaborationScope();
      try {
      const basis = scope.own(studioCollaborationAt(current.state, heads));
      const before = studioCollaborationEntities(basis);
      const after = JSON.parse(JSON.stringify(before)) as typeof before;
      if (!Array.isArray(edits) || edits.length > 1000) throw new Error("Provide at most 1,000 scoped edits.");
      let restoreDeletedEntities = false;
      for (const edit of edits) {
        if (!edit || typeof edit.entityId !== "string" || ["__proto__", "constructor", "prototype"].includes(edit.entityId)) throw new Error("Invalid Studio entity ID.");
        if (edit.kind === "delete") { if (edit.entityId === "project") throw new Error("Cannot delete project identity."); delete after[edit.entityId]; continue; }
        if (edit.kind === "create" || edit.kind === "restore") {
          if (edit.kind === "create" && basis.entities[edit.entityId]) throw new Error("This entity ID is already used; choose a new ID or explicitly restore it.");
          if (after[edit.entityId]) throw new Error("An entity with this ID already exists.");
          if (!edit.value || typeof edit.value !== "object" || Array.isArray(edit.value)) throw new Error("Provide an entity object.");
          after[edit.entityId] = JSON.parse(JSON.stringify(edit.value));
          restoreDeletedEntities ||= edit.kind === "restore";
          continue;
        }
        if (edit.kind && edit.kind !== "set") throw new Error("Unknown Studio edit kind.");
        if (!Array.isArray(edit.path) || !edit.path.every(key => typeof key === "string")) throw new Error("Provide a field path.");
        if (!after[edit.entityId] || !edit.path.length || edit.path.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Invalid Studio entity field edit.");
        let target: Record<string, unknown> = after[edit.entityId];
        for (const key of edit.path.slice(0, -1)) {
          const child = target[key];
          if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("Field path must address an existing object.");
          target = child as Record<string, unknown>;
        }
        const key = edit.path[edit.path.length - 1];
        if (edit.remove) delete target[key]; else target[key] = edit.value;
      }
      const changed = scope.own(changeStudioCollaboration(basis, before, after, {restoreDeletedEntities}));
      const state = scope.own(mergeStudioCollaboration(current.state, changed));
      const next = {state, template: current.template};
      const project = this.project(next);
      validateStudioProjectForAgentEdit(project);
      if (!await this.publish(entry, serializeStudioProject(project))) { throw new StudioWriteRace("Studio file changed during the edit; retry with the same revision and edits."); }
      this.remember(next); scope.retain(state);
      return {project, conflicts: []};
      } finally { scope.close(); }
    });
  }
}
