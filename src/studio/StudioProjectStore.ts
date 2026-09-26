import { requireApiVersion, type App } from "obsidian";
import type { StudioProjectV1, StudioPermissionPolicyV1 } from "./types";
import { createEmptyStudioProject, createDefaultStudioPolicy, parseStudioPolicy, serializeStudioPolicy, serializeStudioProject, parseStudioProject } from "./schema";
import { DEFAULT_STUDIO_PROJECTS_DIR, deriveStudioAssetsDir, deriveStudioPolicyPath, normalizeStudioProjectPath } from "./paths";
import { StudioProjectDocument, type StudioDocumentEdit, type StudioDocumentEditResult, type StudioDocumentReconciliation, type StudioLegacyOriginalCopy } from "./document/StudioProjectDocument";
import type { StudioProjectReconciliation } from "./StudioProjectReconciliation";
import { resolveStudioEntry } from "./StudioEntry";
import { reconcileStudioSupportDocument } from "./persistence/StudioSupportReconciliation";
import { StudioHybridClock } from "./document/StudioDocumentClock";

/** Immutable media bytes stored under the project's support tree by content hash. */
export type StudioAssetFile = { contentAddressedPath: string; bytes: Uint8Array };
/** Any other support file addressed relative to the project's support tree. */
export type StudioSupportFile = { supportRelativePath: string; bytes: Uint8Array };
/** One completed run: its snapshot, events, produced assets and the retained run index. */
export type StudioRunPublication = {
  projectId: string;
  runId: string;
  snapshotDocument: Uint8Array;
  eventsDocument: Uint8Array;
  runIndexDocument: Uint8Array;
  cacheDocument: Uint8Array;
  assets: readonly StudioAssetFile[];
  removeRunIds: readonly string[];
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const operations = new WeakMap<object, Map<string, Promise<unknown>>>();
const devices = new WeakMap<object, string>();
const clocks = new WeakMap<object, Map<string, StudioHybridClock>>();
const DEVICE_KEY = "systemsculpt-studio-device";

/**
 * A stable, device-local identity for this vault: it names the device's clock
 * file and breaks stamp ties. Vault-scoped local storage is not synchronized;
 * hosts without it use one identity per session.
 */
function studioDeviceId(app: App): string {
  const known = devices.get(app);
  if (known) return known;
  let device = "";
  // Vault-scoped local storage exists from Obsidian 1.8.7.
  try {
    if (requireApiVersion("1.8.7")) {
      const stored: unknown = app.loadLocalStorage(DEVICE_KEY);
      if (typeof stored === "string" && /^[0-9a-f]{12}$/.test(stored)) device = stored;
    }
  } catch { /* Unreadable storage: a new identity. */ }
  if (!device) {
    device = Array.from({length: 12}, () => Math.floor(Math.random() * 16).toString(16)).join("");
    try { if (requireApiVersion("1.8.7")) app.saveLocalStorage(DEVICE_KEY, device); } catch { /* A per-session identity still orders its own stamps. */ }
  }
  devices.set(app, device);
  return device;
}

/** One authored file; media and execution records are stored separately. */
export class StudioProjectStore {
  private readonly documents = new Map<string, StudioProjectDocument>();
  private readonly clock: StudioHybridClock;
  constructor(private readonly app: App, private readonly options: {
    onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void;
    /** A merge of another writer's file kept or left out work the user should know about. */
    onMergeNotice?: (projectPath: string, message: string) => void;
    deviceId?: string;
    now?: () => number;
  } = {}) {
    const device = options.deviceId || studioDeviceId(app), adapter = app.vault.adapter;
    let byDevice = clocks.get(adapter); if (!byDevice) {byDevice = new Map(); clocks.set(adapter, byDevice);}
    let clock = byDevice.get(device); if (!clock) {clock = new StudioHybridClock(device, options.now); byDevice.set(device, clock);}
    this.clock = clock;
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const adapter = this.app.vault.adapter;
    let pending = operations.get(adapter); if (!pending) {pending = new Map(); operations.set(adapter, pending);}
    const task = (pending.get(key) || Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(key, task);
    return task.finally(() => {if (pending.get(key) === task) pending.delete(key);});
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.documents.values()].map(document => document.forget()));
    this.documents.clear();
  }

  async releaseDocument(path: string): Promise<void> {
    path = normalizeStudioProjectPath(path);
    const document = this.documents.get(path);
    if (!document) return;
    await document.forget();
    if (this.documents.get(path) === document) this.documents.delete(path);
  }

  private document(path: string): StudioProjectDocument {
    path = normalizeStudioProjectPath(path);
    let document = this.documents.get(path);
    if (!document) {
      document = new StudioProjectDocument(this.app.vault.adapter, path, {clock: this.clock, onLegacyOriginalCopied: this.options.onLegacyOriginalCopied, onMergeNotice: this.options.onMergeNotice});
      this.documents.set(path, document);
    }
    return document;
  }

  async listProjects(): Promise<string[]> { return this.app.vault.getFiles().map(file => file.path).filter(path => path.endsWith(".systemsculpt")).sort(); }
  async createProject(options: {name: string; projectPath?: string; minPluginVersion: string; maxRuns: number; maxArtifactsMb: number}): Promise<{path: string; project: StudioProjectV1}> {
    return this.exclusive("create-project", async () => {
    const desired = normalizeStudioProjectPath(options.projectPath?.trim() || `${DEFAULT_STUDIO_PROJECTS_DIR}/${options.name.trim() || "Untitled"}.systemsculpt`);
    let path = desired;
    for (let suffix = 2; await this.app.vault.adapter.exists(path) || await this.app.vault.adapter.exists(deriveStudioAssetsDir(path)); suffix++) path = desired.replace(/\.systemsculpt$/i, ` (${suffix}).systemsculpt`);
    const project = createEmptyStudioProject({...options, policyPath: deriveStudioPolicyPath(path)});
    await this.document(path).forget();
    await this.write(path, encoder.encode(serializeStudioProject(project)), {exclusive: true});
    return {path, project: await this.loadProject(path)};
    });
  }
  async loadProject(path: string, _options?: {forceReload?: boolean}): Promise<StudioProjectV1> { return (await this.document(path).refresh()).project; }
  /** The file bytes as published, merge record included, so a watcher's event for them is recognized. */
  async readProjectRawText(path: string): Promise<string | null> { try { return await this.document(path).source(); } catch { return null; } }
  async readVisibleProjectRawText(path: string): Promise<string> { return (await resolveStudioEntry(this.app.vault.adapter, path)).raw; }
  async saveProject(path: string, project: StudioProjectV1, options?: {onBeforeProjectWrite?: (raw: string) => void; baseProject?: StudioProjectV1}): Promise<StudioProjectReconciliation> {
    return this.document(path).save(project, options);
  }
  async readDocument(path: string): Promise<StudioProjectReconciliation & {revision: string}> { return this.document(path).read(); }
  async editDocument(path: string, revision: string, edits: StudioDocumentEdit[]): Promise<StudioDocumentEditResult> { return this.document(path).edit(revision, edits); }
  async refreshDocument(path: string): Promise<StudioDocumentReconciliation> { return this.document(path).refresh(); }

  async renameProject(path: string, name: string, options?: {project?: StudioProjectV1}): Promise<{oldPath: string; newPath: string; project: StudioProjectV1}> {
    const oldPath = normalizeStudioProjectPath(path);
    const entry = await resolveStudioEntry(this.app.vault.adapter, oldPath);
    if (entry.entryRaw !== undefined) throw new Error("Rename this directory project through its connector configuration.");
    const slash = oldPath.lastIndexOf("/");
    const newPath = normalizeStudioProjectPath(`${slash < 0 ? "" : oldPath.slice(0, slash + 1)}${name}`);
    if (newPath !== oldPath && (await this.app.vault.adapter.exists(newPath) || await this.app.vault.adapter.exists(deriveStudioAssetsDir(newPath)))) throw new Error("A project already exists at that path.");
    const project = options?.project || await this.loadProject(oldPath);
    await this.saveProject(oldPath, { ...project, name });
    if (newPath !== oldPath) await this.app.vault.adapter.rename(oldPath, newPath);
    return this.adoptVisibleProjectRename({oldPath, newPath, movedRawText: await this.app.vault.adapter.read(newPath), project: {...project, name}});
  }
  async adoptVisibleProjectRename(options: {oldPath: string; newPath: string; movedRawText: string; project: StudioProjectV1}): Promise<{oldPath: string; newPath: string; project: StudioProjectV1}> {
    const {oldPath, newPath} = options;
    if (parseStudioProject(options.movedRawText).projectId !== options.project.projectId) throw new Error("The renamed Studio file has a different identity.");
    const oldRoot = deriveStudioAssetsDir(oldPath), newRoot = deriveStudioAssetsDir(newPath);
    if (oldRoot !== newRoot && await this.app.vault.adapter.exists(oldRoot)) {
      if (await this.app.vault.adapter.exists(newRoot)) throw new Error("The destination project support folder already exists.");
      await this.app.vault.adapter.rename(oldRoot, newRoot);
    }
    await this.documents.get(oldPath)?.forget();
    this.documents.delete(oldPath);
    const result = await this.saveProject(newPath, options.project);
    result.project.permissionsRef.policyPath = deriveStudioPolicyPath(newPath);
    return {oldPath, newPath, project: result.project};
  }

  async loadPolicy(path: string): Promise<StudioPermissionPolicyV1> { return await this.app.vault.adapter.exists(path) ? parseStudioPolicy(await this.app.vault.adapter.read(path)) : createDefaultStudioPolicy(); }
  async savePolicy(path: string, policy: StudioPermissionPolicyV1): Promise<void> { await this.write(path, encoder.encode(serializeStudioPolicy(policy))); }
  supportRelativePath(projectPath: string, path: string): string {
    const root = deriveStudioAssetsDir(projectPath);
    if (!path.startsWith(`${root}/`) || path.split("/").some(part => part === ".." || part === "." || !part) || path.includes("\\")) throw new Error("Path is outside the Studio project support tree.");
    return `support/${path.slice(root.length + 1)}`;
  }
  async readSupportFile(projectPath: string, path: string): Promise<Uint8Array | null> {
    this.supportRelativePath(projectPath, path);
    try { return new Uint8Array(await this.app.vault.adapter.readBinary(path)); }
    catch { return null; }
  }
  async readSupportFileByAbsolutePath(path: string): Promise<Uint8Array | null> {
    for (const projectPath of await this.listProjects()) if (path.startsWith(`${deriveStudioAssetsDir(projectPath)}/`)) return this.readSupportFile(projectPath, path);
    return null;
  }
  async restoreAssetFile(projectPath: string, path: string): Promise<boolean> {
    this.supportRelativePath(projectPath, path);
    if (await this.app.vault.adapter.exists(path)) return true;
    return false;
  }
  private async write(path: string, bytes: Uint8Array, options?: {exclusive?: boolean}): Promise<void> {
    const parts = path.split("/"); parts.pop(); let current = "";
    for (const part of parts) { current = current ? `${current}/${part}` : part; if (!await this.app.vault.adapter.exists(current)) { try { await this.app.vault.adapter.mkdir(current); } catch (error) { if (!await this.app.vault.adapter.exists(current)) throw error; } } }
    // Re-check immediately before publishing: a sync client may have created the destination meanwhile.
    if (options?.exclusive && await this.app.vault.adapter.exists(path)) throw new Error("A file appeared at the new Studio project path. Choose another name.");
    await this.app.vault.adapter.writeBinary(path, bytes.slice().buffer);
  }
  private supportPath(projectPath: string, relative: string): string {
    if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid Studio support path.");
    return `${deriveStudioAssetsDir(projectPath)}/${relative.replace(/^support\//, "")}`;
  }
  private async checkIdentity(path: string, id: string): Promise<void> { if ((await this.loadProject(path)).projectId !== id) throw new Error("Studio project identity mismatch."); }
  async putAsset(path: string, id: string, asset: StudioAssetFile): Promise<void> {
    await this.checkIdentity(path, id);
    if (!/^[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/.test(asset.contentAddressedPath)) throw new Error("Invalid content-addressed asset path.");
    const destination = this.supportPath(path, `assets/sha256/${asset.contentAddressedPath}`);
    if (await this.app.vault.adapter.exists(destination)) {
      const previous = new Uint8Array(await this.app.vault.adapter.readBinary(destination));
      if (previous.length !== asset.bytes.length || previous.some((byte, index) => byte !== asset.bytes[index])) throw new Error("An immutable Studio asset has different bytes.");
      return;
    }
    await this.write(destination, asset.bytes);
  }
  async putSupportFile(path: string, id: string, file: StudioSupportFile): Promise<void> { await this.checkIdentity(path, id); await this.write(this.supportPath(path, file.supportRelativePath), file.bytes); }
  private async mergeSupport(path: string, relative: string, bytes: Uint8Array): Promise<void> {
    const destination = this.supportPath(path, relative);
    await this.exclusive(destination, async () => {
      if (!await this.app.vault.adapter.exists(destination)) { await this.write(destination, bytes); return; }
      await this.app.vault.adapter.process(destination, raw => decoder.decode(reconcileStudioSupportDocument(`support/${relative}`, bytes, encoder.encode(raw)) || bytes));
    });
  }
  async replaceCache(path: string, id: string, bytes: Uint8Array): Promise<void> { await this.checkIdentity(path, id); await this.mergeSupport(path, "cache/node-results.json", bytes); }
  async publishRun(path: string, command: StudioRunPublication): Promise<void> {
    await this.checkIdentity(path, command.projectId);
    const run = command.runId;
    if (!/^[A-Za-z0-9_-]+$/.test(run)) throw new Error("Invalid Studio run ID.");
    for (const asset of command.assets) await this.putAsset(path, command.projectId, asset);
    await this.write(this.supportPath(path, `runs/${run}/snapshot.json`), command.snapshotDocument);
    await this.write(this.supportPath(path, `runs/${run}/events.ndjson`), command.eventsDocument);
    await this.mergeSupport(path, "cache/node-results.json", command.cacheDocument);
    // Publish the index last. Orphan files after a crash do not claim a completed run.
    await this.mergeSupport(path, "runs/index.json", command.runIndexDocument);
    if (command.removeRunIds.some(id => !/^[A-Za-z0-9_-]+$/.test(id) || id === run)) throw new Error("Invalid retained run selection.");
    if (command.removeRunIds.length) {
      const indexPath = this.supportPath(path, "runs/index.json");
      await this.exclusive(indexPath, () => this.app.vault.adapter.process(indexPath, raw => {
        const index = JSON.parse(raw);
        if (!Array.isArray(index)) throw new Error("Invalid run index.");
        return `${JSON.stringify(index.filter(entry => !command.removeRunIds.includes(String(entry?.runId))), null, 2)}\n`;
      }));
      for (const id of command.removeRunIds) {
        const folder = this.supportPath(path, `runs/${id}`);
        if (await this.app.vault.adapter.exists(folder)) await this.app.vault.adapter.rmdir(folder, true);
      }
    }
  }
}
