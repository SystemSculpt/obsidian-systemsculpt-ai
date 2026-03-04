import type { StudioNodeInstance } from "../../../studio/types";
import {
  STUDIO_GRAPH_TERMINAL_MAX_HEIGHT,
  STUDIO_GRAPH_TERMINAL_MAX_WIDTH,
  STUDIO_GRAPH_TERMINAL_MIN_HEIGHT,
  STUDIO_GRAPH_TERMINAL_MIN_WIDTH,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
} from "../graph-v3/StudioGraphNodeGeometry";
import { applyTerminalNodeSize, clampTerminalInt } from "./StudioTerminalNodeConfig";

type StudioTerminalResizeHandleOptions = {
  node: StudioNodeInstance;
  nodeEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  getGraphZoom: () => number;
};

export function mountTerminalResizeHandle(options: StudioTerminalResizeHandleOptions): () => void {
  const { node, nodeEl, interactionLocked, onNodeConfigMutated, onNodeGeometryMutated, getGraphZoom } = options;
  const handleEl = nodeEl.createDiv({
    cls: "ss-studio-terminal-resize-handle",
    attr: {
      title: "Resize terminal node",
      "aria-label": "Resize terminal node",
    },
  });

  let moveListener: ((event: PointerEvent) => void) | null = null;
  let finishListener: ((event: PointerEvent) => void) | null = null;

  handleEl.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    if (interactionLocked || pointerEvent.button !== 0) {
      return;
    }
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();

    const pointerId = pointerEvent.pointerId;
    const startX = pointerEvent.clientX;
    const startY = pointerEvent.clientY;
    const startWidth = resolveStudioGraphNodeWidth(node);
    const startHeight = resolveStudioGraphNodeMinHeight(node);

    moveListener = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const zoom = getGraphZoom() || 1;
      const nextWidth = clampTerminalInt(
        startWidth + (moveEvent.clientX - startX) / zoom,
        startWidth,
        STUDIO_GRAPH_TERMINAL_MIN_WIDTH,
        STUDIO_GRAPH_TERMINAL_MAX_WIDTH
      );
      const nextHeight = clampTerminalInt(
        startHeight + (moveEvent.clientY - startY) / zoom,
        startHeight,
        STUDIO_GRAPH_TERMINAL_MIN_HEIGHT,
        STUDIO_GRAPH_TERMINAL_MAX_HEIGHT
      );
      node.config.width = nextWidth;
      node.config.height = nextHeight;
      applyTerminalNodeSize(node, nodeEl);
      onNodeGeometryMutated(node);
    };

    finishListener = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) {
        return;
      }
      if (moveListener) {
        window.removeEventListener("pointermove", moveListener);
      }
      if (finishListener) {
        window.removeEventListener("pointerup", finishListener);
        window.removeEventListener("pointercancel", finishListener);
      }
      moveListener = null;
      finishListener = null;
      onNodeConfigMutated(node);
      onNodeGeometryMutated(node);
    };

    window.addEventListener("pointermove", moveListener);
    window.addEventListener("pointerup", finishListener);
    window.addEventListener("pointercancel", finishListener);
  });

  return () => {
    if (moveListener) {
      window.removeEventListener("pointermove", moveListener);
    }
    if (finishListener) {
      window.removeEventListener("pointerup", finishListener);
      window.removeEventListener("pointercancel", finishListener);
    }
  };
}
