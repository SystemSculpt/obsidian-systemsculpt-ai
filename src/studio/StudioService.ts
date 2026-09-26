import { reconcileStudioProject } from "./StudioProjectReconciliation";
import { projectToEntities } from "./document/StudioProjectEntities";
import type { StudioDocumentEdit, StudioLegacyOriginalCopy } from "./document/StudioProjectDocument";
import { studioAgentExecution, readStudioCommandExecution } from './StudioCommandExecution';
import { StudioAgentRuns } from '../services/codex/StudioAgentRuns';
import { codexOptionsFromSettings } from '../services/codex/CodexExecutionSettings';
import type { StudioAgentRunView } from '../services/codex/StudioAgentRunStore';
import { Notice, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../main";
import { toSafeVaultFileName } from "../utils/vaultFileName";
import { StudioAssetStore } from "./StudioAssetStore";
import { registerBuiltInStudioNodes } from "./StudioBuiltInNodes";
import { StudioGraphCompiler } from "./StudioGraphCompiler";
import { migrateStudioProjectToPathOnlyPorts } from "./StudioGraphMigrations";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { StudioProjectStore } from "./StudioProjectStore";
import { desktopHost } from "../platform/desktopOnly";
import { StudioPermissionManager } from "./StudioPermissionManager";
import { readStudioScript } from "./StudioScript";
import { resolveExecutableCandidate } from "./StudioProcessPaths";
import { StudioRuntime } from "./StudioRuntime";
import type { StudioObservedRun, StudioRunUpdate } from "./StudioRunObserver";
import { StudioApiExecutionAdapter } from "./StudioApiExecutionAdapter";
import {
  StudioProjectSession,
  type StudioProjectSessionMutateOptions,
  type StudioProjectSessionMutationReason,
} from "./StudioProjectSession";
import { StudioProjectSessionManager } from "./StudioProjectSessionManager";
import { StudioAgentReferenceFile } from "./StudioAgentReferenceFile";
import { isBlanketCliCommandPattern, randomId } from "./utils";
import type {
  StudioAssetRef,
  StudioCapability,
  StudioCapabilityGrant,
  StudioNodeCacheSnapshotV1,
  StudioProjectLintResult,
  StudioProjectV1,
  StudioRunEvent,
  StudioRunEventHandler,
  StudioRunSummary,
} from "./types";
import {
  DEFAULT_STUDIO_PROJECTS_DIR,
  deriveStudioImportsDir,
  deriveStudioPolicyPath,
  normalizeStudioProjectPath,
  sanitizeStudioProjectName,
} from "./paths";
import { parseAndMigrateStudioProject, serializeStudioProject, type StudioProjectParseContext } from "./schema";
import { STUDIO_PROJECT_SCHEMA_V2 } from "./types";
import { sha256HexFromArrayBuffer } from "../utils/sha256";
import {
  assertStableStudioProjectAgentDocumentFieldsUnchanged,
  assertValidStudioProjectAgentDocumentStructure,
} from "./StudioProjectAgentDocumentValidation";
import { validateStudioProjectForAgentEdit } from "./StudioProjectAgentContract";

const IMPORTED_FILE_SEGMENT_FALLBACK = "import";

function sanitizeImportedFileSegment(value: string): string {
  const trimmed = String(value || "").trim();
  const leaf = trimmed.split(/[\\/]/).pop() || "";
  const sanitized = toSafeVaultFileName(leaf, { fallback: "" })
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return sanitized || IMPORTED_FILE_SEGMENT_FALLBACK;
}

function normalizeImportedExtension(extension: string): string {
  const trimmed = String(extension || "").trim().replace(/^\.+/, "").toLowerCase();
  if (!trimmed || !/^[a-z0-9]+$/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

function importedExtensionFromMimeType(mimeType: string): string {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "text/markdown") return "md";
  if (normalized === "application/json") return "json";
  if (normalized === "text/plain") return "txt";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("bmp")) return "bmp";
  if (normalized.includes("tiff")) return "tiff";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("quicktime")) return "mov";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("pdf")) return "pdf";
  return "";
}

function resolveImportedFileName(name: string, mimeType: string, hash: string): string {
  const rawLeaf = String(name || "").trim().split(/[\\/]/).pop() || "";
  const dotIndex = rawLeaf.lastIndexOf(".");
  const hasNameExtension = dotIndex > 0 && dotIndex < rawLeaf.length - 1;
  const baseName = sanitizeImportedFileSegment(hasNameExtension ? rawLeaf.slice(0, dotIndex) : rawLeaf);
  const extension = importedExtensionFromMimeType(mimeType)
    || normalizeImportedExtension(hasNameExtension ? rawLeaf.slice(dotIndex + 1) : "")
    || "bin";
  return `${baseName}-${hash.slice(0, 12)}.${extension}`;
}

const LEGACY_ORIGINAL_NOTICE_NODE_LIMIT = 5;

function formatLegacyOriginalNotice(copy: StudioLegacyOriginalCopy): string {
  const listed = copy.retiredNodes.slice(0, LEGACY_ORIGINAL_NOTICE_NODE_LIMIT).map((node) => `${node.title} (${node.kind})`);
  const more = copy.retiredNodes.length - listed.length;
  const retired = listed.length
    ? ` Converted retired nodes: ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`
    : "";
  return `Studio updated ${copy.projectPath} to the current project format.${retired} The original file is saved at ${copy.copyPath}.`;
}

export class StudioService {
  private readonly registry = new StudioNodeRegistry();
  private readonly compiler = new StudioGraphCompiler();
  private readonly projectStore: StudioProjectStore;
  private readonly assetStore: StudioAssetStore;
  private readonly apiAdapter: StudioApiExecutionAdapter;
  private readonly runtime: StudioRuntime;
  readonly agentRuns: StudioAgentRuns;
  private readonly projectSessionManager = new StudioProjectSessionManager();
  private readonly agentReferenceFile: StudioAgentReferenceFile;

  constructor(private readonly plugin: SystemSculptPlugin) {
    this.projectStore = new StudioProjectStore(plugin.app, {
      // The copy is made once per distinct original, so this notice appears once per upgraded file.
      onLegacyOriginalCopied: (copy) => {
        new Notice(formatLegacyOriginalNotice(copy), 15000);
      },
    });
    this.agentReferenceFile = new StudioAgentReferenceFile(plugin.app);
    this.assetStore = new StudioAssetStore(this.projectStore);
    this.apiAdapter = new StudioApiExecutionAdapter(plugin);
    this.agentRuns = new StudioAgentRuns(plugin, {
      readDocument: path => this.readAgentDocument(path),
      editDocument: (path, heads, edits) => this.editAgentDocument(path, heads, edits),
      startPeer: (path, nodeId, objective, parentRunId, assignmentId) => this.startAgentRun(path, nodeId, { objective, parentRunId, assignmentId }),
      workflowSpecification: async (projectPath, centerId, objective) => {
        const path = this.requireProjectPath(projectPath), project = await this.agentProjectSnapshot(path);
        const center = project.graph.nodes.find(node => node.id === centerId && node.kind === 'studio.command_center');
        if (!center) throw new Error('Choose a Command Center in this Studio.');
        return { projectId: project.projectId, projectPath: path, nodeId: centerId, title: 'Orchestrator', request: {
          ...readStudioCommandExecution(center.config.execution), serviceTier: 'default', workingDirectory: '.',
          prompt: `Owner objective:\n${objective}\n\nStudio path: ${path}. Read studio_context for resources and their machine-specific paths. Work only within the owner objective.`,
        } };
      },
      context: async (path, nodeId) => {
        const project = await this.agentProjectSnapshot(path);
        if (nodeId) {
          const node = project.graph.nodes.find(node => node.id === nodeId);
          if (!node) throw new Error('Studio resource not found.');
          const source = JSON.stringify(node);
          if (source.length > 48000) return { id: node.id, title: node.title, note: 'This resource is too large for inline context. Read the saved Studio resource from disk.', projectPath: path };
          return node;
        }
        return { projectPath: path, nodes: project.graph.nodes.slice(0, 300).map(node => ({ id: node.id, title: node.title, kind: node.kind, summary: JSON.stringify(node.config).slice(0, 500) })), truncated: project.graph.nodes.length > 300, recentRuns: this.agentRuns.list(project.projectId).slice(0, 20).map(run => ({ id: run.id, title: run.title, status: run.status, result: run.result.slice(-1500) })) };
      },
      prepare: record => this.prepareAgentInputs(record.projectPath, record.nodeId, record.request),
      templates: async path => (await this.agentProjectSnapshot(path)).graph.nodes.filter(node => node.kind === 'studio.codex').map(node => ({ id: node.id, title: node.title })),
    });
    this.runtime = new StudioRuntime(
      plugin.app,
      plugin,
      this.projectStore,
      this.registry,
      this.compiler,
      this.assetStore,
      this.apiAdapter,
      this.agentRuns
    );

    registerBuiltInStudioNodes(this.registry);
  }

  async listProjects(): Promise<string[]> {
    return this.projectStore.listProjects();
  }

  getProjectSession(projectPath: string): StudioProjectSession | null {
    return this.projectSessionManager.getSession(projectPath);
  }

  mutateProject(
    projectPath: string,
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => boolean | void,
    options?: StudioProjectSessionMutateOptions
  ): boolean {
    const session = this.projectSessionManager.getSession(projectPath);
    if (!session) {
      return false;
    }
    return session.mutate(reason, mutator, options);
  }

  async mutateProjectAsync(
    projectPath: string,
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => Promise<boolean | void>,
    options?: StudioProjectSessionMutateOptions
  ): Promise<boolean> {
    const session = this.projectSessionManager.getSession(projectPath);
    if (!session) {
      return false;
    }
    return await session.mutateAsync(reason, mutator, options);
  }

  private async buildProjectSession(
    projectPath: string,
    project: StudioProjectV1,
    options?: { acceptedRawText?: string | null }
  ): Promise<StudioProjectSession> {
    const session = new StudioProjectSession({
      projectPath,
      project,
      saveProject: async (nextProjectPath, nextProject, onBeforeProjectWrite, baseProject) => {
        return this.projectStore.saveProject(nextProjectPath, nextProject, { onBeforeProjectWrite, baseProject });
      },
      readProjectRawText: async (nextProjectPath) => {
        return this.projectStore.readProjectRawText(nextProjectPath);
      },

    });
    const rawText =
      typeof options?.acceptedRawText === "string"
        ? options.acceptedRawText
        : await this.projectStore.readProjectRawText(projectPath);
    if (rawText != null) {
      session.markAcceptedProjectText(rawText);
    }
    return session;
  }

  private async loadProjectForSession(projectPath: string, options?: { forceReload?: boolean }): Promise<{
    project: StudioProjectV1;
    rawText: string | null;
  }> {
    void this.agentReferenceFile.ensureCurrent();
    let project = options
      ? await this.projectStore.loadProject(projectPath, options)
      : await this.projectStore.loadProject(projectPath);
    const migration = migrateStudioProjectToPathOnlyPorts(project);
    if (migration.changed) {
      project = migration.project;
      await this.projectStore.saveProject(projectPath, project);
    }
    await this.ensureDefaultPolicy(project);
    const rawText = await this.projectStore.readProjectRawText(projectPath);
    return {
      project,
      rawText,
    };
  }

  /**
   * Retain a project session for a specific owner (usually a Studio view).
   * Every retain must be paired with exactly one releaseProjectSession call;
   * the session-manager refcount decides when the session actually closes.
   */
  async retainProjectSession(
    path: string,
    options?: { forceReload?: boolean }
  ): Promise<StudioProjectSession> {
    return this.projectSessionManager.retainSession(path, async sessionPath => {
      // New sessions always reconcile the visible file, including changes made
      // while no view was watching the project.
      const loaded = await this.loadProjectForSession(sessionPath, { forceReload: true });
      return this.buildProjectSession(sessionPath, loaded.project, { acceptedRawText: loaded.rawText });
    }, options?.forceReload ? async (session, sessionPath) => {
      const loaded = await this.loadProjectForSession(sessionPath, { forceReload: true });
      await session.reconcileExternalProject(loaded.project, loaded.rawText);
    } : undefined);
  }

  /** Files are imported into document authority; views and editor lifetimes stay intact. */
  async reconcileProjectFile(path: string, rawText?: string): Promise<{conflicts: string[]}> {
    const session = this.getProjectSession(path);
    await session?.waitForInFlightSave();
    const result = rawText === undefined
      ? await this.projectStore.refreshDocument(path)
      : await this.projectStore.importProjectText(path, rawText);
    if (session && !session.isDisposed()) {
      await session.reconcileExternalProject(result.project, serializeStudioProject(result.project));
    }
    return {conflicts: result.conflicts};
  }

  /** A merge clock beside the project changed: redo merges that waited for it. Null when none did. */
  async reconcileProjectClock(path: string): Promise<{conflicts: string[]} | null> {
    const session = this.getProjectSession(path);
    await session?.waitForInFlightSave();
    const result = await this.projectStore.settleDocument(path);
    if (!result) return null;
    if (session && !session.isDisposed()) {
      await session.reconcileExternalProject(result.project, serializeStudioProject(result.project));
    }
    return {conflicts: result.conflicts};
  }

  /** `heads` holds one revision: the SHA-256 of the canonical document text. */
  async readAgentDocument(path: string): Promise<unknown> {
    path = this.requireProjectPath(path);
    await this.getProjectSession(path)?.flushPendingSaveWork({force: true});
    const {project, revision} = await this.projectStore.readDocument(path);
    return {heads: [revision], canvas: JSON.parse(serializeStudioProject(project)), entities: projectToEntities(project)};
  }

  async editAgentDocument(path: string, heads: string[], edits: StudioDocumentEdit[]): Promise<unknown> {
    path = this.requireProjectPath(path);
    if (!Array.isArray(heads) || heads.length !== 1 || typeof heads[0] !== "string" || !/^[0-9a-f]{64}$/.test(heads[0])) throw new Error("Read the Studio revision before editing.");
    const session = this.getProjectSession(path);
    await session?.flushPendingSaveWork({force: true});
    const result = await this.projectStore.editDocument(path, heads[0], edits);
    await session?.reconcileExternalProject(result.project, serializeStudioProject(result.project));
    return {heads: [result.revision], entities: projectToEntities(result.project)};
  }

  async releaseProjectSession(path: string): Promise<void> {
    await this.projectSessionManager.releaseSession(path);
  }

  private getProjectsFolder(): string {
    return String(this.plugin.settings.studioDefaultProjectsFolder || "").trim() || DEFAULT_STUDIO_PROJECTS_DIR;
  }

  deriveDefaultProjectPath(name: string): string {
    const safeName = sanitizeStudioProjectName(name);
    return normalizeStudioProjectPath(normalizePath(`${this.getProjectsFolder()}/${safeName}`));
  }

  private async ensureDefaultPolicy(project: StudioProjectV1): Promise<void> {
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    let changed = false;

    const hasFilesystemDefault = policy.grants.some(
      (grant) => grant.capability === "filesystem" && (grant.scope.allowedPaths || []).includes("/")
    );
    if (!hasFilesystemDefault) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "filesystem",
        scope: { allowedPaths: ["/"] },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      });
      changed = true;
    }

    const requiredCliPatterns = [
      "ffmpeg",
      "ffprobe",
      "*/ffmpeg",
      "*/ffprobe",
    ];
    const cliGrant = policy.grants.find((grant) => grant.capability === "cli");
    if (!cliGrant) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "cli",
        scope: {
          allowedCommandPatterns: requiredCliPatterns,
        },
        grantedAt: new Date().toISOString(),
        grantedByUser: true,
      });
      changed = true;
    } else {
      const existing = cliGrant.scope.allowedCommandPatterns || [];
      // SEC-03: scrub any stale blanket "*" baked into an on-disk policy so
      // re-opening an older project converges to the safe state (the cleanup is
      // persisted below via savePolicy).
      const patterns = new Set(existing.filter((p) => !isBlanketCliCommandPattern(p)));
      if (patterns.size !== existing.length) {
        changed = true;
      }
      // Always ensure the legitimate ffmpeg/ffprobe defaults are present.
      for (const pattern of requiredCliPatterns) {
        if (!patterns.has(pattern)) {
          patterns.add(pattern);
          changed = true;
        }
      }
      cliGrant.scope.allowedCommandPatterns = Array.from(patterns);
    }

    if (changed) {
      await this.projectStore.savePolicy(project.permissionsRef.policyPath, policy);
    }
  }

  /**
   * Create a new Studio project file on disk without retaining a session.
   * Session ownership belongs to whichever view subsequently opens the path
   * via retainProjectSession.
   */
  async createProjectFile(options?: { name?: string; projectPath?: string }): Promise<{
    path: string;
    project: StudioProjectV1;
  }> {
    const name = sanitizeStudioProjectName(String(options?.name || "New Studio Project"));
    void this.agentReferenceFile.ensureCurrent();
    const filePath = options?.projectPath
      ? normalizeStudioProjectPath(options.projectPath)
      : this.deriveDefaultProjectPath(name);

    const created = await this.projectStore.createProject({
      name,
      projectPath: filePath,
      minPluginVersion: this.plugin.manifest.version,
      maxRuns: Math.max(1, Math.floor(this.plugin.settings.studioRunRetentionMaxRuns || 100)),
      maxArtifactsMb: Math.max(1, Math.floor(this.plugin.settings.studioRunRetentionMaxArtifactsMb || 1024)),
    });

    await this.ensureDefaultPolicy(created.project);
    return {
      path: created.path,
      project: created.project,
    };
  }

  async createProject(options?: { name?: string; projectPath?: string }): Promise<StudioProjectV1> {
    const created = await this.createProjectFile(options);
    return created.project;
  }

  async renameProject(projectPath: string, nextName: string): Promise<{
    oldPath: string;
    newPath: string;
    project: StudioProjectV1;
  }> {
    const normalizedProjectPath = normalizeStudioProjectPath(projectPath);
    const safeName = sanitizeStudioProjectName(String(nextName || "").trim());
    if (!safeName) {
      throw new Error("Studio project name cannot be empty.");
    }

    const session = this.projectSessionManager.getSession(normalizedProjectPath);
    if (session) {
      await session.flushPendingSaveWork({ force: true });
    }

    const renamed = await this.projectStore.renameProject(normalizedProjectPath, safeName, {
      project: session?.getProjectSnapshot(),
    });

    const nextRawText = await this.projectStore.readProjectRawText(renamed.newPath);
    if (session) {
      session.moveProjectPath(renamed.newPath);
      await this.projectSessionManager.moveSession(renamed.oldPath, renamed.newPath);
      await session.reconcileExternalProject(renamed.project, nextRawText);
    }

    return renamed;
  }

  async adoptVisibleProjectRename(oldProjectPath: string, newProjectPath: string): Promise<{
    oldPath: string;
    newPath: string;
    project: StudioProjectV1;
  }> {
    const oldPath = normalizeStudioProjectPath(oldProjectPath);
    const newPath = normalizeStudioProjectPath(newProjectPath);
    const session = this.projectSessionManager.getSession(oldPath);
    if (!session) {
      throw new Error("Studio no longer has the renamed project open.");
    }
    const movedRawText = await this.projectStore.readVisibleProjectRawText(newPath);
    const lintResult = this.lintProjectText(movedRawText, { projectPath: newPath });
    if (!lintResult.ok) {
      throw new Error(`Studio couldn't read the renamed project file: ${lintResult.error}`);
    }
    if (lintResult.project.projectId !== session.getProject().projectId) {
      throw new Error("The renamed Studio file does not match the open project.");
    }

    const currentCanvas = session.getProjectSnapshot();
    const fileContainsLastSavedCanvas = session.matchesLastAcceptedProjectText(movedRawText);
    const nextPolicyPath = deriveStudioPolicyPath(newPath);
    if (!fileContainsLastSavedCanvas) {
      const movedPolicyPath = lintResult.project.permissionsRef.policyPath;
      const pathChangeMatchesRename = movedPolicyPath === currentCanvas.permissionsRef.policyPath
        || movedPolicyPath === nextPolicyPath;
      if (!pathChangeMatchesRename) {
        throw new Error("permissionsRef.policyPath may only change to match the renamed Studio file.");
      }
      // A v2 file carries no Studio-owned envelope beyond the identity checked
      // above; a v1 file still carries the full envelope and must keep it
      // identical to the open canvas.
      const movedDocument = JSON.parse(movedRawText) as Record<string, unknown>;
      if (movedDocument.schema !== STUDIO_PROJECT_SCHEMA_V2) {
        assertStableStudioProjectAgentDocumentFieldsUnchanged(
          {
            ...lintResult.project,
            permissionsRef: {
              ...lintResult.project.permissionsRef,
              policyPath: nextPolicyPath,
            },
          },
          {
            ...currentCanvas,
            permissionsRef: {
              ...currentCanvas.permissionsRef,
              policyPath: nextPolicyPath,
            },
          }
        );
      }
    }
    await session.waitForInFlightSave();
    const editing = session.getEditingSnapshot();
    const merged = reconcileStudioProject(editing.base, editing.project, lintResult.project, {preferLocalConflicts: true}).project;
    session.moveProjectPath(newPath);
    await this.projectSessionManager.moveSession(oldPath, newPath);
    const fileName = newPath.slice(newPath.lastIndexOf("/") + 1);
    const projectName = fileName.slice(0, -".systemsculpt".length) || lintResult.project.name;
    const sourceProject = merged;
    const renamed = await this.projectStore.adoptVisibleProjectRename({
      oldPath,
      newPath,
      movedRawText,
      project: {
        ...sourceProject,
        name: projectName,
        permissionsRef: {
          ...sourceProject.permissionsRef,
          policyPath: nextPolicyPath,
        },
      },
    });
    const nextRawText = await this.projectStore.readProjectRawText(renamed.newPath);
    // Preserve edits that arrived while the filesystem rename was adopted.
    session.mutate("project.rename", current => { current.name = projectName; });
    await session.reconcileExternalProject(renamed.project, nextRawText);
    return { ...renamed, project: session.getProjectSnapshot() };
  }

  async saveProject(projectPath: string, project: StudioProjectV1): Promise<void> {
    const normalizedProjectPath = normalizeStudioProjectPath(projectPath);
    const saved = await this.projectStore.saveProject(normalizedProjectPath, project);
    const session = this.projectSessionManager.getSession(normalizedProjectPath);
    if (!session) {
      return;
    }
    const rawText = await this.projectStore.readProjectRawText(normalizedProjectPath);
    await session.reconcileExternalProject(saved.project, rawText);
  }

  lintProjectText(rawText: string, context?: StudioProjectParseContext): StudioProjectLintResult {
    try {
      const projectText = String(rawText || "");
      assertValidStudioProjectAgentDocumentStructure(JSON.parse(projectText));
      const project = parseAndMigrateStudioProject(projectText, context);
      // Lint gates whether Studio adopts an edited document, so it compiles
      // in document mode like the persistence gate. Run readiness (required
      // configs and inputs) is enforced by the runtime when a run starts.
      this.compiler.compile(project, this.registry, { validation: "document" });
      validateStudioProjectForAgentEdit(project);
      return {
        ok: true,
        project,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message.trim().length > 0 ? message.trim() : "Studio lint failed with an unknown error.",
      };
    }
  }

  private requireProjectPath(projectPath: string): string {
    const rawPath = String(projectPath || "").trim();
    if (!rawPath) {
      throw new Error("A valid Studio project path is required.");
    }
    return normalizeStudioProjectPath(rawPath);
  }

  subscribeRunEvents(listener: (update: StudioRunUpdate) => void): () => void {
    return this.runtime.runs.subscribe(listener);
  }

  getActiveRun(projectPath: string): StudioObservedRun | null {
    return this.runtime.runs.getActiveRun(this.requireProjectPath(projectPath));
  }

  async runProject(
    projectPath: string,
    options?: { onEvent?: StudioRunEventHandler }
  ): Promise<StudioRunSummary> {
    const normalized = this.requireProjectPath(projectPath);
    const session = this.projectSessionManager.getSession(normalized);
    if (!session) {
      return this.runtime.runProject(normalized, {
        onEvent: options?.onEvent,
      });
    }
    await session.flushPendingSaveWork({ force: true });
    const projectSnapshot = session.getProjectSnapshot();
    return this.runtime.runProjectSnapshot(normalized, projectSnapshot, {
      onEvent: options?.onEvent,
    });
  }

  async runProjectFromNode(
    projectPath: string,
    nodeId: string,
    options?: { onEvent?: StudioRunEventHandler }
  ): Promise<StudioRunSummary> {
    const normalized = this.requireProjectPath(projectPath);

    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      throw new Error("A valid node ID is required to run a scoped Studio execution.");
    }

    const session = this.projectSessionManager.getSession(normalized);
    if (session) {
      await session.flushPendingSaveWork({ force: true });
    }
    const projectSnapshot =
      session?.getProjectSnapshot() || (await this.projectStore.loadProject(normalized));
    const exists = projectSnapshot.graph.nodes.some((node) => node.id === normalizedNodeId);
    if (!exists) {
      throw new Error(`Cannot run from node "${normalizedNodeId}" because it is not part of this project.`);
    }

    return this.runtime.runProjectSnapshot(normalized, projectSnapshot, {
      entryNodeIds: [normalizedNodeId],
      forceNodeIds: [normalizedNodeId],
      onEvent: options?.onEvent,
    });
  }

  private async agentProjectSnapshot(projectPath: string): Promise<StudioProjectV1> {
    const session = this.projectSessionManager.getSession(projectPath);
    if (session) await session.flushPendingSaveWork({ force: true });
    return session?.getProjectSnapshot() || this.projectStore.loadProject(projectPath);
  }

  async startAgentRun(projectPath: string, nodeId: string, options?: { objective?: string; parentRunId?: string; assignmentId?: string }): Promise<StudioAgentRunView> {
    const path = this.requireProjectPath(projectPath), project = await this.agentProjectSnapshot(path);
    const node = project.graph.nodes.find(node => node.id === nodeId && node.kind === 'studio.codex');
    if (!node) throw new Error('Choose a Codex role in this project.');
    const config = node.config;
    const parent = options?.parentRunId ? this.agentRuns.get(options.parentRunId) : undefined;
    if (options?.parentRunId && (!parent || parent.projectId !== project.projectId)) throw new Error('Parent run must belong to this project.');
    const request = { ...studioAgentExecution(project.graph.nodes, nodeId, { ...codexOptionsFromSettings(this.plugin.settings),
      ...Object.fromEntries(['model', 'effort', 'serviceTier'].filter(key => typeof config[key] === 'string' && String(config[key]).trim()).map(key => [key, String(config[key])])) }, parent?.request),
      prompt: `${String(config.prompt || '')}\n\nTask input:\n${JSON.stringify(config.input || {})}${options?.objective ? `\n\nObjective for this instance:\n${options.objective}` : ''}`,
      workingDirectory: String(config.workingDirectory || '.'), threadId: options?.parentRunId ? '' : String(config.threadId || '') };
    const inbound = project.graph.edges.filter(edge => edge.toNodeId === nodeId);
    return this.agentRuns.start({ projectId: project.projectId, projectPath: path, nodeId, title: node.title, request, parentRunId: options?.parentRunId, assignmentId: options?.assignmentId,
      ...(inbound.length ? { prepare: () => this.prepareAgentInputs(path, nodeId, request) } : {}),
    });
  }

  private async prepareAgentInputs(path: string, nodeId: string, request: import('../services/codex/LocalCodexClient').CodexRequest): Promise<import('../services/codex/LocalCodexClient').CodexRequest> {
    const project = await this.agentProjectSnapshot(path), inbound = project.graph.edges.filter(edge => edge.toNodeId === nodeId);
    if (!inbound.length) return request;
    const inputs = await this.runtime.prepareNodeInputs(path, project, nodeId);
    return { ...request, prompt: `${request.prompt}\n\nConnected context:\n${JSON.stringify(inputs)}` };
  }

  async getLatestRunEvents(projectPath: string): Promise<StudioRunEvent[]> {
    return this.runtime.getLatestRunEvents(this.requireProjectPath(projectPath));
  }

  async getRecentRuns(projectPath: string): Promise<StudioRunSummary[]> {
    const rawPath = String(projectPath || "").trim();
    if (!rawPath) return [];
    return this.runtime.getRecentRuns(normalizeStudioProjectPath(rawPath));
  }

  async getProjectNodeCache(projectPath: string): Promise<StudioNodeCacheSnapshotV1 | null> {
    const rawPath = String(projectPath || "").trim();
    if (!rawPath) {
      return null;
    }
    const targetPath = normalizeStudioProjectPath(rawPath);
    return this.runtime.getNodeCacheSnapshot(targetPath);
  }

  async storeAsset(projectPath: string, bytes: ArrayBuffer, mimeType: string): Promise<StudioAssetRef> {
    const targetPath = normalizeStudioProjectPath(String(projectPath || "").trim());
    return this.assetStore.storeArrayBuffer(targetPath, bytes, mimeType);
  }

  async importFileToProject(
    projectPath: string,
    options: { bytes: ArrayBuffer; name?: string; mimeType?: string }
  ): Promise<string> {
    const targetPath = this.requireProjectPath(projectPath);
    const project = await this.projectStore.loadProject(targetPath);
    const bytes = options.bytes.slice(0);
    const hash = await sha256HexFromArrayBuffer(bytes);
    const fileName = resolveImportedFileName(options.name || "", options.mimeType || "", hash);
    const supportRelativePath = `imports/${fileName}`;
    await this.projectStore.putSupportFile(targetPath, project.projectId, {
      supportRelativePath,
      bytes: new Uint8Array(bytes),
    });
    return normalizePath(`${deriveStudioImportsDir(targetPath)}/${fileName}`);
  }

  async readAsset(asset: StudioAssetRef): Promise<ArrayBuffer> {
    return this.assetStore.readArrayBuffer(asset);
  }

  async restoreAssetFile(projectPath: string, assetPath: string): Promise<boolean> {
    return this.projectStore.restoreAssetFile(projectPath, assetPath);
  }

  /** Imported projects never grant their own executable. UI review persists an exact project grant. */
  async getProcessApprovalRequests(projectPath: string, project: StudioProjectV1): Promise<Array<{ command: string; nodeTitle: string; args: string[]; cwd: string }>> {
    const nodes = project.graph.nodes.filter((node) => ["studio.process", "studio.script"].includes(node.kind) && !node.disabled);
    if (nodes.length === 0) return [];
    this.requireProjectPath(projectPath);
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    const permissions = new StudioPermissionManager(policy);
    const path = await desktopHost.path();
    const adapter = this.plugin.app.vault.adapter as { getFullPath?: (relative: string) => string; basePath?: string };
    const requests: Array<{ command: string; nodeTitle: string; args: string[]; cwd: string }> = [];
    for (const node of nodes) {
      const config = node.kind === "studio.script" ? readStudioScript(node.config.source).processConfig : node.config;
      const configuredCwd = String(config.workingDirectory || ".").trim();
      const cwd = path.isAbsolute(configuredCwd) ? configuredCwd
        : adapter.getFullPath?.(configuredCwd) || (adapter.basePath ? path.resolve(adapter.basePath, configuredCwd) : "");
      if (!cwd) throw new Error("Studio requires an absolute vault path to approve a process.");
      const command = resolveExecutableCandidate(String(config.executable || "").trim(), cwd);
      if (!command) throw new Error("A process executable is required.");
      try { permissions.assertCliCommand(command, true); }
      catch {
        requests.push({ command, nodeTitle: node.title, cwd, args: node.kind === "studio.script" ? ["<inline JavaScript module>"] : Array.isArray(config.arguments) ? config.arguments.map(String) : [] });
      }
    }
    return requests;
  }

  async addCapabilityGrant(
    projectPath: string,
    grant: {
      capability: StudioCapability;
      scope: StudioCapabilityGrant["scope"];
      grantedByUser?: boolean;
    }
  ): Promise<void> {
    const normalized = this.requireProjectPath(projectPath);
    const project =
      this.projectSessionManager.getSession(normalized)?.getProjectSnapshot() ||
      (await this.projectStore.loadProject(normalized));
    const policy = await this.projectStore.loadPolicy(project.permissionsRef.policyPath);
    policy.grants.push({
      id: randomId("grant"),
      capability: grant.capability,
      scope: grant.scope,
      grantedAt: new Date().toISOString(),
      grantedByUser: grant.grantedByUser !== false,
    });
    await this.projectStore.savePolicy(project.permissionsRef.policyPath, policy);
  }

  async dispose(): Promise<void> {
    await this.agentRuns.dispose();
    this.runtime.dispose();
    this.apiAdapter.dispose();
    await this.projectSessionManager.closeAll();
    await this.projectStore.dispose();
  }

  listNodeDefinitions() {
    return this.registry.list();
  }

}
