import type { StudioNodeInstance } from "../../../studio/types";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import type {
  StudioGraphNodeMutationOptions,
  StudioGraphNodeResizePatch,
} from "./StudioGraphNodeCardTypes";
import {
  resolveStudioTextNodeFontSize,
  resolveStudioTextNodeHeight,
  resolveStudioTextNodeWidth,
  STUDIO_GRAPH_TEXT_NODE_DEFAULT_FONT_SIZE,
} from "../../../studio/StudioNodeGeometry";
import { mountStudioGraphNodeResizeFrame } from "./StudioGraphNodeResizeFrame";

const STUDIO_TEXT_NODE_DOUBLE_TAP_DELAY_MS = 450;
const STUDIO_TEXT_NODE_DOUBLE_TAP_SLOP_PX = 8;
const STUDIO_TEXT_NODE_TAP_DRAG_SLOP_PX = 3;

type TextNodeTapSnapshot = {
  at: number;
  clientX: number;
  clientY: number;
};

const lastTextNodeTapByNodeId = new Map<string, TextNodeTapSnapshot>();

type RenderTextNodeCardOptions = {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  busy: boolean;
  graphInteraction: StudioGraphInteractionEngine;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: string | number,
    options?: { mode?: "discrete" | "continuous"; captureHistory?: boolean }
  ) => void;
  onNodeResize?: (
    nodeId: string,
    patch: StudioGraphNodeResizePatch,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  isEditing: boolean;
  shouldAutoFocus: boolean;
  onRequestTextNodeEdit: (nodeId: string) => void;
  onStopTextNodeEdit: (nodeId: string) => void;
};

/**
 * Canonical reader for a `studio.text` node's text value. Shared with the
 * view's empty-on-edit-end cleanup so both surfaces agree on what counts
 * as the node's content.
 */
export function readStudioTextNodeValue(node: StudioNodeInstance): string {
  const value = node.config.value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function isRepeatTextNodeTap(
  nodeId: string,
  event: PointerEvent,
  now: number
): boolean {
  const previousTap = lastTextNodeTapByNodeId.get(nodeId);
  if (!previousTap) {
    return false;
  }
  const elapsedMs = now - previousTap.at;
  if (elapsedMs < 0 || elapsedMs > STUDIO_TEXT_NODE_DOUBLE_TAP_DELAY_MS) {
    return false;
  }
  const travel = Math.hypot(
    event.clientX - previousTap.clientX,
    event.clientY - previousTap.clientY
  );
  return travel <= STUDIO_TEXT_NODE_DOUBLE_TAP_SLOP_PX;
}

function trackPotentialTextNodeTap(nodeId: string, event: PointerEvent, now: number): void {
  lastTextNodeTapByNodeId.set(nodeId, {
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
    if (travel <= STUDIO_TEXT_NODE_TAP_DRAG_SLOP_PX) {
      return;
    }
    lastTextNodeTapByNodeId.delete(nodeId);
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

export function renderTextNodeCard(options: RenderTextNodeCardOptions): void {
  const {
    nodeEl,
    node,
    busy,
    graphInteraction,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeResize,
    onNodeGeometryMutated,
    isEditing,
    shouldAutoFocus,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
  } = options;

  nodeEl.addClass("ss-studio-text-node-card");
  // Width is the wrap width; height is INTRINSIC — the card auto-grows with
  // its reflowed content (tldraw-style), so no explicit height is rendered.
  nodeEl.style.width = `${resolveStudioTextNodeWidth(node)}px`;

  // No chrome at all — tldraw parity: deleting goes through select +
  // Delete/Backspace/cut, and font size is drag-scaled via the resize frame
  // (top/bottom edges and corners).
  const getCurrentFontSize = (): number => resolveStudioTextNodeFontSize(node);
  let textSurfaceEl: HTMLElement | HTMLTextAreaElement | null = null;
  const applyFontSize = (fontSize: number): void => {
    if (textSurfaceEl) {
      textSurfaceEl.style.setProperty("--ss-studio-text-node-font-size", `${fontSize}px`);
    }
  };

  const contentEl = nodeEl.createDiv({ cls: "ss-studio-text-node-content" });
  const textValue = readStudioTextNodeValue(node);
  const fontSize = getCurrentFontSize() || STUDIO_GRAPH_TEXT_NODE_DEFAULT_FONT_SIZE;

  if (isEditing) {
    const textAreaEl = contentEl.createEl("textarea", {
      cls: "ss-studio-text-node-editor",
      attr: {
        "aria-label": `${node.title || "Text"} content`,
        placeholder: "Text",
      },
    });
    // A textarea defaults to rows="2", which makes an EMPTY editor's
    // scrollHeight two lines tall — the auto-grow sync below then locks a
    // fresh one-line text node at double height. One row is the true floor.
    textAreaEl.rows = 1;
    textAreaEl.value = textValue;
    textAreaEl.disabled = busy;
    textSurfaceEl = textAreaEl;
    applyFontSize(fontSize);
    // The card's height is intrinsic, so the editor must auto-grow with its
    // content exactly like the display surface reflows: keep the textarea's
    // height synced to its scrollHeight while typing.
    const syncEditorHeight = (): void => {
      textAreaEl.style.height = "auto";
      const scrollHeight = textAreaEl.scrollHeight;
      if (scrollHeight > 0) {
        textAreaEl.style.height = `${scrollHeight}px`;
      }
    };
    syncEditorHeight();
    textAreaEl.addEventListener("input", (event) => {
      syncEditorHeight();
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
      onStopTextNodeEdit(node.id);
    });
    if (shouldAutoFocus && !busy) {
      window.requestAnimationFrame(() => {
        textAreaEl.focus();
        textAreaEl.select();
      });
    }
  } else {
    const hasText = textValue.trim().length > 0;
    const displayEl = contentEl.createDiv({
      cls: "ss-studio-text-node-display",
      text: hasText ? textValue : "Text",
    });
    displayEl.classList.toggle("is-placeholder", !hasText);
    textSurfaceEl = displayEl;
    applyFontSize(fontSize);
    displayEl.addEventListener("pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.button !== 0) {
        return;
      }
      event.stopPropagation();
      if (pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey) {
        lastTextNodeTapByNodeId.delete(node.id);
        graphInteraction.toggleNodeSelection(node.id);
        return;
      }
      const now = Date.now();
      if (isRepeatTextNodeTap(node.id, pointerEvent, now)) {
        event.preventDefault();
        lastTextNodeTapByNodeId.delete(node.id);
        graphInteraction.ensureSingleSelection(node.id);
        onRequestTextNodeEdit(node.id);
        return;
      }
      trackPotentialTextNodeTap(node.id, pointerEvent, now);
      graphInteraction.startNodeDrag(node.id, pointerEvent, nodeEl);
    });
    displayEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      lastTextNodeTapByNodeId.delete(node.id);
      graphInteraction.ensureSingleSelection(node.id);
      onRequestTextNodeEdit(node.id);
    });
  }

  mountStudioGraphNodeResizeFrame({
    node,
    nodeEl,
    title: "Resize text",
    ariaLabel: "Resize text",
    interactionLocked: busy,
    getGraphZoom: () => graphInteraction.getGraphZoom(),
    resolveResizeSnap: (moving, edges) =>
      graphInteraction.resolveNodeResizeSnap(node.id, moving, edges),
    onResizeSnapEnd: () => graphInteraction.clearResizeSnapGuides(),
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeResize,
    onNodeGeometryMutated,
    // Text cards persist and render width only — height reflows from content.
    applySize: ({ width }) => {
      nodeEl.style.width = `${width}px`;
    },
    applyFontSize: (nextFontSize) => {
      applyFontSize(nextFontSize);
    },
    readFontSize: () => getCurrentFontSize() || STUDIO_GRAPH_TEXT_NODE_DEFAULT_FONT_SIZE,
    readInitialSize: () => ({
      width: resolveStudioTextNodeWidth(node),
      // Prefer the live rendered height; the content estimate keeps
      // DOM-less environments (jsdom) deterministic.
      height: resolveStudioTextNodeHeight(node, nodeEl),
    }),
  });
}
