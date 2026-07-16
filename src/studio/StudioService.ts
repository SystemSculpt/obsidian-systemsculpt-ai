import { normalizePath } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StudioAssetStore } from "./StudioAssetStore";
import { registerBuiltInStudioNodes } from "./StudioBuiltInNodes";
import { StudioGraphCompiler } from "./StudioGraphCompiler";
import { migrateStudioProjectToPathOnlyPorts } from "./StudioGraphMigrations";
import { StudioNodeRegistry } from "./StudioNodeRegistry";
import { StudioProjectStore } from "./StudioProjectStore";
import { StudioRuntime } from "./StudioRuntime";
import { StudioApiExecutionAdapter } from "./StudioApiExecutionAdapter";
import {
  StudioProjectSession,
  type StudioProjectSessionMutateOptions,
  type StudioProjectSessionMutationReason,
} from "./StudioProjectSession";
import { StudioProjectSessionManager } from "./StudioProjectSessionManager";
import { StudioProjectRecoveryStore } from "./persistence/StudioProjectRecoveryStore";
import { isBlanketCliCommandPattern, randomId } from "./utils";
import type {
  StudioAssetRef,
  StudioCapability,
  StudioCapabilityGrant,
  StudioNodeCacheSnapshotV1,
  StudioProjectLintResult,
  StudioProjectV1,
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
import { parseStudioProject } from "./schema";
import { sha256HexFromArrayBuffer } from "./hash";
import {
  assertStableStudioProjectAgentDocumentFieldsUnchanged,
  assertValidStudioProjectAgentDocumentStructure,
} from "./StudioProjectAgentDocumentValidation";
import { validateStudioProjectForAgentEdit } from "./StudioProjectAgentContract";

const IMPORTED_FILE_SEGMENT_FALLBACK = "import";

function sanitizeImportedFileSegment(value: string): string {
  const trimmed = String(value || "").trim();
  const leaf = trimmed.split(/[\\/]/).pop() || "";
  const sanitized = leaf
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[.-]+$/g, "")
    .trim()
    .replace(/^-+/g, "");
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

export class StudioService {
  private readonly registry = new StudioNodeRegistry();
  private readonly compiler = new StudioGraphCompiler();
  private readonly projectStore: StudioProjectStore;
  private readonly assetStore: StudioAssetStore;
  private readonly apiAdapter: StudioApiExecutionAdapter;
  private readonly runtime: StudioRuntime;
  private readonly projectSessionManager = new StudioProjectSessionManager();
  private readonly projectRecoveryStore: StudioProjectRecoveryStore;
  private readonly projectSessionOperations = new Map<string, Promise<void>>();

  constructor(private readonly plugin: SystemSculptPlugin) {
    this.projectStore = new StudioProjectStore(plugin.app);
    this.projectRecoveryStore = new StudioProjectRecoveryStore(plugin.app.vault.adapter);
    this.assetStore = new StudioAssetStore(this.projectStore);
    this.apiAdapter = new StudioApiExecutionAdapter(plugin);
    this.runtime = new StudioRuntime(
      plugin.app,
      plugin,
      this.projectStore,
      this.registry,
      this.compiler,
      this.assetStore,
      this.apiAdapter
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
      saveProject: async (nextProjectPath, nextProject, onBeforeProjectWrite) => {
        await this.projectStore.saveProject(nextProjectPath, nextProject, {
          onBeforeProjectWrite,
        });
      },
      readProjectRawText: async (nextProjectPath) => {
        return this.projectStore.readProjectRawText(nextProjectPath);
      },
      saveBlockedProjectRecovery: async (_nextProjectPath, recoveryProject) => {
        await this.preserveProjectRecovery(recoveryProject);
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

  async preserveProjectRecovery(project: StudioProjectV1): Promise<void> {
    await this.projectRecoveryStore.save(project);
  }

  async consumeBlockedProjectRecovery(
    projectId: string,
    currentProject?: StudioProjectV1
  ): Promise<StudioProjectV1 | null> {
    return await this.projectRecoveryStore.consume(projectId, currentProject);
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
    const normalized = normalizeStudioProjectPath(path);
    return await this.withProjectSessionOperation(normalized, async () => {
      const existingSession = this.projectSessionManager.getSession(normalized);
      if (existingSession && options?.forceReload === true) {
        // Load and validate completely before replacing the shared in-memory
        // snapshot. A failed file reload therefore leaves the current canvas
        // and its editor state untouched.
        const loaded = await this.loadProjectForSession(normalized, { forceReload: true });
        existingSession.replaceProjectSnapshot(loaded.project, {
          projectPath: normalized,
          acceptedRawText: loaded.rawText,
        });
      }

      return await this.projectSessionManager.retainSession(normalized, async (sessionPath) => {
        // With no retained session there is no Studio view watching file
        // modifications. Reconcile the visible project file before creating a
        // new session instead of reusing a selection cached by an earlier view.
        const loaded = await this.loadProjectForSession(sessionPath, { forceReload: true });
        return await this.buildProjectSession(sessionPath, loaded.project, {
          acceptedRawText: loaded.rawText,
        });
      });
    });
  }

  async releaseProjectSession(path: string): Promise<void> {
    const rawPath = String(path || "").trim();
    if (!rawPath) {
      return;
    }
    const normalized = normalizeStudioProjectPath(rawPath);
    await this.withProjectSessionOperation(normalized, async () => {
      await this.projectSessionManager.releaseSession(normalized);
    });
  }

  private async withProjectSessionOperation<T>(
    projectPath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const prior = this.projectSessionOperations.get(projectPath) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.catch(() => {}).then(() => gate);
    this.projectSessionOperations.set(projectPath, queued);
    await prior.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.projectSessionOperations.get(projectPath) === queued) {
        this.projectSessionOperations.delete(projectPath);
      }
    }
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
    const projectSnapshot = session?.getProjectSnapshot() || undefined;

    if (session) {
      await session.flushPendingSaveWork({ force: true });
    }

    const renamed = await this.projectStore.renameProject(normalizedProjectPath, safeName, {
      project: projectSnapshot,
    });

    const nextRawText = await this.projectStore.readProjectRawText(renamed.newPath);
    if (session) {
      session.replaceProjectSnapshot(renamed.project, {
        projectPath: renamed.newPath,
        acceptedRawText: nextRawText,
      });
      this.projectSessionManager.moveSession(renamed.oldPath, renamed.newPath);
    }

    return renamed;
  }

  async adoptVisibleProjectRename(oldProjectPath: string, newProjectPath: string): Promise<{
    oldPath: string;
    newPath: string;
    project: StudioProjectV1;
    replacedCanvasProject: StudioProjectV1 | null;
  }> {
    const oldPath = normalizeStudioProjectPath(oldProjectPath);
    const newPath = normalizeStudioProjectPath(newProjectPath);
    const session = this.projectSessionManager.getSession(oldPath);
    if (!session) {
      throw new Error("Studio no longer has the renamed project open.");
    }
    const movedRawText = await this.projectStore.readVisibleProjectRawText(newPath);
    const lintResult = this.lintProjectText(movedRawText);
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
    const replacedCanvasProject =
      !fileContainsLastSavedCanvas && session.hasPendingLocalSaveWork()
        ? currentCanvas
        : null;
    if (replacedCanvasProject) {
      // Content changed as well as the path. Preserve the canvas before the
      // file wins so a failed recovery write blocks the transition.
      await this.preserveProjectRecovery(replacedCanvasProject);
    }
    const fileName = newPath.slice(newPath.lastIndexOf("/") + 1);
    const projectName = fileName.slice(0, -".systemsculpt".length) || lintResult.project.name;
    const sourceProject = fileContainsLastSavedCanvas ? currentCanvas : lintResult.project;
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
    session.replaceProjectSnapshot(renamed.project, {
      projectPath: renamed.newPath,
      acceptedRawText: nextRawText,
    });
    this.projectSessionManager.moveSession(renamed.oldPath, renamed.newPath);
    return { ...renamed, replacedCanvasProject };
  }

  async saveProject(projectPath: string, project: StudioProjectV1): Promise<void> {
    const normalizedProjectPath = normalizeStudioProjectPath(projectPath);
    await this.projectStore.saveProject(normalizedProjectPath, project);
    const session = this.projectSessionManager.getSession(normalizedProjectPath);
    if (!session) {
      return;
    }
    const rawText = await this.projectStore.readProjectRawText(normalizedProjectPath);
    session.replaceProjectSnapshot(project, {
      projectPath: normalizedProjectPath,
      acceptedRawText: rawText,
    });
  }

  lintProjectText(rawText: string): StudioProjectLintResult {
    try {
      const projectText = String(rawText || "");
      assertValidStudioProjectAgentDocumentStructure(JSON.parse(projectText));
      const project = parseStudioProject(projectText);
      this.compiler.compile(project, this.registry);
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
    await this.projectSessionManager.closeAll();
  }

  listNodeDefinitions() {
    return this.registry.list();
  }

}
