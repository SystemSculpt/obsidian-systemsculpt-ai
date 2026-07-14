import { StudioGraphConnectionEngineV3 } from "./connections-v3/StudioGraphConnectionEngineV3";
import { StudioGraphGroupController } from "./StudioGraphGroupController";
import { StudioGraphSelectionController } from "./StudioGraphSelectionController";
import { StudioGraphSelectionResizeController } from "./StudioGraphSelectionResizeController";
import type {
  PendingConnection,
  StudioGraphInteractionHost,
  StudioGraphZoomMode,
} from "./StudioGraphInteractionTypes";
import {
  STUDIO_GRAPH_CANVAS_HEIGHT,
  STUDIO_GRAPH_CANVAS_WIDTH,
} from "./StudioGraphInteractionTypes";

export { STUDIO_GRAPH_CANVAS_HEIGHT, STUDIO_GRAPH_CANVAS_WIDTH };
export type { PendingConnection };

export class StudioGraphInteractionEngine {
  private readonly selectionController: StudioGraphSelectionController;
  private readonly connectionEngine: StudioGraphConnectionEngineV3;
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
    });

    this.groupController = new StudioGraphGroupController({
      isBusy: () => this.host.isBusy(),
      getCurrentProject: () => this.host.getCurrentProject(),
      getGraphZoom: () => this.selectionController.getGraphZoom(),
      getNodeElement: (nodeId) => this.selectionController.getNodeElement(nodeId),
      notifyNodePositionsChanged: (options) => this.selectionController.notifyNodePositionsChanged(options),
      onNodeDragStateChange: (isDragging) => this.host.onNodeDragStateChange?.(isDragging),
      requestRender: () => this.host.requestRender(),
      commitProjectMutation: (reason, mutator, options) =>
        this.host.commitProjectMutation(reason, mutator, options),
    });

    this.connectionEngine = new StudioGraphConnectionEngineV3({
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
      this.selectionResizeController.refreshSelectionFrame();
      this.externalSelectionChangeListener?.();
    });
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
  }

  registerSurfaceElement(surface: HTMLElement): void {
    this.selectionController.registerSurfaceElement(surface);
  }

  registerMarqueeElement(marquee: HTMLElement): void {
    this.selectionController.registerMarqueeElement(marquee);
  }

  registerSnapGuidesElement(layer: HTMLElement): void {
    this.selectionController.registerSnapGuidesElement(layer);
  }

  registerZoomLabelElement(label: HTMLElement): void {
    this.selectionController.registerZoomLabelElement(label);
  }

  registerCanvasElement(canvas: HTMLElement): void {
    this.selectionController.registerCanvasElement(canvas);
    this.connectionEngine.registerCanvasElement(canvas);
    this.groupController.registerCanvasElement(canvas);
    this.selectionResizeController.registerCanvasElement(canvas);
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

  resolveNodeResizeSnap(
    nodeId: string,
    moving: { left: number; top: number; right: number; bottom: number },
    edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 }
  ): { deltaX: number; deltaY: number } {
    return this.selectionController.resolveNodeResizeSnap(nodeId, moving, edges);
  }

  clearResizeSnapGuides(): void {
    this.selectionController.clearResizeSnapGuides();
  }

  registerPortElement(nodeId: string, direction: "in" | "out", portId: string, element: HTMLElement): void {
    this.connectionEngine.registerPortElement(nodeId, direction, portId, element);
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
    return this.selectionController.fitSelectionInViewport(options);
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

  applyRunEvent(event: import("../../studio/types").StudioRunEvent): void {
    this.connectionEngine.applyRunEvent(event);
  }

  notifyNodePositionsChanged(options?: { recomputeCanvasBounds?: boolean }): void {
    this.selectionController.notifyNodePositionsChanged(options);
  }
}
