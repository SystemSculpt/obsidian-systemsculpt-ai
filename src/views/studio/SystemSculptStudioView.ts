import {
  EventRef,
  ItemView,
  MarkdownRenderer,
  Notice,
  normalizePath,
  Platform,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import type SystemSculptPlugin from "../../main";
import { randomId } from "../../studio/utils";
import type {
  StudioAssetRef,
  StudioJsonValue,
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioNodeOutputMap,
  StudioProjectV1,
  StudioRunEvent,
} from "../../studio/types";
import { isStudioVisualOnlyNodeKind } from "../../studio/StudioNodeKinds";
import { scopeProjectForRun } from "../../studio/StudioRunScope";
import { validateNodeConfig } from "../../studio/StudioNodeConfigValidation";
import { resolveNodeDefinitionPorts } from "../../studio/StudioNodePortResolution";
import {
  collectStudioHostUnavailableNodes,
  formatStudioHostUnavailableNodesNotice,
  resolveStudioNodeHostAvailability,
} from "../../studio/StudioHostCapabilities";
import type {
  StudioProjectSessionAutosaveMode,
  StudioProjectSessionMutationReason,
} from "../../studio/StudioProjectSession";
import { renderStudioGraphWorkspace } from "./graph-v3/StudioGraphWorkspaceRenderer";
import type { StudioNodeConfigPathBrowseOptions } from "./StudioPathFieldPicker";
import { createEmbeddableMarkdownEditor } from "../../editor/embeddable-markdown-editor";
import type {
  StudioTextNodeMarkdownEditorFactory,
  StudioTextNodeMarkdownEditorSnapshot,
} from "./graph-v3/StudioGraphTextNodeCard";
import type { StudioTextNodeFocusTarget } from "./graph-v3/StudioGraphTextNodeFocus";
import {
  createGroupFromSelection as createNodeGroupFromSelection,
  removeNodesFromGroups,
} from "../../studio/StudioGraphGroupModel";
import { computeStudioGraphGroupBounds } from "./graph-v3/StudioGraphGroupBounds";
import {
  openStudioMediaPreviewModal,
  resolveStudioAssetPreviewSrc,
} from "./graph-v3/StudioGraphMediaPreviewModal";
import { openStudioImageEditorModal } from "./graph-v3/StudioGraphImageEditorModal";
import { composeStudioCaptionBoardImage } from "../../studio/StudioCaptionBoardComposition";
import {
  boardStateHasRenderableEdits,
  readStudioCaptionBoardState,
  resolveStudioCaptionBoardRenderedAsset,
  writeStudioCaptionBoardState,
} from "../../studio/StudioCaptionBoardState";
import {
  normalizeGraphCoordinate,
  normalizeGraphZoom,
} from "./graph-v3/StudioGraphViewStateStore";
import {
  STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY,
  type StudioNodeDetailMode,
} from "./graph-v3/StudioGraphNodeDetailMode";
import type { StudioGraphNodeResizePatch } from "./graph-v3/StudioGraphNodeCardTypes";
import { readStudioTextNodeValue } from "./graph-v3/StudioGraphTextNodeCard";
import {
  clampStudioNodeDimension,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
  STUDIO_GRAPH_DEFAULT_NODE_HEIGHT,
  STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
  STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
  STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
} from "../../studio/StudioNodeGeometry";
import { StudioGraphInteractionEngine } from "./StudioGraphInteractionEngine";
import {
  STUDIO_GRAPH_DEFAULT_ZOOM,
  type ConnectionAutoCreateDescriptor,
  type ConnectionAutoCreateRequest,
  type StudioGraphZoomChangeContext,
  type StudioGraphZoomMode,
} from "./StudioGraphInteractionTypes";
import { StudioNodeContextMenuOverlay } from "./StudioNodeContextMenuOverlay";
import { StudioSimpleContextMenuOverlay } from "./StudioSimpleContextMenuOverlay";
import { StudioRunPresentationState } from "./StudioRunPresentationState";
import {
  buildNodeInsertMenuItems,
  cloneConfigDefaults,
  definitionKey,
  formatNodeConfigPreview,
  prettifyNodeKind,
} from "./StudioViewHelpers";
import { removePendingManagedOutputNodes } from "../../studio/StudioManagedOutputNodes";
import { isStudioGraphEditableTarget } from "./StudioGraphDomTargeting";
import {
  getStudioOwnerDocument,
  getStudioOwnerWindow,
} from "./StudioDomContext";
import { tryCopyImageFileToClipboard, tryCopyToClipboard } from "../../utils/clipboard";
import { isAbsoluteFilesystemPath, resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import { resolveStudioViewTitle } from "./studio-view-title";
import {
  deriveStudioNoteTitleFromPath,
  ensureStudioNoteConfigItems,
  parseStudioNoteItems,
  readAllStudioNotePaths,
  readEnabledStudioNoteItems,
  readPrimaryStudioNotePath,
  serializeStudioNoteItems,
  type StudioNoteConfigItem,
} from "../../studio/StudioNoteConfig";
import {
  cloneProjectSnapshot,
  normalizeNodeIdList,
  serializeProjectSnapshot,
  type StudioGraphHistorySnapshot,
} from "./systemsculpt-studio-view/StudioGraphClipboardModel";
import {
  consumeStudioGraphRedoSnapshot,
  consumeStudioGraphUndoSnapshot,
  createStudioGraphHistoryState,
  resetStudioGraphHistory,
  setStudioGraphHistoryCurrentSnapshot,
  captureStudioGraphHistoryCheckpoint,
} from "./systemsculpt-studio-view/StudioGraphHistoryState";
import {
  StudioClipboardAndDropController,
  type StudioCreatedNodesFinalization,
} from "./systemsculpt-studio-view/StudioClipboardAndDropController";
import {
  inferAiImageEditAspectRatio,
  insertAiImageEditNode,
} from "./systemsculpt-studio-view/StudioAiImageEditFlow";
import {
  isTextGenerationOutputLocked,
  resolveTextGenerationOutputSnapshot,
} from "./systemsculpt-studio-view/StudioPromptBundleUtils";
import {
  composeTextGenerationPromptBundle,
  resolvePromptBundleNodeSource,
} from "./systemsculpt-studio-view/StudioPromptBundleComposer";
import {
  materializeManagedOutputNodesForNodeOutput,
  materializeManagedOutputNodesFromCacheEntries,
  materializeManagedOutputPlaceholdersForStartedNode,
  syncDatasetOutputFieldsToProjectNodeConfig,
  syncInlineTextOutputToProjectNodeConfig,
} from "../../studio/StudioRunOutputProjectors";
import {
  StudioProjectSessionController,
  type StudioProjectScopedViewState,
} from "./systemsculpt-studio-view/StudioProjectSessionController";
import { SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { applyPluginSurface } from "../../core/ui/surface";

const GROUP_DISCONNECT_OFFSET_X = 36;
const STUDIO_GRAPH_HISTORY_MAX_SNAPSHOTS = 120;
const STUDIO_GRAPH_SELECTION_FIT_PADDING_PX = 25;

type SystemSculptStudioViewState = StudioProjectScopedViewState;

type StudioRunGraphOptions = {
  fromNodeId?: string;
};

export class SystemSculptStudioView extends ItemView {
  private busy = false;
  private lastError: string | null = null;
  private nodeDefinitions: StudioNodeDefinition[] = [];
  private nodeDefinitionsByKey = new Map<string, StudioNodeDefinition>();
  private layoutSaveTimer: number | null = null;
  private layoutSaveTimerWindow: Window | null = null;
  private viewportScrollCaptureFrame: number | null = null;
  private viewportScrollCaptureWindow: Window | null = null;
  private viewportScrollingClassTimer: number | null = null;
  private viewportScrollingClassTimerWindow: Window | null = null;
  private listenerWindow: Window | null = null;
  private detachWindowMigration: (() => void) | null = null;
  private graphViewportEl: HTMLElement | null = null;
  private nodeContextMenuOverlay: StudioNodeContextMenuOverlay | null = null;
  private nodeActionContextMenuOverlay: StudioSimpleContextMenuOverlay | null = null;
  private nodeDragInProgress = false;
  private editingTextNodeIds = new Set<string>();
  /** Text changes stay continuous while typing, then become one undo step on edit end. */
  private dirtyTextNodeEditIds = new Set<string>();
  private pendingTextNodeAutofocusNodeId: string | null = null;
  private pendingTextNodeFocusPointByNodeId = new Map<string, StudioTextNodeFocusTarget>();
  /**
   * Live embedded markdown editors keyed by text-node id. Each graph render
   * rebuilds card DOM wholesale, so every mounted editor registers a teardown
   * here and `disposeTextNodeEditors` runs before the DOM is dropped —
   * CodeMirror views must be destroyed, not garbage-collected.
   */
  private textNodeEditorTeardowns = new Map<
    string,
    () => StudioTextNodeMarkdownEditorSnapshot
  >();
  private textNodeEditorSnapshots = new Map<
    string,
    StudioTextNodeMarkdownEditorSnapshot
  >();
  private readonly runPresentation = new StudioRunPresentationState();
  private readonly graphInteraction: StudioGraphInteractionEngine;
  private readonly clipboardAndDropController: StudioClipboardAndDropController;
  private readonly projectSessionController: StudioProjectSessionController;
  private graphZoomMode: StudioGraphZoomMode = "interactive";
  private graphZoomGestureInFlight = false;
  private vaultEventRefs: EventRef[] = [];
  private readonly historyState = createStudioGraphHistoryState();
  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    this.handleWindowKeyDown(event);
  };

  private get currentProject(): StudioProjectV1 | null {
    return this.projectSessionController.getProject();
  }

  private get currentProjectPath(): string | null {
    return this.projectSessionController.getProjectPath();
  }

  private get currentProjectSession() {
    return this.projectSessionController.getProjectSession();
  }

  private get projectLiveSyncWarning(): string | null {
    return this.projectSessionController.getProjectLiveSyncWarning();
  }

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SystemSculptPlugin
  ) {
    super(leaf);
    this.graphInteraction = new StudioGraphInteractionEngine({
      isBusy: () => this.busy,
      getCurrentProject: () => this.currentProject,
      setError: (error) => this.setError(error),
      recomputeEntryNodes: (project) => this.recomputeEntryNodes(project),
      commitProjectMutation: (reason, mutator, options) =>
        this.projectSessionController.commitMutation(reason, mutator, options),
      requestRender: () => this.render(),
      onNodeDragStateChange: (isDragging) => this.handleNodeDragStateChange(isDragging),
      onSelectionResize: (patches, options) => this.handleSelectionResize(patches, options),
      onGraphZoomChanged: (zoom, context) => this.handleGraphZoomChanged(zoom, context),
      getPortType: (nodeId, direction, portId) => this.getPortType(nodeId, direction, portId),
      portTypeCompatible: (sourceType, targetType) => this.portTypeCompatible(sourceType, targetType),
      describeConnectionAutoCreate: (sourceType) => this.describeConnectionAutoCreate(sourceType),
      onConnectionAutoCreateRequested: (request) => this.handleConnectionAutoCreateRequested(request),
    });
    this.projectSessionController = new StudioProjectSessionController({
      app: this.app,
      plugin: this.plugin,
      graphInteraction: this.graphInteraction,
      getGraphZoomMode: () => this.graphZoomMode,
      resetGraphZoomInteractionState: () => {
        this.graphZoomMode = "interactive";
        this.graphZoomGestureInFlight = false;
      },
      scheduleLayoutSave: () => this.scheduleLayoutSave(),
      requestLayoutSave: () => this.app.workspace.requestSaveLayout(),
      getGraphViewportElement: () => this.graphViewportEl,
      captureProjectHistoryCheckpoint: () => this.captureProjectHistoryCheckpoint(),
      resetProjectHistory: (project) => this.resetProjectHistory(project),
      setHistoryCurrentSnapshot: (project, selectedNodeIds) =>
        this.setHistoryCurrentSnapshot(project, selectedNodeIds),
      clearProjectEditorState: () => this.clearProjectEditorState(),
      clearRunPresentation: () => this.runPresentation.reset(),
      disposeTextNodeEditors: () => this.disposeTextNodeEditors(),
      hydrateProjectCache: async (projectPath, project) => {
        const cacheSnapshot = await this.plugin.getStudioService().getProjectNodeCache(projectPath);
        if (cacheSnapshot) {
          this.runPresentation.hydrateFromCache(cacheSnapshot.entries, {
            allowedNodeIds: project.graph.nodes.map((node) => node.id),
          });
        }
        return cacheSnapshot;
      },
      materializeManagedOutputNodesFromCache: (entries) =>
        this.materializeManagedOutputNodesFromCache(entries),
      refreshNoteNodePreviewsFromVault: (project, options) =>
        this.refreshNoteNodePreviewsFromVault(project, options),
      setError: (error) => this.setError(error),
      setLastError: (message) => {
        this.lastError = message;
      },
      render: () => this.render(),
      refreshLeafDisplay: () => this.refreshLeafDisplay(),
      isMarkdownVaultFile: (file) => this.isMarkdownVaultFile(file || null),
      isVaultFolder: (file) => this.isVaultFolder(file || null),
      readAllNotePathsFromConfig: (node) => this.readAllNotePathsFromConfig(node),
      normalizeNoteNodeConfig: (node) => this.normalizeNoteNodeConfig(node),
    });
    this.clipboardAndDropController = new StudioClipboardAndDropController(this.app, {
      isActive: () => this.isActiveStudioView(),
      isBusy: () => this.busy,
      isEditableTarget: (target) => this.isEditableKeyboardTarget(target),
      getCurrentProject: () => this.currentProject,
      getProjectPath: () => this.currentProjectPath,
      getNodeDefinitions: () => this.nodeDefinitions,
      getSelectedNodeIds: () => this.graphInteraction.getSelectedNodeIds(),
      getGraphZoom: () => this.graphInteraction.getGraphZoom(),
      getDefaultNodePosition: (project) => this.computeDefaultNodePosition(project),
      normalizeNodePosition: (position) => this.normalizeNodePosition(position),
      commitNodeCreation: (mutator) =>
        this.projectSessionController.commitMutation("graph.node.create", mutator),
      finalizeCreatedNodes: (project, options) =>
        this.finalizeClipboardCreatedNodes(project, options),
      removeNodes: (nodeIds) => this.removeNodes(nodeIds),
      insertVaultNoteNodes: (notePaths, anchor, source) =>
        this.insertVaultNoteNodes(notePaths, anchor, { source }),
      storeAsset: (projectPath, bytes, mimeType) =>
        this.plugin.getStudioService().storeAsset(projectPath, bytes, mimeType),
      setError: (error) => this.setError(error),
    });
  }

  getViewType(): string {
    return SYSTEMSCULPT_STUDIO_VIEW_TYPE;
  }

  getDisplayText(): string {
    return resolveStudioViewTitle(this.currentProjectPath);
  }

  getIcon(): string {
    return "bot";
  }

  getState(): Record<string, unknown> {
    this.projectSessionController.captureGraphViewportState();
    return this.projectSessionController.serializePersistentState();
  }

  async setState(state: unknown, result: any): Promise<void> {
    await super.setState(state, result);
    const rawState = (state || {}) as SystemSculptStudioViewState;
    const filePath = this.projectSessionController.restorePersistentState(rawState);
    await this.projectSessionController.loadProjectFromPath(filePath || null, {
      notifyOnError: false,
    });
    this.render();
  }

  async onOpen(): Promise<void> {
    this.bindOwnerWindowEvents(getStudioOwnerWindow(this.contentEl));
    this.detachWindowMigration?.();
    this.detachWindowMigration = this.contentEl.onWindowMigrated((ownerWindow) => {
      this.bindOwnerWindowEvents(ownerWindow);
      this.render();
    });
    this.bindVaultEvents();
    await this.loadNodeDefinitions();
    this.render();
  }

  async onClose(): Promise<void> {
    this.detachWindowMigration?.();
    this.detachWindowMigration = null;
    this.unbindOwnerWindowEvents();
    this.unbindVaultEvents();
    this.clipboardAndDropController.dispose();
    this.clearLayoutSaveTimer();
    this.resetViewportScrollingState();
    await this.projectSessionController.close();
    this.nodeContextMenuOverlay?.destroy();
    this.nodeContextMenuOverlay = null;
    this.nodeActionContextMenuOverlay?.destroy();
    this.nodeActionContextMenuOverlay = null;
    this.graphViewportEl = null;
    this.graphInteraction.clearRenderBindings();
    this.contentEl.empty();
  }

  private unbindOwnerWindowEvents(): void {
    this.listenerWindow?.removeEventListener("keydown", this.onWindowKeyDown, true);
    this.clipboardAndDropController.unbindOwnerWindow();
    this.listenerWindow = null;
  }

  private bindOwnerWindowEvents(ownerWindow: Window): void {
    if (this.listenerWindow === ownerWindow) {
      return;
    }
    this.unbindOwnerWindowEvents();
    ownerWindow.addEventListener("keydown", this.onWindowKeyDown, true);
    this.clipboardAndDropController.bindOwnerWindow(ownerWindow);
    this.listenerWindow = ownerWindow;
  }

  private bindVaultEvents(): void {
    if (this.vaultEventRefs.length > 0) {
      return;
    }
    this.vaultEventRefs.push(
      this.app.vault.on("modify", (file) => {
        void this.projectSessionController.handleVaultItemModified(file);
      })
    );
    this.vaultEventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.projectSessionController.handleVaultItemRenamed(file, oldPath);
      })
    );
    this.vaultEventRefs.push(
      this.app.vault.on("delete", (file) => {
        void this.projectSessionController.handleVaultItemDeleted(file);
      })
    );
  }

  private unbindVaultEvents(): void {
    for (const ref of this.vaultEventRefs) {
      try {
        this.app.vault.offref(ref);
      } catch {
        // Best effort cleanup.
      }
    }
    this.vaultEventRefs = [];
  }

  private isEditableKeyboardTarget(target: EventTarget | null): boolean {
    return isStudioGraphEditableTarget(target);
  }

  private isActiveStudioView(): boolean {
    return this.app.workspace.getActiveViewOfType(SystemSculptStudioView) === this;
  }

  private setHistoryCurrentSnapshot(project: StudioProjectV1, selectedNodeIds: string[]): void {
    setStudioGraphHistoryCurrentSnapshot(this.historyState, project, selectedNodeIds);
  }

  private resetProjectHistory(project: StudioProjectV1 | null, options?: { selectedNodeIds?: string[] }): void {
    resetStudioGraphHistory(this.historyState, project, options);
  }

  private clearProjectEditorState(): void {
    this.editingTextNodeIds.clear();
    this.dirtyTextNodeEditIds.clear();
    this.pendingTextNodeAutofocusNodeId = null;
    this.pendingTextNodeFocusPointByNodeId.clear();
    this.textNodeEditorSnapshots.clear();
  }

  private captureProjectHistoryCheckpoint(): void {
    if (!this.currentProject) {
      return;
    }
    captureStudioGraphHistoryCheckpoint(
      this.historyState,
      this.currentProject,
      this.graphInteraction.getSelectedNodeIds(),
      STUDIO_GRAPH_HISTORY_MAX_SNAPSHOTS
    );
  }

  private applyHistorySnapshot(snapshot: StudioGraphHistorySnapshot): void {
    if (!this.currentProjectPath || !this.currentProjectSession) {
      return;
    }

    const nextProject = cloneProjectSnapshot(snapshot.project);
    const nextNodeIdSet = new Set(nextProject.graph.nodes.map((node) => node.id));
    const nextSelection = normalizeNodeIdList(snapshot.selectedNodeIds).filter((nodeId) =>
      nextNodeIdSet.has(nodeId)
    );

    this.currentProjectSession.replaceProjectSnapshot(nextProject, {
      projectPath: this.currentProjectPath,
      notifyListeners: false,
    });
    this.currentProjectSession.schedulePersist({ mode: "discrete", reason: "history.apply" });
    this.projectSessionController.syncProjectFromSession();
    this.runPresentation.reset();
    this.editingTextNodeIds.clear();
    this.dirtyTextNodeEditIds.clear();
    this.pendingTextNodeAutofocusNodeId = null;
    this.pendingTextNodeFocusPointByNodeId.clear();
    this.textNodeEditorSnapshots.clear();
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.graphInteraction.clearPendingConnection({ requestRender: false });
    this.graphInteraction.clearProjectState();
    const currentProject = this.currentProject;
    if (!currentProject) {
      return;
    }
    this.recomputeEntryNodes(currentProject);
    this.setHistoryCurrentSnapshot(currentProject, nextSelection);
    this.render();
    this.graphInteraction.setSelectedNodeIds(nextSelection);
    void this.commitCurrentProjectMutationAsync(
      "history.apply",
      async (project) => await this.refreshNoteNodePreviewsFromVault(project),
      { captureHistory: false }
    ).then(() => {
      this.render();
    });
  }

  private undoGraphHistory(): boolean {
    if (this.busy || !this.currentProject || !this.historyState.currentSnapshot) {
      return false;
    }
    const targetSnapshot = consumeStudioGraphUndoSnapshot(
      this.historyState,
      STUDIO_GRAPH_HISTORY_MAX_SNAPSHOTS
    );
    if (!targetSnapshot) {
      return false;
    }
    this.applyHistorySnapshot(targetSnapshot);
    return true;
  }

  private redoGraphHistory(): boolean {
    if (this.busy || !this.currentProject || !this.historyState.currentSnapshot) {
      return false;
    }
    const targetSnapshot = consumeStudioGraphRedoSnapshot(
      this.historyState,
      STUDIO_GRAPH_HISTORY_MAX_SNAPSHOTS
    );
    if (!targetSnapshot) {
      return false;
    }
    this.applyHistorySnapshot(targetSnapshot);
    return true;
  }

  private toggleTextGenerationOutputLock(nodeId: string): void {
    if (!this.currentProject) {
      new Notice("Open a Studio project first.");
      return;
    }

    const node = this.currentProject.graph.nodes.find((entry) => entry.id === nodeId);
    if (!node || node.kind !== "studio.text_generation") {
      new Notice("Output lock is only available for text generation nodes.");
      return;
    }

    if (isTextGenerationOutputLocked(node)) {
      const changed = this.commitCurrentProjectMutation("node.config", (project) => {
        const target = this.findNode(project, nodeId);
        if (!target || target.kind !== "studio.text_generation") {
          return false;
        }
        delete target.config.lockOutput;
        return true;
      });
      if (!changed) {
        return;
      }
      this.render();
      new Notice("Text generation output unlocked.");
      return;
    }

    const runtimeText =
      typeof this.runPresentation.getNodeState(node.id).outputs?.text === "string"
        ? String(this.runPresentation.getNodeState(node.id).outputs?.text || "")
        : "";
    const snapshotText = resolveTextGenerationOutputSnapshot({
      node,
      runtimeText,
    });
    const changed = this.commitCurrentProjectMutation("node.config", (project) => {
      const target = this.findNode(project, nodeId);
      if (!target || target.kind !== "studio.text_generation") {
        return false;
      }
      target.config.lockOutput = true;
      target.config.value = snapshotText;
      return true;
    });
    if (!changed) {
      return;
    }
    this.runPresentation.primeNodeOutput(
      node.id,
      { text: snapshotText },
      { message: "Output locked" }
    );
    this.render();
    new Notice(snapshotText.trim() ? "Text generation output locked." : "Text output locked (currently empty).");
  }

  private async resolvePromptBundleSource(node: StudioNodeInstance): Promise<{
    content: string;
    contentLanguage: string;
    sourceLabel: string;
    vaultPath: string;
  }> {
    const runtimeOutputs = this.runPresentation.getNodeState(node.id).outputs;
    return resolvePromptBundleNodeSource({
      node,
      runtimePath: runtimeOutputs?.path,
      runtimeText: runtimeOutputs?.text,
      configuredNotePath: this.readNotePrimaryPathFromConfig(node),
      readConfiguredNoteText: async (configuredPath) => {
        const abstract = this.app.vault.getAbstractFileByPath(configuredPath);
        if (!this.isMarkdownVaultFile(abstract)) {
          return null;
        }
        try {
          const text = (await this.readVaultMarkdownFile(abstract)).trim();
          if (!text) {
            return null;
          }
          return {
            text,
            path: abstract.path,
          };
        } catch {
          return null;
        }
      },
    });
  }

  private async copyTextGenerationPromptBundle(nodeId: string): Promise<void> {
    if (!this.currentProject) {
      new Notice("Open a Studio project first.");
      return;
    }

    const project = this.currentProject;
    const bundle = await composeTextGenerationPromptBundle({
      project,
      targetNodeId: nodeId,
      resolveSource: (sourceNode) => this.resolvePromptBundleSource(sourceNode),
      generatedAt: new Date(),
    });
    if (!bundle.ok) {
      new Notice("Prompt bundle copy is only available for text generation nodes.");
      return;
    }

    const copied = await tryCopyToClipboard(bundle.markdown);
    if (!copied) {
      new Notice("Unable to copy prompt bundle (clipboard unavailable).");
      return;
    }
    new Notice(
      bundle.sourceCount === 1
        ? "Prompt bundle copied with 1 source."
        : `Prompt bundle copied with ${bundle.sourceCount} sources.`
    );
  }

  private handleWindowKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
      return;
    }
    if (!this.isActiveStudioView()) {
      return;
    }
    const normalizedKey = String(event.key || "").toLowerCase();
    const normalizedCode = String(event.code || "").toLowerCase();
    const editableTarget = this.isEditableKeyboardTarget(event.target);
    const primaryModifierPressed = (event.metaKey || event.ctrlKey) && !event.altKey;
    const fitSelectionShortcutPressed =
      event.shiftKey && (normalizedCode === "digit1" || normalizedCode === "numpad1");

    if (primaryModifierPressed) {
      let handled = false;
      if (fitSelectionShortcutPressed) {
        handled = this.fitSelectedGraphNodesInViewport();
      } else if (!editableTarget) {
        if (normalizedKey === "c" && !event.shiftKey) {
          handled = this.clipboardAndDropController.copySelectedGraphNodes();
        } else if (normalizedKey === "x" && !event.shiftKey) {
          handled = this.clipboardAndDropController.cutSelectedGraphNodes();
        } else if (normalizedKey === "z") {
          handled = event.shiftKey ? this.redoGraphHistory() : this.undoGraphHistory();
        } else if (normalizedKey === "y") {
          handled = this.redoGraphHistory();
        }
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (this.busy || !this.currentProject) {
      return;
    }
    if (normalizedKey !== "delete" && normalizedKey !== "backspace") {
      return;
    }
    if (editableTarget) {
      return;
    }

    const selectedNodeIds = this.graphInteraction.getSelectedNodeIds();
    if (selectedNodeIds.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.removeNodes(selectedNodeIds);
  }

  private isMarkdownVaultFile(file: TAbstractFile | null): file is TFile {
    return file instanceof TFile && file.extension.toLowerCase() === "md";
  }

  private isVaultFolder(file: TAbstractFile | null): file is TFolder {
    return file instanceof TFolder;
  }

  private readNotePrimaryPathFromConfig(node: Pick<StudioNodeInstance, "config">): string {
    const rawPath = readPrimaryStudioNotePath(node.config);
    return rawPath ? normalizePath(rawPath) : "";
  }

  private readAllNotePathsFromConfig(node: Pick<StudioNodeInstance, "config">): string[] {
    const output: string[] = [];
    const seen = new Set<string>();
    for (const path of readAllStudioNotePaths(node.config)) {
      const normalized = path ? normalizePath(path) : "";
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  }

  private readEnabledNoteItemsFromConfig(node: Pick<StudioNodeInstance, "config">): StudioNoteConfigItem[] {
    return readEnabledStudioNoteItems(node.config)
      .map((item) => ({
        path: item.path ? normalizePath(item.path) : "",
        enabled: item.enabled !== false,
      }))
      .filter((item) => item.path.length > 0);
  }

  private normalizeNoteNodeConfig(node: StudioNodeInstance): boolean {
    let changed = false;
    let nextConfig: Record<string, StudioJsonValue> = node.config;
    const canonicalized = ensureStudioNoteConfigItems(nextConfig);
    if (canonicalized.changed) {
      nextConfig = canonicalized.nextConfig;
      changed = true;
    }

    const normalizedItems = parseStudioNoteItems(nextConfig.notes).map((item) => ({
      path: item.path ? normalizePath(item.path) : "",
      enabled: item.enabled !== false,
    }));
    const serializedItems = serializeStudioNoteItems(normalizedItems);
    if (JSON.stringify(nextConfig.notes) !== JSON.stringify(serializedItems)) {
      nextConfig = {
        ...nextConfig,
        notes: serializedItems,
      };
      changed = true;
    }

    if (changed) {
      node.config = nextConfig;
    }
    return changed;
  }

  private async refreshNoteNodePreviewsFromVault(
    project: StudioProjectV1,
    options?: {
      onlyNodeIds?: Set<string>;
    }
  ): Promise<boolean> {
    let configChanged = false;
    const onlyNodeIds = options?.onlyNodeIds;

    for (const node of project.graph.nodes) {
      if (node.kind !== "studio.note") {
        continue;
      }
      if (onlyNodeIds && !onlyNodeIds.has(node.id)) {
        continue;
      }

      if (this.normalizeNoteNodeConfig(node)) {
        configChanged = true;
      }

      const enabledItems = this.readEnabledNoteItemsFromConfig(node);
      if (enabledItems.length === 0) {
        this.runPresentation.primeNodeOutput(
          node.id,
          {
            text: "",
            path: "",
            title: "",
          },
          { message: "No enabled notes selected" }
        );
        continue;
      }

      const loadedEntries: Array<{ text: string; path: string; title: string }> = [];
      let failedCount = 0;
      for (const item of enabledItems) {
        const abstract = this.app.vault.getAbstractFileByPath(item.path);
        if (!this.isMarkdownVaultFile(abstract)) {
          failedCount += 1;
          continue;
        }

        try {
          const text = await this.readVaultMarkdownFile(abstract);
          loadedEntries.push({
            text,
            path: abstract.path,
            title: deriveStudioNoteTitleFromPath(abstract.path) || abstract.path,
          });
        } catch (error) {
          failedCount += 1;
          console.warn("[SystemSculpt Studio] Unable to read note preview", {
            nodeId: node.id,
            path: item.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (loadedEntries.length === 0) {
        const fallbackPath = enabledItems[0]?.path || "";
        this.runPresentation.primeNodeOutput(
          node.id,
          {
            text: "",
            path: fallbackPath,
            title: deriveStudioNoteTitleFromPath(fallbackPath) || "",
          },
          { message: "Linked notes unavailable" }
        );
        continue;
      }

      const outputs: StudioNodeOutputMap =
        loadedEntries.length === 1
          ? {
              text: loadedEntries[0].text,
              path: loadedEntries[0].path,
              title: loadedEntries[0].title,
            }
          : {
              text: loadedEntries.map((entry) => entry.text),
              path: loadedEntries.map((entry) => entry.path),
              title: loadedEntries.map((entry) => entry.title),
            };
      const message =
        failedCount > 0
          ? `Preview ready (${loadedEntries.length}/${enabledItems.length} notes loaded)`
          : "Preview ready";
      this.runPresentation.primeNodeOutput(node.id, outputs, { message });
    }

    return configChanged;
  }

  private async readVaultMarkdownFile(file: TFile): Promise<string> {
    const cachedRead = (this.app.vault as any).cachedRead;
    if (typeof cachedRead === "function") {
      return cachedRead.call(this.app.vault, file);
    }
    return this.app.vault.read(file);
  }

  private async insertVaultNoteNodes(
    notePaths: string[],
    anchor: { x: number; y: number },
    options?: { source?: "paste" | "drop" }
  ): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const noteDefinition = this.nodeDefinitions.find((definition) => definition.kind === "studio.note");
    if (!noteDefinition) {
      throw new Error("Note node definition is unavailable.");
    }

    const project = this.currentProject;
    const uniquePaths = Array.from(
      new Set(notePaths.map((path) => String(path || "").trim()).filter(Boolean))
    );
    const createdNodes: StudioNodeInstance[] = [];

    for (let index = 0; index < uniquePaths.length; index += 1) {
      const notePath = uniquePaths[index];
      const abstract = this.app.vault.getAbstractFileByPath(notePath);
      if (!this.isMarkdownVaultFile(abstract)) {
        continue;
      }
      const title = deriveStudioNoteTitleFromPath(abstract.path) || prettifyNodeKind(noteDefinition.kind);
      const node: StudioNodeInstance = {
        id: randomId("node"),
        kind: noteDefinition.kind,
        version: noteDefinition.version,
        title,
        position: this.normalizeNodePosition({
          x: anchor.x + (index % 5) * 38,
          y: anchor.y + Math.floor(index / 5) * 38,
        }),
        config: {
          ...cloneConfigDefaults(noteDefinition),
          notes: serializeStudioNoteItems([{ path: abstract.path, enabled: true }]),
        },
        continueOnError: false,
        disabled: false,
      };
      createdNodes.push(node);
    }

    if (createdNodes.length === 0) {
      return;
    }

    const changed = this.commitCurrentProjectMutation("graph.node.create", (currentProject) => {
      currentProject.graph.nodes.push(...createdNodes);
      return true;
    });
    if (!changed) {
      return;
    }

    const createdNodeIds = createdNodes.map((node) => node.id);
    this.graphInteraction.selectOnlyNode(createdNodeIds[createdNodeIds.length - 1]);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.render();
    void this.refreshNoteNodePreviewsFromVault(project, {
      onlyNodeIds: new Set(createdNodeIds),
    }).then(() => {
      this.render();
    });

    if (options?.source === "drop") {
      new Notice(
        createdNodeIds.length === 1
          ? "Added 1 note as a Note node."
          : `Added ${createdNodeIds.length} notes as Note nodes.`
      );
      return;
    }
    new Notice(
      createdNodeIds.length === 1
        ? "Pasted 1 note as a Note node."
        : `Pasted ${createdNodeIds.length} notes as Note nodes.`
    );
  }

  /** Bridges controller-owned creation flows back to private graph UI state. */
  private finalizeClipboardCreatedNodes(
    project: StudioProjectV1,
    options: StudioCreatedNodesFinalization,
  ): void {
    if (options.hideNodeMenus) {
      this.nodeContextMenuOverlay?.hide();
      this.nodeActionContextMenuOverlay?.hide();
    }
    const applySelection = (): void => {
      if (options.selectionMode === "only" && options.selection.length === 1) {
        this.graphInteraction.selectOnlyNode(options.selection[0]);
        return;
      }
      this.graphInteraction.setSelectedNodeIds(options.selection);
    };
    if (options.pendingConnectionMode === "silent") {
      this.graphInteraction.clearPendingConnection({ requestRender: false });
      applySelection();
    } else {
      applySelection();
      this.graphInteraction.clearPendingConnection();
    }
    this.recomputeEntryNodes(project);
    this.render();
    if (options.refreshNoteNodeIds && options.refreshNoteNodeIds.length > 0) {
      void this.refreshNoteNodePreviewsFromVault(project, {
        onlyNodeIds: new Set(options.refreshNoteNodeIds),
      }).then(() => {
        if (this.currentProject === project) {
          this.render();
        }
      });
    }
  }

  private async loadNodeDefinitions(): Promise<void> {
    const definitions = this.plugin
      .getStudioService()
      .listNodeDefinitions()
      .slice()
      .sort((a, b) => definitionKey(a).localeCompare(definitionKey(b)));

    this.nodeDefinitions = definitions;
    this.nodeDefinitionsByKey = new Map(
      definitions.map((definition) => [definitionKey(definition), definition])
    );
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.render();
  }

  private setError(error: unknown): void {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = this.normalizeEscapedNewlines(rawMessage);
    this.lastError = message;
    if (error instanceof Error) {
      this.logStudioConsoleError("[SystemSculpt Studio] Error", {
        message,
        name: error.name,
        stack: error.stack || null,
        projectPath: this.currentProjectPath,
      });
    } else {
      this.logStudioConsoleError("[SystemSculpt Studio] Error", {
        message,
        rawError: error,
        projectPath: this.currentProjectPath,
      });
    }
    const summary = this.summarizeMessageForNotice(message);
    new Notice(`SystemSculpt Studio: ${summary}. See console for full details.`);
  }

  private logStudioConsoleError(label: string, details: Record<string, unknown>): void {
    console.error(label, details);
    const serialized = this.serializeStudioConsoleDetails(details);
    if (serialized) {
      console.error(`${label} JSON ${serialized}`);
    }
  }

  private serializeStudioConsoleDetails(details: Record<string, unknown>): string {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(
        details,
        (_key, value: unknown) => {
          if (value instanceof Error) {
            return {
              name: value.name,
              message: value.message,
              stack: value.stack || null,
            };
          }
          if (typeof value === "bigint") {
            return value.toString();
          }
          if (value && typeof value === "object") {
            if (seen.has(value as object)) {
              return "[Circular]";
            }
            seen.add(value as object);
          }
          return value;
        },
        2
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        message: "Failed to serialize console details.",
        serializationError: message,
      });
    }
  }

  private normalizeEscapedNewlines(message: string): string {
    return String(message || "")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n");
  }

  private summarizeMessageForNotice(message: string): string {
    const firstLine = this.normalizeEscapedNewlines(message)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return "Unknown error";
    }
    if (firstLine.length <= 220) {
      return firstLine;
    }
    return `${firstLine.slice(0, 217)}...`;
  }

  private handleRunEvent(event: StudioRunEvent): void {
    this.runPresentation.applyEvent(event);
    this.graphInteraction.applyRunEvent(event);
    if (event.type === "node.started") {
      this.materializeManagedOutputPlaceholders(event);
    }
    if (event.type === "node.output") {
      this.syncInlineTextOutputToNodeConfig(event);
      this.syncDatasetOutputFieldsToNodeConfig(event);
      this.materializeManagedOutputNodes(event);
    }
    if (event.type === "node.failed") {
      this.removePendingManagedOutputPlaceholders({
        sourceNodeId: event.nodeId,
        runId: event.runId,
      });
      this.logStudioConsoleError("[SystemSculpt Studio] Node failed", {
        runId: event.runId,
        nodeId: event.nodeId,
        error: event.error,
        stack: event.errorStack || null,
        at: event.at,
        projectPath: this.currentProjectPath,
      });
    } else if (event.type === "run.failed") {
      this.removePendingManagedOutputPlaceholders({ runId: event.runId });
      this.logStudioConsoleError("[SystemSculpt Studio] Run failed", {
        runId: event.runId,
        error: event.error,
        stack: event.errorStack || null,
        at: event.at,
        projectPath: this.currentProjectPath,
      });
    } else if (event.type === "run.completed") {
      this.removePendingManagedOutputPlaceholders({ runId: event.runId });
    }
    this.render();
  }

  private syncInlineTextOutputToNodeConfig(
    event: Extract<StudioRunEvent, { type: "node.output" }>
  ): void {
    if (!this.currentProject) {
      return;
    }
    this.commitCurrentProjectMutation(
      "runtime.projector",
      (project) =>
        syncInlineTextOutputToProjectNodeConfig({
          project,
          event,
        }),
      { captureHistory: false }
    );
  }

  private syncDatasetOutputFieldsToNodeConfig(
    event: Extract<StudioRunEvent, { type: "node.output" }>
  ): void {
    if (!this.currentProject) {
      return;
    }
    this.commitCurrentProjectMutation(
      "runtime.projector",
      (project) =>
        syncDatasetOutputFieldsToProjectNodeConfig({
          project,
          event,
        }),
      { captureHistory: false }
    );
  }

  private materializeManagedOutputPlaceholders(
    event: Extract<StudioRunEvent, { type: "node.started" }>
  ): void {
    if (!this.currentProject) {
      return;
    }
    const changed = this.commitCurrentProjectMutation(
      "runtime.projector",
      (project) =>
        materializeManagedOutputPlaceholdersForStartedNode({
          project,
          event,
          createNodeId: () => randomId("node"),
          createEdgeId: () => randomId("edge"),
        }),
      { captureHistory: false }
    );

    if (!changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
  }

  private materializeManagedOutputNodes(event: Extract<StudioRunEvent, { type: "node.output" }>): void {
    if (!this.currentProject) {
      return;
    }
    let changed = this.removePendingManagedOutputPlaceholders({
      sourceNodeId: event.nodeId,
      runId: event.runId,
    });
    changed =
      this.commitCurrentProjectMutation(
        "runtime.projector",
        (project) =>
          materializeManagedOutputNodesForNodeOutput({
            project,
            event,
            createNodeId: () => randomId("node"),
            createEdgeId: () => randomId("edge"),
          }),
        { captureHistory: false }
      ) || changed;

    if (!changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
  }

  private materializeManagedOutputNodesFromCache(
    entries: Record<string, { outputs: StudioNodeOutputMap; updatedAt?: string }> | null
  ): void {
    if (!this.currentProject) {
      return;
    }
    const changed = this.commitCurrentProjectMutation(
      "runtime.projector",
      (project) =>
        materializeManagedOutputNodesFromCacheEntries({
          project,
          entries,
          createNodeId: () => randomId("node"),
          createEdgeId: () => randomId("edge"),
        }),
      { captureHistory: false }
    );

    if (!changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
  }

  private removePendingManagedOutputPlaceholders(options?: {
    sourceNodeId?: string;
    runId?: string;
  }): boolean {
    if (!this.currentProject) {
      return false;
    }
    let removedNodeIds: string[] = [];
    const changed = this.commitCurrentProjectMutation(
      "runtime.projector",
      (project) => {
        const removed = removePendingManagedOutputNodes({
          project,
          sourceNodeId: options?.sourceNodeId,
          runId: options?.runId,
        });
        if (!removed.changed) {
          return false;
        }
        removedNodeIds = removed.removedNodeIds;
        return true;
      },
      { captureHistory: false }
    );
    if (!changed) {
      return false;
    }
    for (const nodeId of removedNodeIds) {
      this.runPresentation.removeNode(nodeId);
      this.graphInteraction.onNodeRemoved(nodeId);
      this.editingTextNodeIds.delete(nodeId);
      this.dirtyTextNodeEditIds.delete(nodeId);
      this.pendingTextNodeFocusPointByNodeId.delete(nodeId);
      this.textNodeEditorSnapshots.delete(nodeId);
      if (this.pendingTextNodeAutofocusNodeId === nodeId) {
        this.pendingTextNodeAutofocusNodeId = null;
      }
    }
    this.recomputeEntryNodes(this.currentProject);
    return true;
  }

  private clearLayoutSaveTimer(): void {
    if (this.layoutSaveTimer !== null) {
      this.layoutSaveTimerWindow?.clearTimeout(this.layoutSaveTimer);
      this.layoutSaveTimer = null;
      this.layoutSaveTimerWindow = null;
    }
  }

  private clearViewportScrollCaptureFrame(): void {
    if (this.viewportScrollCaptureFrame !== null) {
      this.viewportScrollCaptureWindow?.cancelAnimationFrame(this.viewportScrollCaptureFrame);
      this.viewportScrollCaptureFrame = null;
      this.viewportScrollCaptureWindow = null;
    }
  }

  private clearViewportScrollingClassTimer(): void {
    if (this.viewportScrollingClassTimer !== null) {
      this.viewportScrollingClassTimerWindow?.clearTimeout(this.viewportScrollingClassTimer);
      this.viewportScrollingClassTimer = null;
      this.viewportScrollingClassTimerWindow = null;
    }
  }

  private scheduleLayoutSave(): void {
    this.clearLayoutSaveTimer();
    const ownerWindow = getStudioOwnerWindow(this.contentEl);
    this.layoutSaveTimerWindow = ownerWindow;
    this.layoutSaveTimer = ownerWindow.setTimeout(() => {
      this.layoutSaveTimer = null;
      this.layoutSaveTimerWindow = null;
      this.app.workspace.requestSaveLayout();
    }, 360);
  }

  private commitCurrentProjectMutation(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => boolean | void,
    options?: {
      captureHistory?: boolean;
      mode?: StudioProjectSessionAutosaveMode;
    }
  ): boolean {
    return this.projectSessionController.commitMutation(reason, mutator, options);
  }

  private async commitCurrentProjectMutationAsync(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => Promise<boolean | void>,
    options?: {
      captureHistory?: boolean;
      mode?: StudioProjectSessionAutosaveMode;
    }
  ): Promise<boolean> {
    return await this.projectSessionController.commitMutationAsync(reason, mutator, options);
  }

  private scheduleSessionPersistFromLegacyMutation(options?: {
    captureHistory?: boolean;
    mode?: StudioProjectSessionAutosaveMode;
  }): void {
    this.projectSessionController.schedulePersistFromLegacyMutation(options);
  }

  private async flushPendingProjectSaveWork(options?: {
    force?: boolean;
    showNotice?: boolean;
  }): Promise<void> {
    await this.projectSessionController.flushPendingProjectSaveWork(options);
  }

  private resolveNodeCardBadge(node: StudioNodeInstance): {
    text: string;
    tone: "warning";
    title: string;
  } | null {
    const definition = this.findNodeDefinition(node);
    if (definition) {
      const availability = resolveStudioNodeHostAvailability(definition);
      if (!availability.available) {
        return {
          text: "Desktop only",
          tone: "warning",
          title: availability.reason || "This node requires Obsidian Desktop.",
        };
      }
    }
    if (node.kind !== "studio.note") {
      return null;
    }
    const enabledItems = this.readEnabledNoteItemsFromConfig(node);
    if (enabledItems.length === 0) {
      return {
        text: "Broken link",
        tone: "warning",
        title: "No enabled markdown notes selected.",
      };
    }

    let firstIssue: string | null = null;
    let issueCount = 0;
    for (const item of enabledItems) {
      const normalizedPath = normalizePath(item.path);
      const abstract = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (this.isMarkdownVaultFile(abstract)) {
        continue;
      }
      issueCount += 1;
      if (firstIssue) {
        continue;
      }
      if (this.isVaultFolder(abstract)) {
        firstIssue = `Vault path "${normalizedPath}" points to a folder. Note nodes require a markdown file.`;
      } else if (abstract instanceof TFile) {
        firstIssue = `Vault path "${normalizedPath}" is not a markdown file.`;
      } else {
        firstIssue = `Vault note "${normalizedPath}" was not found.`;
      }
    }

    if (issueCount === 0) {
      return null;
    }
    if (issueCount === 1 && firstIssue) {
      return {
        text: "Broken link",
        tone: "warning",
        title: firstIssue,
      };
    }
    return {
      text: "Broken link",
      tone: "warning",
      title:
        firstIssue && firstIssue.length > 0
          ? `${issueCount} of ${enabledItems.length} enabled notes are unavailable. ${firstIssue}`
          : `${issueCount} of ${enabledItems.length} enabled notes are unavailable.`,
    };
  }

  private async renderNodeMarkdownPreview(
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ): Promise<void> {
    const content = String(markdown || "");
    containerEl.empty();
    if (!content.trim()) {
      return;
    }

    const noteSourcePath = node.kind === "studio.note" ? this.readNotePrimaryPathFromConfig(node) : "";
    const sourcePath = noteSourcePath || this.currentProjectPath || "SystemSculpt Studio";
    try {
      await MarkdownRenderer.render(this.app, content, containerEl, sourcePath, this);
    } catch (error) {
      console.warn("[SystemSculpt Studio] Failed to render node markdown preview", {
        nodeId: node.id,
        nodeKind: node.kind,
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
      containerEl.empty();
      containerEl.setText(content);
    }
  }

  private readJsonEditorPreferredMode(): "composer" | "raw" {
    const rawMode = String(this.plugin.settings.studioJsonEditorDefaultMode || "")
      .trim()
      .toLowerCase();
    return rawMode === "raw" ? "raw" : "composer";
  }

  private updateJsonEditorPreferredMode(mode: "composer" | "raw"): void {
    const normalized = mode === "raw" ? "raw" : "composer";
    if (this.plugin.settings.studioJsonEditorDefaultMode === normalized) {
      return;
    }
    this.plugin.settings.studioJsonEditorDefaultMode = normalized;
    void this.plugin.saveSettings().catch((error) => {
      console.warn("[SystemSculpt Studio] Failed to persist JSON editor mode preference", {
        mode: normalized,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private readCurrentNodeDetailMode(): StudioNodeDetailMode {
    return this.projectSessionController.readCurrentNodeDetailMode();
  }

  private updateCurrentNodeDetailMode(mode: StudioNodeDetailMode): void {
    if (this.projectSessionController.updateCurrentNodeDetailMode(mode)) {
      this.render();
    }
  }

  private toggleCurrentNodeDetailMode(): void {
    const currentMode = this.readCurrentNodeDetailMode();
    this.updateCurrentNodeDetailMode(currentMode === "collapsed" ? "expanded" : "collapsed");
  }

  private setGraphZoomAtViewportCenter(nextZoom: number): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }

    const previousZoom = this.graphInteraction.getGraphZoom() || 1;
    const localX = viewport.clientWidth * 0.5;
    const localY = viewport.clientHeight * 0.5;
    const graphX = (viewport.scrollLeft + localX) / previousZoom;
    const graphY = (viewport.scrollTop + localY) / previousZoom;

    this.graphInteraction.setGraphZoom(nextZoom, {
      mode: "interactive",
      settled: false,
      scheduleSettle: true,
    });
    const appliedZoom = this.graphInteraction.getGraphZoom() || 1;
    viewport.scrollLeft = graphX * appliedZoom - localX;
    viewport.scrollTop = graphY * appliedZoom - localY;
  }

  private adjustGraphZoomFromRibbon(multiplier: number): void {
    const currentZoom = this.graphInteraction.getGraphZoom() || 1;
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      return;
    }
    this.setGraphZoomAtViewportCenter(currentZoom * multiplier);
  }

  private resetGraphZoomFromRibbon(): void {
    this.setGraphZoomAtViewportCenter(STUDIO_GRAPH_DEFAULT_ZOOM);
  }

  fitSelectionInViewportFromCommand(): boolean {
    return this.fitSelectedGraphNodesInViewport();
  }

  showGraphOverviewFromCommand(): boolean {
    return this.fitGraphOverviewInViewport();
  }

  private fitSelectedGraphNodesInViewport(): boolean {
    return this.graphInteraction.fitSelectedNodesInViewport({
      paddingPx: STUDIO_GRAPH_SELECTION_FIT_PADDING_PX,
    });
  }

  private fitGraphOverviewInViewport(): boolean {
    return this.graphInteraction.fitGraphInViewport({
      paddingPx: STUDIO_GRAPH_SELECTION_FIT_PADDING_PX,
    });
  }

  private openAddNodeMenuAtViewportCenter(): void {
    if (this.busy || !this.graphViewportEl || !this.currentProject) {
      return;
    }

    const viewport = this.graphViewportEl;
    const localX = viewport.clientWidth * 0.5;
    const localY = viewport.clientHeight * 0.5;
    const zoom = this.graphInteraction.getGraphZoom() || 1;
    const graphX = (viewport.scrollLeft + localX) / zoom;
    const graphY = (viewport.scrollTop + localY) / zoom;
    const menuX = normalizeGraphCoordinate(viewport.scrollLeft + localX);
    const menuY = normalizeGraphCoordinate(viewport.scrollTop + localY);
    this.openNodeDefinitionMenu({
      graphX,
      graphY,
      menuX,
      menuY,
      zoom,
    });
  }

  private pathBrowseOptions(): StudioNodeConfigPathBrowseOptions {
    return {
      importFileWithoutOsPath: async (file) => this.importBrowsedFileWithoutOsPath(file),
    };
  }

  private async importBrowsedFileWithoutOsPath(file: File): Promise<string | null> {
    if (!this.currentProjectPath) {
      new Notice("Open a .systemsculpt file from the file explorer first.");
      return null;
    }
    try {
      return await this.plugin.getStudioService().importFileToProject(this.currentProjectPath, {
        bytes: await file.arrayBuffer(),
        name: file.name,
        mimeType: file.type,
      });
    } catch (error) {
      this.setError(error);
      return null;
    }
  }

  private ensureNodeContextMenuOverlay(): StudioNodeContextMenuOverlay {
    if (this.nodeContextMenuOverlay) {
      return this.nodeContextMenuOverlay;
    }

    this.nodeContextMenuOverlay = new StudioNodeContextMenuOverlay();
    return this.nodeContextMenuOverlay;
  }

  private ensureNodeActionContextMenuOverlay(): StudioSimpleContextMenuOverlay {
    if (this.nodeActionContextMenuOverlay) {
      return this.nodeActionContextMenuOverlay;
    }

    this.nodeActionContextMenuOverlay = new StudioSimpleContextMenuOverlay();
    return this.nodeActionContextMenuOverlay;
  }

  private handleNodeConfigMutated(node: StudioNodeInstance): void {
    this.refreshNodeCardPreview(node);
    if (node.kind === "studio.note") {
      this.handleNoteNodeConfigMutated(node);
    }
    this.scheduleSessionPersistFromLegacyMutation();
  }

  private handleNodeConfigValueChange(
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: {
      mode?: StudioProjectSessionAutosaveMode;
      captureHistory?: boolean;
    }
  ): void {
    const currentNode = this.currentProject
      ? this.findNode(this.currentProject, nodeId)
      : null;
    const isActiveTextEdit =
      key === "value" &&
      currentNode?.kind === "studio.text" &&
      this.editingTextNodeIds.has(nodeId);
    const changed = this.commitCurrentProjectMutation(
      "node.config",
      (project) => {
        const target = this.findNode(project, nodeId);
        if (!target) {
          return false;
        }
        if (key === STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY && value === null) {
          if (!Object.prototype.hasOwnProperty.call(target.config, key)) {
            return false;
          }
          delete target.config[key];
          return true;
        }
        const previousSerialized = JSON.stringify(target.config[key] ?? null);
        const nextValue = this.cloneJsonValue(value);
        const nextSerialized = JSON.stringify(nextValue ?? null);
        if (previousSerialized === nextSerialized) {
          return false;
        }
        target.config[key] = nextValue;
        return true;
      },
      {
        // Text typing is one native edit transaction. The final checkpoint is
        // captured when the edit session ends, not once per CodeMirror update.
        captureHistory: isActiveTextEdit ? false : options?.captureHistory,
        mode: options?.mode,
      }
    );
    if (!changed || !this.currentProject) {
      return;
    }
    if (isActiveTextEdit) {
      this.dirtyTextNodeEditIds.add(nodeId);
    }
    const node = this.findNode(this.currentProject, nodeId);
    if (!node) {
      return;
    }
    this.refreshNodeCardPreview(node);
    if (node.kind === "studio.note") {
      this.handleNoteNodeConfigMutated(node);
    }
  }

  /**
   * Applies one resize-frame patch — any combination of size, position, and
   * fontSize — as a single "node.geometry" mutation so a left/top or corner
   * drag lands as one atomic change with one history entry. Single-node
   * resizes are just a one-entry group resize.
   */
  private handleNodeResize(
    nodeId: string,
    patch: StudioGraphNodeResizePatch,
    options?: {
      mode?: StudioProjectSessionAutosaveMode;
      captureHistory?: boolean;
    }
  ): void {
    this.handleSelectionResize([{ nodeId, patch }], options);
  }

  /**
   * Applies a batch of resize patches — one per affected node — inside ONE
   * "node.geometry" mutation. This is the multi-select resize frame's
   * commit seam: a whole group transform lands atomically, so a single
   * undo step restores every node's pre-gesture geometry.
   */
  private handleSelectionResize(
    patches: Array<{ nodeId: string; patch: StudioGraphNodeResizePatch }>,
    options?: {
      mode?: StudioProjectSessionAutosaveMode;
      captureHistory?: boolean;
    }
  ): void {
    if (patches.length === 0) {
      return;
    }
    const changed = this.commitCurrentProjectMutation(
      "node.geometry",
      (project) => {
        let mutated = false;
        for (const { nodeId, patch } of patches) {
          const target = this.findNode(project, nodeId);
          if (!target) {
            continue;
          }
          if (this.applyNodeResizePatch(target, patch)) {
            mutated = true;
          }
        }
        return mutated;
      },
      {
        captureHistory: options?.captureHistory,
        mode: options?.mode,
      }
    );
    if (!changed) {
      return;
    }
    this.graphInteraction.notifyNodePositionsChanged();
  }

  /** The one geometry-patch application shared by single and group resizes. */
  private applyNodeResizePatch(
    target: StudioNodeInstance,
    patch: StudioGraphNodeResizePatch
  ): boolean {
    let mutated = false;
    if (patch.size && (patch.size.width !== undefined || patch.size.height !== undefined)) {
      // Geometry is first-class canvas data. Height is optional: text and
      // aspect-driven media cards persist width only. Any lingering legacy
      // config geometry is ignored by the resolvers (size wins) and
      // stripped by the load migration on the next open.
      const nextWidth =
        patch.size.width !== undefined
          ? Math.max(1, Math.round(patch.size.width))
          : (target.size?.width ?? resolveStudioGraphNodeWidth(target));
      const nextHeight =
        patch.size.height !== undefined
          ? Math.max(1, Math.round(patch.size.height))
          : target.size?.height;
      if (target.size?.width !== nextWidth || target.size?.height !== nextHeight) {
        target.size = {
          width: nextWidth,
          ...(nextHeight !== undefined ? { height: nextHeight } : {}),
        };
        mutated = true;
      }
    }
    if (patch.position) {
      const nextX = Math.max(24, Math.round(patch.position.x));
      const nextY = Math.max(24, Math.round(patch.position.y));
      if (target.position.x !== nextX || target.position.y !== nextY) {
        target.position.x = nextX;
        target.position.y = nextY;
        mutated = true;
      }
    }
    if (patch.fontSize !== undefined) {
      const nextFontSize = clampStudioNodeDimension(
        patch.fontSize,
        STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
        STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE
      );
      if (target.config.fontSize !== nextFontSize) {
        target.config.fontSize = nextFontSize;
        mutated = true;
      }
    }
    return mutated;
  }

  private openImageEditorForNode(node: StudioNodeInstance): void {
    if (node.kind !== "studio.media_ingest" || !this.currentProjectPath) {
      return;
    }
    const projectPath = this.currentProjectPath;
    const studio = this.plugin.getStudioService();
    openStudioImageEditorModal({
      app: this.app,
      node,
      nodeRunState: this.runPresentation.getNodeState(node.id),
      projectPath,
      resolveAssetPreviewSrc: (assetPath) => resolveStudioAssetPreviewSrc(this.app, assetPath),
      readAsset: (asset) => studio.readAsset(asset),
      storeAsset: (bytes, mimeType) => studio.storeAsset(projectPath, bytes, mimeType),
      onNodeConfigMutated: (nextNode) => {
        this.handleNodeConfigMutated(nextNode);
      },
      onNodeConfigValueChange: (nodeId, key, value, options) => {
        this.handleNodeConfigValueChange(nodeId, key, value, options);
      },
      onRenderedAssetCommitted: () => {
        this.render();
      },
    });
  }

  private async editImageWithAiForNode(node: StudioNodeInstance): Promise<void> {
    if (this.busy || !this.currentProject || !this.currentProjectPath) {
      return;
    }
    if (node.kind !== "studio.media_ingest") {
      return;
    }

    const imageGenerationDefinition = this.nodeDefinitions.find(
      (definition) => definition.kind === "studio.image_generation"
    );
    if (!imageGenerationDefinition) {
      this.setError("Studio image-edit dependencies are unavailable.");
      return;
    }

    const aspectRatio = await this.resolveAiImageEditAspectRatioForNode(node);
    let createdImageGenerationNodeId: string | null = null;
    const changed = this.commitCurrentProjectMutation("graph.node.create", (project) => {
      const sourceNode = this.findNode(project, node.id);
      if (!sourceNode) {
        return false;
      }
      const inserted = insertAiImageEditNode({
        project,
        sourceNode,
        aspectRatio,
        imageGenerationDefinition,
        nextNodeId: () => randomId("node"),
        nextEdgeId: () => randomId("edge"),
        cloneConfigDefaults: (definition) => cloneConfigDefaults(definition),
        normalizeNodePosition: (position) => this.normalizeNodePosition(position),
      });
      createdImageGenerationNodeId = inserted.imageGenerationNodeId;
      return true;
    });
    if (!changed || !createdImageGenerationNodeId || !this.currentProject) {
      return;
    }

    this.graphInteraction.selectOnlyNode(createdImageGenerationNodeId);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(this.currentProject);
    this.render();
    this.focusImageGenerationPrompt(createdImageGenerationNodeId);
  }

  /** After spawning an AI edit node, put the caret straight into its Prompt box. */
  private focusImageGenerationPrompt(nodeId: string): void {
    const nodeEl = this.graphInteraction.getNodeElement(nodeId);
    const promptEl = nodeEl?.querySelector<HTMLTextAreaElement>(
      ".ss-studio-node-inline-config-field--prompt textarea"
    );
    promptEl?.focus();
  }

  private async resolveAiImageEditAspectRatioForNode(node: StudioNodeInstance): Promise<string> {
    const ensuredAsset = await this.ensureRenderedImageAssetForNode(node);
    const nodeRunState = this.runPresentation.getNodeState(node.id);
    const outputs = (nodeRunState.outputs || {}) as Record<string, unknown>;
    const candidatePaths = [
      ensuredAsset?.path || "",
      typeof outputs.preview_path === "string" ? outputs.preview_path : "",
      typeof outputs.source_preview_path === "string" ? outputs.source_preview_path : "",
      typeof outputs.path === "string" ? outputs.path : "",
      typeof node.config.sourcePath === "string" ? node.config.sourcePath : "",
    ];

    for (const candidatePath of candidatePaths) {
      const previewSrc = this.resolveImagePreviewSrcFromPath(candidatePath);
      if (!previewSrc) {
        continue;
      }
      try {
        const dimensions = await this.measureImageDimensions(previewSrc);
        return inferAiImageEditAspectRatio(dimensions.width, dimensions.height);
      } catch {
        continue;
      }
    }

    return "1:1";
  }

  private resolveImagePreviewSrcFromPath(path: string): string | null {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) {
      return null;
    }
    const assetSrc = resolveStudioAssetPreviewSrc(this.app, normalizedPath);
    if (assetSrc) {
      return assetSrc;
    }
    if (isAbsoluteFilesystemPath(normalizedPath)) {
      return `file://${encodeURI(normalizedPath)}`;
    }
    return null;
  }

  private measureImageDimensions(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const ImageCtor = (getStudioOwnerWindow(this.contentEl) as Window & {
        Image: new () => HTMLImageElement;
      }).Image;
      const imageEl = new ImageCtor();
      imageEl.onload = () => {
        resolve({
          width: imageEl.naturalWidth || 1,
          height: imageEl.naturalHeight || 1,
        });
      };
      imageEl.onerror = () => {
        reject(new Error("Preview image failed to load."));
      };
      imageEl.src = src;
    });
  }

  private normalizeStudioAssetRefLike(value: unknown): StudioAssetRef | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const hash = typeof record.hash === "string" ? record.hash.trim() : "";
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const mimeType =
      typeof record.mimeType === "string"
        ? record.mimeType.trim()
        : typeof record.mime_type === "string"
          ? record.mime_type.trim()
          : "";
    const sizeBytes = Number(record.sizeBytes ?? record.size_bytes);
    if (!hash || !path || !mimeType || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return null;
    }
    return {
      hash,
      path,
      mimeType,
      sizeBytes: Math.floor(sizeBytes),
    };
  }

  private async ensureRenderedImageAssetForNode(node: StudioNodeInstance): Promise<StudioAssetRef | null> {
    if (node.kind !== "studio.media_ingest" || !this.currentProjectPath) {
      return null;
    }

    const nodeRunState = this.runPresentation.getNodeState(node.id);
    const outputs = (nodeRunState.outputs || {}) as Record<string, unknown>;
    const sourcePreviewAsset = this.normalizeStudioAssetRefLike(outputs.source_preview_asset);
    const previewAsset = this.normalizeStudioAssetRefLike(outputs.preview_asset);
    const configuredSourcePath = typeof node.config.sourcePath === "string" ? node.config.sourcePath.trim() : "";
    const boardState = readStudioCaptionBoardState(node.config);
    const existingRenderedAsset = resolveStudioCaptionBoardRenderedAsset(
      node.config,
      sourcePreviewAsset?.path || configuredSourcePath
    );

    if (existingRenderedAsset) {
      return existingRenderedAsset;
    }

    if (boardStateHasRenderableEdits(boardState) && sourcePreviewAsset) {
      const studio = this.plugin.getStudioService();
      const renderedAsset = await composeStudioCaptionBoardImage({
        baseImage: sourcePreviewAsset,
        boardState,
        readAsset: (asset) => studio.readAsset(asset),
        storeAsset: (bytes, mimeType) => studio.storeAsset(this.currentProjectPath!, bytes, mimeType),
      });
      const changed = await this.commitCurrentProjectMutationAsync(
        "media.editor",
        async (project) => {
          const targetNode = this.findNode(project, node.id);
          if (!targetNode || targetNode.kind !== "studio.media_ingest") {
            return false;
          }
          writeStudioCaptionBoardState(targetNode, {
            ...boardState,
            sourceAssetPath: sourcePreviewAsset.path,
            lastRenderedAsset: renderedAsset,
            updatedAt: new Date().toISOString(),
          });
          return true;
        },
        { captureHistory: false }
      );
      if (!changed) {
        return renderedAsset;
      }
      this.refreshNodeCardPreview(node);
      this.render();
      return renderedAsset;
    }

    return previewAsset || sourcePreviewAsset;
  }

  private async copyImageForNodeToClipboard(node: StudioNodeInstance): Promise<void> {
    const asset = await this.ensureRenderedImageAssetForNode(node);
    if (!asset) {
      new Notice("Run this image node once before copying the image.");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(asset.path);
    if (!(file instanceof TFile)) {
      new Notice("Unable to copy image to clipboard.");
      return;
    }
    const copied = await tryCopyImageFileToClipboard(this.app, file, this.containerEl);
    if (!copied) {
      new Notice("Unable to copy image to clipboard.");
      return;
    }
    new Notice("Image copied to clipboard.");
  }

  private handleNoteNodeConfigMutated(node: StudioNodeInstance): void {
    if (this.normalizeNoteNodeConfig(node)) {
      this.refreshNodeCardPreview(node);
    }
    if (!this.currentProject) {
      return;
    }
    void this.refreshNoteNodePreviewsFromVault(this.currentProject, {
      onlyNodeIds: new Set([node.id]),
    }).then(() => {
      this.render();
    });
  }

  private refreshNodeCardPreview(node: StudioNodeInstance): void {
    const nodeEl = this.graphInteraction.getNodeElement(node.id);
    if (!nodeEl) {
      return;
    }
    const previewEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-config-preview");
    if (!previewEl) {
      return;
    }
    previewEl.setText(formatNodeConfigPreview(node));
  }

  private handleNodeDragStateChange(isDragging: boolean): void {
    this.nodeDragInProgress = Boolean(isDragging);
    this.syncGraphInteractionVisualState();
    if (this.nodeDragInProgress) {
      this.nodeContextMenuOverlay?.hide();
      this.nodeActionContextMenuOverlay?.hide();
    }
  }

  private syncGraphInteractionVisualState(): void {
    if (!this.graphViewportEl) {
      return;
    }
    this.graphViewportEl.classList.toggle("is-interacting", this.nodeDragInProgress);
  }

  private syncGraphZoomVisualState(
    zoomOverride?: number,
    modeOverride?: StudioGraphZoomMode
  ): void {
    if (!this.graphViewportEl) {
      return;
    }
    const zoom = normalizeGraphZoom(zoomOverride ?? this.graphInteraction.getGraphZoom());
    const mode = modeOverride ?? this.graphZoomMode;
    this.graphViewportEl.classList.toggle("is-zoomed-far", zoom <= 0.5);
    this.graphViewportEl.classList.toggle("is-zoomed-extreme", zoom <= 0.2);
    this.graphViewportEl.classList.toggle("is-zoomed-micro", zoom <= 0.08);
    this.graphViewportEl.classList.toggle("is-zoom-overview", mode === "overview");
  }

  private collectRunScope(options?: { fromNodeId?: string }): {
    scopedProject: StudioProjectV1 | null;
    errors: string[];
  } {
    if (!this.currentProject) {
      return {
        scopedProject: null,
        errors: [],
      };
    }

    const fromNodeId = String(options?.fromNodeId || "").trim();
    let scopedProject: StudioProjectV1;
    try {
      scopedProject = scopeProjectForRun(
        this.currentProject,
        fromNodeId ? [fromNodeId] : undefined
      );
    } catch (error) {
      return {
        scopedProject: null,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }

    const errors: string[] = [];
    for (const node of scopedProject.graph.nodes) {
      const definition = this.findNodeDefinition(node);
      if (!definition) {
        errors.push(`Node "${node.title || node.id}" is missing a registered definition.`);
        continue;
      }

      const validation = validateNodeConfig(definition, node.config);
      for (const error of validation.errors) {
        const fieldLabel =
          definition.configSchema.fields.find((field) => field.key === error.fieldKey)?.label ||
          error.fieldKey;
        errors.push(`Node "${node.title || node.id}" • ${fieldLabel}: ${error.message}`);
      }

    }

    return {
      scopedProject,
      errors,
    };
  }

  private async runGraph(options?: StudioRunGraphOptions): Promise<void> {
    if (!this.currentProjectPath) {
      new Notice("Open a .systemsculpt file from the file explorer first.");
      return;
    }

    const removedStalePlaceholders = this.removePendingManagedOutputPlaceholders();
    if (removedStalePlaceholders) {
      this.render();
    }

    const scope = this.collectRunScope(options);
    if (scope.errors.length > 0) {
      this.setError(scope.errors[0]);
      return;
    }
    if (!scope.scopedProject) {
      this.setError("Open a .systemsculpt file from the file explorer first.");
      return;
    }

    const blockedNodes = collectStudioHostUnavailableNodes(
      scope.scopedProject,
      (node) => this.findNodeDefinition(node)
    );
    if (blockedNodes.length > 0) {
      new Notice(formatStudioHostUnavailableNodesNotice(blockedNodes));
      return;
    }

    const scopedNodeIds = scope.scopedProject.graph.nodes.map((node) => node.id);
    const fromNodeId = String(options?.fromNodeId || "").trim();
    this.runPresentation.beginRun(scopedNodeIds, {
      fromNodeId: fromNodeId || null,
    });

    await this.flushPendingProjectSaveWork({ force: true });

    this.setBusy(true);
    this.lastError = null;
    try {
      const studio = this.plugin.getStudioService();
      const result = fromNodeId
        ? await studio.runProjectFromNode(this.currentProjectPath, fromNodeId, {
            onEvent: (event) => {
              this.handleRunEvent(event);
            },
          })
        : await studio.runProject(this.currentProjectPath, {
            onEvent: (event) => {
              this.handleRunEvent(event);
            },
          });
      const executedCount = Array.isArray(result.executedNodeIds)
        ? result.executedNodeIds.length
        : 0;
      const cachedCount = Array.isArray(result.cachedNodeIds)
        ? result.cachedNodeIds.length
        : 0;
      const runStatsSuffix = ` (${executedCount} executed, ${cachedCount} cached)`;

      if (result.status === "success") {
        new Notice(
          fromNodeId
            ? `Studio run from node completed: ${result.runId}${runStatsSuffix}`
            : `Studio run completed: ${result.runId}${runStatsSuffix}`
        );
      } else {
        const rawRunError = String(result.error || result.runId || "");
        const runErrorSummary = this.summarizeMessageForNotice(rawRunError);
        new Notice(
          fromNodeId
            ? `Studio run from node failed: ${runErrorSummary}. See console for details.`
            : `Studio run failed: ${runErrorSummary}. See console for details.`
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.runPresentation.failBeforeRun(errorMessage);
      this.setError(error);
    } finally {
      this.setBusy(false);
    }
  }

  private currentProjectOrThrow(): StudioProjectV1 {
    if (!this.currentProject || !this.currentProjectPath) {
      throw new Error("Open a .systemsculpt file from the file explorer first.");
    }
    return this.currentProject;
  }

  private recomputeEntryNodes(project: StudioProjectV1): void {
    const executableNodeIds = new Set(
      project.graph.nodes
        .filter((node) => !isStudioVisualOnlyNodeKind(node.kind))
        .map((node) => node.id)
    );
    const inboundNodeIds = new Set(
      project.graph.edges
        .filter(
          (edge) =>
            executableNodeIds.has(edge.fromNodeId) &&
            executableNodeIds.has(edge.toNodeId)
        )
        .map((edge) => edge.toNodeId)
    );
    project.graph.entryNodeIds = project.graph.nodes
      .filter((node) => executableNodeIds.has(node.id) && !inboundNodeIds.has(node.id))
      .map((node) => node.id);
  }

  private findNode(project: StudioProjectV1, nodeId: string): StudioNodeInstance | null {
    return project.graph.nodes.find((node) => node.id === nodeId) || null;
  }

  private findNodeDefinition(node: StudioNodeInstance): StudioNodeDefinition | null {
    const definition = this.nodeDefinitionsByKey.get(`${node.kind}@${node.version}`) || null;
    if (!definition) {
      return null;
    }
    return resolveNodeDefinitionPorts(node, definition);
  }

  private portTypeCompatible(sourceType: string, targetType: string): boolean {
    if (sourceType === "any" || targetType === "any") {
      return true;
    }
    return sourceType === targetType;
  }

  private getPortType(nodeId: string, direction: "in" | "out", portId: string): string | null {
    const project = this.currentProject;
    if (!project) {
      return null;
    }

    const node = this.findNode(project, nodeId);
    if (!node) {
      return null;
    }

    const definition = this.findNodeDefinition(node);
    if (!definition) {
      return null;
    }

    if (direction === "in") {
      return definition.inputPorts.find((port) => port.id === portId)?.type || null;
    }

    return definition.outputPorts.find((port) => port.id === portId)?.type || null;
  }

  private resolveConnectionAutoCreateTemplate(sourceType: string): {
    nodeKind: string;
    targetPortId: string;
    label: string;
  } | null {
    const normalizedType = String(sourceType || "").trim();
    if (normalizedType === "text") {
      return {
        nodeKind: "studio.text_output",
        targetPortId: "text",
        label: "text output preview",
      };
    }
    if (normalizedType === "json" || normalizedType === "any") {
      return {
        nodeKind: normalizedType === "json" ? "studio.json" : "studio.value",
        targetPortId: normalizedType === "json" ? "json" : "value",
        label: normalizedType === "json" ? "JSON preview" : "value preview",
      };
    }
    if (normalizedType === "number" || normalizedType === "boolean") {
      return {
        nodeKind: "studio.value",
        targetPortId: "value",
        label: "value preview",
      };
    }
    return null;
  }

  private cloneJsonValue(value: StudioJsonValue): StudioJsonValue {
    try {
      return JSON.parse(JSON.stringify(value)) as StudioJsonValue;
    } catch {
      return value;
    }
  }

  private normalizeSeededTextValue(value: StudioJsonValue): string {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value == null) {
      return "";
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private buildAutoCreatedNodeTitle(nodeKind: string, fromPortId: string): string {
    const baseTitle = prettifyNodeKind(nodeKind);
    const sourcePort = String(fromPortId || "").trim();
    if (!sourcePort) {
      return baseTitle;
    }
    return `${baseTitle} (${sourcePort})`;
  }

  private resolveSourcePortValue(nodeId: string, portId: string): StudioJsonValue | undefined {
    const outputs = this.runPresentation.getNodeOutput(nodeId);
    if (!outputs || !Object.prototype.hasOwnProperty.call(outputs, portId)) {
      return undefined;
    }
    return outputs[portId];
  }

  private seedAutoCreatedNodeConfig(
    node: StudioNodeInstance,
    nodeKind: string,
    value: StudioJsonValue
  ): void {
    if (nodeKind === "studio.text_output") {
      node.config.value = this.normalizeSeededTextValue(value);
      return;
    }
    if (nodeKind === "studio.json") {
      node.config.value = this.cloneJsonValue(value);
      return;
    }
    if (nodeKind === "studio.value") {
      node.config.__studio_seed_value = this.cloneJsonValue(value);
    }
  }

  private buildSeededPreviewOutputs(
    nodeKind: string,
    value: StudioJsonValue
  ): StudioNodeOutputMap | null {
    if (nodeKind === "studio.text_output") {
      return {
        text: this.normalizeSeededTextValue(value),
      };
    }
    if (nodeKind === "studio.json") {
      return {
        json: this.cloneJsonValue(value),
      };
    }
    if (nodeKind === "studio.value") {
      return {
        value: this.cloneJsonValue(value),
      };
    }
    return null;
  }

  private describeConnectionAutoCreate(sourceType: string): ConnectionAutoCreateDescriptor | null {
    const template = this.resolveConnectionAutoCreateTemplate(sourceType);
    if (!template) {
      return null;
    }
    return {
      label: template.label,
    };
  }

  private graphPointFromClientPosition(clientX: number, clientY: number): { x: number; y: number } | null {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return null;
    }
    const rect = viewport.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
      return null;
    }
    const zoom = this.graphInteraction.getGraphZoom() || 1;
    return {
      x: (viewport.scrollLeft + localX) / zoom,
      y: (viewport.scrollTop + localY) / zoom,
    };
  }

  private handleConnectionAutoCreateRequested(request: ConnectionAutoCreateRequest): boolean {
    if (this.busy || !this.currentProject) {
      return false;
    }
    const template = this.resolveConnectionAutoCreateTemplate(request.sourceType);
    if (!template) {
      return false;
    }

    const sourceNode = this.findNode(this.currentProject, request.fromNodeId);
    if (!sourceNode) {
      return false;
    }

    const sourcePortType = this.getPortType(sourceNode.id, "out", request.fromPortId);
    if (!sourcePortType) {
      return false;
    }

    const definition = this.nodeDefinitions.find((entry) => entry.kind === template.nodeKind);
    if (!definition) {
      this.setError(`Missing node definition for "${template.nodeKind}@1.0.0".`);
      return false;
    }

    const anchor = this.graphPointFromClientPosition(request.clientX, request.clientY);
    if (!anchor) {
      return false;
    }

    const createdNode: StudioNodeInstance = {
      id: randomId("node"),
      kind: definition.kind,
      version: definition.version,
      title: this.buildAutoCreatedNodeTitle(template.nodeKind, request.fromPortId),
      position: this.normalizeNodePosition({
        x: anchor.x + 48,
        y: anchor.y + 10,
      }),
      config: cloneConfigDefaults(definition),
      continueOnError: false,
      disabled: false,
    };

    const sourceValue = this.resolveSourcePortValue(sourceNode.id, request.fromPortId);
    if (typeof sourceValue !== "undefined") {
      this.seedAutoCreatedNodeConfig(createdNode, template.nodeKind, sourceValue);
    }

    const createdNodeDefinition = resolveNodeDefinitionPorts(createdNode, definition);
    const targetPortType =
      createdNodeDefinition.inputPorts.find((port) => port.id === template.targetPortId)?.type || null;
    if (!targetPortType || !this.portTypeCompatible(sourcePortType, targetPortType)) {
      return false;
    }

    const changed = this.commitCurrentProjectMutation("graph.node.create", (project) => {
      project.graph.nodes.push(createdNode);
      project.graph.edges.push({
        id: randomId("edge"),
        fromNodeId: sourceNode.id,
        fromPortId: request.fromPortId,
        toNodeId: createdNode.id,
        toPortId: template.targetPortId,
      });
      return true;
    });
    if (!changed || !this.currentProject) {
      return false;
    }

    if (typeof sourceValue !== "undefined") {
      const previewOutputs = this.buildSeededPreviewOutputs(template.nodeKind, sourceValue);
      if (previewOutputs) {
        this.runPresentation.primeNodeOutput(createdNode.id, previewOutputs, {
          message: `Preview from ${request.fromPortId}`,
        });
      }
    }

    this.graphInteraction.selectOnlyNode(createdNode.id);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(this.currentProject);
    this.render();
    return true;
  }

  private computeDefaultNodePosition(
    project: StudioProjectV1,
    definition?: StudioNodeDefinition
  ): { x: number; y: number } {
    const index = project.graph.nodes.length;
    const sampleNode = {
      kind: definition?.kind || "studio.input",
      config: {},
    } as Pick<StudioNodeInstance, "kind" | "config">;
    const estimatedWidth = resolveStudioGraphNodeWidth(sampleNode) || STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
    const minHeight = resolveStudioGraphNodeMinHeight(sampleNode);
    const estimatedHeight = Math.max(STUDIO_GRAPH_DEFAULT_NODE_HEIGHT, minHeight);
    const columns = 3;
    const xStep = estimatedWidth + 88;
    const yStep = estimatedHeight + 64;
    return {
      x: 120 + (index % columns) * xStep,
      y: 120 + Math.floor(index / columns) * yStep,
    };
  }

  private normalizeNodePosition(position: { x: number; y: number }): { x: number; y: number } {
    return {
      x: Math.max(24, Math.round(normalizeGraphCoordinate(position.x))),
      y: Math.max(24, Math.round(normalizeGraphCoordinate(position.y))),
    };
  }

  private createNodeFromDefinition(
    definition: StudioNodeDefinition,
    options?: {
      position?: { x: number; y: number };
      autoEditText?: boolean;
    }
  ): StudioNodeInstance | null {
    let project: StudioProjectV1;
    try {
      project = this.currentProjectOrThrow();
    } catch (error) {
      this.setError(error);
      return null;
    }

    if (this.busy) {
      return null;
    }

    const position = options?.position
      ? this.normalizeNodePosition(options.position)
      : this.computeDefaultNodePosition(project, definition);
    const node: StudioNodeInstance = {
      id: randomId("node"),
      kind: definition.kind,
      version: definition.version,
      title: prettifyNodeKind(definition.kind),
      position,
      config: cloneConfigDefaults(definition),
      continueOnError: false,
      disabled: false,
    };

    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    const changed = this.commitCurrentProjectMutation("graph.node.create", (currentProject) => {
      currentProject.graph.nodes.push(node);
      return true;
    });
    if (!changed) {
      return null;
    }
    if (node.kind === "studio.text" && options?.autoEditText === true) {
      this.editingTextNodeIds.add(node.id);
      this.dirtyTextNodeEditIds.delete(node.id);
      this.pendingTextNodeAutofocusNodeId = node.id;
      this.pendingTextNodeFocusPointByNodeId.delete(node.id);
      this.textNodeEditorSnapshots.delete(node.id);
    } else {
      this.editingTextNodeIds.delete(node.id);
      this.dirtyTextNodeEditIds.delete(node.id);
      this.pendingTextNodeFocusPointByNodeId.delete(node.id);
      this.textNodeEditorSnapshots.delete(node.id);
    }
    this.graphInteraction.selectOnlyNode(node.id);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.render();
    return node;
  }

  private createTextNodeAtPosition(position: { x: number; y: number }): void {
    const definition = this.nodeDefinitions.find((entry) => entry.kind === "studio.text");
    if (!definition) {
      this.setError('Missing node definition for "studio.text@1.0.0".');
      return;
    }
    this.createNodeFromDefinition(definition, {
      position,
      autoEditText: true,
    });
  }

  private isTextNodeEditing(nodeId: string): boolean {
    return this.editingTextNodeIds.has(String(nodeId || "").trim());
  }

  private requestTextNodeEdit(
    nodeId: string,
    options?: { autoFocus?: boolean; focusAt?: StudioTextNodeFocusTarget }
  ): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    const wasEditing = this.editingTextNodeIds.has(normalizedNodeId);
    if (wasEditing && options?.autoFocus !== true) {
      return;
    }
    this.editingTextNodeIds.add(normalizedNodeId);
    if (!wasEditing) {
      this.dirtyTextNodeEditIds.delete(normalizedNodeId);
      this.textNodeEditorSnapshots.delete(normalizedNodeId);
    }
    if (options?.autoFocus === true) {
      this.pendingTextNodeAutofocusNodeId = normalizedNodeId;
      if (options.focusAt) {
        this.pendingTextNodeFocusPointByNodeId.set(normalizedNodeId, options.focusAt);
      } else {
        this.pendingTextNodeFocusPointByNodeId.delete(normalizedNodeId);
      }
    }
    this.render();
  }

  private stopTextNodeEdit(nodeId: string): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    if (!this.editingTextNodeIds.delete(normalizedNodeId)) {
      // Only a real edit session ends here; nodes that never entered edit
      // mode (programmatic callers, already-ended sessions) are untouched.
      return;
    }
    if (this.pendingTextNodeAutofocusNodeId === normalizedNodeId) {
      this.pendingTextNodeAutofocusNodeId = null;
    }
    this.pendingTextNodeFocusPointByNodeId.delete(normalizedNodeId);
    this.textNodeEditorSnapshots.delete(normalizedNodeId);
    const redoSnapshotsBeforeEmptyRemoval = this.historyState.redoSnapshots;
    if (this.removeTextNodeIfEmptyOnEditEnd(normalizedNodeId)) {
      // removeNodes captured the pre-edit graph and cleaned up interaction
      // state. Finalize history at the post-delete graph so undo restores the
      // original node and redo reapplies the deletion, still as one edit
      // transaction.
      if (this.currentProject) {
        this.setHistoryCurrentSnapshot(
          this.currentProject,
          this.graphInteraction.getSelectedNodeIds()
        );
        const latestUndoSnapshot =
          this.historyState.undoSnapshots[this.historyState.undoSnapshots.length - 1];
        if (
          latestUndoSnapshot &&
          serializeProjectSnapshot(latestUndoSnapshot.project) ===
            this.historyState.currentSerialized
        ) {
          // Creating a blank text node and immediately leaving it is a net-zero
          // graph interaction. Do not make the next Undo consume an identical
          // pre-creation snapshot and appear to do nothing, or discard a Redo
          // stack that existed before the temporary node was created.
          this.historyState.undoSnapshots.pop();
          this.historyState.redoSnapshots = redoSnapshotsBeforeEmptyRemoval;
        } else {
          // A real edit-and-delete invalidates any earlier redo branch even if
          // the pre-removal checkpoint did not need to add an undo snapshot.
          this.historyState.redoSnapshots = [];
        }
      }
      return;
    }
    if (this.dirtyTextNodeEditIds.delete(normalizedNodeId)) {
      this.captureProjectHistoryCheckpoint();
    }
    this.render();
  }

  /**
   * tldraw parity: when a `studio.text` edit session ends (blur, Escape,
   * click-away — every path funnels through `stopTextNodeEdit`) with no
   * visible content, the node is deleted in the same interaction instead
   * of leaving an empty husk on the canvas. The removal reuses
   * `removeNodes`, so it lands as a single "graph.node.remove" commit with
   * one history checkpoint — a single undo restores the node, with its
   * edit session closed — and it is intentionally silent: this is implicit
   * cleanup, not a user command, so no notice is shown.
   *
   * Deliberate non-goals: while the view is busy the node is left in place,
   * matching the manual Delete-key gating. Teardown paths (`onClose`,
   * project switches, history application) clear `editingTextNodeIds`
   * directly without ending the session, intentionally leaving an empty
   * node in the graph rather than racing a fresh mutation against the
   * pending save flush and session release.
   */
  private removeTextNodeIfEmptyOnEditEnd(nodeId: string): boolean {
    if (this.busy || !this.currentProject) {
      return false;
    }
    const node = this.findNode(this.currentProject, nodeId);
    if (!node || node.kind !== "studio.text") {
      return false;
    }
    if (readStudioTextNodeValue(node).trim().length > 0) {
      return false;
    }
    return this.removeNodes([nodeId]);
  }

  /**
   * Text-node edit sessions run in Obsidian's own embedded live-preview
   * markdown editor, so editing a text card feels exactly like editing a
   * note: syntax renders live, tables and checkboxes stay interactive. The
   * factory returns null when the internal editor cannot be built, and the
   * card falls back to its plain textarea.
   */
  private readonly createTextNodeMarkdownEditor: StudioTextNodeMarkdownEditorFactory = (
    containerEl,
    options
  ) => {
    return createEmbeddableMarkdownEditor(this.app, containerEl, {
      value: options.value,
      placeholder: options.placeholder,
      focusAt: options.focusAt,
      sourcePath: this.currentProjectPath || "",
      nodeId: options.nodeId,
      onChange: options.onChange,
      onEscape: options.onEscape,
      onBlur: options.onBlur,
    });
  };

  private registerTextNodeEditorTeardown(
    nodeId: string,
    teardown: () => StudioTextNodeMarkdownEditorSnapshot
  ): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    const previousTeardown = this.textNodeEditorTeardowns.get(normalizedNodeId);
    if (previousTeardown) {
      try {
        const snapshot = previousTeardown();
        if (this.editingTextNodeIds.has(normalizedNodeId)) {
          this.textNodeEditorSnapshots.set(normalizedNodeId, snapshot);
        }
      } catch (error) {
        this.textNodeEditorSnapshots.delete(normalizedNodeId);
        console.warn("[SystemSculpt Studio] Failed to replace a text-node editor", {
          nodeId: normalizedNodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.textNodeEditorTeardowns.set(normalizedNodeId, teardown);
  }

  /**
   * Destroys every live embedded editor before the graph replaces card DOM.
   * Active edit sessions retain their native selection, scroll, and focus so
   * unrelated graph renders remount the editor without interrupting typing.
   */
  private disposeTextNodeEditors(): void {
    const teardowns = Array.from(this.textNodeEditorTeardowns.entries());
    this.textNodeEditorTeardowns.clear();
    for (const [nodeId, teardown] of teardowns) {
      try {
        const snapshot = teardown();
        if (this.editingTextNodeIds.has(nodeId)) {
          this.textNodeEditorSnapshots.set(nodeId, snapshot);
        } else {
          this.textNodeEditorSnapshots.delete(nodeId);
        }
      } catch (error) {
        this.textNodeEditorSnapshots.delete(nodeId);
        console.warn("[SystemSculpt Studio] Failed to dispose a text-node editor", {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private consumeTextNodeAutoFocus(nodeId: string): boolean {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return false;
    }
    if (this.pendingTextNodeAutofocusNodeId !== normalizedNodeId) {
      return false;
    }
    this.pendingTextNodeAutofocusNodeId = null;
    return true;
  }

  private consumeTextNodeFocusPoint(
    nodeId: string
  ): StudioTextNodeFocusTarget | undefined {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return undefined;
    }
    const point = this.pendingTextNodeFocusPointByNodeId.get(normalizedNodeId);
    this.pendingTextNodeFocusPointByNodeId.delete(normalizedNodeId);
    return point;
  }

  private consumeTextNodeEditorSnapshot(
    nodeId: string
  ): StudioTextNodeMarkdownEditorSnapshot | undefined {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return undefined;
    }
    const snapshot = this.textNodeEditorSnapshots.get(normalizedNodeId);
    this.textNodeEditorSnapshots.delete(normalizedNodeId);
    return snapshot;
  }

  private openNodeDefinitionMenu(options: {
    graphX: number;
    graphY: number;
    menuX: number;
    menuY: number;
    zoom: number;
  }): void {
    if (!this.currentProject || !this.graphViewportEl) {
      return;
    }

    const contextMenuItems = buildNodeInsertMenuItems(this.nodeDefinitions);
    if (contextMenuItems.length === 0) {
      new Notice("No node definitions are available.");
      return;
    }

    const selectedNodeIds = this.graphInteraction.getSelectedNodeIds();
    const canGroupSelection = selectedNodeIds.length > 1;
    this.nodeActionContextMenuOverlay?.hide();
    const contextMenu = this.ensureNodeContextMenuOverlay();
    contextMenu.mount(this.graphViewportEl);
    contextMenu.setGraphZoom(options.zoom);
    contextMenu.open({
      anchorX: options.menuX,
      anchorY: options.menuY,
      items: contextMenuItems,
      actions: canGroupSelection
        ? [
            {
              id: "group-selected-nodes",
              title: "Group Selected Nodes",
              summary: `Create a group around ${selectedNodeIds.length} selected nodes.`,
              onSelect: () => {
                this.createGroupFromSelectedNodes(selectedNodeIds);
              },
            },
          ]
        : [],
      onSelectDefinition: (definition) => {
        this.createNodeFromDefinition(definition, {
          position: { x: options.graphX, y: options.graphY },
        });
      },
    });
  }

  private openNodeContextMenuAtPointer(event: MouseEvent): void {
    if (this.busy || !this.graphViewportEl || !this.currentProject) {
      return;
    }

    const viewport = this.graphViewportEl;
    const rect = viewport.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
      return;
    }

    const zoom = this.graphInteraction.getGraphZoom() || 1;
    const graphX = (viewport.scrollLeft + localX) / zoom;
    const graphY = (viewport.scrollTop + localY) / zoom;
    const menuX = normalizeGraphCoordinate(viewport.scrollLeft + localX);
    const menuY = normalizeGraphCoordinate(viewport.scrollTop + localY);
    const selectedNodeIds = this.graphInteraction.getSelectedNodeIds();
    const selectedNodeIdSet = new Set(selectedNodeIds);
    const canGroupSelection = selectedNodeIds.length > 1;
    const target =
      typeof (event.target as { closest?: unknown } | null)?.closest === "function"
        ? (event.target as HTMLElement)
        : null;
    const contextNodeCard = target?.closest<HTMLElement>(".ss-studio-node-card");
    const contextNodeId = String(contextNodeCard?.dataset.nodeId || "").trim();
    if (contextNodeId) {
      if (canGroupSelection && selectedNodeIdSet.has(contextNodeId)) {
        this.openNodeDefinitionMenu({
          graphX,
          graphY,
          menuX,
          menuY,
          zoom,
        });
        return;
      }
      this.openNodeActionContextMenuAtPointer({
        nodeId: contextNodeId,
        menuX,
        menuY,
        zoom,
      });
      return;
    }
    this.openNodeDefinitionMenu({
      graphX,
      graphY,
      menuX,
      menuY,
      zoom,
    });
  }

  private openNodeActionContextMenuAtPointer(options: {
    nodeId: string;
    menuX: number;
    menuY: number;
    zoom: number;
  }): void {
    if (!this.currentProject || !this.graphViewportEl) {
      return;
    }

    const nodeId = String(options.nodeId || "").trim();
    if (!nodeId) {
      return;
    }
    const contextNode = this.findNode(this.currentProject, nodeId);
    if (!contextNode) {
      return;
    }
    const containingGroup = this.findGroupContainingNode(nodeId);
    if (!containingGroup) {
      this.nodeActionContextMenuOverlay?.hide();
      return;
    }

    this.nodeContextMenuOverlay?.hide();
    const contextMenu = this.ensureNodeActionContextMenuOverlay();
    contextMenu.mount(this.graphViewportEl);
    contextMenu.setGraphZoom(options.zoom);
    contextMenu.open({
      anchorX: options.menuX,
      anchorY: options.menuY,
      title: "Node Actions",
      subtitle: contextNode.title || contextNode.id,
      width: 250,
      items: [
        {
          id: "disconnect-from-group",
          title: "Disconnect from group",
          summary: "Remove this node from its group and move it outside the group boundary.",
          onSelect: () => {
            this.disconnectNodeFromGroup(nodeId);
          },
        },
      ],
    });
  }

  private findGroupContainingNode(nodeId: string): {
    group: NonNullable<StudioProjectV1["graph"]["groups"]>[number];
    index: number;
  } | null {
    if (!this.currentProject) {
      return null;
    }

    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return null;
    }

    const groups = this.currentProject.graph.groups || [];
    const index = groups.findIndex((group) =>
      Array.isArray(group.nodeIds) && group.nodeIds.some((candidate) => candidate === normalizedNodeId)
    );
    if (index < 0) {
      return null;
    }
    const group = groups[index];
    if (!group) {
      return null;
    }
    return { group, index };
  }

  private disconnectNodeFromGroup(nodeId: string): void {
    if (!this.currentProject || this.busy) {
      return;
    }

    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    const node = this.findNode(this.currentProject, normalizedNodeId);
    const containingGroup = this.findGroupContainingNode(normalizedNodeId);
    if (!node || !containingGroup) {
      return;
    }

    const bounds = computeStudioGraphGroupBounds(this.currentProject, containingGroup.group, {
      getNodeWidth: (candidateNodeId) => {
        const nodeEl = this.graphInteraction.getNodeElement(candidateNodeId);
        return nodeEl ? nodeEl.offsetWidth : null;
      },
      getNodeHeight: (candidateNodeId) => {
        const nodeEl = this.graphInteraction.getNodeElement(candidateNodeId);
        return nodeEl ? nodeEl.offsetHeight : null;
      },
    });
    const changed = this.commitCurrentProjectMutation("graph.group", (project) => {
      const targetNode = this.findNode(project, normalizedNodeId);
      if (!targetNode) {
        return false;
      }
      const removed = removeNodesFromGroups(project, [normalizedNodeId]);
      if (!removed) {
        return false;
      }
      if (bounds) {
        targetNode.position = this.normalizeNodePosition({
          x: bounds.left + bounds.width + GROUP_DISCONNECT_OFFSET_X,
          y: targetNode.position.y,
        });
      }
      return true;
    });
    if (!changed) {
      return;
    }

    this.nodeActionContextMenuOverlay?.hide();
    this.graphInteraction.selectOnlyNode(normalizedNodeId);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(this.currentProject);
    this.render();
  }

  private createGroupFromSelectedNodes(selectedNodeIds: string[]): void {
    if (this.busy || !this.currentProject) {
      return;
    }

    let createdGroupId: string | null = null;
    const changed = this.commitCurrentProjectMutation("graph.group", (project) => {
      const createdGroup = createNodeGroupFromSelection(project, selectedNodeIds, () => randomId("group"));
      if (!createdGroup) {
        return false;
      }
      createdGroupId = createdGroup.id;
      return true;
    });
    if (!changed || !createdGroupId) {
      new Notice("Select at least two nodes to create a group.");
      return;
    }

    this.graphInteraction.requestGroupNameEdit(createdGroupId);
    this.render();
  }

  private removeNodes(nodeIds: string[]): boolean {
    if (!this.currentProject) {
      return false;
    }

    const idsToRemove = new Set(
      nodeIds
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => nodeId.length > 0)
    );
    if (idsToRemove.size === 0) {
      return false;
    }

    if (!this.currentProject.graph.nodes.some((node) => idsToRemove.has(node.id))) {
      return false;
    }

    const changed = this.commitCurrentProjectMutation("graph.node.remove", (project) => {
      const previousCount = project.graph.nodes.length;
      project.graph.nodes = project.graph.nodes.filter((node) => !idsToRemove.has(node.id));
      if (project.graph.nodes.length === previousCount) {
        return false;
      }
      project.graph.edges = project.graph.edges.filter(
        (edge) => !idsToRemove.has(edge.fromNodeId) && !idsToRemove.has(edge.toNodeId)
      );
      removeNodesFromGroups(project, Array.from(idsToRemove));
      return true;
    });
    if (!changed) {
      return false;
    }

    for (const nodeId of idsToRemove) {
      this.runPresentation.removeNode(nodeId);
      this.graphInteraction.onNodeRemoved(nodeId);
      this.editingTextNodeIds.delete(nodeId);
      this.dirtyTextNodeEditIds.delete(nodeId);
      this.pendingTextNodeFocusPointByNodeId.delete(nodeId);
      this.textNodeEditorSnapshots.delete(nodeId);
      if (this.pendingTextNodeAutofocusNodeId === nodeId) {
        this.pendingTextNodeAutofocusNodeId = null;
      }
    }
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.recomputeEntryNodes(this.currentProject);
    this.render();
    return true;
  }

  private removeNode(nodeId: string): void {
    this.removeNodes([nodeId]);
  }

  private handleGraphZoomChanged(zoom: number, context: StudioGraphZoomChangeContext): void {
    this.graphZoomMode = context.mode;
    this.graphZoomGestureInFlight = !context.settled;
    this.syncGraphZoomVisualState(zoom, context.mode);
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    if (!context.settled) {
      return;
    }
    if (context.mode === "overview") {
      return;
    }
    this.nodeContextMenuOverlay?.setGraphZoom(zoom);
    this.nodeActionContextMenuOverlay?.setGraphZoom(zoom);
    this.captureGraphViewportState({ zoomOverride: zoom, requestLayoutSave: true });
  }

  private handleGraphViewportScrolled(): void {
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.markViewportScrolling();
    if (this.graphZoomGestureInFlight || this.graphZoomMode === "overview") {
      return;
    }
    if (this.viewportScrollCaptureFrame !== null) {
      return;
    }
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }
    const ownerWindow = getStudioOwnerWindow(viewport);
    this.viewportScrollCaptureWindow = ownerWindow;
    this.viewportScrollCaptureFrame = ownerWindow.requestAnimationFrame(() => {
      this.viewportScrollCaptureFrame = null;
      this.viewportScrollCaptureWindow = null;
      this.captureGraphViewportState({ requestLayoutSave: true });
    });
  }

  private markViewportScrolling(): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }
    viewport.classList.add("is-scrolling");
    this.clearViewportScrollingClassTimer();
    const ownerWindow = getStudioOwnerWindow(viewport);
    this.viewportScrollingClassTimerWindow = ownerWindow;
    this.viewportScrollingClassTimer = ownerWindow.setTimeout(() => {
      this.viewportScrollingClassTimer = null;
      this.viewportScrollingClassTimerWindow = null;
      if (this.graphViewportEl) {
        this.graphViewportEl.classList.remove("is-scrolling");
      }
    }, 140);
  }

  private resetViewportScrollingState(): void {
    this.clearViewportScrollCaptureFrame();
    this.clearViewportScrollingClassTimer();
    this.graphViewportEl?.classList.remove("is-scrolling");
  }

  private blurActiveStudioEditableTarget(): void {
    const activeElement = getStudioOwnerDocument(this.contentEl).activeElement;
    if (!activeElement || typeof (activeElement as { blur?: unknown }).blur !== "function") {
      return;
    }
    if (!this.contentEl.contains(activeElement)) {
      return;
    }
    if (!this.isEditableKeyboardTarget(activeElement)) {
      return;
    }
    (activeElement as HTMLElement).blur();
  }

  private handleGraphViewportPointerDown(event: PointerEvent): void {
    if (this.isEditableKeyboardTarget(event.target)) {
      return;
    }
    this.blurActiveStudioEditableTarget();
  }

  private async revealPathInFinder(path: string): Promise<void> {
    const rawPath = String(path || "").trim();
    if (!rawPath) {
      new Notice("No media path available to reveal.");
      return;
    }
    if (!Platform.isDesktopApp) {
      new Notice("Reveal in Finder is desktop-only.");
      return;
    }

    const normalizedPath = rawPath.replace(/\\/g, "/");
    const isAbsolutePath = isAbsoluteFilesystemPath(normalizedPath);
    const adapter = this.app.vault.adapter as {
      revealInFolder?: (path: string) => void | Promise<void>;
    };
    const revealTarget = isAbsolutePath ? rawPath : normalizedPath;
    if (typeof adapter.revealInFolder === "function") {
      try {
        await Promise.resolve(adapter.revealInFolder(revealTarget));
        return;
      } catch {
        // Fallback to Electron shell reveal.
      }
    }

    const absolutePath = isAbsolutePath
      ? rawPath
      : resolveAbsoluteVaultPath(this.app.vault.adapter, normalizedPath);
    if (!absolutePath) {
      new Notice(`Unable to resolve media path: ${rawPath}`);
      return;
    }

    const runtimeRequire = (getStudioOwnerWindow(this.contentEl) as any)?.require;
    const electron = typeof runtimeRequire === "function" ? runtimeRequire("electron") : null;
    const shell = electron?.shell;
    try {
      if (typeof shell?.showItemInFolder === "function") {
        shell.showItemInFolder(absolutePath);
        return;
      }
    } catch {
      // Continue through shell fallbacks.
    }
    try {
      if (typeof shell?.openPath === "function") {
        await shell.openPath(absolutePath);
        return;
      }
    } catch {
      // Continue through shell fallbacks.
    }
    try {
      if (typeof shell?.openExternal === "function") {
        await shell.openExternal(`file://${encodeURI(absolutePath)}`);
        return;
      }
    } catch {
      // Fall through to notice.
    }

    new Notice(`Unable to open in Finder: ${rawPath}`);
  }

  private renderGraphEditor(root: HTMLElement): void {
    const nodeDetailMode = this.readCurrentNodeDetailMode();
    const result = renderStudioGraphWorkspace({
      root,
      busy: this.busy,
      currentProject: this.currentProject,
      currentProjectPath: this.currentProjectPath,
      nodeDetailMode,
      graphInteraction: this.graphInteraction,
      getNodeRunState: (nodeId) => this.runPresentation.getNodeState(nodeId),
      findNodeDefinition: (node) => this.findNodeDefinition(node),
      resolveAssetPreviewSrc: (assetPath) => resolveStudioAssetPreviewSrc(this.app, assetPath),
      onRunGraph: () => {
        void this.runGraph();
      },
      onOpenAddNodeMenuAtViewportCenter: () => {
        this.openAddNodeMenuAtViewportCenter();
      },
      onZoomIn: () => {
        this.adjustGraphZoomFromRibbon(1.1);
      },
      onZoomOut: () => {
        this.adjustGraphZoomFromRibbon(1 / 1.1);
      },
      onZoomReset: () => {
        this.resetGraphZoomFromRibbon();
      },
      onZoomOverview: () => {
        this.fitGraphOverviewInViewport();
      },
      onToggleNodeDetailMode: () => {
        this.toggleCurrentNodeDetailMode();
      },
      onOpenMediaPreview: (options) => {
        openStudioMediaPreviewModal(this.app, options);
      },
      onOpenNodeContextMenu: (event) => {
        this.openNodeContextMenuAtPointer(event);
      },
      onCreateTextNodeAtPosition: (position) => {
        this.createTextNodeAtPosition(position);
      },
      onRunNode: (nodeId) => {
        void this.runGraph({ fromNodeId: nodeId });
      },
      onCopyTextGenerationPromptBundle: (nodeId) => {
        void this.copyTextGenerationPromptBundle(nodeId);
      },
      onToggleTextGenerationOutputLock: (nodeId) => {
        this.toggleTextGenerationOutputLock(nodeId);
      },
      onRemoveNode: (nodeId) => {
        this.removeNode(nodeId);
      },
      onNodeTitleInput: (node, title) => {
        const changed = this.commitCurrentProjectMutation("node.title", (project) => {
          const target = this.findNode(project, node.id);
          if (!target || target.title === title) {
            return false;
          }
          target.title = title;
          return true;
        });
        if (!changed) {
          return;
        }
      },
      onNodeConfigMutated: (node) => {
        this.handleNodeConfigMutated(node);
      },
      onNodeConfigValueChange: (nodeId, key, value, options) => {
        this.handleNodeConfigValueChange(nodeId, key, value, options);
      },
      onNodeResize: (nodeId, patch, options) => {
        this.handleNodeResize(nodeId, patch, options);
      },
      onOpenImageEditor: (node) => {
        this.openImageEditorForNode(node);
      },
      onEditImageWithAi: (node) => {
        void this.editImageWithAiForNode(node);
      },
      onCopyNodeImageToClipboard: (node) => {
        void this.copyImageForNodeToClipboard(node);
      },
      getJsonEditorPreferredMode: () => this.readJsonEditorPreferredMode(),
      onJsonEditorPreferredModeChange: (mode) => this.updateJsonEditorPreferredMode(mode),
      renderMarkdownPreview: (node, markdown, containerEl) => {
        return this.renderNodeMarkdownPreview(node, markdown, containerEl);
      },
      onNodeGeometryMutated: () => {
        this.graphInteraction.notifyNodePositionsChanged();
      },
      isTextNodeEditing: (nodeId) => this.isTextNodeEditing(nodeId),
      consumeTextNodeAutoFocus: (nodeId) => this.consumeTextNodeAutoFocus(nodeId),
      consumeTextNodeFocusPoint: (nodeId) => this.consumeTextNodeFocusPoint(nodeId),
      consumeTextNodeEditorSnapshot: (nodeId) =>
        this.consumeTextNodeEditorSnapshot(nodeId),
      onRequestTextNodeEdit: (nodeId, focusAt) =>
        this.requestTextNodeEdit(nodeId, { autoFocus: true, focusAt }),
      onStopTextNodeEdit: (nodeId) => this.stopTextNodeEdit(nodeId),
      createTextNodeMarkdownEditor: this.createTextNodeMarkdownEditor,
      registerTextNodeEditorTeardown: (nodeId, teardown) =>
        this.registerTextNodeEditorTeardown(nodeId, teardown),
      onRevealPathInFinder: (path) => {
        void this.revealPathInFinder(path);
      },
      pathBrowseOptions: this.pathBrowseOptions(),
      resolveNodeBadge: (node) => this.resolveNodeCardBadge(node),
    });

    this.graphViewportEl = result.viewportEl;
    if (!this.graphViewportEl || !this.currentProject) {
      this.nodeDragInProgress = false;
      this.nodeContextMenuOverlay?.hide();
      this.nodeActionContextMenuOverlay?.hide();
      return;
    }
    this.syncGraphInteractionVisualState();

    this.graphViewportEl.addEventListener("scroll", () => {
      this.handleGraphViewportScrolled();
    }, { passive: true });
    this.graphViewportEl.addEventListener("pointerdown", (event) => {
      this.handleGraphViewportPointerDown(event);
    }, true);
    this.clipboardAndDropController.bindViewport(this.graphViewportEl);
    this.restoreGraphViewportState(this.graphViewportEl);
    this.syncGraphZoomVisualState();
    const contextMenu = this.ensureNodeContextMenuOverlay();
    const nodeActionMenu = this.ensureNodeActionContextMenuOverlay();
    contextMenu.setGraphZoom(this.graphInteraction.getGraphZoom());
    nodeActionMenu.setGraphZoom(this.graphInteraction.getGraphZoom());
    contextMenu.mount(this.graphViewportEl);
    nodeActionMenu.mount(this.graphViewportEl);
  }

  private captureGraphViewportState(options?: {
    zoomOverride?: number;
    requestLayoutSave?: boolean;
    allowOverview?: boolean;
  }): void {
    this.projectSessionController.captureGraphViewportState(options);
  }

  private restoreGraphViewportState(viewport: HTMLElement): void {
    this.projectSessionController.restoreGraphViewportState(viewport);
  }

  /**
   * Ask Obsidian to re-read getDisplayText() so the tab title reflects the
   * current project path.  Uses the public setViewState API; the subsequent
   * setState→loadProjectFromPath call is a no-op when the path hasn't changed.
   */
  private refreshLeafDisplay(): void {
    try {
      this.leaf?.setViewState({
        type: this.getViewType(),
        state: this.getState(),
      });
    } catch {
      // Best-effort – never block the caller.
    }
  }

  private render(): void {
    this.captureGraphViewportState();
    this.resetViewportScrollingState();
    // The render below replaces all card DOM; destroy live editors first.
    this.disposeTextNodeEditors();
    this.graphInteraction.clearRenderBindings();
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.nodeDragInProgress = false;
    this.clipboardAndDropController.bindViewport(null);
    this.graphViewportEl = null;

    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "ss-studio-view" });
    applyPluginSurface(root, "view");

    if (this.lastError) {
      root.createDiv({
        text: this.lastError,
        cls: "ss-studio-error",
      });
    }
    if (this.projectLiveSyncWarning) {
      root.createDiv({
        text: this.projectLiveSyncWarning,
        cls: "ss-studio-warning",
      });
    }

    this.renderGraphEditor(root);
  }
}
