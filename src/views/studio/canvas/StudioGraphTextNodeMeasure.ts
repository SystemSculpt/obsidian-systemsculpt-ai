/**
 * Glyph-accurate text measurement for auto-sized text cards (tldraw parity).
 *
 * Intrinsic CSS sizing hugs the paragraph box, which can run wider than the
 * glyphs it holds; the card should hug the ink. This walks the rendered text
 * nodes and unions their client rects, so headings, inline code and links
 * all count, while empty and whitespace-only nodes do not.
 */

export type StudioTextGlyphExtent = Readonly<{ left: number; right: number; width: number }>;

/** Screen-px horizontal extent of the rendered glyphs inside `root`, or null when nothing is laid out. */
export function measureStudioTextGlyphExtent(root: HTMLElement): StudioTextGlyphExtent | null {
  const doc = root.ownerDocument;
  if (!doc || typeof doc.createRange !== "function" || typeof doc.createTreeWalker !== "function") {
    return null;
  }
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const range = doc.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!String(node.textContent || "").trim()) continue;
    range.selectNodeContents(node);
    const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
    if (!rects) continue;
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index];
      if (!rect || rect.width <= 0) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
  }
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) {
    return null;
  }
  return { left, right, width: right - left };
}

/**
 * World-px card width that hugs the measured glyphs: ink width divided by
 * the zoom, plus the surface's horizontal padding and the card's borders,
 * rounded up with one pixel of slack so the last glyph never wraps.
 */
export function resolveStudioTextAutoWidth(options: {
  glyphWidth: number;
  zoom: number;
  paddingInline: number;
  borderInline: number;
  minWidth: number;
  maxWidth: number;
}): number {
  const zoom = Number.isFinite(options.zoom) && options.zoom > 0 ? options.zoom : 1;
  const ink = Math.max(0, options.glyphWidth) / zoom;
  const width = Math.ceil(ink + Math.max(0, options.paddingInline) + Math.max(0, options.borderInline)) + 1;
  return Math.min(options.maxWidth, Math.max(options.minWidth, width));
}
