import type { StudioNodeInstance } from "../../../studio/types";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import {
  resolveStudioLabelFontSize,
  resolveStudioLabelHeight,
  resolveStudioLabelWidth,
  STUDIO_GRAPH_LABEL_DEFAULT_FONT_SIZE,
  STUDIO_GRAPH_LABEL_MAX_FONT_SIZE,
  STUDIO_GRAPH_LABEL_MIN_FONT_SIZE,
} from "./StudioGraphNodeGeometry";
import { mountStudioGraphNodeResizeHandle } from "./StudioGraphNodeResizeHandle";

const STUDIO_LABEL_DOUBLE_TAP_DELAY_MS = 450;
const STUDIO_LABEL_DOUBLE_TAP_SLOP_PX = 8;
const STUDIO_LABEL_TAP_DRAG_SLOP_PX = 3;

type LabelTapSnapshot = {
  at: number;
  clientX: number;
  clientY: number;
};

const lastLabelTapByNodeId = new Map<string, LabelTapSnapshot>();

type RenderLabelNodeCardOptions = {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  busy: boolean;
  graphInteraction: StudioGraphInteractionEngine;
  onRemoveNode: (nodeId: string) => void;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: string | number,
    options?: { mode?: "discrete" | "continuous"; captureHistory?: boolean }
  ) => void;
  onNodeSizeChange?: (
    nodeId: string,
    size: { width: number; height: number },
    options?: { mode?: "discrete" | "continuous"; captureHistory?: boolean }
  ) => void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  isEditing: boolean;
  shouldAutoFocus: boolean;
  onRequestLabelEdit: (nodeId: string) => void;
  onStopLabelEdit: (nodeId: string) => void;
};

function readLabelText(node: StudioNodeInstance): string {
  const value = node.config.value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function clampLabelMetric(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function isRepeatLabelTap(
  nodeId: string,
  event: PointerEvent,
  now: number
): boolean {
  const previousTap = lastLabelTapByNodeId.get(nodeId);
  if (!previousTap) {
    return false;
  }
  const elapsedMs = now - previousTap.at;
  if (elapsedMs < 0 || elapsedMs > STUDIO_LABEL_DOUBLE_TAP_DELAY_MS) {
    return false;
  }
  const travel = Math.hypot(
    event.clientX - previousTap.clientX,
    event.clientY - previousTap.clientY
  );
  return travel <= STUDIO_LABEL_DOUBLE_TAP_SLOP_PX;
}

function trackPotentialLabelTap(nodeId: string, event: PointerEvent, now: number): void {
  lastLabelTapByNodeId.set(nodeId, {
    at: now,
    clientX: event.clientX,
    clientY: event.clientY,
  });

  const pointerId = event.pointerId;
  const startClientX = event.clientX;
  const startClientY = event.clientY;
  const clearIfDragged = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) {
      return;
    }
    const travel = Math.hypot(
      moveEvent.clientX - startClientX,
      moveEvent.clientY - startClientY
    );
    if (travel <= STUDIO_LABEL_TAP_DRAG_SLOP_PX) {
      return;
    }
    lastLabelTapByNodeId.delete(nodeId);
    stopTracking();
  };
  const stopTracking = (finishEvent?: PointerEvent): void => {
    if (finishEvent && finishEvent.pointerId !== pointerId) {
      return;
    }
    window.removeEventListener("pointermove", clearIfDragged);
    window.removeEventListener("pointerup", stopTracking);
    window.removeEventListener("pointercancel", stopTracking);
  };

  window.addEventListener("pointermove", clearIfDragged);
  window.addEventListener("pointerup", stopTracking);
  window.addEventListener("pointercancel", stopTracking);
}

export function renderLabelNodeCard(options: RenderLabelNodeCardOptions): void {
  const {
    nodeEl,
    node,
    busy,
    graphInteraction,
    onRemoveNode,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeSizeChange,
    onNodeGeometryMutated,
    isEditing,
    shouldAutoFocus,
    onRequestLabelEdit,
    onStopLabelEdit,
  } = options;

  nodeEl.addClass("ss-studio-label-card");
  const applyDimensions = (): void => {
    const width = resolveStudioLabelWidth(node);
    const height = resolveStudioLabelHeight(node);
    nodeEl.style.width = `${width}px`;
    nodeEl.style.height = `${height}px`;
  };
  applyDimensions();

  const toolbarEl = nodeEl.createDiv({ cls: "ss-studio-label-toolbar" });
  const fontControlsEl = toolbarEl.createDiv({ cls: "ss-studio-label-font-controls" });

  const decreaseButton = fontControlsEl.createEl("button", {
    cls: "ss-studio-label-font-button",
    text: "A-",
    attr: {
      title: "Decrease label text size",
      "aria-label": "Decrease label text size",
    },
  });
  decreaseButton.type = "button";
  const increaseButton = fontControlsEl.createEl("button", {
    cls: "ss-studio-label-font-button",
    text: "A+",
    attr: {
      title: "Increase label text size",
      "aria-label": "Increase label text size",
    },
  });
  increaseButton.type = "button";
  const removeButton = toolbarEl.createEl("button", {
    cls: "ss-studio-label-remove",
    text: "×",
    attr: {
      title: "Delete label",
      "aria-label": "Delete label",
    },
  });
  removeButton.type = "button";

  decreaseButton.disabled = busy;
  increaseButton.disabled = busy;
  removeButton.disabled = busy;

  const getCurrentFontSize = (): number => resolveStudioLabelFontSize(node);
  let textSurfaceEl: HTMLElement | HTMLTextAreaElement | null = null;
  const applyFontSize = (fontSize: number): void => {
    if (textSurfaceEl) {
      textSurfaceEl.style.setProperty("--ss-studio-label-font-size", `${fontSize}px`);
    }
  };
  const commitFontSize = (next: number): void => {
    const normalized = clampLabelMetric(
      next,
      STUDIO_GRAPH_LABEL_MIN_FONT_SIZE,
      STUDIO_GRAPH_LABEL_MAX_FONT_SIZE
    );
    applyFontSize(normalized);
    if (onNodeConfigValueChange) {
      onNodeConfigValueChange(node.id, "fontSize", normalized, { mode: "discrete" });
      return;
    }
    node.config.fontSize = normalized;
    onNodeConfigMutated(node);
  };
  decreaseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    commitFontSize(getCurrentFontSize() - 1);
  });
  increaseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    commitFontSize(getCurrentFontSize() + 1);
  });
  removeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRemoveNode(node.id);
  });

  const contentEl = nodeEl.createDiv({ cls: "ss-studio-label-content" });
  const labelText = readLabelText(node);
  const fontSize = getCurrentFontSize() || STUDIO_GRAPH_LABEL_DEFAULT_FONT_SIZE;

  if (isEditing) {
    const textAreaEl = contentEl.createEl("textarea", {
      cls: "ss-studio-label-editor",
      attr: {
        "aria-label": `${node.title || "Label"} content`,
      },
    });
    textAreaEl.value = labelText;
    textAreaEl.disabled = busy;
    textSurfaceEl = textAreaEl;
    applyFontSize(fontSize);
    textAreaEl.addEventListener("input", (event) => {
      const nextValue = (event.target as HTMLTextAreaElement).value;
      if (onNodeConfigValueChange) {
        onNodeConfigValueChange(node.id, "value", nextValue, { mode: "continuous" });
        return;
      }
      node.config.value = nextValue;
      onNodeConfigMutated(node);
    });
    textAreaEl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      textAreaEl.blur();
    });
    textAreaEl.addEventListener("blur", () => {
      onStopLabelEdit(node.id);
    });
    if (shouldAutoFocus && !busy) {
      window.requestAnimationFrame(() => {
        textAreaEl.focus();
        textAreaEl.select();
      });
    }
  } else {
    const displayEl = contentEl.createDiv({
      cls: "ss-studio-label-display",
      text: labelText.trim().length > 0 ? labelText : "Label",
    });
    textSurfaceEl = displayEl;
    applyFontSize(fontSize);
    displayEl.addEventListener("pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.button !== 0) {
        return;
      }
      event.stopPropagation();
      if (pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey) {
        lastLabelTapByNodeId.delete(node.id);
        graphInteraction.toggleNodeSelection(node.id);
        return;
      }
      const now = Date.now();
      if (isRepeatLabelTap(node.id, pointerEvent, now)) {
        event.preventDefault();
        lastLabelTapByNodeId.delete(node.id);
        graphInteraction.ensureSingleSelection(node.id);
        onRequestLabelEdit(node.id);
        return;
      }
      trackPotentialLabelTap(node.id, pointerEvent, now);
      graphInteraction.startNodeDrag(node.id, pointerEvent, nodeEl);
    });
    displayEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      lastLabelTapByNodeId.delete(node.id);
      graphInteraction.ensureSingleSelection(node.id);
      onRequestLabelEdit(node.id);
    });
  }

  mountStudioGraphNodeResizeHandle({
    node,
    nodeEl,
    handleClassName: "ss-studio-label-resize-handle",
    title: "Resize label",
    ariaLabel: "Resize label",
    interactionLocked: busy,
    getGraphZoom: () => graphInteraction.getGraphZoom(),
    onNodeConfigMutated,
    onNodeSizeChange,
    onNodeGeometryMutated,
    applySize: ({ width, height }) => {
      nodeEl.style.width = `${width}px`;
      nodeEl.style.height = `${height}px`;
    },
    readInitialSize: () => ({
      width: resolveStudioLabelWidth(node),
      height: resolveStudioLabelHeight(node),
    }),
  });
}
