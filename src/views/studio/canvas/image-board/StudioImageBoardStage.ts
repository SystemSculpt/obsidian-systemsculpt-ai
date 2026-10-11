import {
  findStudioImageBoardLayer,
  STUDIO_IMAGE_BOARD_DEFAULT_STROKE_WIDTH,
  studioImageBoardKeepLensInside,
  studioImageBoardLayerIsVisible,
  studioImageBoardLensForArea,
  studioImageBoardLensOver,
  studioImageBoardOutputFrame,
  type StudioImageBoardLayer,
  type StudioImageBoardLayerKind,
  type StudioImageBoardMagnifyLayer,
} from "../../../../studio/StudioImageBoard";
import {
  boxBetweenPoints,
  boxBounds,
  boxSizePx,
  frameFromPoints,
  hitTestBox,
  normalizeRotation,
  padFrame,
  pointInBoxLocal,
  resizeBox,
  rotationToward,
  snapFrameMove,
  snapFrameResize,
  snapPointToLines,
  STUDIO_IMAGE_BOARD_UNIT_FRAME,
  unionFrames,
  type StudioImageBoardBox,
  type StudioImageBoardFrame,
  type StudioImageBoardHandle,
  type StudioImageBoardPoint,
  type StudioImageBoardSize,
  type StudioImageBoardSnapLines,
} from "../../../../studio/StudioImageBoardGeometry";
import {
  paintStudioImageBoard,
  STUDIO_IMAGE_BOARD_RENDER_UNAVAILABLE,
  StudioImageBoardScratch,
  type StudioImageBoardScene,
} from "../../../../studio/StudioImageBoardRenderer";
import {
  cancelStudioAnimationFrame,
  getStudioOwnerWindow,
  requestStudioAnimationFrame,
} from "../../StudioDomContext";
import { latestStudioPointerEvent, startStudioPointerGesture } from "../../StudioPointerGesture";
import { fitStudioFillText, STUDIO_FILL_TEXT_CLASS, STUDIO_FILL_TEXT_PLACEHOLDER } from "../StudioFillTextSurface";
import { markStudioNodeCardInteractive } from "../StudioGraphNodeCardPointer";
import type { StudioGraphNodeMutationOptions } from "../StudioGraphNodeCardTypes";
import type { StudioImageBoardSession, StudioImageBoardTool } from "./StudioImageBoardSession";

export type StudioImageBoardStageHost = {
  session: StudioImageBoardSession;
  /** Null until the node image has decoded. */
  scene: () => StudioImageBoardScene | null;
  /** Shown in place of the image while there is no scene. */
  status: () => string;
  getGraphZoom: () => number;
  onDropFiles: (files: File[], at: StudioImageBoardPoint) => void;
};

type CreateTool = Exclude<StudioImageBoardTool, "select" | "crop">;

const HANDLES: Record<string, StudioImageBoardHandle> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};
const HANDLE_ATTR = "data-board-handle";
const MAX_BACKING_SIDE = 2600;
const DRAG_THRESHOLD_PX = 4;
const HIT_SLOP_PX = 6;
const MIN_LAYER_PX = 10;
const DOUBLE_PRESS_MS = 420;
const SNAP_PX = 6;
const WORKSPACE_PADDING = 0.14;
/** A click with a drawing tool drops a box of this size, as a share of the output frame. */
const CLICK_SIZE: Record<CreateTool, { width: number; height: number }> = {
  text: { width: 0.9, height: 0.15 },
  rect: { width: 0.26, height: 0.2 },
  ellipse: { width: 0.26, height: 0.2 },
  arrow: { width: 0.22, height: 0 },
  highlight: { width: 0.32, height: 0.07 },
  redact: { width: 0.32, height: 0.1 },
  magnify: { width: 0.16, height: 0.16 },
};
const ARROW_HEAD_PER_STROKE = 4.5;

function layerDescriptionFor(tool: CreateTool): { kind: StudioImageBoardLayerKind } & Record<string, unknown> {
  switch (tool) {
    case "text":
      return { kind: "text", text: "" };
    case "rect":
      return { kind: "shape", shape: "rect" };
    case "ellipse":
      return { kind: "shape", shape: "ellipse" };
    case "arrow":
      return { kind: "shape", shape: "arrow" };
    case "highlight":
      return { kind: "highlight" };
    case "redact":
      return { kind: "redact" };
    case "magnify":
      return { kind: "magnify" };
  }
}

/**
 * The editing surface mounted where the image sits on its node card. One
 * canvas shows the board through the shared painter; a thin DOM overlay adds
 * the selection frame, the crop frame, and the in-place text field. It owns
 * every pointer gesture that starts on it.
 */
export class StudioImageBoardStage {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly lensAreaEl: HTMLElement;
  private readonly cropEl: HTMLElement;
  private readonly draftEl: HTMLElement;
  private readonly guideXEl: HTMLElement;
  private readonly guideYEl: HTMLElement;
  private readonly scratch = new StudioImageBoardScratch();
  private textInput: HTMLTextAreaElement | null = null;
  private editingTextId: string | null = null;
  private textHistoryCaptured = false;
  private cropWorkspace: StudioImageBoardFrame | null = null;
  private cancelGesture: (() => void) | null = null;
  private frame: number | null = null;
  private paintedCssWidth = 0;
  private lastPress: { id: string | null; time: number } | null = null;
  private disposed = false;

  constructor(parent: HTMLElement, private readonly host: StudioImageBoardStageHost) {
    this.element = parent.createDiv({ cls: "ss-studio-image-board" });
    markStudioNodeCardInteractive(this.element);
    this.canvas = this.element.createEl("canvas", { cls: "ss-studio-image-board__canvas" });
    this.overlay = this.element.createDiv({ cls: "ss-studio-image-board__overlay" });
    this.statusEl = this.element.createDiv({ cls: "ss-studio-image-board__status" });
    this.draftEl = this.overlay.createDiv({ cls: "ss-studio-image-board__draft" });
    this.lensAreaEl = this.createFrame("ss-studio-image-board__lens-area", false);
    this.selectionEl = this.createFrame("ss-studio-image-board__selection", true);
    this.cropEl = this.createFrame("ss-studio-image-board__crop", false);
    this.guideXEl = this.overlay.createDiv({ cls: "ss-studio-image-board__guide is-vertical" });
    this.guideYEl = this.overlay.createDiv({ cls: "ss-studio-image-board__guide is-horizontal" });

    this.element.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.element.addEventListener("pointerenter", () => this.refreshResolution());
    this.element.addEventListener("wheel", () => this.refreshResolution(), { passive: true });
    this.element.addEventListener("dragover", (event) => this.handleDragOver(event));
    this.element.addEventListener("drop", (event) => this.handleDrop(event));
    // Clicks are spent on the stage; they never reach the card or the canvas.
    this.element.addEventListener("click", (event) => event.stopPropagation());
    this.element.addEventListener("dblclick", (event) => event.stopPropagation());
  }

  get isEditingText(): boolean {
    return this.editingTextId !== null;
  }

  /** Normalized region the stage currently shows. */
  get view(): StudioImageBoardFrame {
    const board = this.host.session.board;
    if (this.host.session.tool !== "crop") {
      this.cropWorkspace = null;
      return studioImageBoardOutputFrame(board);
    }
    this.cropWorkspace ??= this.computeWorkspace();
    return this.cropWorkspace;
  }

  /** Brings the overlay in line with the session and repaints on the next frame. */
  render(): void {
    if (this.disposed) {
      return;
    }
    const scene = this.host.scene();
    this.statusEl.setText(scene ? "" : this.host.status());
    this.element.toggleClass("is-unavailable", !scene);
    this.element.dataset.tool = this.host.session.tool;
    if (scene) {
      this.syncOverlay(scene);
    }
    this.schedulePaint();
  }

  beginTextEdit(layerId: string): void {
    const layer = findStudioImageBoardLayer(this.host.session.board, layerId);
    if (!layer || layer.kind !== "text" || this.disposed) {
      return;
    }
    if (this.editingTextId && this.editingTextId !== layerId) {
      this.endTextEdit();
    }
    this.host.session.select(layerId);
    this.editingTextId = layerId;
    this.textHistoryCaptured = false;
    if (!this.textInput) {
      this.textInput = this.createTextInput();
    }
    this.textInput.value = layer.text;
    this.render();
    this.textInput.focus({ preventScroll: true });
    this.textInput.select();
  }

  endTextEdit(): void {
    const id = this.editingTextId;
    if (!id) {
      return;
    }
    this.editingTextId = null;
    this.textInput?.remove();
    this.textInput = null;
    const layer = findStudioImageBoardLayer(this.host.session.board, id);
    if (layer?.kind === "text" && !layer.text.trim()) {
      // Nothing was typed: an empty caption is not a layer.
      this.host.session.removeLayer(id);
      return;
    }
    this.render();
  }

  /** Moves the selected layer by a share of the visible frame; used by arrow keys. */
  nudgeSelection(dx: number, dy: number): boolean {
    const layer = this.host.session.selectedLayer;
    if (!layer) {
      return false;
    }
    const view = this.view;
    this.host.session.patchLayer(layer.id, {
      x: layer.x + dx * view.width,
      y: layer.y + dy * view.height,
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelGesture?.();
    this.cancelGesture = null;
    if (this.frame !== null) {
      cancelStudioAnimationFrame(this.element, this.frame);
      this.frame = null;
    }
    this.scratch.dispose();
    this.element.remove();
  }

  // ── Geometry ────────────────────────────────────────────────────────────

  private get baseSize(): StudioImageBoardSize {
    return this.host.scene()?.baseSize ?? { width: 1, height: 1 };
  }

  private computeWorkspace(): StudioImageBoardFrame {
    const board = this.host.session.board;
    const base = this.baseSize;
    return padFrame(
      unionFrames([
        STUDIO_IMAGE_BOARD_UNIT_FRAME,
        studioImageBoardOutputFrame(board),
        ...board.layers.map((layer) => boxBounds(layer, base)),
      ]),
      WORKSPACE_PADDING
    );
  }

  private pointAt(event: { clientX: number; clientY: number }): StudioImageBoardPoint {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.view;
    const u = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const v = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
    return { x: view.x + u * view.width, y: view.y + v * view.height };
  }

  /** Screen pixels per base-image pixel, including the graph zoom. */
  private screenScale(): number {
    const rect = this.canvas.getBoundingClientRect();
    const width = this.view.width * this.baseSize.width;
    return rect.width > 0 && width > 0 ? rect.width / width : 1;
  }

  private hitLayer(point: StudioImageBoardPoint): StudioImageBoardLayer | null {
    const base = this.baseSize;
    const slop = HIT_SLOP_PX / this.screenScale();
    const selectedId = this.host.session.selectedId;
    const layers = this.host.session.board.layers;
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (!studioImageBoardLayerIsVisible(layer)) {
        continue;
      }
      if (layer.kind === "magnify" && this.hitLensArea(layer, point, slop, layer.id === selectedId)) {
        return layer;
      }
      if (!hitTestBox(layer, base, point, slop)) {
        continue;
      }
      // An outline is grabbed by its line, so what it surrounds stays reachable.
      if (
        layer.kind === "shape" &&
        layer.shape !== "arrow" &&
        layer.id !== selectedId &&
        !this.hitOutline(layer, point, slop)
      ) {
        continue;
      }
      return layer;
    }
    return null;
  }

  /**
   * Whether `point` is on the area a lens enlarges rather than on the lens.
   * The area is grabbed by its outline, so the picture inside it stays
   * reachable; once its lens is selected, all of it is a handle.
   */
  private hitLensArea(
    layer: StudioImageBoardMagnifyLayer,
    point: StudioImageBoardPoint,
    slop: number,
    whole: boolean
  ): boolean {
    const base = this.baseSize;
    const area = { ...layer.source, rotation: 0 };
    if (hitTestBox(layer, base, point, slop) || !hitTestBox(area, base, point, slop)) {
      return false;
    }
    if (whole) {
      return true;
    }
    const size = boxSizePx(area, base);
    const local = pointInBoxLocal(area, base, point);
    const band = slop * 2;
    return Math.abs(local.x) >= size.width / 2 - band || Math.abs(local.y) >= size.height / 2 - band;
  }

  private hitOutline(
    layer: Extract<StudioImageBoardLayer, { kind: "shape" }>,
    point: StudioImageBoardPoint,
    slop: number
  ): boolean {
    const base = this.baseSize;
    const size = boxSizePx(layer, base);
    const local = pointInBoxLocal(layer, base, point);
    const band = layer.strokeWidth * Math.min(base.width, base.height) + slop * 2;
    if (layer.shape === "ellipse") {
      const inner = {
        x: Math.max(1, size.width / 2 - band),
        y: Math.max(1, size.height / 2 - band),
      };
      return (local.x / inner.x) ** 2 + (local.y / inner.y) ** 2 >= 1;
    }
    return (
      Math.abs(local.x) >= size.width / 2 - band || Math.abs(local.y) >= size.height / 2 - band
    );
  }

  // ── Pointer gestures ────────────────────────────────────────────────────

  private handlePointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (target === this.textInput) {
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    if ((event.pointerType === "mouse" && event.button !== 0) || !this.host.scene()) {
      return;
    }
    event.preventDefault();
    if (this.editingTextId) {
      this.endTextEdit();
    }
    const session = this.host.session;
    const handleName = target?.closest<HTMLElement>(`[${HANDLE_ATTR}]`)?.getAttribute(HANDLE_ATTR) ?? null;
    const point = this.pointAt(event);
    const tool = session.tool;
    if (tool === "crop") {
      this.startCropGesture(event, handleName, point);
      return;
    }
    if (tool !== "select") {
      this.startCreateGesture(event, tool, point);
      return;
    }
    const selected = session.selectedLayer;
    if (handleName && selected) {
      const handle = HANDLES[handleName];
      if (handle && selected.kind === "magnify" && target && this.lensAreaEl.contains(target)) {
        this.startLensAreaResizeGesture(event, selected, handle);
      } else if (handleName === "rotate") {
        this.startRotateGesture(event, selected, point);
      } else if (handle) {
        this.startResizeGesture(event, selected, handle);
      }
      return;
    }

    const hit = this.hitLayer(point);
    const now = Date.now();
    const doublePress =
      this.lastPress !== null &&
      this.lastPress.id === (hit?.id ?? null) &&
      now - this.lastPress.time < DOUBLE_PRESS_MS;
    this.lastPress = { id: hit?.id ?? null, time: now };
    if (doublePress) {
      this.lastPress = null;
      if (hit?.kind === "text") {
        this.beginTextEdit(hit.id);
        return;
      }
      if (!hit || hit.kind === "base") {
        // Double-click on open image: type right there.
        this.createLayer("text", this.clickBox("text", point));
        return;
      }
    }
    if (!hit) {
      session.select(null);
      return;
    }
    if (hit.kind === "base" && session.selectedId !== hit.id) {
      // The background takes two clicks: the first only clears the selection,
      // so reaching past a layer never drags the whole image by accident.
      session.select(session.selectedId ? null : hit.id);
      return;
    }
    const onLensArea = hit.kind === "magnify" && this.hitLensArea(hit, point, HIT_SLOP_PX / this.screenScale(), true);
    session.select(hit.id);
    if (hit.kind === "magnify" && onLensArea) {
      this.startLensAreaGesture(event, hit, point);
      return;
    }
    this.startMoveGesture(event, hit, point);
  }

  private startGesture(
    event: PointerEvent,
    handlers: {
      onPoint: (point: StudioImageBoardPoint, shiftKey: boolean) => void;
      /** `completed` is false when the gesture was abandoned rather than released. */
      onEnd?: (completed: boolean) => void;
    }
  ): void {
    this.cancelGesture?.();
    let latest = this.pointAt(event);
    let shiftKey = event.shiftKey;
    let moved = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const finish = (completed: boolean): void => {
      this.cancelGesture = null;
      this.element.removeClass("is-gesturing");
      handlers.onEnd?.(completed);
    };
    this.element.addClass("is-gesturing");
    this.cancelGesture = startStudioPointerGesture({
      element: this.element,
      event,
      onMove: (next) => {
        const sample = latestStudioPointerEvent(next);
        if (
          !moved &&
          Math.hypot(sample.clientX - startX, sample.clientY - startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        moved = true;
        latest = this.pointAt(sample);
        shiftKey = sample.shiftKey;
      },
      onFrame: () => {
        if (moved) handlers.onPoint(latest, shiftKey);
      },
      onKeyChange: (key) => {
        if (key.shiftKey === shiftKey) return false;
        shiftKey = key.shiftKey;
        return moved;
      },
      onFinish: () => finish(true),
      onCancel: () => finish(false),
    });
  }

  /**
   * Edges a blur box lines up with: the other upright blur boxes, so they
   * can sit flush and merge into one pane, and the edges of the picture.
   * Null for anything that is not an upright blur box.
   */
  private redactSnapLines(
    box: { kind: StudioImageBoardLayerKind; rotation: number; id?: string } | null
  ): StudioImageBoardSnapLines | null {
    if (!box || box.kind !== "redact" || normalizeRotation(box.rotation) !== 0) {
      return null;
    }
    const board = this.host.session.board;
    const frame = studioImageBoardOutputFrame(board);
    const x = [0, 1, frame.x, frame.x + frame.width];
    const y = [0, 1, frame.y, frame.y + frame.height];
    for (const layer of board.layers) {
      if (layer.kind === "redact" && layer.id !== box.id && normalizeRotation(layer.rotation) === 0) {
        x.push(layer.x, layer.x + layer.width);
        y.push(layer.y, layer.y + layer.height);
      }
    }
    return { x, y };
  }

  /** How close, in normalized units, an edge must come to a line to land on it. */
  private snapReach(): StudioImageBoardPoint {
    const base = this.baseSize;
    const reach = SNAP_PX / this.screenScale();
    return { x: reach / base.width, y: reach / base.height };
  }

  /** Shows the lines a box has landed on; null hides that guide. */
  private showGuides(guideX: number | null, guideY: number | null): void {
    const view = this.view;
    this.guideXEl.toggleClass("is-visible", guideX !== null);
    this.guideYEl.toggleClass("is-visible", guideY !== null);
    if (guideX !== null) {
      this.guideXEl.setCssStyles({ left: `${((guideX - view.x) / view.width) * 100}%` });
    }
    if (guideY !== null) {
      this.guideYEl.setCssStyles({ top: `${((guideY - view.y) / view.height) * 100}%` });
    }
  }

  /** Each gesture is one history entry: only its first commit captures. */
  private gestureCommit(): () => StudioGraphNodeMutationOptions {
    let captured = false;
    return () => {
      const options: StudioGraphNodeMutationOptions = { mode: "continuous", captureHistory: !captured };
      captured = true;
      return options;
    };
  }

  private startMoveGesture(
    event: PointerEvent,
    layer: StudioImageBoardLayer,
    start: StudioImageBoardPoint
  ): void {
    const next = this.gestureCommit();
    const frame = studioImageBoardOutputFrame(this.host.session.board);
    const base = this.baseSize;
    const snap = SNAP_PX / this.screenScale();
    const lines = this.redactSnapLines(layer);
    const reach = this.snapReach();
    this.startGesture(event, {
      onPoint: (point, shiftKey) => {
        let dx = point.x - start.x;
        let dy = point.y - start.y;
        if (shiftKey) {
          // Constrain to the dominant axis.
          if (Math.abs(dx * base.width) >= Math.abs(dy * base.height)) dy = 0;
          else dx = 0;
        }
        let x = layer.x + dx;
        let y = layer.y + dy;
        let guideX: number | null = null;
        let guideY: number | null = null;
        if (lines) {
          // A held axis stays where it is; only the free one looks for an edge.
          const snapped = snapFrameMove({ x, y, width: layer.width, height: layer.height }, lines, {
            x: shiftKey && dx === 0 ? -1 : reach.x,
            y: shiftKey && dy === 0 ? -1 : reach.y,
          });
          ({ x, y } = snapped.value);
          ({ guideX, guideY } = snapped);
        }
        // Centres are magnetic: lining a caption up with the image is the common case.
        const centerX = x + layer.width / 2 - (frame.x + frame.width / 2);
        const centerY = y + layer.height / 2 - (frame.y + frame.height / 2);
        if (guideX === null && Math.abs(centerX * base.width) < snap) x -= centerX;
        if (guideY === null && Math.abs(centerY * base.height) < snap) y -= centerY;
        this.showGuides(guideX, guideY);
        this.host.session.patchLayer(layer.id, { x, y }, next());
      },
      onEnd: () => this.showGuides(null, null),
    });
  }

  private startResizeGesture(
    event: PointerEvent,
    layer: StudioImageBoardLayer,
    handle: StudioImageBoardHandle
  ): void {
    const next = this.gestureCommit();
    const initial: StudioImageBoardBox = { ...layer };
    // Pictures and lenses keep their proportions unless Shift says otherwise; everything else is free.
    const lockedByDefault = layer.kind === "image" || layer.kind === "base" || layer.kind === "magnify";
    const minPx = MIN_LAYER_PX / this.screenScale();
    const lines = this.redactSnapLines(layer);
    const reach = this.snapReach();
    this.startGesture(event, {
      onPoint: (point, shiftKey) => {
        const keepAspect = lockedByDefault !== shiftKey;
        const box = resizeBox(initial, this.baseSize, handle, point, { keepAspect, minPx });
        if (!lines || keepAspect) {
          this.host.session.patchLayer(layer.id, box, next());
          return;
        }
        const base = this.baseSize;
        const snapped = snapFrameResize(box, handle, lines, reach, {
          width: minPx / base.width,
          height: minPx / base.height,
        });
        this.showGuides(snapped.guideX, snapped.guideY);
        this.host.session.patchLayer(layer.id, { ...snapped.value, rotation: box.rotation }, next());
      },
      onEnd: () => this.showGuides(null, null),
    });
  }

  /** Drags the area a lens enlarges; the lens stays where it is and shows the new spot. */
  private startLensAreaGesture(
    event: PointerEvent,
    layer: StudioImageBoardMagnifyLayer,
    start: StudioImageBoardPoint
  ): void {
    const next = this.gestureCommit();
    this.startGesture(event, {
      onPoint: (point) => {
        this.host.session.patchLayer(
          layer.id,
          {
            source: {
              ...layer.source,
              x: layer.source.x + point.x - start.x,
              y: layer.source.y + point.y - start.y,
            },
          },
          next()
        );
      },
    });
  }

  /**
   * Adjusts the area a lens enlarges from a corner or an edge of the area.
   * The lens keeps its zoom, so it grows or shrinks to match, away from the
   * area, and is kept on the picture if growing would push it off.
   */
  private startLensAreaResizeGesture(
    event: PointerEvent,
    layer: StudioImageBoardMagnifyLayer,
    handle: StudioImageBoardHandle
  ): void {
    const next = this.gestureCommit();
    const initial: StudioImageBoardBox = { ...layer.source, rotation: 0 };
    const minPx = MIN_LAYER_PX / this.screenScale();
    const output = studioImageBoardOutputFrame(this.host.session.board);
    this.startGesture(event, {
      onPoint: (point, shiftKey) => {
        const { x, y, width, height } = resizeBox(initial, this.baseSize, handle, point, {
          keepAspect: shiftKey,
          minPx,
        });
        const source = { x, y, width, height };
        const lens = studioImageBoardKeepLensInside(
          layer,
          { ...studioImageBoardLensForArea(layer, source), rotation: layer.rotation },
          output,
          this.baseSize
        );
        this.host.session.patchLayer(layer.id, { ...lens, source }, next());
      },
    });
  }

  private startRotateGesture(
    event: PointerEvent,
    layer: StudioImageBoardLayer,
    start: StudioImageBoardPoint
  ): void {
    const next = this.gestureCommit();
    const base = this.baseSize;
    const startAngle = rotationToward(layer, base, start);
    this.startGesture(event, {
      onPoint: (point, shiftKey) => {
        let rotation = normalizeRotation(layer.rotation + rotationToward(layer, base, point) - startAngle);
        if (shiftKey) {
          rotation = Math.round(rotation / 15) * 15;
        } else {
          const quarter = Math.round(rotation / 90) * 90;
          if (Math.abs(rotation - quarter) < 3) rotation = quarter;
        }
        this.host.session.patchLayer(layer.id, { rotation: normalizeRotation(rotation) }, next());
      },
    });
  }

  private startCreateGesture(
    event: PointerEvent,
    tool: CreateTool,
    start: StudioImageBoardPoint
  ): void {
    let box: StudioImageBoardBox | null = null;
    // A blur box is drawn from edge to edge: both corners look for a line.
    const lines = this.redactSnapLines({ kind: layerDescriptionFor(tool).kind, rotation: 0 });
    const reach = this.snapReach();
    const origin = lines ? snapPointToLines(start, lines, reach).value : start;
    this.startGesture(event, {
      onPoint: (point) => {
        const corner = lines ? snapPointToLines(point, lines, reach) : null;
        box = this.dragBox(tool, origin, corner ? corner.value : point);
        this.placeBox(this.draftEl, box);
        this.draftEl.dataset.tool = tool;
        this.draftEl.addClass("is-visible");
        if (corner) {
          this.showGuides(corner.guideX, corner.guideY);
        }
      },
      onEnd: (completed) => {
        this.showGuides(null, null);
        this.draftEl.removeClass("is-visible");
        if (completed) {
          this.createLayer(tool, box ?? this.clickBox(tool, start));
        }
      },
    });
  }

  private arrowThicknessPx(): number {
    const base = this.baseSize;
    return STUDIO_IMAGE_BOARD_DEFAULT_STROKE_WIDTH * Math.min(base.width, base.height) * ARROW_HEAD_PER_STROKE;
  }

  private dragBox(
    tool: CreateTool,
    start: StudioImageBoardPoint,
    end: StudioImageBoardPoint
  ): StudioImageBoardBox {
    if (tool === "arrow") {
      return boxBetweenPoints(start, end, this.baseSize, this.arrowThicknessPx());
    }
    return { ...frameFromPoints(start, end), rotation: 0 };
  }

  private clickBox(tool: CreateTool, point: StudioImageBoardPoint): StudioImageBoardBox {
    const frame = studioImageBoardOutputFrame(this.host.session.board);
    const size = CLICK_SIZE[tool];
    const width = size.width * frame.width;
    const height = tool === "arrow"
      ? this.arrowThicknessPx() / this.baseSize.height
      : size.height * frame.height;
    // A caption spans the image at the clicked height; everything else lands on the click.
    const x = tool === "text" ? frame.x + (frame.width - width) / 2 : point.x - width / 2;
    return { x, y: point.y - height / 2, width, height, rotation: 0 };
  }

  /** The lens for a marked area: the area stays put and its enlarged copy lands beside it. */
  private lensOver(area: StudioImageBoardFrame): StudioImageBoardBox & { source: StudioImageBoardFrame } {
    return {
      ...studioImageBoardLensOver(area, studioImageBoardOutputFrame(this.host.session.board), this.baseSize),
      rotation: 0,
      source: { x: area.x, y: area.y, width: area.width, height: area.height },
    };
  }

  private createLayer(tool: CreateTool, box: StudioImageBoardBox): void {
    const layer = this.host.session.addLayer({
      ...layerDescriptionFor(tool),
      // What is drawn with the magnifier is what to enlarge, not where the lens goes.
      ...(tool === "magnify" ? this.lensOver(box) : box),
    });
    if (layer.kind === "text") {
      this.beginTextEdit(layer.id);
    }
  }

  private startCropGesture(
    event: PointerEvent,
    handleName: string | null,
    start: StudioImageBoardPoint
  ): void {
    const next = this.gestureCommit();
    const session = this.host.session;
    const initial = studioImageBoardOutputFrame(session.board);
    const handle = handleName ? HANDLES[handleName] : null;
    const inside =
      start.x >= initial.x &&
      start.x <= initial.x + initial.width &&
      start.y >= initial.y &&
      start.y <= initial.y + initial.height;
    const minPx = MIN_LAYER_PX / this.screenScale();
    this.startGesture(event, {
      onPoint: (point) => {
        let frame: StudioImageBoardFrame;
        if (handle) {
          frame = resizeBox({ ...initial, rotation: 0 }, this.baseSize, handle, point, { minPx });
        } else if (inside) {
          frame = { ...initial, x: initial.x + point.x - start.x, y: initial.y + point.y - start.y };
        } else {
          frame = frameFromPoints(start, point);
        }
        session.setCrop(this.snapCrop(frame, Boolean(handle) || !inside), next());
      },
      onEnd: () => {
        // Keep room around the frame so it can always be dragged further out.
        const crop = studioImageBoardOutputFrame(session.board);
        const workspace = this.cropWorkspace;
        if (
          workspace &&
          (crop.x < workspace.x ||
            crop.y < workspace.y ||
            crop.x + crop.width > workspace.x + workspace.width ||
            crop.y + crop.height > workspace.y + workspace.height)
        ) {
          this.cropWorkspace = null;
        }
        this.render();
      },
    });
  }

  /** Edges stick to the image's own edges; an exact fit is no crop at all. */
  private snapCrop(frame: StudioImageBoardFrame, snapEdges: boolean): StudioImageBoardFrame | null {
    const base = this.baseSize;
    const snapX = SNAP_PX / this.screenScale() / base.width;
    const snapY = SNAP_PX / this.screenScale() / base.height;
    let left = frame.x;
    let top = frame.y;
    let right = frame.x + frame.width;
    let bottom = frame.y + frame.height;
    if (snapEdges) {
      if (Math.abs(left) < snapX) left = 0;
      if (Math.abs(top) < snapY) top = 0;
      if (Math.abs(right - 1) < snapX) right = 1;
      if (Math.abs(bottom - 1) < snapY) bottom = 1;
    }
    if (left === 0 && top === 0 && right === 1 && bottom === 1) {
      return null;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // ── Drag and drop ───────────────────────────────────────────────────────

  private handleDragOver(event: DragEvent): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  }

  private handleDrop(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith("image/")
    );
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.host.onDropFiles(files, this.pointAt(event));
  }

  // ── Overlay ─────────────────────────────────────────────────────────────

  private createFrame(cls: string, rotatable: boolean): HTMLElement {
    const frame = this.overlay.createDiv({ cls });
    for (const name of Object.keys(HANDLES)) {
      frame.createDiv({
        cls: `ss-studio-image-board__handle is-${name}`,
        attr: { [HANDLE_ATTR]: name },
      });
    }
    if (rotatable) {
      frame.createDiv({ cls: "ss-studio-image-board__rotate", attr: { [HANDLE_ATTR]: "rotate" } });
    }
    return frame;
  }

  private createTextInput(): HTMLTextAreaElement {
    const input = this.overlay.createEl("textarea", {
      cls: `${STUDIO_FILL_TEXT_CLASS} ss-studio-image-board__text-input`,
      attr: {
        "data-testid": "studio.image.text-input",
        "aria-label": "Layer text",
        placeholder: STUDIO_FILL_TEXT_PLACEHOLDER,
        spellcheck: "false",
        rows: "1",
      },
    });
    input.addEventListener("input", () => {
      const id = this.editingTextId;
      if (!id) {
        return;
      }
      this.host.session.patchLayer(id, { text: input.value }, {
        mode: "continuous",
        captureHistory: !this.textHistoryCaptured,
      });
      this.textHistoryCaptured = true;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        event.stopPropagation();
        this.endTextEdit();
      }
    });
    input.addEventListener("blur", () => {
      // Deferred: a toolbar press keeps focus here, and removal mid-blur re-enters.
      const id = this.editingTextId;
      getStudioOwnerWindow(this.element).setTimeout(() => {
        if (this.editingTextId === id && this.textInput && this.textInput.ownerDocument.activeElement !== this.textInput) {
          this.endTextEdit();
        }
      }, 0);
    });
    return input;
  }

  private placeBox(element: HTMLElement, box: StudioImageBoardBox): void {
    const view = this.view;
    element.setCssStyles({
      left: `${(((box.x + box.width / 2) - view.x) / view.width) * 100}%`,
      top: `${(((box.y + box.height / 2) - view.y) / view.height) * 100}%`,
      width: `${(box.width / view.width) * 100}%`,
      height: `${(box.height / view.height) * 100}%`,
      transform: `translate(-50%, -50%) rotate(${box.rotation}deg)`,
    });
  }

  private syncOverlay(scene: StudioImageBoardScene): void {
    const session = this.host.session;
    const view = this.view;
    const pixelWidth = Math.max(1, view.width * scene.baseSize.width);
    const pixelHeight = Math.max(1, view.height * scene.baseSize.height);
    this.element.setCssStyles({ aspectRatio: `${pixelWidth} / ${pixelHeight}` });
    // Handles keep their on-screen size however far the graph is zoomed.
    this.element.setCssProps({
      "--ss-studio-board-ui-scale": String(1 / Math.max(0.05, this.host.getGraphZoom())),
    });

    const selected = session.tool === "select" ? session.selectedLayer : null;
    this.selectionEl.toggleClass("is-visible", Boolean(selected));
    if (selected) {
      this.placeBox(this.selectionEl, selected);
      this.selectionEl.dataset.kind = selected.kind;
      this.selectionEl.toggleClass("is-typing", this.editingTextId === selected.id);
    }
    const lens = selected?.kind === "magnify" ? selected : null;
    this.lensAreaEl.toggleClass("is-visible", Boolean(lens));
    if (lens) {
      this.placeBox(this.lensAreaEl, { ...lens.source, rotation: 0 });
      this.lensAreaEl.dataset.shape = lens.shape;
    }
    const cropping = session.tool === "crop";
    this.cropEl.toggleClass("is-visible", cropping);
    if (cropping) {
      this.placeBox(this.cropEl, { ...studioImageBoardOutputFrame(session.board), rotation: 0 });
    }
    this.syncTextInput(scene);
  }

  private syncTextInput(scene: StudioImageBoardScene): void {
    const input = this.textInput;
    const layer = findStudioImageBoardLayer(this.host.session.board, this.editingTextId);
    if (!input || !layer || layer.kind !== "text") {
      return;
    }
    const size = boxSizePx(layer, scene.baseSize);
    const context = this.canvas.getContext("2d");
    // CSS pixels per base pixel inside the (possibly zoomed) card.
    const cssScale = this.element.clientWidth > 0
      ? this.element.clientWidth / Math.max(1, this.view.width * scene.baseSize.width)
      : 1;
    this.placeBox(input, layer);
    fitStudioFillText(
      input,
      layer,
      size,
      (font, text) => {
        if (!context) return text.length * 50;
        context.font = font;
        return context.measureText(text).width;
      },
      cssScale
    );
  }

  // ── Painting ────────────────────────────────────────────────────────────

  private schedulePaint(): void {
    if (this.frame !== null || this.disposed) {
      return;
    }
    this.frame = requestStudioAnimationFrame(this.element, () => {
      this.frame = null;
      this.paint();
    });
  }

  /** Zooming the graph changes how many screen pixels the stage covers. */
  private refreshResolution(): void {
    const width = this.canvas.getBoundingClientRect().width;
    if (width > 0 && Math.abs(width - this.paintedCssWidth) / Math.max(1, this.paintedCssWidth) > 0.12) {
      this.render();
    }
  }

  private paint(): void {
    const scene = this.host.scene();
    if (this.disposed || !scene) {
      return;
    }
    const context = this.canvas.getContext("2d");
    if (!context) {
      this.statusEl.setText(STUDIO_IMAGE_BOARD_RENDER_UNAVAILABLE);
      this.element.addClass("is-unavailable");
      return;
    }
    const view = this.view;
    const aspect = Math.max(1e-3, (view.width * scene.baseSize.width) / (view.height * scene.baseSize.height));
    const rect = this.canvas.getBoundingClientRect();
    const density = getStudioOwnerWindow(this.element).devicePixelRatio || 1;
    const cssWidth = rect.width || this.element.clientWidth || 480;
    let width = Math.max(96, Math.min(MAX_BACKING_SIDE, Math.round(cssWidth * density)));
    let height = Math.round(width / aspect);
    if (height > MAX_BACKING_SIDE) {
      height = MAX_BACKING_SIDE;
      width = Math.max(1, Math.round(height * aspect));
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== Math.max(1, height)) this.canvas.height = Math.max(1, height);
    this.paintedCssWidth = rect.width;
    try {
      paintStudioImageBoard(context, scene, {
        view,
        skipLayerId: this.editingTextId,
        dimOutside: this.host.session.tool === "crop"
          ? studioImageBoardOutputFrame(this.host.session.board)
          : null,
        scratch: this.scratch,
      });
    } catch (error) {
      this.statusEl.setText(error instanceof Error ? error.message : String(error));
      this.element.addClass("is-unavailable");
    }
  }
}
