import type { StudioNodeInstance, StudioProjectV1, StudioShapeInstance } from "../../../studio/types";
import {
  resolveMeasuredStudioNodeHeight,
  resolveMeasuredStudioNodeWidth,
} from "../../../studio/StudioNodeGeometry";
import { getStudioOwnerWindow } from "../StudioDomContext";
import type { StudioGuideRect } from "./StudioGraphAlignmentGuides";

type NodeSize = { width: number; height: number };
type NodeMeasurement = { width: number | undefined; height: number | undefined };

/**
 * Canvas-space geometry, independent of scroll and zoom. Project/render changes
 * refresh the index once; pointer frames read cached sizes and update only the
 * objects they move. Card layout changes enter through their owner-window
 * ResizeObserver, not repeated offset reads during gestures.
 */
export class StudioCanvasGeometry {
  private project: StudioProjectV1 | null = null;
  private nodes: StudioNodeInstance[] | null = null;
  private shapes: StudioShapeInstance[] | undefined;
  private nodeCount = 0;
  private shapeCount = 0;
  private readonly nodeById = new Map<string, StudioNodeInstance>();
  private readonly nodeIndexById = new Map<string, number>();
  private readonly shapeById = new Map<string, StudioShapeInstance>();
  private readonly nodeElements = new Map<string, HTMLElement>();
  private readonly nodeObservers = new Map<string, ResizeObserver>();
  private readonly measurements = new Map<string, NodeMeasurement>();
  private readonly nodeSizes = new Map<string, NodeSize>();
  private readonly nodeRects = new Map<string, StudioGuideRect>();
  private readonly shapeRects = new Map<string, StudioGuideRect>();
  private nodeBounds: StudioGuideRect | null = null;
  private nodeBoundsDirty = true;
  private geometryRevision = 0;

  constructor(
    private readonly getCurrentProject: () => StudioProjectV1 | null,
    private readonly onGeometryChange?: (nodeId: string) => void
  ) {}

  /** Changes to stationary geometry invalidate a gesture's alignment targets. */
  get revision(): number {
    this.ensureProject();
    return this.geometryRevision;
  }

  /** Synchronize in-place external edits and current DOM layout at a render boundary. */
  refresh(): void {
    this.project = this.getCurrentProject();
    this.nodes = this.project?.graph.nodes ?? null;
    this.shapes = this.project?.diagram?.shapes;
    this.nodeCount = this.nodes?.length ?? 0;
    this.shapeCount = this.shapes?.length ?? 0;
    this.nodeById.clear();
    this.nodeIndexById.clear();
    this.shapeById.clear();
    this.nodeSizes.clear();
    this.nodeRects.clear();
    this.shapeRects.clear();
    for (const [index, node] of (this.nodes ?? []).entries()) {
      this.nodeById.set(node.id, node);
      this.nodeIndexById.set(node.id, index);
      this.measureNode(node.id);
      this.updateNodeRect(node.id);
    }
    for (const shape of this.shapes ?? []) {
      this.shapeById.set(shape.id, shape);
      this.updateShapeRect(shape.id);
    }
    this.nodeBoundsDirty = true;
    this.geometryRevision++;
  }

  /** Mutation drafts preserve node order; never return a live node for a draft write. */
  getNode(nodeId: string, project?: StudioProjectV1): StudioNodeInstance | null {
    this.ensureProject();
    if (!project || project === this.project) return this.nodeById.get(nodeId) ?? null;
    const index = this.nodeIndexById.get(nodeId);
    const node = index === undefined ? undefined : project.graph.nodes[index];
    return node?.id === nodeId ? node : project.graph.nodes.find(candidate => candidate.id === nodeId) ?? null;
  }

  /** Remeasure only cards resized by a continuous geometry mutation. */
  refreshNodes(nodeIds: Iterable<string>): void {
    this.ensureProject();
    let changed = false;
    for (const nodeId of nodeIds) {
      changed = this.measureNode(nodeId) || changed;
      this.updateNodeRect(nodeId);
    }
    if (changed) this.geometryRevision++;
  }

  getNodeSize(nodeId: string): NodeSize | null {
    this.ensureProject();
    this.updateNodeRect(nodeId);
    return this.nodeSizes.get(nodeId) ?? null;
  }

  /** A moved node updates its cached rect without remeasuring or scanning peers. */
  getNodeRect(nodeId: string): StudioGuideRect | null {
    this.ensureProject();
    return this.updateNodeRect(nodeId);
  }

  getNodeRects(): ReadonlyMap<string, StudioGuideRect> {
    this.ensureProject();
    return this.nodeRects;
  }

  getShape(shapeId: string): StudioShapeInstance | null {
    this.ensureProject();
    return this.shapeById.get(shapeId) ?? null;
  }

  getShapeRect(shapeId: string): StudioGuideRect | null {
    this.ensureProject();
    return this.updateShapeRect(shapeId);
  }

  getShapeRects(): ReadonlyMap<string, StudioGuideRect> {
    this.ensureProject();
    return this.shapeRects;
  }

  getNodeBounds(nodeIds?: Iterable<string>): StudioGuideRect | null {
    this.ensureProject();
    if (nodeIds) {
      let bounds: StudioGuideRect | null = null;
      for (const nodeId of nodeIds) {
        bounds = this.includeRect(bounds, this.updateNodeRect(nodeId));
      }
      return bounds;
    }
    if (this.nodeBoundsDirty) {
      this.nodeBounds = null;
      for (const rect of this.nodeRects.values()) {
        this.nodeBounds = this.includeRect(this.nodeBounds, rect);
      }
      this.nodeBoundsDirty = false;
    }
    return this.nodeBounds;
  }

  getNodeElement(nodeId: string): HTMLElement | null {
    return this.nodeElements.get(nodeId) ?? null;
  }

  getNodeElements(): ReadonlyMap<string, HTMLElement> {
    return this.nodeElements;
  }

  registerNodeElement(nodeId: string, element: HTMLElement): void {
    this.ensureProject();
    this.nodeObservers.get(nodeId)?.disconnect();
    this.nodeObservers.delete(nodeId);
    this.nodeElements.set(nodeId, element);
    this.measureNode(nodeId);
    this.updateNodeRect(nodeId);
    this.geometryRevision++;
    const Observer = (getStudioOwnerWindow(element) as Window & {
      ResizeObserver?: typeof ResizeObserver;
    }).ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(() => {
      // A queued callback from a replaced card must not touch its successor.
      if (this.nodeElements.get(nodeId) !== element) return;
      this.ensureProject();
      if (!this.measureNode(nodeId)) return;
      this.updateNodeRect(nodeId);
      this.geometryRevision++;
      this.onGeometryChange?.(nodeId);
    });
    this.nodeObservers.set(nodeId, observer);
    observer.observe(element);
  }

  clearNodeElements(): void {
    for (const observer of this.nodeObservers.values()) observer.disconnect();
    this.nodeObservers.clear();
    this.nodeElements.clear();
    this.measurements.clear();
    for (const nodeId of this.nodeById.keys()) this.updateNodeRect(nodeId);
    this.geometryRevision++;
  }

  private ensureProject(): void {
    const project = this.getCurrentProject();
    const nodes = project?.graph.nodes ?? null;
    const shapes = project?.diagram?.shapes;
    if (project !== this.project || nodes !== this.nodes || shapes !== this.shapes ||
      (nodes?.length ?? 0) !== this.nodeCount || (shapes?.length ?? 0) !== this.shapeCount) {
      this.refresh();
    }
  }

  private measureNode(nodeId: string): boolean {
    const element = this.nodeElements.get(nodeId);
    const next = { width: element?.offsetWidth, height: element?.offsetHeight };
    const previous = this.measurements.get(nodeId);
    this.measurements.set(nodeId, next);
    return previous?.width !== next.width || previous?.height !== next.height;
  }

  private updateNodeRect(nodeId: string): StudioGuideRect | null {
    const node = this.nodeById.get(nodeId);
    if (!node) return null;
    const measurement = this.measurements.get(nodeId);
    const width = resolveMeasuredStudioNodeWidth(measurement?.width, node);
    const height = resolveMeasuredStudioNodeHeight(measurement?.height);
    const size = this.nodeSizes.get(nodeId);
    if (!size || size.width !== width || size.height !== height) {
      this.nodeSizes.set(nodeId, { width, height });
    }
    const left = Number(node.position?.x), top = Number(node.position?.y);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      if (this.nodeRects.delete(nodeId)) this.nodeBoundsDirty = true;
      return null;
    }
    const right = left + width, bottom = top + height;
    const previous = this.nodeRects.get(nodeId);
    if (previous && previous.left === left && previous.top === top &&
      previous.right === right && previous.bottom === bottom) return previous;
    const rect = { left, top, right, bottom };
    this.nodeRects.set(nodeId, rect);
    this.nodeBoundsDirty = true;
    return rect;
  }

  private updateShapeRect(shapeId: string): StudioGuideRect | null {
    const shape = this.shapeById.get(shapeId);
    if (!shape) return null;
    const left = shape.position.x, top = shape.position.y;
    const right = left + shape.size.width, bottom = top + shape.size.height;
    const previous = this.shapeRects.get(shapeId);
    if (previous && previous.left === left && previous.top === top &&
      previous.right === right && previous.bottom === bottom) return previous;
    const rect = { left, top, right, bottom };
    this.shapeRects.set(shapeId, rect);
    return rect;
  }

  private includeRect(bounds: StudioGuideRect | null, rect: StudioGuideRect | null): StudioGuideRect | null {
    if (!rect) return bounds;
    if (!bounds) return { ...rect };
    bounds.left = Math.min(bounds.left, rect.left);
    bounds.top = Math.min(bounds.top, rect.top);
    bounds.right = Math.max(bounds.right, rect.right);
    bounds.bottom = Math.max(bounds.bottom, rect.bottom);
    return bounds;
  }
}
