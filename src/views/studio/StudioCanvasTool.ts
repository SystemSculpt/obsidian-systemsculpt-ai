import { STUDIO_SHAPE_KINDS } from "../../studio/StudioShapes";
import type { StudioShapeKind } from "../../studio/types";

/**
 * The armed canvas tool. "select" is the normal pointer (drag nodes, marquee,
 * pan); the shape tools draw freeform on the canvas; "arrow" drags a link from
 * any node or shape to another.
 */
export type StudioCanvasTool = "select" | StudioShapeKind | "arrow";

export function resolveStudioCanvasToolShape(tool: StudioCanvasTool): StudioShapeKind | null {
  return STUDIO_SHAPE_KINDS.includes(tool as StudioShapeKind) ? (tool as StudioShapeKind) : null;
}
