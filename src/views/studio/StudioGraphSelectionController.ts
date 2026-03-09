import type { StudioNodeInstance, StudioProjectV1 } from "../../studio/types";
import {
  STUDIO_GRAPH_CANVAS_HEIGHT,
  STUDIO_GRAPH_CANVAS_WIDTH,
  STUDIO_GRAPH_DEFAULT_ZOOM,
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
  STUDIO_GRAPH_OVERVIEW_MIN_ZOOM,
  type StudioGraphZoomChangeContext,
  type StudioGraphZoomMode,
} from "./StudioGraphInteractionTypes";
import {
  computeStudioGraphCanvasSize,
  STUDIO_GRAPH_CANVAS_MAX_HEIGHT,
  STUDIO_GRAPH_CANVAS_MAX_WIDTH,
} from "./graph-v3/StudioGraphCanvasBounds";
import { resolveStudioGraphNodeWidth } from "./graph-v3/StudioGraphNodeGeometry";
import {
  isStudioGraphEditableFieldActive,
  isStudioGraphTerminalInteractiveTarget,
  shouldStudioGraphDeferWheelToNativeScroll,
} from "./StudioGraphDomTargeting";

type GraphPoint = {
  x: number;
  y: number;
};

type GraphBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const WHEEL_DOM_DELTA_LINE =
  typeof WheelEvent !== "undefined" ? WheelEvent.DOM_DELTA_LINE : 1;
const WHEEL_DOM_DELTA_PAGE =
  typeof WheelEvent !== "undefined" ? WheelEvent.DOM_DELTA_PAGE : 2;
const STUDIO_GRAPH_SELECTION_FIT_PADDING_PX = 25;
const STUDIO_GRAPH_NODE_MIN_HEIGHT_PX = 80;
const STUDIO_GRAPH_NODE_FALLBACK_HEIGHT_PX = 164;
const STUDIO_GRAPH_ZOOM_SETTLE_DELAY_MS = 160;
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
  onGraphZoomChanged?: (zoom: number, context: StudioGraphZoomChangeContext) => void;
};

type NotifyNodePositionsChangedOptions = {
  recomputeCanvasBounds?: boolean;
};

export class StudioGraphSelectionController {
  private graphZoom = STUDIO_GRAPH_DEFAULT_ZOOM;
  private graphZoomMode: StudioGraphZoomMode = "interactive";
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
  private zoomSettleTimer: number | null = null;

  constructor(private readonly host: StudioGraphSelectionHost) {}

  getGraphZoom(): number {
    return this.graphZoom;
  }

  getGraphZoomMode(): StudioGraphZoomMode {
    return this.graphZoomMode;
  }

  setGraphZoom(
    nextZoom: number,
    options?: {
      mode?: StudioGraphZoomMode;
      settled?: boolean;
      scheduleSettle?: boolean;
    }
  ): void {
    const mode = options?.mode ?? "interactive";
    this.graphZoomMode = mode;
    this.graphZoom = this.clampGraphZoom(nextZoom, mode);
    const settled = options?.settled !== false;
    if (settled) {
      this.cancelScheduledGraphZoomSettle();
    }
    this.applyGraphZoom({ settled });
    if (options?.scheduleSettle) {
      this.scheduleSettledGraphZoom();
    }
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
    this.cancelScheduledGraphZoomSettle();
    this.graphZoomMode = "interactive";
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
    this.cancelScheduledGraphZoomSettle();
    this.graphZoomMode = "interactive";
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

  notifyNodePositionsChanged(options?: NotifyNodePositionsChangedOptions): void {
    const shouldRecomputeCanvasBounds = options?.recomputeCanvasBounds !== false;
    if (shouldRecomputeCanvasBounds && this.syncCanvasBounds()) {
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

  fitSelectionInViewport(options?: { paddingPx?: number }): boolean {
    const viewport = this.graphViewportEl;
    const project = this.host.getCurrentProject();
    if (!viewport || !project || this.selectedNodeIds.size === 0) {
      return false;
    }

    const selectionBounds = this.computeNodeBounds(project, this.selectedNodeIds);
    if (!selectionBounds) {
      return false;
    }

    return this.fitBoundsInViewport(selectionBounds, {
      mode: "interactive",
      paddingPx: options?.paddingPx,
    });
  }

  fitGraphInViewport(options?: { paddingPx?: number }): boolean {
    const project = this.host.getCurrentProject();
    if (!this.graphViewportEl || !project || project.graph.nodes.length === 0) {
      return false;
    }

    const graphBounds = this.computeNodeBounds(project);
    if (!graphBounds) {
      return false;
    }

    return this.fitBoundsInViewport(graphBounds, {
      mode: "overview",
      paddingPx: options?.paddingPx,
    });
  }

  private fitBoundsInViewport(
    bounds: GraphBounds,
    options?: {
      paddingPx?: number;
      mode?: StudioGraphZoomMode;
    }
  ): boolean {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return false;
    }

    const requestedPadding = options?.paddingPx;
    const paddingPx = Number.isFinite(requestedPadding)
      ? Math.max(0, requestedPadding as number)
      : STUDIO_GRAPH_SELECTION_FIT_PADDING_PX;
    const viewportWidth = Math.max(1, viewport.clientWidth || 0);
    const viewportHeight = Math.max(1, viewport.clientHeight || 0);
    const availableWidth = Math.max(1, viewportWidth - paddingPx * 2);
    const availableHeight = Math.max(1, viewportHeight - paddingPx * 2);
    const selectionWidth = Math.max(1, bounds.right - bounds.left);
    const selectionHeight = Math.max(1, bounds.bottom - bounds.top);
    const requestedMode = options?.mode ?? "interactive";
    const rawTargetZoom = Math.min(availableWidth / selectionWidth, availableHeight / selectionHeight);
    const appliedMode =
      requestedMode === "overview" && rawTargetZoom < STUDIO_GRAPH_MIN_ZOOM ? "overview" : "interactive";
    const targetZoom = this.clampGraphZoom(rawTargetZoom, appliedMode);

    this.cancelScheduledGraphZoomSettle();
    this.graphZoomMode = appliedMode;
    this.graphZoom = targetZoom;
    this.applyGraphZoom({ settled: false, notifyHost: false });

    const centerX = (bounds.left + bounds.right) * 0.5;
    const centerY = (bounds.top + bounds.bottom) * 0.5;
    viewport.scrollLeft = centerX * targetZoom - viewportWidth * 0.5;
    viewport.scrollTop = centerY * targetZoom - viewportHeight * 0.5;
    this.applyGraphZoom({ settled: true });
    return true;
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

  private computeNodeBounds(project: StudioProjectV1, nodeIds?: Iterable<string>): GraphBounds | null {
    const nodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
    const nodes = nodeIds
      ? Array.from(nodeIds)
        .map((nodeId) => nodeById.get(nodeId))
        .filter((node): node is StudioNodeInstance => Boolean(node))
      : project.graph.nodes;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    for (const node of nodes) {
      if (!node.position) {
        continue;
      }
      const nodeX = Number(node.position.x);
      const nodeY = Number(node.position.y);
      if (!Number.isFinite(nodeX) || !Number.isFinite(nodeY)) {
        continue;
      }

      const nodeEl = this.nodeElsById.get(node.id);
      const measuredWidth = nodeEl?.offsetWidth;
      const measuredHeight = nodeEl?.offsetHeight;
      const nodeWidth = Math.max(
        120,
        measuredWidth && measuredWidth > 0 ? measuredWidth : resolveStudioGraphNodeWidth(node)
      );
      const nodeHeight = Math.max(
        STUDIO_GRAPH_NODE_MIN_HEIGHT_PX,
        measuredHeight && measuredHeight > 0 ? measuredHeight : STUDIO_GRAPH_NODE_FALLBACK_HEIGHT_PX
      );

      left = Math.min(left, nodeX);
      top = Math.min(top, nodeY);
      right = Math.max(right, nodeX + nodeWidth);
      bottom = Math.max(bottom, nodeY + nodeHeight);
    }

    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(right) ||
      !Number.isFinite(bottom)
    ) {
      return null;
    }
    return { left, top, right, bottom };
  }

  startMarqueeSelection(startEvent: PointerEvent): void {
    if (this.graphZoomMode === "overview") {
      return;
    }
    if (!this.host.getCurrentProject() || !this.graphViewportEl || !this.graphMarqueeEl) {
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
    let pendingClientX = startEvent.clientX;
    let pendingClientY = startEvent.clientY;
    let selectionFrameRequested = false;

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

    const flushSelectionFrame = (): void => {
      selectionFrameRequested = false;
      updateSelection(pendingClientX, pendingClientY);
    };

    const scheduleSelectionFrame = (): void => {
      if (selectionFrameRequested) {
        return;
      }
      selectionFrameRequested = true;
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(flushSelectionFrame);
        return;
      }
      flushSelectionFrame();
    };

    const finishSelection = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) {
        return;
      }

      if (selectionFrameRequested) {
        flushSelectionFrame();
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
      const latestEvent = this.resolveLatestPointerEvent(moveEvent);
      pendingClientX = latestEvent.clientX;
      pendingClientY = latestEvent.clientY;
      scheduleSelectionFrame();
    };

    updateSelection(startEvent.clientX, startEvent.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishSelection);
    window.addEventListener("pointercancel", finishSelection);
  }

  private clampGraphZoom(value: number, mode: StudioGraphZoomMode = this.graphZoomMode): number {
    if (!Number.isFinite(value)) {
      return this.graphZoom;
    }
    const minZoom = mode === "overview" ? STUDIO_GRAPH_OVERVIEW_MIN_ZOOM : STUDIO_GRAPH_MIN_ZOOM;
    return Math.min(STUDIO_GRAPH_MAX_ZOOM, Math.max(minZoom, value));
  }

  applyGraphZoom(options?: {
    settled?: boolean;
    notifyHost?: boolean;
  }): void {
    const settled = options?.settled !== false;
    const zoom = this.clampGraphZoom(this.graphZoom, this.graphZoomMode);
    this.graphZoom = zoom;
    if (!this.graphCanvasEl || !this.graphSurfaceEl) {
      return;
    }
    this.graphCanvasEl.style.transform = `scale(${zoom})`;
    this.graphCanvasEl.style.transformOrigin = "0 0";
    this.syncGraphSurfaceSize();
    if (this.graphZoomLabelEl) {
      this.graphZoomLabelEl.setText(`${Math.round(zoom * 100)}%`);
    }
    if (options?.notifyHost !== false) {
      this.host.onGraphZoomChanged?.(zoom, {
        mode: this.graphZoomMode,
        settled,
      });
    }
    if (settled) {
      this.host.renderEdgeLayer();
    }
  }

  private scheduleSettledGraphZoom(): void {
    this.cancelScheduledGraphZoomSettle();
    this.zoomSettleTimer = window.setTimeout(() => {
      this.zoomSettleTimer = null;
      this.applyGraphZoom({ settled: true });
    }, STUDIO_GRAPH_ZOOM_SETTLE_DELAY_MS);
  }

  private cancelScheduledGraphZoomSettle(): void {
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
    }
  }

  private zoomGraphAtClientPoint(
    nextZoom: number,
    clientX: number,
    clientY: number,
    options?: {
      mode?: StudioGraphZoomMode;
      settled?: boolean;
      scheduleSettle?: boolean;
    }
  ): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }

    const mode = options?.mode ?? "interactive";
    const previousZoom = this.graphZoom;
    const clampedNextZoom = this.clampGraphZoom(nextZoom, mode);
    if (Math.abs(clampedNextZoom - previousZoom) < 0.0001 && this.graphZoomMode === mode) {
      if (options?.scheduleSettle) {
        this.scheduleSettledGraphZoom();
      }
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const localX = clientX - viewportRect.left;
    const localY = clientY - viewportRect.top;
    const graphX = (viewport.scrollLeft + localX) / previousZoom;
    const graphY = (viewport.scrollTop + localY) / previousZoom;

    const settled = options?.settled !== false;
    if (settled) {
      this.cancelScheduledGraphZoomSettle();
    }
    this.graphZoomMode = mode;
    this.graphZoom = clampedNextZoom;
    this.applyGraphZoom({ settled });

    viewport.scrollLeft = graphX * clampedNextZoom - localX;
    viewport.scrollTop = graphY * clampedNextZoom - localY;
    if (options?.scheduleSettle) {
      this.scheduleSettledGraphZoom();
    }
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

    const shouldZoom = event.ctrlKey || event.metaKey;
    if (shouldZoom) {
      event.preventDefault();
      const scaleFactor = Math.exp(-event.deltaY * 0.0025);
      this.zoomGraphAtClientPoint(this.graphZoom * scaleFactor, event.clientX, event.clientY, {
        mode: "interactive",
        settled: false,
        scheduleSettle: true,
      });
      return;
    }

    if (this.shouldDeferWheelToOverlay(event) || isStudioGraphEditableFieldActive(event.target)) {
      return;
    }
    if (isStudioGraphTerminalInteractiveTarget(event.target)) {
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
    if (this.graphZoomMode === "overview") {
      return;
    }
    const project = this.host.getCurrentProject();
    if (!project) {
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
    let pendingClientX = startX;
    let pendingClientY = startY;
    let dragFrameRequested = false;
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

    const flushDragFrame = (): void => {
      dragFrameRequested = false;
      const travel = Math.hypot(pendingClientX - startX, pendingClientY - startY);
      if (!dragged && travel > 3) {
        dragged = true;
        this.host.onNodeDragStateChange?.(true);
        syncHoveredGroup();
      }
      if (!dragged) {
        return;
      }

      const deltaX = (pendingClientX - startX) / zoom;
      const deltaY = (pendingClientY - startY) / zoom;
      for (const [dragNodeId, dragNode] of dragNodes.entries()) {
        const origin = originByNodeId.get(dragNodeId);
        if (!origin) continue;
        dragNode.position.x = Math.max(24, Math.round(origin.x + deltaX));
        dragNode.position.y = Math.max(24, Math.round(origin.y + deltaY));
        this.updateNodePosition(dragNodeId);
      }
      this.notifyNodePositionsChanged({ recomputeCanvasBounds: false });
      syncHoveredGroup();
    };

    const scheduleDragFrame = (): void => {
      if (dragFrameRequested) {
        return;
      }
      dragFrameRequested = true;
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(flushDragFrame);
        return;
      }
      flushDragFrame();
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const latestEvent = this.resolveLatestPointerEvent(moveEvent);
      pendingClientX = latestEvent.clientX;
      pendingClientY = latestEvent.clientY;
      scheduleDragFrame();
    };

    const finishDrag = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) {
        return;
      }

      if (dragFrameRequested) {
        flushDragFrame();
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
        this.notifyNodePositionsChanged();
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

  private resolveLatestPointerEvent(event: PointerEvent): PointerEvent {
    if (typeof event.getCoalescedEvents === "function") {
      const coalescedEvents = event.getCoalescedEvents();
      if (Array.isArray(coalescedEvents) && coalescedEvents.length > 0) {
        return coalescedEvents[coalescedEvents.length - 1] as PointerEvent;
      }
    }
    return event;
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
    const nodeById = project
      ? new Map(project.graph.nodes.map((node) => [node.id, node] as const))
      : new Map<string, StudioNodeInstance>();
    const nextSize = computeStudioGraphCanvasSize(project, {
      minWidth: STUDIO_GRAPH_CANVAS_WIDTH,
      minHeight: STUDIO_GRAPH_CANVAS_HEIGHT,
      maxWidth: STUDIO_GRAPH_CANVAS_MAX_WIDTH,
      maxHeight: STUDIO_GRAPH_CANVAS_MAX_HEIGHT,
      getNodeWidth: (nodeId) => {
        const node = nodeById.get(nodeId);
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
