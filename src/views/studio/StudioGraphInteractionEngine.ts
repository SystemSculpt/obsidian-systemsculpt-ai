import { StudioGraphConnectionEngine } from "./connections/StudioGraphConnectionEngine";
import { StudioGraphGroupController } from "./StudioGraphGroupController";
import { StudioGraphSelectionController } from "./StudioGraphSelectionController";
import { StudioGraphSelectionResizeController } from "./StudioGraphSelectionResizeController";
import type { StudioProjectV1 } from "../../studio/types";
import type {
  PendingConnection,
  StudioGraphInteractionHost,
  StudioGraphZoomMode,
} from "./StudioGraphInteractionTypes";
export type { PendingConnection };

export class StudioGraphInteractionEngine {
  private readonly selectionController: StudioGraphSelectionController;
  private readonly connectionEngine: StudioGraphConnectionEngine;
  private readonly groupController: StudioGraphGroupController;
  private readonly selectionResizeController: StudioGraphSelectionResizeController;
  private externalSelectionChangeListener: (() => void) | null = null;

  constructor(private readonly host: StudioGraphInteractionHost) {
    this.selectionController = new StudioGraphSelectionController({
      isBusy: () => this.host.isBusy(),
      getCurrentProject: () => this.host.getCurrentProject(),
      renderEdgeLayer: () => this.connectionEngine.renderEdgeLayer(),
      onNodePositionsChanged: () => {
        this.groupController.refreshGroupBounds();
        this.selectionResizeController.refreshSelectionFrame();
        this.host.onNodePositionsChanged?.();
      },
      commitProjectMutation: (reason, mutator, options) =>
        this.host.commitProjectMutation(reason, mutator, options),
      onNodeDragStateChange: (isDragging) => this.host.onNodeDragStateChange?.(isDragging),
      resolveNodeDragHoverGroup: (draggedNodeIds) =>
        this.groupController.resolveDropTargetGroupId(draggedNodeIds),
      onNodeDragHoverGroupChange: (groupId, draggedNodeIds) => {
        this.groupController.setDropTargetHighlight(groupId);
        this.host.onNodeDragHoverGroupChange?.(groupId, draggedNodeIds);
      },
      onNodeDropToGroup: (groupId, draggedNodeIds) => {
        this.groupController.handleNodeDropToGroup(groupId, draggedNodeIds);
        this.host.onNodeDropToGroup?.(groupId, draggedNodeIds);
      },
      onGraphZoomChanged: (zoom, context) => this.host.onGraphZoomChanged?.(zoom, context),
      getSelectedShapeIds: () => this.host.getSelectedShapeIds?.() || [],
      beginDiagramMarquee: () => this.host.beginDiagramMarquee?.(),
      selectDiagramInBounds: (bounds, additive) =>
        this.host.selectDiagramInBounds?.(bounds, additive),
      beginDiagramTranslation: () => this.host.beginDiagramTranslation?.(),
      translateDiagramSelection: (project, delta) =>
        this.host.translateDiagramSelection?.(project, delta) === true,
      previewDiagramTranslation: () => this.host.previewDiagramTranslation?.(),
      finishDiagramTranslation: () => this.host.finishDiagramTranslation?.(),
    });

    this.groupController = new StudioGraphGroupController({
      isBusy: () => this.host.isBusy(),
      getCurrentProject: () => this.host.getCurrentProject(),
      getGraphZoom: () => this.selectionController.getGraphZoom(),
      onGroupSelected: () => { this.selectionController.setSelectedNodeIds([]); this.host.clearDiagramSelection?.(); },
      getNodeElement: (nodeId) => this.selectionController.getNodeElement(nodeId),
      notifyNodePositionsChanged: (options) => this.selectionController.notifyNodePositionsChanged(options),
      onNodeDragStateChange: (isDragging) => this.host.onNodeDragStateChange?.(isDragging),
      requestRender: () => this.host.requestRender(),
      commitProjectMutation: (reason, mutator, options) =>
        this.host.commitProjectMutation(reason, mutator, options),
      createMovementSnap: (nodes, shapes) => this.selectionController.createMovementSnap(nodes, shapes),
      showMovementGuides: (nodes, shapes) => this.selectionController.showMovementGuides(nodes, shapes),
      clearMovementGuides: () => this.selectionController.clearAlignmentGuides(),
      beginShapeTranslation: (shapeIds) => this.host.beginGroupShapeTranslation?.(shapeIds),
      translateShapes: (project, delta) =>
        this.host.translateDiagramSelection?.(project, delta) === true,
      previewShapeTranslation: () => this.host.previewDiagramTranslation?.(),
      finishShapeTranslation: () => this.host.finishDiagramTranslation?.(),
    });

    this.connectionEngine = new StudioGraphConnectionEngine({
      ...this.host,
      getGraphZoom: () => this.selectionController.getGraphZoom(),
    });

    this.selectionResizeController = new StudioGraphSelectionResizeController({
      isBusy: () => this.host.isBusy(),
      getCurrentProject: () => this.host.getCurrentProject(),
      getGraphZoom: () => this.selectionController.getGraphZoom(),
      getSelectedNodeIds: () => this.selectionController.getSelectedNodeIds(),
      getNodeElement: (nodeId) => this.selectionController.getNodeElement(nodeId),
      onSelectionResize: (patches, options) => this.host.onSelectionResize?.(patches, options),
    });

    // The engine multiplexes selection changes: the multi-select resize
    // frame re-derives first, then the host's own listener runs.
    this.selectionController.setSelectionChangeListener(() => {
      this.groupController.clearSelection();
      this.selectionResizeController.refreshSelectionFrame();
      this.externalSelectionChangeListener?.();
    });
  }

  createMovementSnap(nodeIds: readonly string[], shapeIds: readonly string[]) {
    return this.selectionController.createMovementSnap(nodeIds, shapeIds);
  }

  showMovementGuides(nodeIds: readonly string[], shapeIds: readonly string[]): void {
    this.selectionController.showMovementGuides(nodeIds, shapeIds);
  }

  clearMovementGuides(): void {
    this.selectionController.clearAlignmentGuides();
  }

  getGraphZoom(): number {
    return this.selectionController.getGraphZoom();
  }

  getGraphZoomMode(): StudioGraphZoomMode {
    return this.selectionController.getGraphZoomMode();
  }

  setGraphZoom(
    nextZoom: number,
    options?: {
      mode?: StudioGraphZoomMode;
      settled?: boolean;
      scheduleSettle?: boolean;
    }
  ): void {
    this.selectionController.setGraphZoom(nextZoom, options);
  }

  getPendingConnection(): PendingConnection | null {
    return this.connectionEngine.getPendingConnection();
  }

  isNodeSelected(nodeId: string): boolean {
    return this.selectionController.isNodeSelected(nodeId);
  }

  getSelectedNodeIds(): string[] {
    return this.selectionController.getSelectedNodeIds();
  }

  setSelectedNodeIds(nodeIds: string[]): void {
    this.selectionController.setSelectedNodeIds(nodeIds);
  }

  getSingleSelectedNodeId(): string | null {
    return this.selectionController.getSingleSelectedNodeId();
  }

  setSelectionChangeListener(listener: (() => void) | null): void {
    this.externalSelectionChangeListener = listener;
  }

  isPendingConnectionSource(nodeId: string, portId: string): boolean {
    return this.connectionEngine.isPendingConnectionSource(nodeId, portId);
  }

  selectOnlyNode(nodeId: string): void {
    this.selectionController.selectOnlyNode(nodeId);
  }

  clearProjectState(): void {
    this.groupController.clearSelection();
    this.selectionController.clearProjectState();
    this.connectionEngine.clearProjectState();
  }

  clearPendingConnection(options?: { requestRender?: boolean }): void {
    this.connectionEngine.clearPendingConnection(options);
  }

  clearRenderBindings(): void {
    this.selectionController.clearRenderBindings();
    this.connectionEngine.clearRenderBindings();
    this.groupController.clearRenderBindings();
    this.selectionResizeController.clearRenderBindings();
  }

  onNodeRemoved(nodeId: string): void {
    this.selectionController.onNodeRemoved(nodeId);
    this.connectionEngine.onNodeRemoved(nodeId);
    this.selectionResizeController.refreshSelectionFrame();
  }

  registerViewportElement(viewport: HTMLElement): void {
    this.selectionController.registerViewportElement(viewport);
    this.connectionEngine.registerViewportElement(viewport);
  }

  registerSurfaceElement(surface: HTMLElement): void {
    this.selectionController.registerSurfaceElement(surface);
  }

  registerMarqueeElement(marquee: HTMLElement): void {
    this.selectionController.registerMarqueeElement(marquee);
  }

  registerAlignmentGuidesElement(layer: HTMLElement): void {
    this.selectionController.registerAlignmentGuidesElement(layer);
  }

  registerZoomLabelElement(label: HTMLElement): void {
    this.selectionController.registerZoomLabelElement(label);
  }

  /**
   * `canvas` is the scroll box; `world` is the translated layer inside it
   * where every positioned element lives in world px. Sub-controllers that
   * mount layers or measure positions work in the world.
   */
  registerCanvasElement(canvas: HTMLElement, world: HTMLElement = canvas): void {
    this.selectionController.registerCanvasElement(canvas, world);
    this.connectionEngine.registerCanvasElement(world);
    this.groupController.registerCanvasElement(world);
    this.selectionResizeController.registerCanvasElement(world);
  }

  /** Client (screen) point → world px. */
  graphPointFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
    return this.selectionController.graphPointFromClient(clientX, clientY);
  }

  getViewportCenterWorldPoint(): { x: number; y: number } | null {
    return this.selectionController.getViewportCenterWorldPoint();
  }

  getViewportWorldTopLeft(): { x: number; y: number } | null {
    return this.selectionController.getViewportWorldTopLeft();
  }

  setViewportWorldTopLeft(x: number, y: number): void {
    this.selectionController.setViewportWorldTopLeft(x, y);
  }

  /** Grow the scroll box when the view nears an edge; call from scroll handling. */
  ensureWorldCoverage(): boolean {
    return this.selectionController.ensureWorldCoverage();
  }

  zoomGraphAtViewportCenter(
    nextZoom: number,
    options?: { mode?: StudioGraphZoomMode; settled?: boolean; scheduleSettle?: boolean }
  ): void {
    this.selectionController.zoomGraphAtViewportCenter(nextZoom, options);
  }

  registerEdgesLayerElement(layer: SVGSVGElement): void {
    this.selectionController.registerEdgesLayerElement(layer);
    this.connectionEngine.registerEdgesLayerElement(layer);
  }

  clearGraphElementMaps(): void {
    this.selectionController.clearNodeElements();
    this.connectionEngine.clearPortElements();
  }

  registerNodeElement(nodeId: string, nodeEl: HTMLElement): void {
    this.selectionController.registerNodeElement(nodeId, nodeEl);
  }

  getNodeElement(nodeId: string): HTMLElement | null {
    return this.selectionController.getNodeElement(nodeId);
  }

  showNodeResizeGuides(
    nodeId: string,
    moving: { left: number; top: number; right: number; bottom: number },
    edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 }
  ): void {
    return this.selectionController.showNodeResizeGuides(nodeId, moving, edges);
  }

  clearAlignmentGuides(): void {
    this.selectionController.clearAlignmentGuides();
  }

  registerPortElement(nodeId: string, direction: "in" | "out", portId: string, element: HTMLElement): void {
    this.connectionEngine.registerPortElement(nodeId, direction, portId, element);
  }

  getPortElement(nodeId: string, direction: "in" | "out", portId: string): HTMLElement | null {
    return this.connectionEngine.getPortElement(nodeId, direction, portId);
  }

  refreshNodeSelectionClasses(): void {
    this.selectionController.refreshNodeSelectionClasses();
  }

  renderGroupLayer(): void {
    this.groupController.renderGroupLayer();
  }

  refreshGroupBounds(): void {
    this.groupController.refreshGroupBounds();
  }

  refreshSelectionResizeFrame(): void {
    this.selectionResizeController.refreshSelectionFrame();
  }

  requestGroupNameEdit(groupId: string): void {
    this.groupController.requestGroupNameEdit(groupId);
  }

  startMarqueeSelection(startEvent: PointerEvent): void {
    this.selectionController.startMarqueeSelection(startEvent);
  }

  startCanvasPan(startEvent: PointerEvent): void {
    this.selectionController.startCanvasPan(startEvent);
  }

  applyGraphZoom(): void {
    this.selectionController.applyGraphZoom();
  }

  fitSelectedNodesInViewport(options?: { paddingPx?: number }): boolean {
    const groupBounds = this.groupController.getSelectedGroupBounds();
    return groupBounds
      ? this.selectionController.fitBoundsInViewport(groupBounds, options)
      : this.selectionController.fitSelectionInViewport(options);
  }

  fitGraphInViewport(options?: { paddingPx?: number }): boolean {
    return this.selectionController.fitGraphInViewport(options);
  }

  handleGraphViewportWheel(event: WheelEvent): void {
    this.selectionController.handleGraphViewportWheel(event);
  }

  startNodeDrag(nodeId: string, startEvent: PointerEvent, dragSurfaceEl: HTMLElement): void {
    this.selectionController.startNodeDrag(nodeId, startEvent, dragSurfaceEl);
  }

  /** Node half of a drag the diagram layer owns; see the selection controller. */
  beginSelectionTranslation(): void {
    this.selectionController.beginSelectionTranslation();
  }

  applySelectionTranslation(project: StudioProjectV1, delta: { x: number; y: number }): boolean {
    return this.selectionController.applySelectionTranslation(project, delta);
  }

  previewSelectionTranslation(): void {
    this.selectionController.previewSelectionTranslation();
  }

  finishSelectionTranslation(): void {
    this.selectionController.finishSelectionTranslation();
  }

  toggleNodeSelection(nodeId: string): void {
    this.selectionController.toggleNodeSelection(nodeId);
  }

  ensureSingleSelection(nodeId: string): void {
    this.selectionController.ensureSingleSelection(nodeId);
  }

  beginConnection(fromNodeId: string, fromPortId: string): void {
    this.connectionEngine.beginConnection(fromNodeId, fromPortId);
  }

  completeConnection(toNodeId: string, toPortId: string): void {
    this.connectionEngine.completeConnection(toNodeId, toPortId);
  }

  startConnectionDrag(
    fromNodeId: string,
    fromPortId: string,
    startEvent: PointerEvent,
    sourcePinEl: HTMLElement
  ): void {
    this.connectionEngine.startConnectionDrag(fromNodeId, fromPortId, startEvent, sourcePinEl);
  }

  consumeSuppressedOutputPortClick(nodeId: string, portId: string): boolean {
    return this.connectionEngine.consumeSuppressedOutputPortClick(nodeId, portId);
  }

  handleCanvasBackgroundClick(target: HTMLElement): void {
    if (this.selectionController.consumeSuppressedCanvasClick()) {
      return;
    }

    if (target.closest(".ss-studio-port-pin") || target.closest(".ss-studio-node-card")) {
      return;
    }

    if (this.connectionEngine.getPendingConnection()) {
      this.connectionEngine.clearPendingConnection({ requestRender: true });
      return;
    }

    this.selectionController.clearSelection();
  }

  renderEdgeLayer(): void {
    this.connectionEngine.renderEdgeLayer();
  }

  /** Cable phases from the activity applier; see views/studio/activity. */
  setEdgeActivity(edges: ReadonlyMap<string, import("./activity/StudioActivityDomApplier").StudioEdgeActivityUpdate>): void {
    this.connectionEngine.setEdgeActivity(edges);
  }

  notifyNodePositionsChanged(options?: { recomputeCanvasBounds?: boolean }): void {
    this.selectionController.notifyNodePositionsChanged(options);
  }
}
