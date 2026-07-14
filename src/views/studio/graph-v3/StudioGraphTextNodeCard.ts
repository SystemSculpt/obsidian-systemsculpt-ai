import type { StudioNodeInstance } from "../../../studio/types";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import type {
  StudioGraphNodeMutationOptions,
  StudioGraphNodeResizePatch,
} from "./StudioGraphNodeCardTypes";
import { getStudioOwnerWindow, requestStudioAnimationFrame } from "../StudioDomContext";
import {
  resolveStudioTextNodeFontSize,
  resolveStudioTextNodeHeight,
  resolveStudioTextNodeWidth,
  STUDIO_GRAPH_TEXT_NODE_DEFAULT_FONT_SIZE,
} from "../../../studio/StudioNodeGeometry";
import { mountStudioGraphNodeResizeFrame } from "./StudioGraphNodeResizeFrame";
import { STUDIO_GRAPH_EDITOR_SURFACE_ATTR } from "../StudioGraphDomTargeting";
import { markStudioNodeCardInteractive } from "./StudioGraphNodeCardPointer";

const STUDIO_TEXT_NODE_DOUBLE_TAP_DELAY_MS = 450;
const STUDIO_TEXT_NODE_DOUBLE_TAP_SLOP_PX = 8;
const STUDIO_TEXT_NODE_TAP_DRAG_SLOP_PX = 3;

type TextNodeTapSnapshot = {
  at: number;
  clientX: number;
  clientY: number;
};

const lastTextNodeTapByNodeId = new Map<string, TextNodeTapSnapshot>();

/**
 * Editing surface handle produced by the host view's embedded-markdown-editor
 * factory. Mirrors the shape of `EmbeddableMarkdownEditorHandle` without
 * importing it, so this render module stays free of app-level dependencies.
 */
export type StudioTextNodeMarkdownEditorSnapshot = {
  selection: { anchor: number; head: number };
  scrollTop: number;
  focused: boolean;
};

export type StudioTextNodeMarkdownEditorHandle = {
  readonly value: string;
  set(value: string): void;
  /** Flushes the current native document through onChange before returning it. */
  commit(): string;
  focus(): void;
  focusAt(point: { x: number; y: number }): void;
  selectAll(): void;
  captureSnapshot(): StudioTextNodeMarkdownEditorSnapshot;
  restoreSnapshot(snapshot: StudioTextNodeMarkdownEditorSnapshot): void;
  destroy(): void;
  readonly editorEl: HTMLElement | null;
  readonly editor: unknown;
};

/**
 * Builds an Obsidian live-preview markdown editor inside `containerEl`, or
 * returns null when the embedded editor is unavailable — the card then falls
 * back to the plain textarea surface.
 */
export type StudioTextNodeMarkdownEditorFactory = (
  containerEl: HTMLElement,
  options: {
    value: string;
    placeholder: string;
    focusAt?: { x: number; y: number };
    nodeId?: string;
    onChange?: (value: string) => void;
    onEscape?: () => void;
    onBlur?: () => void;
  }
) => StudioTextNodeMarkdownEditorHandle | null;

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
  initialFocusPoint?: { x: number; y: number };
  onRequestTextNodeEdit: (nodeId: string, focusAt?: { x: number; y: number }) => void;
  onStopTextNodeEdit: (nodeId: string) => void;
  renderMarkdownPreview?: (
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ) => Promise<void> | void;
  createMarkdownEditor?: StudioTextNodeMarkdownEditorFactory;
  initialEditorSnapshot?: StudioTextNodeMarkdownEditorSnapshot;
  registerEditorTeardown?: (
    nodeId: string,
    teardown: () => StudioTextNodeMarkdownEditorSnapshot
  ) => void;
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

function trackPotentialTextNodeTap(
  nodeId: string,
  event: PointerEvent,
  now: number,
  host: Node
): void {
  const ownerWindow = getStudioOwnerWindow(host);
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
    ownerWindow.removeEventListener("pointermove", clearIfDragged);
    ownerWindow.removeEventListener("pointerup", stopTracking);
    ownerWindow.removeEventListener("pointercancel", stopTracking);
  };

  ownerWindow.addEventListener("pointermove", clearIfDragged);
  ownerWindow.addEventListener("pointerup", stopTracking);
  ownerWindow.addEventListener("pointercancel", stopTracking);
}

type MountLiveMarkdownEditorOptions = {
  contentEl: HTMLElement;
  node: StudioNodeInstance;
  textValue: string;
  createMarkdownEditor: StudioTextNodeMarkdownEditorFactory;
  registerEditorTeardown?: (
    nodeId: string,
    teardown: () => StudioTextNodeMarkdownEditorSnapshot
  ) => void;
  initialEditorSnapshot?: StudioTextNodeMarkdownEditorSnapshot;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: RenderTextNodeCardOptions["onNodeConfigValueChange"];
  onStopTextNodeEdit: (nodeId: string) => void;
  shouldAutoFocus: boolean;
  initialFocusPoint?: { x: number; y: number };
  adoptTextSurface: (el: HTMLElement) => void;
};

/**
 * Mounts the embedded Obsidian live-preview editor for a text-node edit
 * session. Returns false when the factory cannot produce an editor, in which
 * case the caller renders the plain textarea instead. The host owns the
 * editor's lifetime through the registered teardown — the graph re-render
 * that follows `onStopTextNodeEdit` destroys the editor before the card's
 * DOM is dropped.
 */
function mountLiveMarkdownEditor(options: MountLiveMarkdownEditorOptions): boolean {
  const {
    contentEl,
    node,
    textValue,
    createMarkdownEditor,
    registerEditorTeardown,
    initialEditorSnapshot,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onStopTextNodeEdit,
    shouldAutoFocus,
    initialFocusPoint,
    adoptTextSurface,
  } = options;

  const hostEl = contentEl.createDiv({
    cls: "ss-studio-text-node-live-editor",
    attr: {
      "aria-label": `${node.title || "Text"} content`,
      [STUDIO_GRAPH_EDITOR_SURFACE_ATTR]: "",
    },
  });
  // Pointer gestures inside the editor belong to the editor (text selection,
  // checkbox toggles, table cells), never to card dragging.
  markStudioNodeCardInteractive(hostEl);

  const commitValue = (nextValue: string): void => {
    if (onNodeConfigValueChange) {
      onNodeConfigValueChange(node.id, "value", nextValue, {
        mode: "continuous",
        captureHistory: false,
      });
      return;
    }
    node.config.value = nextValue;
    onNodeConfigMutated(node);
  };

  let editorHandle: StudioTextNodeMarkdownEditorHandle | null = null;
  const finishEditing = (): void => {
    // Native CodeMirror updates are synchronous in the normal path, but IME,
    // paste, and fast click-away can race the final owner.save callback. Flush
    // the live document before the view decides whether an empty node should
    // be removed.
    try {
      editorHandle?.commit();
    } finally {
      onStopTextNodeEdit(node.id);
    }
  };
  editorHandle = createMarkdownEditor(hostEl, {
    value: textValue,
    placeholder: "Text",
    focusAt: initialFocusPoint,
    nodeId: node.id,
    onChange: (nextValue) => {
      commitValue(nextValue);
    },
    onEscape: finishEditing,
    onBlur: finishEditing,
  });
  if (!editorHandle) {
    hostEl.remove();
    return false;
  }

  adoptTextSurface(hostEl);
  let editorDisposed = false;
  if (initialEditorSnapshot) {
    editorHandle.restoreSnapshot(initialEditorSnapshot);
  }
  registerEditorTeardown?.(node.id, () => {
    // Whole-graph renders can arrive between CodeMirror's last DOM update and
    // its owner callback. Persist the live document before carrying the caret
    // snapshot into the replacement editor. Destruction is unconditional so
    // a failed commit/snapshot cannot leak Obsidian's focus or keymap owner.
    try {
      editorHandle.commit();
      return editorHandle.captureSnapshot();
    } finally {
      editorDisposed = true;
      editorHandle.destroy();
    }
  });

  if (shouldAutoFocus && !initialFocusPoint && !initialEditorSnapshot) {
    requestStudioAnimationFrame(contentEl, () => {
      // A re-render can tear the editor down before this frame fires.
      if (editorDisposed) {
        return;
      }
      // Native note editing focuses the caret; it does not select the whole
      // document on entry. Pointer-driven entry is handled by focusAt above.
      editorHandle.focus();
    });
  }
  return true;
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
    initialFocusPoint,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
    renderMarkdownPreview,
    createMarkdownEditor,
    initialEditorSnapshot,
    registerEditorTeardown,
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
    // Obsidian-note parity: edit through the embedded live-preview markdown
    // editor whenever the host can build one. The editor is created against
    // internal Obsidian API, so a null factory result (unsupported internals,
    // busy view, headless tests) falls through to the plain textarea.
    const liveEditorMounted =
      !busy && createMarkdownEditor
        ? mountLiveMarkdownEditor({
            contentEl,
            node,
            textValue,
            createMarkdownEditor,
            registerEditorTeardown,
            initialEditorSnapshot,
            onNodeConfigMutated,
            onNodeConfigValueChange,
            onStopTextNodeEdit,
            shouldAutoFocus,
            initialFocusPoint,
            adoptTextSurface: (el) => {
              textSurfaceEl = el;
              applyFontSize(fontSize);
            },
          })
        : false;
    if (!liveEditorMounted) {
      renderTextNodeTextarea();
    }
  } else {
    renderTextNodeDisplay();
  }

  function renderTextNodeTextarea(): void {
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
      textAreaEl.setCssStyles({ height: "auto" });
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
        onNodeConfigValueChange(node.id, "value", nextValue, {
          mode: "continuous",
          captureHistory: false,
        });
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
      requestStudioAnimationFrame(textAreaEl, () => {
        textAreaEl.focus();
        textAreaEl.select();
      });
    }
  }

  function renderTextNodeDisplay(): void {
    const hasText = textValue.trim().length > 0;
    const displayEl = contentEl.createDiv({
      cls: "ss-studio-text-node-display",
      text: hasText ? "" : "Text",
    });
    displayEl.classList.toggle("is-placeholder", !hasText);
    textSurfaceEl = displayEl;
    applyFontSize(fontSize);
    if (hasText) {
      renderTextNodeDisplayContent(displayEl);
    }
    displayEl.addEventListener("pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.button !== 0) {
        return;
      }
      // Rendered markdown carries its own controls (links, task checkboxes,
      // embeds); their pointer gestures belong to the control, not to card
      // dragging. The card-level pointer policy skips these targets too.
      if (
        typeof (event.target as { closest?: unknown } | null)?.closest === "function" &&
        (event.target as Element).closest("a, input, button, audio, video") !== null
      ) {
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
        onRequestTextNodeEdit(node.id, {
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
        });
        return;
      }
      trackPotentialTextNodeTap(node.id, pointerEvent, now, displayEl);
      graphInteraction.startNodeDrag(node.id, pointerEvent, nodeEl);
    });
    displayEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      lastTextNodeTapByNodeId.delete(node.id);
      graphInteraction.ensureSingleSelection(node.id);
      onRequestTextNodeEdit(node.id, {
        x: (event as MouseEvent).clientX,
        y: (event as MouseEvent).clientY,
      });
    });
  }

  /**
   * Obsidian-note parity for the resting card: the value is markdown, so it
   * displays as rendered markdown (headings, tables, checklists) through the
   * host's renderer. Without a renderer (headless tests, degraded hosts) the
   * raw text is shown exactly as before.
   */
  function renderTextNodeDisplayContent(displayEl: HTMLElement): void {
    if (!renderMarkdownPreview) {
      displayEl.setText(textValue);
      return;
    }
    displayEl.addClass("is-markdown");
    const fallBackToPlainText = (): void => {
      // Raw text needs the pre-wrap source styling back, not markdown
      // block flow.
      displayEl.removeClass("is-markdown");
      displayEl.empty();
      displayEl.setText(textValue);
    };
    try {
      void Promise.resolve(
        renderMarkdownPreview(node, textValue, displayEl)
      ).catch(fallBackToPlainText);
    } catch {
      fallBackToPlainText();
    }
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
