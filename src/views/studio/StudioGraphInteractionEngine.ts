import { StudioGraphConnectionController } from "./StudioGraphConnectionController";
import { StudioGraphSelectionController } from "./StudioGraphSelectionController";
import type {
  PendingConnection,
  StudioGraphInteractionHost,
} from "./StudioGraphInteractionTypes";
import {
  STUDIO_GRAPH_CANVAS_HEIGHT,
  STUDIO_GRAPH_CANVAS_WIDTH,
} from "./StudioGraphInteractionTypes";

export { STUDIO_GRAPH_CANVAS_HEIGHT, STUDIO_GRAPH_CANVAS_WIDTH };
export type { PendingConnection };

export class StudioGraphInteractionEngine {
  private readonly selectionController: StudioGraphSelectionController;
  private readonly connectionController: StudioGraphConnectionController;

  constructor(private readonly host: StudioGraphInteractionHost) {
    this.selectionController = new StudioGraphSelectionController({
      isBusy: () => this.host.isBusy(),
      getCurrentProject: () => this.host.getCurrentProject(),
      renderEdgeLayer: () => this.connectionController.renderEdgeLayer(),
      scheduleProjectSave: () => this.host.scheduleProjectSave(),
      onNodeDragStateChange: (isDragging) => this.host.onNodeDragStateChange?.(isDragging),
    });
    this.connectionController = new StudioGraphConnectionController({
      ...this.host,
      getGraphZoom: () => this.selectionController.getGraphZoom(),
    });
  }

  getGraphZoom(): number {
    return this.selectionController.getGraphZoom();
  }

  getPendingConnection(): PendingConnection | null {
    return this.connectionController.getPendingConnection();
  }

  isNodeSelected(nodeId: string): boolean {
    return this.selectionController.isNodeSelected(nodeId);
  }

  getSelectedNodeIds(): string[] {
    return this.selectionController.getSelectedNodeIds();
  }

  getSingleSelectedNodeId(): string | null {
    return this.selectionController.getSingleSelectedNodeId();
  }

  setSelectionChangeListener(listener: (() => void) | null): void {
    this.selectionController.setSelectionChangeListener(listener);
  }

  isPendingConnectionSource(nodeId: string, portId: string): boolean {
    return this.connectionController.isPendingConnectionSource(nodeId, portId);
  }

  selectOnlyNode(nodeId: string): void {
    this.selectionController.selectOnlyNode(nodeId);
  }

  clearProjectState(): void {
    this.selectionController.clearProjectState();
    this.connectionController.clearProjectState();
  }

  clearPendingConnection(options?: { requestRender?: boolean }): void {
    this.connectionController.clearPendingConnection(options);
  }

  clearRenderBindings(): void {
    this.selectionController.clearRenderBindings();
    this.connectionController.clearRenderBindings();
  }

  onNodeRemoved(nodeId: string): void {
    this.selectionController.onNodeRemoved(nodeId);
    this.connectionController.onNodeRemoved(nodeId);
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

  registerZoomLabelElement(label: HTMLElement): void {
    this.selectionController.registerZoomLabelElement(label);
  }

  registerCanvasElement(canvas: HTMLElement): void {
    this.selectionController.registerCanvasElement(canvas);
    this.connectionController.registerCanvasElement(canvas);
  }

  registerEdgesLayerElement(layer: SVGSVGElement): void {
    this.connectionController.registerEdgesLayerElement(layer);
  }

  clearGraphElementMaps(): void {
    this.selectionController.clearNodeElements();
    this.connectionController.clearPortElements();
  }

  registerNodeElement(nodeId: string, nodeEl: HTMLElement): void {
    this.selectionController.registerNodeElement(nodeId, nodeEl);
  }

  getNodeElement(nodeId: string): HTMLElement | null {
    return this.selectionController.getNodeElement(nodeId);
  }

  registerPortElement(nodeId: string, direction: "in" | "out", portId: string, element: HTMLElement): void {
    this.connectionController.registerPortElement(nodeId, direction, portId, element);
  }

  refreshNodeSelectionClasses(): void {
    this.selectionController.refreshNodeSelectionClasses();
  }

  startMarqueeSelection(startEvent: PointerEvent): void {
    this.selectionController.startMarqueeSelection(startEvent);
  }

  applyGraphZoom(): void {
    this.selectionController.applyGraphZoom();
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
    this.connectionController.beginConnection(fromNodeId, fromPortId);
  }

  completeConnection(toNodeId: string, toPortId: string): void {
    this.connectionController.completeConnection(toNodeId, toPortId);
  }

  startConnectionDrag(
    fromNodeId: string,
    fromPortId: string,
    startEvent: PointerEvent,
    sourcePinEl: HTMLElement
  ): void {
    this.connectionController.startConnectionDrag(fromNodeId, fromPortId, startEvent, sourcePinEl);
  }

  consumeSuppressedOutputPortClick(nodeId: string, portId: string): boolean {
    return this.connectionController.consumeSuppressedOutputPortClick(nodeId, portId);
  }

  handleCanvasBackgroundClick(target: HTMLElement): void {
    if (this.selectionController.consumeSuppressedCanvasClick()) {
      return;
    }

    if (target.closest(".ss-studio-port-pin") || target.closest(".ss-studio-node-card")) {
      return;
    }

    if (this.connectionController.getPendingConnection()) {
      this.connectionController.clearPendingConnection({ requestRender: true });
      return;
    }

    this.selectionController.clearSelection();
  }

  renderEdgeLayer(): void {
    this.connectionController.renderEdgeLayer();
  }
}
