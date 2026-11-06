import type { Menu } from "obsidian";

const isEscapeKeydown = (event: Event | undefined): boolean =>
  event?.type === "keydown" && (event as KeyboardEvent).key === "Escape";

/** Escape dismisses only this menu. Dispose from its owner's sole onHide callback. */
export function containMenuEscape(menu: Menu, ownerDocument: Document): () => void {
  const ownerWindow = ownerDocument.defaultView ?? window;
  const ownerEvents: { event?: Event } = ownerWindow;
  const mainEvents: { event?: Event } = window;
  const release = (): void => ownerDocument.removeEventListener("keydown", onKeydown, true);
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.isComposing) return;
    release();
    event.preventDefault();
    event.stopPropagation();
    menu.hide();
  };
  // The host's bubbling Escape handler otherwise switches to the last note
  // after its menu scope hides the menu without consuming the event.
  ownerDocument.addEventListener("keydown", onKeydown, true);
  // Menu.onHide replaces its callback; the owner composes cleanup with focus.
  return () => {
    // Obsidian's keymap hides the menu on Escape before this listener runs (for
    // a pop-out, while handling a copy it sends to the main window), so onHide
    // disposes mid-keypress. Keep the listener only until that keypress ends.
    if (isEscapeKeydown(ownerEvents.event) || isEscapeKeydown(mainEvents.event)) {
      ownerWindow.setTimeout(release, 0);
      return;
    }
    release();
  };
}

/**
 * Focuses `target()` once Obsidian has finished hiding a menu, unless
 * something else, such as a newly started chat, has taken focus meanwhile.
 */
export function returnFocusAfterMenu(host: HTMLElement, target: () => HTMLElement | null | undefined): void {
  const ownerDocument = host.ownerDocument;
  const before = ownerDocument.activeElement;
  (ownerDocument.defaultView ?? window).setTimeout(() => {
    const active = ownerDocument.activeElement;
    const meaningfulFocus = active && active !== ownerDocument.body && !active.closest(".menu");
    const outsideLeaf = !host.closest(".workspace-leaf")?.contains(active);
    if (meaningfulFocus && (active !== before || outsideLeaf) && active !== target()) return;
    const element = target();
    if (element?.isConnected) element.focus();
  }, 0);
}
