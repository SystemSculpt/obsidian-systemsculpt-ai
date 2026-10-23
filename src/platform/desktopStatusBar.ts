const HOST_STATUS_BAR_SELECTOR = ".status-bar";

/**
 * How many pixels of an element's bottom edge Obsidian's floating desktop
 * status bar covers. The bar is fixed to the window's bottom right, above
 * whatever pane sits there; bottom-anchored controls reserve this much room.
 * Returns 0 when the bar is hidden (mobile, or turned off) or elsewhere.
 */
export function statusBarBottomOverlap(element: HTMLElement): number {
  const ownerDocument = element.ownerDocument;
  const bar = ownerDocument.querySelector<HTMLElement>(HOST_STATUS_BAR_SELECTOR);
  if (!bar || !element.isConnected) return 0;
  const position = ownerDocument.defaultView?.getComputedStyle(bar).position;
  if (position !== "fixed" && position !== "absolute") return 0;
  const barRect = bar.getBoundingClientRect();
  if (barRect.width === 0 || barRect.height === 0) return 0;
  const rect = element.getBoundingClientRect();
  const sharedWidth = Math.min(rect.right, barRect.right) - Math.max(rect.left, barRect.left);
  if (sharedWidth <= 0 || barRect.top >= rect.bottom || barRect.bottom <= rect.top) return 0;
  return Math.ceil(rect.bottom - barRect.top);
}
