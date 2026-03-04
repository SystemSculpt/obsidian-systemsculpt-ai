const STUDIO_GRAPH_EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true']";
const STUDIO_GRAPH_MENU_SELECTOR = ".ss-studio-node-context-menu, .ss-studio-simple-context-menu";
const STUDIO_GRAPH_TERMINAL_INTERACTIVE_SELECTOR =
  ".ss-studio-terminal-panel, .ss-studio-terminal-surface, .ss-studio-terminal-surface .xterm, .xterm-helper-textarea";
const STUDIO_GRAPH_NATIVE_WHEEL_SCROLL_SELECTOR = [
  ".ss-studio-node-inspector",
  ".ss-studio-node-context-menu",
  ".ss-studio-simple-context-menu",
  ".ss-studio-group-color-palette",
  ".ss-studio-searchable-select",
  ".ss-studio-searchable-select-panel",
  ".ss-studio-searchable-select-list",
  ".ss-studio-node-text-rendered:focus-within",
].join(", ");

export function resolveStudioGraphTargetElement(target: EventTarget | null): Element | null {
  if (!target) {
    return null;
  }
  if (typeof (target as { closest?: unknown }).closest === "function") {
    return target as Element;
  }
  if (typeof Node !== "undefined" && target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

export function isStudioGraphEditableTarget(target: EventTarget | null): boolean {
  const targetEl = resolveStudioGraphTargetElement(target);
  if (!targetEl) {
    return false;
  }
  return Boolean(
    targetEl.closest(
      `${STUDIO_GRAPH_MENU_SELECTOR}, ${STUDIO_GRAPH_EDITABLE_SELECTOR}, ${STUDIO_GRAPH_TERMINAL_INTERACTIVE_SELECTOR}`
    )
  );
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

  if (typeof document === "undefined") {
    return false;
  }
  const activeElement = (document as { activeElement?: unknown }).activeElement;
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
