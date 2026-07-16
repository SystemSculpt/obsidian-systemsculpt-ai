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
    "clearProjectState" | "fitSelectedNodesInViewport" | "getGraphZoom" | "getSelectedNodeIds" | "setGraphZoom" | "setSelectedNodeIds"
  >;
  getGraphZoomMode: () => StudioGraphZoomMode;
  resetGraphZoomInteractionState: () => void;
  scheduleLayoutSave: () => void;
  requestLayoutSave: () => void;
  getGraphViewportElement: () => HTMLElement | null;
  captureProjectHistoryCheckpoint: () => void;
  resetProjectHistory: (project: StudioProjectV1 | null) => void;
  preserveProjectAsUndo: (project: StudioProjectV1, selectedNodeIds: string[]) => void;
  setHistoryCurrentSnapshot: (project: StudioProjectV1, selectedNodeIds: string[]) => void;
  clearProjectEditorState: () => void;
  clearRunPresentation: () => void;
  disposeTextNodeEditors: () => void;
  scheduleProjectFileRetry: (callback: () => void) => void;
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
  private projectFileWarning: string | null = null;
  private graphViewStateByProjectPath: StudioGraphViewStateByProject = {};
  private nodeDetailModeByProjectPath: StudioNodeDetailModeByProject = {};
  private pendingViewportState: StudioGraphViewportState | null = null;
  private projectFileMutationTail: Promise<void> = Promise.resolve();
  private projectBindingEpoch = 0;
  private projectFileRetryScheduled = false;
  private projectFileRetryCount = 0;
  private readFailureBlockedSession: StudioProjectSession | null = null;

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

  getProjectFileWarning(): string | null {
    return this.projectFileWarning;
  }

  hasPendingLocalProjectSaveWork(): boolean {
    return this.currentProjectSession?.hasPendingLocalSaveWork() === true;
  }

  markAcceptedProjectSignature(signature: string, options?: { trackExpectedWrite?: boolean }): void {
    this.currentProjectSession?.markAcceptedProjectSignature(signature, options);
  }

  clearProjectFileState(): void {
    this.projectFileWarning = null;
    this.currentProjectSession?.clearProjectFileState();
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

  restoreGraphViewportState(viewport: HTMLElement): boolean {
    const pending = this.pendingViewportState;
    this.pendingViewportState = null;
    const currentProjectPath = this.currentProjectPath;
    if (!currentProjectPath) {
      return false;
    }

    const restoredState = pending && pending.projectPath === currentProjectPath
      ? pending
      : getSavedGraphViewState(this.graphViewStateByProjectPath, currentProjectPath);
    if (!restoredState) {
      return false;
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
    return true;
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
      if (options?.showNotice) {
        new Notice("Studio graph saved.");
      }
    } catch (error) {
      this.host.setError(error);
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
    // A vault modify callback captures the changed file bytes before it is
    // queued. Let every already-observed project-file change finish while the
    // current session is still bound; otherwise advancing the epoch here would
    // make the queued handler discard the agent edit before the final canvas
    // flush/release runs.
    await this.drainProjectFileMutations();
    this.projectBindingEpoch += 1;
    this.projectFileRetryScheduled = false;
    this.projectFileRetryCount = 0;
    this.readFailureBlockedSession = null;
    this.captureGraphViewportState();
    this.host.requestLayoutSave();
    await this.flushTextNodeEditorsBeforeProjectTransition();
    await this.releaseRetainedProjectSession();
    this.host.resetProjectHistory(null);
    this.host.clearRunPresentation();
    this.clearProjectFileState();
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
    options?: {
      notifyOnError?: boolean;
      forceReload?: boolean;
      consumeBlockedRecovery?: boolean;
    }
  ): Promise<boolean> {
    // Same-path force reloads run inside the project-file mutation queue, so
    // waiting there would deadlock. A real path switch must first finish every
    // modify event already attached to the current binding.
    if (projectPath !== this.currentProjectPath) {
      await this.drainProjectFileMutations();
    }
    const previousSession = this.currentProjectSession;
    const previousRetainedPath = this.retainedProjectPath;
    const previousProjectPath = this.currentProjectPath;
    const isPathSwitch = projectPath !== this.currentProjectPath;
    const isSamePathFileReload = !isPathSwitch && options?.forceReload === true;
    const isProjectTransition = isPathSwitch || isSamePathFileReload;
    if (isPathSwitch) {
      this.projectBindingEpoch += 1;
      this.projectFileRetryScheduled = false;
      this.projectFileRetryCount = 0;
      this.readFailureBlockedSession = null;
    }
    if (isPathSwitch && this.currentProjectPath && this.currentProject) {
      await this.flushTextNodeEditorsBeforeProjectTransition();
    } else if (isSamePathFileReload && this.currentProjectPath && this.currentProject) {
      // A file reload is already authoritative. Commit any final editor text to
      // the in-memory snapshot only; the caller blocks project-file writes
      // before entering this path so the old canvas cannot overwrite the file.
      this.currentProjectSession?.blockProjectFileWrites();
      this.host.disposeTextNodeEditors();
    }

    if (isProjectTransition) {
      this.captureGraphViewportState();
      this.host.clearProjectEditorState();
    }

    if (!projectPath) {
      await this.releaseRetainedProjectSession();
      this.resetLoadedProjectState();
      this.clearProjectFileState();
      return true;
    }

    if (!isStudioProjectPath(projectPath)) {
      await this.releaseRetainedProjectSession();
      this.resetLoadedProjectState();
      this.clearProjectFileState();
      if (options?.notifyOnError !== false) {
        new Notice("Studio only opens .systemsculpt files.");
      }
      return false;
    }

    if (!options?.forceReload && this.currentProjectPath === projectPath && this.currentProject) {
      return true;
    }

    try {
      const studio = this.host.plugin.getStudioService();
      const session = await studio.retainProjectSession(projectPath, {
        forceReload: options?.forceReload,
      });
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

      try {
        await this.commitMutationAsync(
          "project.repair",
          async (currentProject) => repairStudioProjectForLoad(currentProject),
          { captureHistory: false }
        );
      } catch (repairError) {
        console.warn("[SystemSculpt Studio] Unable to apply optional project repairs", {
          projectPath,
          error: repairError instanceof Error ? repairError.message : String(repairError),
        });
      }

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

      try {
        await this.commitMutationAsync(
          "project.repair",
          async (currentProject) => await this.host.refreshNoteNodePreviewsFromVault(currentProject),
          { captureHistory: false }
        );
      } catch (previewError) {
        console.warn("[SystemSculpt Studio] Unable to refresh note previews on project load", {
          projectPath,
          error: previewError instanceof Error ? previewError.message : String(previewError),
        });
      }
      this.host.resetProjectHistory(project);
      if (options?.consumeBlockedRecovery !== false) {
        const blockedRecovery = await studio.consumeBlockedProjectRecovery(project.projectId, project);
        if (blockedRecovery) {
          this.host.preserveProjectAsUndo(blockedRecovery, []);
        }
      }
      const loadedRawText = await this.readStudioProjectRawText(projectPath);
      if (loadedRawText != null) {
        this.currentProjectSession?.markAcceptedProjectText(loadedRawText);
      } else {
        this.currentProjectSession?.clearProjectFileState();
      }
      this.projectFileWarning = null;
      this.host.setLastError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        options?.forceReload === true &&
        previousSession &&
        previousRetainedPath &&
        previousProjectPath
      ) {
        this.currentProjectSession = previousSession;
        this.retainedProjectPath = previousRetainedPath;
        this.currentProjectPath = previousProjectPath;
        this.currentProject = previousSession.getProject();
        this.host.setLastError(message);
        this.host.render();
        if (options?.notifyOnError !== false) {
          this.host.setError(error);
        }
        return false;
      }
      await this.releaseRetainedProjectSession();
      this.resetLoadedProjectState();
      this.clearProjectFileState();
      this.host.setLastError(message);
      if (options?.notifyOnError !== false) {
        this.host.setError(error);
      }
      return false;
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
      const bindingEpoch = this.projectBindingEpoch;
      // Start the read immediately so an observed agent edit is not lost if a
      // competing in-flight save settles before its queued handler runs.
      const rawTextPromise = this.readStudioProjectRawText(modifiedPath);
      const operation = this.projectFileMutationTail.then(async () => {
        if (bindingEpoch !== this.projectBindingEpoch || modifiedPath !== this.currentProjectPath) {
          return;
        }
        const rawText = await rawTextPromise;
        if (
          rawText != null &&
          bindingEpoch === this.projectBindingEpoch &&
          modifiedPath === this.currentProjectPath
        ) {
          await this.processCurrentProjectFileMutation(rawText);
        } else if (
          rawText == null &&
          bindingEpoch === this.projectBindingEpoch &&
          modifiedPath === this.currentProjectPath
        ) {
          const session = this.currentProjectSession;
          session?.blockProjectFileWrites();
          this.readFailureBlockedSession = session;
          this.projectFileWarning = "Studio couldn't read the changed file yet. Studio will retry automatically; the file has not been overwritten.";
          this.host.render();
          this.scheduleProjectFileRetry(modifiedPath, bindingEpoch);
        }
      });
      this.projectFileMutationTail = operation.catch((error) => {
        console.warn("[SystemSculpt Studio] Unable to reload the changed project file", {
          projectPath: modifiedPath,
          error: error instanceof Error ? error.message : String(error),
        });
        this.host.setError(error);
        if (bindingEpoch === this.projectBindingEpoch && modifiedPath === this.currentProjectPath) {
          const session = this.currentProjectSession;
          session?.blockProjectFileWrites();
          this.readFailureBlockedSession = session;
          this.projectFileWarning = "Studio couldn't reload the changed file yet. Studio will retry automatically; the file has not been overwritten.";
          this.host.render();
          this.scheduleProjectFileRetry(modifiedPath, bindingEpoch);
        }
      });
      await this.projectFileMutationTail;
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
      await this.adoptCurrentProjectPathRename(previousPath, renamedPath, selectedNodeIds);
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
      await this.adoptCurrentProjectPathRename(
        this.currentProjectPath,
        remappedProjectPath,
        selectedNodeIds
      );
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

  private async replaceStudioProjectRawTextIfUnchanged(
    projectPath: string,
    expectedRawText: string,
    nextRawText: string
  ): Promise<boolean> {
    const adapter = this.host.app.vault.adapter as {
      process?: (path: string, update: (current: string) => string) => Promise<string>;
    };
    if (typeof adapter.process !== "function") {
      return false;
    }
    let matched = false;
    await adapter.process(projectPath, (current) => {
      if (current !== expectedRawText) return current;
      matched = true;
      return nextRawText;
    });
    return matched;
  }

  private async drainProjectFileMutations(): Promise<void> {
    // A second modify event may append itself while the first one is settling.
    // Keep draining until the tail we awaited is still the current tail. The
    // equality check and the caller's subsequent epoch increment execute in
    // the same JavaScript turn, so no observed event can slip between them.
    while (true) {
      const pending = this.projectFileMutationTail;
      await pending;
      if (pending === this.projectFileMutationTail) {
        return;
      }
    }
  }

  private scheduleProjectFileRetry(projectPath: string, bindingEpoch: number): void {
    if (this.projectFileRetryScheduled) {
      return;
    }
    if (this.projectFileRetryCount >= 8) {
      this.projectFileWarning = "Studio still can't read this changed file. The file has not been overwritten. Edit the file or reopen Studio to retry.";
      this.host.render();
      return;
    }
    this.projectFileRetryScheduled = true;
    this.projectFileRetryCount += 1;
    this.host.scheduleProjectFileRetry(() => {
      this.projectFileRetryScheduled = false;
      if (bindingEpoch !== this.projectBindingEpoch || projectPath !== this.currentProjectPath) {
        return;
      }
      void this.handleVaultItemModified({ path: projectPath } as TAbstractFile);
    });
  }

  private async processCurrentProjectFileMutation(rawText: string): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath || !this.currentProjectSession) {
      return;
    }
    const session = this.currentProjectSession;
    const projectPath = this.currentProjectPath;
    const update = session.resolveProjectFileTextUpdate(rawText, {
      isActiveProjectFile: true,
    });
    if (update.decision.kind === "ignore") {
      if (update.decision.reason === "duplicate_accepted") {
        const acceptedProject = session.getProject();
        if (acceptedProject !== this.currentProject) {
          const previousNodeIds = new Set(this.currentProject.graph.nodes.map((node) => node.id));
          const selectedNodeIds = this.host.graphInteraction.getSelectedNodeIds();
          this.currentProject = acceptedProject;
          const addedNodeIds = acceptedProject.graph.nodes
            .map((node) => node.id)
            .filter((nodeId) => !previousNodeIds.has(nodeId));
          this.applySelectionToCurrentProject(addedNodeIds.length > 0 ? addedNodeIds : selectedNodeIds);
          this.projectFileWarning = null;
          this.host.setLastError(null);
          this.host.render();
          if (addedNodeIds.length > 0) {
            const viewport = this.host.getGraphViewportElement();
            if (viewport) {
              requestStudioAnimationFrame(viewport, () => {
                this.host.graphInteraction.fitSelectedNodesInViewport();
              });
            }
          }
        }
        if (this.readFailureBlockedSession === session) {
          session.resumeProjectFileWrites();
          this.readFailureBlockedSession = null;
          this.projectFileWarning = null;
          this.projectFileRetryCount = 0;
          this.host.render();
        }
      } else if (update.decision.reason === "duplicate_rejected") {
        session.blockProjectFileWrites();
        const lintResult = this.host.plugin.getStudioService().lintProjectText(rawText);
        const detail = lintResult.ok ? "The file is not a valid Studio project." : lintResult.error;
        this.projectFileWarning = `Studio couldn't read this file: ${detail} Fix the file and Studio will update automatically.`;
        this.projectFileRetryCount = 0;
        this.host.render();
      } else if (
        update.decision.reason === "self_write" &&
        this.readFailureBlockedSession === session
      ) {
        session.resumeProjectFileWrites();
        this.readFailureBlockedSession = null;
        this.projectFileWarning = null;
        this.projectFileRetryCount = 0;
        this.host.render();
      }
      return;
    }
    // From this point onward the file is authoritative. Stop every queued or
    // future canvas write before waiting for a save that may already be in
    // flight. The persistence layer's final CAS prevents that save from
    // overwriting these bytes.
    session.blockProjectFileWrites();
    try {
      await session.waitForInFlightSave();
    } catch {
      // A normal file-wins race rejects the competing canvas save. Continue by
      // loading the file instead of surfacing an unhandled save error.
    }
    if (this.currentProjectSession !== session || this.currentProjectPath !== projectPath) {
      return;
    }

    let candidateRawText = rawText;
    let latestRawText = await this.readStudioProjectRawText(projectPath);
    if (latestRawText != null && latestRawText !== candidateRawText) {
      if (session.matchesLastAcceptedProjectText(latestRawText)) {
        const restored = await this.replaceStudioProjectRawTextIfUnchanged(
          projectPath,
          latestRawText,
          candidateRawText
        );
        if (!restored) {
          latestRawText = await this.readStudioProjectRawText(projectPath);
          if (latestRawText != null) candidateRawText = latestRawText;
        }
      } else {
        candidateRawText = latestRawText;
      }
    }
    const candidateUpdate = candidateRawText === rawText
      ? update
      : session.resolveProjectFileTextUpdate(candidateRawText, { isActiveProjectFile: true });
    const studio = this.host.plugin.getStudioService();
    const lintResult = studio.lintProjectText(candidateRawText);
    if (!lintResult.ok) {
      session.markRejectedProjectSignature(candidateUpdate.signature);
      this.projectFileWarning = `Studio couldn't read this file: ${lintResult.error} Fix the file and Studio will update automatically.`;
      this.projectFileRetryCount = 0;
      this.host.render();
      return;
    }

    // Text-editor disposal commits the last keystroke into the blocked session,
    // so it is preserved in Undo without ever being written over the file.
    this.host.disposeTextNodeEditors();
    const previousProject = session.hasPendingLocalSaveWork()
      ? session.getProjectSnapshot()
      : null;
    if (previousProject) {
      try {
        // Persist the losing canvas before replacing the shared session. If
        // this write fails, the transition remains blocked and close cannot
        // discard the only remaining in-memory copy.
        await studio.preserveProjectRecovery(previousProject);
      } catch (recoveryError) {
        const detail = recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
        this.projectFileWarning = `Studio couldn't preserve the current canvas before loading this file: ${detail} The file has not been overwritten; Studio will retry automatically.`;
        this.host.setLastError(detail);
        this.host.render();
        this.scheduleProjectFileRetry(projectPath, this.projectBindingEpoch);
        return;
      }
    }
    const previousNodeIds = new Set(this.currentProject.graph.nodes.map((node) => node.id));
    const selectedNodeIds = this.host.graphInteraction.getSelectedNodeIds();
    let loaded = false;
    for (let attempt = 0; attempt < 2 && !loaded; attempt += 1) {
      loaded = await this.loadProjectFromPath(projectPath, {
        notifyOnError: false,
        forceReload: true,
        // The recovery written immediately above must survive this in-place
        // reload and remain available after the view closes. It is consumed
        // on the next ordinary open; this view gets the same snapshot in Undo.
        consumeBlockedRecovery: false,
      });
    }
    if (!loaded || !this.currentProject) {
      this.projectFileWarning = "Studio couldn't reload this file yet. Studio will retry automatically; the file has not been overwritten.";
      this.host.render();
      this.scheduleProjectFileRetry(projectPath, this.projectBindingEpoch);
      return;
    }
    const addedNodeIds = this.currentProject?.graph.nodes
      .map((node) => node.id)
      .filter((nodeId) => !previousNodeIds.has(nodeId)) || [];
    this.applySelectionToCurrentProject(addedNodeIds.length > 0 ? addedNodeIds : selectedNodeIds);
    if (previousProject) {
      this.host.preserveProjectAsUndo(previousProject, selectedNodeIds);
    }
    this.projectFileWarning = null;
    this.projectFileRetryCount = 0;
    this.readFailureBlockedSession = null;
    this.currentProjectSession?.markAcceptedProjectSignature(candidateUpdate.signature);
    this.host.setLastError(null);
    this.host.render();
    if (addedNodeIds.length > 0) {
      const viewport = this.host.getGraphViewportElement();
      if (viewport) {
        requestStudioAnimationFrame(viewport, () => {
          this.host.graphInteraction.fitSelectedNodesInViewport();
        });
      }
    }
  }

  private async releaseRetainedProjectSession(): Promise<void> {
    const retainedPath = this.retainedProjectPath;
    const retainedSession = this.currentProjectSession;
    if (!retainedPath) {
      this.currentProjectSession = null;
      return;
    }
    try {
      await this.host.plugin.getStudioService().releaseProjectSession(retainedPath);
    } catch (error) {
      console.warn("[SystemSculpt Studio] Failed to release project session", {
        projectPath: retainedPath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.retainedProjectPath = retainedPath;
      this.currentProjectSession = retainedSession;
      throw error;
    }
    this.retainedProjectPath = null;
    this.currentProjectSession = null;
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

  private async adoptCurrentProjectPathRename(
    previousPath: string,
    nextPath: string,
    selectedNodeIds: string[]
  ): Promise<boolean> {
    try {
      const renamed = await this.host.plugin
        .getStudioService()
        .adoptVisibleProjectRename(previousPath, nextPath);
      this.projectBindingEpoch += 1;
      this.projectFileRetryScheduled = false;
      this.projectFileRetryCount = 0;
      this.readFailureBlockedSession = null;
      this.remapProjectScopedState(previousPath, nextPath);
      this.currentProjectPath = renamed.newPath;
      this.retainedProjectPath = renamed.newPath;
      this.currentProject = renamed.project;
      this.host.resetProjectHistory(renamed.project);
      this.applySelectionToCurrentProject(selectedNodeIds);
      if (renamed.replacedCanvasProject) {
        this.host.preserveProjectAsUndo(renamed.replacedCanvasProject, selectedNodeIds);
      }
      const renamedRawText = await this.readStudioProjectRawText(renamed.newPath);
      if (renamedRawText != null) {
        this.currentProjectSession?.markAcceptedProjectText(renamedRawText);
      }
      this.projectFileWarning = null;
      this.host.setLastError(null);
      this.host.render();
      this.host.refreshLeafDisplay();
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.projectFileWarning = `Studio couldn't finish loading the renamed project yet: ${detail} The file has not been overwritten.`;
      this.host.setLastError(detail);
      this.host.render();
      return false;
    }
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
