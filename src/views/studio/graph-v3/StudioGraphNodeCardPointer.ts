import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";

/**
 * Node-card pointer policy — the single source of truth for which
 * elements inside a node card are interactive controls versus inert
 * card body (a drag surface).
 *
 * Native form controls, links, port pins, resize zones, and the
 * text-node display are interactive by construction. Composite chrome
 * (toolbars, floating panels) opts in declaratively with
 * markStudioNodeCardInteractive — never by growing this selector with
 * one-off class names.
 */
export const STUDIO_NODE_CARD_INTERACTIVE_ATTR = "data-studio-interactive";

const STUDIO_NODE_CARD_INTERACTIVE_SELECTOR = [
  "input",
  "button",
  "select",
  "textarea",
  "a",
  `[${STUDIO_NODE_CARD_INTERACTIVE_ATTR}]`,
  ".ss-studio-port-pin",
  ".ss-studio-node-resize-zone",
  ".ss-studio-text-node-display",
].join(", ");

/**
 * Declares an element (and everything inside it) an interactive control
 * surface: pointer gestures on it belong to the control, never to card
 * dragging or card-level double-click actions.
 */
export function markStudioNodeCardInteractive(el: HTMLElement): void {
  el.setAttribute(STUDIO_NODE_CARD_INTERACTIVE_ATTR, "");
}

export function isStudioNodeCardInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(STUDIO_NODE_CARD_INTERACTIVE_SELECTOR) !== null
  );
}

/**
 * Card-body pointer contract: plain pointerdown on the card body drags
 * the node, modifier-pointerdown toggles selection, and anything the
 * policy above deems interactive is left alone entirely.
 */
export function bindNodeCardPointerDown(options: {
  nodeEl: HTMLElement;
  nodeId: string;
  graphInteraction: StudioGraphInteractionEngine;
}): void {
  const { nodeEl, nodeId, graphInteraction } = options;
  nodeEl.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    if (isStudioNodeCardInteractiveTarget(pointerEvent.target)) {
      return;
    }

    const modifierToggle = pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey;
    if (modifierToggle) {
      graphInteraction.toggleNodeSelection(nodeId);
      return;
    }

    graphInteraction.startNodeDrag(nodeId, pointerEvent, nodeEl);
  });
}
