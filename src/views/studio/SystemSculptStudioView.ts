import {
  EventRef,
  FileSystemAdapter,
  ItemView,
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
  StudioEdge,
  StudioJsonValue,
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeGroup,
  StudioNodeInstance,
  StudioNodeOutputMap,
  StudioProjectV1,
  StudioRunEvent,
} from "../../studio/types";
import {
  isStudioManagedOutputProducerKind,
  isStudioVisualOnlyNodeKind,
} from "../../studio/StudioNodeKinds";
import { scopeProjectForRun } from "../../studio/StudioRunScope";
import { validateNodeConfig } from "../../studio/StudioNodeConfigValidation";
import { resolveNodeDefinitionPorts } from "../../studio/StudioNodePortResolution";
import {
  DATASET_OUTPUT_FIELDS_CONFIG_KEY,
  deriveDatasetOutputFieldsFromOutputs,
  readDatasetOutputFields,
} from "../../studio/nodes/datasetNode";
import { renderStudioGraphWorkspace } from "./graph-v3/StudioGraphWorkspaceRenderer";
import {
  createGroupFromSelection as createNodeGroupFromSelection,
  removeNodesFromGroups,
  sanitizeGraphGroups,
} from "./graph-v3/StudioGraphGroupModel";
import { computeStudioGraphGroupBounds } from "./graph-v3/StudioGraphGroupBounds";
import {
  openStudioMediaPreviewModal,
  resolveStudioAssetPreviewSrc,
} from "./graph-v3/StudioGraphMediaPreviewModal";
import {
  getSavedGraphViewState,
  normalizeGraphCoordinate,
  normalizeGraphZoom,
  parseGraphViewStateByProject,
  serializeGraphViewStateByProject,
  type StudioGraphViewState,
  type StudioGraphViewStateByProject,
  type StudioGraphViewportState,
  upsertGraphViewStateForProject,
} from "./graph-v3/StudioGraphViewStateStore";
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
import {
  cleanupStaleManagedOutputPlaceholders,
  materializePendingImageOutputPlaceholders,
  materializeImageOutputsAsMediaNodes,
  removeManagedTextOutputNodes,
  removePendingManagedOutputNodes,
} from "./StudioManagedOutputNodes";
import { isStudioGraphEditableTarget } from "./StudioGraphDomTargeting";
import { tryCopyToClipboard } from "../../utils/clipboard";

export const SYSTEMSCULPT_STUDIO_VIEW_TYPE = "systemsculpt-studio-view";

const DEFAULT_INSPECTOR_LAYOUT: StudioNodeInspectorLayout = {
  x: 36,
  y: 88,
  width: 420,
  height: 460,
};
const GROUP_DISCONNECT_OFFSET_X = 36;
const STUDIO_GRAPH_HISTORY_MAX_SNAPSHOTS = 120;
const STUDIO_GRAPH_CLIPBOARD_SCHEMA = "systemsculpt.studio.clipboard.v1" as const;

type StudioGraphClipboardPayload = {
  schema: typeof STUDIO_GRAPH_CLIPBOARD_SCHEMA;
  createdAt: string;
  nodes: StudioNodeInstance[];
  edges: StudioEdge[];
  groups: StudioNodeGroup[];
  selectedNodeIds: string[];
  anchor: {
    x: number;
    y: number;
  };
};

type StudioGraphHistorySnapshot = {
  project: StudioProjectV1;
  selectedNodeIds: string[];
};

type SystemSculptStudioViewState = {
  inspectorLayout?: unknown;
  file?: unknown;
  graphViewByProject?: unknown;
};

export class SystemSculptStudioView extends ItemView {
  private currentProject: StudioProjectV1 | null = null;
  private currentProjectPath: string | null = null;
  private busy = false;
  private lastError: string | null = null;
  private nodeDefinitions: StudioNodeDefinition[] = [];
  private nodeDefinitionsByKey = new Map<string, StudioNodeDefinition>();
  private saveTimer: number | null = null;
  private layoutSaveTimer: number | null = null;
  private saveInFlight = false;
  private saveQueued = false;
  private graphViewportEl: HTMLElement | null = null;
  private graphViewportProjectPath: string | null = null;
  private inspectorOverlay: StudioNodeInspectorOverlay | null = null;
  private nodeContextMenuOverlay: StudioNodeContextMenuOverlay | null = null;
  private nodeActionContextMenuOverlay: StudioSimpleContextMenuOverlay | null = null;
  private inspectorLayout: StudioNodeInspectorLayout = { ...DEFAULT_INSPECTOR_LAYOUT };
  private nodeDragInProgress = false;
  private transientFieldErrorsByNodeId = new Map<string, Map<string, string>>();
  private graphViewStateByProjectPath: StudioGraphViewStateByProject = {};
  private pendingViewportState: StudioGraphViewportState | null = null;
  private editingLabelNodeIds = new Set<string>();
  private pendingLabelAutofocusNodeId: string | null = null;
  private readonly runPresentation = new StudioRunPresentationState();
  private readonly graphInteraction: StudioGraphInteractionEngine;
  private lastGraphPointerPosition: { x: number; y: number } | null = null;
  private vaultEventRefs: EventRef[] = [];
  private notePathByNodeId = new Map<string, string>();
  private noteWriteTimersByNodeId = new Map<string, number>();
  private graphClipboardPayload: StudioGraphClipboardPayload | null = null;
  private graphClipboardPasteCount = 0;
  private historyCurrentSnapshot: StudioGraphHistorySnapshot | null = null;
  private historyCurrentSerialized = "";
  private historyUndoSnapshots: StudioGraphHistorySnapshot[] = [];
  private historyRedoSnapshots: StudioGraphHistorySnapshot[] = [];
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
      scheduleProjectSave: () => this.scheduleProjectSave(),
      requestRender: () => this.render(),
      onNodeDragStateChange: (isDragging) => this.handleNodeDragStateChange(isDragging),
      onGraphZoomChanged: (zoom) => this.handleGraphZoomChanged(zoom),
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
    return "SystemSculpt Studio";
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
    await this.flushPendingNoteWrites();
    this.unbindVaultEvents();
    this.clearAllNoteWriteTimers();
    this.notePathByNodeId.clear();
    this.graphClipboardPayload = null;
    this.graphClipboardPasteCount = 0;
    this.resetProjectHistory(null);
    this.captureGraphViewportState();
    this.app.workspace.requestSaveLayout();
    this.clearSaveTimer();
    this.clearLayoutSaveTimer();
    this.runPresentation.reset();
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
        this.handleVaultItemDeleted(file);
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

  private normalizeNodeIdList(nodeIds: string[]): string[] {
    return Array.from(
      new Set(
        nodeIds
          .map((nodeId) => String(nodeId || "").trim())
          .filter((nodeId) => nodeId.length > 0)
      )
    );
  }

  private cloneProjectSnapshot(project: StudioProjectV1): StudioProjectV1 {
    return JSON.parse(JSON.stringify(project)) as StudioProjectV1;
  }

  private serializeProjectSnapshot(project: StudioProjectV1): string {
    return JSON.stringify(project);
  }

  private cloneHistorySnapshot(snapshot: StudioGraphHistorySnapshot): StudioGraphHistorySnapshot {
    return {
      project: this.cloneProjectSnapshot(snapshot.project),
      selectedNodeIds: [...snapshot.selectedNodeIds],
    };
  }

  private setHistoryCurrentSnapshot(project: StudioProjectV1, selectedNodeIds: string[]): void {
    this.historyCurrentSnapshot = {
      project: this.cloneProjectSnapshot(project),
      selectedNodeIds: this.normalizeNodeIdList(selectedNodeIds),
    };
    this.historyCurrentSerialized = this.serializeProjectSnapshot(project);
  }

  private resetProjectHistory(project: StudioProjectV1 | null, options?: { selectedNodeIds?: string[] }): void {
    this.historyUndoSnapshots = [];
    this.historyRedoSnapshots = [];
    if (!project) {
      this.historyCurrentSnapshot = null;
      this.historyCurrentSerialized = "";
      return;
    }
    this.setHistoryCurrentSnapshot(project, options?.selectedNodeIds || []);
  }

  private trimHistorySnapshots(snapshots: StudioGraphHistorySnapshot[]): void {
    while (snapshots.length > STUDIO_GRAPH_HISTORY_MAX_SNAPSHOTS) {
      snapshots.shift();
    }
  }

  private captureProjectHistoryCheckpoint(): void {
    if (!this.currentProject) {
      return;
    }

    const serialized = this.serializeProjectSnapshot(this.currentProject);
    if (!this.historyCurrentSnapshot) {
      this.setHistoryCurrentSnapshot(this.currentProject, this.graphInteraction.getSelectedNodeIds());
      return;
    }
    if (serialized === this.historyCurrentSerialized) {
      return;
    }

    this.historyUndoSnapshots.push(this.cloneHistorySnapshot(this.historyCurrentSnapshot));
    this.trimHistorySnapshots(this.historyUndoSnapshots);
    this.setHistoryCurrentSnapshot(this.currentProject, this.graphInteraction.getSelectedNodeIds());
    this.historyRedoSnapshots = [];
  }

  private applyHistorySnapshot(snapshot: StudioGraphHistorySnapshot): void {
    if (!this.currentProjectPath) {
      return;
    }

    const nextProject = this.cloneProjectSnapshot(snapshot.project);
    const nextNodeIdSet = new Set(nextProject.graph.nodes.map((node) => node.id));
    const nextSelection = this.normalizeNodeIdList(snapshot.selectedNodeIds).filter((nodeId) =>
      nextNodeIdSet.has(nodeId)
    );

    this.currentProject = nextProject;
    this.clearAllNoteWriteTimers();
    this.notePathByNodeId.clear();
    this.rebuildNotePathIndex(nextProject);
    this.transientFieldErrorsByNodeId.clear();
    this.runPresentation.reset();
    this.editingLabelNodeIds.clear();
    this.pendingLabelAutofocusNodeId = null;
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.graphInteraction.clearPendingConnection({ requestRender: false });
    this.graphInteraction.clearProjectState();
    this.recomputeEntryNodes(nextProject);
    this.setHistoryCurrentSnapshot(nextProject, nextSelection);
    this.scheduleProjectSave({ captureHistory: false });
    this.render();
    this.graphInteraction.setSelectedNodeIds(nextSelection);
  }

  private undoGraphHistory(): boolean {
    if (this.busy || !this.currentProject || !this.historyCurrentSnapshot) {
      return false;
    }
    const targetSnapshot = this.historyUndoSnapshots.pop();
    if (!targetSnapshot) {
      return false;
    }

    this.historyRedoSnapshots.push(this.cloneHistorySnapshot(this.historyCurrentSnapshot));
    this.trimHistorySnapshots(this.historyRedoSnapshots);
    this.applyHistorySnapshot(targetSnapshot);
    return true;
  }

  private redoGraphHistory(): boolean {
    if (this.busy || !this.currentProject || !this.historyCurrentSnapshot) {
      return false;
    }
    const targetSnapshot = this.historyRedoSnapshots.pop();
    if (!targetSnapshot) {
      return false;
    }

    this.historyUndoSnapshots.push(this.cloneHistorySnapshot(this.historyCurrentSnapshot));
    this.trimHistorySnapshots(this.historyUndoSnapshots);
    this.applyHistorySnapshot(targetSnapshot);
    return true;
  }

  private resolveClipboardAnchor(nodes: StudioNodeInstance[]): { x: number; y: number } {
    if (nodes.length === 0) {
      return { x: 0, y: 0 };
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      minX = Math.min(minX, Number(node.position?.x) || 0);
      minY = Math.min(minY, Number(node.position?.y) || 0);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return { x: 0, y: 0 };
    }
    return {
      x: minX,
      y: minY,
    };
  }

  private buildGraphClipboardPayload(selectedNodeIds: string[]): StudioGraphClipboardPayload | null {
    if (!this.currentProject) {
      return null;
    }

    const project = this.currentProject;
    const nodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
    const normalizedSelection = this.normalizeNodeIdList(selectedNodeIds).filter((nodeId) =>
      nodeById.has(nodeId)
    );
    if (normalizedSelection.length === 0) {
      return null;
    }

    const selectedNodeIdSet = new Set(normalizedSelection);
    const nodes = normalizedSelection
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is StudioNodeInstance => Boolean(node))
      .map((node) => JSON.parse(JSON.stringify(node)) as StudioNodeInstance);
    if (nodes.length === 0) {
      return null;
    }

    const edges = project.graph.edges
      .filter(
        (edge) =>
          selectedNodeIdSet.has(edge.fromNodeId) &&
          selectedNodeIdSet.has(edge.toNodeId)
      )
      .map((edge) => ({ ...edge }));

    const groups = (project.graph.groups || [])
      .map((group) => {
        const groupNodeIds = this.normalizeNodeIdList(group.nodeIds || []).filter((nodeId) =>
          selectedNodeIdSet.has(nodeId)
        );
        if (groupNodeIds.length < 2) {
          return null;
        }
        const groupName = String(group.name || "").trim();
        const groupId = String(group.id || "").trim();
        if (!groupName || !groupId) {
          return null;
        }
        const groupColor = String(group.color || "").trim();
        return {
          id: groupId,
          name: groupName,
          ...(groupColor ? { color: groupColor } : {}),
          nodeIds: groupNodeIds,
        } satisfies StudioNodeGroup;
      })
      .filter((group): group is StudioNodeGroup => Boolean(group));

    return {
      schema: STUDIO_GRAPH_CLIPBOARD_SCHEMA,
      createdAt: new Date().toISOString(),
      nodes,
      edges,
      groups,
      selectedNodeIds: normalizedSelection,
      anchor: this.resolveClipboardAnchor(nodes),
    };
  }

  private async syncGraphClipboardToSystemClipboard(payload: StudioGraphClipboardPayload): Promise<void> {
    try {
      const serialized = JSON.stringify(payload);
      await tryCopyToClipboard(serialized);
    } catch {
      // Best-effort clipboard mirroring only.
    }
  }

  private parseGraphClipboardPayload(raw: string): StudioGraphClipboardPayload | null {
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const payload = parsed as Partial<StudioGraphClipboardPayload>;
    if (payload.schema !== STUDIO_GRAPH_CLIPBOARD_SCHEMA) {
      return null;
    }
    if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) {
      return null;
    }

    return {
      schema: STUDIO_GRAPH_CLIPBOARD_SCHEMA,
      createdAt: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
      nodes: payload.nodes as StudioNodeInstance[],
      edges: Array.isArray(payload.edges) ? (payload.edges as StudioEdge[]) : [],
      groups: Array.isArray(payload.groups) ? (payload.groups as StudioNodeGroup[]) : [],
      selectedNodeIds: Array.isArray(payload.selectedNodeIds)
        ? this.normalizeNodeIdList(payload.selectedNodeIds as string[])
        : [],
      anchor: {
        x:
          payload.anchor && Number.isFinite(Number(payload.anchor.x))
            ? Number(payload.anchor.x)
            : 0,
        y:
          payload.anchor && Number.isFinite(Number(payload.anchor.y))
            ? Number(payload.anchor.y)
            : 0,
      },
    };
  }

  private copySelectedGraphNodesToClipboard(options?: { showNotice?: boolean }): boolean {
    if (this.busy || !this.currentProject) {
      return false;
    }
    const payload = this.buildGraphClipboardPayload(this.graphInteraction.getSelectedNodeIds());
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
    const nodeIdMap = new Map<string, string>();
    const newNodes: StudioNodeInstance[] = [];
    const anchor = this.resolvePasteAnchorPosition();
    const repeatedPasteOffset = this.graphClipboardPasteCount * 28;
    const deltaX = anchor.x + repeatedPasteOffset - payload.anchor.x;
    const deltaY = anchor.y + repeatedPasteOffset - payload.anchor.y;

    for (const sourceNode of payload.nodes) {
      const sourceNodeId = String(sourceNode.id || "").trim();
      if (!sourceNodeId) {
        continue;
      }
      const nextNodeId = randomId("node");
      nodeIdMap.set(sourceNodeId, nextNodeId);
      const clonedNode = JSON.parse(JSON.stringify(sourceNode)) as StudioNodeInstance;
      clonedNode.id = nextNodeId;
      clonedNode.position = this.normalizeNodePosition({
        x: Number(clonedNode.position?.x || 0) + deltaX,
        y: Number(clonedNode.position?.y || 0) + deltaY,
      });
      newNodes.push(clonedNode);
    }
    if (newNodes.length === 0) {
      return false;
    }

    const newEdges: StudioEdge[] = [];
    for (const sourceEdge of payload.edges || []) {
      const fromNodeId = nodeIdMap.get(String(sourceEdge.fromNodeId || "").trim());
      const toNodeId = nodeIdMap.get(String(sourceEdge.toNodeId || "").trim());
      if (!fromNodeId || !toNodeId) {
        continue;
      }
      const fromPortId = String(sourceEdge.fromPortId || "").trim();
      const toPortId = String(sourceEdge.toPortId || "").trim();
      if (!fromPortId || !toPortId) {
        continue;
      }
      newEdges.push({
        id: randomId("edge"),
        fromNodeId,
        fromPortId,
        toNodeId,
        toPortId,
      });
    }

    const newGroups: StudioNodeGroup[] = [];
    for (const sourceGroup of payload.groups || []) {
      const groupNodeIds = this.normalizeNodeIdList(sourceGroup.nodeIds || [])
        .map((nodeId) => nodeIdMap.get(nodeId) || "")
        .filter((nodeId) => nodeId.length > 0);
      if (groupNodeIds.length < 2) {
        continue;
      }
      const groupName = String(sourceGroup.name || "").trim();
      if (!groupName) {
        continue;
      }
      const groupColor = String(sourceGroup.color || "").trim();
      newGroups.push({
        id: randomId("group"),
        name: groupName,
        ...(groupColor ? { color: groupColor } : {}),
        nodeIds: groupNodeIds,
      });
    }

    project.graph.nodes.push(...newNodes);
    if (newEdges.length > 0) {
      project.graph.edges.push(...newEdges);
    }
    if (newGroups.length > 0) {
      if (!Array.isArray(project.graph.groups)) {
        project.graph.groups = [];
      }
      project.graph.groups.push(...newGroups);
    }

    const nextSelection = this.normalizeNodeIdList(payload.selectedNodeIds || [])
      .map((nodeId) => nodeIdMap.get(nodeId) || "")
      .filter((nodeId) => nodeId.length > 0);
    if (nextSelection.length === 0) {
      nextSelection.push(...newNodes.map((node) => node.id));
    }

    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.graphInteraction.clearPendingConnection({ requestRender: false });
    this.graphInteraction.setSelectedNodeIds(nextSelection);
    for (const node of newNodes) {
      if (node.kind !== "studio.note") {
        continue;
      }
      const notePath = this.readNotePathFromConfig(node);
      if (notePath) {
        this.notePathByNodeId.set(node.id, normalizePath(notePath));
      }
    }
    this.recomputeEntryNodes(project);
    this.scheduleProjectSave();
    this.render();
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
    const editableTarget = this.isEditableKeyboardTarget(event.target);
    const primaryModifierPressed = (event.metaKey || event.ctrlKey) && !event.altKey;

    if (primaryModifierPressed) {
      let handled = false;
      if (!editableTarget) {
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

  private normalizePastedImageMimeType(rawMimeType: string): string {
    const normalized = String(rawMimeType || "").trim().toLowerCase();
    if (normalized.startsWith("image/")) {
      return normalized;
    }
    return "image/png";
  }

  private extractClipboardImageFiles(event: ClipboardEvent): File[] {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return [];
    }

    const files: File[] = [];
    const seenKeys = new Set<string>();
    if (clipboard.items && clipboard.items.length > 0) {
      for (const item of Array.from(clipboard.items)) {
        if (!item || item.kind !== "file") {
          continue;
        }
        const file = item.getAsFile();
        if (!file || !String(file.type || "").toLowerCase().startsWith("image/")) {
          continue;
        }
        const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
        if (seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        files.push(file);
      }
    }

    if (files.length > 0) {
      return files;
    }

    if (clipboard.files && clipboard.files.length > 0) {
      for (const file of Array.from(clipboard.files)) {
        if (!file || !String(file.type || "").toLowerCase().startsWith("image/")) {
          continue;
        }
        const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
        if (seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        files.push(file);
      }
    }

    return files;
  }

  private extractClipboardText(event: ClipboardEvent): string {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return "";
    }
    const text = clipboard.getData("text/plain");
    return typeof text === "string" ? text : "";
  }

  private parseObsidianOpenFilePath(reference: string): string | null {
    const raw = String(reference || "").trim();
    if (!raw.startsWith("obsidian://open")) {
      return null;
    }
    try {
      const url = new URL(raw);
      const filePath = url.searchParams.get("file");
      if (!filePath) {
        return null;
      }
      const decoded = decodeURIComponent(filePath).trim();
      return decoded ? normalizePath(decoded) : null;
    } catch {
      return null;
    }
  }

  private stripEnclosingReferenceWrappers(reference: string): string {
    let next = String(reference || "").trim();
    while (next.startsWith("<") && next.endsWith(">") && next.length > 1) {
      next = next.slice(1, -1).trim();
    }
    if (
      (next.startsWith("\"") && next.endsWith("\"") && next.length > 1) ||
      (next.startsWith("'") && next.endsWith("'") && next.length > 1) ||
      (next.startsWith("`") && next.endsWith("`") && next.length > 1)
    ) {
      next = next.slice(1, -1).trim();
    }
    return next;
  }

  private normalizeObsidianLinkTarget(reference: string): string {
    let next = this.stripEnclosingReferenceWrappers(reference);
    if (!next) {
      return "";
    }
    if (next.startsWith("!")) {
      next = next.slice(1).trim();
    }
    const aliasIndex = next.indexOf("|");
    if (aliasIndex >= 0) {
      next = next.slice(0, aliasIndex).trim();
    }
    const headingIndex = next.indexOf("#");
    if (headingIndex >= 0) {
      next = next.slice(0, headingIndex).trim();
    }
    const blockIndex = next.indexOf("^");
    if (blockIndex >= 0) {
      next = next.slice(0, blockIndex).trim();
    }
    return next.trim();
  }

  private parseObsidianWikiLinkTarget(reference: string): string | null {
    const raw = this.stripEnclosingReferenceWrappers(reference);
    const match = raw.match(/^!?\[\[([\s\S]+?)\]\]$/);
    if (!match) {
      return null;
    }
    const target = this.normalizeObsidianLinkTarget(match[1]);
    return target || null;
  }

  private parseMarkdownLinkTarget(reference: string): string | null {
    const raw = this.stripEnclosingReferenceWrappers(reference);
    const match = raw.match(/^!?\[[^\]]*]\((.+)\)$/);
    if (!match) {
      return null;
    }
    let target = String(match[1] || "").trim();
    if (!target) {
      return null;
    }
    if (target.startsWith("<") && target.endsWith(">") && target.length > 1) {
      target = target.slice(1, -1).trim();
    } else {
      const firstToken = target.split(/\s+/)[0];
      target = firstToken || target;
    }
    try {
      target = decodeURIComponent(target);
    } catch {
      // Keep the original text when URL decoding fails.
    }
    const normalized = this.normalizeObsidianLinkTarget(target);
    return normalized || null;
  }

  private resolveVaultPathFromFileUri(reference: string): string | null {
    const raw = this.stripEnclosingReferenceWrappers(reference);
    if (!raw.toLowerCase().startsWith("file://")) {
      return null;
    }
    try {
      const url = new URL(raw);
      if (url.protocol !== "file:") {
        return null;
      }
      let absolutePath = decodeURIComponent(url.pathname || "").trim();
      if (/^\/[a-zA-Z]:\//.test(absolutePath)) {
        absolutePath = absolutePath.slice(1);
      }
      return this.resolveVaultPathFromAbsoluteFilePath(absolutePath);
    } catch {
      return null;
    }
  }

  private resolveVaultItemFromReference(reference: string): TAbstractFile | null {
    const raw = this.stripEnclosingReferenceWrappers(reference);
    if (!raw) {
      return null;
    }

    const candidatePaths = new Set<string>();
    const pushCandidate = (value: string | null | undefined): void => {
      const next = String(value || "").trim();
      if (!next) {
        return;
      }
      candidatePaths.add(next);
    };

    pushCandidate(this.parseObsidianOpenFilePath(raw));
    pushCandidate(this.parseObsidianWikiLinkTarget(raw));
    pushCandidate(this.parseMarkdownLinkTarget(raw));
    pushCandidate(this.resolveVaultPathFromFileUri(raw));
    if (this.isAbsoluteFilesystemPath(raw)) {
      pushCandidate(this.resolveVaultPathFromAbsoluteFilePath(raw));
    }
    pushCandidate(this.normalizeObsidianLinkTarget(raw));
    pushCandidate(raw);

    for (const candidate of candidatePaths) {
      const normalizedCandidate = normalizePath(candidate.replace(/\\/g, "/"));
      if (!normalizedCandidate) {
        continue;
      }
      const direct = this.app.vault.getAbstractFileByPath(normalizedCandidate);
      if (direct) {
        return direct;
      }
      if (!normalizedCandidate.includes(".")) {
        const markdownFallback = this.app.vault.getAbstractFileByPath(`${normalizedCandidate}.md`);
        if (markdownFallback) {
          return markdownFallback;
        }
      }
    }

    return null;
  }

  private collectInlinePathReferencesFromText(raw: string, push: (value: string) => void): void {
    const text = String(raw || "");
    if (!text.trim()) {
      return;
    }

    for (const match of text.matchAll(/obsidian:\/\/open[^\s)]+/gi)) {
      push(match[0]);
    }
    for (const match of text.matchAll(/file:\/\/[^\s)]+/gi)) {
      push(match[0]);
    }
    for (const match of text.matchAll(/!?\[\[([\s\S]+?)\]\]/g)) {
      push(match[0]);
      push(match[1]);
    }
    for (const match of text.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
      push(match[0]);
      push(match[1]);
    }
  }

  private parsePathReferencesFromText(raw: string): string[] {
    const normalized = String(raw || "").trim();
    if (!normalized) {
      return [];
    }

    const references = new Set<string>();
    const push = (value: string): void => {
      const next = String(value || "").trim();
      if (!next) {
        return;
      }
      references.add(next);
    };

    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.path === "string") {
          push(record.path);
        }
        if (typeof record.file === "string") {
          push(record.file);
        }
        if (Array.isArray(record.results)) {
          for (const result of record.results) {
            if (result && typeof result === "object" && typeof (result as Record<string, unknown>).path === "string") {
              push((result as Record<string, unknown>).path as string);
            }
          }
        }
      } else if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (typeof value === "string") {
            push(value);
          }
        }
      }
    } catch {
      // Continue with line parsing.
    }

    this.collectInlinePathReferencesFromText(normalized, push);
    for (const line of normalized.split(/\r?\n/)) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }
      push(trimmedLine);
      push(trimmedLine.replace(/^[-*]\s+/, ""));
    }

    return Array.from(references);
  }

  private isMarkdownVaultFile(file: TAbstractFile | null): file is TFile {
    return file instanceof TFile && file.extension.toLowerCase() === "md";
  }

  private isVaultFolder(file: TAbstractFile | null): file is TFolder {
    return file instanceof TFolder;
  }

  private resolveMarkdownVaultPathFromReference(reference: string): string | null {
    const item = this.resolveVaultItemFromReference(reference);
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

    const pastedText = this.extractClipboardText(event);
    const graphClipboardPayload = this.parseGraphClipboardPayload(pastedText);
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

    const imageFiles = this.extractClipboardImageFiles(event);
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
    const anchor = this.resolvePasteAnchorPosition();
    const node: StudioNodeInstance = {
      id: randomId("node"),
      kind: textDefinition.kind,
      version: textDefinition.version,
      title: prettifyNodeKind(textDefinition.kind),
      position: this.normalizeNodePosition(anchor),
      config: {
        ...cloneConfigDefaults(textDefinition),
        value: text,
      },
      continueOnError: false,
      disabled: false,
    };
    project.graph.nodes.push(node);
    this.graphInteraction.selectOnlyNode(node.id);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.scheduleProjectSave();
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
    const anchor = this.resolvePasteAnchorPosition();
    const createdNodeIds: string[] = [];

    for (let index = 0; index < imageFiles.length; index += 1) {
      const imageFile = imageFiles[index];
      const mimeType = this.normalizePastedImageMimeType(imageFile.type);
      const bytes = await imageFile.arrayBuffer();
      const asset = await studio.storeAsset(this.currentProjectPath, bytes, mimeType);
      const node: StudioNodeInstance = {
        id: randomId("node"),
        kind: mediaDefinition.kind,
        version: mediaDefinition.version,
        title: prettifyNodeKind(mediaDefinition.kind),
        position: this.normalizeNodePosition({
          x: anchor.x + (index % 5) * 38,
          y: anchor.y + Math.floor(index / 5) * 38,
        }),
        config: {
          ...cloneConfigDefaults(mediaDefinition),
          sourcePath: asset.path,
        },
        continueOnError: false,
        disabled: false,
      };
      project.graph.nodes.push(node);
      createdNodeIds.push(node.id);
    }

    if (createdNodeIds.length === 0) {
      return;
    }

    this.graphInteraction.selectOnlyNode(createdNodeIds[createdNodeIds.length - 1]);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.scheduleProjectSave();
    this.render();
    new Notice(
      createdNodeIds.length === 1
        ? "Pasted 1 image as a Media node."
        : `Pasted ${createdNodeIds.length} images as Media nodes.`
    );
  }

  private readNotePathFromConfig(node: Pick<StudioNodeInstance, "config">): string {
    return String(node.config.vaultPath || "").trim();
  }

  private deriveNoteTitleFromPath(path: string): string {
    const normalized = String(path || "").trim().replace(/\\/g, "/");
    if (!normalized) {
      return "";
    }
    const fileName = normalized.split("/").pop() || normalized;
    if (fileName.toLowerCase().endsWith(".md") && fileName.length > 3) {
      return fileName.slice(0, -3);
    }
    return fileName;
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
    const createdNodeIds: string[] = [];

    for (let index = 0; index < uniquePaths.length; index += 1) {
      const notePath = uniquePaths[index];
      const abstract = this.app.vault.getAbstractFileByPath(notePath);
      if (!this.isMarkdownVaultFile(abstract)) {
        continue;
      }
      const noteText = await this.readVaultMarkdownFile(abstract);
      const title = this.deriveNoteTitleFromPath(abstract.path) || prettifyNodeKind(noteDefinition.kind);
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
          vaultPath: abstract.path,
          value: noteText,
        },
        continueOnError: false,
        disabled: false,
      };
      project.graph.nodes.push(node);
      this.notePathByNodeId.set(node.id, abstract.path);
      createdNodeIds.push(node.id);
    }

    if (createdNodeIds.length === 0) {
      return;
    }

    this.graphInteraction.selectOnlyNode(createdNodeIds[createdNodeIds.length - 1]);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.scheduleProjectSave();
    this.render();

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
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    if (error instanceof Error) {
      console.error("[SystemSculpt Studio] Error", {
        message,
        name: error.name,
        stack: error.stack || null,
        projectPath: this.currentProjectPath,
      });
    } else {
      console.error("[SystemSculpt Studio] Error", {
        message,
        rawError: error,
        projectPath: this.currentProjectPath,
      });
    }
    new Notice(`SystemSculpt Studio: ${message}`);
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
      console.error("[SystemSculpt Studio] Node failed", {
        runId: event.runId,
        nodeId: event.nodeId,
        error: event.error,
        stack: event.errorStack || null,
        at: event.at,
        projectPath: this.currentProjectPath,
      });
    } else if (event.type === "run.failed") {
      this.removePendingManagedOutputPlaceholders({ runId: event.runId });
      console.error("[SystemSculpt Studio] Run failed", {
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
    const sourceNode = this.findNode(this.currentProject, event.nodeId);
    if (!sourceNode) {
      return;
    }
    if (sourceNode.kind !== "studio.text_generation" && sourceNode.kind !== "studio.transcription") {
      return;
    }
    const outputText = typeof event.outputs?.text === "string" ? event.outputs.text : "";
    if (!outputText.trim()) {
      return;
    }
    if (String(sourceNode.config.value || "") === outputText) {
      return;
    }
    sourceNode.config.value = outputText;
    this.scheduleProjectSave();
  }

  private syncDatasetOutputFieldsToNodeConfig(
    event: Extract<StudioRunEvent, { type: "node.output" }>
  ): void {
    if (!this.currentProject) {
      return;
    }
    const sourceNode = this.findNode(this.currentProject, event.nodeId);
    if (!sourceNode || sourceNode.kind !== "studio.dataset") {
      return;
    }

    const nextFields = deriveDatasetOutputFieldsFromOutputs(event.outputs);
    const currentFields = readDatasetOutputFields(
      sourceNode.config[DATASET_OUTPUT_FIELDS_CONFIG_KEY] as StudioJsonValue
    );
    const unchanged =
      nextFields.length === currentFields.length &&
      nextFields.every((field, index) => field === currentFields[index]);
    if (unchanged) {
      return;
    }

    if (nextFields.length === 0) {
      delete sourceNode.config[DATASET_OUTPUT_FIELDS_CONFIG_KEY];
    } else {
      sourceNode.config[DATASET_OUTPUT_FIELDS_CONFIG_KEY] = nextFields;
    }
    this.scheduleProjectSave();
  }

  private materializeManagedOutputPlaceholders(
    event: Extract<StudioRunEvent, { type: "node.started" }>
  ): void {
    if (!this.currentProject) {
      return;
    }

    const sourceNode = this.findNode(this.currentProject, event.nodeId);
    if (!sourceNode || !isStudioManagedOutputProducerKind(sourceNode.kind)) {
      return;
    }

    let changed = false;
    if (sourceNode.kind === "studio.image_generation") {
      const placeholders = materializePendingImageOutputPlaceholders({
        project: this.currentProject,
        sourceNode,
        runId: event.runId,
        createdAt: event.at,
        createNodeId: () => randomId("node"),
        createEdgeId: () => randomId("edge"),
      });
      changed = changed || placeholders.changed;
    }

    if (!changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
  }

  private materializeManagedOutputNodes(event: Extract<StudioRunEvent, { type: "node.output" }>): void {
    if (!this.currentProject) {
      return;
    }

    const sourceNode = this.findNode(this.currentProject, event.nodeId);
    if (!sourceNode) {
      return;
    }

    let changed = this.removePendingManagedOutputPlaceholders({
      sourceNodeId: sourceNode.id,
      runId: event.runId,
    });
    if (sourceNode.kind === "studio.image_generation") {
      const materializedMedia = materializeImageOutputsAsMediaNodes({
        project: this.currentProject,
        sourceNode,
        outputs: event.outputs || null,
        createNodeId: () => randomId("node"),
        createEdgeId: () => randomId("edge"),
      });
      changed = changed || materializedMedia.changed;
    }
    if (sourceNode.kind === "studio.text_generation") {
      const removedManagedText = removeManagedTextOutputNodes({
        project: this.currentProject,
        sourceNodeId: sourceNode.id,
      });
      changed = changed || removedManagedText.changed;
    }

    if (!changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
  }

  private materializeManagedOutputNodesFromCache(
    entries: Record<string, { outputs: StudioNodeOutputMap; updatedAt?: string }> | null
  ): void {
    if (!this.currentProject || !entries) {
      return;
    }

    let changed = false;
    for (const node of this.currentProject.graph.nodes) {
      if (!isStudioManagedOutputProducerKind(node.kind)) {
        continue;
      }

      const cacheEntry = entries[node.id];
      if (!cacheEntry || !cacheEntry.outputs || typeof cacheEntry.outputs !== "object") {
        continue;
      }

      if (node.kind === "studio.image_generation") {
        const materializedMedia = materializeImageOutputsAsMediaNodes({
          project: this.currentProject,
          sourceNode: node,
          outputs: cacheEntry.outputs,
          createNodeId: () => randomId("node"),
          createEdgeId: () => randomId("edge"),
        });
        if (materializedMedia.changed) {
          changed = true;
        }
      }
    }

    if (!changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
  }

  private removePendingManagedOutputPlaceholders(options?: {
    sourceNodeId?: string;
    runId?: string;
  }): boolean {
    if (!this.currentProject) {
      return false;
    }
    const removed = removePendingManagedOutputNodes({
      project: this.currentProject,
      sourceNodeId: options?.sourceNodeId,
      runId: options?.runId,
    });
    if (!removed.changed) {
      return false;
    }
    for (const nodeId of removed.removedNodeIds) {
      this.clearNoteWriteTimer(nodeId);
      this.notePathByNodeId.delete(nodeId);
      this.clearTransientFieldErrorsForNode(nodeId);
      this.runPresentation.removeNode(nodeId);
      this.graphInteraction.onNodeRemoved(nodeId);
      this.editingLabelNodeIds.delete(nodeId);
      if (this.pendingLabelAutofocusNodeId === nodeId) {
        this.pendingLabelAutofocusNodeId = null;
      }
    }
    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
    return true;
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private clearLayoutSaveTimer(): void {
    if (this.layoutSaveTimer !== null) {
      window.clearTimeout(this.layoutSaveTimer);
      this.layoutSaveTimer = null;
    }
  }

  private scheduleLayoutSave(): void {
    this.clearLayoutSaveTimer();
    this.layoutSaveTimer = window.setTimeout(() => {
      this.layoutSaveTimer = null;
      this.app.workspace.requestSaveLayout();
    }, 360);
  }

  private scheduleProjectSave(options?: { captureHistory?: boolean }): void {
    if (options?.captureHistory !== false) {
      this.captureProjectHistoryCheckpoint();
    }
    this.clearSaveTimer();
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushProjectSave();
    }, 280);
  }

  private async flushProjectSave(options?: { showNotice?: boolean }): Promise<void> {
    if (!this.currentProjectPath || !this.currentProject) {
      return;
    }

    if (this.saveInFlight) {
      this.saveQueued = true;
      return;
    }

    this.saveInFlight = true;
    this.lastError = null;
    try {
      await this.plugin
        .getStudioService()
        .saveProject(this.currentProjectPath, this.currentProject);
      if (options?.showNotice) {
        new Notice("Studio graph saved.");
      }
    } catch (error) {
      this.setError(error);
    } finally {
      this.saveInFlight = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        this.scheduleProjectSave();
      }
    }
  }

  private async loadProjectFromPath(
    projectPath: string | null,
    options?: { notifyOnError?: boolean }
  ): Promise<void> {
    if (!Platform.isDesktopApp) {
      return;
    }

    if (projectPath !== this.currentProjectPath) {
      await this.flushPendingNoteWrites();
      this.captureGraphViewportState();
      this.editingLabelNodeIds.clear();
      this.pendingLabelAutofocusNodeId = null;
      this.notePathByNodeId.clear();
      this.clearAllNoteWriteTimers();
    }

    if (!projectPath) {
      this.currentProjectPath = null;
      this.currentProject = null;
      this.resetProjectHistory(null);
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.notePathByNodeId.clear();
      this.pendingViewportState = null;
      this.syncInspectorSelection();
      return;
    }

    if (!projectPath.toLowerCase().endsWith(".systemsculpt")) {
      this.currentProjectPath = null;
      this.currentProject = null;
      this.resetProjectHistory(null);
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.notePathByNodeId.clear();
      this.pendingViewportState = null;
      this.syncInspectorSelection();
      if (options?.notifyOnError !== false) {
        new Notice("SystemSculpt Studio only opens .systemsculpt files.");
      }
      return;
    }

    if (this.currentProjectPath === projectPath && this.currentProject) {
      return;
    }

    try {
      const studio = this.plugin.getStudioService();
      const project = await studio.openProject(projectPath);
      const groupsSanitized = sanitizeGraphGroups(project);
      const mediaTitlesNormalized = this.normalizeLegacyMediaNodeTitles(project);
      const stalePendingRemoved = cleanupStaleManagedOutputPlaceholders(project).changed;
      const legacyManagedTextRemoved = removeManagedTextOutputNodes({ project }).changed;
      const noteValuesHydrated = await this.hydrateNoteNodeValuesFromVault(project);
      const savedGraphView = getSavedGraphViewState(this.graphViewStateByProjectPath, projectPath);
      this.currentProjectPath = projectPath;
      this.currentProject = project;
      this.rebuildNotePathIndex(project);
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
      this.resetProjectHistory(project);
      if (
        groupsSanitized ||
        mediaTitlesNormalized ||
        stalePendingRemoved ||
        legacyManagedTextRemoved ||
        noteValuesHydrated
      ) {
        this.scheduleProjectSave();
      }
      this.lastError = null;
      this.syncInspectorSelection();
    } catch (error) {
      this.currentProjectPath = null;
      this.currentProject = null;
      this.resetProjectHistory(null);
      this.notePathByNodeId.clear();
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.pendingViewportState = null;
      this.syncInspectorSelection();
      this.lastError = error instanceof Error ? error.message : String(error);
      if (options?.notifyOnError !== false) {
        this.setError(error);
      }
    }
  }

  private rebuildNotePathIndex(project: StudioProjectV1): void {
    this.notePathByNodeId.clear();
    for (const node of project.graph.nodes) {
      if (node.kind !== "studio.note") {
        continue;
      }
      const vaultPath = this.readNotePathFromConfig(node);
      if (!vaultPath) {
        continue;
      }
      this.notePathByNodeId.set(node.id, normalizePath(vaultPath));
    }
  }

  private async hydrateNoteNodeValuesFromVault(
    project: StudioProjectV1,
    options?: {
      onlyNodeIds?: Set<string>;
      clearWhenMissing?: boolean;
    }
  ): Promise<boolean> {
    let changed = false;
    const onlyNodeIds = options?.onlyNodeIds;
    const clearWhenMissing = options?.clearWhenMissing ?? true;

    for (const node of project.graph.nodes) {
      if (node.kind !== "studio.note") {
        continue;
      }
      if (onlyNodeIds && !onlyNodeIds.has(node.id)) {
        continue;
      }

      const configuredPath = this.readNotePathFromConfig(node);
      if (!configuredPath) {
        continue;
      }
      const normalizedPath = normalizePath(configuredPath);
      if (normalizedPath !== configuredPath) {
        node.config.vaultPath = normalizedPath;
        changed = true;
      }
      this.notePathByNodeId.set(node.id, normalizedPath);
      if (!normalizedPath.toLowerCase().endsWith(".md")) {
        continue;
      }

      const abstract = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!this.isMarkdownVaultFile(abstract)) {
        if (clearWhenMissing && String(node.config.value || "") !== "") {
          node.config.value = "";
          changed = true;
        }
        continue;
      }

      try {
        const text = await this.readVaultMarkdownFile(abstract);
        if (String(node.config.value || "") !== text) {
          node.config.value = text;
          changed = true;
        }
      } catch (error) {
        console.warn("[SystemSculpt Studio] Unable to read note for hydration", {
          nodeId: node.id,
          path: normalizedPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return changed;
  }

  private clearNoteWriteTimer(nodeId: string): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    const timerId = this.noteWriteTimersByNodeId.get(normalizedNodeId);
    if (typeof timerId !== "number") {
      return;
    }
    window.clearTimeout(timerId);
    this.noteWriteTimersByNodeId.delete(normalizedNodeId);
  }

  private clearAllNoteWriteTimers(): void {
    for (const timerId of this.noteWriteTimersByNodeId.values()) {
      window.clearTimeout(timerId);
    }
    this.noteWriteTimersByNodeId.clear();
  }

  private async flushPendingNoteWrites(): Promise<void> {
    const pendingNodeIds = Array.from(this.noteWriteTimersByNodeId.keys());
    if (pendingNodeIds.length === 0) {
      return;
    }
    this.clearAllNoteWriteTimers();
    for (const nodeId of pendingNodeIds) {
      await this.persistNoteNodeToVault(nodeId);
    }
  }

  private scheduleNoteNodeWrite(nodeId: string): void {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId) {
      return;
    }
    this.clearNoteWriteTimer(normalizedNodeId);
    const timerId = window.setTimeout(() => {
      this.noteWriteTimersByNodeId.delete(normalizedNodeId);
      void this.persistNoteNodeToVault(normalizedNodeId);
    }, 260);
    this.noteWriteTimersByNodeId.set(normalizedNodeId, timerId);
  }

  private async ensureFolderPathForVaultFile(filePath: string): Promise<void> {
    const normalized = normalizePath(String(filePath || "").trim());
    if (!normalized.includes("/")) {
      return;
    }
    const segments = normalized.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!current) {
        continue;
      }
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`Cannot create folder "${current}" because a file already exists there.`);
      }
    }
  }

  private async persistNoteNodeToVault(nodeId: string): Promise<void> {
    if (!this.currentProject) {
      return;
    }
    const node = this.findNode(this.currentProject, nodeId);
    if (!node || node.kind !== "studio.note") {
      return;
    }

    const rawPath = this.readNotePathFromConfig(node);
    if (!rawPath) {
      return;
    }
    const vaultPath = normalizePath(rawPath);
    if (!vaultPath.toLowerCase().endsWith(".md")) {
      return;
    }

    const nextText = String(node.config.value || "");
    try {
      const existing = this.app.vault.getAbstractFileByPath(vaultPath);
      if (this.isMarkdownVaultFile(existing)) {
        const currentText = await this.readVaultMarkdownFile(existing);
        if (currentText !== nextText) {
          await this.app.vault.modify(existing, nextText);
        }
        this.notePathByNodeId.set(node.id, existing.path);
        return;
      }
      if (this.isVaultFolder(existing)) {
        throw new Error(`Cannot write note to "${vaultPath}" because it is a folder.`);
      }

      await this.ensureFolderPathForVaultFile(vaultPath);
      await this.app.vault.create(vaultPath, nextText);
      this.notePathByNodeId.set(node.id, vaultPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SystemSculpt Studio] Failed to persist note node to vault", {
        nodeId,
        vaultPath,
        message,
      });
      new Notice(`Failed to save note "${vaultPath}": ${message}`);
    }
  }

  private async handleVaultItemModified(file: TAbstractFile): Promise<void> {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    if (!this.isMarkdownVaultFile(file)) {
      return;
    }

    const matchingNodeIds = this.currentProject.graph.nodes
      .filter((node) => node.kind === "studio.note" && this.readNotePathFromConfig(node) === file.path)
      .map((node) => node.id);
    if (matchingNodeIds.length === 0) {
      return;
    }

    const changed = await this.hydrateNoteNodeValuesFromVault(this.currentProject, {
      onlyNodeIds: new Set(matchingNodeIds),
      clearWhenMissing: false,
    });
    if (!changed) {
      return;
    }
    this.scheduleProjectSave();
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

    let changed = false;
    const changedNodeIds = new Set<string>();
    if (this.isMarkdownVaultFile(file)) {
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        if (this.readNotePathFromConfig(node) !== previousPath) {
          continue;
        }
        node.config.vaultPath = file.path;
        this.notePathByNodeId.set(node.id, file.path);
        const previousTitle = this.deriveNoteTitleFromPath(previousPath);
        if (!node.title || node.title === "Note" || node.title === previousTitle) {
          node.title = file.basename || node.title;
        }
        changed = true;
        changedNodeIds.add(node.id);
      }
    } else if (this.isVaultFolder(file)) {
      const prefix = `${previousPath}/`;
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        const currentPath = this.readNotePathFromConfig(node);
        if (!currentPath.startsWith(prefix)) {
          continue;
        }
        const suffix = currentPath.slice(prefix.length);
        const nextPath = normalizePath(`${file.path}/${suffix}`);
        node.config.vaultPath = nextPath;
        this.notePathByNodeId.set(node.id, nextPath);
        changed = true;
        changedNodeIds.add(node.id);
      }
    }

    if (changedNodeIds.size > 0) {
      const hydrated = await this.hydrateNoteNodeValuesFromVault(this.currentProject, {
        onlyNodeIds: changedNodeIds,
        clearWhenMissing: false,
      });
      changed = changed || hydrated;
    }
    if (!changed) {
      return;
    }
    this.scheduleProjectSave();
    this.render();
  }

  private handleVaultItemDeleted(file: TAbstractFile): void {
    if (!this.currentProject || !this.currentProjectPath) {
      return;
    }
    const deletedPath = normalizePath(String(file.path || "").trim());
    if (!deletedPath) {
      return;
    }

    let changed = false;
    if (this.isMarkdownVaultFile(file)) {
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        if (this.readNotePathFromConfig(node) !== deletedPath) {
          continue;
        }
        if (String(node.config.value || "") !== "") {
          node.config.value = "";
          changed = true;
        }
      }
    } else if (this.isVaultFolder(file)) {
      const prefix = `${deletedPath}/`;
      for (const node of this.currentProject.graph.nodes) {
        if (node.kind !== "studio.note") {
          continue;
        }
        const path = this.readNotePathFromConfig(node);
        if (!path.startsWith(prefix)) {
          continue;
        }
        if (String(node.config.value || "") !== "") {
          node.config.value = "";
          changed = true;
        }
      }
    }

    if (!changed) {
      return;
    }
    this.scheduleProjectSave();
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
    const rawPath = this.readNotePathFromConfig(node);
    if (!rawPath) {
      return {
        text: "Broken link",
        tone: "warning",
        title: "Note path is empty. Set a markdown vault path to link this note node.",
      };
    }
    const normalizedPath = normalizePath(rawPath);
    const abstract = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (this.isMarkdownVaultFile(abstract)) {
      return null;
    }
    if (this.isVaultFolder(abstract)) {
      return {
        text: "Broken link",
        tone: "warning",
        title: `Vault path "${normalizedPath}" points to a folder. Note nodes require a markdown file.`,
      };
    }
    if (abstract instanceof TFile) {
      return {
        text: "Broken link",
        tone: "warning",
        title: `Vault path "${normalizedPath}" is not a markdown file.`,
      };
    }
    return {
      text: "Broken link",
      tone: "warning",
      title: `Vault note "${normalizedPath}" was not found.`,
    };
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
    this.scheduleProjectSave();
  }

  private handleNoteNodeConfigMutated(node: StudioNodeInstance): void {
    const rawPath = this.readNotePathFromConfig(node);
    const normalizedPath = rawPath ? normalizePath(rawPath) : "";
    if (rawPath && normalizedPath !== rawPath) {
      node.config.vaultPath = normalizedPath;
    }
    const previousPath = this.notePathByNodeId.get(node.id) || "";
    if (!normalizedPath) {
      this.notePathByNodeId.delete(node.id);
      this.clearNoteWriteTimer(node.id);
      return;
    }
    if (previousPath !== normalizedPath) {
      this.clearNoteWriteTimer(node.id);
      this.notePathByNodeId.set(node.id, normalizedPath);
      if (this.currentProject) {
        void this.hydrateNoteNodeValuesFromVault(this.currentProject, {
          onlyNodeIds: new Set([node.id]),
          clearWhenMissing: false,
        }).then((changed) => {
          if (!changed) {
            return;
          }
          this.scheduleProjectSave();
          this.render();
        });
      }
      return;
    }
    this.scheduleNoteNodeWrite(node.id);
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

    const outputPath = typeof outputs?.path === "string" ? outputs.path.trim() : "";
    const outputText = typeof outputs?.text === "string" ? outputs.text : "";
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
    if (this.nodeDragInProgress) {
      this.inspectorOverlay?.hide();
      this.nodeContextMenuOverlay?.hide();
      this.nodeActionContextMenuOverlay?.hide();
    }
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

  private async runGraph(options?: { fromNodeId?: string }): Promise<void> {
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

    this.clearSaveTimer();
    await this.flushProjectSave();

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
        new Notice(
          fromNodeId
            ? `Studio run from node failed: ${result.error || result.runId}`
            : `Studio run failed: ${result.error || result.runId}`
        );
      }
    } catch (error) {
      this.runPresentation.failBeforeRun(error instanceof Error ? error.message : String(error));
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
      node.config.__studio_seed_json = this.cloneJsonValue(value);
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

    const createdNode = this.createNodeFromDefinition(definition, {
      position: {
        x: anchor.x + 48,
        y: anchor.y + 10,
      },
    });
    if (!createdNode || !this.currentProject) {
      return false;
    }
    createdNode.title = this.buildAutoCreatedNodeTitle(template.nodeKind, request.fromPortId);

    const sourceValue = this.resolveSourcePortValue(sourceNode.id, request.fromPortId);
    if (typeof sourceValue !== "undefined") {
      this.seedAutoCreatedNodeConfig(createdNode, template.nodeKind, sourceValue);
      const previewOutputs = this.buildSeededPreviewOutputs(template.nodeKind, sourceValue);
      if (previewOutputs) {
        this.runPresentation.primeNodeOutput(createdNode.id, previewOutputs, {
          message: `Preview from ${request.fromPortId}`,
        });
      }
    }

    const targetPortType = this.getPortType(createdNode.id, "in", template.targetPortId);
    if (!targetPortType || !this.portTypeCompatible(sourcePortType, targetPortType)) {
      return false;
    }

    this.currentProject.graph.edges.push({
      id: randomId("edge"),
      fromNodeId: sourceNode.id,
      fromPortId: request.fromPortId,
      toNodeId: createdNode.id,
      toPortId: template.targetPortId,
    });

    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
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

  private normalizeLegacyMediaNodeTitles(project: StudioProjectV1): boolean {
    let changed = false;
    for (const node of project.graph.nodes) {
      if (node.kind !== "studio.media_ingest") {
        continue;
      }
      const currentTitle = String(node.title || "").trim();
      if (!currentTitle || currentTitle === "Media Ingest") {
        node.title = "Media";
        changed = true;
      }
    }
    return changed;
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
    project.graph.nodes.push(node);
    if (node.kind === "studio.label" && options?.autoEditLabel === true) {
      this.editingLabelNodeIds.add(node.id);
      this.pendingLabelAutofocusNodeId = node.id;
    } else {
      this.editingLabelNodeIds.delete(node.id);
    }
    this.graphInteraction.selectOnlyNode(node.id);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.scheduleProjectSave();
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
    const contextMenuItems = this.nodeDefinitions.map((definition) => ({
      definition,
      title: prettifyNodeKind(definition.kind),
      summary: describeNodeDefinition(definition),
    }));
    const target = event.target instanceof HTMLElement ? event.target : null;
    const contextNodeCard = target?.closest<HTMLElement>(".ss-studio-node-card");
    const contextNodeId = String(contextNodeCard?.dataset.nodeId || "").trim();
    if (contextNodeId) {
      if (canGroupSelection && selectedNodeIdSet.has(contextNodeId)) {
        this.nodeActionContextMenuOverlay?.hide();
        const contextMenu = this.ensureNodeContextMenuOverlay();
        contextMenu.mount(viewport);
        contextMenu.setGraphZoom(zoom);
        contextMenu.open({
          anchorX: menuX,
          anchorY: menuY,
          items: contextMenuItems,
          actions: [
            {
              id: "group-selected-nodes",
              title: "Group Selected Nodes",
              summary: `Create a group around ${selectedNodeIds.length} selected nodes.`,
              onSelect: () => {
                this.createGroupFromSelectedNodes(selectedNodeIds);
              },
            },
          ],
          onSelectDefinition: (definition) => {
            this.createNodeFromDefinition(definition, {
              position: { x: graphX, y: graphY },
            });
          },
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

    if (contextMenuItems.length === 0) {
      new Notice("No node definitions are available.");
      return;
    }

    this.nodeActionContextMenuOverlay?.hide();
    const contextMenu = this.ensureNodeContextMenuOverlay();
    contextMenu.mount(viewport);
    contextMenu.setGraphZoom(zoom);
    contextMenu.open({
      anchorX: menuX,
      anchorY: menuY,
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
          position: { x: graphX, y: graphY },
        });
      },
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
    const changed = removeNodesFromGroups(this.currentProject, [normalizedNodeId]);
    if (!changed) {
      return;
    }

    if (bounds) {
      node.position = this.normalizeNodePosition({
        x: bounds.left + bounds.width + GROUP_DISCONNECT_OFFSET_X,
        y: node.position.y,
      });
    }

    this.nodeActionContextMenuOverlay?.hide();
    this.graphInteraction.selectOnlyNode(normalizedNodeId);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
    this.render();
  }

  private createGroupFromSelectedNodes(selectedNodeIds: string[]): void {
    if (this.busy || !this.currentProject) {
      return;
    }

    const createdGroup = createNodeGroupFromSelection(this.currentProject, selectedNodeIds, () =>
      randomId("group")
    );
    if (!createdGroup) {
      new Notice("Select at least two nodes to create a group.");
      return;
    }

    this.graphInteraction.requestGroupNameEdit(createdGroup.id);
    this.scheduleProjectSave();
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

    const previousCount = this.currentProject.graph.nodes.length;
    this.currentProject.graph.nodes = this.currentProject.graph.nodes.filter(
      (node) => !idsToRemove.has(node.id)
    );
    if (this.currentProject.graph.nodes.length === previousCount) {
      return;
    }
    this.currentProject.graph.edges = this.currentProject.graph.edges.filter(
      (edge) => !idsToRemove.has(edge.fromNodeId) && !idsToRemove.has(edge.toNodeId)
    );
    removeNodesFromGroups(this.currentProject, Array.from(idsToRemove));

    for (const nodeId of idsToRemove) {
      this.clearNoteWriteTimer(nodeId);
      this.notePathByNodeId.delete(nodeId);
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
    this.scheduleProjectSave();
    this.render();
  }

  private removeNode(nodeId: string): void {
    this.removeNodes([nodeId]);
  }

  private handleGraphZoomChanged(zoom: number): void {
    this.inspectorOverlay?.setGraphZoom(zoom);
    this.nodeContextMenuOverlay?.setGraphZoom(zoom);
    this.nodeActionContextMenuOverlay?.setGraphZoom(zoom);
    this.captureGraphViewportState({ zoomOverride: zoom, requestLayoutSave: true });
  }

  private handleGraphViewportScrolled(): void {
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
    this.captureGraphViewportState({ requestLayoutSave: true });
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
      for (const reference of this.parsePathReferencesFromText(payload)) {
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
      const item = this.resolveVaultItemFromReference(reference);
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

  private isAbsoluteFilesystemPath(path: string): boolean {
    const normalized = String(path || "").replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
  }

  private resolveAbsolutePathFromVaultPath(vaultPath: string): string | null {
    const normalizedVaultPath = String(vaultPath || "").trim().replace(/\\/g, "/");
    if (!normalizedVaultPath) {
      return null;
    }

    const adapter = this.app.vault.adapter as any;
    if (adapter instanceof FileSystemAdapter && typeof adapter.getFullPath === "function") {
      try {
        const fullPath = adapter.getFullPath(normalizedVaultPath);
        if (typeof fullPath === "string" && fullPath.trim().length > 0) {
          return fullPath;
        }
      } catch {
        // Fall through to base path fallback.
      }
    }
    if (typeof adapter.basePath === "string" && adapter.basePath.trim().length > 0) {
      const basePath = adapter.basePath.replace(/[\\/]+$/, "");
      const separator = basePath.includes("\\") ? "\\" : "/";
      const normalizedRelative = normalizedVaultPath.split(/[\\/]+/).filter(Boolean).join(separator);
      return normalizedRelative ? `${basePath}${separator}${normalizedRelative}` : basePath;
    }
    return null;
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
    const isAbsolutePath = this.isAbsoluteFilesystemPath(normalizedPath);
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
      : this.resolveAbsolutePathFromVaultPath(normalizedPath);
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
    const result = renderStudioGraphWorkspace({
      root,
      busy: this.busy,
      currentProject: this.currentProject,
      currentProjectPath: this.currentProjectPath,
      graphInteraction: this.graphInteraction,
      getNodeRunState: (nodeId) => this.runPresentation.getNodeState(nodeId),
      findNodeDefinition: (node) => this.findNodeDefinition(node),
      resolveAssetPreviewSrc: (assetPath) => resolveStudioAssetPreviewSrc(this.app, assetPath),
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
      onRemoveNode: (nodeId) => {
        this.removeNode(nodeId);
      },
      onNodeTitleInput: (node, title) => {
        node.title = title;
        this.scheduleProjectSave();
      },
      onNodeConfigMutated: (node) => {
        this.handleNodeConfigMutated(node);
      },
      onNodeGeometryMutated: () => {
        this.graphInteraction.notifyNodePositionsChanged();
        this.scheduleProjectSave();
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
      this.inspectorOverlay?.hide();
      this.nodeContextMenuOverlay?.hide();
      this.nodeActionContextMenuOverlay?.hide();
      return;
    }

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
  }): void {
    const viewport = this.graphViewportEl;
    const projectPath = this.graphViewportProjectPath;
    if (!viewport || !projectPath) {
      this.pendingViewportState = null;
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
    this.graphInteraction.setGraphZoom(nextZoom);

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

  private render(): void {
    this.captureGraphViewportState();
    this.graphInteraction.clearRenderBindings();
    this.nodeContextMenuOverlay?.hide();
    this.nodeActionContextMenuOverlay?.hide();
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

    this.renderGraphEditor(root);
  }
}
