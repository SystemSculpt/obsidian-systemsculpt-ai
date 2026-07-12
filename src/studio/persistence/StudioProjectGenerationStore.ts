import { deriveStudioAssetsDir, deriveStudioPolicyPath, normalizeStudioProjectPath } from "../paths";
import { parseStudioPolicy, parseStudioProject } from "../schema";
import { sha256HexFromArrayBuffer } from "../hash";

export type GenerationHash = string;
export type ExpectedGeneration = { revision: number; generationHash: GenerationHash };
export type ProjectionLocator = { vaultRelativeProjectPath: string };
export type StudioGenerationAdapter = {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
};

type GenerationManifestEntry = { relativePath: string; kind: "text" | "binary"; sizeBytes: number; sha256: string };
type GenerationManifestBody = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  parentRevision: number | null;
  parentGenerationHash: string | null;
  createdAt: string;
  commandKind: StudioGenerationCommandKind;
  entries: GenerationManifestEntry[];
  projection: { canonicalPath: string; supportRoot: string };
};
type GenerationManifest = GenerationManifestBody & { generationHash: string };
type CommitDescriptor = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  generationHash: string;
  manifestSha256: string;
  entryCount: number;
  logicallyCommittedAt: string;
};
type ValidGeneration = { manifest: GenerationManifest; files: Map<string, Uint8Array>; directory: string };
type ProjectionMarker = { schemaVersion: 1; projectId: string; revision: number; generationHash: string; projectDocumentSha256: string; supportManifestSha256: string };
type ProjectionSnapshot = { files: Map<string, Uint8Array>; markerRaw: string | null; supportMarkerRaw: string | null };

export type SelectedGeneration = { files: ReadonlyMap<string, Uint8Array>; metadata: GenerationManifest };
export type ReadyResult = { status: "ready"; expectedGeneration: ExpectedGeneration; generation: SelectedGeneration; projectionStatus: "matching" | "repaired" };
export type CommitResult =
  | { status: "committed"; expectedGeneration: ExpectedGeneration; generation: SelectedGeneration; logicallyCommitted: true }
  | { status: "stale_revision"; expectedGeneration: ExpectedGeneration }
  | { status: "fork_detected" | "recovery_required" | "future_unsupported" | "read_only" | "invalid_candidate" | "storage_unavailable"; message: string };
export type OpenResult = ReadyResult | Exclude<CommitResult, { status: "committed" | "stale_revision" }>;
export type RecoveryResult =
  | { status: "ready"; expectedGeneration: ExpectedGeneration; generation: SelectedGeneration }
  | { status: "fork_detected" | "recovery_required" | "future_unsupported" | "storage_unavailable"; message: string };
export type StudioAssetGenerationFile = { contentAddressedPath: string; bytes: Uint8Array };
export type StudioProjectGenerationCreateCommand = {
  kind: "create";
  projectId: string;
  projectDocument: Uint8Array;
  policyDocument: Uint8Array;
  projectManifest: Uint8Array;
};
export type StudioExternalCandidate = { projectId: string; expectedGeneration: ExpectedGeneration; projectDocument: Uint8Array; supportFiles: readonly { supportRelativePath: string; bytes: Uint8Array }[] };
export type StudioProjectGenerationCommand =
  | { kind: "replace_project"; projectId: string; projectDocument: Uint8Array; reason: "discrete_save" | "autosave" | "migration" | "repair" }
  | { kind: "replace_policy"; projectId: string; policyDocument: Uint8Array }
  | { kind: "put_asset"; projectId: string; asset: StudioAssetGenerationFile }
  | { kind: "replace_cache"; projectId: string; cacheDocument: Uint8Array }
  | { kind: "replace_manifest"; projectId: string; projectManifest: Uint8Array }
  | { kind: "publish_run"; projectId: string; runId: string; snapshotDocument: Uint8Array; eventsDocument: Uint8Array; runIndexDocument: Uint8Array; cacheDocument: Uint8Array; assets: readonly StudioAssetGenerationFile[]; removeRunIds: readonly string[] }
  | { kind: "logical_rename"; projectId: string; locator: ProjectionLocator; projectDocument: Uint8Array; projectManifest: Uint8Array };
type InternalStudioProjectGenerationCommand = StudioProjectGenerationCommand | { kind: "external_sync"; projectId: string; projectDocument: Uint8Array; supportFiles: readonly { relativePath: string; bytes: Uint8Array }[] };

type StudioGenerationCommandKind = "create" | "discrete_save" | "autosave" | "policy" | "manifest" | "asset" | "run" | "cache" | "migration" | "repair" | "external_sync" | "logical_rename";

const AUTHORITY_ROOT = ".systemsculpt/studio/projects";
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical metadata numbers must be integers.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON value.");
}

function normalizeRelativePath(input: string): string {
  const path = String(input).replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid generation relative path.");
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Invalid generation relative path.");
  if (path === "manifest.json" || path === "commit.json") throw new Error("Reserved generation path.");
  return path;
}

export function validateProjectionLocator(locator: ProjectionLocator): ProjectionLocator {
  const raw = String(locator?.vaultRelativeProjectPath || "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error("Invalid Studio projection path.");
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Invalid Studio projection path.");
  const normalized = normalizeStudioProjectPath(raw);
  if (normalized !== raw || normalized.startsWith(`${AUTHORITY_ROOT}/`) || normalized.startsWith(".systemsculpt/")) throw new Error("Invalid or reserved Studio projection path.");
  return { vaultRelativeProjectPath: normalized };
}

function hasAllowedKeys(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => allowed.includes(key));
}

function validateClosedLegacyProject(raw: Record<string, unknown>, locator: ProjectionLocator): { projectId: string } {
  const top = ["schema", "projectId", "name", "createdAt", "updatedAt", "engine", "graph", "permissionsRef", "settings", "migrations"];
  if (!hasExactKeys(raw, top)) throw new Error("Legacy Studio project root schema is not closed.");
  const object = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; };
  if (!hasExactKeys(object(raw.engine, "engine"), ["apiMode", "minPluginVersion"])) throw new Error("Legacy engine schema is not closed.");
  const graph = object(raw.graph, "graph");
  if (!hasExactKeys(graph, ["nodes", "edges", "entryNodeIds", "groups"]) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.entryNodeIds) || !Array.isArray(graph.groups)) throw new Error("Legacy graph schema is not closed.");
  for (const node of graph.nodes) if (!hasAllowedKeys(object(node, "node"), ["id", "kind", "version", "title", "position", "config"], ["id", "kind", "version", "title", "position", "size", "config", "continueOnError", "disabled"])) throw new Error("Legacy node schema is not closed.");
  for (const edge of graph.edges) if (!hasExactKeys(object(edge, "edge"), ["id", "fromNodeId", "fromPortId", "toNodeId", "toPortId"])) throw new Error("Legacy edge schema is not closed.");
  for (const group of graph.groups) if (!hasAllowedKeys(object(group, "group"), ["id", "name", "nodeIds"], ["id", "name", "color", "nodeIds"])) throw new Error("Legacy group schema is not closed.");
  const permissions = object(raw.permissionsRef, "permissionsRef");
  if (!hasExactKeys(permissions, ["policyVersion", "policyPath"]) || permissions.policyPath !== deriveStudioPolicyPath(locator.vaultRelativeProjectPath)) throw new Error("Legacy policy reference is invalid for the projection locator.");
  const settings = object(raw.settings, "settings");
  if (!hasExactKeys(settings, ["runConcurrency", "defaultFsScope", "retention"]) || !hasExactKeys(object(settings.retention, "retention"), ["maxRuns", "maxArtifactsMb"])) throw new Error("Legacy settings schema is not closed.");
  const migrations = object(raw.migrations, "migrations");
  if (!hasExactKeys(migrations, ["projectSchemaVersion", "applied"]) || !Array.isArray(migrations.applied)) throw new Error("Legacy migrations schema is not closed.");
  for (const applied of migrations.applied) if (!hasExactKeys(object(applied, "migration"), ["id", "at"])) throw new Error("Legacy migration entry schema is not closed.");
  parseStudioProject(decoder.decode(encoder.encode(JSON.stringify(raw))));
  return { projectId: String(raw.projectId || "") };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) if (left[i] !== right[i]) return false;
  return true;
}
function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer; }
async function hash(bytes: Uint8Array): Promise<string> { return sha256HexFromArrayBuffer(arrayBuffer(bytes)); }
function authority(projectId: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Studio project ID.");
  return `${AUTHORITY_ROOT}/${projectId}`;
}
function generationRoot(projectId: string): string { return `${authority(projectId)}/generations`; }
function assetGenerationPath(path: string): string {
  const normalized = normalizeRelativePath(path);
  if (!/^[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/.test(normalized)) throw new Error("Asset command requires a SHA-256 content-addressed path.");
  return `support/assets/sha256/${normalized}`;
}
function validateRunId(runId: string): string {
  if (!PROJECT_ID.test(runId)) throw new Error("Invalid Studio run ID.");
  return runId;
}
function generationToken(g: ValidGeneration): ExpectedGeneration { return { revision: g.manifest.revision, generationHash: g.manifest.generationHash }; }
function selected(g: ValidGeneration): SelectedGeneration { return { files: new Map([...g.files].map(([p, b]) => [p, b.slice()])), metadata: g.manifest }; }

export class StudioProjectGenerationStore {
  private static readonly coordinators = new WeakMap<object, Map<string, Promise<unknown>>>();
  private readonly now: () => string;
  private readonly maxCandidates: number;
  private readonly listeners = new Map<string, Set<(generation: ExpectedGeneration) => void>>();

  constructor(private readonly adapter: StudioGenerationAdapter, options?: { now?: () => string; maxCandidates?: number }) {
    this.now = options?.now || (() => new Date().toISOString());
    this.maxCandidates = options?.maxCandidates || 1000;
  }

  subscribe(projectId: string, listener: (generation: ExpectedGeneration) => void): () => void {
    const set = this.listeners.get(projectId) || new Set(); set.add(listener); this.listeners.set(projectId, set);
    return () => set.delete(listener);
  }

  async isProjectionLocatorAvailable(locatorInput: ProjectionLocator): Promise<boolean> {
    const locator = validateProjectionLocator(locatorInput);
    const path = locator.vaultRelativeProjectPath;
    const parent = dirname(path);
    try {
      const listed = await this.adapter.list(parent);
      if (listed.files.includes(path)) return false;
      const supportRoot = deriveStudioAssetsDir(path);
      if (listed.folders.includes(supportRoot)) return false;
      return true;
    } catch {
      return true;
    }
  }

  private async authorityHasCandidates(projectId: string): Promise<boolean> {
    try { const listed = await this.adapter.list(generationRoot(projectId)); return listed.files.length > 0 || listed.folders.length > 0; }
    catch { return false; }
  }

  private async exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    let map = StudioProjectGenerationStore.coordinators.get(this.adapter as object);
    if (!map) { map = new Map(); StudioProjectGenerationStore.coordinators.set(this.adapter as object, map); }
    const prior = map.get(projectId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    map.set(projectId, queued);
    await prior;
    try { return await action(); } finally { release(); if (map.get(projectId) === queued) map.delete(projectId); }
  }

  async discoverAndAdopt(locatorInput: ProjectionLocator): Promise<CommitResult> {
    let locator: ProjectionLocator;
    try { locator = validateProjectionLocator(locatorInput); } catch (error) { return { status: "invalid_candidate", message: String(error) }; }
    let documentBytes: Uint8Array;
    let projectId: string;
    try {
      documentBytes = new Uint8Array(await this.adapter.readBinary(locator.vaultRelativeProjectPath));
      const parsed = JSON.parse(decoder.decode(documentBytes)) as Record<string, unknown>;
      if (parsed.schema !== "studio.project.v1") return { status: String(parsed.schema || "").startsWith("studio.project.") ? "future_unsupported" : "invalid_candidate", message: "Unsupported legacy Studio project schema." };
      projectId = String(parsed.projectId || ""); authority(projectId);
    } catch (error) { return { status: "invalid_candidate", message: `Unable to parse legacy Studio project: ${String(error)}` }; }
    return this.exclusive(projectId, async () => {
      const existing = await this.recover(projectId);
      if (existing.status === "ready") {
        if (existing.generation.metadata.projection.canonicalPath !== locator.vaultRelativeProjectPath) {
          return { status: "fork_detected", message: "A second projection locator claims an existing project ID." };
        }
        const existingDocument = existing.generation.files.get("project.systemsculpt");
        if (existingDocument && bytesEqual(existingDocument, documentBytes)) {
          const projection = await this.readProjection(locator);
          if (projection && !this.generationFilesEqual(existing.generation.files, projection.files) && !this.projectionIsAuthoritySubset(existing.generation.files, projection.files)) return { status: "fork_detected", message: "Projection support tree conflicts with existing authority." };
          try { await this.ensureProjection(existing.generation); }
          catch (error) { return { status: "storage_unavailable", message: String(error) }; }
          return { status: "committed", expectedGeneration: existing.expectedGeneration, generation: existing.generation, logicallyCommitted: true };
        }
        return { status: "fork_detected", message: "Projection and existing authority disagree." };
      }
      if (existing.status === "fork_detected" || existing.status === "future_unsupported") return existing;
      if (await this.authorityHasCandidates(projectId)) return { status: "recovery_required", message: "Existing authority candidates failed validation; legacy bytes were preserved." };
      try { validateClosedLegacyProject(JSON.parse(decoder.decode(documentBytes)) as Record<string, unknown>, locator); }
      catch (error) { return { status: "invalid_candidate", message: String(error) }; }
      const files = new Map<string, Uint8Array>(); files.set("project.systemsculpt", documentBytes);
      try { await this.captureTree(deriveStudioAssetsDir(locator.vaultRelativeProjectPath), "support", files); }
      catch (error) { return { status: "storage_unavailable", message: String(error) }; }
      const policyBytes = files.get("support/policy/grants.json");
      if (!policyBytes) return { status: "invalid_candidate", message: "Legacy project policy reference is missing from the support tree." };
      try { parseStudioPolicy(decoder.decode(policyBytes)); }
      catch (error) { return { status: "invalid_candidate", message: `Legacy policy is invalid: ${String(error)}` }; }
      const manifestBytes = files.get("support/project.manifest.json");
      if (manifestBytes) {
        try {
          const manifest = JSON.parse(decoder.decode(manifestBytes)) as Record<string, unknown>;
          if (!hasExactKeys(manifest, ["schema", "projectId", "projectPath", "assetsDir", "createdAt"]) || manifest.schema !== "studio.manifest.v1" || manifest.projectId !== projectId || manifest.projectPath !== locator.vaultRelativeProjectPath || manifest.assetsDir !== deriveStudioAssetsDir(locator.vaultRelativeProjectPath)) throw new Error("manifest references do not match the projection");
        } catch (error) { return { status: "invalid_candidate", message: `Legacy support manifest is invalid: ${String(error)}` }; }
      }
      return this.publish(projectId, files, null, "create", locator);
    });
  }

  async create(command: StudioProjectGenerationCreateCommand, locatorInput: ProjectionLocator): Promise<CommitResult> {
    return this.exclusive(command.projectId, async () => {
      const recovered = await this.recover(command.projectId);
      if (recovered.status === "ready") return { status: "stale_revision", expectedGeneration: recovered.expectedGeneration };
      if (await this.authorityHasCandidates(command.projectId)) return { status: "recovery_required", message: "Existing authority candidates failed validation." };
      try {
        const files = new Map<string, Uint8Array>([
          ["project.systemsculpt", command.projectDocument.slice()],
          ["support/policy/grants.json", command.policyDocument.slice()],
          ["support/project.manifest.json", command.projectManifest.slice()],
        ]);
        return this.publish(command.projectId, files, null, "create", validateProjectionLocator(locatorInput));
      } catch (error) { return { status: "invalid_candidate", message: String(error) }; }
    });
  }

  async commit(command: StudioProjectGenerationCommand, expected: ExpectedGeneration): Promise<CommitResult> { return this.commitWholeGeneration(command, expected); }

  async commitWholeGeneration(command: StudioProjectGenerationCommand, expected: ExpectedGeneration): Promise<CommitResult> {
    return this.commitInternal(command, expected);
  }

  private async commitInternal(command: InternalStudioProjectGenerationCommand, expected: ExpectedGeneration): Promise<CommitResult> {
    return this.exclusive(command.projectId, async () => {
      const recovered = await this.recover(command.projectId);
      if (recovered.status !== "ready") return recovered;
      if (recovered.expectedGeneration.revision !== expected.revision || recovered.expectedGeneration.generationHash !== expected.generationHash) return { status: "stale_revision", expectedGeneration: recovered.expectedGeneration };
      try {
        const files = this.applyCommand(command, recovered.generation.files);
        const locator = command.kind === "logical_rename" ? validateProjectionLocator(command.locator) : { vaultRelativeProjectPath: recovered.generation.metadata.projection.canonicalPath };
        return this.publish(command.projectId, files, recovered.generation.metadata, this.commandKind(command), locator);
      } catch (error) { return { status: "invalid_candidate", message: String(error) }; }
    });
  }

  private applyCommand(command: InternalStudioProjectGenerationCommand, current: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    const files = new Map([...current].map(([path, bytes]) => [path, bytes.slice()]));
    switch (command.kind) {
      case "replace_project": files.set("project.systemsculpt", command.projectDocument.slice()); break;
      case "replace_policy": files.set("support/policy/grants.json", command.policyDocument.slice()); break;
      case "put_asset": files.set(assetGenerationPath(command.asset.contentAddressedPath), command.asset.bytes.slice()); break;
      case "replace_cache": files.set("support/cache/node-results.json", command.cacheDocument.slice()); break;
      case "replace_manifest": files.set("support/project.manifest.json", command.projectManifest.slice()); break;
      case "publish_run": {
        const runId = validateRunId(command.runId);
        for (const removeRunId of command.removeRunIds.map(validateRunId)) {
          const prefix = `support/runs/${removeRunId}`;
          for (const path of [...files.keys()]) if (path === prefix || path.startsWith(`${prefix}/`)) files.delete(path);
        }
        files.set(`support/runs/${runId}/snapshot.json`, command.snapshotDocument.slice());
        files.set(`support/runs/${runId}/events.ndjson`, command.eventsDocument.slice());
        files.set("support/runs/index.json", command.runIndexDocument.slice());
        files.set("support/cache/node-results.json", command.cacheDocument.slice());
        for (const asset of command.assets) files.set(assetGenerationPath(asset.contentAddressedPath), asset.bytes.slice());
        break;
      }
      case "logical_rename": files.set("project.systemsculpt", command.projectDocument.slice()); files.set("support/project.manifest.json", command.projectManifest.slice()); break;
      case "external_sync":
        files.clear(); files.set("project.systemsculpt", command.projectDocument.slice());
        for (const file of command.supportFiles) files.set(normalizeRelativePath(file.relativePath), file.bytes.slice());
        break;
    }
    return files;
  }

  private commandKind(command: InternalStudioProjectGenerationCommand): StudioGenerationCommandKind {
    if (command.kind === "replace_project") return command.reason;
    return ({ replace_policy: "policy", put_asset: "asset", replace_cache: "cache", replace_manifest: "manifest", publish_run: "run", logical_rename: "logical_rename", external_sync: "external_sync" } as const)[command.kind];
  }

  async open(projectId: string, locatorInput: ProjectionLocator): Promise<OpenResult> {
    let locator: ProjectionLocator;
    try { locator = validateProjectionLocator(locatorInput); } catch (error) { return { status: "invalid_candidate", message: String(error) }; }
    const recovered = await this.recover(projectId);
    if (recovered.status !== "ready") return recovered;
    if (recovered.generation.metadata.projection.canonicalPath !== locator.vaultRelativeProjectPath) return { status: "read_only", message: "Projection locator does not match selected generation." };
    const projection = await this.readProjection(locator);
    const exact = projection !== null && this.generationFilesEqual(recovered.generation.files, projection.files);
    if (projection && !exact && this.projectionIsAuthoritySubset(recovered.generation.files, projection.files)) {
      const authorityMarker = canonicalJson(await this.buildMarker(recovered.generation));
      if (projection.markerRaw === authorityMarker && projection.supportMarkerRaw === authorityMarker) return { status: "read_only", message: "Selected-token projection is missing support content; bytes were preserved as a partial replacement." };
      try {
        await this.writeProjection(recovered.generation);
        return { ...recovered, projectionStatus: "repaired" };
      } catch (error) { return { status: "storage_unavailable", message: String(error) }; }
    }
    if (exact) {
      try {
        const status = await this.ensureProjection(recovered.generation);
        return { ...recovered, projectionStatus: status };
      } catch (error) { return { status: "storage_unavailable", message: String(error) }; }
    }
    if (!projection || !projection.markerRaw || projection.markerRaw !== projection.supportMarkerRaw) {
      return { status: "read_only", message: "Changed projection has missing or mismatched identity markers; bytes were preserved." };
    }
    const marker = this.parseProjectionMarker(projection.markerRaw);
    if (!marker || marker.projectId !== projectId || marker.revision !== recovered.expectedGeneration.revision || marker.generationHash !== recovered.expectedGeneration.generationHash) {
      return { status: "fork_detected", message: "Changed projection is based on an untrusted or stale generation; bytes were preserved." };
    }
    const candidateMarker = await this.buildMarker({ files: projection.files, metadata: recovered.generation.metadata });
    const candidateHashesMatch = marker.projectDocumentSha256 === candidateMarker.projectDocumentSha256 && marker.supportManifestSha256 === candidateMarker.supportManifestSha256;
    if (!candidateHashesMatch) return { status: "read_only", message: "Changed projection marker hashes do not validate the exact candidate bytes; bytes were preserved." };
    const reconciled = await this.reconcileExternalCandidate(locator, recovered.expectedGeneration);
    if (reconciled.status !== "committed") return { status: reconciled.status === "fork_detected" ? "fork_detected" : "read_only", message: `External candidate was preserved (${reconciled.status}).` };
    return { status: "ready", expectedGeneration: reconciled.expectedGeneration, generation: reconciled.generation, projectionStatus: "matching" };
  }

  async recover(projectId: string): Promise<RecoveryResult> {
    let root: string;
    try { root = generationRoot(projectId); } catch (error) { return { status: "recovery_required", message: String(error) }; }
    let listed: { files: string[]; folders: string[] };
    try { listed = await this.adapter.list(root); } catch { return { status: "recovery_required", message: "No generation authority exists." }; }
    if (listed.folders.length > this.maxCandidates) return { status: "recovery_required", message: "Generation scan bound exceeded." };
    const valid: ValidGeneration[] = [];
    let future = false;
    for (const folder of listed.folders) {
      try { valid.push(await this.validateGeneration(folder)); }
      catch (error) { if (String(error).includes("future schema")) future = true; }
    }
    if (future) return { status: "future_unsupported", message: "A future generation schema is present." };
    if (!valid.length) return { status: "recovery_required", message: "No validated generation exists." };
    const byToken = new Map(valid.map((g) => [`${g.manifest.revision}:${g.manifest.generationHash}`, g]));
    const children = new Map<string, ValidGeneration[]>();
    for (const g of valid) {
      if (g.manifest.parentRevision === null) continue;
      const parentToken = `${g.manifest.parentRevision}:${g.manifest.parentGenerationHash}`;
      if (!byToken.has(parentToken)) return { status: "recovery_required", message: "Validated generation has an unknown parent." };
      const list = children.get(parentToken) || []; list.push(g); children.set(parentToken, list);
      if (list.length > 1) return { status: "fork_detected", message: "Two validated generations descend from the same parent." };
    }
    const roots = valid.filter((g) => g.manifest.parentRevision === null);
    if (roots.length !== 1) return { status: "fork_detected", message: "Authority contains multiple root generations." };
    let tip = roots[0]; const visited = new Set<string>();
    while (true) {
      const token = `${tip.manifest.revision}:${tip.manifest.generationHash}`;
      if (visited.has(token)) return { status: "recovery_required", message: "Generation lineage cycle." };
      visited.add(token);
      const next = children.get(token) || [];
      if (!next.length) break;
      tip = next[0];
    }
    if (visited.size !== valid.length) return { status: "fork_detected", message: "Validated generation is outside the selected lineage." };
    return { status: "ready", expectedGeneration: generationToken(tip), generation: selected(tip) };
  }

  async repairProjection(projectId: string): Promise<OpenResult> {
    const recovered = await this.recover(projectId); if (recovered.status !== "ready") return recovered;
    const locator = { vaultRelativeProjectPath: recovered.generation.metadata.projection.canonicalPath };
    const projection = await this.readProjection(locator);
    if (projection && !this.generationFilesEqual(recovered.generation.files, projection.files)) {
      if (!this.projectionIsAuthoritySubset(recovered.generation.files, projection.files)) return { status: "read_only", message: "Changed projection bytes were preserved for reconciliation." };
      const marker = canonicalJson(await this.buildMarker(recovered.generation));
      if (projection.markerRaw === marker && projection.supportMarkerRaw === marker) return { status: "read_only", message: "Selected-token projection is missing support content; bytes were preserved." };
    }
    try { await this.writeProjection(recovered.generation); return { ...recovered, projectionStatus: "repaired" }; }
    catch (error) { return { status: "storage_unavailable", message: String(error) }; }
  }
  async createExternalCandidateMarker(candidate: StudioExternalCandidate): Promise<string> {
    const recovered = await this.recover(candidate.projectId);
    if (recovered.status !== "ready" || recovered.expectedGeneration.revision !== candidate.expectedGeneration.revision || recovered.expectedGeneration.generationHash !== candidate.expectedGeneration.generationHash) throw new Error("External candidate base generation is stale or unavailable.");
    const files = new Map<string, Uint8Array>([["project.systemsculpt", candidate.projectDocument.slice()]]);
    for (const file of candidate.supportFiles) files.set(`support/${normalizeRelativePath(file.supportRelativePath)}`, file.bytes.slice());
    const parsed = JSON.parse(decoder.decode(candidate.projectDocument)) as Record<string, unknown>;
    if (parsed.schema !== "studio.project.v1" || parsed.projectId !== candidate.projectId) throw new Error("External candidate project identity is invalid.");
    return canonicalJson(await this.buildMarker({ files, metadata: recovered.generation.metadata }));
  }

  async reconcileExternalCandidate(candidate: ProjectionLocator, expected: ExpectedGeneration): Promise<CommitResult> {
    let locator: ProjectionLocator;
    try { locator = validateProjectionLocator(candidate); } catch (error) { return { status: "invalid_candidate", message: String(error) }; }
    try {
      const projection = await this.readProjection(locator);
      if (!projection || !projection.markerRaw || projection.markerRaw !== projection.supportMarkerRaw) return { status: "fork_detected", message: "Projection identity markers are missing or disagree." };
      const marker = this.parseProjectionMarker(projection.markerRaw);
      if (!marker) return { status: "invalid_candidate", message: "Projection marker schema is invalid." };
      const projectId = marker.projectId; authority(projectId);
      if (marker.revision !== expected.revision || marker.generationHash !== expected.generationHash) return { status: "fork_detected", message: "External projection is based on a stale generation." };
      const document = projection.files.get("project.systemsculpt");
      if (!document) return { status: "invalid_candidate", message: "External projection lacks a project document." };
      const parsed = JSON.parse(decoder.decode(document)) as Record<string, unknown>;
      if (parsed.schema !== "studio.project.v1" || parsed.projectId !== projectId) return { status: "invalid_candidate", message: "External project document identity is invalid." };
      const recovered = await this.recover(projectId);
      if (recovered.status !== "ready") return recovered;
      for (const path of recovered.generation.files.keys()) {
        if (path.startsWith("support/") && !projection.files.has(path)) return { status: "invalid_candidate", message: "External projection is missing selected-generation support content." };
      }
      const computed = await this.buildMarker({ files: projection.files, metadata: recovered.generation.metadata });
      const candidateHashesMatch = marker.projectDocumentSha256 === computed.projectDocumentSha256 && marker.supportManifestSha256 === computed.supportManifestSha256;
      if (!candidateHashesMatch) return { status: "invalid_candidate", message: "External projection marker hashes do not validate the exact candidate bytes." };
      return this.commitInternal({
        kind: "external_sync",
        projectId,
        projectDocument: document,
        supportFiles: [...projection.files].filter(([path]) => path.startsWith("support/")).map(([relativePath, bytes]) => ({ relativePath, bytes })),
      }, expected);
    } catch (error) { return { status: "invalid_candidate", message: String(error) }; }
  }

  private async publish(projectId: string, inputFiles: Map<string, Uint8Array>, parent: GenerationManifest | null, commandKind: StudioGenerationCommandKind, locator: ProjectionLocator): Promise<CommitResult> {
    try {
      const createdAt = this.now(); if (!RFC3339_MS.test(createdAt)) throw new Error("Timestamp must be RFC3339 with milliseconds.");
      const files = new Map<string, Uint8Array>(); const folded = new Set<string>();
      for (const [rawPath, rawBytes] of inputFiles) {
        const path = normalizeRelativePath(rawPath); const fold = path.toLocaleLowerCase("en-US");
        if (folded.has(fold)) throw new Error("Case-folding generation path collision."); folded.add(fold); files.set(path, rawBytes.slice());
      }
      if (!files.has("project.systemsculpt")) throw new Error("Generation is missing the project document.");
      const entries: GenerationManifestEntry[] = [];
      for (const [relativePath, bytes] of files) entries.push({ relativePath, kind: relativePath === "project.systemsculpt" || relativePath.endsWith(".json") || relativePath.endsWith(".ndjson") ? "text" : "binary", sizeBytes: bytes.byteLength, sha256: await hash(bytes) });
      entries.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
      const body: GenerationManifestBody = { schemaVersion: 1, projectId, revision: parent ? parent.revision + 1 : 0, parentRevision: parent?.revision ?? null, parentGenerationHash: parent?.generationHash ?? null, createdAt, commandKind, entries, projection: { canonicalPath: locator.vaultRelativeProjectPath, supportRoot: deriveStudioAssetsDir(locator.vaultRelativeProjectPath) } };
      const generationHash = await hash(encoder.encode(`studio-generation-v1\0${canonicalJson(body)}`));
      const manifest: GenerationManifest = { ...body, generationHash };
      const manifestBytes = encoder.encode(canonicalJson(manifest));
      const directory = `${generationRoot(projectId)}/${body.revision}-${generationHash}`;
      await this.mkdirRecursive(`${directory}/files`);
      for (const entry of entries) { const bytes = files.get(entry.relativePath)!; await this.mkdirRecursive(dirname(`${directory}/files/${entry.relativePath}`)); await this.adapter.writeBinary(`${directory}/files/${entry.relativePath}`, arrayBuffer(bytes)); }
      await this.adapter.write(`${directory}/manifest.json`, decoder.decode(manifestBytes));
      await this.validateFiles(directory, manifest, files);
      const descriptor: CommitDescriptor = { schemaVersion: 1, projectId, revision: body.revision, generationHash, manifestSha256: await hash(manifestBytes), entryCount: entries.length, logicallyCommittedAt: createdAt };
      await this.adapter.write(`${directory}/commit.json`, canonicalJson(descriptor));
      const validated = await this.validateGeneration(directory);
      await this.writeProjection(selected(validated));
      if (parent && parent.projection.canonicalPath !== manifest.projection.canonicalPath) {
        await this.retirePreviousProjection(parent);
      }
      const token = generationToken(validated); for (const listener of this.listeners.get(projectId) || []) listener(token);
      return { status: "committed", expectedGeneration: token, generation: selected(validated), logicallyCommitted: true };
    } catch (error) { return { status: "storage_unavailable", message: String(error) }; }
  }

  private async validateGeneration(directory: string): Promise<ValidGeneration> {
    const rawManifest = await this.adapter.read(`${directory}/manifest.json`); const manifestBytes = encoder.encode(rawManifest); const manifest = JSON.parse(rawManifest) as GenerationManifest;
    if (manifest.schemaVersion !== 1) throw new Error("future schema");
    if (!hasExactKeys(manifest as unknown as Record<string, unknown>, ["schemaVersion", "projectId", "revision", "parentRevision", "parentGenerationHash", "generationHash", "createdAt", "commandKind", "entries", "projection"])) throw new Error("manifest schema is not closed");
    authority(manifest.projectId);
    if (!HASH.test(manifest.generationHash) || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 || !RFC3339_MS.test(manifest.createdAt) || !["create", "discrete_save", "autosave", "policy", "manifest", "asset", "run", "cache", "migration", "repair", "external_sync", "logical_rename"].includes(manifest.commandKind)) throw new Error("invalid manifest identity");
    if (!hasExactKeys(manifest.projection as unknown as Record<string, unknown>, ["canonicalPath", "supportRoot"]) || validateProjectionLocator({ vaultRelativeProjectPath: manifest.projection.canonicalPath }).vaultRelativeProjectPath !== manifest.projection.canonicalPath || deriveStudioAssetsDir(manifest.projection.canonicalPath) !== manifest.projection.supportRoot) throw new Error("invalid manifest projection");
    if ((manifest.revision === 0) !== (manifest.parentRevision === null && manifest.parentGenerationHash === null)) throw new Error("invalid root lineage");
    if (manifest.revision > 0 && (!Number.isSafeInteger(manifest.parentRevision) || manifest.parentRevision !== manifest.revision - 1 || !HASH.test(String(manifest.parentGenerationHash)))) throw new Error("invalid descendant lineage");
    const expectedDirectory = `${generationRoot(manifest.projectId)}/${manifest.revision}-${manifest.generationHash}`;
    if (directory !== expectedDirectory) throw new Error("generation directory identity mismatch");
    const seen = new Set<string>(); let previousPath: string | null = null;
    for (const entry of manifest.entries) {
      if (!hasExactKeys(entry as unknown as Record<string, unknown>, ["relativePath", "kind", "sizeBytes", "sha256"])) throw new Error("entry schema is not closed");
      const path = normalizeRelativePath(entry.relativePath); const folded = path.toLocaleLowerCase("en-US");
      if (seen.has(folded) || (previousPath !== null && compareUtf8(previousPath, path) >= 0) || (entry.kind !== "text" && entry.kind !== "binary") || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !HASH.test(entry.sha256)) throw new Error("invalid manifest entry");
      seen.add(folded); previousPath = path;
    }
    const { generationHash, ...body } = manifest; if (await hash(encoder.encode(`studio-generation-v1\0${canonicalJson(body)}`)) !== generationHash) throw new Error("generation hash mismatch");
    if (rawManifest !== canonicalJson(manifest)) throw new Error("noncanonical manifest");
    const descriptorRaw = await this.adapter.read(`${directory}/commit.json`); const descriptor = JSON.parse(descriptorRaw) as CommitDescriptor;
    if (!hasExactKeys(descriptor as unknown as Record<string, unknown>, ["schemaVersion", "projectId", "revision", "generationHash", "manifestSha256", "entryCount", "logicallyCommittedAt"]) || descriptor.schemaVersion !== 1 || descriptor.projectId !== manifest.projectId || descriptor.revision !== manifest.revision || descriptor.generationHash !== generationHash || descriptor.entryCount !== manifest.entries.length || descriptor.manifestSha256 !== await hash(manifestBytes) || !RFC3339_MS.test(descriptor.logicallyCommittedAt) || descriptorRaw !== canonicalJson(descriptor)) throw new Error("invalid commit descriptor");
    const rootListing = await this.adapter.list(directory);
    if (rootListing.files.slice().sort(compareUtf8).join("\n") !== [`${directory}/commit.json`, `${directory}/manifest.json`].sort(compareUtf8).join("\n") || rootListing.folders.slice().sort(compareUtf8).join("\n") !== [`${directory}/files`].join("\n")) throw new Error("unmanifested generation metadata entry");
    const manifestedPaths = manifest.entries.map((entry) => `${directory}/files/${entry.relativePath}`).sort(compareUtf8);
    const actualPaths = await this.listTreeFiles(`${directory}/files`);
    if (actualPaths.join("\n") !== manifestedPaths.join("\n")) throw new Error("unmanifested generation content entry");
    const files = new Map<string, Uint8Array>();
    for (const entry of manifest.entries) { const path = normalizeRelativePath(entry.relativePath); const bytes = new Uint8Array(await this.adapter.readBinary(`${directory}/files/${path}`)); if (bytes.byteLength !== entry.sizeBytes || await hash(bytes) !== entry.sha256) throw new Error("entry validation failed"); files.set(path, bytes); }
    return { manifest, files, directory };
  }

  private async validateFiles(directory: string, manifest: GenerationManifest, expected: Map<string, Uint8Array>): Promise<void> {
    for (const entry of manifest.entries) { const actual = new Uint8Array(await this.adapter.readBinary(`${directory}/files/${entry.relativePath}`)); if (!bytesEqual(actual, expected.get(entry.relativePath)!)) throw new Error("fresh read validation failed"); }
    const manifestRead = await this.adapter.read(`${directory}/manifest.json`); if (manifestRead !== canonicalJson(manifest)) throw new Error("manifest fresh read validation failed");
  }

  private parseProjectionMarker(raw: string): ProjectionMarker | null {
    try {
      const marker = JSON.parse(raw) as Record<string, unknown>;
      if (!hasExactKeys(marker, ["schemaVersion", "projectId", "revision", "generationHash", "projectDocumentSha256", "supportManifestSha256"])) return null;
      if (marker.schemaVersion !== 1 || typeof marker.projectId !== "string" || !PROJECT_ID.test(marker.projectId) || !Number.isSafeInteger(marker.revision) || !HASH.test(String(marker.generationHash)) || !HASH.test(String(marker.projectDocumentSha256)) || !HASH.test(String(marker.supportManifestSha256))) return null;
      return marker as ProjectionMarker;
    } catch { return null; }
  }

  private async readProjection(locator: ProjectionLocator): Promise<ProjectionSnapshot | null> {
    try {
      const files = new Map<string, Uint8Array>();
      files.set("project.systemsculpt", new Uint8Array(await this.adapter.readBinary(locator.vaultRelativeProjectPath)));
      await this.captureTree(deriveStudioAssetsDir(locator.vaultRelativeProjectPath), "support", files);
      let markerRaw: string | null = null; let supportMarkerRaw: string | null = null;
      try { markerRaw = await this.adapter.read(`${locator.vaultRelativeProjectPath}.identity.json`); } catch {}
      try { supportMarkerRaw = await this.adapter.read(`${deriveStudioAssetsDir(locator.vaultRelativeProjectPath)}/.studio-projection.json`); } catch {}
      return { files, markerRaw, supportMarkerRaw };
    } catch { return null; }
  }

  private generationFilesEqual(expected: ReadonlyMap<string, Uint8Array>, actual: ReadonlyMap<string, Uint8Array>): boolean {
    return expected.size === actual.size && this.projectionIsAuthoritySubset(expected, actual);
  }

  private projectionIsAuthoritySubset(authorityFiles: ReadonlyMap<string, Uint8Array>, projectionFiles: ReadonlyMap<string, Uint8Array>): boolean {
    for (const [path, bytes] of projectionFiles) { const authorityBytes = authorityFiles.get(path); if (!authorityBytes || !bytesEqual(bytes, authorityBytes)) return false; }
    return true;
  }

  private async ensureProjection(generation: SelectedGeneration): Promise<"matching" | "repaired"> {
    const marker = canonicalJson(await this.buildMarker(generation));
    const locator = { vaultRelativeProjectPath: generation.metadata.projection.canonicalPath };
    const projection = await this.readProjection(locator);
    if (projection && this.generationFilesEqual(generation.files, projection.files) && projection.markerRaw === marker && projection.supportMarkerRaw === marker) return "matching";
    if (projection && !this.generationFilesEqual(generation.files, projection.files)) throw new Error("Projection bytes differ from authority and require reconciliation.");
    await this.writeProjection(generation);
    return "repaired";
  }

  private async writeProjection(generation: SelectedGeneration): Promise<void> {
    const document = generation.files.get("project.systemsculpt"); if (!document) throw new Error("Generation lacks project document.");
    const path = generation.metadata.projection.canonicalPath; const supportRoot = generation.metadata.projection.supportRoot;
    const expectedSupport = new Set([...generation.files.keys()].filter((entry) => entry.startsWith("support/")).map((entry) => `${supportRoot}/${entry.slice(8)}`));
    const existing = await this.listTreeFiles(supportRoot);
    for (const stale of existing) if (stale !== `${supportRoot}/.studio-projection.json` && !expectedSupport.has(stale)) await this.adapter.remove(stale);
    await this.mkdirRecursive(dirname(path)); await this.adapter.writeBinary(path, arrayBuffer(document));
    for (const [relativePath, bytes] of generation.files) if (relativePath.startsWith("support/")) { const target = `${supportRoot}/${relativePath.slice(8)}`; await this.mkdirRecursive(dirname(target)); await this.adapter.writeBinary(target, arrayBuffer(bytes)); }
    const marker = canonicalJson(await this.buildMarker(generation)); await this.adapter.write(`${path}.identity.json`, marker); await this.mkdirRecursive(supportRoot); await this.adapter.write(`${supportRoot}/.studio-projection.json`, marker);
    const verified = await this.readProjection({ vaultRelativeProjectPath: path });
    if (!verified || !this.generationFilesEqual(generation.files, verified.files) || verified.markerRaw !== marker || verified.supportMarkerRaw !== marker) throw new Error("Projection fresh-read validation failed.");
  }

  private async retirePreviousProjection(previous: GenerationManifest): Promise<void> {
    // The destination is already rebuilt and validated from authority. Cleanup
    // is an optimization only; an interruption leaves two classifiable
    // projections and never changes the selected generation.
    for (const path of [previous.projection.canonicalPath, `${previous.projection.canonicalPath}.identity.json`, previous.projection.supportRoot]) {
      try { await this.adapter.remove(path); } catch {}
    }
  }

  private async buildMarker(generation: SelectedGeneration): Promise<Record<string, unknown>> {
    const supportEntries: Array<{ relativePath: string; sizeBytes: number; sha256: string }> = [];
    for (const [path, bytes] of generation.files) if (path.startsWith("support/") && !path.endsWith("/.studio-projection.json")) supportEntries.push({ relativePath: path.slice(8), sizeBytes: bytes.byteLength, sha256: await hash(bytes) });
    supportEntries.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
    return { schemaVersion: 1, projectId: generation.metadata.projectId, revision: generation.metadata.revision, generationHash: generation.metadata.generationHash, projectDocumentSha256: await hash(generation.files.get("project.systemsculpt")!), supportManifestSha256: await hash(encoder.encode(canonicalJson({ entries: supportEntries }))) };
  }

  private async listTreeFiles(root: string): Promise<string[]> {
    let listed: { files: string[]; folders: string[] };
    try { listed = await this.adapter.list(root); } catch { return []; }
    const files = [...listed.files];
    for (const folder of listed.folders) files.push(...await this.listTreeFiles(folder));
    return files.sort(compareUtf8);
  }

  private async captureTree(root: string, prefix: string, output: Map<string, Uint8Array>): Promise<void> {
    let listed: { files: string[]; folders: string[] }; try { listed = await this.adapter.list(root); } catch { return; }
    for (const file of listed.files) { const name = file.slice(root.length + 1); if (name === ".studio-projection.json") continue; output.set(`${prefix}/${name}`, new Uint8Array(await this.adapter.readBinary(file))); }
    for (const folder of listed.folders) { const name = folder.slice(root.length + 1); await this.captureTree(folder, `${prefix}/${name}`, output); }
  }
  private async mkdirRecursive(path: string): Promise<void> { if (!path) return; let current = ""; for (const segment of path.split("/").filter(Boolean)) { current = current ? `${current}/${segment}` : segment; try { await this.adapter.mkdir(current); } catch {} } }
}

function dirname(path: string): string { const at = path.lastIndexOf("/"); return at < 0 ? "" : path.slice(0, at); }
function compareUtf8(left: string, right: string): number { const a = encoder.encode(left); const b = encoder.encode(right); const count = Math.min(a.length, b.length); for (let i = 0; i < count; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }
