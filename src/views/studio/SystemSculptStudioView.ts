import { ItemView, Notice, Platform, WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { randomId } from "../../studio/utils";
import type {
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioNodeOutputMap,
  StudioProjectV1,
  StudioRunEvent,
} from "../../studio/types";
import { scopeProjectForRun } from "../../studio/StudioRunScope";
import { validateNodeConfig } from "../../studio/StudioNodeConfigValidation";
import { renderStudioGraphWorkspace } from "./graph-v3/StudioGraphWorkspaceRenderer";
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
import { StudioGraphInteractionEngine } from "./StudioGraphInteractionEngine";
import {
  STUDIO_GRAPH_DEFAULT_ZOOM,
} from "./StudioGraphInteractionTypes";
import {
  type StudioNodeInspectorRuntimeDetails,
  StudioNodeInspectorLayout,
  StudioNodeInspectorOverlay,
} from "./StudioNodeInspectorOverlay";
import { StudioNodeContextMenuOverlay } from "./StudioNodeContextMenuOverlay";
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
import { materializeImageOutputsAsMediaNodes } from "./StudioGeneratedMediaNodes";

export const SYSTEMSCULPT_STUDIO_VIEW_TYPE = "systemsculpt-studio-view";

const DEFAULT_INSPECTOR_LAYOUT: StudioNodeInspectorLayout = {
  x: 36,
  y: 88,
  width: 420,
  height: 460,
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
  private inspectorLayout: StudioNodeInspectorLayout = { ...DEFAULT_INSPECTOR_LAYOUT };
  private nodeDragInProgress = false;
  private transientFieldErrorsByNodeId = new Map<string, Map<string, string>>();
  private graphViewStateByProjectPath: StudioGraphViewStateByProject = {};
  private pendingViewportState: StudioGraphViewportState | null = null;
  private readonly runPresentation = new StudioRunPresentationState();
  private readonly graphInteraction: StudioGraphInteractionEngine;
  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    this.handleWindowKeyDown(event);
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
    await this.loadNodeDefinitions();
    this.render();
  }

  async onClose(): Promise<void> {
    window.removeEventListener("keydown", this.onWindowKeyDown, true);
    this.captureGraphViewportState();
    this.app.workspace.requestSaveLayout();
    this.clearSaveTimer();
    this.clearLayoutSaveTimer();
    this.runPresentation.reset();
    this.inspectorOverlay?.destroy();
    this.inspectorOverlay = null;
    this.nodeContextMenuOverlay?.destroy();
    this.nodeContextMenuOverlay = null;
    this.pendingViewportState = null;
    this.graphViewportEl = null;
    this.graphViewportProjectPath = null;
    this.graphInteraction.clearRenderBindings();
    this.contentEl.empty();
  }

  private isEditableKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target.closest(".ss-studio-node-context-menu")) {
      return true;
    }
    if (target.isContentEditable) {
      return true;
    }
    if (target.matches("input, textarea, select")) {
      return true;
    }
    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  }

  private handleWindowKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (this.app.workspace.getActiveViewOfType(SystemSculptStudioView) !== this) {
      return;
    }
    if (this.busy || !this.currentProject) {
      return;
    }

    const key = String(event.key || "");
    if (key !== "Delete" && key !== "Backspace") {
      return;
    }
    if (this.isEditableKeyboardTarget(event.target)) {
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
    if (event.type === "node.output") {
      this.materializeGeneratedImageOutputs(event);
    }
    if (event.type === "node.failed") {
      console.error("[SystemSculpt Studio] Node failed", {
        runId: event.runId,
        nodeId: event.nodeId,
        error: event.error,
        stack: event.errorStack || null,
        at: event.at,
        projectPath: this.currentProjectPath,
      });
    } else if (event.type === "run.failed") {
      console.error("[SystemSculpt Studio] Run failed", {
        runId: event.runId,
        error: event.error,
        stack: event.errorStack || null,
        at: event.at,
        projectPath: this.currentProjectPath,
      });
    }
    this.render();
  }

  private materializeGeneratedImageOutputs(event: Extract<StudioRunEvent, { type: "node.output" }>): void {
    if (!this.currentProject) {
      return;
    }

    const sourceNode = this.findNode(this.currentProject, event.nodeId);
    if (!sourceNode || sourceNode.kind !== "studio.image_generation") {
      return;
    }

    const materialized = materializeImageOutputsAsMediaNodes({
      project: this.currentProject,
      sourceNode,
      outputs: event.outputs || null,
      createNodeId: () => randomId("node"),
      createEdgeId: () => randomId("edge"),
    });

    if (!materialized.changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
  }

  private materializeGeneratedImageOutputsFromCache(
    entries: Record<string, { outputs: StudioNodeOutputMap; updatedAt?: string }> | null
  ): void {
    if (!this.currentProject || !entries) {
      return;
    }

    let changed = false;
    for (const node of this.currentProject.graph.nodes) {
      if (node.kind !== "studio.image_generation") {
        continue;
      }

      const cacheEntry = entries[node.id];
      if (!cacheEntry || !cacheEntry.outputs || typeof cacheEntry.outputs !== "object") {
        continue;
      }

      const materialized = materializeImageOutputsAsMediaNodes({
        project: this.currentProject,
        sourceNode: node,
        outputs: cacheEntry.outputs,
        createNodeId: () => randomId("node"),
        createEdgeId: () => randomId("edge"),
      });
      if (materialized.changed) {
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    this.recomputeEntryNodes(this.currentProject);
    this.scheduleProjectSave();
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

  private scheduleProjectSave(): void {
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
      this.captureGraphViewportState();
    }

    if (!projectPath) {
      this.currentProjectPath = null;
      this.currentProject = null;
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
      this.pendingViewportState = null;
      this.syncInspectorSelection();
      return;
    }

    if (!projectPath.toLowerCase().endsWith(".systemsculpt")) {
      this.currentProjectPath = null;
      this.currentProject = null;
      this.graphInteraction.clearProjectState();
      this.graphInteraction.setGraphZoom(STUDIO_GRAPH_DEFAULT_ZOOM);
      this.transientFieldErrorsByNodeId.clear();
      this.runPresentation.reset();
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
      const savedGraphView = getSavedGraphViewState(this.graphViewStateByProjectPath, projectPath);
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
      try {
        const cacheSnapshot = await studio.getProjectNodeCache(projectPath);
        if (cacheSnapshot) {
          this.runPresentation.hydrateFromCache(cacheSnapshot.entries, {
            allowedNodeIds: project.graph.nodes.map((node) => node.id),
          });
          this.materializeGeneratedImageOutputsFromCache(cacheSnapshot.entries);
        }
      } catch (cacheError) {
        console.warn("[SystemSculpt Studio] Unable to hydrate cache state on project load", {
          projectPath,
          error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        });
      }
      this.lastError = null;
      this.syncInspectorSelection();
    } catch (error) {
      this.currentProjectPath = null;
      this.currentProject = null;
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

  private ensureInspectorOverlay(): StudioNodeInspectorOverlay {
    if (this.inspectorOverlay) {
      return this.inspectorOverlay;
    }

    this.inspectorOverlay = new StudioNodeInspectorOverlay(
      {
        isBusy: () => this.busy,
        onConfigMutated: (node) => {
          this.refreshNodeCardPreview(node);
          this.scheduleProjectSave();
        },
        onTransientFieldError: (nodeId, fieldKey, message) => {
          this.setTransientFieldError(nodeId, fieldKey, message);
        },
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
    }
  }

  private syncInspectorSelection(): void {
    if (!this.inspectorOverlay || !this.currentProject || !this.graphViewportEl) {
      return;
    }

    if (this.nodeDragInProgress) {
      this.inspectorOverlay.hide();
      return;
    }

    const nodeId = this.graphInteraction.getSingleSelectedNodeId();
    if (!nodeId) {
      this.inspectorOverlay.hide();
      return;
    }

    const node = this.findNode(this.currentProject, nodeId);
    if (!node) {
      this.inspectorOverlay.hide();
      return;
    }

    const definition = this.findNodeDefinition(node);
    if (!definition) {
      this.inspectorOverlay.hide();
      return;
    }

    const anchorEl = this.graphInteraction.getNodeElement(node.id);
    this.inspectorOverlay.showNode(node, definition, { anchorEl });
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
    const inboundNodeIds = new Set(project.graph.edges.map((edge) => edge.toNodeId));
    project.graph.entryNodeIds = project.graph.nodes
      .filter((node) => !inboundNodeIds.has(node.id))
      .map((node) => node.id);
  }

  private findNode(project: StudioProjectV1, nodeId: string): StudioNodeInstance | null {
    return project.graph.nodes.find((node) => node.id === nodeId) || null;
  }

  private findNodeDefinition(node: StudioNodeInstance): StudioNodeDefinition | null {
    return this.nodeDefinitionsByKey.get(`${node.kind}@${node.version}`) || null;
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

  private computeDefaultNodePosition(project: StudioProjectV1): { x: number; y: number } {
    const index = project.graph.nodes.length;
    return {
      x: 120 + (index % 4) * 320,
      y: 120 + Math.floor(index / 4) * 220,
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
    options?: { position?: { x: number; y: number } }
  ): void {
    let project: StudioProjectV1;
    try {
      project = this.currentProjectOrThrow();
    } catch (error) {
      this.setError(error);
      return;
    }

    if (this.busy) {
      return;
    }

    const position = options?.position
      ? this.normalizeNodePosition(options.position)
      : this.computeDefaultNodePosition(project);
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
    project.graph.nodes.push(node);
    this.graphInteraction.selectOnlyNode(node.id);
    this.graphInteraction.clearPendingConnection();
    this.recomputeEntryNodes(project);
    this.scheduleProjectSave();
    this.render();
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
    const contextMenuItems = this.nodeDefinitions.map((definition) => ({
      definition,
      title: prettifyNodeKind(definition.kind),
      summary: describeNodeDefinition(definition),
    }));

    if (contextMenuItems.length === 0) {
      new Notice("No node definitions are available.");
      return;
    }

    const contextMenu = this.ensureNodeContextMenuOverlay();
    contextMenu.mount(viewport);
    contextMenu.setGraphZoom(zoom);
    contextMenu.open({
      anchorX: menuX,
      anchorY: menuY,
      items: contextMenuItems,
      onSelectDefinition: (definition) => {
        this.createNodeFromDefinition(definition, {
          position: { x: graphX, y: graphY },
        });
      },
    });
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

    for (const nodeId of idsToRemove) {
      this.clearTransientFieldErrorsForNode(nodeId);
      this.runPresentation.removeNode(nodeId);
      this.graphInteraction.onNodeRemoved(nodeId);
    }
    this.nodeContextMenuOverlay?.hide();
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
    this.captureGraphViewportState({ zoomOverride: zoom, requestLayoutSave: true });
  }

  private handleGraphViewportScrolled(): void {
    this.nodeContextMenuOverlay?.hide();
    this.captureGraphViewportState({ requestLayoutSave: true });
  }

  private renderGraphEditor(root: HTMLElement): void {
    const result = renderStudioGraphWorkspace({
      root,
      busy: this.busy,
      currentProject: this.currentProject,
      currentProjectPath: this.currentProjectPath,
      graphInteraction: this.graphInteraction,
      getNodeRunState: (nodeId) => this.runPresentation.getNodeState(nodeId),
      runProgress: this.runPresentation.getProgress(),
      findNodeDefinition: (node) => this.findNodeDefinition(node),
      resolveAssetPreviewSrc: (assetPath) => resolveStudioAssetPreviewSrc(this.app, assetPath),
      onOpenMediaPreview: (options) => {
        openStudioMediaPreviewModal(this.app, options);
      },
      onRunGraph: () => {
        void this.runGraph();
      },
      onOpenNodeContextMenu: (event) => {
        this.openNodeContextMenuAtPointer(event);
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
    });

    this.graphViewportEl = result.viewportEl;
    this.graphViewportProjectPath = this.currentProjectPath;
    if (!this.graphViewportEl || !this.currentProject) {
      this.graphViewportProjectPath = null;
      this.inspectorOverlay?.hide();
      this.nodeContextMenuOverlay?.hide();
      return;
    }

    this.graphViewportEl.addEventListener("scroll", () => {
      this.handleGraphViewportScrolled();
    }, { passive: true });
    this.restoreGraphViewportState(this.graphViewportEl);
    const inspector = this.ensureInspectorOverlay();
    const contextMenu = this.ensureNodeContextMenuOverlay();
    inspector.setGraphZoom(this.graphInteraction.getGraphZoom());
    contextMenu.setGraphZoom(this.graphInteraction.getGraphZoom());
    inspector.mount(this.graphViewportEl);
    contextMenu.mount(this.graphViewportEl);
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
    this.graphViewportEl = null;
    this.graphViewportProjectPath = null;

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
