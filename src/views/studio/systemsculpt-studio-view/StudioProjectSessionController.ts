import {
  Notice,
  TAbstractFile,
  normalizePath,
} from "obsidian";
import type SystemSculptPlugin from "../../../main";
import type {
  StudioNodeCacheSnapshotV1,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../../studio/types";
import {
  type StudioProjectSessionAutosaveMode,
  type StudioProjectSessionMutationReason,
  StudioProjectSession,
} from "../../../studio/StudioProjectSession";
import { repairStudioProjectForLoad } from "../../../studio/StudioProjectRepairs";
import {
  getSavedGraphViewState,
  getSavedNodeDetailMode,
  normalizeGraphCoordinate,
  normalizeGraphZoom,
  parseGraphViewStateByProject,
  parseNodeDetailModeByProject,
  serializeGraphViewStateByProject,
  serializeNodeDetailModeByProject,
  type StudioGraphViewState,
  type StudioGraphViewStateByProject,
  type StudioGraphViewportState,
  type StudioNodeDetailModeByProject,
  upsertGraphViewStateForProject,
} from "../graph-v3/StudioGraphViewStateStore";
import {
  STUDIO_NODE_DETAIL_DEFAULT_MODE,
  type StudioNodeDetailMode,
} from "../graph-v3/StudioGraphNodeDetailMode";
import { requestStudioAnimationFrame } from "../StudioDomContext";
import { STUDIO_GRAPH_DEFAULT_ZOOM, type StudioGraphZoomMode } from "../StudioGraphInteractionTypes";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import {
  isStudioProjectPath,
  remapPathScopedRecord,
  resolveProjectPathAfterFolderRename,
} from "./StudioProjectPathState";
import {
  deriveStudioNoteTitleFromPath,
  parseStudioNoteItems,
  serializeStudioNoteItems,
} from "../../../studio/StudioNoteConfig";

export type StudioProjectScopedViewState = {
  file?: unknown;
  graphViewByProject?: unknown;
  nodeDetailModeByProject?: unknown;
};

type StudioProjectSessionControllerHost = {
  app: SystemSculptPlugin["app"];
  plugin: SystemSculptPlugin;
  graphInteraction: Pick<
    StudioGraphInteractionEngine,
    "clearProjectState" | "getGraphZoom" | "getSelectedNodeIds" | "setGraphZoom" | "setSelectedNodeIds"
  >;
  getGraphZoomMode: () => StudioGraphZoomMode;
  resetGraphZoomInteractionState: () => void;
  scheduleLayoutSave: () => void;
  requestLayoutSave: () => void;
  getGraphViewportElement: () => HTMLElement | null;
  captureProjectHistoryCheckpoint: () => void;
  resetProjectHistory: (project: StudioProjectV1 | null) => void;
  setHistoryCurrentSnapshot: (project: StudioProjectV1, selectedNodeIds: string[]) => void;
  clearProjectEditorState: () => void;
  clearRunPresentation: () => void;
  disposeTextNodeEditors: () => void;
  hydrateProjectCache: (
    projectPath: string,
    project: StudioProjectV1
  ) => Promise<StudioNodeCacheSnapshotV1 | null>;
  materializeManagedOutputNodesFromCache: (
    entries: StudioNodeCacheSnapshotV1["entries"]
  ) => void;
  refreshNoteNodePreviewsFromVault: (
    project: StudioProjectV1,
    options?: { onlyNodeIds?: Set<string> }
  ) => Promise<boolean>;
  setError: (error: unknown) => void;
  setLastError: (message: string | null) => void;
  render: () => void;
  refreshLeafDisplay: () => void;
  isMarkdownVaultFile: (file: TAbstractFile | null | undefined) => boolean;
  isVaultFolder: (file: TAbstractFile | null | undefined) => boolean;
  readAllNotePathsFromConfig: (node: StudioNodeInstance) => string[];
  normalizeNoteNodeConfig: (node: StudioNodeInstance) => boolean;
};

export class StudioProjectSessionController {
  private currentProject: StudioProjectV1 | null = null;
  private currentProjectPath: string | null = null;
  private currentProjectSession: StudioProjectSession | null = null;
  private retainedProjectPath: string | null = null;
  private projectLiveSyncWarning: string | null = null;
  private graphViewStateByProjectPath: StudioGraphViewStateByProject = {};
  private nodeDetailModeByProjectPath: StudioNodeDetailModeByProject = {};
  private pendingViewportState: StudioGraphViewportState | null = null;

  constructor(private readonly host: StudioProjectSessionControllerHost) {}

  getProject(): StudioProjectV1 | null {
    return this.currentProject;
  }

  getProjectPath(): string | null {
    return this.currentProjectPath;
  }

  getProjectSession(): StudioProjectSession | null {
    return this.currentProjectSession;
  }

  getProjectLiveSyncWarning(): string | null {
    return this.projectLiveSyncWarning;
  }

  hasPendingLocalProjectSaveWork(): boolean {
    return this.currentProjectSession?.hasPendingLocalSaveWork() === true;
  }

  markAcceptedProjectSignature(signature: string, options?: { trackExpectedWrite?: boolean }): void {
    this.currentProjectSession?.markAcceptedProjectSignature(signature, options);
  }

  clearProjectLiveSyncState(): void {
    this.projectLiveSyncWarning = null;
    this.currentProjectSession?.clearLiveSyncState();
  }

  readCurrentNodeDetailMode(): StudioNodeDetailMode {
    return getSavedNodeDetailMode(this.nodeDetailModeByProjectPath, this.currentProjectPath);
  }

  updateCurrentNodeDetailMode(mode: StudioNodeDetailMode): boolean {
    const projectPath = String(this.currentProjectPath || "").trim();
    if (!projectPath) {
      return false;
    }
    const nextMode = mode === "collapsed" ? "collapsed" : STUDIO_NODE_DETAIL_DEFAULT_MODE;
    const previousMode = getSavedNodeDetailMode(this.nodeDetailModeByProjectPath, projectPath);
    if (previousMode === nextMode) {
      return false;
    }
    this.nodeDetailModeByProjectPath = {
      ...this.nodeDetailModeByProjectPath,
      [projectPath]: nextMode,
    };
    this.host.scheduleLayoutSave();
    return true;
  }

  captureGraphViewportState(options?: {
    allowOverview?: boolean;
    zoomOverride?: number;
    requestLayoutSave?: boolean;
  }): void {
    const projectPath = this.currentProjectPath;
    const viewport = this.host.getGraphViewportElement();
    if (!projectPath || !viewport) {
      return;
    }
    if (this.host.getGraphZoomMode() === "overview" && options?.allowOverview !== true) {
      return;
    }

    const snapshot: StudioGraphViewState = {
      scrollLeft: normalizeGraphCoordinate(viewport.scrollLeft),
      scrollTop: normalizeGraphCoordinate(viewport.scrollTop),
      zoom: normalizeGraphZoom(options?.zoomOverride ?? this.host.graphInteraction.getGraphZoom()),
    };
    this.pendingViewportState = { ...snapshot, projectPath };
    const nextGraphViewState = upsertGraphViewStateForProject(
      this.graphViewStateByProjectPath,
      projectPath,
      snapshot
    );
    this.graphViewStateByProjectPath = nextGraphViewState.nextStateByProjectPath;
    if (nextGraphViewState.changed && options?.requestLayoutSave) {
      this.host.scheduleLayoutSave();
    }
  }

  restoreGraphViewportState(viewport: HTMLElement): void {
    const pending = this.pendingViewportState;
    this.pendingViewportState = null;
    const currentProjectPath = this.currentProjectPath;
    if (!currentProjectPath) {
      return;
    }

    const restoredState = pending && pending.projectPath === currentProjectPath
      ? pending
      : getSavedGraphViewState(this.graphViewStateByProjectPath, currentProjectPath);
    if (!restoredState) {
      return;
    }

    const nextZoom = normalizeGraphZoom(restoredState.zoom);
    this.host.resetGraphZoomInteractionState();
    this.host.graphInteraction.setGraphZoom(nextZoom, { mode: "interactive" });

    const nextLeft = normalizeGraphCoordinate(restoredState.scrollLeft);
    const nextTop = normalizeGraphCoordinate(restoredState.scrollTop);
    viewport.scrollLeft = nextLeft;
    viewport.scrollTop = nextTop;

    requestStudioAnimationFrame(viewport, () => {
      if (this.host.getGraphViewportElement() !== viewport) {
        return;
      }
      viewport.scrollLeft = nextLeft;
      viewport.scrollTop = nextTop;
    });
  }

  serializePersistentState(): StudioProjectScopedViewState {
    const state: StudioProjectScopedViewState = {};
    const graphViewByProject = serializeGraphViewStateByProject(this.graphViewStateByProjectPath);
    if (Object.keys(graphViewByProject).length > 0) {
      state.graphViewByProject = graphViewByProject;
    }
    const nodeDetailModeByProject = serializeNodeDetailModeByProject(this.nodeDetailModeByProjectPath);
    if (Object.keys(nodeDetailModeByProject).length > 0) {
      state.nodeDetailModeByProject = nodeDetailModeByProject;
    }
    if (this.currentProjectPath) {
      state.file = this.currentProjectPath;
    }
    return state;
  }

  restorePersistentState(state: StudioProjectScopedViewState): string {
    this.graphViewStateByProjectPath = parseGraphViewStateByProject(state.graphViewByProject);
    this.nodeDetailModeByProjectPath = parseNodeDetailModeByProject(state.nodeDetailModeByProject);
    return typeof state.file === "string" ? state.file || "" : "";
  }

  commitMutation(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => boolean | void,
    options?: {
      captureHistory?: boolean;
      mode?: StudioProjectSessionAutosaveMode;
    }
  ): boolean {
    const session = this.currentProjectSession;
    if (!session) {
      return false;
    }
    if (options?.captureHistory !== false) {
      this.host.captureProjectHistoryCheckpoint();
    }
    return session.mutate(reason, mutator, {
      mode: options?.mode || "discrete",
    });
  }

  async commitMutationAsync(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => Promise<boolean | void>,
    options?: {
      captureHistory?: boolean;
      mode?: StudioProjectSessionAutosaveMode;
    }
  ): Promise<boolean> {
    const session = this.currentProjectSession;
    if (!session) {
      return false;
    }
    if (options?.captureHistory !== false) {
      this.host.captureProjectHistoryCheckpoint();
    }
    return await session.mutateAsync(reason, mutator, {
      mode: options?.mode || "discrete",
    });
  }

  schedulePersistFromLegacyMutation(options?: {
    captureHistory?: boolean;
    mode?: StudioProjectSessionAutosaveMode;
  }): void {
    if (options?.captureHistory !== false) {
      this.host.captureProjectHistoryCheckpoint();
    }
    this.currentProjectSession?.schedulePersist({ mode: options?.mode || "discrete" });
  }

  async flushPendingProjectSaveWork(options?: {
    force?: boolean;
    showNotice?: boolean;
  }): Promise<void> {
    if (!this.currentProjectSession) {
      return;
    }
    try {
      await this.currentProjectSession.flushPendingSaveWork({ force: options?.force });
      this.projectLiveSyncWarning = null;
      if (options?.showNotice) {
        new Notice("Studio graph saved.");
      }
    } catch (error) {
      this.host.setError(error);
    } finally {
      void this.processPendingExternalProjectSync();
    }
  }

  async flushProjectSave(options?: { showNotice?: boolean }): Promise<void> {
    await this.flushPendingProjectSaveWork({ force: true, showNotice: options?.showNotice });
  }

  async flushTextNodeEditorsBeforeProjectTransition(): Promise<void> {
    this.host.disposeTextNodeEditors();
    await this.flushPendingProjectSaveWork();
  }

  async close(): Promise<void> {
    this.captureGraphViewportState();
    this.host.requestLayoutSave();
    await this.flushTextNodeEditorsBeforeProjectTransition();
    this.host.resetProjectHistory(null);
    this.host.clearRunPresentation();
    this.clearProjectLiveSyncState();
    await this.releaseRetainedProjectSession();
    this.currentProjectPath = null;
    this.currentProject = null;
    this.pendingViewportState = null;
    this.host.clearProjectEditorState();
    this.host.graphInteraction.clearProjectState();
    this.host.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
  }

  syncProjectFromSession(): void {
    this.currentProject = this.currentProjectSession?.getProject() || null;
  }

  async loadProjectFromPath(
    projectPath: string | null,
    options?: { notifyOnError?: boolean; forceReload?: boolean }
  ): Promise<void> {
    const isProjectTransition =
      projectPath !== this.currentProjectPath || options?.forceReload === true;
    if (isProjectTransition && this.currentProjectPath && this.currentProject) {
      await this.flushTextNodeEditorsBeforeProjectTransition();
    }

    if (isProjectTransition) {
      this.captureGraphViewportState();
      this.host.clearProjectEditorState();
    }

    if (!projectPath) {
      await this.releaseRetainedProjectSession();
      this.resetLoadedProjectState();
      this.clearProjectLiveSyncState();
      return;
    }

    if (!isStudioProjectPath(projectPath)) {
      await this.releaseRetainedProjectSession();
      this.resetLoadedProjectState();
      this.clearProjectLiveSyncState();
      if (options?.notifyOnError !== false) {
        new Notice("Studio only opens .systemsculpt files.");
      }
      return;
    }

    if (!options?.forceReload && this.currentProjectPath === projectPath && this.currentProject) {
      return;
    }

    try {
      const studio = this.host.plugin.getStudioService();
      const session = await studio.retainProjectSession(projectPath, {
        forceReload: options?.forceReload,
      });
      const previousSession = this.currentProjectSession;
      const previousRetainedPath = this.retainedProjectPath;
      this.currentProjectSession = session;
      this.retainedProjectPath = session.getProjectPath();
      if (previousSession && previousRetainedPath) {
        if (previousSession === session) {
          await studio.releaseProjectSession(session.getProjectPath());
        } else {
          await studio.releaseProjectSession(previousRetainedPath);
        }
      }

      const project = session.getProject();
      const savedGraphView = getSavedGraphViewState(this.graphViewStateByProjectPath, projectPath);
      this.currentProjectPath = projectPath;
      this.currentProject = project;
      this.host.graphInteraction.clearProjectState();
      this.host.graphInteraction.setGraphZoom(savedGraphView?.zoom ?? STUDIO_GRAPH_DEFAULT_ZOOM);
      this.host.clearRunPresentation();
      this.pendingViewportState = savedGraphView
        ? { ...savedGraphView, projectPath }
        : {
            scrollLeft: 0,
            scrollTop: 0,
            zoom: this.host.graphInteraction.getGraphZoom(),
            projectPath,
          };

      await this.commitMutationAsync(
        "project.repair",
        async (currentProject) => repairStudioProjectForLoad(currentProject),
        { captureHistory: false }
      );

      try {
        const cacheSnapshot = await this.host.hydrateProjectCache(projectPath, project);
        if (cacheSnapshot) {
          this.host.materializeManagedOutputNodesFromCache(cacheSnapshot.entries);
        }
      } catch (cacheError) {
        console.warn("[SystemSculpt Studio] Unable to hydrate cache state on project load", {
          projectPath,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
      }

      await this.commitMutationAsync(
        "project.repair",
        async (currentProject) => await this.host.refreshNoteNodePreviewsFromVault(currentProject),
        { captureHistory: false }
      );
      this.host.resetProjectHistory(project);
      const loadedRawText = await this.readStudioProjectRawText(projectPath);
      if (loadedRawText != null) {
        this.currentProjectSession?.markAcceptedProjectText(loadedRawText);
      } else {
        this.currentProjectSession?.clearLiveSyncState();
      }
      this.projectLiveSyncWarning = null;
      this.host.setLastError(null);
    } catch (error) {
      await this.releaseRetainedProjectSession();
      this.resetLoadedProjectState();
      this.clearProjectLiveSyncState();
      this.host.setLastError(error instanceof Error ? error.message : String(error));
      if (options?.notifyOnError !== false) {
        this.host.setError(error);
      }
    }
  }

  async handleVaultItemModified(file: TAbstractFile): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const modifiedPath = normalizePath(String(file.path || "").trim());
    if (!modifiedPath) {
      return;
    }
    if (modifiedPath === this.currentProjectPath) {
      const rawText = await this.readStudioProjectRawText(modifiedPath);
      if (rawText != null) {
        await this.processCurrentProjectFileMutation(rawText);
      }
      return;
    }
    if (!this.host.isMarkdownVaultFile(file)) {
      return;
    }
    const matchingNodeIds = this.currentProject.graph.nodes
      .filter((node) => {
        if (node.kind !== "studio.note") {
          return false;
        }
        return this.host.readAllNotePathsFromConfig(node).includes(modifiedPath);
      })
      .map((node) => node.id);
    if (matchingNodeIds.length === 0) {
      return;
    }

    await this.commitMutationAsync(
      "vault.sync",
      async (project) =>
        await this.host.refreshNoteNodePreviewsFromVault(project, {
          onlyNodeIds: new Set(matchingNodeIds),
        }),
      { captureHistory: false }
    );
    this.host.render();
  }

  async handleVaultItemRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const previousPath = normalizePath(String(oldPath || "").trim());
    if (!previousPath) {
      return;
    }
    const renamedPath = normalizePath(String(file.path || "").trim());
    if (previousPath === this.currentProjectPath) {
      const selectedNodeIds = this.host.graphInteraction.getSelectedNodeIds();
      if (!isStudioProjectPath(renamedPath)) {
        await this.loadProjectFromPath(null, { notifyOnError: false });
        this.host.render();
        return;
      }
      this.remapProjectScopedState(previousPath, renamedPath);
      await this.loadProjectFromPath(renamedPath, {
        notifyOnError: false,
        forceReload: true,
      });
      this.applySelectionToCurrentProject(selectedNodeIds);
      const renamedRawText = await this.readStudioProjectRawText(renamedPath);
      if (renamedRawText != null) {
        this.currentProjectSession?.markAcceptedProjectText(renamedRawText);
      }
      this.projectLiveSyncWarning = null;
      this.host.render();
      this.host.refreshLeafDisplay();
      return;
    }

    const remappedProjectPath = this.host.isVaultFolder(file)
      ? resolveProjectPathAfterFolderRename({
          currentProjectPath: this.currentProjectPath,
          previousFolderPath: previousPath,
          nextFolderPath: renamedPath,
        })
      : null;
    if (remappedProjectPath) {
      const selectedNodeIds = this.host.graphInteraction.getSelectedNodeIds();
      if (!isStudioProjectPath(remappedProjectPath)) {
        await this.loadProjectFromPath(null, { notifyOnError: false });
        this.host.render();
        return;
      }
      this.remapProjectScopedState(this.currentProjectPath, remappedProjectPath);
      await this.loadProjectFromPath(remappedProjectPath, {
        notifyOnError: false,
        forceReload: true,
      });
      this.applySelectionToCurrentProject(selectedNodeIds);
      const remappedRawText = await this.readStudioProjectRawText(remappedProjectPath);
      if (remappedRawText != null) {
        this.currentProjectSession?.markAcceptedProjectText(remappedRawText);
      }
      this.projectLiveSyncWarning = null;
      this.host.render();
      this.host.refreshLeafDisplay();
      return;
    }

    const changed = await this.commitMutationAsync(
      "vault.sync",
      async (project) => {
        let nextChanged = false;
        const changedNodeIds = new Set<string>();
        if (this.host.isMarkdownVaultFile(file)) {
          for (const node of project.graph.nodes) {
            if (node.kind !== "studio.note") {
              continue;
            }
            if (this.host.normalizeNoteNodeConfig(node)) {
              nextChanged = true;
            }
            const existingItems = parseStudioNoteItems(node.config.notes).map((item) => ({
              path: item.path ? normalizePath(item.path) : "",
              enabled: item.enabled !== false,
            }));
            const remappedItems = existingItems.map((item) => ({
              path: item.path === previousPath ? normalizePath(file.path) : item.path,
              enabled: item.enabled,
            }));
            if (JSON.stringify(existingItems) === JSON.stringify(remappedItems)) {
              continue;
            }
            node.config.notes = serializeStudioNoteItems(remappedItems);
            const previousTitle = deriveStudioNoteTitleFromPath(previousPath);
            if (!node.title || node.title === "Note" || node.title === previousTitle) {
              node.title = (file as { basename?: string }).basename || node.title;
            }
            nextChanged = true;
            changedNodeIds.add(node.id);
          }
        } else if (this.host.isVaultFolder(file)) {
          const prefix = `${previousPath}/`;
          for (const node of project.graph.nodes) {
            if (node.kind !== "studio.note") {
              continue;
            }
            if (this.host.normalizeNoteNodeConfig(node)) {
              nextChanged = true;
            }
            const existingItems = parseStudioNoteItems(node.config.notes).map((item) => ({
              path: item.path ? normalizePath(item.path) : "",
              enabled: item.enabled !== false,
            }));
            const remappedItems = existingItems.map((item) => {
              if (!item.path.startsWith(prefix)) {
                return item;
              }
              const suffix = item.path.slice(prefix.length);
              return {
                path: normalizePath(`${file.path}/${suffix}`),
                enabled: item.enabled,
              };
            });
            if (JSON.stringify(existingItems) === JSON.stringify(remappedItems)) {
              continue;
            }
            node.config.notes = serializeStudioNoteItems(remappedItems);
            nextChanged = true;
            changedNodeIds.add(node.id);
          }
        }

        if (changedNodeIds.size > 0) {
          const hydrated = await this.host.refreshNoteNodePreviewsFromVault(project, {
            onlyNodeIds: changedNodeIds,
          });
          nextChanged = nextChanged || hydrated;
        }
        return nextChanged;
      },
      { captureHistory: false }
    );
    if (changed) {
      this.host.render();
    }
  }

  async handleVaultItemDeleted(file: TAbstractFile): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const deletedPath = normalizePath(String(file.path || "").trim());
    if (!deletedPath) {
      return;
    }
    if (
      deletedPath === this.currentProjectPath ||
      this.currentProjectPath.startsWith(`${deletedPath}/`)
    ) {
      await this.loadProjectFromPath(null, { notifyOnError: false });
      this.host.render();
      return;
    }

    const matchingNodeIds = new Set<string>();
    if (this.host.isMarkdownVaultFile(file)) {
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        if (!this.host.readAllNotePathsFromConfig(node).includes(deletedPath)) {
          continue;
        }
        matchingNodeIds.add(node.id);
      }
    } else if (this.host.isVaultFolder(file)) {
      const prefix = `${deletedPath}/`;
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        const hasMatch = this.host.readAllNotePathsFromConfig(node).some((path) =>
          path.startsWith(prefix)
        );
        if (!hasMatch) {
          continue;
        }
        matchingNodeIds.add(node.id);
      }
    }

    if (matchingNodeIds.size === 0) {
      return;
    }

    const changed = await this.commitMutationAsync(
      "vault.sync",
      async (project) =>
        await this.host.refreshNoteNodePreviewsFromVault(project, {
          onlyNodeIds: matchingNodeIds,
        }),
      { captureHistory: false }
    );
    if (!changed) {
      this.host.render();
      return;
    }
    this.host.render();
  }

  private async readStudioProjectRawText(projectPath: string): Promise<string | null> {
    const normalized = normalizePath(String(projectPath || "").trim());
    if (!normalized || !isStudioProjectPath(normalized)) {
      return null;
    }
    const adapter = this.host.app.vault.adapter as { read?: (path: string) => Promise<string> };
    if (typeof adapter.read !== "function") {
      return null;
    }
    try {
      return await adapter.read(normalized);
    } catch {
      return null;
    }
  }

  private async processCurrentProjectFileMutation(rawText: string): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath || !this.currentProjectSession) {
      return;
    }
    const update = this.currentProjectSession.resolveExternalProjectTextUpdate(rawText, {
      isActiveProjectFile: true,
    });
    if (update.decision.kind === "ignore" || update.decision.kind === "defer") {
      return;
    }

    const lintResult = this.host.plugin.getStudioService().lintProjectText(rawText);
    if (!lintResult.ok) {
      this.currentProjectSession.markRejectedProjectSignature(update.signature);
      this.projectLiveSyncWarning = `External .systemsculpt change rejected: ${lintResult.error}`;
      this.host.render();
      return;
    }

    const selectedNodeIds = this.host.graphInteraction.getSelectedNodeIds();
    await this.loadProjectFromPath(this.currentProjectPath, {
      notifyOnError: false,
      forceReload: true,
    });
    this.applySelectionToCurrentProject(selectedNodeIds);
    this.projectLiveSyncWarning = null;
    this.currentProjectSession?.markAcceptedProjectSignature(update.signature);
    this.host.setLastError(null);
    this.host.render();
  }

  private async processPendingExternalProjectSync(): Promise<void> {
    if (!this.currentProjectSession?.hasDeferredExternalSync()) {
      return;
    }
    if (!this.currentProjectPath || !this.currentProject) {
      this.currentProjectSession?.consumeDeferredExternalSync();
      return;
    }
    if (this.hasPendingLocalProjectSaveWork()) {
      return;
    }
    const rawText = await this.readStudioProjectRawText(this.currentProjectPath);
    this.currentProjectSession.consumeDeferredExternalSync();
    if (rawText == null) {
      return;
    }
    await this.processCurrentProjectFileMutation(rawText);
  }

  private async releaseRetainedProjectSession(): Promise<void> {
    const retainedPath = this.retainedProjectPath;
    this.retainedProjectPath = null;
    this.currentProjectSession = null;
    if (!retainedPath) {
      return;
    }
    try {
      await this.host.plugin.getStudioService().releaseProjectSession(retainedPath);
    } catch (error) {
      console.warn("[SystemSculpt Studio] Failed to release project session", {
        projectPath: retainedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applySelectionToCurrentProject(nodeIds: string[]): void {
    if (!this.currentProject) {
      return;
    }
    const nodeIdSet = new Set(this.currentProject.graph.nodes.map((node) => node.id));
    const nextSelection = nodeIds.filter((nodeId) => nodeIdSet.has(nodeId));
    this.host.graphInteraction.setSelectedNodeIds(nextSelection);
    this.host.setHistoryCurrentSnapshot(this.currentProject, nextSelection);
  }

  private remapProjectScopedState(previousPath: string, nextPath: string): void {
    this.graphViewStateByProjectPath = remapPathScopedRecord(
      this.graphViewStateByProjectPath,
      previousPath,
      nextPath
    );
    this.nodeDetailModeByProjectPath = remapPathScopedRecord(
      this.nodeDetailModeByProjectPath,
      previousPath,
      nextPath
    );
  }

  private resetLoadedProjectState(): void {
    this.currentProjectPath = null;
    this.currentProject = null;
    this.host.resetProjectHistory(null);
    this.host.graphInteraction.clearProjectState();
    this.host.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
    this.host.clearRunPresentation();
    this.pendingViewportState = null;
  }
}
