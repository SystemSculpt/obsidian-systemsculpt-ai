import type { StudioNodeInstance } from "../../../studio/types";
import {
  STUDIO_GRAPH_TERMINAL_MAX_HEIGHT,
  STUDIO_GRAPH_TERMINAL_MAX_WIDTH,
  STUDIO_GRAPH_TERMINAL_MIN_HEIGHT,
  STUDIO_GRAPH_TERMINAL_MIN_WIDTH,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
} from "../graph-v3/StudioGraphNodeGeometry";
import { applyTerminalNodeSize } from "./StudioTerminalNodeConfig";

type StudioTerminalResizeHandleOptions = {
  node: StudioNodeInstance;
  nodeEl: HTMLElement;
  sizeTargets: HTMLElement[];
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  getGraphZoom: () => number;
};

function clampSize(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveSafeZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0.1, value);
}

export function mountTerminalResizeHandle(options: StudioTerminalResizeHandleOptions): () => void {
  const handleEl = options.nodeEl.createDiv({
    cls: "ss-studio-terminal-resize-handle",
    attr: {
      title: "Resize terminal node",
      "aria-label": "Resize terminal node",
      role: "slider",
    },
  });

  handleEl.classList.toggle("is-disabled", options.interactionLocked);
  if (options.interactionLocked) {
    return () => {
      handleEl.remove();
    };
  }

  const nodeConfig = options.node.config as Record<string, unknown>;

  let activePointerId: number | null = null;
  let startClientX = 0;
  let startClientY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let pendingWidth = 0;
  let pendingHeight = 0;
  let frameId: number | null = null;

  const applyPendingSize = (): void => {
    frameId = null;
    const nextWidth = clampSize(pendingWidth, STUDIO_GRAPH_TERMINAL_MIN_WIDTH, STUDIO_GRAPH_TERMINAL_MAX_WIDTH);
    const nextHeight = clampSize(pendingHeight, STUDIO_GRAPH_TERMINAL_MIN_HEIGHT, STUDIO_GRAPH_TERMINAL_MAX_HEIGHT);
    const previousWidth = Number(nodeConfig.width);
    const previousHeight = Number(nodeConfig.height);
    if (previousWidth === nextWidth && previousHeight === nextHeight) {
      return;
    }
    nodeConfig.width = nextWidth;
    nodeConfig.height = nextHeight;
    for (const targetEl of options.sizeTargets) {
      applyTerminalNodeSize(options.node, targetEl);
    }
    options.onNodeConfigMutated(options.node);
    options.onNodeGeometryMutated(options.node);
  };

  const scheduleApply = (): void => {
    if (frameId !== null) {
      return;
    }
    frameId = window.requestAnimationFrame(applyPendingSize);
  };

  const stopTracking = (): void => {
    if (activePointerId === null) {
      return;
    }
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
      applyPendingSize();
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerFinish);
    window.removeEventListener("pointercancel", onPointerFinish);
    activePointerId = null;
    handleEl.classList.remove("is-active");
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointerId === null || event.pointerId !== activePointerId) {
      return;
    }
    const zoom = resolveSafeZoom(options.getGraphZoom());
    const deltaX = (event.clientX - startClientX) / zoom;
    const deltaY = (event.clientY - startClientY) / zoom;
    pendingWidth = startWidth + deltaX;
    pendingHeight = startHeight + deltaY;
    scheduleApply();
  };

  const onPointerFinish = (event: PointerEvent): void => {
    if (activePointerId === null || event.pointerId !== activePointerId) {
      return;
    }
    stopTracking();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    activePointerId = event.pointerId;
    startClientX = event.clientX;
    startClientY = event.clientY;
    startWidth = resolveStudioGraphNodeWidth(options.node);
    startHeight = resolveStudioGraphNodeMinHeight(options.node);
    pendingWidth = startWidth;
    pendingHeight = startHeight;

    handleEl.classList.add("is-active");

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerFinish);
    window.addEventListener("pointercancel", onPointerFinish);
  };

  handleEl.addEventListener("pointerdown", onPointerDown);

  return () => {
    handleEl.removeEventListener("pointerdown", onPointerDown);
    stopTracking();
    handleEl.remove();
  };
}
