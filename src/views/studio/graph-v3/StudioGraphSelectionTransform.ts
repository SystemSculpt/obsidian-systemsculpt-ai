import {
  clampStudioNodeDimension,
  resolveStudioGraphNodeResizeBounds,
  resolveStudioNodeResizeSemantics,
  STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
  STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
} from "../../../studio/StudioNodeGeometry";
import type { StudioGraphNodeResizePatch } from "./StudioGraphNodeCardTypes";
import {
  resolveStudioGraphResizeZoneDirection,
  type StudioGraphResizeZone,
} from "./StudioGraphNodeResizeFrame";

/**
 * Pure group-transform math for the multi-select resize frame (tldraw
 * parity): dragging one selection bounds box scales the whole selection.
 *
 * The group bounds resize with the same edge/corner anchoring rules as the
 * single-node frame (left/top zones anchor the opposite edge, corners scale
 * both axes, edges one axis). Each node's position then interpolates inside
 * the new bounds — group origin plus its normalized offset times the new
 * group size — so relative layout is preserved on every scaled axis.
 *
 * Per-node levers by resize semantics (x = group x-factor, y = y-factor):
 *
 * | mode         | horizontal drag | vertical drag        | corner drag          |
 * | ------------ | --------------- | -------------------- | -------------------- |
 * | box          | width ×x        | height ×y            | width ×x, height ×y  |
 * | min-height   | width ×x        | height floor ×y      | width ×x, floor ×y   |
 * | aspect-width | width ×x        | width ×y (aspect     | width ×x             |
 * |              |                 | keeps height synced) |                      |
 * | text         | wrap width ×x   | fontSize ×y          | width ×x, fontSize ×y|
 *
 * Clamp interaction: every lever passes through the node's own module
 * bounds AFTER group scaling, while positions always interpolate from the
 * raw (unclamped) group transform — a node that hits its min/max stops
 * shrinking/growing but keeps sliding with the layout, so the arrangement
 * compresses around clamped nodes exactly like tldraw.
 *
 * Interaction-locked nodes (busy placeholders) participate in the bounds
 * envelope but are excluded from the emitted patches — they stay put while
 * the rest of the selection transforms around them.
 */

export type StudioSelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StudioSelectionResizeNodeSnapshot = {
  nodeId: string;
  kind: string;
  /** Canvas-space rect measured at gesture start. */
  rect: StudioSelectionRect;
  /** Start fontSize (text nodes; ignored elsewhere). */
  fontSize: number;
  hasAspectMediaContent?: boolean;
  interactionLocked?: boolean;
};

export type StudioSelectionResizePatchEntry = {
  nodeId: string;
  patch: StudioGraphNodeResizePatch;
};

export type StudioSelectionGroupResizeResult = {
  bounds: StudioSelectionRect;
  scaleX: number;
  scaleY: number;
};

export type StudioSelectionResizeResult = StudioSelectionGroupResizeResult & {
  patches: StudioSelectionResizePatchEntry[];
};

/**
 * Floor for the group scale factor: bounds shrink toward — but never
 * through — zero, so the transform can never invert or divide by zero.
 */
export const STUDIO_SELECTION_MIN_GROUP_SCALE = 0.05;

/** Mirror of the canvas position floor shared by every node-move path. */
const STUDIO_SELECTION_MIN_CANVAS_POSITION = 24;

function floorCanvasPosition(value: number): number {
  return Math.max(STUDIO_SELECTION_MIN_CANVAS_POSITION, Math.round(value));
}

function isFiniteRect(rect: StudioSelectionRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

/** Min/max envelope over node rects — the selection bounds box. */
export function computeStudioSelectionBounds(
  rects: Iterable<StudioSelectionRect>
): StudioSelectionRect | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    if (!isFiniteRect(rect)) {
      continue;
    }
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * New group bounds for a zone drag: the same anchoring rules as the
 * single-node frame — the edge opposite the dragged zone stays fixed.
 * Deltas are canvas-space (already zoom-compensated via
 * resolveStudioCanvasDelta).
 */
export function resolveStudioSelectionGroupResize(params: {
  zone: StudioGraphResizeZone;
  deltaX: number;
  deltaY: number;
  startBounds: StudioSelectionRect;
}): StudioSelectionGroupResizeResult {
  const { startBounds } = params;
  const direction = resolveStudioGraphResizeZoneDirection(params.zone);
  const deltaX = Number.isFinite(params.deltaX) ? params.deltaX : 0;
  const deltaY = Number.isFinite(params.deltaY) ? params.deltaY : 0;

  const minWidth = Math.max(1, startBounds.width * STUDIO_SELECTION_MIN_GROUP_SCALE);
  const minHeight = Math.max(1, startBounds.height * STUDIO_SELECTION_MIN_GROUP_SCALE);
  const width =
    direction.x === 0
      ? startBounds.width
      : Math.max(startBounds.width + direction.x * deltaX, minWidth);
  const height =
    direction.y === 0
      ? startBounds.height
      : Math.max(startBounds.height + direction.y * deltaY, minHeight);

  return {
    bounds: {
      left: direction.x === -1 ? startBounds.left + (startBounds.width - width) : startBounds.left,
      top: direction.y === -1 ? startBounds.top + (startBounds.height - height) : startBounds.top,
      width,
      height,
    },
    scaleX: startBounds.width > 0 ? width / startBounds.width : 1,
    scaleY: startBounds.height > 0 ? height / startBounds.height : 1,
  };
}

/**
 * Full group transform: new bounds plus one geometry patch per unlocked
 * node (position always; size/fontSize levers per the mode table above).
 */
export function resolveStudioSelectionResizePatches(params: {
  zone: StudioGraphResizeZone;
  deltaX: number;
  deltaY: number;
  startBounds: StudioSelectionRect;
  nodes: readonly StudioSelectionResizeNodeSnapshot[];
}): StudioSelectionResizeResult {
  const direction = resolveStudioGraphResizeZoneDirection(params.zone);
  const group = resolveStudioSelectionGroupResize(params);
  const { startBounds } = params;
  const xActive = direction.x !== 0;
  const yActive = direction.y !== 0;

  const patches: StudioSelectionResizePatchEntry[] = [];
  for (const node of params.nodes) {
    if (node.interactionLocked) {
      continue;
    }

    const mode = resolveStudioNodeResizeSemantics(node.kind, {
      hasAspectMediaContent: node.hasAspectMediaContent,
    });
    const bounds = resolveStudioGraphNodeResizeBounds({ kind: node.kind });
    const patch: StudioGraphNodeResizePatch = {};

    if (mode === "text") {
      if (xActive) {
        patch.size = {
          width: clampStudioNodeDimension(
            node.rect.width * group.scaleX,
            bounds.minWidth,
            bounds.maxWidth
          ),
        };
      }
      if (yActive) {
        patch.fontSize = clampStudioNodeDimension(
          node.fontSize * group.scaleY,
          STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
          STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE
        );
      }
    } else if (mode === "aspect-width") {
      // Width is the single lever; on pure vertical drags the y-factor
      // routes onto it (rendered height follows the intrinsic aspect).
      const factor = xActive ? group.scaleX : group.scaleY;
      patch.size = {
        width: clampStudioNodeDimension(
          node.rect.width * factor,
          bounds.minWidth,
          bounds.maxWidth
        ),
      };
    } else {
      // "box" (explicit height) and "min-height" (height floor) share the
      // same lever math; the DOM/persist layer interprets height per mode.
      const size: NonNullable<StudioGraphNodeResizePatch["size"]> = {};
      if (xActive) {
        size.width = clampStudioNodeDimension(
          node.rect.width * group.scaleX,
          bounds.minWidth,
          bounds.maxWidth
        );
      }
      if (yActive) {
        size.height = clampStudioNodeDimension(
          node.rect.height * group.scaleY,
          bounds.minHeight,
          bounds.maxHeight
        );
      }
      if (size.width !== undefined || size.height !== undefined) {
        patch.size = size;
      }
    }

    // Positions interpolate from the RAW group transform (normalized start
    // offset × new group size), never from clamped node sizes.
    patch.position = {
      x: floorCanvasPosition(
        group.bounds.left + (node.rect.left - startBounds.left) * group.scaleX
      ),
      y: floorCanvasPosition(
        group.bounds.top + (node.rect.top - startBounds.top) * group.scaleY
      ),
    };

    patches.push({ nodeId: node.nodeId, patch });
  }

  return { ...group, patches };
}
