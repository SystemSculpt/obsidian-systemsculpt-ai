export const STUDIO_GRAPH_EDITOR_SURFACE_ATTR = "data-studio-editor-surface";

const STUDIO_GRAPH_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  `[${STUDIO_GRAPH_EDITOR_SURFACE_ATTR}]`,
].join(", ");
const STUDIO_GRAPH_MENU_SELECTOR = ".ss-studio-node-context-menu, .ss-studio-simple-context-menu";
const STUDIO_GRAPH_NATIVE_WHEEL_SCROLL_SELECTOR = [
  ".ss-studio-node-context-menu",
  ".ss-studio-simple-context-menu",
  ".ss-studio-group-color-palette",
  ".ss-studio-searchable-select",
  ".ss-studio-searchable-select-panel",
  ".ss-studio-searchable-select-list",
  ".ss-studio-node-text-rendered:focus-within",
].join(", ");

function resolveStudioGraphTargetElement(target: EventTarget | null): Element | null {
  if (!target) {
    return null;
  }
  if (typeof (target as { closest?: unknown }).closest === "function") {
    return target as Element;
  }
  if ("parentElement" in (target as object)) {
    return (target as Node).parentElement;
  }
  return null;
}

export function isStudioGraphEditableTarget(target: EventTarget | null): boolean {
  const targetEl = resolveStudioGraphTargetElement(target);
  if (!targetEl) {
    return false;
  }
  return Boolean(targetEl.closest(`${STUDIO_GRAPH_MENU_SELECTOR}, ${STUDIO_GRAPH_EDITABLE_SELECTOR}`));
}

export function isStudioGraphEditableFieldActive(target: EventTarget | null): boolean {
  const targetEl = resolveStudioGraphTargetElement(target);
  if (!targetEl) {
    return false;
  }
  const editableFieldEl = targetEl.closest(STUDIO_GRAPH_EDITABLE_SELECTOR);
  if (!editableFieldEl) {
    return false;
  }

  const activeElement = editableFieldEl.ownerDocument.activeElement;
  if (!activeElement || typeof activeElement !== "object") {
    return false;
  }
  if (editableFieldEl === activeElement) {
    return true;
  }

  const contains = (editableFieldEl as { contains?: (node: unknown) => boolean }).contains;
  if (typeof contains === "function") {
    return contains.call(editableFieldEl, activeElement);
  }

  return false;
}

export function shouldStudioGraphDeferWheelToNativeScroll(target: EventTarget | null): boolean {
  const targetEl = resolveStudioGraphTargetElement(target);
  if (!targetEl) {
    return false;
  }
  return Boolean(targetEl.closest(STUDIO_GRAPH_NATIVE_WHEEL_SCROLL_SELECTOR));
}
