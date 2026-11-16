/**
 * A request bubble whose words wrap hugs its longest line, as a one-line bubble hugs its
 * text. Without this the bubble keeps the whole column width beside a first line that
 * `text-wrap: pretty` shortened to spare the last line a lone word.
 */
const REQUEST_ROWS = ".systemsculpt-agent-turn.is-user:not(.is-editing)";
const FITTED_AT = "bubbleFitWidth";

/**
 * Fits every request bubble under `root` that was not fitted at this width yet. Widths
 * are cleared, read and set in three passes, so a whole chat costs one layout.
 */
export function fitRequestBubbles(root: HTMLElement): void {
  // A message being edited takes its editor's width, never a fitted one.
  for (const row of Array.from(root.querySelectorAll<HTMLElement>(".systemsculpt-agent-turn.is-user.is-editing"))) {
    row.style.removeProperty("max-width");
    delete row.dataset[FITTED_AT];
  }
  const width = Math.round(root.getBoundingClientRect().width);
  if (width === 0) return;
  const rows = Array.from(root.querySelectorAll<HTMLElement>(REQUEST_ROWS))
    .filter((row) => row.dataset[FITTED_AT] !== String(width));
  if (rows.length === 0) return;
  for (const row of rows) row.style.removeProperty("max-width");
  const fitted = rows.map(longestLineWidth);
  rows.forEach((row, index) => {
    const value = fitted[index];
    if (value !== null) row.style.setProperty("max-width", `${value}px`);
    row.dataset[FITTED_AT] = String(width);
  });
}

/** The bubble's width at its longest line, or null when it already hugs its text. */
function longestLineWidth(row: HTMLElement): number | null {
  const body = row.querySelector<HTMLElement>(":scope > .systemsculpt-agent-turn-body");
  if (!body) return null;
  const box = body.getBoundingClientRect();
  if (box.width === 0) return null;
  const style = body.ownerDocument.defaultView?.getComputedStyle(body);
  if (!style) return null;
  const start = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  const inset = start + parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
  // Only words are fitted: attachments, code and lists keep the bubble's own width.
  if (!Array.from(body.children).every((child) => child.tagName === "P")) return null;
  const range = body.ownerDocument.createRange();
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const left = box.left + start;
  let right = left;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    range.selectNodeContents(text);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0) right = Math.max(right, rect.right);
    }
  }
  // One spare pixel keeps the longest line from wrapping again at the narrower width.
  const content = Math.ceil(right - left) + 1;
  return box.width - inset - content > 2 ? content + inset : null;
}
