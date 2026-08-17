import { createStudioSvgElement, getStudioOwnerWindow } from "../StudioDomContext";
import { buildStudioShapeOutline } from "./StudioShapeOutline";
import { resolveStudioGraphSafeZoom } from "../../../studio/StudioNodeGeometry";
import type { StudioShapeKind } from "../../../studio/types";

/**
 * Freeform shape drawing (tldraw parity): with a shape tool armed, a canvas
 * drag paints a live preview and commits the drawn bounds on release. A tap
 * (no meaningful drag) falls back to the kind's default size at that point,
 * so a click still produces a usable shape.
 */

const STUDIO_SHAPE_DRAW_TAP_SLOP_PX = 6;

export type StudioShapeDrawRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StudioShapeDrawGestureOptions = {
  canvasEl: HTMLElement;
  startEvent: PointerEvent;
  shape: StudioShapeKind;
  getGraphZoom: () => number;
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
  onCommit: (rect: StudioShapeDrawRect) => void;
  onCancel?: () => void;
};

function graphPointFromClient(
  canvasEl: HTMLElement,
  zoom: number,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const canvasRect = canvasEl.getBoundingClientRect();
  return {
    x: (clientX - canvasRect.left) / zoom,
    y: (clientY - canvasRect.top) / zoom,
  };
}

export function startStudioShapeDrawGesture(options: StudioShapeDrawGestureOptions): void {
  const {
    canvasEl,
    startEvent,
    shape,
    getGraphZoom,
    minWidth,
    minHeight,
    defaultWidth,
    defaultHeight,
    onCommit,
    onCancel,
  } = options;

  const ownerWindow = getStudioOwnerWindow(canvasEl);
  const startPoint = graphPointFromClient(
    canvasEl,
    resolveStudioGraphSafeZoom(getGraphZoom()),
    startEvent.clientX,
    startEvent.clientY
  );

  const previewEl = canvasEl.createDiv({ cls: "ss-studio-shape-draw-preview" });
  previewEl.dataset.shape = shape;
  // The preview draws the kind's real outline, so a diamond never previews as
  // the box it was dragged from.
  const previewOutline = createStudioSvgElement(previewEl, "svg");
  previewOutline.setAttribute("class", "ss-studio-shape-draw-preview-outline");
  previewEl.appendChild(previewOutline);
  const previewPath = createStudioSvgElement(previewEl, "path");
  previewPath.setAttribute("class", "ss-studio-shape-draw-preview-path");
  previewOutline.appendChild(previewPath);

  let currentRect: StudioShapeDrawRect = {
    x: startPoint.x,
    y: startPoint.y,
    width: 0,
    height: 0,
  };
  let settled = false;

  const applyPreview = (rect: StudioShapeDrawRect): void => {
    previewEl.style.left = `${rect.x}px`;
    previewEl.style.top = `${rect.y}px`;
    previewEl.style.width = `${rect.width}px`;
    previewEl.style.height = `${rect.height}px`;
    previewOutline.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    previewOutline.setAttribute("width", `${rect.width}`);
    previewOutline.setAttribute("height", `${rect.height}`);
    previewPath.setAttribute("d", buildStudioShapeOutline(shape, rect).body);
  };
  applyPreview(currentRect);

  const readRect = (event: PointerEvent): StudioShapeDrawRect => {
    const point = graphPointFromClient(
      canvasEl,
      resolveStudioGraphSafeZoom(getGraphZoom()),
      event.clientX,
      event.clientY
    );
    return {
      x: Math.min(startPoint.x, point.x),
      y: Math.min(startPoint.y, point.y),
      width: Math.abs(point.x - startPoint.x),
      height: Math.abs(point.y - startPoint.y),
    };
  };

  const cleanup = (): void => {
    previewEl.remove();
    ownerWindow.removeEventListener("pointermove", onMove);
    ownerWindow.removeEventListener("pointerup", onEnd);
    ownerWindow.removeEventListener("pointercancel", onCancelled);
    ownerWindow.removeEventListener("keydown", onKeyDown);
  };

  function onMove(event: PointerEvent): void {
    if (settled || event.pointerId !== startEvent.pointerId) {
      return;
    }
    currentRect = readRect(event);
    applyPreview(currentRect);
  }

  function onEnd(event: PointerEvent): void {
    if (settled || event.pointerId !== startEvent.pointerId) {
      return;
    }
    settled = true;
    currentRect = readRect(event);
    cleanup();
    const isTap =
      currentRect.width < STUDIO_SHAPE_DRAW_TAP_SLOP_PX
      && currentRect.height < STUDIO_SHAPE_DRAW_TAP_SLOP_PX;
    if (isTap) {
      onCommit({
        x: startPoint.x - defaultWidth * 0.5,
        y: startPoint.y - defaultHeight * 0.5,
        width: defaultWidth,
        height: defaultHeight,
      });
      return;
    }
    // A drawn box smaller than the shape minimum keeps its drawn origin and
    // grows to the minimum rather than collapsing to nothing.
    onCommit({
      x: currentRect.x,
      y: currentRect.y,
      width: Math.max(minWidth, currentRect.width),
      height: Math.max(minHeight, currentRect.height),
    });
  }

  function onCancelled(event: PointerEvent): void {
    if (settled || event.pointerId !== startEvent.pointerId) {
      return;
    }
    settled = true;
    cleanup();
    onCancel?.();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (settled || event.key !== "Escape") {
      return;
    }
    settled = true;
    cleanup();
    onCancel?.();
  }

  ownerWindow.addEventListener("pointermove", onMove);
  ownerWindow.addEventListener("pointerup", onEnd);
  ownerWindow.addEventListener("pointercancel", onCancelled);
  ownerWindow.addEventListener("keydown", onKeyDown);
}
