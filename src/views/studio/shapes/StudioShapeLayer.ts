import type { StudioDiagram, StudioShapeInstance } from "../../../studio/types";
import { clampStudioShapeHeight, clampStudioShapeWidth } from "../../../studio/StudioShapes";
import { resolveStudioGraphSafeZoom } from "../../../studio/StudioNodeGeometry";
import { createStudioSvgElement, getStudioOwnerWindow } from "../StudioDomContext";
import { startStudioPointerGesture } from "../StudioPointerGesture";
import type { StudioCanvasTool } from "../StudioCanvasTool";
import {
  buildStudioShapeArrowPath,
  buildStudioShapeArrowPreviewPath,
  type StudioShapeArrowFan,
  type StudioArrowAnchor,
} from "./StudioShapeGeometry";
import { buildStudioShapeOutline } from "./StudioShapeOutline";

/**
 * The diagram layer: shapes and visual arrows between canvas items. Node card
 * bounds anchor arrows without involving ports, execution links, or run state.
 *
 * Gestures move/resize the local copy live and commit once on release, so a
 * drag is one history entry instead of one per pointer frame.
 */

const DRAG_ACTIVATION_PX = 3;

/** Diagram half of the canvas selection; nodes are the other half. */
export type StudioShapeSelection = {
  shapeIds: readonly string[];
  arrowIds: readonly string[];
};

export const EMPTY_STUDIO_SHAPE_SELECTION: StudioShapeSelection = { shapeIds: [], arrowIds: [] };

export type StudioShapeTarget = { type: "shape" | "arrow"; id: string };

export type StudioShapeRect = { x: number; y: number; width: number; height: number };

/** One frame of a selection drag; `first` opens the history entry, `final` closes it. */
export type StudioShapeDragPhase = { first: boolean; final: boolean; cancelled?: boolean };

export type StudioShapeLayerOptions = {
  canvasEl: HTMLElement;
  diagram: StudioDiagram;
  busy: boolean;
  activeCanvasTool: StudioCanvasTool;
  selection: StudioShapeSelection;
  getSelection?: () => StudioShapeSelection;
  getGraphZoom: () => number;
  getNodeAnchor?: (nodeId: string) => StudioArrowAnchor | null;
  onSelect: (target: StudioShapeTarget, options: { additive: boolean }) => void;
  /**
   * A drag started on a shape. The delta applies to the whole canvas selection
   * — the host moves the selected nodes with it, so one drag is one move.
   */
  onMoveSelection: (delta: { x: number; y: number }, phase: StudioShapeDragPhase) => void;
  onResizeShape: (shapeId: string, rect: StudioShapeRect) => void;
  onLabelChange: (shapeId: string, label: string) => void;
  onArrowLabelChange: (arrowId: string, label: string) => void;
  onConnectShapes: (fromShapeId: string, toShapeId: string) => void;
};

/**
 * Imperative handle for drags that start outside the diagram: a node drag
 * nudges the selected shapes through this without a re-render.
 */
export type StudioShapeLayerHandle = {
  el: HTMLElement;
  dispose?: () => void;
  startArrowGesture: (itemId: string, event: PointerEvent) => void;
  cancelArrowGesture: () => void;
  /** Touched node/shape IDs coalesce until the next frame; omitted IDs reconcile everything immediately. */
  refreshArrows: (itemIds?: readonly string[]) => void;
  applyShapePositions: (
    positions: ReadonlyArray<{ shapeId: string; position: { x: number; y: number } }>
  ) => void;
  update: (options: Pick<StudioShapeLayerOptions, "diagram" | "busy" | "activeCanvasTool" | "selection">) => void;
};

type ArrowElements = {
  group: SVGGElement;
  hit: SVGPathElement;
  line: SVGPathElement;
  head: SVGPathElement;
  /** HTML div at the arrow's midpoint; empty labels are hidden by CSS. */
  label: HTMLElement;
};

/** A shape is drawn as its own SVG outline, so every kind gets a true border. */
type ShapeElements = {
  root: HTMLElement;
  outline: SVGSVGElement;
  body: SVGPathElement;
  detail: SVGPathElement;
};

const RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;
type ResizeCorner = (typeof RESIZE_CORNERS)[number];

/** Same additive chord the node graph's marquee uses, so one habit covers both. */
function isAdditive(event: PointerEvent): boolean {
  return Boolean(event.shiftKey || event.metaKey || event.ctrlKey);
}

export function renderStudioShapeLayer(options: StudioShapeLayerOptions): StudioShapeLayerHandle {
  const { canvasEl, getGraphZoom } = options;
  const ownerWindow = getStudioOwnerWindow(canvasEl);
  let currentDiagram = options.diagram;
  let currentBusy = options.busy;
  let currentActiveCanvasTool = options.activeCanvasTool;
  let currentSelection = options.selection;
  const selection = (): StudioShapeSelection => options.getSelection?.() ?? currentSelection;

  const layerEl = canvasEl.createDiv({ cls: "ss-studio-shapes-layer" });
  const arrowsLayer = createStudioSvgElement(layerEl, "svg");
  arrowsLayer.setAttribute("class", "ss-studio-shape-arrows-layer");
  layerEl.appendChild(arrowsLayer);

  // Working copy: gestures mutate this, never the project, until they commit.
  const shapesById = new Map<string, StudioShapeInstance>(
    currentDiagram.shapes.map((shape) => [
      shape.id,
      { ...shape, position: { ...shape.position }, size: { ...shape.size } },
    ])
  );
  const shapeElements = new Map<string, ShapeElements>();
  const arrowElements = new Map<string, ArrowElements>();
  const arrowsById = new Map<string, StudioDiagram["arrows"][number]>();
  const arrowIdsByItemId = new Map<string, Set<string>>();
  const pendingArrowIds = new Set<string>();
  let arrowFrame: number | null = null;
  let disposed = false;
  let arrowFans = new Map<string, StudioShapeArrowFan>();

  const indexArrows = (): void => {
    arrowFans = resolveArrowFans(currentDiagram);
    arrowsById.clear();
    arrowIdsByItemId.clear();
    for (const arrow of currentDiagram.arrows) {
      arrowsById.set(arrow.id, arrow);
      for (const itemId of [arrow.fromShapeId, arrow.toShapeId]) {
        let ids = arrowIdsByItemId.get(itemId);
        if (!ids) arrowIdsByItemId.set(itemId, ids = new Set());
        ids.add(arrow.id);
      }
    }
  };
  const activeGestureShapeIds = new Set<string>();
  let previewPath: SVGPathElement | null = null;
  let cancelArrowGesture = (): void => {};
  let cancelMoveGesture: (() => void) | null = null;
  let cancelResizeGesture: (() => void) | null = null;

  const resolveAnchor = (itemId: string): StudioArrowAnchor | null =>
    shapesById.get(itemId) ?? options.getNodeAnchor?.(itemId) ?? null;

  const graphPointFromClient = (clientX: number, clientY: number): { x: number; y: number } => {
    const zoom = resolveStudioGraphSafeZoom(getGraphZoom());
    const rect = canvasEl.getBoundingClientRect();
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };

  const applyShapeGeometry = (shape: StudioShapeInstance): void => {
    const elements = shapeElements.get(shape.id);
    if (!elements) {
      return;
    }
    const { width, height } = shape.size;
    elements.root.style.left = `${shape.position.x}px`;
    elements.root.style.top = `${shape.position.y}px`;
    elements.root.style.width = `${width}px`;
    elements.root.style.height = `${height}px`;
    const outline = buildStudioShapeOutline(shape.shape, shape.size);
    elements.outline.setAttribute("viewBox", `0 0 ${width} ${height}`);
    elements.outline.setAttribute("width", `${width}`);
    elements.outline.setAttribute("height", `${height}`);
    elements.body.setAttribute("d", outline.body);
    elements.detail.setAttribute("d", outline.detail);
  };

  const removeArrow = (arrowId: string): void => {
    const elements = arrowElements.get(arrowId);
    elements?.group.remove();
    elements?.label.remove();
    arrowElements.delete(arrowId);
  };

  const renderArrows = (arrowIds: Iterable<string>): void => {
    const anchors = new Map<string, StudioArrowAnchor | null>();
    const anchor = (id: string): StudioArrowAnchor | null => {
      if (!anchors.has(id)) anchors.set(id, resolveAnchor(id));
      return anchors.get(id) ?? null;
    };
    for (const arrowId of arrowIds) {
      const arrow = arrowsById.get(arrowId);
      if (!arrow) continue;
      const from = anchor(arrow.fromShapeId);
      const to = anchor(arrow.toShapeId);
      if (!from || !to) {
        removeArrow(arrowId);
        continue;
      }
      const path = buildStudioShapeArrowPath(from, to, arrowFans.get(arrow.id));
      let elements = arrowElements.get(arrow.id);
      if (!elements) {
        const created = createArrowElements(arrowsLayer, layerEl, arrow.id);
        elements = created;
        arrowElements.set(arrow.id, created);
        arrowsLayer.appendChild(created.group);
        created.hit.addEventListener("pointerdown", (event) => {
          if (currentBusy) {
            return;
          }
          event.stopPropagation();
          options.onSelect({ type: "arrow", id: arrow.id }, { additive: isAdditive(event) });
        });
        created.label.addEventListener("pointerdown", (event) => {
          if (currentBusy) {
            return;
          }
          event.stopPropagation();
          options.onSelect({ type: "arrow", id: arrow.id }, { additive: isAdditive(event) });
        });
        const editLabel = (event: Event): void => {
          if (currentBusy) {
            return;
          }
          event.stopPropagation();
          event.preventDefault();
          editStudioDiagramLabel({
            labelEl: created.label,
            initial: currentDiagram.arrows.find(candidate => candidate.id === arrow.id)?.label || "",
            testid: "studio.arrow.label-editor",
            commit: (label) => options.onArrowLabelChange(arrow.id, label),
          });
        };
        created.hit.addEventListener("dblclick", editLabel);
        created.label.addEventListener("dblclick", editLabel);
      }
      elements.group.classList.toggle("is-selected", selection().arrowIds.includes(arrow.id));
      elements.label.classList.toggle("is-selected", selection().arrowIds.includes(arrow.id));
      elements.hit.setAttribute("d", path.line);
      elements.line.setAttribute("d", path.line);
      elements.head.setAttribute("d", path.head);
      elements.label.style.left = `${path.mid.x}px`;
      elements.label.style.top = `${path.mid.y}px`;
      // A drag redraws arrows mid-edit; never clobber the text being typed.
      if (!elements.label.classList.contains("is-editing")) {
        elements.label.textContent = arrow.label || "";
      }
    }
  };

  const cancelArrowFrame = (): void => {
    if (arrowFrame !== null) ownerWindow.cancelAnimationFrame(arrowFrame);
    arrowFrame = null;
    pendingArrowIds.clear();
  };

  const refreshArrows = (itemIds?: readonly string[]): void => {
    if (disposed) return;
    if (itemIds === undefined) {
      // A document refresh can replace endpoints/IDs without changing counts.
      cancelArrowFrame();
      indexArrows();
      for (const arrowId of arrowElements.keys()) {
        if (!arrowsById.has(arrowId)) removeArrow(arrowId);
      }
      renderArrows(arrowsById.keys());
      return;
    }
    for (const itemId of itemIds) {
      for (const arrowId of arrowIdsByItemId.get(itemId) ?? []) pendingArrowIds.add(arrowId);
    }
    if (!pendingArrowIds.size || arrowFrame !== null) return;
    const flush = (): void => {
      arrowFrame = null;
      const ids = [...pendingArrowIds];
      pendingArrowIds.clear();
      if (!disposed) renderArrows(ids);
    };
    if (typeof ownerWindow.requestAnimationFrame !== "function") { flush(); return; }
    // Test/host adapters may invoke RAF synchronously.
    let synchronous = false;
    const id = ownerWindow.requestAnimationFrame(() => { synchronous = true; flush(); });
    if (!synchronous) arrowFrame = id;
  };

  /** Moves the layer's own copy of the dragged shapes and redraws their arrows. */
  const translateShapes = (
    shapeIds: readonly string[],
    origins: Map<string, { x: number; y: number }>,
    delta: { x: number; y: number }
  ): void => {
    for (const shapeId of shapeIds) {
      const shape = shapesById.get(shapeId);
      const origin = origins.get(shapeId);
      if (!shape || !origin) {
        continue;
      }
      shape.position = { x: Math.round(origin.x + delta.x), y: Math.round(origin.y + delta.y) };
      applyShapeGeometry(shape);
    }
    refreshArrows(shapeIds);
  };

  const startMoveGesture = (shape: StudioShapeInstance, startEvent: PointerEvent): void => {
    let dragShapeIds: string[] = [];
    const startPositions = new Map<string, { x: number; y: number }>();
    let activated = false;
    let lastDelta = { x: 0, y: 0 };

    const finish = (commit: boolean): void => {
      cancelMoveGesture = null;
      dragShapeIds.forEach(shapeId => activeGestureShapeIds.delete(shapeId));
      if (!activated) {
        return;
      }
      if (!commit) {
        translateShapes(dragShapeIds, startPositions, { x: 0, y: 0 });
        options.onMoveSelection({ x: 0, y: 0 }, { first: false, final: true, cancelled: true });
        return;
      }
      options.onMoveSelection(lastDelta, { first: false, final: true });
    };

    function onMove(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId) {
        return;
      }
      const point = graphPointFromClient(event.clientX, event.clientY);
      const delta = { x: point.x - origin.x, y: point.y - origin.y };
      if (!activated && Math.hypot(delta.x, delta.y) < DRAG_ACTIVATION_PX) {
        return;
      }
      const first = !activated;
      activated = true;
      lastDelta = delta;
      translateShapes(dragShapeIds, startPositions, delta);
      options.onMoveSelection(delta, { first, final: false });
    }

    cancelMoveGesture = startStudioPointerGesture({
      element: shapeElements.get(shape.id)?.root ?? canvasEl,
      event: startEvent,
      onMove,
      onFinish: () => finish(true),
      onCancel: () => finish(false),
    });
    // Capture origins only after the previous gesture has restored its preview.
    if (!shapesById.has(shape.id)) {
      cancelMoveGesture();
      return;
    }
    const origin = graphPointFromClient(startEvent.clientX, startEvent.clientY);
    // Dragging a member moves the whole selection; anything else moves alone.
    dragShapeIds = selection().shapeIds.includes(shape.id) ? [...selection().shapeIds] : [shape.id];
    for (const shapeId of dragShapeIds) {
      const dragged = shapesById.get(shapeId);
      if (dragged) {
        activeGestureShapeIds.add(shapeId);
        startPositions.set(shapeId, { ...dragged.position });
      }
    }
  };

  const startResizeGesture = (
    shape: StudioShapeInstance,
    corner: ResizeCorner,
    startEvent: PointerEvent
  ): void => {
    const finish = (commit: boolean): void => {
      cancelResizeGesture = null;
      activeGestureShapeIds.delete(shape.id);
      if (!commit) {
        // Refreshes received during the gesture deferred this shape and its handles.
        handle.update({
          diagram: currentDiagram,
          busy: currentBusy,
          activeCanvasTool: currentActiveCanvasTool,
          selection: selection(),
        });
        return;
      }
      options.onResizeShape(shape.id, {
        x: shape.position.x,
        y: shape.position.y,
        width: shape.size.width,
        height: shape.size.height,
      });
    };

    function onMove(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId) {
        return;
      }
      const point = graphPointFromClient(event.clientX, event.clientY);
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      const pullsLeft = corner === "nw" || corner === "sw";
      const pullsUp = corner === "nw" || corner === "ne";
      const width = clampStudioShapeWidth(startRect.width + (pullsLeft ? -dx : dx));
      const height = clampStudioShapeHeight(startRect.height + (pullsUp ? -dy : dy));
      shape.size = { width, height };
      shape.position = {
        // A corner that pulls left/up keeps the opposite edge pinned, so the
        // clamped size — not the raw pointer delta — decides the new origin.
        x: Math.round(pullsLeft ? startRect.x + startRect.width - width : startRect.x),
        y: Math.round(pullsUp ? startRect.y + startRect.height - height : startRect.y),
      };
      applyShapeGeometry(shape);
      refreshArrows([shape.id]);
    }

    cancelResizeGesture = startStudioPointerGesture({
      // Handles are rebuilt during document refreshes; capture their stable root.
      element: shapeElements.get(shape.id)?.root ?? canvasEl,
      event: startEvent,
      onMove,
      onFinish: event => finish(event?.type === "pointerup"),
      onCancel: () => finish(false),
    });
    // Superseding another gesture may restore or delete this working shape.
    if (!shapesById.has(shape.id)) {
      cancelResizeGesture();
      return;
    }
    activeGestureShapeIds.add(shape.id);
    const origin = graphPointFromClient(startEvent.clientX, startEvent.clientY);
    const startRect: StudioShapeRect = {
      x: shape.position.x,
      y: shape.position.y,
      width: shape.size.width,
      height: shape.size.height,
    };
  };

  const startArrowGesture = (itemId: string, startEvent: PointerEvent): void => {
    cancelArrowGesture();
    const initialSource = resolveAnchor(itemId);
    if (currentBusy || !initialSource) return;
    const source: StudioArrowAnchor = initialSource;
    previewPath = createStudioSvgElement(arrowsLayer, "path");
    previewPath.setAttribute("class", "ss-studio-shape-arrow-preview");
    arrowsLayer.appendChild(previewPath);
    let settled = false;

    const finish = (event: PointerEvent | null): void => {
      if (settled) return;
      settled = true;
      previewPath?.remove();
      previewPath = null;
      cancelArrowGesture = () => {};
      const targetId = event ? resolveItemIdAtPoint(canvasEl, event) : null;
      if (targetId && targetId !== itemId && resolveAnchor(targetId)) {
        options.onConnectShapes(itemId, targetId);
      }
    };

    function onMove(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId || !previewPath) return;
      const targetId = resolveItemIdAtPoint(canvasEl, event);
      const target = targetId && targetId !== itemId ? resolveAnchor(targetId) : null;
      const from = resolveAnchor(itemId) ?? source;
      const path = target
        ? buildStudioShapeArrowPath(from, target)
        : buildStudioShapeArrowPreviewPath(from, graphPointFromClient(event.clientX, event.clientY));
      previewPath.setAttribute("d", `${path.line} ${path.head}`);
    }

    cancelArrowGesture = startStudioPointerGesture({
      element: canvasEl,
      event: startEvent,
      onMove,
      onFinish: event => finish(event?.type === "pointerup" ? event : null),
      onCancel: () => finish(null),
    });
    onMove(startEvent);
  };

  const mountShape = (shape: StudioShapeInstance): void => {
    const shapeEl = layerEl.createDiv({ cls: "ss-studio-shape" });
    shapeEl.dataset.shapeId = shape.id;
    shapeEl.dataset.shape = shape.shape;
    shapeEl.classList.toggle("is-selected", selection().shapeIds.includes(shape.id));
    shapeElements.set(shape.id, createShapeOutlineElements(shapeEl));
    applyShapeGeometry(shape);

    const labelEl = shapeEl.createDiv({ cls: "ss-studio-shape-label", text: shape.label });

    shapeEl.addEventListener("pointerdown", (event) => {
      if (currentBusy || event.button !== 0) {
        return;
      }
      event.stopPropagation();
      if (currentActiveCanvasTool === "arrow") {
        event.preventDefault();
        startArrowGesture(shape.id, event);
        return;
      }
      if (currentActiveCanvasTool !== "select") {
        return;
      }
      options.onSelect({ type: "shape", id: shape.id }, { additive: isAdditive(event) });
      startMoveGesture(shape, event);
    });

    shapeEl.addEventListener("dblclick", (event) => {
      if (currentBusy) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      editStudioDiagramLabel({
        labelEl,
        initial: shape.label,
        testid: "studio.shape.label-editor",
        commit: (label) => options.onLabelChange(shape.id, label),
      });
    });

    // Resize handles belong to a single shape: a group selection moves, it
    // does not stretch.
    const singleSelected =
      selection().shapeIds.length === 1 && selection().arrowIds.length === 0 && selection().shapeIds.includes(shape.id);
    if (singleSelected && !currentBusy && currentActiveCanvasTool === "select") {
      for (const corner of RESIZE_CORNERS) {
        const handle = shapeEl.createDiv({ cls: "ss-studio-shape-handle" });
        handle.dataset.corner = corner;
        handle.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) {
            return;
          }
          event.stopPropagation();
          event.preventDefault();
          startResizeGesture(shape, corner, event);
        });
      }
    }
  };

  for (const shape of shapesById.values()) mountShape(shape);

  refreshArrows();
  const handle: StudioShapeLayerHandle = {
    el: layerEl,
    dispose: () => {
      cancelResizeGesture?.();
      cancelMoveGesture?.();
      cancelArrowGesture();
      disposed = true;
      cancelArrowFrame();
    },
    startArrowGesture,
    cancelArrowGesture: () => cancelArrowGesture(),
    refreshArrows,
    applyShapePositions: (positions) => {
      const changedIds: string[] = [];
      for (const { shapeId, position } of positions) {
        const shape = shapesById.get(shapeId);
        if (!shape) {
          continue;
        }
        const next = { x: Math.round(position.x), y: Math.round(position.y) };
        if (shape.position.x === next.x && shape.position.y === next.y) continue;
        shape.position = next;
        applyShapeGeometry(shape);
        changedIds.push(shapeId);
      }
      refreshArrows(changedIds);
    },
    update: (next) => {
      currentDiagram = next.diagram;
      currentBusy = next.busy;
      currentActiveCanvasTool = next.activeCanvasTool;
      currentSelection = next.selection;

      const incomingIds = new Set(currentDiagram.shapes.map(shape => shape.id));
      for (const [shapeId, elements] of shapeElements) {
        if (incomingIds.has(shapeId) || activeGestureShapeIds.has(shapeId)) continue;
        elements.root.remove();
        shapeElements.delete(shapeId);
        shapesById.delete(shapeId);
      }
      for (const incoming of currentDiagram.shapes) {
        const shape = shapesById.get(incoming.id);
        if (!shape) {
          const created = { ...incoming, position: { ...incoming.position }, size: { ...incoming.size } };
          shapesById.set(created.id, created);
          mountShape(created);
          continue;
        }
        if (!activeGestureShapeIds.has(incoming.id)) {
          Object.assign(shape, incoming, { position: { ...incoming.position }, size: { ...incoming.size } });
          applyShapeGeometry(shape);
          const root = shapeElements.get(shape.id)?.root;
          if (root && root.dataset.shape !== shape.shape) root.dataset.shape = shape.shape;
          const label = root?.querySelector<HTMLElement>(".ss-studio-shape-label");
          if (label && !label.classList.contains("is-editing")) label.setText(shape.label);
        }
      }
      for (const [shapeId, elements] of shapeElements) {
        elements.root.classList.toggle("is-selected", selection().shapeIds.includes(shapeId));
        elements.root.querySelectorAll(".ss-studio-shape-handle").forEach(handle => handle.remove());
      }
      // Selection handles are presentation only. Reusing the existing shape
      // elements keeps pointer listeners and active gestures intact.
      if (!currentBusy && currentActiveCanvasTool === "select" && selection().shapeIds.length === 1 && selection().arrowIds.length === 0) {
        const shapeId = selection().shapeIds[0];
        const shape = shapesById.get(shapeId);
        const root = shapeElements.get(shapeId)?.root;
        if (shape && root && !activeGestureShapeIds.has(shapeId)) {
          for (const corner of RESIZE_CORNERS) {
            const resize = root.createDiv({ cls: "ss-studio-shape-handle" });
            resize.dataset.corner = corner;
            resize.addEventListener("pointerdown", event => {
              if (event.button !== 0) return;
              event.stopPropagation();
              event.preventDefault();
              startResizeGesture(shape, corner, event);
            });
          }
        }
      }
      refreshArrows();
    },
  };
  return handle;
}

/**
 * Drops the diagram selection visuals in place. Deselecting happens during a
 * pointerdown that another layer may still need (a node drag starting on its
 * card), so it must never re-render the canvas out from under that gesture.
 */
export function clearStudioShapeSelectionVisuals(canvasEl: HTMLElement): void {
  canvasEl.querySelectorAll(".ss-studio-shape-handle").forEach((handle) => handle.remove());
  canvasEl
    .querySelectorAll(
      ".ss-studio-shape.is-selected, .ss-studio-shape-arrow.is-selected, .ss-studio-shape-arrow-label.is-selected"
    )
    .forEach((element) => element.classList.remove("is-selected"));
}

function createShapeOutlineElements(shapeEl: HTMLElement): ShapeElements {
  const outline = createStudioSvgElement(shapeEl, "svg");
  outline.setAttribute("class", "ss-studio-shape-outline");
  shapeEl.appendChild(outline);

  const body = createStudioSvgElement(shapeEl, "path");
  body.setAttribute("class", "ss-studio-shape-outline-body");
  outline.appendChild(body);

  const detail = createStudioSvgElement(shapeEl, "path");
  detail.setAttribute("class", "ss-studio-shape-outline-detail");
  outline.appendChild(detail);

  return { root: shapeEl, outline, body, detail };
}

/**
 * Arrows sharing the same two shapes fan apart. Grouping is by unordered pair,
 * so a round trip (A→B and B→A) separates instead of drawing the same pixels
 * twice with one head hidden under the other.
 */
function resolveArrowFans(diagram: StudioDiagram): Map<string, StudioShapeArrowFan> {
  const groups = new Map<string, string[]>();
  for (const arrow of diagram.arrows) {
    const key = [arrow.fromShapeId, arrow.toShapeId].sort().join("|");
    const group = groups.get(key);
    if (group) {
      group.push(arrow.id);
      continue;
    }
    groups.set(key, [arrow.id]);
  }

  const fans = new Map<string, StudioShapeArrowFan>();
  for (const group of groups.values()) {
    group.forEach((arrowId, index) => {
      fans.set(arrowId, { index, count: group.length });
    });
  }
  return fans;
}

function createArrowElements(
  layer: SVGSVGElement,
  htmlLayer: HTMLElement,
  arrowId: string
): ArrowElements {
  const group = createStudioSvgElement(layer, "g");
  group.setAttribute("class", "ss-studio-shape-arrow");
  group.dataset.arrowId = arrowId;

  const hit = createStudioSvgElement(layer, "path");
  hit.setAttribute("class", "ss-studio-shape-arrow-hit");
  group.appendChild(hit);

  const line = createStudioSvgElement(layer, "path");
  line.setAttribute("class", "ss-studio-shape-arrow-line");
  group.appendChild(line);

  const head = createStudioSvgElement(layer, "path");
  head.setAttribute("class", "ss-studio-shape-arrow-head");
  group.appendChild(head);

  // The label is HTML, not SVG text, so it edits in place like a shape label.
  const label = htmlLayer.createDiv({ cls: "ss-studio-shape-arrow-label" });
  label.dataset.arrowId = arrowId;

  return { group, hit, line, head, label };
}

/** Visual arrows land anywhere on an item within this canvas, including its children. */
function resolveItemIdAtPoint(canvasEl: HTMLElement, event: PointerEvent): string | null {
  const released = canvasEl.ownerDocument.elementFromPoint?.(event.clientX, event.clientY);
  const itemEl = released?.closest<HTMLElement>(".ss-studio-shape, .ss-studio-node-card");
  if (!itemEl || !canvasEl.contains(itemEl)) return null;
  return itemEl.dataset.shapeId || itemEl.dataset.nodeId || null;
}

/** jsdom has no innerText; normalize NBSP and CRLF so the model stays plain \n text. */
function readStudioLabelText(labelEl: HTMLElement): string {
  const raw = labelEl.innerText ?? labelEl.textContent ?? "";
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function selectAllLabelText(labelEl: HTMLElement): void {
  const ownerDocument = labelEl.ownerDocument;
  const selection = ownerDocument.defaultView?.getSelection?.();
  if (!selection || typeof ownerDocument.createRange !== "function") {
    return;
  }
  const range = ownerDocument.createRange();
  range.selectNodeContents(labelEl);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * In-place multiline label editing, shared by shapes and arrows: the label
 * element itself becomes editable, so the text never moves or re-wraps between
 * viewing and typing. Plain Enter inserts a newline; Cmd/Ctrl+Enter or leaving
 * the field commits; Escape reverts.
 */
function editStudioDiagramLabel(options: {
  labelEl: HTMLElement;
  initial: string;
  testid: string;
  commit: (label: string) => void;
}): void {
  const { labelEl, initial, commit } = options;
  if (labelEl.classList.contains("is-editing")) {
    return;
  }
  labelEl.classList.add("is-editing");
  labelEl.setAttribute("data-testid", options.testid);
  try {
    labelEl.contentEditable = "plaintext-only";
  } catch {
    // A host without plaintext-only rejects the assignment; rich mode still
    // reads back as plain text through innerText.
    labelEl.contentEditable = "true";
  }
  labelEl.textContent = initial;
  labelEl.focus();
  selectAllLabelText(labelEl);

  let settled = false;
  const stop = (event: Event): void => event.stopPropagation();
  const close = (nextLabel: string | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    labelEl.removeEventListener("keydown", onKeyDown);
    labelEl.removeEventListener("blur", onBlur);
    labelEl.removeEventListener("pointerdown", stop);
    labelEl.removeEventListener("dblclick", stop);
    labelEl.removeAttribute("contenteditable");
    labelEl.removeAttribute("data-testid");
    labelEl.classList.remove("is-editing");
    labelEl.textContent = nextLabel === null ? initial : nextLabel;
    if (nextLabel !== null && nextLabel !== initial) {
      commit(nextLabel);
    }
  };

  function onKeyDown(event: KeyboardEvent): void {
    // Canvas hotkeys (delete selection, tools) must never fire while typing.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close(null);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      close(readStudioLabelText(labelEl));
    }
    // Plain Enter falls through and inserts a newline.
  }

  function onBlur(): void {
    close(readStudioLabelText(labelEl));
  }

  labelEl.addEventListener("keydown", onKeyDown);
  labelEl.addEventListener("blur", onBlur);
  labelEl.addEventListener("pointerdown", stop);
  labelEl.addEventListener("dblclick", stop);
}
