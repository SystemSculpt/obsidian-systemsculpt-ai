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
import { resolveStudioDynamicSelectOptions } from "./StudioDynamicSelectOptions";
import { isBlanketCliCommandPattern, randomId } from "./utils";
import type {
  StudioAssetRef,
  StudioCapability,
  StudioCapabilityGrant,
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeInstance,
  StudioNodeCacheSnapshotV1,
  StudioProjectLintResult,
  StudioProjectV1,
  StudioRunEventHandler,
  StudioRunSummary,
} from "./types";
import {
  DEFAULT_STUDIO_PROJECTS_DIR,
  normalizeStudioProjectPath,
  sanitizeStudioProjectName,
} from "./paths";
import { parseStudioProject } from "./schema";

export class StudioService {
  private readonly registry = new StudioNodeRegistry();
  private readonly compiler = new StudioGraphCompiler();
  private readonly projectStore: StudioProjectStore;
  private readonly assetStore: StudioAssetStore;
  private readonly apiAdapter: StudioApiExecutionAdapter;
  private readonly runtime: StudioRuntime;
  private readonly projectSessionManager = new StudioProjectSessionManager();

  constructor(private readonly plugin: SystemSculptPlugin) {
    this.projectStore = new StudioProjectStore(plugin.app);
    this.assetStore = new StudioAssetStore(this.projectStore);
    this.apiAdapter = new StudioApiExecutionAdapter(plugin, this.assetStore);
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
      saveProject: async (nextProjectPath, nextProject) => {
        await this.projectStore.saveProject(nextProjectPath, nextProject);
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

  private async loadProjectForSession(projectPath: string): Promise<{
    project: StudioProjectV1;
    rawText: string | null;
  }> {
    let project = await this.projectStore.loadProject(projectPath);
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
    const normalized = normalizeStudioProjectPath(path);

    const existingSession = this.projectSessionManager.getSession(normalized);
    if (existingSession && options?.forceReload === true) {
      const loaded = await this.loadProjectForSession(normalized);
      existingSession.replaceProjectSnapshot(loaded.project, {
        projectPath: normalized,
        acceptedRawText: loaded.rawText,
      });
    }

    return await this.projectSessionManager.retainSession(normalized, async (sessionPath) => {
      const loaded = await this.loadProjectForSession(sessionPath);
      return await this.buildProjectSession(sessionPath, loaded.project, {
        acceptedRawText: loaded.rawText,
      });
    });
  }

  async releaseProjectSession(path: string): Promise<void> {
    const rawPath = String(path || "").trim();
    if (!rawPath) {
      return;
    }
    await this.projectSessionManager.releaseSession(normalizeStudioProjectPath(rawPath));
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

    const hasStudioNetwork = policy.grants.some(
      (grant) =>
        grant.capability === "network" &&
        (grant.scope.allowedDomains || []).some((domain) => domain === "api.systemsculpt.com")
    );
    if (!hasStudioNetwork) {
      policy.grants.push({
        id: randomId("grant"),
        capability: "network",
        scope: {
          allowedDomains: ["api.systemsculpt.com", "systemsculpt.com"],
        },
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
      const project = parseStudioProject(String(rawText || ""));
      this.compiler.compile(project, this.registry);
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

  async resolveDynamicSelectOptions(
    source: StudioNodeConfigDynamicOptionsSource,
    _node: StudioNodeInstance
  ): Promise<StudioNodeConfigSelectOption[]> {
    return await resolveStudioDynamicSelectOptions({
      plugin: this.plugin,
      source,
    });
  }
}
