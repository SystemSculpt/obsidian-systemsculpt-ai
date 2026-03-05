import type { StudioNodeInstance } from "../../../studio/types";
import {
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeResizeBounds,
  resolveStudioGraphNodeWidth,
} from "./StudioGraphNodeGeometry";

type StudioGraphNodeSize = {
  width: number;
  height: number;
};

type MountStudioGraphNodeResizeHandleOptions = {
  node: StudioNodeInstance;
  nodeEl: HTMLElement;
  handleClassName?: string;
  title: string;
  ariaLabel: string;
  interactionLocked: boolean;
  getGraphZoom: () => number;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  applySize: (size: StudioGraphNodeSize) => void;
  readInitialSize?: () => StudioGraphNodeSize;
  commitConfigOnMove?: boolean;
};

function clampRounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveSafeZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0.1, value);
}

function readInitialSizeFromNode(node: StudioNodeInstance, nodeEl: HTMLElement): StudioGraphNodeSize {
  const measuredWidth = nodeEl.offsetWidth;
  const measuredHeight = nodeEl.offsetHeight;
  return {
    width: measuredWidth > 0 ? measuredWidth : resolveStudioGraphNodeWidth(node),
    height:
      measuredHeight > 0
        ? measuredHeight
        : Math.max(resolveStudioGraphNodeMinHeight(node), 1),
  };
}

export function mountStudioGraphNodeResizeHandle(
  options: MountStudioGraphNodeResizeHandleOptions
): () => void {
  const classes = ["ss-studio-node-resize-handle"];
  const extraClass = String(options.handleClassName || "").trim();
  if (extraClass.length > 0) {
    classes.push(...extraClass.split(/\s+/g).filter((value) => value.length > 0));
  }
  options.nodeEl.addClass("has-resize-handle");
  const handleEl = options.nodeEl.createDiv({
    cls: classes.join(" "),
    attr: {
      title: options.title,
      "aria-label": options.ariaLabel,
      role: "slider",
    },
  });

  handleEl.classList.toggle("is-disabled", options.interactionLocked);
  if (options.interactionLocked) {
    return () => {
      options.nodeEl.removeClass("has-resize-handle");
      handleEl.remove();
    };
  }

  const nodeConfig = options.node.config as Record<string, unknown>;
  let activePointerId: number | null = null;
  let frameId: number | null = null;
  let startClientX = 0;
  let startClientY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let pendingWidth = 0;
  let pendingHeight = 0;
  let didMutateDuringDrag = false;

  const applyPendingSize = (): void => {
    frameId = null;
    if (activePointerId === null) {
      return;
    }
    const bounds = resolveStudioGraphNodeResizeBounds(options.node);
    const nextWidth = clampRounded(pendingWidth, bounds.minWidth, bounds.maxWidth);
    const nextHeight = clampRounded(pendingHeight, bounds.minHeight, bounds.maxHeight);
    const previousWidth = Number(nodeConfig.width);
    const previousHeight = Number(nodeConfig.height);
    if (previousWidth === nextWidth && previousHeight === nextHeight) {
      return;
    }
    nodeConfig.width = nextWidth;
    nodeConfig.height = nextHeight;
    options.applySize({
      width: nextWidth,
      height: nextHeight,
    });
    options.onNodeGeometryMutated(options.node);
    if (options.commitConfigOnMove === true) {
      options.onNodeConfigMutated(options.node);
    }
    didMutateDuringDrag = true;
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
    if (typeof handleEl.releasePointerCapture === "function") {
      try {
        handleEl.releasePointerCapture(activePointerId);
      } catch {
        // Ignore release errors from detached pointers.
      }
    }
    activePointerId = null;
    handleEl.classList.remove("is-active");
    if (options.commitConfigOnMove !== true && didMutateDuringDrag) {
      options.onNodeConfigMutated(options.node);
    }
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
    if (event.button !== 0 || activePointerId !== null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    activePointerId = event.pointerId;
    didMutateDuringDrag = false;
    startClientX = event.clientX;
    startClientY = event.clientY;
    const initialSize = options.readInitialSize
      ? options.readInitialSize()
      : readInitialSizeFromNode(options.node, options.nodeEl);
    startWidth = initialSize.width;
    startHeight = initialSize.height;
    pendingWidth = startWidth;
    pendingHeight = startHeight;
    handleEl.classList.add("is-active");
    if (typeof handleEl.setPointerCapture === "function") {
      try {
        handleEl.setPointerCapture(activePointerId);
      } catch {
        // Ignore capture errors; window listeners are fallback.
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerFinish);
    window.addEventListener("pointercancel", onPointerFinish);
  };

  handleEl.addEventListener("pointerdown", onPointerDown);

  return () => {
    handleEl.removeEventListener("pointerdown", onPointerDown);
    stopTracking();
    options.nodeEl.removeClass("has-resize-handle");
    handleEl.remove();
  };
}
