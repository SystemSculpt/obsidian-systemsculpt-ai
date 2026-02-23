import type { StudioNodeInstance, StudioProjectV1 } from "../../studio/types";
import { isManagedOutputPlaceholderNode } from "./StudioManagedOutputNodes";
import {
  STUDIO_GRAPH_CANVAS_HEIGHT,
  STUDIO_GRAPH_CANVAS_WIDTH,
  STUDIO_GRAPH_DEFAULT_ZOOM,
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "./StudioGraphInteractionTypes";
import {
  computeStudioGraphCanvasSize,
  STUDIO_GRAPH_CANVAS_MAX_HEIGHT,
  STUDIO_GRAPH_CANVAS_MAX_WIDTH,
} from "./graph-v3/StudioGraphCanvasBounds";
import { resolveStudioGraphNodeWidth } from "./graph-v3/StudioGraphNodeGeometry";
import { shouldStudioGraphDeferWheelToNativeScroll } from "./StudioGraphDomTargeting";

type GraphPoint = {
  x: number;
  y: number;
};

const WHEEL_DOM_DELTA_LINE =
  typeof WheelEvent !== "undefined" ? WheelEvent.DOM_DELTA_LINE : 1;
const WHEEL_DOM_DELTA_PAGE =
  typeof WheelEvent !== "undefined" ? WheelEvent.DOM_DELTA_PAGE : 2;
type StudioGraphSelectionHost = {
  isBusy: () => boolean;
  getCurrentProject: () => StudioProjectV1 | null;
  renderEdgeLayer: () => void;
  onNodePositionsChanged?: () => void;
  scheduleProjectSave: () => void;
  onNodeDragStateChange?: (isDragging: boolean) => void;
  resolveNodeDragHoverGroup?: (draggedNodeIds: string[]) => string | null;
  onNodeDragHoverGroupChange?: (groupId: string | null, draggedNodeIds: string[]) => void;
  onNodeDropToGroup?: (groupId: string | null, draggedNodeIds: string[]) => void;
  onGraphZoomChanged?: (zoom: number) => void;
};

export class StudioGraphSelectionController {
  private graphZoom = STUDIO_GRAPH_DEFAULT_ZOOM;
  private graphCanvasWidth = STUDIO_GRAPH_CANVAS_WIDTH;
  private graphCanvasHeight = STUDIO_GRAPH_CANVAS_HEIGHT;
  private graphViewportEl: HTMLElement | null = null;
  private graphSurfaceEl: HTMLElement | null = null;
  private graphMarqueeEl: HTMLElement | null = null;
  private graphZoomLabelEl: HTMLElement | null = null;
  private graphCanvasEl: HTMLElement | null = null;
  private graphEdgesLayerEl: SVGSVGElement | null = null;
  private nodeElsById = new Map<string, HTMLElement>();
  private selectedNodeIds = new Set<string>();
  private suppressNextCanvasClick = false;
  private onSelectionChange: (() => void) | null = null;

  constructor(private readonly host: StudioGraphSelectionHost) {}

  getGraphZoom(): number {
    return this.graphZoom;
  }

  setGraphZoom(nextZoom: number): void {
    this.graphZoom = this.clampGraphZoom(nextZoom);
    this.applyGraphZoom();
  }

  isNodeSelected(nodeId: string): boolean {
    return this.selectedNodeIds.has(nodeId);
  }

  getSelectedNodeIds(): string[] {
    return Array.from(this.selectedNodeIds);
  }

  setSelectedNodeIds(nodeIds: string[]): void {
    const project = this.host.getCurrentProject();
    const allowedNodeIds = project
      ? new Set(project.graph.nodes.map((node) => node.id))
      : null;
    const nextSelection = new Set(
      nodeIds
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => nodeId.length > 0)
        .filter((nodeId) => (allowedNodeIds ? allowedNodeIds.has(nodeId) : true))
    );
    this.selectedNodeIds = nextSelection;
    this.refreshNodeSelectionClasses();
    this.notifySelectionChanged();
  }

  getSingleSelectedNodeId(): string | null {
    if (this.selectedNodeIds.size !== 1) {
      return null;
    }
    return Array.from(this.selectedNodeIds)[0] || null;
  }

  setSelectionChangeListener(listener: (() => void) | null): void {
    this.onSelectionChange = listener;
  }

  selectOnlyNode(nodeId: string): void {
    this.selectedNodeIds = new Set([nodeId]);
    this.notifySelectionChanged();
  }

  clearProjectState(): void {
    const hadSelection = this.selectedNodeIds.size > 0;
    this.selectedNodeIds.clear();
    if (hadSelection) {
      this.notifySelectionChanged();
    }
  }

  clearRenderBindings(): void {
    this.graphViewportEl = null;
    this.graphSurfaceEl = null;
    this.graphMarqueeEl = null;
    this.graphZoomLabelEl = null;
    this.graphCanvasEl = null;
    this.graphEdgesLayerEl = null;
    this.graphCanvasWidth = STUDIO_GRAPH_CANVAS_WIDTH;
    this.graphCanvasHeight = STUDIO_GRAPH_CANVAS_HEIGHT;
    this.suppressNextCanvasClick = false;
    this.nodeElsById.clear();
  }

  onNodeRemoved(nodeId: string): void {
    if (this.selectedNodeIds.delete(nodeId)) {
      this.notifySelectionChanged();
    }
  }

  registerViewportElement(viewport: HTMLElement): void {
    this.graphViewportEl = viewport;
  }

  registerSurfaceElement(surface: HTMLElement): void {
    this.graphSurfaceEl = surface;
  }

  registerMarqueeElement(marquee: HTMLElement): void {
    this.graphMarqueeEl = marquee;
  }

  registerZoomLabelElement(label: HTMLElement): void {
    this.graphZoomLabelEl = label;
  }

  registerCanvasElement(canvas: HTMLElement): void {
    this.graphCanvasEl = canvas;
    this.syncCanvasBounds({ force: true });
  }

  registerEdgesLayerElement(layer: SVGSVGElement): void {
    this.graphEdgesLayerEl = layer;
    this.syncCanvasBounds({ force: true });
  }

  notifyNodePositionsChanged(): void {
    if (this.syncCanvasBounds()) {
      this.syncGraphSurfaceSize();
    }
    this.host.renderEdgeLayer();
    this.host.onNodePositionsChanged?.();
  }

  clearNodeElements(): void {
    this.nodeElsById.clear();
  }

  registerNodeElement(nodeId: string, nodeEl: HTMLElement): void {
    this.nodeElsById.set(nodeId, nodeEl);
  }

  getNodeElement(nodeId: string): HTMLElement | null {
    return this.nodeElsById.get(nodeId) || null;
  }

  refreshNodeSelectionClasses(): void {
    for (const [nodeId, nodeEl] of this.nodeElsById.entries()) {
      nodeEl.classList.toggle("is-selected", this.selectedNodeIds.has(nodeId));
    }
  }

  clearSelection(): void {
    if (this.selectedNodeIds.size === 0) {
      return;
    }
    this.selectedNodeIds.clear();
    this.refreshNodeSelectionClasses();
    this.notifySelectionChanged();
  }

  consumeSuppressedCanvasClick(): boolean {
    if (!this.suppressNextCanvasClick) {
      return false;
    }
    this.suppressNextCanvasClick = false;
    return true;
  }

  private graphPointFromClient(clientX: number, clientY: number): GraphPoint | null {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return null;
    }

    const rect = viewport.getBoundingClientRect();
    const zoom = this.graphZoom || 1;
    return {
      x: (viewport.scrollLeft + clientX - rect.left) / zoom,
      y: (viewport.scrollTop + clientY - rect.top) / zoom,
    };
  }

  startMarqueeSelection(startEvent: PointerEvent): void {
    if (this.host.isBusy() || !this.host.getCurrentProject() || !this.graphViewportEl || !this.graphMarqueeEl) {
      return;
    }

    if (startEvent.button !== 0) {
      return;
    }

    startEvent.preventDefault();
    const viewport = this.graphViewportEl;
    const marquee = this.graphMarqueeEl;
    const pointerId = startEvent.pointerId;
    const additive = startEvent.shiftKey || startEvent.metaKey || startEvent.ctrlKey;
    const baselineSelection = additive ? new Set(this.selectedNodeIds) : new Set<string>();
    const startGraph = this.graphPointFromClient(startEvent.clientX, startEvent.clientY);
    if (!startGraph) {
      return;
    }

    let lastClientX = startEvent.clientX;
    let lastClientY = startEvent.clientY;

    if (typeof viewport.setPointerCapture === "function") {
      try {
        viewport.setPointerCapture(pointerId);
      } catch {
        // Pointer capture can fail in some environments; window listeners are fallback.
      }
    }

    const updateSelection = (clientX: number, clientY: number): void => {
      lastClientX = clientX;
      lastClientY = clientY;

      const currentGraph = this.graphPointFromClient(clientX, clientY);
      if (!currentGraph) {
        return;
      }

      const x1 = Math.min(startGraph.x, currentGraph.x);
      const y1 = Math.min(startGraph.y, currentGraph.y);
      const x2 = Math.max(startGraph.x, currentGraph.x);
      const y2 = Math.max(startGraph.y, currentGraph.y);
      const zoom = this.graphZoom || 1;

      marquee.classList.add("is-active");
      // Marquee is rendered inside the scrollable viewport content layer, so
      // coordinates must stay in content-space (do not subtract scroll offsets).
      marquee.style.left = `${x1 * zoom}px`;
      marquee.style.top = `${y1 * zoom}px`;
      marquee.style.width = `${(x2 - x1) * zoom}px`;
      marquee.style.height = `${(y2 - y1) * zoom}px`;

      const marqueeSelected = new Set<string>();
      const project = this.host.getCurrentProject();
      if (!project) {
        return;
      }
      for (const node of project.graph.nodes) {
        const nodeEl = this.nodeElsById.get(node.id);
        const nodeHeight = Math.max(80, nodeEl?.offsetHeight || 164);
        const nodeWidth = Math.max(
          120,
          nodeEl?.offsetWidth || resolveStudioGraphNodeWidth(node)
        );
        const nodeX1 = node.position.x;
        const nodeY1 = node.position.y;
        const nodeX2 = nodeX1 + nodeWidth;
        const nodeY2 = nodeY1 + nodeHeight;
        const intersects = nodeX1 <= x2 && nodeX2 >= x1 && nodeY1 <= y2 && nodeY2 >= y1;
        if (intersects) {
          marqueeSelected.add(node.id);
        }
      }

      const nextSelection = additive
        ? new Set<string>([...baselineSelection, ...marqueeSelected])
        : marqueeSelected;
      this.selectedNodeIds = nextSelection;
      this.refreshNodeSelectionClasses();
    };

    const finishSelection = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) {
        return;
      }

      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishSelection);
      window.removeEventListener("pointercancel", finishSelection);
      marquee.classList.remove("is-active");
      marquee.style.width = "0px";
      marquee.style.height = "0px";

      if (typeof viewport.releasePointerCapture === "function") {
        try {
          viewport.releasePointerCapture(pointerId);
        } catch {
          // Ignore release errors; listeners are detached already.
        }
      }

      const movedDistance = Math.hypot(lastClientX - startEvent.clientX, lastClientY - startEvent.clientY);
      if (movedDistance > 3) {
        this.suppressNextCanvasClick = true;
      } else if (!additive) {
        this.selectedNodeIds.clear();
        this.refreshNodeSelectionClasses();
      }
      this.notifySelectionChanged();
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      updateSelection(moveEvent.clientX, moveEvent.clientY);
    };

    updateSelection(startEvent.clientX, startEvent.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishSelection);
    window.addEventListener("pointercancel", finishSelection);
  }

  private clampGraphZoom(value: number): number {
    if (!Number.isFinite(value)) {
      return this.graphZoom;
    }
    return Math.min(STUDIO_GRAPH_MAX_ZOOM, Math.max(STUDIO_GRAPH_MIN_ZOOM, value));
  }

  applyGraphZoom(): void {
    const zoom = this.clampGraphZoom(this.graphZoom);
    this.graphZoom = zoom;
    this.syncCanvasBounds();
    if (!this.graphCanvasEl || !this.graphSurfaceEl) {
      return;
    }
    this.graphCanvasEl.style.transform = `scale(${zoom})`;
    this.graphCanvasEl.style.transformOrigin = "0 0";
    this.syncGraphSurfaceSize();
    if (this.graphZoomLabelEl) {
      this.graphZoomLabelEl.setText(`${Math.round(zoom * 100)}%`);
    }
    this.host.onGraphZoomChanged?.(zoom);
    this.host.renderEdgeLayer();
  }

  private zoomGraphAtClientPoint(nextZoom: number, clientX: number, clientY: number): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }

    const previousZoom = this.graphZoom;
    const clampedNextZoom = this.clampGraphZoom(nextZoom);
    if (Math.abs(clampedNextZoom - previousZoom) < 0.0001) {
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const localX = clientX - viewportRect.left;
    const localY = clientY - viewportRect.top;
    const graphX = (viewport.scrollLeft + localX) / previousZoom;
    const graphY = (viewport.scrollTop + localY) / previousZoom;

    this.graphZoom = clampedNextZoom;
    this.applyGraphZoom();

    viewport.scrollLeft = graphX * clampedNextZoom - localX;
    viewport.scrollTop = graphY * clampedNextZoom - localY;
  }

  private normalizeWheelDelta(delta: number, deltaMode: number, viewport: HTMLElement): number {
    if (!Number.isFinite(delta) || delta === 0) {
      return 0;
    }
    if (deltaMode === WHEEL_DOM_DELTA_LINE) {
      return delta * 16;
    }
    if (deltaMode === WHEEL_DOM_DELTA_PAGE) {
      return delta * Math.max(1, viewport.clientHeight);
    }
    return delta;
  }

  private shouldDeferWheelToOverlay(event: WheelEvent): boolean {
    return shouldStudioGraphDeferWheelToNativeScroll(event.target);
  }

  handleGraphViewportWheel(event: WheelEvent): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }

    if (this.shouldDeferWheelToOverlay(event)) {
      return;
    }

    const shouldZoom = event.ctrlKey || event.metaKey;
    if (shouldZoom) {
      event.preventDefault();
      const scaleFactor = Math.exp(-event.deltaY * 0.0025);
      this.zoomGraphAtClientPoint(this.graphZoom * scaleFactor, event.clientX, event.clientY);
      return;
    }

    const deltaX = this.normalizeWheelDelta(event.deltaX, event.deltaMode, viewport);
    const deltaY = this.normalizeWheelDelta(event.deltaY, event.deltaMode, viewport);
    if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) {
      return;
    }

    event.preventDefault();
    viewport.scrollLeft += deltaX;
    viewport.scrollTop += deltaY;
  }

  private findNode(project: StudioProjectV1, nodeId: string): StudioNodeInstance | null {
    return project.graph.nodes.find((node) => node.id === nodeId) || null;
  }

  private updateNodePosition(nodeId: string): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }

    const node = this.findNode(project, nodeId);
    const element = this.nodeElsById.get(nodeId);
    if (!node || !element) {
      return;
    }

    element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
  }

  startNodeDrag(nodeId: string, startEvent: PointerEvent, dragSurfaceEl: HTMLElement): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }
    const dragSourceNode = this.findNode(project, nodeId);
    const canDragWhileBusy = dragSourceNode ? isManagedOutputPlaceholderNode(dragSourceNode) : false;
    if (this.host.isBusy() && !canDragWhileBusy) {
      return;
    }

    if (startEvent.button !== 0) {
      return;
    }

    const shouldDragSelection = this.selectedNodeIds.has(nodeId) && this.selectedNodeIds.size > 0;
    let selectionChangedOnPointerDown = false;
    if (!shouldDragSelection) {
      this.selectedNodeIds = new Set([nodeId]);
      this.refreshNodeSelectionClasses();
      selectionChangedOnPointerDown = true;
    }

    const dragNodeIds = shouldDragSelection ? Array.from(this.selectedNodeIds) : [nodeId];
    const dragNodes = new Map<string, StudioNodeInstance>();
    const originByNodeId = new Map<string, GraphPoint>();
    for (const dragNodeId of dragNodeIds) {
      const dragNode = this.findNode(project, dragNodeId);
      if (!dragNode) continue;
      dragNodes.set(dragNodeId, dragNode);
      originByNodeId.set(dragNodeId, {
        x: dragNode.position.x,
        y: dragNode.position.y,
      });
    }

    if (dragNodes.size === 0) {
      return;
    }

    startEvent.preventDefault();

    const pointerId = startEvent.pointerId;
    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    const zoom = this.graphZoom || 1;
    let dragged = false;
    let hoveredGroupId: string | null = null;
    const syncHoveredGroup = (): void => {
      const nextGroupId = this.host.resolveNodeDragHoverGroup?.(dragNodeIds) || null;
      if (nextGroupId === hoveredGroupId) {
        return;
      }
      hoveredGroupId = nextGroupId;
      this.host.onNodeDragHoverGroupChange?.(hoveredGroupId, dragNodeIds);
    };
    if (typeof dragSurfaceEl.setPointerCapture === "function") {
      try {
        dragSurfaceEl.setPointerCapture(pointerId);
      } catch {
        // Ignore capture errors and keep window listeners as fallback.
      }
    }

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const travel = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragged && travel > 3) {
        dragged = true;
        this.host.onNodeDragStateChange?.(true);
        syncHoveredGroup();
      }
      if (!dragged) {
        return;
      }

      const deltaX = (moveEvent.clientX - startX) / zoom;
      const deltaY = (moveEvent.clientY - startY) / zoom;
      for (const [dragNodeId, dragNode] of dragNodes.entries()) {
        const origin = originByNodeId.get(dragNodeId);
        if (!origin) continue;
        dragNode.position.x = Math.max(24, Math.round(origin.x + deltaX));
        dragNode.position.y = Math.max(24, Math.round(origin.y + deltaY));
        this.updateNodePosition(dragNodeId);
      }
      this.notifyNodePositionsChanged();
      syncHoveredGroup();
    };

    const finishDrag = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) {
        return;
      }

      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      if (typeof dragSurfaceEl.releasePointerCapture === "function") {
        try {
          dragSurfaceEl.releasePointerCapture(pointerId);
        } catch {
          // Ignore release errors; drag listeners are already detached.
        }
      }
      if (dragged) {
        this.host.onNodeDragStateChange?.(false);
        this.host.onNodeDropToGroup?.(hoveredGroupId, dragNodeIds);
        hoveredGroupId = null;
        this.host.onNodeDragHoverGroupChange?.(null, dragNodeIds);
        this.host.scheduleProjectSave();
        return;
      }

      if (selectionChangedOnPointerDown || this.selectedNodeIds.has(nodeId)) {
        this.notifySelectionChanged();
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  }

  toggleNodeSelection(nodeId: string): void {
    if (this.selectedNodeIds.has(nodeId)) {
      this.selectedNodeIds.delete(nodeId);
    } else {
      this.selectedNodeIds.add(nodeId);
    }
    this.refreshNodeSelectionClasses();
    this.notifySelectionChanged();
  }

  ensureSingleSelection(nodeId: string): void {
    if (!this.selectedNodeIds.has(nodeId) || this.selectedNodeIds.size !== 1) {
      this.selectedNodeIds = new Set([nodeId]);
      this.refreshNodeSelectionClasses();
      this.notifySelectionChanged();
    }
  }

  private notifySelectionChanged(): void {
    try {
      this.onSelectionChange?.();
    } catch {
      // Selection updates must never break graph interactions.
    }
  }

  private syncGraphSurfaceSize(): void {
    if (!this.graphSurfaceEl) {
      return;
    }
    const zoom = this.graphZoom || 1;
    this.graphSurfaceEl.style.width = `${Math.round(this.graphCanvasWidth * zoom)}px`;
    this.graphSurfaceEl.style.height = `${Math.round(this.graphCanvasHeight * zoom)}px`;
  }

  private syncCanvasBounds(options?: { force?: boolean }): boolean {
    const project = this.host.getCurrentProject();
    const nextSize = computeStudioGraphCanvasSize(project, {
      minWidth: STUDIO_GRAPH_CANVAS_WIDTH,
      minHeight: STUDIO_GRAPH_CANVAS_HEIGHT,
      maxWidth: STUDIO_GRAPH_CANVAS_MAX_WIDTH,
      maxHeight: STUDIO_GRAPH_CANVAS_MAX_HEIGHT,
      getNodeWidth: (nodeId) => {
        const project = this.host.getCurrentProject();
        if (!project) {
          return null;
        }
        const node = project.graph.nodes.find((entry) => entry.id === nodeId);
        const nodeEl = this.nodeElsById.get(nodeId);
        if (!node) {
          return nodeEl ? Math.max(120, nodeEl.offsetWidth || 280) : null;
        }
        return Math.max(120, nodeEl?.offsetWidth || resolveStudioGraphNodeWidth(node));
      },
      getNodeHeight: (nodeId) => {
        const nodeEl = this.nodeElsById.get(nodeId);
        if (!nodeEl) {
          return null;
        }
        return Math.max(80, nodeEl.offsetHeight || 164);
      },
    });

    const changed =
      options?.force === true ||
      this.graphCanvasWidth !== nextSize.width ||
      this.graphCanvasHeight !== nextSize.height;
    if (!changed) {
      return false;
    }

    this.graphCanvasWidth = nextSize.width;
    this.graphCanvasHeight = nextSize.height;

    if (this.graphCanvasEl) {
      this.graphCanvasEl.style.width = `${this.graphCanvasWidth}px`;
      this.graphCanvasEl.style.height = `${this.graphCanvasHeight}px`;
    }
    if (this.graphEdgesLayerEl) {
      this.graphEdgesLayerEl.setAttribute("viewBox", `0 0 ${this.graphCanvasWidth} ${this.graphCanvasHeight}`);
      this.graphEdgesLayerEl.setAttribute("width", String(this.graphCanvasWidth));
      this.graphEdgesLayerEl.setAttribute("height", String(this.graphCanvasHeight));
    }

    return true;
  }
}
