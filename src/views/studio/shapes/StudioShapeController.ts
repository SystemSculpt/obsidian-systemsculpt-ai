import type { StudioProjectSessionMutationReason } from "../../../studio/StudioProjectSession";
import type { StudioProjectV1, StudioShapeKind } from "../../../studio/types";
import {
  clampStudioShapeHeight,
  clampStudioShapeWidth,
  connectStudioShapes,
  createStudioShape,
  findStudioShape,
  mutateStudioDiagram,
  readStudioDiagramFromProject,
  removeStudioShape,
  removeStudioShapeArrow,
  setStudioShapeArrowLabel,
  STUDIO_SHAPE_DEFAULT_HEIGHT,
  STUDIO_SHAPE_DEFAULT_WIDTH,
  STUDIO_SHAPE_MIN_HEIGHT,
  STUDIO_SHAPE_MIN_WIDTH,
} from "../../../studio/StudioShapes";
import { removeShapesFromGroups } from "../../../studio/StudioGraphGroupModel";
import { startStudioShapeDrawGesture } from "./StudioShapeDrawGesture";
import {
  clearStudioShapeSelectionVisuals,
  EMPTY_STUDIO_SHAPE_SELECTION,
  type StudioShapeDragPhase,
  type StudioShapeLayerHandle,
  type StudioShapeLayerOptions,
  type StudioShapeRect,
  type StudioShapeSelection,
  type StudioShapeTarget,
} from "./StudioShapeLayer";

/**
 * Owns the diagram half of the canvas selection and every shape edit.
 *
 * Selection, delete, and drag are deliberately NOT diagram-only concepts: a
 * marquee sweeps nodes and shapes together, and dragging either kind moves the
 * whole selection. This controller therefore exposes the same three-step
 * translation contract the node side does — begin, apply, finish — so whichever
 * layer owns the gesture can move the other one through it.
 */
export type StudioShapeControllerHost = {
  isBusy: () => boolean;
  getCanvasEl: () => HTMLElement | null;
  getGraphZoom: () => number;
  commitMutation: (
    reason: StudioProjectSessionMutationReason,
    mutator: (project: StudioProjectV1) => boolean | void,
    options?: { captureHistory?: boolean; mode?: "continuous" }
  ) => boolean;
  getCurrentProject: () => StudioProjectV1 | null;
  clearNodeSelection: () => void;
  requestRender: () => void;
  /** Node side of a drag that started on a shape. */
  beginNodeTranslation: () => void;
  translateNodes: (project: StudioProjectV1, delta: { x: number; y: number }) => boolean;
  previewNodeTranslation: () => void;
  finishNodeTranslation: () => void;
};

type ShapeOrigin = { shapeId: string; x: number; y: number };

export class StudioShapeController {
  private shapeIds = new Set<string>();
  private arrowIds = new Set<string>();
  private layerHandle: StudioShapeLayerHandle | null = null;
  private translationOrigins: ShapeOrigin[] = [];
  private marqueeBaseline: StudioShapeSelection = EMPTY_STUDIO_SHAPE_SELECTION;

  constructor(private readonly host: StudioShapeControllerHost) {}

  getSelection(): StudioShapeSelection {
    return { shapeIds: [...this.shapeIds], arrowIds: [...this.arrowIds] };
  }

  getSelectedShapeIds(): string[] {
    return [...this.shapeIds];
  }

  hasSelection(): boolean {
    return this.shapeIds.size > 0 || this.arrowIds.size > 0;
  }

  clearSelection(): void {
    this.shapeIds.clear();
    this.arrowIds.clear();
  }

  /**
   * Replaces the diagram selection outright — the paste path, where the caller
   * already owns the node selection and the render that follows.
   */
  setSelectedShapeIds(shapeIds: readonly string[]): void {
    this.shapeIds = new Set(shapeIds);
    this.arrowIds.clear();
  }

  /**
   * Drops the selection without a re-render. Deselecting happens during a
   * pointerdown another layer may still need (a node drag starting on its
   * card), so the visuals are cleared in place instead.
   */
  clearSelectionInPlace(): void {
    if (!this.hasSelection()) {
      return;
    }
    this.clearSelection();
    const canvasEl = this.host.getCanvasEl();
    if (canvasEl) {
      clearStudioShapeSelectionVisuals(canvasEl);
    }
  }

  select(target: StudioShapeTarget, options?: { additive?: boolean }): void {
    const additive = options?.additive === true;
    const set = target.type === "shape" ? this.shapeIds : this.arrowIds;
    if (additive) {
      if (set.has(target.id)) {
        set.delete(target.id);
      } else {
        set.add(target.id);
      }
    } else {
      if (this.shapeIds.size === 1 && this.shapeIds.has(target.id) && this.arrowIds.size === 0) {
        return;
      }
      if (this.arrowIds.size === 1 && this.arrowIds.has(target.id) && this.shapeIds.size === 0) {
        return;
      }
      this.clearSelection();
      set.add(target.id);
      this.host.clearNodeSelection();
    }
    this.host.requestRender();
  }

  /**
   * Marquee pass for the diagram layer, driven by the graph's marquee so one
   * sweep collects nodes and shapes. Visuals are refreshed in place because the
   * gesture is still live.
   */
  beginMarquee(): void {
    this.marqueeBaseline = this.getSelection();
  }

  selectInBounds(
    bounds: { left: number; top: number; right: number; bottom: number },
    options: { additive: boolean }
  ): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }
    const inside = new Set<string>();
    for (const shape of readStudioDiagramFromProject(project).shapes) {
      const left = shape.position.x;
      const top = shape.position.y;
      const right = left + shape.size.width;
      const bottom = top + shape.size.height;
      if (left <= bounds.right && right >= bounds.left && top <= bounds.bottom && bottom >= bounds.top) {
        inside.add(shape.id);
      }
    }
    this.shapeIds = options.additive
      ? new Set([...this.marqueeBaseline.shapeIds, ...inside])
      : inside;
    this.arrowIds = new Set(options.additive ? this.marqueeBaseline.arrowIds : []);
    this.refreshSelectionVisuals();
  }

  registerLayerHandle(handle: StudioShapeLayerHandle | null): void {
    this.layerHandle = handle;
  }

  /**
   * Snapshots where shapes started, for a drag of any layer. Defaults to the
   * selection; a group drag passes its own members instead.
   */
  beginTranslation(shapeIds?: readonly string[]): void {
    const project = this.host.getCurrentProject();
    const moving = shapeIds ? new Set(shapeIds) : this.shapeIds;
    this.translationOrigins = project
      ? readStudioDiagramFromProject(project)
          .shapes.filter((shape) => moving.has(shape.id))
          .map((shape) => ({ shapeId: shape.id, x: shape.position.x, y: shape.position.y }))
      : [];
  }

  /** Writes the dragged shapes to `origin + delta`; part of the caller's mutation. */
  applyTranslation(project: StudioProjectV1, delta: { x: number; y: number }): boolean {
    if (this.translationOrigins.length === 0) {
      return false;
    }
    let changed = false;
    const shapes = readStudioDiagramFromProject(project).shapes;
    for (const origin of this.translationOrigins) {
      const shape = shapes.find((candidate) => candidate.id === origin.shapeId);
      if (!shape) {
        continue;
      }
      const x = Math.round(origin.x + delta.x);
      const y = Math.round(origin.y + delta.y);
      if (shape.position.x !== x || shape.position.y !== y) {
        shape.position = { x, y };
        changed = true;
      }
    }
    return changed;
  }

  /** Pushes committed positions into the live layer without a re-render. */
  previewTranslation(): void {
    const project = this.host.getCurrentProject();
    if (!project || !this.layerHandle || this.translationOrigins.length === 0) {
      return;
    }
    const shapes = readStudioDiagramFromProject(project).shapes;
    this.layerHandle.applyShapePositions(
      this.translationOrigins
        .map(({ shapeId }) => shapes.find((shape) => shape.id === shapeId))
        .filter((shape): shape is NonNullable<typeof shape> => Boolean(shape))
        .map((shape) => ({ shapeId: shape.id, position: { ...shape.position } }))
    );
  }

  finishTranslation(): void {
    this.translationOrigins = [];
  }

  /**
   * Freeform draw: the armed tool turns a canvas drag into the new shape's
   * bounds. `onSettled` runs on commit AND cancel so the caller can disarm.
   */
  startDrawGesture(shape: StudioShapeKind, startEvent: PointerEvent, onSettled: () => void): void {
    const canvasEl = this.host.getCanvasEl();
    if (!canvasEl) {
      return;
    }
    startStudioShapeDrawGesture({
      canvasEl,
      startEvent,
      shape,
      getGraphZoom: () => this.host.getGraphZoom(),
      minWidth: STUDIO_SHAPE_MIN_WIDTH,
      minHeight: STUDIO_SHAPE_MIN_HEIGHT,
      defaultWidth: STUDIO_SHAPE_DEFAULT_WIDTH,
      defaultHeight: STUDIO_SHAPE_DEFAULT_HEIGHT,
      onCommit: (rect) => {
        const created = createStudioShape({
          shape,
          position: { x: rect.x, y: rect.y },
          size: { width: rect.width, height: rect.height },
        });
        this.host.commitMutation("diagram.shape.create", (project) =>
          mutateStudioDiagram(project, (diagram) => {
            diagram.shapes.push(created);
          })
        );
        this.clearSelection();
        this.shapeIds.add(created.id);
        onSettled();
      },
      onCancel: onSettled,
    });
  }

  /** Delete for the diagram layer; false when nothing was selected. */
  removeSelection(): boolean {
    if (!this.hasSelection() || this.host.isBusy()) {
      return false;
    }
    const shapeIds = [...this.shapeIds];
    const arrowIds = [...this.arrowIds];
    const changed = this.host.commitMutation("diagram.remove", (project) => {
      let removed = false;
      for (const arrowId of arrowIds) {
        removed = removeStudioShapeArrow(project, arrowId) || removed;
      }
      for (const shapeId of shapeIds) {
        removed = removeStudioShape(project, shapeId) || removed;
      }
      // A deleted shape leaves its group, exactly like a deleted node.
      removed = removeShapesFromGroups(project, shapeIds) || removed;
      return removed;
    });
    this.clearSelection();
    this.host.requestRender();
    return changed;
  }

  /** Callbacks handed to the renderer; the layer drives its own gestures. */
  layerOptions(): Pick<
    StudioShapeLayerOptions,
    | "selection"
    | "onSelect"
    | "onMoveSelection"
    | "onResizeShape"
    | "onLabelChange"
    | "onArrowLabelChange"
    | "onConnectShapes"
  > & { registerLayerHandle: (handle: StudioShapeLayerHandle | null) => void } {
    return {
      selection: this.getSelection(),
      onSelect: (target, options) => this.select(target, options),
      onMoveSelection: (delta, phase) => this.moveSelection(delta, phase),
      onResizeShape: (shapeId, rect) => this.resizeShape(shapeId, rect),
      onLabelChange: (shapeId, label) => this.setLabel(shapeId, label),
      onArrowLabelChange: (arrowId, label) => this.setArrowLabel(arrowId, label),
      onConnectShapes: (fromShapeId, toShapeId) => this.connect(fromShapeId, toShapeId),
      registerLayerHandle: (handle) => this.registerLayerHandle(handle),
    };
  }

  /**
   * A drag that started on a shape. One mutation moves the shapes and the
   * selected nodes, so a mixed selection travels together and undo takes one
   * step back — the same contract as dragging from a node card.
   */
  private moveSelection(delta: { x: number; y: number }, phase: StudioShapeDragPhase): void {
    if (phase.first) {
      this.beginTranslation();
      this.host.beginNodeTranslation();
    }
    this.host.commitMutation(
      "diagram.shape.move",
      (project) => {
        const shapesMoved = this.applyTranslation(project, delta);
        const nodesMoved = this.host.translateNodes(project, delta);
        return shapesMoved || nodesMoved;
      },
      { captureHistory: phase.first, mode: "continuous" }
    );
    this.host.previewNodeTranslation();
    if (phase.final) {
      this.finishTranslation();
      this.host.finishNodeTranslation();
      this.host.requestRender();
    }
  }

  private resizeShape(shapeId: string, rect: StudioShapeRect): void {
    this.commitShapeEdit("diagram.shape.resize", shapeId, (shape) => {
      shape.position = { x: Math.round(rect.x), y: Math.round(rect.y) };
      shape.size = {
        width: clampStudioShapeWidth(rect.width),
        height: clampStudioShapeHeight(rect.height),
      };
      return true;
    });
  }

  private setLabel(shapeId: string, label: string): void {
    this.commitShapeEdit("diagram.shape.label", shapeId, (shape) => {
      if (shape.label === label) {
        return false;
      }
      shape.label = label;
      return true;
    });
  }

  private setArrowLabel(arrowId: string, label: string): void {
    const changed = this.host.commitMutation("diagram.arrow.label", (project) =>
      setStudioShapeArrowLabel(project, arrowId, label)
    );
    if (changed) {
      this.host.requestRender();
    }
  }

  private connect(fromShapeId: string, toShapeId: string): void {
    const changed = this.host.commitMutation("diagram.arrow.create", (project) =>
      connectStudioShapes(project, fromShapeId, toShapeId)
    );
    if (changed) {
      this.host.requestRender();
    }
  }

  /** Marquee visuals only: classes, never a re-render mid-gesture. */
  private refreshSelectionVisuals(): void {
    const canvasEl = this.host.getCanvasEl();
    if (!canvasEl) {
      return;
    }
    canvasEl.querySelectorAll<HTMLElement>(".ss-studio-shape").forEach((element) => {
      const shapeId = element.dataset.shapeId || "";
      element.classList.toggle("is-selected", this.shapeIds.has(shapeId));
    });
    canvasEl
      .querySelectorAll<HTMLElement>(".ss-studio-shape-arrow, .ss-studio-shape-arrow-label")
      .forEach((element) => {
        const arrowId = element.dataset.arrowId || "";
        element.classList.toggle("is-selected", this.arrowIds.has(arrowId));
      });
  }

  private commitShapeEdit(
    reason: StudioProjectSessionMutationReason,
    shapeId: string,
    edit: (shape: NonNullable<ReturnType<typeof findStudioShape>>) => boolean
  ): void {
    const changed = this.host.commitMutation(reason, (project) => {
      const shape = findStudioShape(project, shapeId);
      return shape ? edit(shape) : false;
    });
    if (changed) {
      this.host.requestRender();
    }
  }
}

export { EMPTY_STUDIO_SHAPE_SELECTION };
