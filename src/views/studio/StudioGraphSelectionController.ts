import { StudioCanvasSelection } from "./StudioCanvasSelection";
import { createStudioMovementSnap, STUDIO_ALIGNMENT_SNAP_THRESHOLD_PX, type StudioMovementSnap } from "./canvas/StudioGraphAlignmentGuides";
import { latestStudioPointerEvent, startStudioPointerGesture } from "./StudioPointerGesture";
import type { StudioProjectSessionMutationReason } from "../../studio/StudioProjectSession";
import type { StudioNodeInstance, StudioProjectV1 } from "../../studio/types";
import {
  STUDIO_GRAPH_DEFAULT_ZOOM,
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
  STUDIO_GRAPH_OVERVIEW_MIN_ZOOM,
  type NotifyNodePositionsChangedOptions,
  type StudioGraphProjectMutationOptions,
  type StudioGraphZoomChangeContext,
  type StudioGraphZoomMode,
} from "./StudioGraphInteractionTypes";
import {
  computeStudioWorldExtent,
  type StudioWorldExtent,
  type StudioWorldRect,
} from "./canvas/StudioGraphWorldExtent";
import {
  resolveStudioCanvasDelta,
  resolveStudioGraphSafeZoom,
} from "../../studio/StudioNodeGeometry";
import {
  resolveStudioResizeGuides,
  resolveStudioMovementGuides,
  STUDIO_GUIDE_THRESHOLD_PX,
  type StudioGuideRect,
  type StudioAlignmentGuides,
} from "./canvas/StudioGraphAlignmentGuides";
import { renderStudioGraphAlignmentGuidesLayer } from "./canvas/StudioGraphAlignmentGuidesOverlay";
import {
  isStudioGraphEditableFieldActive,
  shouldStudioGraphDeferWheelToNativeScroll,
} from "./StudioGraphDomTargeting";
import { getStudioOwnerWindow } from "./StudioDomContext";
import { StudioCanvasGeometry } from "./canvas/StudioCanvasGeometry";

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
const STUDIO_GRAPH_FALLBACK_VIEWPORT_WIDTH = 1200;
const STUDIO_GRAPH_FALLBACK_VIEWPORT_HEIGHT = 800;
const STUDIO_GRAPH_ZOOM_SETTLE_DELAY_MS = 160;
type StudioGraphSelectionHost = {
  isBusy: () => boolean;
  getCurrentProject: () => StudioProjectV1 | null;
  renderEdgeLayer: (options?: { translating?: boolean }) => void;
  onNodePositionsChanged?: (options?: NotifyNodePositionsChangedOptions) => void;
  commitProjectMutation: (
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => boolean | void,
    options?: StudioGraphProjectMutationOptions
  ) => boolean;
  onNodeDragStateChange?: (isDragging: boolean) => void;
  resolveNodeDragHoverGroup?: (draggedNodeIds: string[]) => string | null;
  onNodeDragHoverGroupChange?: (groupId: string | null, draggedNodeIds: string[]) => void;
  onNodeDropToGroup?: (groupId: string | null, draggedNodeIds: string[]) => void;
  onGraphZoomChanged?: (zoom: number, context: StudioGraphZoomChangeContext) => void;
  /**
   * The diagram layer's half of the one canvas selection: a marquee sweeps
   * shapes with nodes, and a node drag carries the selected shapes along.
   */
  beginDiagramMarquee?: () => void;
  selectDiagramInBounds?: (bounds: GraphBounds, additive: boolean) => void;
  getSelectedShapeIds?: () => string[];
  beginDiagramTranslation?: () => void;
  translateDiagramSelection?: (project: StudioProjectV1, delta: GraphPoint) => boolean;
  previewDiagramTranslation?: () => void;
  finishDiagramTranslation?: () => void;
};


export class StudioGraphSelectionController {
  readonly geometry: StudioCanvasGeometry;
  private movementTargets: {
    revision: number;
    nodeIds: readonly string[];
    shapeIds: readonly string[];
    others: StudioGuideRect[];
  } | null = null;
  private resizeTargets: { revision: number; nodeId: string; others: StudioGuideRect[] } | null = null;
  private graphZoom = STUDIO_GRAPH_DEFAULT_ZOOM;
  private graphZoomMode: StudioGraphZoomMode = "interactive";
  /**
   * The scroll box's coverage in world px. The world origin sits at
   * (-left, -top) inside the box: `box px = world px + origin`. Grows in
   * viewport-sized chunks as the view or content approaches an edge, so the
   * canvas feels infinite while the DOM stays a few screens large.
   */
  private worldExtent: StudioWorldExtent | null = null;
  private graphWorldEl: HTMLElement | null = null;
  private graphViewportEl: HTMLElement | null = null;
  private graphSurfaceEl: HTMLElement | null = null;
  private graphMarqueeEl: HTMLElement | null = null;
  private alignmentGuidesEl: HTMLElement | null = null;
  private alignmentGuideResult: StudioAlignmentGuides | null = null;
  private alignmentGuideMovingRect: StudioGuideRect | null = null;
  private graphZoomLabelEl: HTMLElement | null = null;
  private graphCanvasEl: HTMLElement | null = null;
  private graphEdgesLayerEl: SVGSVGElement | null = null;
  private graphOwnerWindow: Window | null = null;
  private viewportResizeObserver: ResizeObserver | null = null;
  private viewportWorldTopLeft: GraphPoint = { x: 0, y: 0 };
  private viewportPositionNeedsRestore = false;
  private get selectedNodeIds(): ReadonlySet<string> { return this.selection.ids("node"); }
  private set selectedNodeIds(ids: ReadonlySet<string>) { this.selection.replace("node", ids); }
  private nodeTranslationOrigins = new Map<string, GraphPoint>();
  private suppressNextCanvasClick = false;
  private onSelectionChange: (() => void) | null = null;
  private zoomSettleTimer: number | null = null;
  private zoomSettleWindow: Window | null = null;
  private cancelPointerGesture: (() => void) | null = null;

  constructor(
    private readonly host: StudioGraphSelectionHost,
    private readonly selection = new StudioCanvasSelection()
  ) {
    this.selection.subscribe(() => this.refreshNodeSelectionClasses());
    this.geometry = new StudioCanvasGeometry(() => this.host.getCurrentProject(), (nodeId) => {
      this.retainMovingGuideTargets([nodeId], this.geometry.revision - 1);
      this.ensureWorldCoverage();
      this.host.renderEdgeLayer();
      this.host.onNodePositionsChanged?.({ nodeIds: [nodeId] });
    });
  }

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
    this.cancelPointerGesture?.();
    const hadSelection = this.selectedNodeIds.size > 0;
    this.selection.clear("node");
    this.cancelScheduledGraphZoomSettle();
    this.graphZoomMode = "interactive";
    if (hadSelection) {
      this.notifySelectionChanged();
    }
  }

  clearRenderBindings(): void {
    this.cancelPointerGesture?.();
    this.cancelScheduledGraphZoomSettle();
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.viewportWorldTopLeft = { x: 0, y: 0 };
    this.viewportPositionNeedsRestore = false;
    this.graphViewportEl = null;
    this.graphSurfaceEl = null;
    this.graphMarqueeEl = null;
    this.alignmentGuidesEl = null;
    this.alignmentGuideResult = null;
    this.alignmentGuideMovingRect = null;
    this.graphZoomLabelEl = null;
    this.graphCanvasEl = null;
    this.graphWorldEl = null;
    this.graphEdgesLayerEl = null;
    this.graphOwnerWindow = null;
    this.worldExtent = null;
    this.suppressNextCanvasClick = false;
    this.clearNodeElements();
  }

  onNodeRemoved(nodeId: string): void {
    if (this.selectedNodeIds.has(nodeId)) {
      this.selection.remove("node", nodeId);
      this.notifySelectionChanged();
    }
  }

  registerViewportElement(viewport: HTMLElement): void {
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.graphViewportEl = viewport;
    this.graphOwnerWindow = getStudioOwnerWindow(viewport);
    const Observer = (this.graphOwnerWindow as Window & {
      ResizeObserver?: typeof ResizeObserver;
    }).ResizeObserver;
    if (Observer) {
      this.viewportResizeObserver = new Observer(() => {
        if (this.graphViewportEl === viewport) {
          this.getViewportWorldRect();
        }
      });
      this.viewportResizeObserver.observe(viewport);
    }
  }

  registerSurfaceElement(surface: HTMLElement): void {
    this.graphSurfaceEl = surface;
  }

  registerMarqueeElement(marquee: HTMLElement): void {
    this.graphMarqueeEl = marquee;
  }

  registerAlignmentGuidesElement(layer: HTMLElement): void {
    this.alignmentGuidesEl = layer;
  }

  registerZoomLabelElement(label: HTMLElement): void {
    this.graphZoomLabelEl = label;
  }

  registerCanvasElement(canvas: HTMLElement, world?: HTMLElement): void {
    this.graphCanvasEl = canvas;
    this.graphWorldEl = world ?? null;
    this.graphOwnerWindow = getStudioOwnerWindow(canvas);
    this.ensureWorldCoverage();
    this.syncWorldGeometry();
  }

  registerEdgesLayerElement(layer: SVGSVGElement): void {
    this.graphEdgesLayerEl = layer;
    this.syncWorldGeometry();
  }

  notifyNodePositionsChanged(options?: NotifyNodePositionsChangedOptions): void {
    const shouldRecomputeCanvasBounds = options?.recomputeCanvasBounds !== false;
    if (shouldRecomputeCanvasBounds) {
      this.geometry.refresh();
      this.ensureWorldCoverage();
    } else {
      const nodeIds = options?.nodeIds ?? [];
      if (!options?.translating) {
        const previousRevision = this.geometry.revision;
        this.geometry.refreshNodes(nodeIds);
        this.retainMovingGuideTargets(nodeIds, previousRevision);
      }
      for (const nodeId of nodeIds) this.geometry.getNodeRect(nodeId);
      for (const shapeId of options?.shapeIds ?? []) this.geometry.getShapeRect(shapeId);
    }
    this.host.renderEdgeLayer({ translating: options?.translating === true });
    this.host.onNodePositionsChanged?.(options);
  }

  /** World px added to a position to reach scroll-box px. */
  getWorldOrigin(): GraphPoint {
    return { x: -(this.worldExtent?.left ?? 0), y: -(this.worldExtent?.top ?? 0) };
  }

  /** The viewport's visible rectangle in world px. */
  getViewportWorldRect(): StudioWorldRect | null {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return null;
    }
    const measurable = viewport.clientWidth > 0 && viewport.clientHeight > 0;
    // Hidden leaves report zero scroll offsets and ignore scroll writes. Keep
    // their last/requested world position until the scroll box is laid out.
    if (!measurable) {
      this.viewportPositionNeedsRestore = true;
    } else if (this.viewportPositionNeedsRestore) {
      this.setViewportWorldTopLeft(this.viewportWorldTopLeft.x, this.viewportWorldTopLeft.y);
    }
    const zoom = resolveStudioGraphSafeZoom(this.graphZoom);
    const origin = this.getWorldOrigin();
    const width = Math.max(1, viewport.clientWidth || STUDIO_GRAPH_FALLBACK_VIEWPORT_WIDTH) / zoom;
    const height = Math.max(1, viewport.clientHeight || STUDIO_GRAPH_FALLBACK_VIEWPORT_HEIGHT) / zoom;
    const left = measurable ? viewport.scrollLeft / zoom - origin.x : this.viewportWorldTopLeft.x;
    const top = measurable ? viewport.scrollTop / zoom - origin.y : this.viewportWorldTopLeft.y;
    this.viewportWorldTopLeft = { x: left, y: top };
    return { left, top, right: left + width, bottom: top + height };
  }

  /** World coordinate under the viewport's top-left corner, for persistence. */
  getViewportWorldTopLeft(): GraphPoint | null {
    const rect = this.getViewportWorldRect();
    return rect ? { x: rect.left, y: rect.top } : null;
  }

  /** World coordinate at the viewport's centre. */
  getViewportCenterWorldPoint(): GraphPoint | null {
    const rect = this.getViewportWorldRect();
    return rect ? { x: (rect.left + rect.right) * 0.5, y: (rect.top + rect.bottom) * 0.5 } : null;
  }

  /** Scroll so the viewport's top-left corner sits at a world coordinate, growing the box first. */
  setViewportWorldTopLeft(x: number, y: number): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }
    this.viewportWorldTopLeft = { x, y };
    this.viewportPositionNeedsRestore = viewport.clientWidth <= 0 || viewport.clientHeight <= 0;
    const zoom = resolveStudioGraphSafeZoom(this.graphZoom);
    const width = Math.max(1, viewport.clientWidth || STUDIO_GRAPH_FALLBACK_VIEWPORT_WIDTH) / zoom;
    const height = Math.max(1, viewport.clientHeight || STUDIO_GRAPH_FALLBACK_VIEWPORT_HEIGHT) / zoom;
    this.ensureWorldCoverage({ view: { left: x, top: y, right: x + width, bottom: y + height }, compensateScroll: false });
    if (this.viewportPositionNeedsRestore) {
      return;
    }
    const origin = this.getWorldOrigin();
    viewport.scrollLeft = (x + origin.x) * zoom;
    viewport.scrollTop = (y + origin.y) * zoom;
  }

  /**
   * Grow the scroll box when the view or the content nears its edge. The
   * scroll position is compensated by the origin shift so nothing moves on
   * screen. Returns true when the extent changed.
   */
  ensureWorldCoverage(options?: { view?: StudioWorldRect; compensateScroll?: boolean }): boolean {
    const viewport = this.graphViewportEl;
    const view = options?.view ?? this.getViewportWorldRect();
    if (!view) {
      return false;
    }
    const zoom = resolveStudioGraphSafeZoom(this.graphZoom);
    const viewWidth = Math.max(1, view.right - view.left);
    const viewHeight = Math.max(1, view.bottom - view.top);
    const content = this.geometry.getNodeBounds();
    const next = computeStudioWorldExtent({
      current: this.worldExtent,
      content,
      view,
      margin: { x: viewWidth, y: viewHeight },
      slack: { x: viewWidth * 2, y: viewHeight * 2 },
    });
    if (next === this.worldExtent) {
      return false;
    }
    const previous = this.getWorldOrigin();
    this.worldExtent = next;
    this.syncWorldGeometry();
    const origin = this.getWorldOrigin();
    if (viewport && !this.viewportPositionNeedsRestore && options?.compensateScroll !== false) {
      const dx = (origin.x - previous.x) * zoom;
      const dy = (origin.y - previous.y) * zoom;
      if (dx !== 0) viewport.scrollLeft += dx;
      if (dy !== 0) viewport.scrollTop += dy;
    }
    return true;
  }

  /** Apply the extent and origin to the scroll box, the world layer, and the edge layer. */
  private syncWorldGeometry(): void {
    const extent = this.worldExtent;
    if (!extent) {
      return;
    }
    const origin = this.getWorldOrigin();
    if (this.graphCanvasEl) {
      this.graphCanvasEl.style.width = `${extent.width}px`;
      this.graphCanvasEl.style.height = `${extent.height}px`;
    }
    if (this.graphWorldEl) {
      this.graphWorldEl.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
    }
    if (this.graphEdgesLayerEl) {
      // The SVG lives in the world layer and must cover the whole scroll box.
      this.graphEdgesLayerEl.style.left = `${-origin.x}px`;
      this.graphEdgesLayerEl.style.top = `${-origin.y}px`;
      this.graphEdgesLayerEl.setAttribute("viewBox", `${-origin.x} ${-origin.y} ${extent.width} ${extent.height}`);
      this.graphEdgesLayerEl.setAttribute("width", String(extent.width));
      this.graphEdgesLayerEl.setAttribute("height", String(extent.height));
    }
    this.syncGraphSurfaceSize();
  }

  clearNodeElements(): void {
    this.geometry.clearNodeElements();
    this.movementTargets = null;
    this.resizeTargets = null;
  }

  registerNodeElement(nodeId: string, nodeEl: HTMLElement): void {
    this.geometry.registerNodeElement(nodeId, nodeEl);
  }

  getNodeElement(nodeId: string): HTMLElement | null {
    return this.geometry.getNodeElement(nodeId);
  }

  refreshNodeSelectionClasses(): void {
    for (const [nodeId, nodeEl] of this.geometry.getNodeElements()) {
      nodeEl.classList.toggle("is-selected", this.selectedNodeIds.has(nodeId));
    }
  }

  clearSelection(): void {
    if (this.selectedNodeIds.size === 0) {
      return;
    }
    this.selection.clear("node");
    this.refreshNodeSelectionClasses();
    this.notifySelectionChanged();
  }

  fitSelectionInViewport(options?: { paddingPx?: number }): boolean {
    const viewport = this.graphViewportEl;
    const project = this.host.getCurrentProject();
    if (!viewport || !project || this.selectedNodeIds.size === 0) {
      return false;
    }

    const selectionBounds = this.geometry.getNodeBounds(this.selectedNodeIds);
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

    const graphBounds = this.geometry.getNodeBounds();
    if (!graphBounds) {
      return false;
    }

    return this.fitBoundsInViewport(graphBounds, {
      mode: "overview",
      paddingPx: options?.paddingPx,
    });
  }

  fitBoundsInViewport(
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
    const fittedZoom = Math.min(availableWidth / selectionWidth, availableHeight / selectionHeight);
    // Overview is an orientation aid, not a magnifier. A small graph should
    // be centered at its natural scale instead of ballooning on a wide phone,
    // tablet, or desktop window. Selection fitting remains free to zoom in.
    const rawTargetZoom = requestedMode === "overview"
      ? Math.min(1, fittedZoom)
      : fittedZoom;
    const appliedMode =
      requestedMode === "overview" && rawTargetZoom < STUDIO_GRAPH_MIN_ZOOM ? "overview" : "interactive";
    const targetZoom = this.clampGraphZoom(rawTargetZoom, appliedMode);

    this.cancelScheduledGraphZoomSettle();
    this.graphZoomMode = appliedMode;
    this.graphZoom = targetZoom;
    this.applyGraphZoom({ settled: false, notifyHost: false });

    const centerX = (bounds.left + bounds.right) * 0.5;
    const centerY = (bounds.top + bounds.bottom) * 0.5;
    this.setViewportWorldTopLeft(
      centerX - viewportWidth * 0.5 / targetZoom,
      centerY - viewportHeight * 0.5 / targetZoom
    );
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

  /** Client (screen) point → world px. */
  graphPointFromClient(clientX: number, clientY: number): GraphPoint | null {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return null;
    }

    const rect = viewport.getBoundingClientRect();
    const zoom = this.graphZoom || 1;
    const origin = this.getWorldOrigin();
    return {
      x: (viewport.scrollLeft + clientX - rect.left) / zoom - origin.x,
      y: (viewport.scrollTop + clientY - rect.top) / zoom - origin.y,
    };
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

    this.cancelPointerGesture?.();
    startEvent.preventDefault();
    const viewport = this.graphViewportEl;
    const marquee = this.graphMarqueeEl;
    const additive = startEvent.shiftKey || startEvent.metaKey || startEvent.ctrlKey;
    const baselineSelection = additive ? new Set(this.selectedNodeIds) : new Set<string>();
    this.host.beginDiagramMarquee?.();
    const startGraph = this.graphPointFromClient(startEvent.clientX, startEvent.clientY);
    if (!startGraph) {
      return;
    }

    let lastClientX = startEvent.clientX;
    let lastClientY = startEvent.clientY;
    let pendingClientX = startEvent.clientX;
    let pendingClientY = startEvent.clientY;

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
      // coordinates are scroll-box px: world plus origin, times zoom.
      const origin = this.getWorldOrigin();
      marquee.style.left = `${(x1 + origin.x) * zoom}px`;
      marquee.style.top = `${(y1 + origin.y) * zoom}px`;
      marquee.style.width = `${(x2 - x1) * zoom}px`;
      marquee.style.height = `${(y2 - y1) * zoom}px`;

      const marqueeSelected = new Set<string>();
      const project = this.host.getCurrentProject();
      if (!project) {
        return;
      }
      for (const [nodeId, rect] of this.geometry.getNodeRects()) {
        const intersects = rect.left <= x2 && rect.right >= x1 && rect.top <= y2 && rect.bottom >= y1;
        if (intersects) {
          marqueeSelected.add(nodeId);
        }
      }

      const nextSelection = additive
        ? new Set<string>([...baselineSelection, ...marqueeSelected])
        : marqueeSelected;
      this.selectedNodeIds = nextSelection;
      this.refreshNodeSelectionClasses();
      // The same sweep collects shapes: one marquee, one selection.
      this.host.selectDiagramInBounds?.(
        { left: x1, top: y1, right: x2, bottom: y2 },
        additive
      );
    };

    const flushSelectionFrame = (): void => {
      updateSelection(pendingClientX, pendingClientY);
    };

    const cleanupSelection = (): void => {
      this.cancelPointerGesture = null;
      marquee.classList.remove("is-active");
      marquee.setCssStyles({ width: "0px", height: "0px" });
    };

    const finishSelection = (): void => {
      cleanupSelection();

      const movedDistance = Math.hypot(lastClientX - startEvent.clientX, lastClientY - startEvent.clientY);
      if (movedDistance > 3) {
        this.suppressNextCanvasClick = true;
      } else if (!additive) {
        this.selection.clear("node");
        this.refreshNodeSelectionClasses();
      }
      this.notifySelectionChanged();
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const latestEvent = latestStudioPointerEvent(moveEvent);
      pendingClientX = latestEvent.clientX;
      pendingClientY = latestEvent.clientY;
    };

    updateSelection(startEvent.clientX, startEvent.clientY);
    this.cancelPointerGesture = startStudioPointerGesture({
      element: viewport, event: startEvent, onMove: onPointerMove,
      onFrame: flushSelectionFrame, onFinish: finishSelection, onCancel: cleanupSelection,
    });
  }

  startCanvasPan(startEvent: PointerEvent): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }

    if (startEvent.button !== 0) {
      return;
    }

    this.cancelPointerGesture?.();
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    let pendingClientX = startX;
    let pendingClientY = startY;
    let lastClientX = startX;
    let lastClientY = startY;

    const flushPanFrame = (): void => {
      // Incremental: the scroll box may grow (and its scroll be compensated)
      // between frames, so pan by the pointer delta since the last frame.
      viewport.scrollLeft -= pendingClientX - lastClientX;
      viewport.scrollTop -= pendingClientY - lastClientY;
      lastClientX = pendingClientX;
      lastClientY = pendingClientY;
      this.ensureWorldCoverage();
    };

    const cleanupPan = (): void => {
      this.cancelPointerGesture = null;
    };

    const finishPan = (): void => {
      cleanupPan();

      if (Math.hypot(lastClientX - startX, lastClientY - startY) > 3) {
        this.suppressNextCanvasClick = true;
      }
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const latestEvent = latestStudioPointerEvent(moveEvent);
      pendingClientX = latestEvent.clientX;
      pendingClientY = latestEvent.clientY;
      if (typeof moveEvent.preventDefault === "function") {
        moveEvent.preventDefault();
      }
    };

    this.cancelPointerGesture = startStudioPointerGesture({
      element: viewport, event: startEvent, onMove: onPointerMove,
      onFrame: flushPanFrame, onFinish: finishPan, onCancel: cleanupPan,
    });
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
    this.graphCanvasEl.setCssStyles({ transformOrigin: "0 0" });
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
    const ownerWindow = this.graphCanvasEl
      ? getStudioOwnerWindow(this.graphCanvasEl)
      : this.graphOwnerWindow;
    if (!ownerWindow) {
      this.applyGraphZoom({ settled: true });
      return;
    }
    this.zoomSettleWindow = ownerWindow;
    this.zoomSettleTimer = ownerWindow.setTimeout(() => {
      this.zoomSettleTimer = null;
      this.zoomSettleWindow = null;
      this.applyGraphZoom({ settled: true });
    }, STUDIO_GRAPH_ZOOM_SETTLE_DELAY_MS);
  }

  private cancelScheduledGraphZoomSettle(): void {
    if (this.zoomSettleTimer !== null) {
      this.zoomSettleWindow?.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
      this.zoomSettleWindow = null;
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
    const world = this.graphPointFromClient(clientX, clientY);

    const settled = options?.settled !== false;
    if (settled) {
      this.cancelScheduledGraphZoomSettle();
    }
    this.graphZoomMode = mode;
    this.graphZoom = clampedNextZoom;
    this.applyGraphZoom({ settled });

    if (world) {
      this.scrollWorldPointToLocal(world, localX, localY);
    }
    if (options?.scheduleSettle) {
      this.scheduleSettledGraphZoom();
    }
  }

  /** Zoom keeping the viewport centre fixed in world space. */
  zoomGraphAtViewportCenter(
    nextZoom: number,
    options?: { mode?: StudioGraphZoomMode; settled?: boolean; scheduleSettle?: boolean }
  ): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      this.setGraphZoom(nextZoom, options);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    this.zoomGraphAtClientPoint(
      nextZoom,
      rect.left + viewport.clientWidth * 0.5,
      rect.top + viewport.clientHeight * 0.5,
      options
    );
  }

  /** Scroll so a world point lands at a viewport-local pixel, growing the box first. */
  private scrollWorldPointToLocal(world: GraphPoint, localX: number, localY: number): void {
    const viewport = this.graphViewportEl;
    if (!viewport) {
      return;
    }
    const zoom = resolveStudioGraphSafeZoom(this.graphZoom);
    this.setViewportWorldTopLeft(world.x - localX / zoom, world.y - localY / zoom);
  }

  private normalizeWheelDelta(delta: number, deltaMode: number, pageSize: number): number {
    if (!Number.isFinite(delta) || delta === 0) {
      return 0;
    }
    if (deltaMode === WHEEL_DOM_DELTA_LINE) {
      return delta * 16;
    }
    if (deltaMode === WHEEL_DOM_DELTA_PAGE) {
      return delta * Math.max(1, pageSize);
    }
    return delta;
  }

  private shouldDeferWheelToOverlay(event: WheelEvent): boolean {
    return shouldStudioGraphDeferWheelToNativeScroll(event.target);
  }

  handleGraphViewportWheel(event: WheelEvent): void {
    const viewport = this.graphViewportEl;
    if (!viewport || event.defaultPrevented) {
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

    // Some mouse drivers already translate Shift + wheel into deltaX. Keep
    // that horizontal gesture; otherwise route the vertical wheel sideways.
    const horizontalDelta = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
    const verticalDelta = event.shiftKey ? 0 : event.deltaY;
    const deltaX = this.normalizeWheelDelta(horizontalDelta, event.deltaMode, viewport.clientWidth);
    const deltaY = this.normalizeWheelDelta(verticalDelta, event.deltaMode, viewport.clientHeight);
    if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) {
      return;
    }

    event.preventDefault();
    this.getViewportWorldRect();
    viewport.scrollLeft += deltaX;
    viewport.scrollTop += deltaY;
    // A tab can hide before the view's deferred scroll capture runs.
    this.getViewportWorldRect();
  }

  private findNode(project: StudioProjectV1, nodeId: string): StudioNodeInstance | null {
    return this.geometry.getNode(nodeId, project);
  }

  private updateNodePosition(nodeId: string): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }

    const node = this.findNode(project, nodeId);
    this.geometry.getNodeRect(nodeId);
    const element = this.geometry.getNodeElement(nodeId);
    if (!node || !element) {
      return;
    }

    element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
  }

  /**
   * Node half of a drag that started on a shape. Mirrors what the diagram
   * controller does for a drag that starts on a node card: snapshot origins,
   * write positions from them, then refresh what the DOM already shows.
   */
  beginSelectionTranslation(): void {
    const project = this.host.getCurrentProject();
    this.nodeTranslationOrigins = new Map();
    if (!project) {
      return;
    }
    for (const nodeId of this.selectedNodeIds) {
      const node = this.findNode(project, nodeId);
      if (node) {
        this.nodeTranslationOrigins.set(nodeId, { x: node.position.x, y: node.position.y });
      }
    }
  }

  applySelectionTranslation(project: StudioProjectV1, delta: GraphPoint): boolean {
    let changed = false;
    for (const [nodeId, origin] of this.nodeTranslationOrigins) {
      const node = this.findNode(project, nodeId);
      if (!node) {
        continue;
      }
      const nextX = Math.round(origin.x + delta.x);
      const nextY = Math.round(origin.y + delta.y);
      if (node.position.x !== nextX || node.position.y !== nextY) {
        node.position.x = nextX;
        node.position.y = nextY;
        changed = true;
      }
    }
    return changed;
  }

  previewSelectionTranslation(): void {
    if (this.nodeTranslationOrigins.size === 0 && !this.host.getSelectedShapeIds?.().length) {
      return;
    }
    for (const nodeId of this.nodeTranslationOrigins.keys()) {
      this.updateNodePosition(nodeId);
    }
    this.notifyNodePositionsChanged({
      recomputeCanvasBounds: false,
      translating: true,
      nodeIds: Array.from(this.nodeTranslationOrigins.keys()),
      shapeIds: this.host.getSelectedShapeIds?.() ?? [],
    });
  }

  finishSelectionTranslation(): void {
    if (this.nodeTranslationOrigins.size === 0 && !this.host.getSelectedShapeIds?.().length) {
      return;
    }
    this.nodeTranslationOrigins = new Map();
    this.notifyNodePositionsChanged();
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

    this.cancelPointerGesture?.();
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

    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    const zoom = this.graphZoom;
    let pendingClientX = startX;
    let pendingClientY = startY;
    let dragged = false;
    let captureHistoryOnNextMutation = false;
    let hoveredGroupId: string | null = null;

    let snapMovement: StudioMovementSnap = delta => delta;
    const syncHoveredGroup = (): void => {
      const nextGroupId = this.host.resolveNodeDragHoverGroup?.(dragNodeIds) || null;
      if (nextGroupId === hoveredGroupId) {
        return;
      }
      hoveredGroupId = nextGroupId;
      this.host.onNodeDragHoverGroupChange?.(hoveredGroupId, dragNodeIds);
    };
    const commitDraggedNodePositions = (options?: {
      captureHistory?: boolean;
      mode?: StudioGraphProjectMutationOptions["mode"];
      forceChanged?: boolean;
    }): boolean => {
      // Shared screen→canvas math with the resize frame — one zoom division.
      const { deltaX, deltaY } = resolveStudioCanvasDelta({
        startClientX: startX,
        startClientY: startY,
        clientX: pendingClientX,
        clientY: pendingClientY,
        zoom,
      });
      const delta = snapMovement({ x: deltaX, y: deltaY });
      return this.host.commitProjectMutation(
        "node.position",
        (currentProject) => {
          // Selected shapes ride the same pointer delta, in the same mutation,
          // so a mixed selection stays put relative to itself.
          let changed = this.host.translateDiagramSelection?.(currentProject, delta) === true;
          for (const dragNodeId of dragNodeIds) {
            const dragNode = this.findNode(currentProject, dragNodeId);
            const origin = originByNodeId.get(dragNodeId);
            if (!dragNode || !origin) {
              continue;
            }
            const nextX = Math.round(origin.x + delta.x);
            const nextY = Math.round(origin.y + delta.y);
            if (dragNode.position.x !== nextX || dragNode.position.y !== nextY) {
              dragNode.position.x = nextX;
              dragNode.position.y = nextY;
              changed = true;
            }
          }
          return changed || options?.forceChanged === true;
        },
        {
          mode: options?.mode,
          captureHistory: options?.captureHistory,
        }
      );
    };

    const flushDragFrame = (): void => {
      const travel = Math.hypot(pendingClientX - startX, pendingClientY - startY);
      if (!dragged && travel > 3) {
        dragged = true;
        startEvent.preventDefault();
        captureHistoryOnNextMutation = true;
        // Shape origins are captured here, not on pointerdown: the press may
        // still have been about to clear the diagram selection.
        this.host.beginDiagramTranslation?.();
        snapMovement = this.createMovementSnap(dragNodeIds, this.host.getSelectedShapeIds?.() || []);
        this.host.onNodeDragStateChange?.(true);
        syncHoveredGroup();
      }
      if (!dragged) {
        return;
      }

      const changed = commitDraggedNodePositions({
        captureHistory: captureHistoryOnNextMutation,
        mode: "continuous",
      });
      captureHistoryOnNextMutation = false;
      this.showMovementGuides(dragNodeIds, this.host.getSelectedShapeIds?.() || []);
      if (!changed) {
        syncHoveredGroup();
        return;
      }
      for (const dragNodeId of dragNodeIds) {
        this.updateNodePosition(dragNodeId);
      }
      this.host.previewDiagramTranslation?.();
      this.notifyNodePositionsChanged({
        recomputeCanvasBounds: false,
        translating: true,
        nodeIds: dragNodeIds,
        shapeIds: this.host.getSelectedShapeIds?.() ?? [],
      });
      syncHoveredGroup();
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {

      const latestEvent = latestStudioPointerEvent(moveEvent);
      pendingClientX = latestEvent.clientX;
      pendingClientY = latestEvent.clientY;
      if (
        Math.hypot(pendingClientX - startX, pendingClientY - startY) > 3 &&
        typeof moveEvent.preventDefault === "function"
      ) {
        moveEvent.preventDefault();
      }
    };

    const cleanupDrag = (): void => {
      this.cancelPointerGesture = null;
      this.renderAlignmentGuides(null);
    };

    const finishDrag = (): void => {
      cleanupDrag();
      if (dragged) {
        this.host.onNodeDragStateChange?.(false);
        this.host.onNodeDropToGroup?.(hoveredGroupId, dragNodeIds);
        hoveredGroupId = null;
        this.host.onNodeDragHoverGroupChange?.(null, dragNodeIds);
        void commitDraggedNodePositions({
          captureHistory: false,
          mode: "discrete",
          forceChanged: true,
        });
        this.host.previewDiagramTranslation?.();
        this.host.finishDiagramTranslation?.();
        this.notifyNodePositionsChanged();
        return;
      }

      if (selectionChangedOnPointerDown || this.selectedNodeIds.has(nodeId)) {
        this.notifySelectionChanged();
      }
    };

    this.cancelPointerGesture = startStudioPointerGesture({
      element: dragSurfaceEl, event: startEvent, onMove: onPointerMove,
      onFrame: flushDragFrame, onFinish: finishDrag,
      onCancel: () => {
        cleanupDrag();
        if (dragged) {
          this.host.onNodeDragStateChange?.(false);
          this.host.onNodeDragHoverGroupChange?.(null, dragNodeIds);
          this.host.finishDiagramTranslation?.();
        }
      },
    });
  }

  /** Show nearby edge alignment while resizing; never adjust the dragged edge. */
  showNodeResizeGuides(
    nodeId: string,
    moving: StudioGuideRect,
    edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 }
  ): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      this.renderAlignmentGuides(null);
      return;
    }
    const revision = this.geometry.revision;
    if (!this.resizeTargets || this.resizeTargets.revision !== revision || this.resizeTargets.nodeId !== nodeId) {
      this.resizeTargets = {
        revision,
        nodeId,
        others: Array.from(this.geometry.getNodeRects())
          .filter(([id]) => id !== nodeId)
          .map(([, rect]) => rect),
      };
    }
    const guides = resolveStudioResizeGuides({
      moving,
      others: this.resizeTargets.others,
      threshold: STUDIO_GUIDE_THRESHOLD_PX / resolveStudioGraphSafeZoom(this.graphZoom),
      edges,
    });
    this.renderAlignmentGuides(guides.guides.length > 0 ? guides : null, moving);
  }

  clearAlignmentGuides(): void {
    this.renderAlignmentGuides(null);
  }

  private movementGeometry(nodeIds: readonly string[], shapeIds: readonly string[]): { moving: StudioGuideRect; others: StudioGuideRect[] } | null {
    if (!this.host.getCurrentProject()) return null;
    const revision = this.geometry.revision;
    const targets = this.movementTargets;
    if (!targets || targets.revision !== revision ||
      !this.sameIds(targets.nodeIds, nodeIds) || !this.sameIds(targets.shapeIds, shapeIds)) {
      const nodes = new Set(nodeIds), shapes = new Set(shapeIds);
      this.movementTargets = {
        revision,
        nodeIds: [...nodeIds],
        shapeIds: [...shapeIds],
        others: [
          ...Array.from(this.geometry.getNodeRects()).filter(([id]) => !nodes.has(id)).map(([, rect]) => rect),
          ...Array.from(this.geometry.getShapeRects()).filter(([id]) => !shapes.has(id)).map(([, rect]) => rect),
        ],
      };
    }
    const moving: StudioGuideRect[] = [];
    for (const nodeId of nodeIds) {
      const rect = this.geometry.getNodeRect(nodeId);
      if (rect) moving.push(rect);
    }
    for (const shapeId of shapeIds) {
      const rect = this.geometry.getShapeRect(shapeId);
      if (rect) moving.push(rect);
    }
    if (!moving.length) return null;
    const bounds = moving.reduce((union, rect) => ({ left: Math.min(union.left, rect.left),
      top: Math.min(union.top, rect.top), right: Math.max(union.right, rect.right), bottom: Math.max(union.bottom, rect.bottom) }));
    return { moving: bounds, others: this.movementTargets!.others };
  }

  private sameIds(previous: readonly string[], current: readonly string[]): boolean {
    return previous.length === current.length && previous.every((id, index) => id === current[index]);
  }

  private retainMovingGuideTargets(nodeIds: readonly string[], previousRevision: number): void {
    if (nodeIds.length === 0) return;
    const revision = this.geometry.revision;
    const movement = this.movementTargets;
    if (movement?.revision === previousRevision && nodeIds.every(id => movement.nodeIds.includes(id))) {
      movement.revision = revision;
    } else {
      this.movementTargets = null;
    }
    const resize = this.resizeTargets;
    if (resize?.revision === previousRevision && nodeIds.every(id => id === resize.nodeId)) {
      resize.revision = revision;
    } else {
      this.resizeTargets = null;
    }
  }

  createMovementSnap(nodeIds: readonly string[], shapeIds: readonly string[]): StudioMovementSnap {
    const geometry = this.movementGeometry(nodeIds, shapeIds);
    return geometry ? createStudioMovementSnap({ ...geometry,
      threshold: STUDIO_ALIGNMENT_SNAP_THRESHOLD_PX / resolveStudioGraphSafeZoom(this.graphZoom) }) : delta => delta;
  }

  showMovementGuides(nodeIds: readonly string[], shapeIds: readonly string[]): void {
    const geometry = this.movementGeometry(nodeIds, shapeIds);
    if (!geometry) { this.renderAlignmentGuides(null); return; }
    this.renderAlignmentGuides(resolveStudioMovementGuides({ ...geometry,
      threshold: STUDIO_GUIDE_THRESHOLD_PX / resolveStudioGraphSafeZoom(this.graphZoom) }));
  }

  /** Arrow geometry flushes after the drag preview; use its current cached label boxes. */
  refreshAlignmentGuides(): void {
    if (this.alignmentGuideResult) this.renderAlignmentGuides(this.alignmentGuideResult, this.alignmentGuideMovingRect);
  }

  private renderAlignmentGuides(result: StudioAlignmentGuides | null, moving: StudioGuideRect | null = null): void {
    this.alignmentGuideResult = result;
    this.alignmentGuideMovingRect = moving;
    if (!this.alignmentGuidesEl) {
      return;
    }
    try {
      const viewport = this.getViewportWorldRect();
      renderStudioGraphAlignmentGuidesLayer(this.alignmentGuidesEl, result, this.graphZoom, this.getWorldOrigin(), [
        this.geometry.getNodeRects(), this.geometry.getShapeRects(), this.geometry.getArrowLabelRects(), moving ? [moving] : [],
      ], viewport);
    } catch {
      // Guide rendering must never break an in-flight drag.
    }
  }

  toggleNodeSelection(nodeId: string): void {
    this.selection.toggle("node", nodeId);
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
    if (!this.graphSurfaceEl || !this.worldExtent) {
      return;
    }
    const zoom = this.graphZoom || 1;
    this.graphSurfaceEl.style.width = `${Math.round(this.worldExtent.width * zoom)}px`;
    this.graphSurfaceEl.style.height = `${Math.round(this.worldExtent.height * zoom)}px`;
  }
}
