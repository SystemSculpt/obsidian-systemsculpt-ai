import type { StudioNodeInstance } from "../../../studio/types";
import type { StudioGraphNodeResizePatch } from "../canvas/StudioGraphNodeCardTypes";
import {
  clampStudioNodeDimension,
  isStudioFillTextNode,
  resolveStudioGraphNodeWidth,
  STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
  STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
  STUDIO_TEXT_NODE_WIDTH_MODE_KEY,
} from "../../../studio/StudioNodeGeometry";

/** The one geometry-patch application shared by single and group resizes. */
export function applyStudioNodeResizePatch(
  target: StudioNodeInstance,
  patch: StudioGraphNodeResizePatch
): boolean {
  let mutated = false;
  if (patch.size && (patch.size.width !== undefined || patch.size.height !== undefined)) {
    // Geometry is first-class canvas data. Height is optional: text and
    // aspect-driven media cards persist width only. Any lingering legacy
    // config geometry is ignored by the resolvers (size wins) and
    // stripped by the load migration on the next open.
    const nextWidth =
      patch.size.width !== undefined
        ? Math.max(1, Math.round(patch.size.width))
        : (target.size?.width ?? resolveStudioGraphNodeWidth(target));
    const nextHeight =
      patch.size.height !== undefined
        ? Math.max(1, Math.round(patch.size.height))
        : target.size?.height;
    if (target.size?.width !== nextWidth || target.size?.height !== nextHeight) {
      target.size = {
        width: nextWidth,
        ...(nextHeight !== undefined ? { height: nextHeight } : {}),
      };
      mutated = true;
    }
    // A dragged width ends a text card's auto sizing (tldraw parity).
    if (target.kind === "studio.text" && !isStudioFillTextNode(target) && patch.size.width !== undefined && target.config[STUDIO_TEXT_NODE_WIDTH_MODE_KEY] !== "fixed") {
      target.config[STUDIO_TEXT_NODE_WIDTH_MODE_KEY] = "fixed";
      mutated = true;
    }
  }
  if (patch.position) {
    const nextX = Math.round(patch.position.x);
    const nextY = Math.round(patch.position.y);
    if (target.position.x !== nextX || target.position.y !== nextY) {
      target.position.x = nextX;
      target.position.y = nextY;
      mutated = true;
    }
  }
  if (patch.fontSize !== undefined) {
    const nextFontSize = clampStudioNodeDimension(
      patch.fontSize,
      STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
      STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE
    );
    if (target.config.fontSize !== nextFontSize) {
      target.config.fontSize = nextFontSize;
      mutated = true;
    }
  }
  return mutated;
}

