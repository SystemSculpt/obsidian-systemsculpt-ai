import type {
  StudioDiagram,
  StudioEdge,
  StudioJsonValue,
  StudioNodeInstance,
  StudioProjectV1,
  StudioShapeArrow,
  StudioShapeInstance,
  StudioShapeKind,
} from "./types";
import { asNumber, asString, ensureArray, isRecord, randomId } from "./utils";

/**
 * Behavior for the Studio diagram layer — the tldraw surface that shares a
 * canvas with the ComfyUI-style dataflow graph but nothing else.
 *
 * A shape is NOT a node: it has no kind, no version, no ports, no config, no
 * definition in the node registry, and it never reaches the compiler or the
 * runtime. It lives in `project.diagram`, beside `project.graph`, so a run can
 * neither see it nor be broken by it. Arrows connect shape to shape only;
 * shape-to-node interaction is deliberately absent for now.
 *
 * `style` is the reserved home for shape properties (fill, stroke, font …).
 * Normalization preserves whatever it finds there so a future property can be
 * added without a migration.
 */
export const STUDIO_SHAPE_KINDS: readonly StudioShapeKind[] = [
  "rectangle",
  "ellipse",
  "diamond",
  "pill",
  "cylinder",
  "note",
  "hexagon",
];

const DEFAULT_SHAPE_KIND: StudioShapeKind = "rectangle";

export const STUDIO_SHAPE_DEFAULT_WIDTH = 180;
export const STUDIO_SHAPE_DEFAULT_HEIGHT = 120;
export const STUDIO_SHAPE_MIN_WIDTH = 48;
export const STUDIO_SHAPE_MIN_HEIGHT = 48;
export const STUDIO_SHAPE_MAX_WIDTH = 4000;
export const STUDIO_SHAPE_MAX_HEIGHT = 4000;

export function createEmptyStudioDiagram(): StudioDiagram {
  return { shapes: [], arrows: [] };
}

export function resolveStudioShapeKind(value: unknown): StudioShapeKind {
  const raw = String(value ?? "").trim();
  return STUDIO_SHAPE_KINDS.includes(raw as StudioShapeKind)
    ? (raw as StudioShapeKind)
    : DEFAULT_SHAPE_KIND;
}

export function clampStudioShapeWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return STUDIO_SHAPE_DEFAULT_WIDTH;
  }
  return Math.round(Math.min(STUDIO_SHAPE_MAX_WIDTH, Math.max(STUDIO_SHAPE_MIN_WIDTH, value)));
}

export function clampStudioShapeHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return STUDIO_SHAPE_DEFAULT_HEIGHT;
  }
  return Math.round(Math.min(STUDIO_SHAPE_MAX_HEIGHT, Math.max(STUDIO_SHAPE_MIN_HEIGHT, value)));
}

export function createStudioShape(options: {
  shape: StudioShapeKind;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  label?: string;
}): StudioShapeInstance {
  return {
    id: randomId("shape"),
    shape: options.shape,
    position: {
      x: Math.round(Number.isFinite(options.position.x) ? options.position.x : 0),
      y: Math.round(Number.isFinite(options.position.y) ? options.position.y : 0),
    },
    size: {
      width: clampStudioShapeWidth(options.size?.width ?? STUDIO_SHAPE_DEFAULT_WIDTH),
      height: clampStudioShapeHeight(options.size?.height ?? STUDIO_SHAPE_DEFAULT_HEIGHT),
    },
    label: options.label ?? "",
  };
}

function readShape(raw: unknown, index: number): StudioShapeInstance | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = asString(raw.id).trim() || randomId(`shape${index}`);
  const position = isRecord(raw.position) ? raw.position : {};
  const size = isRecord(raw.size) ? raw.size : {};
  const style = isRecord(raw.style) ? (raw.style as Record<string, StudioJsonValue>) : null;
  return {
    id,
    shape: resolveStudioShapeKind(raw.shape),
    position: {
      x: Math.round(asNumber(position.x) ?? 0),
      y: Math.round(asNumber(position.y) ?? 0),
    },
    size: {
      width: clampStudioShapeWidth(asNumber(size.width) ?? STUDIO_SHAPE_DEFAULT_WIDTH),
      height: clampStudioShapeHeight(asNumber(size.height) ?? STUDIO_SHAPE_DEFAULT_HEIGHT),
    },
    label: asString(raw.label),
    ...(style ? { style } : {}),
  };
}

/**
 * Diagram data is presentation, never execution, so normalization heals rather
 * than throws: an unreadable shape is dropped and an arrow that points at a
 * missing shape disappears with it, exactly like a deleted shape's arrows.
 */
export function readStudioDiagram(raw: unknown): StudioDiagram {
  if (!isRecord(raw)) {
    return createEmptyStudioDiagram();
  }

  const shapes: StudioShapeInstance[] = [];
  const shapeIds = new Set<string>();
  ensureArray<unknown>(raw.shapes).forEach((entry, index) => {
    const shape = readShape(entry, index);
    if (!shape || shapeIds.has(shape.id)) {
      return;
    }
    shapeIds.add(shape.id);
    shapes.push(shape);
  });

  const arrows: StudioShapeArrow[] = [];
  const arrowPairs = new Set<string>();
  ensureArray<unknown>(raw.arrows).forEach((entry, index) => {
    if (!isRecord(entry)) {
      return;
    }
    const fromShapeId = asString(entry.fromShapeId).trim();
    const toShapeId = asString(entry.toShapeId).trim();
    if (!shapeIds.has(fromShapeId) || !shapeIds.has(toShapeId) || fromShapeId === toShapeId) {
      return;
    }
    const pair = `${fromShapeId}->${toShapeId}`;
    if (arrowPairs.has(pair)) {
      return;
    }
    arrowPairs.add(pair);
    const label = asString(entry.label);
    arrows.push({
      id: asString(entry.id).trim() || randomId(`arrow${index}`),
      fromShapeId,
      toShapeId,
      ...(label ? { label } : {}),
    });
  });

  return { shapes, arrows };
}

/**
 * Shapes briefly shipped as a visual-only node kind before they became their
 * own layer. Load-time conversion lifts those nodes out of the graph into the
 * diagram: an edge between two shape nodes becomes an arrow, and an edge that
 * straddled a shape and a real node is dropped — the two layers no longer
 * connect. Idempotent: once converted, no shape node remains to find.
 */
const LEGACY_SHAPE_NODE_KIND = "studio.shape";

export function convertLegacyShapeNodesToDiagram(input: {
  nodes: StudioNodeInstance[];
  edges: StudioEdge[];
}): { nodes: StudioNodeInstance[]; edges: StudioEdge[]; diagram: StudioDiagram } | null {
  const legacyNodes = input.nodes.filter((node) => node.kind === LEGACY_SHAPE_NODE_KIND);
  if (legacyNodes.length === 0) {
    return null;
  }

  const legacyIds = new Set(legacyNodes.map((node) => node.id));
  const shapes = legacyNodes.map<StudioShapeInstance>((node) => ({
    id: node.id,
    shape: resolveStudioShapeKind(node.config?.shape),
    position: {
      x: Math.round(node.position?.x ?? 0),
      y: Math.round(node.position?.y ?? 0),
    },
    size: {
      width: clampStudioShapeWidth(node.size?.width ?? STUDIO_SHAPE_DEFAULT_WIDTH),
      height: clampStudioShapeHeight(node.size?.height ?? STUDIO_SHAPE_DEFAULT_HEIGHT),
    },
    label: typeof node.config?.label === "string" ? node.config.label : "",
  }));

  const arrows: StudioShapeArrow[] = [];
  const arrowPairs = new Set<string>();
  for (const edge of input.edges) {
    if (!legacyIds.has(edge.fromNodeId) || !legacyIds.has(edge.toNodeId)) {
      continue;
    }
    const pair = `${edge.fromNodeId}->${edge.toNodeId}`;
    if (edge.fromNodeId === edge.toNodeId || arrowPairs.has(pair)) {
      continue;
    }
    arrowPairs.add(pair);
    arrows.push({ id: edge.id, fromShapeId: edge.fromNodeId, toShapeId: edge.toNodeId });
  }

  return {
    nodes: input.nodes.filter((node) => !legacyIds.has(node.id)),
    edges: input.edges.filter(
      (edge) => !legacyIds.has(edge.fromNodeId) && !legacyIds.has(edge.toNodeId)
    ),
    diagram: { shapes, arrows },
  };
}

/** Always-present diagram accessor; a project persisted before shapes existed has none. */
export function readStudioDiagramFromProject(project: StudioProjectV1): StudioDiagram {
  return project.diagram ?? createEmptyStudioDiagram();
}

export function findStudioShape(
  project: StudioProjectV1,
  shapeId: string
): StudioShapeInstance | null {
  return readStudioDiagramFromProject(project).shapes.find((shape) => shape.id === shapeId) ?? null;
}

/**
 * Mutation entry point. Every shape edit routes through here so `diagram` is
 * materialized exactly once and callers never branch on its absence.
 */
export function mutateStudioDiagram(
  project: StudioProjectV1,
  mutate: (diagram: StudioDiagram) => boolean | void
): boolean {
  const diagram = project.diagram ?? createEmptyStudioDiagram();
  const changed = mutate(diagram) !== false;
  if (!changed) {
    return false;
  }
  project.diagram = diagram;
  return true;
}

/** Removes a shape and every arrow that touched it. */
export function removeStudioShape(project: StudioProjectV1, shapeId: string): boolean {
  return mutateStudioDiagram(project, (diagram) => {
    const nextShapes = diagram.shapes.filter((shape) => shape.id !== shapeId);
    if (nextShapes.length === diagram.shapes.length) {
      return false;
    }
    diagram.shapes = nextShapes;
    diagram.arrows = diagram.arrows.filter(
      (arrow) => arrow.fromShapeId !== shapeId && arrow.toShapeId !== shapeId
    );
    return true;
  });
}

/** Sets or clears the text drawn at an arrow's midpoint. */
export function setStudioShapeArrowLabel(
  project: StudioProjectV1,
  arrowId: string,
  label: string
): boolean {
  return mutateStudioDiagram(project, (diagram) => {
    const arrow = diagram.arrows.find((candidate) => candidate.id === arrowId);
    if (!arrow || (arrow.label || "") === label) {
      return false;
    }
    if (label) {
      arrow.label = label;
    } else {
      delete arrow.label;
    }
    return true;
  });
}

export function removeStudioShapeArrow(project: StudioProjectV1, arrowId: string): boolean {
  return mutateStudioDiagram(project, (diagram) => {
    const nextArrows = diagram.arrows.filter((arrow) => arrow.id !== arrowId);
    if (nextArrows.length === diagram.arrows.length) {
      return false;
    }
    diagram.arrows = nextArrows;
    return true;
  });
}

/** Connects two shapes, ignoring self-links and duplicates of an existing arrow. */
export function connectStudioShapes(
  project: StudioProjectV1,
  fromShapeId: string,
  toShapeId: string
): boolean {
  return mutateStudioDiagram(project, (diagram) => {
    if (fromShapeId === toShapeId) {
      return false;
    }
    const shapeIds = new Set(diagram.shapes.map((shape) => shape.id));
    if (!shapeIds.has(fromShapeId) || !shapeIds.has(toShapeId)) {
      return false;
    }
    const exists = diagram.arrows.some(
      (arrow) => arrow.fromShapeId === fromShapeId && arrow.toShapeId === toShapeId
    );
    if (exists) {
      return false;
    }
    diagram.arrows.push({ id: randomId("arrow"), fromShapeId, toShapeId });
    return true;
  });
}
