import type {
  StudioCaptionBoardAnnotation,
  StudioCaptionBoardCrop,
  StudioCaptionBoardLabel,
  StudioCaptionBoardState,
} from "../../../../studio/StudioCaptionBoardState";
import type { StudioGraphNodeMutationOptions } from "../StudioGraphNodeCardTypes";
import {
  ANNOTATION_MIN_HEIGHT,
  ANNOTATION_MIN_WIDTH,
  annotationLabel,
  clamp,
  CROP_MIN_HEIGHT,
  CROP_MIN_WIDTH,
  LABEL_MIN_HEIGHT,
  LABEL_MIN_WIDTH,
  selectionEquals,
  sortBoardAnnotations,
  sortBoardLabels,
  type StudioImageEditorFrame,
  type StudioImageEditorSelection,
  type StudioImageEditorSurfaceLayout,
} from "./StudioImageEditorTypes";

type DragInteraction = {
  mode: "move" | "resize";
  pointerId: number;
  selection: StudioImageEditorSelection;
  startClientX: number;
  startClientY: number;
  initialFrame: StudioImageEditorFrame;
  capturedHistory: boolean;
};

type StudioImageEditorCanvasActions = {
  onSelect: (selection: StudioImageEditorSelection | null) => void;
  onPatchFrame: (
    selection: StudioImageEditorSelection,
    patch: Partial<StudioCaptionBoardCrop>,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onDeleteSelected: () => void;
  resolveSelectionFrame: (
    selection: StudioImageEditorSelection
  ) => StudioImageEditorFrame | null;
};

type StudioImageEditorCanvasSource = {
  path: string;
  src: string;
  width: number;
  height: number;
};

const ZOOM_MIN = 0.18;
const ZOOM_MAX = 4;
const SURFACE_PADDING = 140;

export class StudioImageEditorCanvas {
  private state: StudioCaptionBoardState | null = null;
  private selection: StudioImageEditorSelection | null = null;
  private source: StudioImageEditorCanvasSource = { path: "", src: "", width: 0, height: 0 };
  private renderedPreviewSrc = "";
  private zoom = 1;
  private stageEl: HTMLElement | null = null;
  private interaction: DragInteraction | null = null;
  private readonly detachListeners: Array<() => void> = [];

  constructor(
    private readonly viewportEl: HTMLElement,
    private readonly surfaceEl: HTMLElement,
    ownerWindow: Window,
    private readonly imageAlt: string,
    private readonly actions: StudioImageEditorCanvasActions
  ) {
    const onWheel = (event: WheelEvent): void => this.handleWheel(event);
    const onPointerMove = (event: PointerEvent): void => this.handlePointerMove(event);
    const onPointerUp = (event: PointerEvent): void => this.handlePointerUp(event);
    const onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event);
    const onResize = (): void => this.renderCurrent();

    viewportEl.addEventListener("wheel", onWheel, { passive: false });
    ownerWindow.addEventListener("pointermove", onPointerMove);
    ownerWindow.addEventListener("pointerup", onPointerUp);
    ownerWindow.addEventListener("pointercancel", onPointerUp);
    ownerWindow.addEventListener("keydown", onKeyDown);
    ownerWindow.addEventListener("resize", onResize);
    this.detachListeners.push(
      () => viewportEl.removeEventListener("wheel", onWheel),
      () => ownerWindow.removeEventListener("pointermove", onPointerMove),
      () => ownerWindow.removeEventListener("pointerup", onPointerUp),
      () => ownerWindow.removeEventListener("pointercancel", onPointerUp),
      () => ownerWindow.removeEventListener("keydown", onKeyDown),
      () => ownerWindow.removeEventListener("resize", onResize)
    );
  }

  destroy(): void {
    this.interaction = null;
    while (this.detachListeners.length > 0) {
      this.detachListeners.pop()?.();
    }
  }

  get hasSource(): boolean {
    return Boolean(this.source.src);
  }

  setSource(source: StudioImageEditorCanvasSource): void {
    this.source = source;
    this.renderedPreviewSrc = "";
  }

  setRenderedPreview(src: string): void {
    this.renderedPreviewSrc = src;
    this.renderCurrent();
  }

  render(
    state: StudioCaptionBoardState,
    selection: StudioImageEditorSelection | null
  ): void {
    this.state = state;
    this.selection = selection;
    this.renderCurrent();
  }

  fitToViewport(): void {
    if (!this.source.width || !this.source.height) {
      return;
    }
    const availableWidth = Math.max(240, this.viewportEl.clientWidth - SURFACE_PADDING);
    const availableHeight = Math.max(200, this.viewportEl.clientHeight - SURFACE_PADDING);
    this.zoom = clamp(
      Math.min(availableWidth / this.source.width, availableHeight / this.source.height, 1.35),
      ZOOM_MIN,
      ZOOM_MAX
    );
    this.renderCurrent();
    const layout = this.getLayout();
    this.viewportEl.scrollLeft = Math.max(
      0,
      layout.stageLeft + layout.stageWidth / 2 - this.viewportEl.clientWidth / 2
    );
    this.viewportEl.scrollTop = Math.max(
      0,
      layout.stageTop + layout.stageHeight / 2 - this.viewportEl.clientHeight / 2
    );
  }

  private getLayout(nextZoom: number = this.zoom): StudioImageEditorSurfaceLayout {
    const stageWidth = Math.max(1, this.source.width * nextZoom);
    const stageHeight = Math.max(1, this.source.height * nextZoom);
    const viewportWidth = this.viewportEl.clientWidth || stageWidth + SURFACE_PADDING * 2;
    const viewportHeight = this.viewportEl.clientHeight || stageHeight + SURFACE_PADDING * 2;
    const surfaceWidth = Math.max(viewportWidth, stageWidth + SURFACE_PADDING * 2);
    const surfaceHeight = Math.max(viewportHeight, stageHeight + SURFACE_PADDING * 2);
    return {
      surfaceWidth,
      surfaceHeight,
      stageLeft: Math.max(SURFACE_PADDING / 2, (surfaceWidth - stageWidth) / 2),
      stageTop: Math.max(SURFACE_PADDING / 2, (surfaceHeight - stageHeight) / 2),
      stageWidth,
      stageHeight,
    };
  }

  private renderCurrent(): void {
    this.surfaceEl.empty();
    this.stageEl = null;
    if (!this.source.src || !this.source.width || !this.source.height || !this.state) {
      this.surfaceEl.createDiv({
        cls: "ss-studio-caption-board__empty",
        text: this.source.path
          ? "Loading source image..."
          : "Run this media node once or use a stored Studio asset so the editor can load the source image.",
      });
      return;
    }

    const layout = this.getLayout();
    this.surfaceEl.style.width = `${layout.surfaceWidth}px`;
    this.surfaceEl.style.height = `${layout.surfaceHeight}px`;
    const stageEl = this.surfaceEl.createDiv({ cls: "ss-studio-caption-board__stage" });
    stageEl.style.left = `${layout.stageLeft}px`;
    stageEl.style.top = `${layout.stageTop}px`;
    stageEl.style.width = `${layout.stageWidth}px`;
    stageEl.style.height = `${layout.stageHeight}px`;
    stageEl.addEventListener("pointerdown", (event) => this.handleStagePointerDown(event));
    this.stageEl = stageEl;

    const imageEl = stageEl.createEl("img", {
      cls: "ss-studio-caption-board__image",
      attr: { src: this.renderedPreviewSrc || this.source.src, alt: this.imageAlt },
    });
    imageEl.draggable = false;
    if (this.state.crop) {
      this.renderCrop(stageEl, this.state.crop, layout);
    }
    sortBoardAnnotations(this.state.annotations).forEach((annotation) => {
      this.renderAnnotation(stageEl, annotation, layout);
    });
    sortBoardLabels(this.state.labels).forEach((label) => {
      this.renderLabel(stageEl, label, layout);
    });
  }

  private renderCrop(
    stageEl: HTMLElement,
    crop: StudioCaptionBoardCrop,
    layout: StudioImageEditorSurfaceLayout
  ): void {
    const selection: StudioImageEditorSelection = { kind: "crop" };
    const selected = selectionEquals(this.selection, selection);
    const cropEl = stageEl.createDiv({
      cls: `ss-studio-caption-board__crop${selected ? " is-selected" : ""}`,
    });
    setFrameStyles(cropEl, crop, layout);
    cropEl.setCssStyles({ zIndex: "40" });
    cropEl.addEventListener("pointerdown", (event) => this.startInteraction(event, selection, "move"));
    if (selected) {
      cropEl.createDiv({ cls: "ss-studio-caption-board__crop-label", text: "Crop" });
      const handle = cropEl.createDiv({ cls: "ss-studio-caption-board__overlay-resize-handle" });
      handle.addEventListener("pointerdown", (event) => this.startInteraction(event, selection, "resize"));
    }
  }

  private renderAnnotation(
    stageEl: HTMLElement,
    annotation: StudioCaptionBoardAnnotation,
    layout: StudioImageEditorSurfaceLayout
  ): void {
    const selection: StudioImageEditorSelection = { kind: "annotation", id: annotation.id };
    const selected = selectionEquals(this.selection, selection);
    const element = stageEl.createDiv({
      cls: `ss-studio-caption-board__annotation is-hit-area is-${annotation.kind}${selected ? " is-selected" : ""}`,
    });
    element.dataset.annotationId = annotation.id;
    setFrameStyles(element, annotation, layout);
    element.style.zIndex = String(12 + annotation.zIndex);
    element.style.setProperty("--ss-studio-annotation-color", annotation.color);
    element.style.setProperty(
      "--ss-studio-annotation-stroke",
      `${Math.max(2, annotation.strokeWidth * this.zoom)}px`
    );
    element.addEventListener("pointerdown", (event) => this.startInteraction(event, selection, "move"));
    if (selected) {
      element.createDiv({
        cls: "ss-studio-caption-board__annotation-chip",
        text: annotationLabel(annotation.kind),
      });
      const handle = element.createDiv({ cls: "ss-studio-caption-board__overlay-resize-handle" });
      handle.addEventListener("pointerdown", (event) => this.startInteraction(event, selection, "resize"));
    }
  }

  private renderLabel(
    stageEl: HTMLElement,
    label: StudioCaptionBoardLabel,
    layout: StudioImageEditorSurfaceLayout
  ): void {
    const selection: StudioImageEditorSelection = { kind: "label", id: label.id };
    const selected = selectionEquals(this.selection, selection);
    const element = stageEl.createDiv({
      cls: `ss-studio-caption-board__label is-hit-area${selected ? " is-selected" : ""}`,
    });
    element.dataset.labelId = label.id;
    setFrameStyles(element, label, layout);
    element.style.zIndex = String(20 + label.zIndex);
    element.addEventListener("pointerdown", (event) => this.startInteraction(event, selection, "move"));
    if (selected) {
      const handle = element.createDiv({ cls: "ss-studio-caption-board__label-resize-handle" });
      handle.addEventListener("pointerdown", (event) => this.startInteraction(event, selection, "resize"));
    }
  }

  private handleWheel(event: WheelEvent): void {
    if (!this.source.src || !this.source.width || !this.source.height) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      this.setZoom(this.zoom * (event.deltaY < 0 ? 1.08 : 0.92), event);
      return;
    }
    this.viewportEl.scrollLeft += event.deltaX;
    this.viewportEl.scrollTop += event.deltaY;
  }

  private setZoom(nextZoom: number, event: WheelEvent): void {
    const zoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(zoom - this.zoom) < 0.0001) {
      return;
    }
    const previousLayout = this.getLayout();
    const rect = this.viewportEl.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const imageX = (this.viewportEl.scrollLeft + anchorX - previousLayout.stageLeft) / this.zoom;
    const imageY = (this.viewportEl.scrollTop + anchorY - previousLayout.stageTop) / this.zoom;
    this.zoom = zoom;
    this.renderCurrent();
    const layout = this.getLayout();
    this.viewportEl.scrollLeft = Math.max(0, layout.stageLeft + imageX * zoom - anchorX);
    this.viewportEl.scrollTop = Math.max(0, layout.stageTop + imageY * zoom - anchorY);
  }

  private handleStagePointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        ".ss-studio-caption-board__label, .ss-studio-caption-board__annotation, .ss-studio-caption-board__crop"
      )
    ) {
      return;
    }
    this.actions.onSelect(null);
  }

  private startInteraction(
    event: PointerEvent,
    selection: StudioImageEditorSelection,
    mode: "move" | "resize"
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const initialFrame = this.actions.resolveSelectionFrame(selection);
    if (!initialFrame) {
      this.actions.onSelect(selection);
      return;
    }
    this.interaction = {
      mode,
      pointerId: event.pointerId,
      selection,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialFrame,
      capturedHistory: false,
    };
    this.actions.onSelect(selection);
  }

  private handlePointerMove(event: PointerEvent): void {
    const interaction = this.interaction;
    if (!interaction || interaction.pointerId !== event.pointerId || !this.stageEl) {
      return;
    }
    const rect = this.stageEl.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const deltaX = (event.clientX - interaction.startClientX) / rect.width;
    const deltaY = (event.clientY - interaction.startClientY) / rect.height;
    let patch: Partial<StudioCaptionBoardCrop>;
    if (interaction.mode === "move") {
      patch = {
        x: clamp(interaction.initialFrame.x + deltaX, 0, 1 - interaction.initialFrame.width),
        y: clamp(interaction.initialFrame.y + deltaY, 0, 1 - interaction.initialFrame.height),
      };
    } else {
      const [minWidth, minHeight] = minimumFrameSize(interaction.selection);
      patch = {
        width: clamp(
          interaction.initialFrame.width + deltaX,
          minWidth,
          1 - interaction.initialFrame.x
        ),
        height: clamp(
          interaction.initialFrame.height + deltaY,
          minHeight,
          1 - interaction.initialFrame.y
        ),
      };
    }
    this.actions.onPatchFrame(interaction.selection, patch, {
      mode: "continuous",
      captureHistory: !interaction.capturedHistory,
    });
    interaction.capturedHistory = true;
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.interaction?.pointerId === event.pointerId) {
      this.interaction = null;
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const tagName = (event.target as HTMLElement | null)?.tagName?.toLowerCase() || "";
    if (tagName === "input" || tagName === "textarea" || tagName === "select") {
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && this.selection) {
      event.preventDefault();
      this.actions.onDeleteSelected();
    } else if (event.key === "Escape") {
      this.actions.onSelect(null);
    }
  }
}

function setFrameStyles(
  element: HTMLElement,
  frame: StudioImageEditorFrame,
  layout: StudioImageEditorSurfaceLayout
): void {
  element.style.left = `${frame.x * layout.stageWidth}px`;
  element.style.top = `${frame.y * layout.stageHeight}px`;
  element.style.width = `${frame.width * layout.stageWidth}px`;
  element.style.height = `${frame.height * layout.stageHeight}px`;
}

function minimumFrameSize(selection: StudioImageEditorSelection): [number, number] {
  if (selection.kind === "label") {
    return [LABEL_MIN_WIDTH, LABEL_MIN_HEIGHT];
  }
  if (selection.kind === "crop") {
    return [CROP_MIN_WIDTH, CROP_MIN_HEIGHT];
  }
  return [ANNOTATION_MIN_WIDTH, ANNOTATION_MIN_HEIGHT];
}
