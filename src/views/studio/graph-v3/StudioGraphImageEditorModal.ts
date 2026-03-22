import { readFile } from "node:fs/promises";
import { App, Modal, Notice } from "obsidian";
import {
  boardStateHasRenderableEdits,
  countStudioCaptionBoardEdits,
  createStudioCaptionBoardAnnotation,
  createStudioCaptionBoardCrop,
  createStudioCaptionBoardLabel,
  readStudioCaptionBoardState,
  type StudioCaptionBoardAnnotation,
  type StudioCaptionBoardAnnotationKind,
  type StudioCaptionBoardCrop,
  type StudioCaptionBoardLabel,
  type StudioCaptionBoardState,
  type StudioCaptionBoardStyleVariant,
  type StudioCaptionBoardTextAlign,
  writeStudioCaptionBoardState,
} from "../../../studio/StudioCaptionBoardState";
import {
  composeStudioCaptionBoardImage,
  renderStudioCaptionBoardImageFromBytes,
} from "../../../studio/StudioCaptionBoardComposition";
import { inferMimeTypeFromPath, isLikelyAbsolutePath } from "../../../studio/nodes/shared";
import type { StudioAssetRef, StudioNodeInstance } from "../../../studio/types";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";

type BoardSelection =
  | { kind: "label"; id: string }
  | { kind: "annotation"; id: string }
  | { kind: "crop" };

type DragInteraction = {
  mode: "move" | "resize";
  pointerId: number;
  selection: BoardSelection;
  startClientX: number;
  startClientY: number;
  initialX: number;
  initialY: number;
  initialWidth: number;
  initialHeight: number;
};

type StudioCaptionBoardModalOptions = {
  app: App;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  projectPath: string;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
  storeAsset: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onRenderedAssetCommitted?: (node: StudioNodeInstance) => void;
};

type StudioCaptionBoardSurfaceLayout = {
  surfaceWidth: number;
  surfaceHeight: number;
  stageLeft: number;
  stageTop: number;
  stageWidth: number;
  stageHeight: number;
};

const LABEL_MIN_WIDTH = 0.12;
const LABEL_MIN_HEIGHT = 0.08;
const LABEL_DEFAULT_WIDTH = 0.44;
const LABEL_DEFAULT_HEIGHT = 0.18;
const ANNOTATION_MIN_WIDTH = 0.08;
const ANNOTATION_MIN_HEIGHT = 0.08;
const ANNOTATION_DEFAULT_WIDTH = 0.26;
const ANNOTATION_DEFAULT_HEIGHT = 0.18;
const CROP_MIN_WIDTH = 0.12;
const CROP_MIN_HEIGHT = 0.12;
const DEFAULT_CROP_WIDTH = 0.82;
const DEFAULT_CROP_HEIGHT = 0.82;
const DEFAULT_HIGHLIGHT_COLOR = "#ff4d4f";
const DEFAULT_STROKE_WIDTH = 8;
const DEFAULT_BLUR_RADIUS = 16;
const ZOOM_MIN = 0.18;
const ZOOM_MAX = 4;
const SURFACE_PADDING = 140;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeAssetRef(value: unknown): StudioAssetRef | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const hash = readString(record.hash).trim();
  const path = readString(record.path).trim();
  const mimeType = readString(record.mimeType || record.mime_type).trim();
  const sizeBytesRaw = Number(record.sizeBytes ?? record.size_bytes);
  const sizeBytes = Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? Math.floor(sizeBytesRaw) : 0;
  if (!hash || !path || !mimeType || !sizeBytes) {
    return null;
  }
  return {
    hash,
    path,
    mimeType,
    sizeBytes,
  };
}

function sortBoardLabels(labels: StudioCaptionBoardLabel[]): StudioCaptionBoardLabel[] {
  return labels.slice().sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
}

function sortBoardAnnotations(annotations: StudioCaptionBoardAnnotation[]): StudioCaptionBoardAnnotation[] {
  return annotations.slice().sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
}

function buildFilePreviewSrc(path: string): string {
  return encodeURI(`file://${path}`);
}

function normalizeBinaryToArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) {
    return bytes;
  }
  return Uint8Array.from(bytes).buffer;
}

function selectionEquals(a: BoardSelection | null, b: BoardSelection | null): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  return a.kind === b.kind && (a.kind === "crop" || b.kind === "crop" ? true : a.id === b.id);
}

function annotationLabel(kind: StudioCaptionBoardAnnotationKind): string {
  if (kind === "highlight_circle") {
    return "Red Circle";
  }
  if (kind === "blur_rect") {
    return "Blur Box";
  }
  return "Red Rectangle";
}

function resolveSelectedLabel(state: StudioCaptionBoardState, selection: BoardSelection | null): StudioCaptionBoardLabel | null {
  if (!selection || selection.kind !== "label") {
    return null;
  }
  return state.labels.find((label) => label.id === selection.id) || null;
}

function resolveSelectedAnnotation(
  state: StudioCaptionBoardState,
  selection: BoardSelection | null
): StudioCaptionBoardAnnotation | null {
  if (!selection || selection.kind !== "annotation") {
    return null;
  }
  return state.annotations.find((annotation) => annotation.id === selection.id) || null;
}

function normalizeSelection(state: StudioCaptionBoardState, selection: BoardSelection | null): BoardSelection | null {
  if (selection?.kind === "label" && state.labels.some((label) => label.id === selection.id)) {
    return selection;
  }
  if (selection?.kind === "annotation" && state.annotations.some((annotation) => annotation.id === selection.id)) {
    return selection;
  }
  if (selection?.kind === "crop" && state.crop) {
    return selection;
  }
  const firstLabel = state.labels[0];
  if (firstLabel) {
    return { kind: "label", id: firstLabel.id };
  }
  const firstAnnotation = state.annotations[0];
  if (firstAnnotation) {
    return { kind: "annotation", id: firstAnnotation.id };
  }
  if (state.crop) {
    return { kind: "crop" };
  }
  return null;
}

class StudioCaptionBoardModal extends Modal {
  private boardState: StudioCaptionBoardState;
  private selectedItem: BoardSelection | null;
  private viewportEl!: HTMLElement;
  private surfaceEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private sidebarEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private doneButtonEl!: HTMLButtonElement;
  private fitButtonEl!: HTMLButtonElement;
  private addTextButtonEl!: HTMLButtonElement;
  private highlightRectButtonEl!: HTMLButtonElement;
  private highlightCircleButtonEl!: HTMLButtonElement;
  private blurButtonEl!: HTMLButtonElement;
  private cropButtonEl!: HTMLButtonElement;
  private baseImageAsset: StudioAssetRef | null = null;
  private baseImageBytes: ArrayBuffer | null = null;
  private basePreviewPath = "";
  private basePreviewSrc = "";
  private renderedPreviewSrc = "";
  private previewRenderVersion = 0;
  private imageNaturalWidth = 0;
  private imageNaturalHeight = 0;
  private zoom = 1;
  private interaction: DragInteraction | null = null;
  private isDoneSaving = false;
  private statusMessageOverride = "";
  private readonly detachGlobalListeners: Array<() => void> = [];

  constructor(private readonly options: StudioCaptionBoardModalOptions) {
    super(options.app);
    this.boardState = readStudioCaptionBoardState(options.node.config);
    this.selectedItem = normalizeSelection(this.boardState, null);
  }

  onOpen(): void {
    const title = this.options.node.title || "Image Editor";
    if (typeof (this as unknown as { setTitle?: (value: string) => void }).setTitle === "function") {
      (this as unknown as { setTitle: (value: string) => void }).setTitle(title);
    } else {
      this.titleEl.setText(title);
    }
    this.titleEl.empty();
    this.titleEl.style.display = "none";

    this.modalEl.addClass("ss-studio-caption-board-modal-shell");
    this.contentEl.empty();
    this.contentEl.addClass("ss-studio-caption-board-modal");

    const root = this.contentEl.createDiv({ cls: "ss-studio-caption-board" });
    this.toolbarEl = root.createDiv({ cls: "ss-studio-caption-board__toolbar" });
    const titleStack = this.toolbarEl.createDiv({ cls: "ss-studio-caption-board__toolbar-title-stack" });
    titleStack.createDiv({
      cls: "ss-studio-caption-board__toolbar-eyebrow",
      text: "Image Editor",
    });
    titleStack.createDiv({
      cls: "ss-studio-caption-board__toolbar-title",
      text: title,
    });
    const actionsEl = this.toolbarEl.createDiv({ cls: "ss-studio-caption-board__toolbar-actions" });
    this.addTextButtonEl = this.createToolbarButton(actionsEl, "Text", () => this.handleAddLabel());
    this.highlightRectButtonEl = this.createToolbarButton(actionsEl, "Box", () => this.handleAddAnnotation("highlight_rect"));
    this.highlightCircleButtonEl = this.createToolbarButton(actionsEl, "Circle", () => this.handleAddAnnotation("highlight_circle"));
    this.blurButtonEl = this.createToolbarButton(actionsEl, "Blur", () => this.handleAddAnnotation("blur_rect"));
    this.cropButtonEl = this.createToolbarButton(actionsEl, "Crop", () => this.handleEnsureCrop());
    this.fitButtonEl = this.createToolbarButton(actionsEl, "Fit", () => this.fitCanvasToViewport());
    this.doneButtonEl = this.createToolbarButton(actionsEl, "Done", () => {
      void this.handleDone();
    });
    this.createToolbarButton(actionsEl, "Close", () => this.close());

    const bodyEl = root.createDiv({ cls: "ss-studio-caption-board__body" });
    this.viewportEl = bodyEl.createDiv({ cls: "ss-studio-caption-board__viewport" });
    this.surfaceEl = this.viewportEl.createDiv({ cls: "ss-studio-caption-board__surface" });
    this.stageEl = this.surfaceEl.createDiv({ cls: "ss-studio-caption-board__stage" });
    this.sidebarEl = bodyEl.createDiv({ cls: "ss-studio-caption-board__sidebar" });
    this.statusEl = root.createDiv({ cls: "ss-studio-caption-board__status" });

    this.viewportEl.addEventListener("wheel", (event) => this.handleViewportWheel(event), {
      passive: false,
    });
    this.bindGlobalListeners();
    this.renderBoard();
    void this.hydrateBaseImage();
  }

  onClose(): void {
    while (this.detachGlobalListeners.length > 0) {
      const detach = this.detachGlobalListeners.pop();
      try {
        detach?.();
      } catch {
        // noop
      }
    }
    this.contentEl.empty();
  }

  private bindGlobalListeners(): void {
    const onPointerMove = (event: PointerEvent): void => this.handleGlobalPointerMove(event);
    const onPointerUp = (event: PointerEvent): void => this.handleGlobalPointerUp(event);
    const onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event);
    const onResize = (): void => {
      if (this.imageNaturalWidth > 0 && this.imageNaturalHeight > 0) {
        this.renderBoard();
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    this.detachGlobalListeners.push(
      () => window.removeEventListener("pointermove", onPointerMove),
      () => window.removeEventListener("pointerup", onPointerUp),
      () => window.removeEventListener("pointercancel", onPointerUp),
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("resize", onResize)
    );
  }

  private createToolbarButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "ss-studio-caption-board__toolbar-button",
      text: label,
    });
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private async hydrateBaseImage(): Promise<void> {
    const outputs = asRecord(this.options.nodeRunState.outputs);
    const sourcePreviewAsset = normalizeAssetRef(outputs?.source_preview_asset);
    const sourcePreviewPath =
      readString(outputs?.source_preview_path).trim() ||
      readString(this.options.node.config.sourcePath).trim();
    const previewPath = sourcePreviewAsset?.path || sourcePreviewPath;
    const previewMime = sourcePreviewAsset?.mimeType || inferMimeTypeFromPath(previewPath);

    let baseAsset = sourcePreviewAsset;
    let baseBytes: ArrayBuffer | null = null;
    let previewSrc =
      (previewPath && this.options.resolveAssetPreviewSrc?.(previewPath)) ||
      (isLikelyAbsolutePath(previewPath) ? buildFilePreviewSrc(previewPath) : "");

    if (sourcePreviewAsset) {
      try {
        baseBytes = await this.options.readAsset(sourcePreviewAsset);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statusMessageOverride = `Unable to load source image: ${message}`;
      }
    }

    if (!baseAsset && previewPath && previewMime.startsWith("image/")) {
      try {
        const bytes = isLikelyAbsolutePath(previewPath)
          ? await readFile(previewPath)
          : await this.readVaultBinary(previewPath);
        baseBytes = normalizeBinaryToArrayBuffer(bytes);
        baseAsset = await this.options.storeAsset(baseBytes, previewMime);
        if (!previewSrc) {
          previewSrc =
            this.options.resolveAssetPreviewSrc?.(baseAsset.path) ||
            (isLikelyAbsolutePath(previewPath) ? buildFilePreviewSrc(previewPath) : "");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statusMessageOverride = `Unable to load source image: ${message}`;
      }
    }

    this.baseImageAsset = baseAsset;
    this.baseImageBytes = baseBytes;
    this.basePreviewPath = previewPath;
    this.basePreviewSrc = previewSrc;
    this.renderedPreviewSrc = "";

    if (!this.basePreviewSrc) {
      this.renderBoard();
      return;
    }

    try {
      const dimensions = await this.measurePreviewDimensions(this.basePreviewSrc);
      this.imageNaturalWidth = dimensions.width;
      this.imageNaturalHeight = dimensions.height;
      this.statusMessageOverride = "";
      this.fitCanvasToViewport();
      void this.refreshRenderedPreview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusMessageOverride = `Unable to render image preview: ${message}`;
      this.renderBoard();
    }
  }

  private async readVaultBinary(path: string): Promise<ArrayBuffer> {
    const adapter = this.app.vault.adapter as {
      readBinary?: (path: string) => Promise<ArrayBuffer>;
    };
    if (typeof adapter.readBinary !== "function") {
      throw new Error("Binary vault reads are unavailable on this adapter.");
    }
    return adapter.readBinary(path);
  }

  private measurePreviewDimensions(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const imageEl = new Image();
      imageEl.onload = () => {
        const width = imageEl.naturalWidth || 1600;
        const height = imageEl.naturalHeight || 900;
        resolve({ width, height });
      };
      imageEl.onerror = () => reject(new Error("Preview image failed to load."));
      imageEl.src = src;
    });
  }

  private getCanvasLayout(nextZoom: number = this.zoom): StudioCaptionBoardSurfaceLayout {
    const stageWidth = Math.max(1, this.imageNaturalWidth * nextZoom);
    const stageHeight = Math.max(1, this.imageNaturalHeight * nextZoom);
    const viewportWidth = this.viewportEl?.clientWidth || stageWidth + SURFACE_PADDING * 2;
    const viewportHeight = this.viewportEl?.clientHeight || stageHeight + SURFACE_PADDING * 2;
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

  private fitCanvasToViewport(): void {
    if (!this.imageNaturalWidth || !this.imageNaturalHeight || !this.viewportEl) {
      return;
    }
    const availableWidth = Math.max(240, this.viewportEl.clientWidth - SURFACE_PADDING);
    const availableHeight = Math.max(200, this.viewportEl.clientHeight - SURFACE_PADDING);
    const nextZoom = clamp(
      Math.min(availableWidth / this.imageNaturalWidth, availableHeight / this.imageNaturalHeight, 1.35),
      ZOOM_MIN,
      ZOOM_MAX
    );
    this.zoom = nextZoom;
    this.renderBoard();
    this.centerStageInViewport();
  }

  private centerStageInViewport(): void {
    const layout = this.getCanvasLayout();
    this.viewportEl.scrollLeft = Math.max(0, layout.stageLeft + layout.stageWidth / 2 - this.viewportEl.clientWidth / 2);
    this.viewportEl.scrollTop = Math.max(0, layout.stageTop + layout.stageHeight / 2 - this.viewportEl.clientHeight / 2);
  }

  private setZoom(nextZoom: number, event?: WheelEvent): void {
    if (!this.imageNaturalWidth || !this.imageNaturalHeight) {
      return;
    }
    const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(clampedZoom - this.zoom) < 0.0001) {
      return;
    }
    const previousLayout = this.getCanvasLayout(this.zoom);
    const viewportRect = this.viewportEl.getBoundingClientRect();
    const anchorClientX = event ? event.clientX - viewportRect.left : this.viewportEl.clientWidth / 2;
    const anchorClientY = event ? event.clientY - viewportRect.top : this.viewportEl.clientHeight / 2;
    const imageX = (this.viewportEl.scrollLeft + anchorClientX - previousLayout.stageLeft) / this.zoom;
    const imageY = (this.viewportEl.scrollTop + anchorClientY - previousLayout.stageTop) / this.zoom;

    this.zoom = clampedZoom;
    this.renderBoard();

    const nextLayout = this.getCanvasLayout(this.zoom);
    this.viewportEl.scrollLeft = Math.max(0, nextLayout.stageLeft + imageX * this.zoom - anchorClientX);
    this.viewportEl.scrollTop = Math.max(0, nextLayout.stageTop + imageY * this.zoom - anchorClientY);
  }

  private resolveStagePreviewSrc(): string {
    return this.renderedPreviewSrc || this.basePreviewSrc;
  }

  private async refreshRenderedPreview(): Promise<void> {
    const renderVersion = ++this.previewRenderVersion;
    if (!this.baseImageBytes || !this.baseImageAsset || !this.basePreviewSrc) {
      this.renderedPreviewSrc = "";
      if (renderVersion === this.previewRenderVersion) {
        this.renderBoard();
      }
      return;
    }
    if (!boardStateHasRenderableEdits(this.boardState)) {
      this.renderedPreviewSrc = "";
      if (renderVersion === this.previewRenderVersion) {
        this.renderBoard();
      }
      return;
    }

    try {
      const rendered = await renderStudioCaptionBoardImageFromBytes({
        baseBytes: this.baseImageBytes,
        baseMimeType: this.baseImageAsset.mimeType,
        boardState: this.boardState,
        mode: "editor",
      });
      if (renderVersion !== this.previewRenderVersion) {
        return;
      }
      this.renderedPreviewSrc = rendered.dataUrl;
      this.renderBoard();
    } catch {
      if (renderVersion !== this.previewRenderVersion) {
        return;
      }
      this.renderedPreviewSrc = "";
      this.renderBoard();
    }
  }

  private renderBoard(): void {
    this.renderCanvas();
    this.renderSidebar();
    this.statusEl.setText(this.describeStatus());
    this.syncActionState();
  }

  private describeStatus(): string {
    if (this.statusMessageOverride) {
      return this.statusMessageOverride;
    }
    if (!this.basePreviewSrc) {
      return "Load a source image to start editing. You can add captions, highlights, blur, and crop once the image is available.";
    }
    const editCount = countStudioCaptionBoardEdits(this.boardState);
    if (editCount === 0) {
      return "Add text, highlights, blur, or crop. Scroll to pan and hold Cmd/Ctrl while scrolling to zoom.";
    }
    const selectedLabel = resolveSelectedLabel(this.boardState, this.selectedItem);
    const selectedAnnotation = resolveSelectedAnnotation(this.boardState, this.selectedItem);
    const selectedSuffix = selectedLabel
      ? " Selected text layer ready."
      : selectedAnnotation
        ? ` Selected ${annotationLabel(selectedAnnotation.kind).toLowerCase()} ready.`
        : this.selectedItem?.kind === "crop"
          ? " Selected crop ready."
          : "";
    return `${editCount} edit${editCount === 1 ? "" : "s"} on this image.${selectedSuffix} Scroll to pan and hold Cmd/Ctrl while scrolling to zoom.`;
  }

  private syncActionState(): void {
    const hasBaseImage = Boolean(this.basePreviewSrc);
    const disabled = !hasBaseImage || this.isDoneSaving;
    this.addTextButtonEl.disabled = disabled;
    this.highlightRectButtonEl.disabled = disabled;
    this.highlightCircleButtonEl.disabled = disabled;
    this.blurButtonEl.disabled = disabled;
    this.cropButtonEl.disabled = disabled;
    this.fitButtonEl.disabled = disabled;
    this.doneButtonEl.disabled = this.isDoneSaving || !hasBaseImage;
    this.doneButtonEl.textContent = this.isDoneSaving ? "Saving..." : "Done";
  }

  private renderCanvas(): void {
    this.surfaceEl.empty();

    if (!this.basePreviewSrc || !this.imageNaturalWidth || !this.imageNaturalHeight) {
      const emptyEl = this.surfaceEl.createDiv({ cls: "ss-studio-caption-board__empty" });
      emptyEl.setText(
        this.basePreviewPath
          ? "Loading source image..."
          : "Run this media node once or use a stored Studio asset so the editor can load the source image."
      );
      return;
    }

    const layout = this.getCanvasLayout();
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
      attr: {
        src: this.resolveStagePreviewSrc(),
        alt: this.options.node.title || "Image editor source",
      },
    });
    imageEl.draggable = false;

    if (this.boardState.crop) {
      this.renderCropOverlay(stageEl, layout);
    }

    for (const annotation of sortBoardAnnotations(this.boardState.annotations)) {
      this.renderAnnotation(stageEl, annotation, layout);
    }

    for (const label of sortBoardLabels(this.boardState.labels)) {
      this.renderLabel(stageEl, label, layout);
    }
  }

  private renderCropOverlay(stageEl: HTMLElement, layout: StudioCaptionBoardSurfaceLayout): void {
    const crop = this.boardState.crop;
    if (!crop) {
      return;
    }
    const selection: BoardSelection = { kind: "crop" };
    const isSelected = selectionEquals(this.selectedItem, selection);
    const cropEl = stageEl.createDiv({
      cls: "ss-studio-caption-board__crop" + (isSelected ? " is-selected" : ""),
    });
    cropEl.style.left = `${crop.x * layout.stageWidth}px`;
    cropEl.style.top = `${crop.y * layout.stageHeight}px`;
    cropEl.style.width = `${crop.width * layout.stageWidth}px`;
    cropEl.style.height = `${crop.height * layout.stageHeight}px`;
    cropEl.style.zIndex = "40";
    cropEl.addEventListener("pointerdown", (event) => this.handleItemPointerDown(event, selection, "move"));

    if (isSelected) {
      cropEl.createDiv({
        cls: "ss-studio-caption-board__crop-label",
        text: "Crop",
      });
      const resizeHandleEl = cropEl.createDiv({ cls: "ss-studio-caption-board__overlay-resize-handle" });
      resizeHandleEl.addEventListener("pointerdown", (event) => this.handleItemPointerDown(event, selection, "resize"));
    }
  }

  private renderAnnotation(
    stageEl: HTMLElement,
    annotation: StudioCaptionBoardAnnotation,
    layout: StudioCaptionBoardSurfaceLayout
  ): void {
    const selection: BoardSelection = { kind: "annotation", id: annotation.id };
    const isSelected = selectionEquals(this.selectedItem, selection);
    const annotationEl = stageEl.createDiv({
      cls:
        "ss-studio-caption-board__annotation is-hit-area" +
        ` is-${annotation.kind}` +
        (isSelected ? " is-selected" : ""),
    });
    annotationEl.dataset.annotationId = annotation.id;
    annotationEl.style.left = `${annotation.x * layout.stageWidth}px`;
    annotationEl.style.top = `${annotation.y * layout.stageHeight}px`;
    annotationEl.style.width = `${annotation.width * layout.stageWidth}px`;
    annotationEl.style.height = `${annotation.height * layout.stageHeight}px`;
    annotationEl.style.zIndex = String(12 + annotation.zIndex);
    annotationEl.style.setProperty("--ss-studio-annotation-color", annotation.color);
    annotationEl.style.setProperty("--ss-studio-annotation-stroke", `${Math.max(2, annotation.strokeWidth * this.zoom)}px`);
    annotationEl.addEventListener("pointerdown", (event) => this.handleItemPointerDown(event, selection, "move"));

    if (isSelected) {
      annotationEl.createDiv({
        cls: "ss-studio-caption-board__annotation-chip",
        text: annotationLabel(annotation.kind),
      });
      const resizeHandleEl = annotationEl.createDiv({ cls: "ss-studio-caption-board__overlay-resize-handle" });
      resizeHandleEl.addEventListener("pointerdown", (event) => this.handleItemPointerDown(event, selection, "resize"));
    }
  }

  private renderLabel(stageEl: HTMLElement, label: StudioCaptionBoardLabel, layout: StudioCaptionBoardSurfaceLayout): void {
    const selection: BoardSelection = { kind: "label", id: label.id };
    const isSelected = selectionEquals(this.selectedItem, selection);
    const labelEl = stageEl.createDiv({
      cls:
        "ss-studio-caption-board__label is-hit-area" +
        (isSelected ? " is-selected" : ""),
    });
    labelEl.dataset.labelId = label.id;
    labelEl.style.left = `${label.x * layout.stageWidth}px`;
    labelEl.style.top = `${label.y * layout.stageHeight}px`;
    labelEl.style.width = `${label.width * layout.stageWidth}px`;
    labelEl.style.height = `${label.height * layout.stageHeight}px`;
    labelEl.style.zIndex = String(20 + label.zIndex);
    labelEl.addEventListener("pointerdown", (event) => this.handleItemPointerDown(event, selection, "move"));

    if (isSelected) {
      const resizeHandleEl = labelEl.createDiv({ cls: "ss-studio-caption-board__label-resize-handle" });
      resizeHandleEl.addEventListener("pointerdown", (event) => this.handleItemPointerDown(event, selection, "resize"));
    }
  }

  private renderSidebar(): void {
    this.sidebarEl.empty();
    const headerEl = this.sidebarEl.createDiv({ cls: "ss-studio-caption-board__sidebar-header" });
    headerEl.createDiv({
      cls: "ss-studio-caption-board__sidebar-title",
      text: "Inspector",
    });
    headerEl.createDiv({
      cls: "ss-studio-caption-board__sidebar-subtitle",
      text: this.basePreviewSrc
        ? "Captions are just one tool here. You can also crop, add red callouts, and blur areas directly on the image."
        : "Load an image source to start editing.",
    });

    if (!this.basePreviewSrc) {
      this.sidebarEl.createDiv({
        cls: "ss-studio-caption-board__sidebar-empty",
        text: "This editor needs an image source before you can add text, crop, blur, or highlights.",
      });
      return;
    }

    const boardSection = this.sidebarEl.createDiv({ cls: "ss-studio-caption-board__inspector-section" });
    boardSection.createDiv({
      cls: "ss-studio-caption-board__inspector-section-title",
      text: "Tools",
    });
    boardSection.createDiv({
      cls: "ss-studio-caption-board__sidebar-copy",
      text: this.describeSidebarSelectionCopy(),
    });
    const toolButtonsEl = boardSection.createDiv({ cls: "ss-studio-caption-board__button-grid" });
    this.createSecondaryButton(toolButtonsEl, "Add Text", () => this.handleAddLabel());
    this.createSecondaryButton(toolButtonsEl, "Red Box", () => this.handleAddAnnotation("highlight_rect"));
    this.createSecondaryButton(toolButtonsEl, "Red Circle", () => this.handleAddAnnotation("highlight_circle"));
    this.createSecondaryButton(toolButtonsEl, "Blur Box", () => this.handleAddAnnotation("blur_rect"));
    this.createSecondaryButton(toolButtonsEl, this.boardState.crop ? "Select Crop" : "Add Crop", () => this.handleEnsureCrop());
    this.createSecondaryButton(toolButtonsEl, "Deselect", () => {
      this.selectedItem = null;
      this.renderBoard();
    });

    const selectedLabel = resolveSelectedLabel(this.boardState, this.selectedItem);
    const selectedAnnotation = resolveSelectedAnnotation(this.boardState, this.selectedItem);
    if (selectedLabel) {
      this.renderLabelInspector(selectedLabel);
      return;
    }
    if (selectedAnnotation) {
      this.renderAnnotationInspector(selectedAnnotation);
      return;
    }
    if (this.selectedItem?.kind === "crop" && this.boardState.crop) {
      this.renderCropInspector(this.boardState.crop);
    }
  }

  private describeSidebarSelectionCopy(): string {
    const selectedLabel = resolveSelectedLabel(this.boardState, this.selectedItem);
    if (selectedLabel) {
      return "Selected text layer settings.";
    }
    const selectedAnnotation = resolveSelectedAnnotation(this.boardState, this.selectedItem);
    if (selectedAnnotation) {
      return `${annotationLabel(selectedAnnotation.kind)} settings.`;
    }
    if (this.selectedItem?.kind === "crop") {
      return "Selected crop settings. Everything outside this box is trimmed from the final image.";
    }
    const editCount = countStudioCaptionBoardEdits(this.boardState);
    if (editCount === 0) {
      return "Add a tool to start editing on the image.";
    }
    return "Select an item on the canvas to edit it here.";
  }

  private renderLabelInspector(label: StudioCaptionBoardLabel): void {
    const inspectorSection = this.sidebarEl.createDiv({ cls: "ss-studio-caption-board__inspector-section" });
    inspectorSection.createDiv({
      cls: "ss-studio-caption-board__inspector-section-title",
      text: "Text",
    });

    const textField = this.createField(inspectorSection, "Text");
    const textInput = textField.createEl("textarea", {
      cls: "ss-studio-caption-board__textarea",
      attr: {
        "aria-label": "Selected text layer",
      },
    });
    textInput.value = label.text;
    textInput.addEventListener("input", (event) => {
      this.patchSelectedLabel({ text: (event.target as HTMLTextAreaElement).value });
    });

    const fontRow = this.createGrid(inspectorSection, 2);
    this.createNumberInput(fontRow, {
      label: "Font",
      value: label.fontSize,
      min: 18,
      max: 160,
      step: 1,
      onInput: (value) => this.patchSelectedLabel({ fontSize: value }),
    });
    this.createColorInput(fontRow, {
      label: "Color",
      value: label.textColor,
      onInput: (value) => this.patchSelectedLabel({ textColor: value }),
    });

    const alignField = this.createField(inspectorSection, "Align");
    const alignButtons = alignField.createDiv({ cls: "ss-studio-caption-board__toggle-row" });
    this.createToggleButton(alignButtons, "Left", label.textAlign === "left", () => this.patchSelectedLabel({ textAlign: "left" }));
    this.createToggleButton(alignButtons, "Center", label.textAlign === "center", () => this.patchSelectedLabel({ textAlign: "center" }));
    this.createToggleButton(alignButtons, "Right", label.textAlign === "right", () => this.patchSelectedLabel({ textAlign: "right" }));

    const styleField = this.createField(inspectorSection, "Style");
    const styleButtons = styleField.createDiv({ cls: "ss-studio-caption-board__toggle-row" });
    this.createStyleButton(styleButtons, "Shadow", label.styleVariant, "shadow");
    this.createStyleButton(styleButtons, "Outline", label.styleVariant, "outline");
    this.createStyleButton(styleButtons, "Banner", label.styleVariant, "banner");

    const actionField = this.createField(inspectorSection, "Actions");
    const actionButtons = actionField.createDiv({ cls: "ss-studio-caption-board__button-grid" });
    this.createSecondaryButton(actionButtons, "Duplicate", () => this.duplicateSelectedItem());
    this.createSecondaryButton(actionButtons, "Delete", () => this.deleteSelectedItem());
    this.createSecondaryButton(actionButtons, "Bring Forward", () => this.bumpSelectedItem(1));
    this.createSecondaryButton(actionButtons, "Send Back", () => this.bumpSelectedItem(-1));
  }

  private renderAnnotationInspector(annotation: StudioCaptionBoardAnnotation): void {
    const inspectorSection = this.sidebarEl.createDiv({ cls: "ss-studio-caption-board__inspector-section" });
    inspectorSection.createDiv({
      cls: "ss-studio-caption-board__inspector-section-title",
      text: annotationLabel(annotation.kind),
    });

    const kindField = this.createField(inspectorSection, "Type");
    const kindButtons = kindField.createDiv({ cls: "ss-studio-caption-board__toggle-row" });
    this.createToggleButton(kindButtons, "Box", annotation.kind === "highlight_rect", () => {
      this.patchSelectedAnnotation({ kind: "highlight_rect" });
    });
    this.createToggleButton(kindButtons, "Circle", annotation.kind === "highlight_circle", () => {
      this.patchSelectedAnnotation({ kind: "highlight_circle" });
    });
    this.createToggleButton(kindButtons, "Blur", annotation.kind === "blur_rect", () => {
      this.patchSelectedAnnotation({ kind: "blur_rect" });
    });

    const visualRow = this.createGrid(inspectorSection, 2);
    this.createColorInput(visualRow, {
      label: "Color",
      value: annotation.color,
      onInput: (value) => this.patchSelectedAnnotation({ color: value }),
    });
    this.createNumberInput(visualRow, {
      label: annotation.kind === "blur_rect" ? "Outline" : "Stroke",
      value: annotation.strokeWidth,
      min: 2,
      max: 24,
      step: 1,
      onInput: (value) => this.patchSelectedAnnotation({ strokeWidth: value }),
    });

    if (annotation.kind === "blur_rect") {
      this.createNumberInput(inspectorSection, {
        label: "Blur Amount",
        value: annotation.blurRadius,
        min: 4,
        max: 48,
        step: 1,
        onInput: (value) => this.patchSelectedAnnotation({ blurRadius: value }),
      });
    }

    const actionField = this.createField(inspectorSection, "Actions");
    const actionButtons = actionField.createDiv({ cls: "ss-studio-caption-board__button-grid" });
    this.createSecondaryButton(actionButtons, "Duplicate", () => this.duplicateSelectedItem());
    this.createSecondaryButton(actionButtons, "Delete", () => this.deleteSelectedItem());
    this.createSecondaryButton(actionButtons, "Bring Forward", () => this.bumpSelectedItem(1));
    this.createSecondaryButton(actionButtons, "Send Back", () => this.bumpSelectedItem(-1));
  }

  private renderCropInspector(crop: StudioCaptionBoardCrop): void {
    const inspectorSection = this.sidebarEl.createDiv({ cls: "ss-studio-caption-board__inspector-section" });
    inspectorSection.createDiv({
      cls: "ss-studio-caption-board__inspector-section-title",
      text: "Crop",
    });
    inspectorSection.createDiv({
      cls: "ss-studio-caption-board__sidebar-copy",
      text: "This crop box controls what area is exported from the image.",
    });

    const positionRow = this.createGrid(inspectorSection, 2);
    this.createNumberInput(positionRow, {
      label: "X %",
      value: Math.round(crop.x * 100),
      min: 0,
      max: 100,
      step: 1,
      onInput: (value) => this.patchCrop({ x: value / 100 }),
    });
    this.createNumberInput(positionRow, {
      label: "Y %",
      value: Math.round(crop.y * 100),
      min: 0,
      max: 100,
      step: 1,
      onInput: (value) => this.patchCrop({ y: value / 100 }),
    });

    const sizeRow = this.createGrid(inspectorSection, 2);
    this.createNumberInput(sizeRow, {
      label: "Width %",
      value: Math.round(crop.width * 100),
      min: Math.round(CROP_MIN_WIDTH * 100),
      max: 100,
      step: 1,
      onInput: (value) => this.patchCrop({ width: value / 100 }),
    });
    this.createNumberInput(sizeRow, {
      label: "Height %",
      value: Math.round(crop.height * 100),
      min: Math.round(CROP_MIN_HEIGHT * 100),
      max: 100,
      step: 1,
      onInput: (value) => this.patchCrop({ height: value / 100 }),
    });

    const actionField = this.createField(inspectorSection, "Actions");
    const actionButtons = actionField.createDiv({ cls: "ss-studio-caption-board__button-row" });
    this.createSecondaryButton(actionButtons, "Clear Crop", () => this.clearCrop());
  }

  private createField(parent: HTMLElement, label: string): HTMLElement {
    const field = parent.createDiv({ cls: "ss-studio-caption-board__field" });
    field.createDiv({
      cls: "ss-studio-caption-board__field-label",
      text: label,
    });
    return field;
  }

  private createGrid(parent: HTMLElement, columns: number): HTMLElement {
    return parent.createDiv({
      cls: `ss-studio-caption-board__grid is-${columns}-col`,
    });
  }

  private createToggleButton(parent: HTMLElement, label: string, active: boolean, onClick: () => void): void {
    const button = parent.createEl("button", {
      cls: "ss-studio-caption-board__toggle" + (active ? " is-active" : ""),
      text: label,
    });
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  private createStyleButton(
    parent: HTMLElement,
    label: string,
    current: StudioCaptionBoardStyleVariant,
    next: StudioCaptionBoardStyleVariant
  ): void {
    this.createToggleButton(parent, label, current === next, () => {
      this.patchSelectedLabel({ styleVariant: next });
    });
  }

  private createSecondaryButton(parent: HTMLElement, label: string, onClick: () => void): void {
    const button = parent.createEl("button", {
      cls: "ss-studio-caption-board__secondary-button",
      text: label,
    });
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  private createNumberInput(
    parent: HTMLElement,
    options: {
      label: string;
      value: number;
      min: number;
      max: number;
      step: number;
      onInput: (value: number) => void;
    }
  ): void {
    const field = this.createField(parent, options.label);
    const input = field.createEl("input", {
      cls: "ss-studio-caption-board__input",
      type: "number",
    });
    input.value = String(options.value);
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.addEventListener("input", (event) => {
      options.onInput(Number((event.target as HTMLInputElement).value));
    });
  }

  private createColorInput(
    parent: HTMLElement,
    options: {
      label: string;
      value: string;
      onInput: (value: string) => void;
    }
  ): void {
    const field = this.createField(parent, options.label);
    const input = field.createEl("input", {
      cls: "ss-studio-caption-board__input is-color",
      type: "color",
    });
    input.value = options.value;
    input.addEventListener("input", (event) => {
      options.onInput((event.target as HTMLInputElement).value);
    });
  }

  private handleViewportWheel(event: WheelEvent): void {
    if (!this.basePreviewSrc || !this.imageNaturalWidth || !this.imageNaturalHeight) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey) {
      const factor = event.deltaY < 0 ? 1.08 : 0.92;
      this.setZoom(this.zoom * factor, event);
      return;
    }

    this.viewportEl.scrollLeft += event.deltaX;
    this.viewportEl.scrollTop += event.deltaY;
  }

  private handleStagePointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (
      target.closest(
        ".ss-studio-caption-board__label, .ss-studio-caption-board__annotation, .ss-studio-caption-board__crop"
      )
    ) {
      return;
    }
    this.selectedItem = null;
    this.renderBoard();
  }

  private handleItemPointerDown(event: PointerEvent, selection: BoardSelection, mode: "move" | "resize"): void {
    event.preventDefault();
    event.stopPropagation();
    const frame = this.resolveSelectionFrame(selection);
    if (!frame) {
      this.selectedItem = normalizeSelection(this.boardState, selection);
      this.renderBoard();
      return;
    }
    this.selectedItem = selection;
    this.interaction = {
      mode,
      pointerId: event.pointerId,
      selection,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialX: frame.x,
      initialY: frame.y,
      initialWidth: frame.width,
      initialHeight: frame.height,
    };
    this.renderBoard();
  }

  private resolveSelectionFrame(selection: BoardSelection | null): { x: number; y: number; width: number; height: number } | null {
    if (!selection) {
      return null;
    }
    if (selection.kind === "label") {
      const label = resolveSelectedLabel(this.boardState, selection);
      return label ? { x: label.x, y: label.y, width: label.width, height: label.height } : null;
    }
    if (selection.kind === "annotation") {
      const annotation = resolveSelectedAnnotation(this.boardState, selection);
      return annotation
        ? { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }
        : null;
    }
    const crop = this.boardState.crop;
    return crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : null;
  }

  private handleGlobalPointerMove(event: PointerEvent): void {
    if (!this.interaction || this.interaction.pointerId !== event.pointerId || !this.stageEl) {
      return;
    }
    const rect = this.stageEl.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const deltaX = (event.clientX - this.interaction.startClientX) / rect.width;
    const deltaY = (event.clientY - this.interaction.startClientY) / rect.height;

    if (this.interaction.mode === "move") {
      const nextX = clamp(this.interaction.initialX + deltaX, 0, 1 - this.interaction.initialWidth);
      const nextY = clamp(this.interaction.initialY + deltaY, 0, 1 - this.interaction.initialHeight);
      this.patchSelectionFrame(this.interaction.selection, { x: nextX, y: nextY });
      return;
    }

    const minWidth = this.interaction.selection.kind === "label" ? LABEL_MIN_WIDTH : this.interaction.selection.kind === "crop" ? CROP_MIN_WIDTH : ANNOTATION_MIN_WIDTH;
    const minHeight = this.interaction.selection.kind === "label" ? LABEL_MIN_HEIGHT : this.interaction.selection.kind === "crop" ? CROP_MIN_HEIGHT : ANNOTATION_MIN_HEIGHT;
    const nextWidth = clamp(this.interaction.initialWidth + deltaX, minWidth, 1 - this.interaction.initialX);
    const nextHeight = clamp(this.interaction.initialHeight + deltaY, minHeight, 1 - this.interaction.initialY);
    this.patchSelectionFrame(this.interaction.selection, { width: nextWidth, height: nextHeight });
  }

  private handleGlobalPointerUp(event: PointerEvent): void {
    if (!this.interaction || this.interaction.pointerId !== event.pointerId) {
      return;
    }
    this.interaction = null;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const activeTag = (event.target as HTMLElement | null)?.tagName?.toLowerCase() || "";
    if (activeTag === "input" || activeTag === "textarea" || activeTag === "select") {
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && this.selectedItem) {
      event.preventDefault();
      this.deleteSelectedItem();
      return;
    }
    if (event.key === "Escape") {
      this.selectedItem = null;
      this.renderBoard();
    }
  }

  private handleAddLabel(): void {
    const existingCount = this.boardState.labels.length;
    const newLabel = createStudioCaptionBoardLabel({
      text: existingCount === 0 ? "New caption" : `Caption ${existingCount + 1}`,
      x: clamp(0.5 - LABEL_DEFAULT_WIDTH / 2 + existingCount * 0.02, 0, 1 - LABEL_DEFAULT_WIDTH),
      y: clamp(0.5 - LABEL_DEFAULT_HEIGHT / 2 + existingCount * 0.02, 0, 1 - LABEL_DEFAULT_HEIGHT),
      width: LABEL_DEFAULT_WIDTH,
      height: LABEL_DEFAULT_HEIGHT,
      zIndex: this.boardState.labels.length,
    });
    this.selectedItem = { kind: "label", id: newLabel.id };
    this.commitDraftMutation({
      ...this.boardState,
      labels: [...this.boardState.labels, newLabel],
    });
  }

  private handleAddAnnotation(kind: StudioCaptionBoardAnnotationKind): void {
    const existingCount = this.boardState.annotations.length;
    const annotation = createStudioCaptionBoardAnnotation({
      kind,
      x: clamp(0.5 - ANNOTATION_DEFAULT_WIDTH / 2 + existingCount * 0.02, 0, 1 - ANNOTATION_DEFAULT_WIDTH),
      y: clamp(0.5 - ANNOTATION_DEFAULT_HEIGHT / 2 + existingCount * 0.02, 0, 1 - ANNOTATION_DEFAULT_HEIGHT),
      width: ANNOTATION_DEFAULT_WIDTH,
      height: ANNOTATION_DEFAULT_HEIGHT,
      color: DEFAULT_HIGHLIGHT_COLOR,
      strokeWidth: DEFAULT_STROKE_WIDTH,
      blurRadius: DEFAULT_BLUR_RADIUS,
      zIndex: this.boardState.annotations.length,
    });
    this.selectedItem = { kind: "annotation", id: annotation.id };
    this.commitDraftMutation({
      ...this.boardState,
      annotations: [...this.boardState.annotations, annotation],
    });
  }

  private handleEnsureCrop(): void {
    if (this.boardState.crop) {
      this.selectedItem = { kind: "crop" };
      this.renderBoard();
      return;
    }
    this.selectedItem = { kind: "crop" };
    this.commitDraftMutation({
      ...this.boardState,
      crop: createStudioCaptionBoardCrop({
        x: clamp(0.5 - DEFAULT_CROP_WIDTH / 2, 0, 1 - DEFAULT_CROP_WIDTH),
        y: clamp(0.5 - DEFAULT_CROP_HEIGHT / 2, 0, 1 - DEFAULT_CROP_HEIGHT),
        width: DEFAULT_CROP_WIDTH,
        height: DEFAULT_CROP_HEIGHT,
      }),
    });
  }

  private clearCrop(): void {
    this.selectedItem = null;
    this.commitDraftMutation({
      ...this.boardState,
      crop: null,
    });
  }

  private patchSelectionFrame(selection: BoardSelection, patch: Partial<StudioCaptionBoardCrop>): void {
    if (selection.kind === "label") {
      this.patchLabelById(selection.id, patch);
      return;
    }
    if (selection.kind === "annotation") {
      this.patchAnnotationById(selection.id, patch);
      return;
    }
    this.patchCrop(patch);
  }

  private patchSelectedLabel(patch: Partial<StudioCaptionBoardLabel>): void {
    if (this.selectedItem?.kind !== "label") {
      return;
    }
    this.patchLabelById(this.selectedItem.id, patch);
  }

  private patchLabelById(labelId: string, patch: Partial<StudioCaptionBoardLabel | StudioCaptionBoardCrop>): void {
    const labels = this.boardState.labels.map((label) => {
      if (label.id !== labelId) {
        return label;
      }
      const nextWidth = Number.isFinite(Number(patch.width)) ? clamp(Number(patch.width), LABEL_MIN_WIDTH, 1 - label.x) : label.width;
      const nextHeight = Number.isFinite(Number(patch.height)) ? clamp(Number(patch.height), LABEL_MIN_HEIGHT, 1 - label.y) : label.height;
      const nextX = Number.isFinite(Number(patch.x)) ? clamp(Number(patch.x), 0, 1 - nextWidth) : label.x;
      const nextY = Number.isFinite(Number(patch.y)) ? clamp(Number(patch.y), 0, 1 - nextHeight) : label.y;
      const nextFontSizeRaw = Number((patch as Partial<StudioCaptionBoardLabel>).fontSize);
      const nextFontSize = Number.isFinite(nextFontSizeRaw) ? clamp(nextFontSizeRaw, 18, 160) : label.fontSize;
      return {
        ...label,
        ...(patch as Partial<StudioCaptionBoardLabel>),
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
        fontSize: nextFontSize,
      };
    });
    this.commitDraftMutation({
      ...this.boardState,
      labels,
    });
  }

  private patchSelectedAnnotation(patch: Partial<StudioCaptionBoardAnnotation>): void {
    if (this.selectedItem?.kind !== "annotation") {
      return;
    }
    this.patchAnnotationById(this.selectedItem.id, patch);
  }

  private patchAnnotationById(annotationId: string, patch: Partial<StudioCaptionBoardAnnotation | StudioCaptionBoardCrop>): void {
    const annotations = this.boardState.annotations.map((annotation) => {
      if (annotation.id !== annotationId) {
        return annotation;
      }
      const nextWidth = Number.isFinite(Number(patch.width)) ? clamp(Number(patch.width), ANNOTATION_MIN_WIDTH, 1 - annotation.x) : annotation.width;
      const nextHeight = Number.isFinite(Number(patch.height)) ? clamp(Number(patch.height), ANNOTATION_MIN_HEIGHT, 1 - annotation.y) : annotation.height;
      const nextX = Number.isFinite(Number(patch.x)) ? clamp(Number(patch.x), 0, 1 - nextWidth) : annotation.x;
      const nextY = Number.isFinite(Number(patch.y)) ? clamp(Number(patch.y), 0, 1 - nextHeight) : annotation.y;
      const nextStrokeWidthRaw = Number((patch as Partial<StudioCaptionBoardAnnotation>).strokeWidth);
      const nextBlurRadiusRaw = Number((patch as Partial<StudioCaptionBoardAnnotation>).blurRadius);
      return {
        ...annotation,
        ...(patch as Partial<StudioCaptionBoardAnnotation>),
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
        color: readString((patch as Partial<StudioCaptionBoardAnnotation>).color).trim() || annotation.color,
        strokeWidth: Number.isFinite(nextStrokeWidthRaw) ? clamp(nextStrokeWidthRaw, 2, 24) : annotation.strokeWidth,
        blurRadius: Number.isFinite(nextBlurRadiusRaw) ? clamp(nextBlurRadiusRaw, 4, 48) : annotation.blurRadius,
      };
    });
    this.commitDraftMutation({
      ...this.boardState,
      annotations,
    });
  }

  private patchCrop(patch: Partial<StudioCaptionBoardCrop>): void {
    const current = this.boardState.crop;
    if (!current) {
      return;
    }
    const nextWidth = Number.isFinite(Number(patch.width)) ? clamp(Number(patch.width), CROP_MIN_WIDTH, 1 - current.x) : current.width;
    const nextHeight = Number.isFinite(Number(patch.height)) ? clamp(Number(patch.height), CROP_MIN_HEIGHT, 1 - current.y) : current.height;
    const nextX = Number.isFinite(Number(patch.x)) ? clamp(Number(patch.x), 0, 1 - nextWidth) : current.x;
    const nextY = Number.isFinite(Number(patch.y)) ? clamp(Number(patch.y), 0, 1 - nextHeight) : current.y;
    this.commitDraftMutation({
      ...this.boardState,
      crop: {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
      },
    });
  }

  private duplicateSelectedItem(): void {
    const selectedLabel = resolveSelectedLabel(this.boardState, this.selectedItem);
    if (selectedLabel) {
      const duplicate = createStudioCaptionBoardLabel({
        ...selectedLabel,
        id: "",
        x: clamp(selectedLabel.x + 0.03, 0, 1 - selectedLabel.width),
        y: clamp(selectedLabel.y + 0.03, 0, 1 - selectedLabel.height),
        zIndex: this.boardState.labels.length,
      });
      this.selectedItem = { kind: "label", id: duplicate.id };
      this.commitDraftMutation({
        ...this.boardState,
        labels: [...this.boardState.labels, duplicate],
      });
      return;
    }

    const selectedAnnotation = resolveSelectedAnnotation(this.boardState, this.selectedItem);
    if (!selectedAnnotation) {
      return;
    }
    const duplicate = createStudioCaptionBoardAnnotation({
      ...selectedAnnotation,
      id: "",
      x: clamp(selectedAnnotation.x + 0.03, 0, 1 - selectedAnnotation.width),
      y: clamp(selectedAnnotation.y + 0.03, 0, 1 - selectedAnnotation.height),
      zIndex: this.boardState.annotations.length,
    });
    this.selectedItem = { kind: "annotation", id: duplicate.id };
    this.commitDraftMutation({
      ...this.boardState,
      annotations: [...this.boardState.annotations, duplicate],
    });
  }

  private deleteSelectedItem(): void {
    if (!this.selectedItem) {
      return;
    }
    if (this.selectedItem.kind === "label") {
      const selectedId = this.selectedItem.id;
      this.commitDraftMutation({
        ...this.boardState,
        labels: this.boardState.labels.filter((label) => label.id !== selectedId),
      });
      return;
    }
    if (this.selectedItem.kind === "annotation") {
      const selectedId = this.selectedItem.id;
      this.commitDraftMutation({
        ...this.boardState,
        annotations: this.boardState.annotations.filter((annotation) => annotation.id !== selectedId),
      });
      return;
    }
    this.clearCrop();
  }

  private bumpSelectedItem(direction: -1 | 1): void {
    const selectedLabel = resolveSelectedLabel(this.boardState, this.selectedItem);
    if (selectedLabel) {
      const labels = sortBoardLabels(this.boardState.labels);
      const currentIndex = labels.findIndex((label) => label.id === selectedLabel.id);
      if (currentIndex < 0) {
        return;
      }
      const nextIndex = clamp(currentIndex + direction, 0, labels.length - 1);
      if (nextIndex === currentIndex) {
        return;
      }
      const [moved] = labels.splice(currentIndex, 1);
      labels.splice(nextIndex, 0, moved);
      this.commitDraftMutation({
        ...this.boardState,
        labels,
      });
      return;
    }

    const selectedAnnotation = resolveSelectedAnnotation(this.boardState, this.selectedItem);
    if (!selectedAnnotation) {
      return;
    }
    const annotations = sortBoardAnnotations(this.boardState.annotations);
    const currentIndex = annotations.findIndex((annotation) => annotation.id === selectedAnnotation.id);
    if (currentIndex < 0) {
      return;
    }
    const nextIndex = clamp(currentIndex + direction, 0, annotations.length - 1);
    if (nextIndex === currentIndex) {
      return;
    }
    const [moved] = annotations.splice(currentIndex, 1);
    annotations.splice(nextIndex, 0, moved);
    this.commitDraftMutation({
      ...this.boardState,
      annotations,
    });
  }

  private commitDraftMutation(nextState: StudioCaptionBoardState): void {
    writeStudioCaptionBoardState(this.options.node, {
      ...nextState,
      lastRenderedAsset: null,
      sourceAssetPath: "",
      updatedAt: new Date().toISOString(),
    });
    this.boardState = readStudioCaptionBoardState(this.options.node.config);
    this.selectedItem = normalizeSelection(this.boardState, this.selectedItem);
    this.options.onNodeConfigMutated(this.options.node);
    this.renderBoard();
    void this.refreshRenderedPreview();
  }

  private async handleDone(): Promise<void> {
    if (this.isDoneSaving) {
      return;
    }
    this.isDoneSaving = true;
    this.syncActionState();
    try {
      let nextState = readStudioCaptionBoardState(this.options.node.config);
      if (this.baseImageAsset && boardStateHasRenderableEdits(nextState)) {
        const renderedAsset = await composeStudioCaptionBoardImage({
          baseImage: this.baseImageAsset,
          boardState: nextState,
          readAsset: this.options.readAsset,
          storeAsset: this.options.storeAsset,
        });
        nextState = {
          ...nextState,
          sourceAssetPath: this.baseImageAsset.path,
          lastRenderedAsset: renderedAsset,
          updatedAt: new Date().toISOString(),
        };
      }
      writeStudioCaptionBoardState(this.options.node, nextState);
      this.boardState = readStudioCaptionBoardState(this.options.node.config);
      this.selectedItem = normalizeSelection(this.boardState, this.selectedItem);
      this.options.onNodeConfigMutated(this.options.node);
      this.options.onRenderedAssetCommitted?.(this.options.node);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Image editor save failed: ${message}`);
    } finally {
      this.isDoneSaving = false;
      this.syncActionState();
    }
  }
}

export function openStudioImageEditorModal(options: StudioCaptionBoardModalOptions): void {
  const modal = new StudioCaptionBoardModal(options);
  modal.open();
}
