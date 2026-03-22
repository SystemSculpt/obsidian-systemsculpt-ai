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
import {
  StudioTerminalSessionManager,
  type StudioTerminalSidecarStatus,
  type StudioTerminalSidecarStatusListener,
  type StudioTerminalSessionListener,
  type StudioTerminalSessionRequest,
  type StudioTerminalSessionSnapshot,
} from "./StudioTerminalSessionManager";
import { resolveStudioDynamicSelectOptions } from "./StudioDynamicSelectOptions";
import { StudioTerminalService } from "./StudioTerminalService";
import { randomId } from "./utils";
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

function starterGraph(project: StudioProjectV1): StudioProjectV1 {
  if (project.graph.nodes.length > 0) {
    return project;
  }

  const inputId = randomId("node");
  const textId = randomId("node");

  return {
    ...project,
    graph: {
      nodes: [
        {
          id: inputId,
          kind: "studio.input",
          version: "1.0.0",
          title: "Input",
          position: { x: 80, y: 120 },
          config: { value: "Describe a launch-ready plan for this project." },
          continueOnError: false,
          disabled: false,
        },
        {
          id: textId,
          kind: "studio.text_generation",
          version: "1.0.0",
          title: "Text Generation",
          position: { x: 420, y: 120 },
          config: {
            modelId: project.engine.apiMode === "systemsculpt_only" ? "openai/gpt-5-mini" : "",
          },
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [
        {
          id: randomId("edge"),
          fromNodeId: inputId,
          fromPortId: "text",
          toNodeId: textId,
          toPortId: "prompt",
        },
      ],
      entryNodeIds: [inputId],
      groups: project.graph.groups || [],
    },
  };
}

export class StudioService {
  private readonly registry = new StudioNodeRegistry();
  private readonly compiler = new StudioGraphCompiler();
  private readonly projectStore: StudioProjectStore;
  private readonly assetStore: StudioAssetStore;
  private readonly apiAdapter: StudioApiExecutionAdapter;
  private readonly runtime: StudioRuntime;
  private readonly terminalService: StudioTerminalService;
  private readonly projectSessionManager = new StudioProjectSessionManager();
  private currentProjectPath: string | null = null;
  private currentProjectSession: StudioProjectSession | null = null;

  constructor(private readonly plugin: SystemSculptPlugin) {
    this.projectStore = new StudioProjectStore(plugin.app);
    this.assetStore = new StudioAssetStore(plugin.app);
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
    const terminalSessionManager = new StudioTerminalSessionManager(plugin);
    this.terminalService = new StudioTerminalService(
      plugin,
      this.projectStore,
      terminalSessionManager
    );

    registerBuiltInStudioNodes(this.registry);
  }

  getCurrentProjectPath(): string | null {
    return this.currentProjectPath;
  }

  async listProjects(): Promise<string[]> {
    return this.projectStore.listProjects();
  }

  getCurrentProjectSession(): StudioProjectSession | null {
    return this.currentProjectSession;
  }

  async getCurrentProject(): Promise<StudioProjectV1 | null> {
    if (this.currentProjectSession) {
      return this.currentProjectSession.getProject();
    }
    if (!this.currentProjectPath) return null;
    return this.projectStore.loadProject(this.currentProjectPath);
  }

  getCurrentProjectSnapshot(): StudioProjectV1 | null {
    return this.currentProjectSession?.getProjectSnapshot() || null;
  }

  getProjectSession(projectPath: string): StudioProjectSession | null {
    return this.projectSessionManager.getSession(projectPath);
  }

  mutateCurrentProject(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => boolean | void,
    options?: StudioProjectSessionMutateOptions
  ): boolean {
    if (!this.currentProjectSession) {
      return false;
    }
    return this.currentProjectSession.mutate(reason, mutator, options);
  }

  async mutateCurrentProjectAsync(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => Promise<boolean | void>,
    options?: StudioProjectSessionMutateOptions
  ): Promise<boolean> {
    if (!this.currentProjectSession) {
      return false;
    }
    return await this.currentProjectSession.mutateAsync(reason, mutator, options);
  }

  async mutateCurrentProjectAndFlush(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => boolean | void,
    options?: StudioProjectSessionMutateOptions
  ): Promise<boolean> {
    if (!this.currentProjectSession) {
      return false;
    }
    return await this.currentProjectSession.mutateAndFlush(reason, mutator, options);
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

  async openProjectSession(
    path: string,
    options?: { forceReload?: boolean }
  ): Promise<StudioProjectSession> {
    const normalized = normalizeStudioProjectPath(path);
    if (
      this.currentProjectSession &&
      this.currentProjectSession.getProjectPath() === normalized &&
      options?.forceReload !== true
    ) {
      this.currentProjectPath = normalized;
      return this.currentProjectSession;
    }

    if (
      this.currentProjectSession &&
      this.currentProjectSession.getProjectPath() === normalized &&
      options?.forceReload === true
    ) {
      const loaded = await this.loadProjectForSession(normalized);
      this.currentProjectSession.replaceProjectSnapshot(loaded.project, {
        projectPath: normalized,
        acceptedRawText: loaded.rawText,
      });
      this.currentProjectPath = normalized;
      return this.currentProjectSession;
    }

    const previousProjectPath = this.currentProjectPath;
    if (previousProjectPath && previousProjectPath !== normalized) {
      await this.projectSessionManager.releaseSession(previousProjectPath);
      await this.terminalService.terminateProjectSessions({
        projectPath: previousProjectPath,
        reason: "project_switch",
      });
    }

    const existingSession = this.projectSessionManager.getSession(normalized);
    if (existingSession && options?.forceReload === true) {
      const loaded = await this.loadProjectForSession(normalized);
      existingSession.replaceProjectSnapshot(loaded.project, {
        projectPath: normalized,
        acceptedRawText: loaded.rawText,
      });
    }

    const session = await this.projectSessionManager.retainSession(normalized, async (sessionPath) => {
      const loaded = await this.loadProjectForSession(sessionPath);
      return await this.buildProjectSession(sessionPath, loaded.project, {
        acceptedRawText: loaded.rawText,
      });
    });
    this.currentProjectSession = session;
    this.currentProjectPath = normalized;
    return session;
  }

  async openProject(path: string): Promise<StudioProjectV1> {
    const session = await this.openProjectSession(path);
    return session.getProject();
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
      const patterns = new Set(cliGrant.scope.allowedCommandPatterns || []);
      if (!patterns.has("*")) {
        for (const pattern of requiredCliPatterns) {
          if (!patterns.has(pattern)) {
            patterns.add(pattern);
            changed = true;
          }
        }
      }
      cliGrant.scope.allowedCommandPatterns = Array.from(patterns);
    }

    if (changed) {
      await this.projectStore.savePolicy(project.permissionsRef.policyPath, policy);
    }
  }

  async createProject(options?: { name?: string; projectPath?: string }): Promise<StudioProjectV1> {
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

    const seeded = starterGraph(created.project);
    await this.projectStore.saveProject(created.path, seeded);
    await this.ensureDefaultPolicy(seeded);

    const previousProjectPath = this.currentProjectPath;
    if (previousProjectPath && previousProjectPath !== created.path) {
      await this.projectSessionManager.releaseSession(previousProjectPath);
      await this.terminalService.terminateProjectSessions({
        projectPath: previousProjectPath,
        reason: "project_switch",
      });
    }

    const acceptedRawText = await this.projectStore.readProjectRawText(created.path);
    const session = await this.projectSessionManager.retainSession(created.path, async (sessionPath) =>
      await this.buildProjectSession(sessionPath, seeded, {
        acceptedRawText,
      })
    );
    this.currentProjectSession = session;
    this.currentProjectPath = created.path;
    return session.getProject();
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
    if (this.currentProjectSession?.getProjectPath() === normalizedProjectPath) {
      this.currentProjectSession = session;
    }
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

  async runCurrentProject(options?: { onEvent?: StudioRunEventHandler }): Promise<StudioRunSummary> {
    if (!this.currentProjectPath) {
      throw new Error("No Studio project is currently open.");
    }
    await this.currentProjectSession?.flushPendingSaveWork({ force: true });
    const projectSnapshot = this.currentProjectSession?.getProjectSnapshot();
    if (!projectSnapshot) {
      return this.runtime.runProject(this.currentProjectPath, {
        onEvent: options?.onEvent,
      });
    }
    return this.runtime.runProjectSnapshot(this.currentProjectPath, projectSnapshot, {
      onEvent: options?.onEvent,
    });
  }

  async runCurrentProjectFromNode(
    nodeId: string,
    options?: { onEvent?: StudioRunEventHandler }
  ): Promise<StudioRunSummary> {
    if (!this.currentProjectPath) {
      throw new Error("No Studio project is currently open.");
    }

    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      throw new Error("A valid node ID is required to run a scoped Studio execution.");
    }

    await this.currentProjectSession?.flushPendingSaveWork({ force: true });
    const projectSnapshot =
      this.currentProjectSession?.getProjectSnapshot() ||
      await this.projectStore.loadProject(this.currentProjectPath);
    const exists = projectSnapshot.graph.nodes.some((node) => node.id === normalizedNodeId);
    if (!exists) {
      throw new Error(`Cannot run from node "${normalizedNodeId}" because it is not part of this project.`);
    }

    return this.runtime.runProjectSnapshot(this.currentProjectPath, projectSnapshot, {
      entryNodeIds: [normalizedNodeId],
      forceNodeIds: [normalizedNodeId],
      onEvent: options?.onEvent,
    });
  }

  async getRecentRuns(): Promise<StudioRunSummary[]> {
    if (!this.currentProjectPath) return [];
    return this.runtime.getRecentRuns(this.currentProjectPath);
  }

  async getProjectNodeCache(projectPath?: string): Promise<StudioNodeCacheSnapshotV1 | null> {
    const rawPath = String(projectPath || this.currentProjectPath || "").trim();
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

  async addCapabilityGrant(grant: {
    capability: StudioCapability;
    scope: StudioCapabilityGrant["scope"];
    grantedByUser?: boolean;
  }): Promise<void> {
    if (!this.currentProjectPath) {
      throw new Error("No Studio project is currently open.");
    }
    const project = await this.projectStore.loadProject(this.currentProjectPath);
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

  async ensureTerminalSession(request: StudioTerminalSessionRequest): Promise<StudioTerminalSessionSnapshot> {
    return await this.terminalService.ensureSession(request);
  }

  async restartTerminalSession(request: StudioTerminalSessionRequest): Promise<StudioTerminalSessionSnapshot> {
    return await this.terminalService.restartSession(request);
  }

  async stopTerminalSession(options: { projectPath: string; nodeId: string }): Promise<void> {
    await this.terminalService.stopSession(options);
  }

  clearTerminalSessionHistory(options: { projectPath: string; nodeId: string }): void {
    this.terminalService.clearHistory(options);
  }

  writeTerminalInput(options: { projectPath: string; nodeId: string; data: string }): void {
    this.terminalService.writeInput(options);
  }

  resizeTerminalSession(options: { projectPath: string; nodeId: string; cols: number; rows: number }): void {
    this.terminalService.resizeSession(options);
  }

  getTerminalSessionSnapshot(options: {
    projectPath: string;
    nodeId: string;
  }): StudioTerminalSessionSnapshot | null {
    return this.terminalService.getSnapshot(options);
  }

  async peekTerminalSession(options: {
    projectPath: string;
    nodeId: string;
  }): Promise<StudioTerminalSessionSnapshot | null> {
    return await this.terminalService.peekSession(options);
  }

  subscribeTerminalSession(
    options: { projectPath: string; nodeId: string },
    listener: StudioTerminalSessionListener
  ): () => void {
    return this.terminalService.subscribe(options, listener);
  }

  getTerminalSidecarStatus(): StudioTerminalSidecarStatus | null {
    return this.terminalService.getSidecarStatus();
  }

  subscribeTerminalSidecarStatus(listener: StudioTerminalSidecarStatusListener): () => void {
    return this.terminalService.subscribeSidecarStatus(listener);
  }

  async refreshTerminalSidecarStatus(): Promise<StudioTerminalSidecarStatus | null> {
    return await this.terminalService.refreshSidecarStatus();
  }

  buildTerminalSidecarStatusReport(): string {
    return this.terminalService.buildSidecarStatusReport();
  }

  async terminateProjectTerminalSessions(options: { projectPath: string; reason?: string }): Promise<void> {
    await this.terminalService.terminateProjectSessions({
      projectPath: normalizeStudioProjectPath(String(options.projectPath || "").trim()),
      reason: String(options.reason || "").trim(),
    });
  }

  async closeCurrentProject(options?: { terminateTerminalSessions?: boolean }): Promise<void> {
    const previousProjectPath = this.currentProjectPath;
    this.currentProjectPath = null;
    this.currentProjectSession = null;
    if (previousProjectPath) {
      await this.projectSessionManager.releaseSession(previousProjectPath);
    }
    if (!previousProjectPath || options?.terminateTerminalSessions === false) {
      return;
    }
    await this.terminalService.terminateProjectSessions({
      projectPath: previousProjectPath,
      reason: "project_close",
    });
  }

  async dispose(): Promise<void> {
    this.currentProjectSession = null;
    this.currentProjectPath = null;
    await this.projectSessionManager.closeAll();
    await this.terminalService.dispose();
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
