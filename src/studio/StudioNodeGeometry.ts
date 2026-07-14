import { isStudioVisualOnlyNodeKind } from "./StudioNodeKinds";
import type { StudioNodeInstance, StudioNodeSize } from "./types";

/**
 * Single source of truth for Studio node canvas geometry: per-kind default
 * sizes, min/max bounds, the one clamp function, the text content-height
 * estimate, and node-size resolution.
 *
 * Node size is first-class canvas data (`node.size`, next to `node.position`).
 * The resolvers below keep a clearly-marked read fallback to the retired
 * `config.width` / `config.height` keys so not-yet-migrated in-memory graphs
 * render identically until the load migration
 * (StudioGraphMigrations.migrateStudioProjectToPathOnlyPorts) rewrites them.
 */

export const STUDIO_GRAPH_DEFAULT_NODE_WIDTH = 280;
export const STUDIO_GRAPH_DEFAULT_NODE_HEIGHT = 164;
export const STUDIO_GRAPH_LARGE_TEXT_NODE_WIDTH = STUDIO_GRAPH_DEFAULT_NODE_WIDTH * 2;
export const STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT = STUDIO_GRAPH_DEFAULT_NODE_HEIGHT * 2;
export const STUDIO_GRAPH_NODE_MIN_WIDTH = 220;
const STUDIO_GRAPH_NODE_MAX_WIDTH = 2000;
export const STUDIO_GRAPH_NODE_MIN_HEIGHT = 120;
const STUDIO_GRAPH_NODE_MAX_HEIGHT = 2000;
export const STUDIO_GRAPH_TERMINAL_DEFAULT_WIDTH = 640;
export const STUDIO_GRAPH_TERMINAL_DEFAULT_HEIGHT = 420;
export const STUDIO_GRAPH_TERMINAL_MIN_WIDTH = 360;
const STUDIO_GRAPH_TERMINAL_MAX_WIDTH = 2000;
export const STUDIO_GRAPH_TERMINAL_MIN_HEIGHT = 220;
const STUDIO_GRAPH_TERMINAL_MAX_HEIGHT = 1600;

// Text scales poster-large (tldraw-style): the caps exist only to keep truly
// absurd values from wrecking canvas math, not to constrain design intent.
export const STUDIO_GRAPH_TEXT_NODE_MIN_WIDTH = 140;
const STUDIO_GRAPH_TEXT_NODE_MAX_WIDTH = 4000;
// One line of default-size text plus the vertical chrome — the card is
// chromeless (no toolbar), so a single-line text node is genuinely short.
export const STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT = 32;
export const STUDIO_GRAPH_TEXT_NODE_MAX_HEIGHT = 4000;
export const STUDIO_GRAPH_TEXT_NODE_DEFAULT_HEIGHT = STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT + 50;
export const STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE = 10;
export const STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE = 512;
export const STUDIO_GRAPH_TEXT_NODE_DEFAULT_FONT_SIZE = 14;

/**
 * Floors applied to DOM-measured node dimensions (offsetWidth/offsetHeight)
 * before they feed layout math (group bounds, canvas sizing, marquee hit
 * testing). Mid-layout measurements can transiently read tiny/zero values.
 */
export const STUDIO_GRAPH_MEASURED_NODE_MIN_WIDTH = 120;
// Below the shortest legitimate card (a one-line text node at
// STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT) so compact text measures honestly;
// still catches the degenerate zero/near-zero mid-layout reads it guards.
export const STUDIO_GRAPH_MEASURED_NODE_MIN_HEIGHT = 24;

/**
 * Canonical text-node content-height estimate — the DOM-less fallback behind
 * resolveStudioTextNodeHeight. Line height approximates the default 14px font
 * at the base leading; the vertical chrome is the content padding plus the
 * card borders (keep in sync with .ss-studio-text-node-display padding in
 * views/studio/text-nodes.css). Live DOM measurement
 * (resolveStudioTextNodeHeight with an
 * element) always wins; this estimate keeps group bounds, canvas bounds, and
 * jsdom tests correct when no element exists.
 */
const STUDIO_TEXT_NODE_LINE_HEIGHT_PX = 22;
const STUDIO_TEXT_NODE_VERTICAL_CHROME_PX = 10;

export type StudioGraphNodeResizeBounds = {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
};

type StudioNodeGeometrySource = Pick<StudioNodeInstance, "kind" | "config"> &
  Partial<Pick<StudioNodeInstance, "size">>;

function readFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

/**
 * The one geometry clamp: rounds to whole pixels, clamps into [min, max], and
 * collapses non-finite input to the minimum.
 */
export function clampStudioNodeDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Normalizes a graph zoom factor for interaction math. Non-finite or
 * non-positive zoom collapses to identity; anything else is floored at the
 * interactive minimum so screen→canvas division can never explode.
 */
export function resolveStudioGraphSafeZoom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(0.1, value);
}

/**
 * THE screen→canvas drag delta: divides pointer travel by the graph zoom
 * (CSS `scale()` on the canvas). Every drag interaction — node moves and the
 * resize frame alike — derives its canvas-space delta here so the zoom
 * compensation can never drift between interactions.
 */
export function resolveStudioCanvasDelta(params: {
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  zoom: number;
}): { deltaX: number; deltaY: number } {
  const zoom = resolveStudioGraphSafeZoom(params.zoom);
  return {
    deltaX: (params.clientX - params.startClientX) / zoom,
    deltaY: (params.clientY - params.startClientY) / zoom,
  };
}

/**
 * How a node kind interprets the 8-zone resize frame:
 *
 * - "text": width is the wrap width (height reflows intrinsically);
 *   vertical drags scale `config.fontSize`; corners scale fontSize AND width
 *   proportionally (tldraw-style visual zoom).
 * - "aspect-width": width is the single lever; rendered height follows the
 *   intrinsic aspect ratio (`height: auto` media CSS), so vertical/corner
 *   drags convert into width via the measured aspect.
 * - "box": width and height are both explicit (terminal).
 * - "min-height": width plus a min-height floor — content may still
 *   overflow-grow past the floor (generic cards).
 */
export type StudioNodeResizeMode = "text" | "aspect-width" | "box" | "min-height";

const STUDIO_NODE_RESIZE_MODE_BY_KIND: Readonly<Record<string, StudioNodeResizeMode>> = {
  "studio.text": "text",
  "studio.terminal": "box",
};

export function resolveStudioNodeResizeSemantics(
  kind: string,
  context?: { hasAspectMediaContent?: boolean }
): StudioNodeResizeMode {
  const normalizedKind = String(kind || "").trim();
  const declared = STUDIO_NODE_RESIZE_MODE_BY_KIND[normalizedKind];
  if (declared) {
    return declared;
  }
  if (context?.hasAspectMediaContent === true) {
    return "aspect-width";
  }
  return "min-height";
}

function countStudioTextNodeLines(text: unknown): number {
  const value =
    typeof text === "string"
      ? text
      : typeof text === "number" || typeof text === "boolean"
        ? String(text)
        : "";
  return Math.max(1, value.split(/\r\n|\r|\n/).length);
}

export function estimateStudioTextNodeHeight(lineCount: number): number {
  const lines = Number.isFinite(lineCount) ? Math.max(1, Math.floor(lineCount)) : 1;
  return clampStudioNodeDimension(
    STUDIO_TEXT_NODE_VERTICAL_CHROME_PX + lines * STUDIO_TEXT_NODE_LINE_HEIGHT_PX,
    STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT,
    STUDIO_GRAPH_TEXT_NODE_MAX_HEIGHT
  );
}

function isStudioTextNode(node: Pick<StudioNodeInstance, "kind">): boolean {
  return isStudioVisualOnlyNodeKind(node.kind) && node.kind === "studio.text";
}

export function isStudioExpandedTextNodeKind(kind: string): boolean {
  const normalizedKind = String(kind || "").trim();
  return (
    normalizedKind === "studio.image_generation" ||
    normalizedKind === "studio.json" ||
    normalizedKind === "studio.note" ||
    normalizedKind === "studio.text_output" ||
    normalizedKind === "studio.text_generation" ||
    normalizedKind === "studio.transcription" ||
    normalizedKind === "studio.value"
  );
}

function isStudioTerminalNode(node: Pick<StudioNodeInstance, "kind">): boolean {
  return String(node.kind || "").trim() === "studio.terminal";
}

function isStudioLargeLayoutNodeKind(kind: string): boolean {
  return kind === "studio.dataset" || isStudioExpandedTextNodeKind(kind);
}

export function resolveStudioGraphNodeResizeBounds(
  node: Pick<StudioNodeInstance, "kind">
): StudioGraphNodeResizeBounds {
  if (isStudioTextNode(node)) {
    return {
      minWidth: STUDIO_GRAPH_TEXT_NODE_MIN_WIDTH,
      maxWidth: STUDIO_GRAPH_TEXT_NODE_MAX_WIDTH,
      minHeight: STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT,
      maxHeight: STUDIO_GRAPH_TEXT_NODE_MAX_HEIGHT,
    };
  }
  if (isStudioTerminalNode(node)) {
    return {
      minWidth: STUDIO_GRAPH_TERMINAL_MIN_WIDTH,
      maxWidth: STUDIO_GRAPH_TERMINAL_MAX_WIDTH,
      minHeight: STUDIO_GRAPH_TERMINAL_MIN_HEIGHT,
      maxHeight: STUDIO_GRAPH_TERMINAL_MAX_HEIGHT,
    };
  }
  const kind = String(node.kind || "").trim();
  const largeLayout = isStudioLargeLayoutNodeKind(kind);
  return {
    minWidth: largeLayout ? STUDIO_GRAPH_DEFAULT_NODE_WIDTH : STUDIO_GRAPH_NODE_MIN_WIDTH,
    maxWidth: STUDIO_GRAPH_NODE_MAX_WIDTH,
    minHeight: largeLayout ? STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT : STUDIO_GRAPH_NODE_MIN_HEIGHT,
    maxHeight: STUDIO_GRAPH_NODE_MAX_HEIGHT,
  };
}

/**
 * Per-kind default rendered size, used when a node carries no size anywhere
 * (fresh nodes, or the load migration filling a missing dimension).
 */
export function resolveStudioNodeDefaultSize(kind: string): StudioNodeSize {
  const normalizedKind = String(kind || "").trim();
  if (normalizedKind === "studio.text") {
    return {
      width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
      height: STUDIO_GRAPH_TEXT_NODE_DEFAULT_HEIGHT,
    };
  }
  if (normalizedKind === "studio.terminal") {
    return {
      width: STUDIO_GRAPH_TERMINAL_DEFAULT_WIDTH,
      height: STUDIO_GRAPH_TERMINAL_DEFAULT_HEIGHT,
    };
  }
  if (isStudioLargeLayoutNodeKind(normalizedKind)) {
    return {
      width: STUDIO_GRAPH_LARGE_TEXT_NODE_WIDTH,
      height: STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT,
    };
  }
  return {
    width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
    height: STUDIO_GRAPH_DEFAULT_NODE_HEIGHT,
  };
}

/**
 * Reads the node's stored geometry: the first-class `size` field wins;
 * otherwise fall back to the retired legacy `config.width`/`config.height`
 * keys (LEGACY: tolerated only for in-memory graphs that predate the load
 * migration — every persisted project is rewritten on load).
 */
function readStoredNodeDimension(
  node: StudioNodeGeometrySource,
  dimension: "width" | "height"
): number | null {
  const sized = readFiniteNumber(node.size?.[dimension]);
  if (sized !== null) {
    return sized;
  }
  // LEGACY read fallback — see doc comment above.
  return readFiniteNumber((node.config as Record<string, unknown>)?.[dimension]);
}

export function resolveStudioTextNodeWidth(node: StudioNodeGeometrySource): number {
  if (!isStudioTextNode(node)) {
    return STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
  }
  const stored = readStoredNodeDimension(node, "width");
  if (stored === null) {
    return STUDIO_GRAPH_DEFAULT_NODE_WIDTH;
  }
  return clampStudioNodeDimension(
    stored,
    STUDIO_GRAPH_TEXT_NODE_MIN_WIDTH,
    STUDIO_GRAPH_TEXT_NODE_MAX_WIDTH
  );
}

/**
 * Text-node height is INTRINSIC: the card renders with CSS auto height and
 * reflows to its content, so height is resolved — never persisted. Resolution
 * prefers (a) a live DOM measurement when an element is available, then
 * (b) the canonical content estimate. A stale `size.height` persisted by
 * older projects is deliberately ignored residue (no migration strips it —
 * the resolvers simply never read it).
 */
export function resolveStudioTextNodeHeight(
  node: StudioNodeGeometrySource,
  measuredElement?: Pick<HTMLElement, "offsetHeight"> | null
): number {
  if (!isStudioTextNode(node)) {
    return STUDIO_GRAPH_DEFAULT_NODE_HEIGHT;
  }
  const measured = measuredElement?.offsetHeight;
  if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
    return clampStudioNodeDimension(
      measured,
      STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT,
      STUDIO_GRAPH_TEXT_NODE_MAX_HEIGHT
    );
  }
  return estimateStudioTextNodeHeight(
    countStudioTextNodeLines((node.config as Record<string, unknown>)?.value)
  );
}

export function resolveStudioTextNodeFontSize(node: StudioNodeGeometrySource): number {
  if (!isStudioTextNode(node)) {
    return STUDIO_GRAPH_TEXT_NODE_DEFAULT_FONT_SIZE;
  }
  const configured = readFiniteNumber((node.config as Record<string, unknown>)?.fontSize);
  if (configured === null) {
    return STUDIO_GRAPH_TEXT_NODE_DEFAULT_FONT_SIZE;
  }
  return clampStudioNodeDimension(
    configured,
    STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
    STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE
  );
}

export function resolveStudioGraphNodeWidth(node: StudioNodeGeometrySource): number {
  if (isStudioTextNode(node)) {
    return resolveStudioTextNodeWidth(node);
  }
  const bounds = resolveStudioGraphNodeResizeBounds(node);
  const stored = readStoredNodeDimension(node, "width");
  if (stored !== null) {
    return clampStudioNodeDimension(stored, bounds.minWidth, bounds.maxWidth);
  }
  return resolveStudioNodeDefaultSize(node.kind).width;
}

export function resolveStudioGraphNodeMinHeight(node: StudioNodeGeometrySource): number {
  if (isStudioTextNode(node)) {
    // Text-node height is intrinsic (content reflow) — never force a floor.
    return 0;
  }
  const bounds = resolveStudioGraphNodeResizeBounds(node);
  const stored = readStoredNodeDimension(node, "height");
  if (stored !== null) {
    return clampStudioNodeDimension(stored, bounds.minHeight, bounds.maxHeight);
  }
  if (isStudioTerminalNode(node)) {
    return STUDIO_GRAPH_TERMINAL_DEFAULT_HEIGHT;
  }
  if (isStudioExpandedTextNodeKind(node.kind)) {
    return STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT;
  }
  // Unsized regular nodes keep auto content height (no forced minimum).
  return 0;
}

/**
 * Normalizes a DOM-measured node width for layout math. Positive measurements
 * are floored at the measured minimum; unusable measurements fall back to the
 * node's resolved width (or the default width when no node is available).
 */
export function resolveMeasuredStudioNodeWidth(
  measured: number | null | undefined,
  node?: StudioNodeGeometrySource
): number {
  if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
    return Math.max(STUDIO_GRAPH_MEASURED_NODE_MIN_WIDTH, measured);
  }
  return Math.max(
    STUDIO_GRAPH_MEASURED_NODE_MIN_WIDTH,
    node ? resolveStudioGraphNodeWidth(node) : STUDIO_GRAPH_DEFAULT_NODE_WIDTH
  );
}

/**
 * Normalizes a DOM-measured node height for layout math. Positive
 * measurements are floored at the measured minimum; unusable measurements
 * fall back to the default node height.
 */
export function resolveMeasuredStudioNodeHeight(measured: number | null | undefined): number {
  if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
    return Math.max(STUDIO_GRAPH_MEASURED_NODE_MIN_HEIGHT, measured);
  }
  return STUDIO_GRAPH_DEFAULT_NODE_HEIGHT;
}
