/**
 * The canvas is a scroll box; the world inside it is unbounded.
 *
 * World coordinates are what nodes, shapes, and edges store. The scroll box
 * only needs to cover what the user can see plus room to keep moving, so it is
 * sized from the content and the current view and moved with an origin offset
 * (`world + origin = scroll box px`). When the view nears an edge the extent
 * grows in that direction in viewport-sized chunks and the scroll position is
 * compensated, so the canvas feels infinite without ever laying out more than
 * a few screens of empty space. Nothing here touches the DOM.
 */

export type StudioWorldRect = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/** Scroll-box coverage in world px: the box spans [left, left + width] × [top, top + height]. */
export type StudioWorldExtent = Readonly<{ left: number; top: number; width: number; height: number }>;

/** Largest scroll box per axis (world px). Layout engines cap around 33M px; keep well under that at max zoom. */
export const STUDIO_WORLD_EXTENT_MAX_SIZE = 2_000_000;
/** Smallest chunk the extent grows by, so tiny viewports still get real room. */
export const STUDIO_WORLD_EXTENT_MIN_CHUNK = 1_200;

export function unionWorldRects(a: StudioWorldRect | null, b: StudioWorldRect | null): StudioWorldRect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

export function padWorldRect(rect: StudioWorldRect, padX: number, padY: number): StudioWorldRect {
  return { left: rect.left - padX, top: rect.top - padY, right: rect.right + padX, bottom: rect.bottom + padY };
}

export function worldExtentContains(extent: StudioWorldExtent, rect: StudioWorldRect): boolean {
  return (
    rect.left >= extent.left &&
    rect.top >= extent.top &&
    rect.right <= extent.left + extent.width &&
    rect.bottom <= extent.top + extent.height
  );
}

export function worldExtentToRect(extent: StudioWorldExtent): StudioWorldRect {
  return { left: extent.left, top: extent.top, right: extent.left + extent.width, bottom: extent.top + extent.height };
}

export type ComputeStudioWorldExtentInput = Readonly<{
  /** The extent currently laid out, if any. */
  current: StudioWorldExtent | null;
  /** Everything with a position: nodes and shapes. */
  content: StudioWorldRect | null;
  /** What the viewport shows right now, in world px. */
  view: StudioWorldRect;
  /** Room that must exist beyond content and view before growth triggers. */
  margin: { x: number; y: number };
  /** Room added on a side that had to grow, so growth happens in chunks. */
  slack: { x: number; y: number };
  maxSize?: number;
}>;

/**
 * Returns the extent that should be laid out. Idempotent: while the padded
 * content and view already fit, the current extent is returned unchanged
 * (same object), so callers can compare by identity. The result never
 * shrinks below the current extent except to honor the size cap, in which
 * case the side farthest from the view is trimmed.
 */
export function computeStudioWorldExtent(input: ComputeStudioWorldExtentInput): StudioWorldExtent {
  const maxSize = Math.max(1, input.maxSize ?? STUDIO_WORLD_EXTENT_MAX_SIZE);
  const marginX = Math.max(0, input.margin.x);
  const marginY = Math.max(0, input.margin.y);
  const slackX = Math.max(STUDIO_WORLD_EXTENT_MIN_CHUNK, input.slack.x);
  const slackY = Math.max(STUDIO_WORLD_EXTENT_MIN_CHUNK, input.slack.y);
  const required = padWorldRect(unionWorldRects(input.content, input.view) as StudioWorldRect, marginX, marginY);

  if (input.current && worldExtentContains(input.current, required)) {
    return input.current;
  }

  const base = input.current ? worldExtentToRect(input.current) : required;
  let left = Math.min(base.left, required.left);
  let top = Math.min(base.top, required.top);
  let right = Math.max(base.right, required.right);
  let bottom = Math.max(base.bottom, required.bottom);
  const growLeft = !input.current || required.left < input.current.left;
  const growTop = !input.current || required.top < input.current.top;
  const growRight = !input.current || required.right > input.current.left + input.current.width;
  const growBottom = !input.current || required.bottom > input.current.top + input.current.height;
  if (growLeft) left -= slackX;
  if (growRight) right += slackX;
  if (growTop) top -= slackY;
  if (growBottom) bottom += slackY;

  const viewCenterX = (input.view.left + input.view.right) * 0.5;
  const viewCenterY = (input.view.top + input.view.bottom) * 0.5;
  if (right - left > maxSize) {
    // Distant content can exceed the cap on both sides. Anchor the capped
    // scroll box around the view, not either distant content boundary.
    left = Math.min(Math.max(left, viewCenterX - maxSize * 0.5), right - maxSize);
    right = left + maxSize;
  }
  if (bottom - top > maxSize) {
    top = Math.min(Math.max(top, viewCenterY - maxSize * 0.5), bottom - maxSize);
    bottom = top + maxSize;
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}
