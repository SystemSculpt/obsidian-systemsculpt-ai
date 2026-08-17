import type { StudioDiagram, StudioShapeInstance } from "../../../studio/types";
import { clampStudioShapeHeight, clampStudioShapeWidth } from "../../../studio/StudioShapes";
import { resolveStudioGraphSafeZoom } from "../../../studio/StudioNodeGeometry";
import { createStudioSvgElement, getStudioOwnerWindow } from "../StudioDomContext";
import type { StudioCanvasTool } from "../StudioCanvasTool";
import {
  buildStudioShapeArrowPath,
  buildStudioShapeArrowPreviewPath,
  type StudioShapeArrowFan,
} from "./StudioShapeGeometry";
import { buildStudioShapeOutline } from "./StudioShapeOutline";

/**
 * The diagram layer: shapes and the arrows between them, rendered and driven
 * entirely on its own. It shares the canvas element with the node graph and
 * nothing else — no ports, no links, no node selection, no run state.
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
export type StudioShapeDragPhase = { first: boolean; final: boolean };

export type StudioShapeLayerOptions = {
  canvasEl: HTMLElement;
  diagram: StudioDiagram;
  busy: boolean;
  activeCanvasTool: StudioCanvasTool;
  selection: StudioShapeSelection;
  getGraphZoom: () => number;
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
  applyShapePositions: (
    positions: ReadonlyArray<{ shapeId: string; position: { x: number; y: number } }>
  ) => void;
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
  const { canvasEl, diagram, busy, activeCanvasTool, selection, getGraphZoom } = options;
  const ownerWindow = getStudioOwnerWindow(canvasEl);
  const selectedShapeIds = new Set(selection.shapeIds);
  const selectedArrowIds = new Set(selection.arrowIds);

  const layerEl = canvasEl.createDiv({ cls: "ss-studio-shapes-layer" });
  const arrowsLayer = createStudioSvgElement(layerEl, "svg");
  arrowsLayer.setAttribute("class", "ss-studio-shape-arrows-layer");
  layerEl.appendChild(arrowsLayer);

  // Working copy: gestures mutate this, never the project, until they commit.
  const shapesById = new Map<string, StudioShapeInstance>(
    diagram.shapes.map((shape) => [
      shape.id,
      { ...shape, position: { ...shape.position }, size: { ...shape.size } },
    ])
  );
  const shapeElements = new Map<string, ShapeElements>();
  const arrowElements = new Map<string, ArrowElements>();
  const arrowFans = resolveArrowFans(diagram);
  let previewPath: SVGPathElement | null = null;

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

  const renderArrows = (): void => {
    const seen = new Set<string>();
    for (const arrow of diagram.arrows) {
      const from = shapesById.get(arrow.fromShapeId);
      const to = shapesById.get(arrow.toShapeId);
      if (!from || !to) {
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
          if (busy) {
            return;
          }
          event.stopPropagation();
          options.onSelect({ type: "arrow", id: arrow.id }, { additive: isAdditive(event) });
        });
        created.label.addEventListener("pointerdown", (event) => {
          if (busy) {
            return;
          }
          event.stopPropagation();
          options.onSelect({ type: "arrow", id: arrow.id }, { additive: isAdditive(event) });
        });
        const editLabel = (event: Event): void => {
          if (busy) {
            return;
          }
          event.stopPropagation();
          event.preventDefault();
          editStudioDiagramLabel({
            labelEl: created.label,
            initial: arrow.label || "",
            testid: "studio.arrow.label-editor",
            commit: (label) => options.onArrowLabelChange(arrow.id, label),
          });
        };
        created.hit.addEventListener("dblclick", editLabel);
        created.label.addEventListener("dblclick", editLabel);
      }
      elements.group.classList.toggle("is-selected", selectedArrowIds.has(arrow.id));
      elements.label.classList.toggle("is-selected", selectedArrowIds.has(arrow.id));
      elements.hit.setAttribute("d", path.line);
      elements.line.setAttribute("d", path.line);
      elements.head.setAttribute("d", path.head);
      elements.label.style.left = `${path.mid.x}px`;
      elements.label.style.top = `${path.mid.y}px`;
      // A drag redraws arrows mid-edit; never clobber the text being typed.
      if (!elements.label.classList.contains("is-editing")) {
        elements.label.textContent = arrow.label || "";
      }
      seen.add(arrow.id);
    }
    for (const [arrowId, elements] of arrowElements) {
      if (seen.has(arrowId)) {
        continue;
      }
      elements.group.remove();
      elements.label.remove();
      arrowElements.delete(arrowId);
    }
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
    renderArrows();
  };

  const startMoveGesture = (shape: StudioShapeInstance, startEvent: PointerEvent): void => {
    const origin = graphPointFromClient(startEvent.clientX, startEvent.clientY);
    // Dragging a member of the selection drags the whole selection; dragging
    // anything else is that shape alone.
    const dragShapeIds = selectedShapeIds.has(shape.id) ? [...selectedShapeIds] : [shape.id];
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const shapeId of dragShapeIds) {
      const dragged = shapesById.get(shapeId);
      if (dragged) {
        startPositions.set(shapeId, { ...dragged.position });
      }
    }
    let activated = false;
    let lastDelta = { x: 0, y: 0 };

    const finish = (commit: boolean): void => {
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onUp);
      ownerWindow.removeEventListener("pointercancel", onCancel);
      if (!activated) {
        return;
      }
      if (!commit) {
        translateShapes(dragShapeIds, startPositions, { x: 0, y: 0 });
        options.onMoveSelection({ x: 0, y: 0 }, { first: false, final: true });
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

    function onUp(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId) {
        return;
      }
      finish(true);
    }

    function onCancel(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId) {
        return;
      }
      finish(false);
    }

    ownerWindow.addEventListener("pointermove", onMove);
    ownerWindow.addEventListener("pointerup", onUp);
    ownerWindow.addEventListener("pointercancel", onCancel);
  };

  const startResizeGesture = (
    shape: StudioShapeInstance,
    corner: ResizeCorner,
    startEvent: PointerEvent
  ): void => {
    const origin = graphPointFromClient(startEvent.clientX, startEvent.clientY);
    const startRect: StudioShapeRect = {
      x: shape.position.x,
      y: shape.position.y,
      width: shape.size.width,
      height: shape.size.height,
    };

    const finish = (): void => {
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onUp);
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
      renderArrows();
    }

    function onUp(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId) {
        return;
      }
      finish();
    }

    ownerWindow.addEventListener("pointermove", onMove);
    ownerWindow.addEventListener("pointerup", onUp);
  };

  const startArrowGesture = (shape: StudioShapeInstance, startEvent: PointerEvent): void => {
    previewPath?.remove();
    previewPath = createStudioSvgElement(arrowsLayer, "path");
    previewPath.setAttribute("class", "ss-studio-shape-arrow-preview");
    arrowsLayer.appendChild(previewPath);

    const finish = (event: PointerEvent | null): void => {
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onUp);
      ownerWindow.removeEventListener("pointercancel", onCancel);
      previewPath?.remove();
      previewPath = null;
      const targetId = event ? resolveShapeIdAtPoint(canvasEl, event) : null;
      if (targetId && targetId !== shape.id) {
        options.onConnectShapes(shape.id, targetId);
      }
    };

    function onMove(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId || !previewPath) {
        return;
      }
      const cursor = graphPointFromClient(event.clientX, event.clientY);
      previewPath.setAttribute("d", buildStudioShapeArrowPreviewPath(shape, cursor).line);
    }

    function onUp(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId) {
        return;
      }
      finish(event);
    }

    function onCancel(event: PointerEvent): void {
      if (event.pointerId !== startEvent.pointerId) {
        return;
      }
      finish(null);
    }

    ownerWindow.addEventListener("pointermove", onMove);
    ownerWindow.addEventListener("pointerup", onUp);
    ownerWindow.addEventListener("pointercancel", onCancel);
  };

  for (const shape of shapesById.values()) {
    const shapeEl = layerEl.createDiv({ cls: "ss-studio-shape" });
    shapeEl.dataset.shapeId = shape.id;
    shapeEl.dataset.shape = shape.shape;
    shapeEl.classList.toggle("is-selected", selectedShapeIds.has(shape.id));
    shapeElements.set(shape.id, createShapeOutlineElements(shapeEl));
    applyShapeGeometry(shape);

    const labelEl = shapeEl.createDiv({ cls: "ss-studio-shape-label", text: shape.label });

    shapeEl.addEventListener("pointerdown", (event) => {
      if (busy || event.button !== 0) {
        return;
      }
      event.stopPropagation();
      if (activeCanvasTool === "arrow") {
        event.preventDefault();
        startArrowGesture(shape, event);
        return;
      }
      if (activeCanvasTool !== "select") {
        return;
      }
      options.onSelect({ type: "shape", id: shape.id }, { additive: isAdditive(event) });
      startMoveGesture(shape, event);
    });

    shapeEl.addEventListener("dblclick", (event) => {
      if (busy) {
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
      selectedShapeIds.size === 1 && selectedArrowIds.size === 0 && selectedShapeIds.has(shape.id);
    if (singleSelected && !busy) {
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
  }

  renderArrows();
  return {
    el: layerEl,
    applyShapePositions: (positions) => {
      for (const { shapeId, position } of positions) {
        const shape = shapesById.get(shapeId);
        if (!shape) {
          continue;
        }
        shape.position = { x: Math.round(position.x), y: Math.round(position.y) };
        applyShapeGeometry(shape);
      }
      renderArrows();
    },
  };
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

/** Shape under the release point, so an arrow lands anywhere on the target. */
function resolveShapeIdAtPoint(canvasEl: HTMLElement, event: PointerEvent): string | null {
  const ownerDocument = canvasEl.ownerDocument;
  if (typeof ownerDocument?.elementFromPoint !== "function") {
    return null;
  }
  const released = ownerDocument.elementFromPoint(event.clientX, event.clientY);
  const shapeEl =
    typeof released?.closest === "function"
      ? (released.closest(".ss-studio-shape") as HTMLElement | null)
      : null;
  return shapeEl?.dataset.shapeId || null;
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
