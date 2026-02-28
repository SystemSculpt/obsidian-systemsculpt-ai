import {
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "./StudioGraphInteractionTypes";

export const STUDIO_MENU_EDGE_PADDING_PX = 8;
export const STUDIO_MENU_ANCHOR_OFFSET_PX = 8;

type StudioMenuViewportMetrics = Pick<
  HTMLElement,
  "scrollLeft" | "scrollTop" | "clientWidth" | "clientHeight"
>;

type ResolveStudioAnchoredMenuPositionOptions = {
  viewportEl: StudioMenuViewportMetrics;
  anchorX: number;
  anchorY: number;
  visualWidth: number;
  visualHeight: number;
  edgePadding?: number;
  anchorOffset?: number;
};

function asFiniteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeStudioMenuScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(STUDIO_GRAPH_MAX_ZOOM, Math.max(STUDIO_GRAPH_MIN_ZOOM, value));
}

export function resolveStudioAnchoredMenuPosition(
  options: ResolveStudioAnchoredMenuPositionOptions
): { x: number; y: number } {
  const edgePadding = Math.max(0, asFiniteNumber(options.edgePadding ?? STUDIO_MENU_EDGE_PADDING_PX, 0));
  const anchorOffset = asFiniteNumber(options.anchorOffset ?? STUDIO_MENU_ANCHOR_OFFSET_PX, 0);
  const visualWidth = Math.max(0, asFiniteNumber(options.visualWidth, 0));
  const visualHeight = Math.max(0, asFiniteNumber(options.visualHeight, 0));
  const anchorX = asFiniteNumber(options.anchorX, 0);
  const anchorY = asFiniteNumber(options.anchorY, 0);

  const minX = options.viewportEl.scrollLeft + edgePadding;
  const minY = options.viewportEl.scrollTop + edgePadding;
  const maxX = Math.max(
    minX,
    options.viewportEl.scrollLeft + options.viewportEl.clientWidth - visualWidth - edgePadding
  );
  const maxY = Math.max(
    minY,
    options.viewportEl.scrollTop + options.viewportEl.clientHeight - visualHeight - edgePadding
  );
  const desiredX = anchorX + anchorOffset;
  const desiredY = anchorY + anchorOffset;

  return {
    x: Math.min(maxX, Math.max(minX, desiredX)),
    y: Math.min(maxY, Math.max(minY, desiredY)),
  };
}
