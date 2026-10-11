import { readStudioFillTextLook, studioFillTextLookConfig } from "../../../studio/StudioFillTextNode";
import { resolveStudioFillTextNodeSize } from "../../../studio/StudioNodeGeometry";
import type { StudioJsonValue } from "../../../studio/types";
import { getStudioOwnerWindow, requestStudioAnimationFrame } from "../StudioDomContext";
import { STUDIO_GRAPH_EDITOR_SURFACE_ATTR } from "../StudioGraphDomTargeting";
import {
  createStudioFillTextMeasure,
  fitStudioFillText,
  STUDIO_FILL_TEXT_CLASS,
  STUDIO_FILL_TEXT_PLACEHOLDER,
  type StudioFillTextAppearance,
} from "./StudioFillTextSurface";
import { mountStudioFillTextToolbar, type StudioFillTextToolbar } from "./StudioFillTextToolbar";
import { commitInlineConfigValueChange } from "./StudioGraphInlineConfigPanel";
import { markStudioNodeCardInteractive } from "./StudioGraphNodeCardPointer";
import type { StudioGraphNodeMutationOptions } from "./StudioGraphNodeCardTypes";
import { mountStudioGraphNodeResizeFrame } from "./StudioGraphNodeResizeFrame";
import {
  bindStudioTextNodeDisplayGestures,
  readStudioTextNodeValue,
  type RenderTextNodeCardOptions,
} from "./StudioGraphTextNodeCard";

type RenderFillTextNodeCardOptions = Pick<
  RenderTextNodeCardOptions,
  | "nodeEl"
  | "node"
  | "busy"
  | "graphInteraction"
  | "onNodeConfigMutated"
  | "onNodeConfigValueChange"
  | "onNodeResize"
  | "onNodeGeometryMutated"
  | "isEditing"
  | "shouldAutoFocus"
  | "initialEditorSnapshot"
  | "onRequestTextNodeEdit"
  | "onStopTextNodeEdit"
  | "registerEditorTeardown"
>;

/**
 * A text node whose text fills its box, the way a caption fills its box on
 * an image: the card is the box, typing happens on the card itself at the
 * size the text will have, and resizing the box resizes the type.
 *
 * The card's own width and height come from the shared card geometry; this
 * only fits the text to whatever box the card has. Returns its teardown.
 */
export function renderFillTextNodeCard(options: RenderFillTextNodeCardOptions): () => void {
  const {
    nodeEl,
    node,
    busy,
    graphInteraction,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onStopTextNodeEdit,
  } = options;
  nodeEl.addClass("ss-studio-text-node-card");
  nodeEl.addClass("ss-studio-fill-text-card");
  const measure = createStudioFillTextMeasure(nodeEl);
  const appearance: StudioFillTextAppearance = {
    text: readStudioTextNodeValue(node),
    ...readStudioFillTextLook(node.config),
  };
  const save = (key: string, value: StudioJsonValue, mutationOptions: StudioGraphNodeMutationOptions): void =>
    commitInlineConfigValueChange({ node, key, value, onNodeConfigValueChange, onNodeConfigMutated, mutationOptions });
  let box = resolveStudioFillTextNodeSize(node);
  let surface: HTMLElement | null = null;
  let toolbar: StudioFillTextToolbar | null = null;
  // Set once the card is being taken down: a field removed mid-edit is remounted, not left.
  let closed = false;

  /** Fits the text to the card as it is laid out now, or to its stored box where nothing is laid out. */
  const fit = (): void => {
    if (!surface) {
      return;
    }
    fitStudioFillText(
      surface,
      appearance,
      {
        width: surface.clientWidth > 0 ? surface.clientWidth : box.width,
        height: surface.clientHeight > 0 ? surface.clientHeight : box.height,
      },
      measure
    );
  };

  if (options.isEditing && !busy) {
    const field = nodeEl.createEl("textarea", {
      cls: STUDIO_FILL_TEXT_CLASS,
      attr: {
        "data-testid": "studio.text.field",
        "aria-label": `${node.title || "Text"} content`,
        placeholder: STUDIO_FILL_TEXT_PLACEHOLDER,
        spellcheck: "false",
        rows: "1",
        [STUDIO_GRAPH_EDITOR_SURFACE_ATTR]: "",
      },
    });
    field.value = appearance.text;
    surface = field;
    field.addEventListener("input", () => {
      appearance.text = field.value;
      fit();
      save("value", field.value, { mode: "continuous", captureHistory: false });
    });
    field.addEventListener("keydown", (event) => {
      if (event.isComposing) {
        return;
      }
      if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        event.stopPropagation();
        field.blur();
      }
    });
    const stopEditing = (next: EventTarget | null): void => {
      // Focus moving into the style bar (its colour picker) or back to the text is still this edit.
      if (closed || next === field || toolbar?.element.contains(next as Node | null)) {
        return;
      }
      onStopTextNodeEdit(node.id);
    };
    field.addEventListener("blur", (event) => stopEditing(event.relatedTarget));
    options.registerEditorTeardown?.(node.id, () => {
      closed = true;
      return {
        selection: { anchor: field.selectionStart, head: field.selectionEnd },
        scrollTop: 0,
        focused: field.ownerDocument.activeElement === field,
      };
    });
    const workspaceEl = nodeEl.closest<HTMLElement>(".ss-studio-graph-workspace");
    toolbar = mountStudioFillTextToolbar({
      host: workspaceEl ?? nodeEl,
      docked: workspaceEl !== null,
      look: appearance,
      onChange: (change, how) => {
        Object.assign(appearance, change);
        fit();
        toolbar?.sync(appearance);
        for (const [key, value] of studioFillTextLookConfig(change)) {
          save(key, value, how);
        }
      },
      returnFocus: () => field.focus({ preventScroll: true }),
      onFocusLeft: stopEditing,
    });
    const snapshot = options.initialEditorSnapshot;
    if (snapshot) {
      // Remounted mid-edit: put the caret back where it was.
      field.setSelectionRange(snapshot.selection.anchor, snapshot.selection.head);
      if (snapshot.focused) {
        field.focus({ preventScroll: true });
      }
    } else if (options.shouldAutoFocus) {
      requestStudioAnimationFrame(field, () => {
        if (!field.isConnected) {
          return;
        }
        // Typing replaces what was there, as it does for a caption on an image.
        field.focus({ preventScroll: true });
        field.select();
      });
    }
  } else {
    const hasText = appearance.text.trim().length > 0;
    const display = nodeEl.createDiv({
      cls: STUDIO_FILL_TEXT_CLASS,
      text: hasText ? appearance.text : STUDIO_FILL_TEXT_PLACEHOLDER,
    });
    display.toggleClass("is-placeholder", !hasText);
    surface = display;
    // The text is the card's drag surface and its way into editing.
    markStudioNodeCardInteractive(display);
    bindStudioTextNodeDisplayGestures({
      displayEl: display,
      nodeEl,
      nodeId: node.id,
      graphInteraction,
      resolveFocusTarget: (event) => ({ x: event.clientX, y: event.clientY }),
      onRequestTextNodeEdit: options.onRequestTextNodeEdit,
    });
  }
  fit();

  const removeFrame = mountStudioGraphNodeResizeFrame({
    node,
    nodeEl,
    title: "Resize text",
    ariaLabel: "Resize text",
    interactionLocked: busy,
    getGraphZoom: () => graphInteraction.getGraphZoom(),
    showResizeGuides: (moving, edges) => graphInteraction.showNodeResizeGuides(node.id, moving, edges),
    onResizeGuidesEnd: () => graphInteraction.clearAlignmentGuides(),
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeResize: options.onNodeResize,
    onNodeGeometryMutated: options.onNodeGeometryMutated,
    applySize: ({ width, height }) => {
      box = { width, height: height ?? box.height };
      nodeEl.style.width = `${box.width}px`;
      nodeEl.style.minHeight = `${box.height}px`;
      fit();
    },
    readInitialSize: () => ({
      width: nodeEl.offsetWidth > 0 ? nodeEl.offsetWidth : box.width,
      height: nodeEl.offsetHeight > 0 ? nodeEl.offsetHeight : box.height,
    }),
  });

  // The box also changes from outside this card: undo, and resizing a
  // selection of several cards. Whatever moved it, the text follows.
  const Observer = (getStudioOwnerWindow(nodeEl) as Window & { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver;
  const observer = typeof Observer === "function" ? new Observer(() => fit()) : null;
  observer?.observe(nodeEl);

  return () => {
    closed = true;
    observer?.disconnect();
    toolbar?.dispose();
    removeFrame();
  };
}
