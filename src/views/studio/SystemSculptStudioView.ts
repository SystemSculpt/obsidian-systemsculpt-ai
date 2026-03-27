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
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
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
  StudioProjectSession,
  type StudioProjectSessionAutosaveMode,
  type StudioProjectSessionMutationReason,
} from "../../studio/StudioProjectSession";
import { renderStudioGraphWorkspace } from "./graph-v3/StudioGraphWorkspaceRenderer";
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
import { openStudioAiImageEditPromptModal } from "./graph-v3/StudioGraphAiImageEditPromptModal";
import { composeStudioCaptionBoardImage } from "../../studio/StudioCaptionBoardComposition";
import {
  boardStateHasRenderableEdits,
  readStudioCaptionBoardState,
  resolveStudioCaptionBoardRenderedAsset,
  writeStudioCaptionBoardState,
} from "../../studio/StudioCaptionBoardState";
import {
  getSavedGraphViewState,
  getSavedNodeDetailMode,
  normalizeGraphCoordinate,
  normalizeGraphZoom,
  parseNodeDetailModeByProject,
  parseGraphViewStateByProject,
  serializeNodeDetailModeByProject,
  serializeGraphViewStateByProject,
  type StudioGraphViewState,
  type StudioGraphViewStateByProject,
  type StudioNodeDetailModeByProject,
  type StudioGraphViewportState,
  upsertGraphViewStateForProject,
} from "./graph-v3/StudioGraphViewStateStore";
import {
  STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY,
  STUDIO_NODE_DETAIL_DEFAULT_MODE,
  type StudioNodeDetailMode,
} from "./graph-v3/StudioGraphNodeDetailMode";
import {
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
  STUDIO_GRAPH_DEFAULT_NODE_HEIGHT,
  STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
} from "./graph-v3/StudioGraphNodeGeometry";
import { StudioGraphInteractionEngine } from "./StudioGraphInteractionEngine";
import {
  STUDIO_GRAPH_DEFAULT_ZOOM,
  type ConnectionAutoCreateDescriptor,
  type ConnectionAutoCreateRequest,
  type StudioGraphZoomChangeContext,
  type StudioGraphZoomMode,
} from "./StudioGraphInteractionTypes";
import {
  type StudioNodeInspectorRuntimeDetails,
  StudioNodeInspectorLayout,
  StudioNodeInspectorOverlay,
} from "./StudioNodeInspectorOverlay";
import { StudioNodeContextMenuOverlay } from "./StudioNodeContextMenuOverlay";
import { StudioSimpleContextMenuOverlay } from "./StudioSimpleContextMenuOverlay";
import {
  statusLabelForNode,
  StudioRunPresentationState,
} from "./StudioRunPresentationState";
import {
  cloneConfigDefaults,
  describeNodeDefinition,
  definitionKey,
  formatNodeConfigPreview,
  prettifyNodeKind,
} from "./StudioViewHelpers";
import { removePendingManagedOutputNodes } from "../../studio/StudioManagedOutputNodes";
import { isStudioGraphEditableTarget } from "./StudioGraphDomTargeting";
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
  buildGraphClipboardPayload,
  cloneProjectSnapshot,
  normalizeNodeIdList,
  parseGraphClipboardPayload,
  STUDIO_GRAPH_CLIPBOARD_SCHEMA,
  type StudioGraphClipboardPayload,
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
import { materializeGraphClipboardPaste } from "./systemsculpt-studio-view/StudioGraphClipboardPasteMaterializer";
import {
  extractClipboardImageFiles,
  extractClipboardText,
  normalizePastedImageMimeType,
} from "./systemsculpt-studio-view/StudioClipboardData";
import {
  buildPastedTextNode,
  materializePastedMediaNodes,
} from "./systemsculpt-studio-view/StudioClipboardPasteNodes";
import {
  inferAiImageEditAspectRatio,
  insertAiImageEditNodes,
} from "./systemsculpt-studio-view/StudioAiImageEditFlow";
import {
  coerceNotePreviewText,
  isTextGenerationOutputLocked,
  readFirstTextValue,
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
  parsePathReferencesFromText,
  resolveVaultItemFromReference,
} from "./systemsculpt-studio-view/StudioVaultReferenceResolver";
import {
  isStudioProjectPath,
  remapPathScopedRecord,
  resolveProjectPathAfterFolderRename,
} from "./systemsculpt-studio-view/StudioProjectPathState";
import { repairStudioProjectForLoad } from "../../studio/StudioProjectRepairs";
import { SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "../../core/plugin/viewTypes";

export { SYSTEMSCULPT_STUDIO_VIEW_TYPE };

const DEFAULT_INSPECTOR_LAYOUT: StudioNodeInspectorLayout = {
  x: 36,
  y: 88,
  width: 420,
  height: 460,
};
const GROUP_DISCONNECT_OFFSET_X = 36;
const STUDIO_GRAPH_HISTORY_MAX_SNAPSHOTS = 120;
const STUDIO_GRAPH_SELECTION_FIT_PADDING_PX = 25;

type SystemSculptStudioViewState = {
  inspectorLayout?: unknown;
  file?: unknown;
  graphViewByProject?: unknown;
  nodeDetailModeByProject?: unknown;
};

type StudioRunGraphOptions = {
  fromNodeId?: string;
};

export class SystemSculptStudioView extends ItemView {
  private currentProject: StudioProjectV1 | null = null;
  private currentProjectPath: string | null = null;
  private currentProjectSession: StudioProjectSession | null = null;
  private busy = false;
  private lastError: string | null = null;
  private nodeDefinitions: StudioNodeDefinition[] = [];
  private nodeDefinitionsByKey = new Map<string, StudioNodeDefinition>();
  private layoutSaveTimer: number | null = null;
  private viewportScrollCaptureFrame: number | null = null;
  private viewportScrollingClassTimer: number | null = null;
  private projectLiveSyncWarning: string | null = null;
  private graphViewportEl: HTMLElement | null = null;
  private graphViewportProjectPath: string | null = null;
  private inspectorOverlay: StudioNodeInspectorOverlay | null = null;
  private nodeContextMenuOverlay: StudioNodeContextMenuOverlay | null = null;
  private nodeActionContextMenuOverlay: StudioSimpleContextMenuOverlay | null = null;
  private inspectorLayout: StudioNodeInspectorLayout = { ...DEFAULT_INSPECTOR_LAYOUT };
  private nodeDragInProgress = false;
  private transientFieldErrorsByNodeId = new Map<string, Map<string, string>>();
  private graphViewStateByProjectPath: StudioGraphViewStateByProject = {};
  private nodeDetailModeByProjectPath: StudioNodeDetailModeByProject = {};
  private pendingViewportState: StudioGraphViewportState | null = null;
  private editingLabelNodeIds = new Set<string>();
  private pendingLabelAutofocusNodeId: string | null = null;
  private readonly runPresentation = new StudioRunPresentationState();
  private readonly graphInteraction: StudioGraphInteractionEngine;
  private graphZoomMode: StudioGraphZoomMode = "interactive";
  private graphZoomGestureInFlight = false;
  private lastGraphPointerPosition: { x: number; y: number } | null = null;
  private vaultEventRefs: EventRef[] = [];
  private graphClipboardPayload: StudioGraphClipboardPayload | null = null;
  private graphClipboardPasteCount = 0;
  private readonly historyState = createStudioGraphHistoryState();
  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    this.handleWindowKeyDown(event);
  };
  private readonly onWindowPaste = (event: ClipboardEvent): void => {
    void this.handleWindowPaste(event);
  };

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
        this.commitCurrentProjectMutation(reason, mutator, options),
      requestRender: () => this.render(),
      onNodeDragStateChange: (isDragging) => this.handleNodeDragStateChange(isDragging),
      onGraphZoomChanged: (zoom, context) => this.handleGraphZoomChanged(zoom, context),
      getPortType: (nodeId, direction, portId) => this.getPortType(nodeId, direction, portId),
      portTypeCompatible: (sourceType, targetType) => this.portTypeCompatible(sourceType, targetType),
      describeConnectionAutoCreate: (sourceType) => this.describeConnectionAutoCreate(sourceType),
      onConnectionAutoCreateRequested: (request) => this.handleConnectionAutoCreateRequested(request),
    });
    this.graphInteraction.setSelectionChangeListener(() => {
      this.syncInspectorSelection();
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
    this.captureGraphViewportState();
    const state: Record<string, unknown> = {
      inspectorLayout: { ...this.inspectorLayout },
    };
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

  async setState(state: unknown, result: any): Promise<void> {
    await super.setState(state, result);
    const rawState = (state || {}) as SystemSculptStudioViewState;
    const rawLayout = rawState.inspectorLayout;
    this.graphViewStateByProjectPath = parseGraphViewStateByProject(rawState.graphViewByProject);
    this.nodeDetailModeByProjectPath = parseNodeDetailModeByProject(rawState.nodeDetailModeByProject);
    if (rawLayout && typeof rawLayout === "object") {
      const candidate = rawLayout as Partial<StudioNodeInspectorLayout>;
      this.inspectorLayout = {
        x: Number.isFinite(candidate.x) ? Number(candidate.x) : DEFAULT_INSPECTOR_LAYOUT.x,
        y: Number.isFinite(candidate.y) ? Number(candidate.y) : DEFAULT_INSPECTOR_LAYOUT.y,
        width: Number.isFinite(candidate.width) ? Number(candidate.width) : DEFAULT_INSPECTOR_LAYOUT.width,
        height: Number.isFinite(candidate.height)
          ? Number(candidate.height)
          : DEFAULT_INSPECTOR_LAYOUT.height,
      };
    }
    const filePath = typeof rawState.file === "string"
      ? (rawState.file || "")
      : "";
    await this.loadProjectFromPath(filePath || null, { notifyOnError: false });
    this.render();
  }

  async onOpen(): Promise<void> {
    window.addEventListener("keydown", this.onWindowKeyDown, true);
    window.addEventListener("paste", this.onWindowPaste, true);
    this.bindVaultEvents();
    await this.loadNodeDefinitions();
    this.render();
  }

  async onClose(): Promise<void> {
    window.removeEventListener("keydown", this.onWindowKeyDown, true);
    window.removeEventListener("paste", this.onWindowPaste, true);
    this.unbindVaultEvents();
    this.graphClipboardPayload = null;
    this.graphClipboardPasteCount = 0;
    this.resetProjectHistory(null);
    this.captureGraphViewportState();
    this.app.workspace.requestSaveLayout();
    await this.flushPendingProjectSaveWork();
    this.clearSaveTimer();
    this.clearLayoutSaveTimer();
    this.resetViewportScrollingState();
    this.runPresentation.reset();
    this.clearProjectLiveSyncState();
    this.currentProjectSession = null;
    this.currentProjectPath = null;
    this.currentProject = null;
    this.editingLabelNodeIds.clear();
    this.pendingLabelAutofocusNodeId = null;
    this.inspectorOverlay?.destroy();
    this.inspectorOverlay = null;
    this.nodeContextMenuOverlay?.destroy();
    this.nodeContextMenuOverlay = null;
    this.nodeActionContextMenuOverlay?.destroy();
    this.nodeActionContextMenuOverlay = null;
    this.pendingViewportState = null;
    this.graphViewportEl = null;
    this.graphViewportProjectPath = null;
    this.lastGraphPointerPosition = null;
    this.graphInteraction.clearRenderBindings();
    this.contentEl.empty();
  }

  private bindVaultEvents(): void {
    if (this.vaultEventRefs.length > 0) {
      return;
    }
    this.vaultEventRefs.push(
      this.app.vault.on("modify", (file) => {
        void this.handleVaultItemModified(file);
      })
    );
    this.vaultEventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.handleVaultItemRenamed(file, oldPath);
      })
    );
    this.vaultEventRefs.push(
      this.app.vault.on("delete", (file) => {
        void this.handleVaultItemDeleted(file);
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
    this.currentProject = this.currentProjectSession.getProject();
    this.transientFieldErrorsByNodeId.clear();
    this.runPresentation.reset();
    this.editingLabelNodeIds.clear();
    this.pendingLabelAutofocusNodeId = null;
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.graphInteraction.clearPendingConnection({ requestRender: false });
    this.graphInteraction.clearProjectState();
    this.recomputeEntryNodes(this.currentProject);
    this.setHistoryCurrentSnapshot(this.currentProject, nextSelection);
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

  private async syncGraphClipboardToSystemClipboard(payload: StudioGraphClipboardPayload): Promise<void> {
    try {
      const serialized = JSON.stringify(payload);
      await tryCopyToClipboard(serialized);
    } catch {
      // Best-effort clipboard mirroring only.
    }
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

  private copySelectedGraphNodesToClipboard(options?: { showNotice?: boolean }): boolean {
    if (this.busy || !this.currentProject) {
      return false;
    }
    const payload = this.currentProject
      ? buildGraphClipboardPayload({
          project: this.currentProject,
          selectedNodeIds: this.graphInteraction.getSelectedNodeIds(),
        })
      : null;
    if (!payload) {
      return false;
    }
    this.graphClipboardPayload = payload;
    this.graphClipboardPasteCount = 0;
    void this.syncGraphClipboardToSystemClipboard(payload);
    if (options?.showNotice !== false) {
      new Notice(payload.nodes.length === 1 ? "Copied 1 node." : `Copied ${payload.nodes.length} nodes.`);
    }
    return true;
  }

  private cutSelectedGraphNodesToClipboard(): boolean {
    if (this.busy || !this.currentProject) {
      return false;
    }
    const selectedNodeIds = this.graphInteraction.getSelectedNodeIds();
    if (selectedNodeIds.length === 0) {
      return false;
    }
    if (!this.copySelectedGraphNodesToClipboard({ showNotice: false })) {
      return false;
    }
    this.removeNodes(selectedNodeIds);
    new Notice(selectedNodeIds.length === 1 ? "Cut 1 node." : `Cut ${selectedNodeIds.length} nodes.`);
    return true;
  }

  private pasteGraphClipboardPayload(payloadOverride?: StudioGraphClipboardPayload): boolean {
    if (this.busy || !this.currentProject || !this.currentProjectPath) {
      return false;
    }
    const payload = payloadOverride || this.graphClipboardPayload;
    if (!payload) {
      return false;
    }
    if (
      payload.schema !== STUDIO_GRAPH_CLIPBOARD_SCHEMA ||
      !Array.isArray(payload.nodes) ||
      payload.nodes.length === 0
    ) {
      return false;
    }

    const project = this.currentProject;
    const materializedPaste = materializeGraphClipboardPaste({
      payload,
      anchor: this.resolvePasteAnchorPosition(),
      pasteCount: this.graphClipboardPasteCount,
      normalizeNodePosition: (position) => this.normalizeNodePosition(position),
      nextNodeId: () => randomId("node"),
      nextEdgeId: () => randomId("edge"),
      nextGroupId: () => randomId("group"),
    });
    if (!materializedPaste) {
      return false;
    }
    const { newNodes, newEdges, newGroups, nextSelection } = materializedPaste;

    const changed = this.commitCurrentProjectMutation("graph.node.create", (currentProject) => {
      currentProject.graph.nodes.push(...newNodes);
      if (newEdges.length > 0) {
        currentProject.graph.edges.push(...newEdges);
      }
      if (newGroups.length > 0) {
        if (!Array.isArray(currentProject.graph.groups)) {
          currentProject.graph.groups = [];
        }
        currentProject.graph.groups.push(...newGroups);
      }
      return true;
    });
    if (!changed) {
      return false;
    }

    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.graphInteraction.clearPendingConnection({ requestRender: false });
    this.graphInteraction.setSelectedNodeIds(nextSelection);
    this.recomputeEntryNodes(project);
    this.render();
    const pastedNoteNodeIds = newNodes
      .filter((node) => node.kind === "studio.note")
      .map((node) => node.id);
    if (pastedNoteNodeIds.length > 0) {
      void this.refreshNoteNodePreviewsFromVault(project, {
        onlyNodeIds: new Set(pastedNoteNodeIds),
      }).then(() => {
        this.render();
      });
    }
    this.graphClipboardPasteCount += 1;
    new Notice(newNodes.length === 1 ? "Pasted 1 node." : `Pasted ${newNodes.length} nodes.`);
    return true;
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
          handled = this.copySelectedGraphNodesToClipboard();
        } else if (normalizedKey === "x" && !event.shiftKey) {
          handled = this.cutSelectedGraphNodesToClipboard();
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

  private resolveMarkdownVaultPathFromReference(reference: string): string | null {
    const item = resolveVaultItemFromReference({
      reference,
      getAbstractFileByPath: (path) => this.app.vault.getAbstractFileByPath(path),
      resolveVaultPathFromAbsoluteFilePath: (absolutePath) =>
        this.resolveVaultPathFromAbsoluteFilePath(absolutePath),
    });
    if (!this.isMarkdownVaultFile(item)) {
      return null;
    }
    return item.path;
  }

  private resolvePasteAnchorPosition(): { x: number; y: number } {
    const pointer = this.lastGraphPointerPosition;
    if (pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
      return {
        x: pointer.x,
        y: pointer.y,
      };
    }

    const viewport = this.graphViewportEl;
    if (viewport) {
      const zoom = this.graphInteraction.getGraphZoom() || 1;
      return {
        x: (viewport.scrollLeft + viewport.clientWidth * 0.5) / zoom,
        y: (viewport.scrollTop + viewport.clientHeight * 0.5) / zoom,
      };
    }

    if (this.currentProject) {
      return this.computeDefaultNodePosition(this.currentProject);
    }

    return { x: 120, y: 120 };
  }

  private async handleWindowPaste(event: ClipboardEvent): Promise<void> {
    if (event.defaultPrevented) {
      return;
    }
    if (!this.isActiveStudioView()) {
      return;
    }
    if (this.busy || !this.currentProject || !this.currentProjectPath) {
      return;
    }
    if (this.isEditableKeyboardTarget(event.target)) {
      return;
    }

    const pastedText = extractClipboardText(event);
    const graphClipboardPayload = parseGraphClipboardPayload(pastedText);
    if (graphClipboardPayload) {
      const previousCreatedAt = this.graphClipboardPayload?.createdAt || "";
      this.graphClipboardPayload = graphClipboardPayload;
      if (previousCreatedAt !== graphClipboardPayload.createdAt) {
        this.graphClipboardPasteCount = 0;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        this.pasteGraphClipboardPayload(graphClipboardPayload);
      } catch (error) {
        this.setError(error);
      }
      return;
    }

    const imageFiles = extractClipboardImageFiles(event);
    if (imageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      try {
        await this.pasteClipboardImages(imageFiles);
      } catch (error) {
        this.setError(error);
      }
      return;
    }

    if (!pastedText || pastedText.trim().length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      const notePath =
        pastedText.includes("\n") || pastedText.includes("\r")
          ? null
          : this.resolveMarkdownVaultPathFromReference(pastedText);
      if (notePath) {
        await this.insertVaultNoteNodes([notePath], this.resolvePasteAnchorPosition(), {
          source: "paste",
        });
        return;
      }
      this.pasteClipboardText(pastedText);
    } catch (error) {
      this.setError(error);
    }
  }

  private pasteClipboardText(text: string): void {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const textDefinition = this.nodeDefinitions.find((definition) => definition.kind === "studio.text");
    if (!textDefinition) {
      throw new Error("Text node definition is unavailable.");
    }

    const project = this.currentProject;
    const node = buildPastedTextNode({
      textDefinition,
      text,
      position: this.resolvePasteAnchorPosition(),
      nextNodeId: () => randomId("node"),
      prettifyNodeKind,
      cloneConfigDefaults: (definition) => cloneConfigDefaults(definition),
      normalizeNodePosition: (position) => this.normalizeNodePosition(position),
    });
    const changed = this.commitCurrentProjectMutation("graph.node.create", (currentProject) => {
      currentProject.graph.nodes.push(node);
      return true;
    });
    if (!changed) {
      return;
    }
    this.graphInteraction.selectOnlyNode(node.id);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.render();
    new Notice("Pasted text as a Text node.");
  }

  private async pasteClipboardImages(imageFiles: File[]): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }

    const mediaDefinition = this.nodeDefinitions.find(
      (definition) => definition.kind === "studio.media_ingest"
    );
    if (!mediaDefinition) {
      throw new Error("Media node definition is unavailable.");
    }

    const studio = this.plugin.getStudioService();
    const project = this.currentProject;
    const nodes = await materializePastedMediaNodes({
      imageFiles,
      mediaDefinition,
      anchor: this.resolvePasteAnchorPosition(),
      projectPath: this.currentProjectPath,
      nextNodeId: () => randomId("node"),
      normalizeNodePosition: (position) => this.normalizeNodePosition(position),
      normalizeMimeType: normalizePastedImageMimeType,
      storeAsset: async (projectPath, bytes, mimeType) =>
        await studio.storeAsset(projectPath, bytes, mimeType),
      prettifyNodeKind,
      cloneConfigDefaults: (definition) => cloneConfigDefaults(definition),
    });
    if (nodes.length === 0) {
      return;
    }
    const changed = this.commitCurrentProjectMutation("graph.node.create", (currentProject) => {
      currentProject.graph.nodes.push(...nodes);
      return true;
    });
    if (!changed) {
      return;
    }
    const createdNodeIds = nodes.map((node) => node.id);

    this.graphInteraction.selectOnlyNode(createdNodeIds[createdNodeIds.length - 1]);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.render();
    new Notice(
      createdNodeIds.length === 1
        ? "Pasted 1 image as a Media node."
        : `Pasted ${createdNodeIds.length} images as Media nodes.`
    );
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
      this.clearTransientFieldErrorsForNode(nodeId);
      this.runPresentation.removeNode(nodeId);
      this.graphInteraction.onNodeRemoved(nodeId);
      this.editingLabelNodeIds.delete(nodeId);
      if (this.pendingLabelAutofocusNodeId === nodeId) {
        this.pendingLabelAutofocusNodeId = null;
      }
    }
    this.recomputeEntryNodes(this.currentProject);
    return true;
  }

  private clearSaveTimer(): void {
    // Legacy wrapper retained while mutation call sites are still view-routed.
  }

  private clearLayoutSaveTimer(): void {
    if (this.layoutSaveTimer !== null) {
      window.clearTimeout(this.layoutSaveTimer);
      this.layoutSaveTimer = null;
    }
  }

  private clearViewportScrollCaptureFrame(): void {
    if (this.viewportScrollCaptureFrame !== null) {
      window.cancelAnimationFrame(this.viewportScrollCaptureFrame);
      this.viewportScrollCaptureFrame = null;
    }
  }

  private clearViewportScrollingClassTimer(): void {
    if (this.viewportScrollingClassTimer !== null) {
      window.clearTimeout(this.viewportScrollingClassTimer);
      this.viewportScrollingClassTimer = null;
    }
  }

  private hasPendingLocalProjectSaveWork(): boolean {
    return this.currentProjectSession?.hasPendingLocalSaveWork() === true;
  }

  private async readStudioProjectRawText(projectPath: string): Promise<string | null> {
    const normalized = normalizePath(String(projectPath || "").trim());
    if (!normalized || !isStudioProjectPath(normalized)) {
      return null;
    }
    const adapter = this.app.vault.adapter as { read?: (path: string) => Promise<string> };
    if (typeof adapter.read !== "function") {
      return null;
    }
    try {
      return await adapter.read(normalized);
    } catch {
      return null;
    }
  }

  private markAcceptedProjectSignature(signature: string, options?: { trackExpectedWrite?: boolean }): void {
    this.currentProjectSession?.markAcceptedProjectSignature(signature, options);
  }

  private clearProjectLiveSyncState(): void {
    this.projectLiveSyncWarning = null;
    this.currentProjectSession?.clearLiveSyncState();
  }

  private applySelectionToCurrentProject(nodeIds: string[]): void {
    if (!this.currentProject) {
      return;
    }
    const nodeIdSet = new Set(this.currentProject.graph.nodes.map((node) => node.id));
    const nextSelection = normalizeNodeIdList(nodeIds).filter((nodeId) => nodeIdSet.has(nodeId));
    this.graphInteraction.setSelectedNodeIds(nextSelection);
    this.setHistoryCurrentSnapshot(this.currentProject, nextSelection);
  }

  private async processCurrentProjectFileMutation(rawText: string): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath || !this.currentProjectSession) {
      return;
    }
    const update = this.currentProjectSession.resolveExternalProjectTextUpdate(rawText, {
      isActiveProjectFile: true,
    });
    if (update.decision.kind === "ignore") {
      return;
    }
    if (update.decision.kind === "defer") {
      return;
    }

    const lintResult = this.plugin.getStudioService().lintProjectText(rawText);
    if (!lintResult.ok) {
      this.currentProjectSession.markRejectedProjectSignature(update.signature);
      this.projectLiveSyncWarning = `External .systemsculpt change rejected: ${lintResult.error}`;
      this.render();
      return;
    }

    const selectedNodeIds = this.graphInteraction.getSelectedNodeIds();
    await this.loadProjectFromPath(this.currentProjectPath, {
      notifyOnError: false,
      forceReload: true,
    });
    this.applySelectionToCurrentProject(selectedNodeIds);
    this.projectLiveSyncWarning = null;
    this.currentProjectSession?.markAcceptedProjectSignature(update.signature);
    this.lastError = null;
    this.render();
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

  private scheduleLayoutSave(): void {
    this.clearLayoutSaveTimer();
    this.layoutSaveTimer = window.setTimeout(() => {
      this.layoutSaveTimer = null;
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
    if (options?.captureHistory !== false) {
      this.captureProjectHistoryCheckpoint();
    }
    return this.plugin.getStudioService().mutateCurrentProject(reason, mutator, {
      mode: options?.mode || "discrete",
    });
  }

  private async commitCurrentProjectMutationAsync(
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => Promise<boolean | void>,
    options?: {
      captureHistory?: boolean;
      mode?: StudioProjectSessionAutosaveMode;
    }
  ): Promise<boolean> {
    if (options?.captureHistory !== false) {
      this.captureProjectHistoryCheckpoint();
    }
    return await this.plugin.getStudioService().mutateCurrentProjectAsync(reason, mutator, {
      mode: options?.mode || "discrete",
    });
  }

  private scheduleSessionPersistFromLegacyMutation(options?: {
    captureHistory?: boolean;
    mode?: StudioProjectSessionAutosaveMode;
  }): void {
    if (options?.captureHistory !== false) {
      this.captureProjectHistoryCheckpoint();
    }
    this.currentProjectSession?.schedulePersist({ mode: options?.mode || "discrete" });
  }

  private async flushPendingProjectSaveWork(options?: {
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
      this.setError(error);
    } finally {
      void this.processPendingExternalProjectSync();
    }
  }

  private async flushProjectSave(options?: { showNotice?: boolean }): Promise<void> {
    await this.flushPendingProjectSaveWork({ force: true, showNotice: options?.showNotice });
  }

  private async loadProjectFromPath(
    projectPath: string | null,
    options?: { notifyOnError?: boolean; forceReload?: boolean }
  ): Promise<void> {
    if (!Platform.isDesktopApp) {
      return;
    }

    if (projectPath !== this.currentProjectPath && this.currentProjectPath && this.currentProject) {
      await this.flushPendingProjectSaveWork();
    }

    if (projectPath !== this.currentProjectPath || options?.forceReload) {
      this.captureGraphViewportState();
      this.editingLabelNodeIds.clear();
      this.pendingLabelAutofocusNodeId = null;
    }

    if (!projectPath) {
      await this.plugin.getStudioService().closeCurrentProject();
      this.currentProjectSession = null;
      this.currentProjectPath = null;
      this.currentProject = null;
      this.resetProjectHistory(null);
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.pendingViewportState = null;
      this.syncInspectorSelection();
      this.clearProjectLiveSyncState();
      return;
    }

    if (!isStudioProjectPath(projectPath)) {
      await this.plugin.getStudioService().closeCurrentProject();
      this.currentProjectSession = null;
      this.currentProjectPath = null;
      this.currentProject = null;
      this.resetProjectHistory(null);
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.pendingViewportState = null;
      this.syncInspectorSelection();
      this.clearProjectLiveSyncState();
      if (options?.notifyOnError !== false) {
        new Notice("SystemSculpt Studio only opens .systemsculpt files.");
      }
      return;
    }

    if (!options?.forceReload && this.currentProjectPath === projectPath && this.currentProject) {
      return;
    }

    try {
      const studio = this.plugin.getStudioService();
      const session = await studio.openProjectSession(projectPath, {
        forceReload: options?.forceReload,
      });
      const project = session.getProject();
      const savedGraphView = getSavedGraphViewState(this.graphViewStateByProjectPath, projectPath);
      this.currentProjectSession = session;
      this.currentProjectPath = projectPath;
      this.currentProject = project;
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(savedGraphView?.zoom ?? STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.pendingViewportState = savedGraphView
        ? { ...savedGraphView, projectPath }
        : {
            scrollLeft: 0,
            scrollTop: 0,
            zoom: this.graphInteraction.getGraphZoom(),
            projectPath,
          };
      await this.commitCurrentProjectMutationAsync(
        "project.repair",
        async (currentProject) => {
          return repairStudioProjectForLoad(currentProject);
        },
        { captureHistory: false }
      );
      try {
        const cacheSnapshot = await studio.getProjectNodeCache(projectPath);
        if (cacheSnapshot) {
          this.runPresentation.hydrateFromCache(cacheSnapshot.entries, {
            allowedNodeIds: project.graph.nodes.map((node) => node.id),
          });
          this.materializeManagedOutputNodesFromCache(cacheSnapshot.entries);
        }
      } catch (cacheError) {
        console.warn("[SystemSculpt Studio] Unable to hydrate cache state on project load", {
          projectPath,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
      }
      await this.commitCurrentProjectMutationAsync(
        "project.repair",
        async (currentProject) => await this.refreshNoteNodePreviewsFromVault(currentProject),
        { captureHistory: false }
      );
      this.resetProjectHistory(project);
      const loadedRawText = await this.readStudioProjectRawText(projectPath);
      if (loadedRawText != null) {
        this.currentProjectSession?.markAcceptedProjectText(loadedRawText);
      } else {
        this.currentProjectSession?.clearLiveSyncState();
      }
      this.projectLiveSyncWarning = null;
      this.lastError = null;
      this.syncInspectorSelection();
    } catch (error) {
      await this.plugin.getStudioService().closeCurrentProject();
      this.currentProjectSession = null;
      this.currentProjectPath = null;
      this.currentProject = null;
      this.resetProjectHistory(null);
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.pendingViewportState = null;
      this.syncInspectorSelection();
      this.clearProjectLiveSyncState();
      this.lastError = error instanceof Error ? error.message : String(error);
      if (options?.notifyOnError !== false) {
        this.setError(error);
      }
    }
  }

  private async handleVaultItemModified(file: TAbstractFile): Promise<void> {
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
    if (!this.isMarkdownVaultFile(file)) {
      return;
    }
    const matchingNodeIds = this.currentProject.graph.nodes
      .filter((node) => {
        if (node.kind !== "studio.note") {
          return false;
        }
        return this.readAllNotePathsFromConfig(node).includes(modifiedPath);
      })
      .map((node) => node.id);
    if (matchingNodeIds.length === 0) {
      return;
    }

    await this.commitCurrentProjectMutationAsync(
      "vault.sync",
      async (project) =>
        await this.refreshNoteNodePreviewsFromVault(project, {
          onlyNodeIds: new Set(matchingNodeIds),
        }),
      { captureHistory: false }
    );
    this.render();
  }

  private async handleVaultItemRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const previousPath = normalizePath(String(oldPath || "").trim());
    if (!previousPath) {
      return;
    }
    const renamedPath = normalizePath(String(file.path || "").trim());
    if (previousPath === this.currentProjectPath) {
      const selectedNodeIds = this.graphInteraction.getSelectedNodeIds();
      if (!isStudioProjectPath(renamedPath)) {
        await this.loadProjectFromPath(null, { notifyOnError: false });
        this.render();
        return;
      }
      this.graphViewStateByProjectPath = remapPathScopedRecord(
        this.graphViewStateByProjectPath,
        previousPath,
        renamedPath
      );
      this.nodeDetailModeByProjectPath = remapPathScopedRecord(
        this.nodeDetailModeByProjectPath,
        previousPath,
        renamedPath
      );
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
      this.render();
      this.refreshLeafDisplay();
      return;
    }
    const remappedProjectPath = this.isVaultFolder(file)
      ? resolveProjectPathAfterFolderRename({
          currentProjectPath: this.currentProjectPath,
          previousFolderPath: previousPath,
          nextFolderPath: renamedPath,
        })
      : null;
    if (remappedProjectPath) {
      const selectedNodeIds = this.graphInteraction.getSelectedNodeIds();
      if (!isStudioProjectPath(remappedProjectPath)) {
        await this.loadProjectFromPath(null, { notifyOnError: false });
        this.render();
        return;
      }
      this.graphViewStateByProjectPath = remapPathScopedRecord(
        this.graphViewStateByProjectPath,
        this.currentProjectPath,
        remappedProjectPath
      );
      this.nodeDetailModeByProjectPath = remapPathScopedRecord(
        this.nodeDetailModeByProjectPath,
        this.currentProjectPath,
        remappedProjectPath
      );
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
      this.render();
      this.refreshLeafDisplay();
      return;
    }

    const changed = await this.commitCurrentProjectMutationAsync(
      "vault.sync",
      async (project) => {
        let nextChanged = false;
        const changedNodeIds = new Set<string>();
        if (this.isMarkdownVaultFile(file)) {
          for (const node of project.graph.nodes) {
            if (node.kind !== "studio.note") {
              continue;
            }
            if (this.normalizeNoteNodeConfig(node)) {
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
              node.title = file.basename || node.title;
            }
            nextChanged = true;
            changedNodeIds.add(node.id);
          }
        } else if (this.isVaultFolder(file)) {
          const prefix = `${previousPath}/`;
          for (const node of project.graph.nodes) {
            if (node.kind !== "studio.note") {
              continue;
            }
            if (this.normalizeNoteNodeConfig(node)) {
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
          const hydrated = await this.refreshNoteNodePreviewsFromVault(project, {
            onlyNodeIds: changedNodeIds,
          });
          nextChanged = nextChanged || hydrated;
        }
        return nextChanged;
      },
      { captureHistory: false }
    );
    if (!changed) {
      return;
    }
    this.render();
  }

  private async handleVaultItemDeleted(file: TAbstractFile): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const deletedPath = normalizePath(String(file.path || "").trim());
    if (!deletedPath) {
      return;
    }
    if (deletedPath === this.currentProjectPath || this.currentProjectPath.startsWith(`${deletedPath}/`)) {
      await this.loadProjectFromPath(null, { notifyOnError: false });
      this.render();
      return;
    }

    const matchingNodeIds = new Set<string>();
    if (this.isMarkdownVaultFile(file)) {
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        if (!this.readAllNotePathsFromConfig(node).includes(deletedPath)) {
          continue;
        }
        matchingNodeIds.add(node.id);
      }
    } else if (this.isVaultFolder(file)) {
      const prefix = `${deletedPath}/`;
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        const hasMatch = this.readAllNotePathsFromConfig(node).some((path) => path.startsWith(prefix));
        if (!hasMatch) {
          continue;
        }
        matchingNodeIds.add(node.id);
      }
    }

    if (matchingNodeIds.size === 0) {
      return;
    }
    const changed = await this.commitCurrentProjectMutationAsync(
      "vault.sync",
      async (project) =>
        await this.refreshNoteNodePreviewsFromVault(project, {
          onlyNodeIds: matchingNodeIds,
        }),
      { captureHistory: false }
    );
    if (!changed) {
      this.render();
      return;
    }
    this.render();
  }

  private resolveNodeCardBadge(node: StudioNodeInstance): {
    text: string;
    tone: "warning";
    title: string;
  } | null {
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

  private setTransientFieldError(nodeId: string, fieldKey: string, message: string | null): void {
    const normalizedNodeId = String(nodeId || "").trim();
    const normalizedKey = String(fieldKey || "").trim();
    if (!normalizedNodeId || !normalizedKey) {
      return;
    }

    const normalizedMessage = String(message || "").trim();
    const perNode = this.transientFieldErrorsByNodeId.get(normalizedNodeId) || new Map<string, string>();
    if (!normalizedMessage) {
      perNode.delete(normalizedKey);
      if (perNode.size === 0) {
        this.transientFieldErrorsByNodeId.delete(normalizedNodeId);
      } else {
        this.transientFieldErrorsByNodeId.set(normalizedNodeId, perNode);
      }
      return;
    }

    perNode.set(normalizedKey, normalizedMessage);
    this.transientFieldErrorsByNodeId.set(normalizedNodeId, perNode);
  }

  private clearTransientFieldErrorsForNode(nodeId: string): void {
    this.transientFieldErrorsByNodeId.delete(String(nodeId || "").trim());
  }

  private async resolveDynamicSelectOptionsForNode(
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ): Promise<StudioNodeConfigSelectOption[]> {
    return this.plugin.getStudioService().resolveDynamicSelectOptions(source, node);
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
    return getSavedNodeDetailMode(this.nodeDetailModeByProjectPath, this.currentProjectPath);
  }

  private updateCurrentNodeDetailMode(mode: StudioNodeDetailMode): void {
    const projectPath = String(this.currentProjectPath || "").trim();
    if (!projectPath) {
      return;
    }
    const nextMode = mode === "collapsed" ? "collapsed" : STUDIO_NODE_DETAIL_DEFAULT_MODE;
    const previousMode = getSavedNodeDetailMode(this.nodeDetailModeByProjectPath, projectPath);
    if (previousMode === nextMode) {
      return;
    }

    this.nodeDetailModeByProjectPath = {
      ...this.nodeDetailModeByProjectPath,
      [projectPath]: nextMode,
    };
    this.scheduleLayoutSave();
    this.render();
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

  private ensureInspectorOverlay(): StudioNodeInspectorOverlay {
    if (this.inspectorOverlay) {
      return this.inspectorOverlay;
    }

    this.inspectorOverlay = new StudioNodeInspectorOverlay(
      {
        isBusy: () => this.busy,
        onConfigMutated: (node) => {
          this.handleNodeConfigMutated(node);
        },
        onTransientFieldError: (nodeId, fieldKey, message) => {
          this.setTransientFieldError(nodeId, fieldKey, message);
        },
        resolveDynamicSelectOptions: (source, node) =>
          this.resolveDynamicSelectOptionsForNode(source, node),
        getRuntimeDetails: (nodeId) => this.buildInspectorRuntimeDetails(nodeId),
        onLayoutChanged: (layout) => {
          this.inspectorLayout = { ...layout };
        },
      },
      this.inspectorLayout
    );
    return this.inspectorOverlay;
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
        captureHistory: options?.captureHistory,
        mode: options?.mode,
      }
    );
    if (!changed || !this.currentProject) {
      return;
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

  private handleNodeSizeChange(
    nodeId: string,
    size: { width: number; height: number },
    options?: {
      mode?: StudioProjectSessionAutosaveMode;
      captureHistory?: boolean;
    }
  ): void {
    const nextWidth = Math.max(1, Math.round(size.width));
    const nextHeight = Math.max(1, Math.round(size.height));
    const changed = this.commitCurrentProjectMutation(
      "node.geometry",
      (project) => {
        const target = this.findNode(project, nodeId);
        if (!target) {
          return false;
        }
        const previousWidth = Number(target.config.width);
        const previousHeight = Number(target.config.height);
        if (previousWidth === nextWidth && previousHeight === nextHeight) {
          return false;
        }
        target.config.width = nextWidth;
        target.config.height = nextHeight;
        return true;
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

    const textDefinition = this.nodeDefinitions.find((definition) => definition.kind === "studio.text");
    const imageGenerationDefinition = this.nodeDefinitions.find(
      (definition) => definition.kind === "studio.image_generation"
    );
    if (!textDefinition || !imageGenerationDefinition) {
      this.setError("Studio image-edit dependencies are unavailable.");
      return;
    }

    const prompt = await openStudioAiImageEditPromptModal({
      app: this.app,
      title: "Edit with AI",
      description:
        "Describe how you want the AI to change this image. Studio will add an AI image step, keep the original image, and append the edited result.",
    });
    if (!prompt) {
      return;
    }

    const aspectRatio = await this.resolveAiImageEditAspectRatioForNode(node);
    let createdImageGenerationNodeId: string | null = null;
    const changed = this.commitCurrentProjectMutation("graph.node.create", (project) => {
      const sourceNode = this.findNode(project, node.id);
      if (!sourceNode) {
        return false;
      }
      const inserted = insertAiImageEditNodes({
        project,
        sourceNode,
        prompt,
        aspectRatio,
        textDefinition,
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
    new Notice("AI image edit added. Running now...");
    void this.runGraph({ fromNodeId: createdImageGenerationNodeId });
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
      const imageEl = new Image();
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
    const copied = await tryCopyImageFileToClipboard(this.app, file);
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

  private buildInspectorRuntimeDetails(nodeId: string): StudioNodeInspectorRuntimeDetails | null {
    const state = this.runPresentation.getNodeState(nodeId);
    const outputs = state.outputs;
    const hasOutput = Boolean(outputs && Object.keys(outputs).length > 0);
    const hasStatus = state.status !== "idle" || state.message.trim().length > 0;
    if (!hasOutput && !hasStatus) {
      return null;
    }

    const outputPath =
      readFirstTextValue(outputs?.path);
    const outputText = coerceNotePreviewText(outputs?.text, outputs?.path);
    return {
      statusLabel: statusLabelForNode(state.status),
      statusTone: state.status,
      statusMessage: state.message,
      outputPath: outputPath || undefined,
      outputText: outputText || undefined,
      outputs,
      updatedAt: state.updatedAt,
    };
  }

  private handleNodeDragStateChange(isDragging: boolean): void {
    this.nodeDragInProgress = Boolean(isDragging);
    this.syncGraphInteractionVisualState();
    if (this.nodeDragInProgress) {
      this.inspectorOverlay?.hide();
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
    this.graphViewportEl.classList.toggle("is-zoomed-far", zoom <= 0.56);
    this.graphViewportEl.classList.toggle("is-zoomed-extreme", zoom <= 0.4);
    this.graphViewportEl.classList.toggle("is-zoom-overview", mode === "overview");
  }

  private syncInspectorSelection(): void {
    // Studio config editing is now inline-only on node cards.
    this.inspectorOverlay?.hide();
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

      const transientErrors = this.transientFieldErrorsByNodeId.get(node.id);
      if (transientErrors) {
        for (const [fieldKey, message] of transientErrors.entries()) {
          const fieldLabel =
            definition.configSchema.fields.find((field) => field.key === fieldKey)?.label ||
            fieldKey;
          errors.push(`Node "${node.title || node.id}" • ${fieldLabel}: ${message}`);
        }
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
        ? await studio.runCurrentProjectFromNode(fromNodeId, {
            onEvent: (event) => {
              this.handleRunEvent(event);
            },
          })
        : await studio.runCurrentProject({
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
        nodeKind: "studio.text",
        targetPortId: "text",
        label: "text preview",
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
    if (nodeKind === "studio.text") {
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
    if (nodeKind === "studio.text") {
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
      autoEditLabel?: boolean;
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
    if (node.kind === "studio.label" && options?.autoEditLabel === true) {
      this.editingLabelNodeIds.add(node.id);
      this.pendingLabelAutofocusNodeId = node.id;
    } else {
      this.editingLabelNodeIds.delete(node.id);
    }
    this.graphInteraction.selectOnlyNode(node.id);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.render();
    return node;
  }

  private createLabelAtPosition(position: { x: number; y: number }): void {
    const definition = this.nodeDefinitions.find((entry) => entry.kind === "studio.label");
    if (!definition) {
      this.setError('Missing node definition for "studio.label@1.0.0".');
      return;
    }
    this.createNodeFromDefinition(definition, {
      position,
      autoEditLabel: true,
    });
  }

  private isLabelNodeEditing(nodeId: string): boolean {
    return this.editingLabelNodeIds.has(String(nodeId || "").trim());
  }

  private requestLabelNodeEdit(nodeId: string, options?: { autoFocus?: boolean }): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    if (this.editingLabelNodeIds.has(normalizedNodeId) && options?.autoFocus !== true) {
      return;
    }
    this.editingLabelNodeIds.add(normalizedNodeId);
    if (options?.autoFocus === true) {
      this.pendingLabelAutofocusNodeId = normalizedNodeId;
    }
    this.render();
  }

  private stopLabelNodeEdit(nodeId: string): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    if (!this.editingLabelNodeIds.delete(normalizedNodeId)) {
      return;
    }
    if (this.pendingLabelAutofocusNodeId === normalizedNodeId) {
      this.pendingLabelAutofocusNodeId = null;
    }
    this.render();
  }

  private consumeLabelAutoFocus(nodeId: string): boolean {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return false;
    }
    if (this.pendingLabelAutofocusNodeId !== normalizedNodeId) {
      return false;
    }
    this.pendingLabelAutofocusNodeId = null;
    return true;
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

    const contextMenuItems = this.nodeDefinitions
      .filter((definition) => definition.hiddenFromInsertMenu !== true)
      .map((definition) => ({
      definition,
      title: prettifyNodeKind(definition.kind),
      summary: describeNodeDefinition(definition),
      }));
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
    const target = event.target instanceof HTMLElement ? event.target : null;
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

  private removeNodes(nodeIds: string[]): void {
    if (!this.currentProject) {
      return;
    }

    const idsToRemove = new Set(
      nodeIds
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => nodeId.length > 0)
    );
    if (idsToRemove.size === 0) {
      return;
    }

    if (!this.currentProject.graph.nodes.some((node) => idsToRemove.has(node.id))) {
      return;
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
      return;
    }

    for (const nodeId of idsToRemove) {
      this.clearTransientFieldErrorsForNode(nodeId);
      this.runPresentation.removeNode(nodeId);
      this.graphInteraction.onNodeRemoved(nodeId);
      this.editingLabelNodeIds.delete(nodeId);
      if (this.pendingLabelAutofocusNodeId === nodeId) {
        this.pendingLabelAutofocusNodeId = null;
      }
    }
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.recomputeEntryNodes(this.currentProject);
    this.render();
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
      this.inspectorOverlay?.hide();
      return;
    }
    this.inspectorOverlay?.setGraphZoom(zoom);
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
    this.viewportScrollCaptureFrame = window.requestAnimationFrame(() => {
      this.viewportScrollCaptureFrame = null;
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
    this.viewportScrollingClassTimer = window.setTimeout(() => {
      this.viewportScrollingClassTimer = null;
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
    if (typeof document === "undefined") {
      return;
    }
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return;
    }
    if (!this.contentEl.contains(activeElement)) {
      return;
    }
    if (!this.isEditableKeyboardTarget(activeElement)) {
      return;
    }
    activeElement.blur();
  }

  private handleGraphViewportPointerDown(event: PointerEvent): void {
    if (this.isEditableKeyboardTarget(event.target)) {
      return;
    }
    this.blurActiveStudioEditableTarget();
  }

  private handleGraphViewportPointerMove(event: PointerEvent): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
      return;
    }
    const zoom = this.graphInteraction.getGraphZoom() || 1;
    this.lastGraphPointerPosition = {
      x: (viewport.scrollLeft + localX) / zoom,
      y: (viewport.scrollTop + localY) / zoom,
    };
  }

  private resolveGraphPositionFromClientPoint(clientX: number, clientY: number): { x: number; y: number } | null {
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

  private resolveVaultPathFromAbsoluteFilePath(absolutePath: string): string | null {
    const normalizedAbsolute = normalizePath(String(absolutePath || "").trim().replace(/\\/g, "/"));
    if (!normalizedAbsolute) {
      return null;
    }
    const adapter = this.app.vault.adapter as any;
    const basePathRaw =
      typeof adapter?.basePath === "string" ? String(adapter.basePath).trim().replace(/\\/g, "/") : "";
    if (!basePathRaw) {
      return null;
    }
    const basePath = normalizePath(basePathRaw);
    if (!normalizedAbsolute.startsWith(`${basePath}/`)) {
      return null;
    }
    const relative = normalizedAbsolute.slice(basePath.length + 1);
    return relative ? normalizePath(relative) : null;
  }

  private readDataTransferStringItem(item: DataTransferItem): Promise<string> {
    return new Promise((resolve) => {
      try {
        item.getAsString((value) => {
          resolve(typeof value === "string" ? value : "");
        });
      } catch {
        resolve("");
      }
    });
  }

  private async collectDroppedVaultItems(dataTransfer: DataTransfer): Promise<{
    notePaths: string[];
    folderPaths: string[];
    unsupportedPaths: string[];
  }> {
    const references = new Set<string>();
    const pushReference = (value: string): void => {
      const next = String(value || "").trim();
      if (!next) {
        return;
      }
      references.add(next);
    };

    const payloads = new Set<string>();
    const pushPayload = (value: string): void => {
      const next = String(value || "").trim();
      if (!next) {
        return;
      }
      payloads.add(next);
    };

    for (const preferredType of ["text/plain", "text/uri-list", "application/json"]) {
      try {
        pushPayload(dataTransfer.getData(preferredType));
      } catch {
        // Continue through best-effort fallbacks.
      }
    }
    for (const type of Array.from(dataTransfer.types || [])) {
      const normalizedType = String(type || "").toLowerCase();
      if (
        !normalizedType.startsWith("text/") &&
        !normalizedType.includes("json") &&
        !normalizedType.includes("uri")
      ) {
        continue;
      }
      try {
        pushPayload(dataTransfer.getData(type));
      } catch {
        // Continue through best-effort fallbacks.
      }
    }
    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind !== "string") {
        continue;
      }
      pushPayload(await this.readDataTransferStringItem(item));
    }
    for (const payload of payloads) {
      for (const reference of parsePathReferencesFromText(payload)) {
        pushReference(reference);
      }
    }

    for (const file of Array.from(dataTransfer.files || [])) {
      const absolutePath =
        typeof (file as unknown as { path?: unknown }).path === "string"
          ? String((file as unknown as { path?: string }).path)
          : "";
      if (!absolutePath) {
        continue;
      }
      const vaultPath = this.resolveVaultPathFromAbsoluteFilePath(absolutePath);
      if (vaultPath) {
        pushReference(vaultPath);
      }
    }

    const notePaths = new Set<string>();
    const folderPaths = new Set<string>();
    const unsupportedPaths = new Set<string>();
    for (const reference of references) {
      const item = resolveVaultItemFromReference({
        reference,
        getAbstractFileByPath: (path) => this.app.vault.getAbstractFileByPath(path),
        resolveVaultPathFromAbsoluteFilePath: (absolutePath) =>
          this.resolveVaultPathFromAbsoluteFilePath(absolutePath),
      });
      if (this.isMarkdownVaultFile(item)) {
        notePaths.add(item.path);
        continue;
      }
      if (this.isVaultFolder(item)) {
        folderPaths.add(item.path);
        continue;
      }
      if (item instanceof TFile) {
        unsupportedPaths.add(item.path);
      }
    }
    return {
      notePaths: Array.from(notePaths),
      folderPaths: Array.from(folderPaths),
      unsupportedPaths: Array.from(unsupportedPaths),
    };
  }

  private handleGraphViewportDragOver(event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (this.busy || !this.currentProject || !this.currentProjectPath) {
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }

  private async handleGraphViewportDrop(event: DragEvent): Promise<void> {
    if (!event.dataTransfer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (this.busy || !this.currentProject || !this.currentProjectPath) {
      return;
    }

    const dropped = await this.collectDroppedVaultItems(event.dataTransfer);
    if (
      dropped.notePaths.length === 0 &&
      dropped.folderPaths.length === 0 &&
      dropped.unsupportedPaths.length === 0
    ) {
      const hasPayload =
        (event.dataTransfer.types?.length || 0) > 0 || (event.dataTransfer.files?.length || 0) > 0;
      if (hasPayload) {
        new Notice("Drop a markdown note from your vault to create a Note node.");
      }
      return;
    }

    if (dropped.folderPaths.length > 0) {
      new Notice("Dropping folders into Studio is not supported yet.");
    }
    if (dropped.notePaths.length === 0) {
      if (dropped.unsupportedPaths.length > 0) {
        new Notice("Only markdown notes can be dropped into Studio.");
      }
      return;
    }

    const anchor =
      this.resolveGraphPositionFromClientPoint(event.clientX, event.clientY) ||
      this.resolvePasteAnchorPosition();
    await this.insertVaultNoteNodes(dropped.notePaths, anchor, {
      source: "drop",
    });
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

    const runtimeRequire = typeof window !== "undefined" ? (window as any)?.require : null;
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
      onCreateLabelAtPosition: (position) => {
        this.createLabelAtPosition(position);
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
      onNodeSizeChange: (nodeId, size, options) => {
        this.handleNodeSizeChange(nodeId, size, options);
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
      resolveDynamicSelectOptions: (source, node) =>
        this.resolveDynamicSelectOptionsForNode(source, node),
      isLabelEditing: (nodeId) => this.isLabelNodeEditing(nodeId),
      consumeLabelAutoFocus: (nodeId) => this.consumeLabelAutoFocus(nodeId),
      onRequestLabelEdit: (nodeId) => this.requestLabelNodeEdit(nodeId, { autoFocus: true }),
      onStopLabelEdit: (nodeId) => this.stopLabelNodeEdit(nodeId),
      onRevealPathInFinder: (path) => {
        void this.revealPathInFinder(path);
      },
      resolveNodeBadge: (node) => this.resolveNodeCardBadge(node),
    });

    this.graphViewportEl = result.viewportEl;
    this.graphViewportProjectPath = this.currentProjectPath;
    if (!this.graphViewportEl || !this.currentProject) {
      this.graphViewportProjectPath = null;
      this.nodeDragInProgress = false;
      this.inspectorOverlay?.hide();
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
    this.graphViewportEl.addEventListener("pointermove", (event) => {
      this.handleGraphViewportPointerMove(event);
    }, { passive: true });
    this.graphViewportEl.addEventListener("pointerleave", () => {
      this.lastGraphPointerPosition = null;
    }, { passive: true });
    this.graphViewportEl.addEventListener("dragover", (event) => {
      this.handleGraphViewportDragOver(event);
    });
    this.graphViewportEl.addEventListener("drop", (event) => {
      void this.handleGraphViewportDrop(event);
    });
    this.restoreGraphViewportState(this.graphViewportEl);
    this.syncGraphZoomVisualState();
    const contextMenu = this.ensureNodeContextMenuOverlay();
    const nodeActionMenu = this.ensureNodeActionContextMenuOverlay();
    this.inspectorOverlay?.hide();
    contextMenu.setGraphZoom(this.graphInteraction.getGraphZoom());
    nodeActionMenu.setGraphZoom(this.graphInteraction.getGraphZoom());
    contextMenu.mount(this.graphViewportEl);
    nodeActionMenu.mount(this.graphViewportEl);
    this.syncInspectorSelection();
  }

  private captureGraphViewportState(options?: {
    zoomOverride?: number;
    requestLayoutSave?: boolean;
    allowOverview?: boolean;
  }): void {
    const viewport = this.graphViewportEl;
    const projectPath = this.graphViewportProjectPath;
    if (!viewport || !projectPath) {
      this.pendingViewportState = null;
      return;
    }
    if (this.graphZoomMode === "overview" && options?.allowOverview !== true) {
      return;
    }

    const snapshot: StudioGraphViewState = {
      scrollLeft: normalizeGraphCoordinate(viewport.scrollLeft),
      scrollTop: normalizeGraphCoordinate(viewport.scrollTop),
      zoom: normalizeGraphZoom(
        options?.zoomOverride ?? this.graphInteraction.getGraphZoom()
      ),
    };
    this.pendingViewportState = { ...snapshot, projectPath };
    const nextGraphViewState = upsertGraphViewStateForProject(
      this.graphViewStateByProjectPath,
      projectPath,
      snapshot
    );
    this.graphViewStateByProjectPath = nextGraphViewState.nextStateByProjectPath;
    if (nextGraphViewState.changed && options?.requestLayoutSave) {
      this.scheduleLayoutSave();
    }
  }

  private restoreGraphViewportState(viewport: HTMLElement): void {
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
    this.graphZoomMode = "interactive";
    this.graphZoomGestureInFlight = false;
    this.graphInteraction.setGraphZoom(nextZoom, { mode: "interactive" });

    const nextLeft = normalizeGraphCoordinate(restoredState.scrollLeft);
    const nextTop = normalizeGraphCoordinate(restoredState.scrollTop);
    viewport.scrollLeft = nextLeft;
    viewport.scrollTop = nextTop;

    // Ensure position is retained after the browser finishes layout.
    window.requestAnimationFrame(() => {
      if (this.graphViewportEl !== viewport) {
        return;
      }
      viewport.scrollLeft = nextLeft;
      viewport.scrollTop = nextTop;
    });
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
    this.graphInteraction.clearRenderBindings();
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.nodeDragInProgress = false;
    this.graphViewportEl = null;
    this.graphViewportProjectPath = null;
    this.lastGraphPointerPosition = null;

    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "ss-studio-view" });

    if (!Platform.isDesktopApp) {
      this.inspectorOverlay?.hide();
      root.createEl("p", {
        text: "SystemSculpt Studio is desktop-only.",
        cls: "ss-studio-warning",
      });
      return;
    }

    if (this.lastError) {
      root.createEl("div", {
        text: this.lastError,
        cls: "ss-studio-error",
      });
    }
    if (this.projectLiveSyncWarning) {
      root.createEl("div", {
        text: this.projectLiveSyncWarning,
        cls: "ss-studio-warning",
      });
    }

    this.renderGraphEditor(root);
  }
}
