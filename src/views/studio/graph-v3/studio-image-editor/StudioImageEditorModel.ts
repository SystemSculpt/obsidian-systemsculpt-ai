import {
  createStudioCaptionBoardAnnotation,
  createStudioCaptionBoardCrop,
  createStudioCaptionBoardLabel,
  readStudioCaptionBoardState,
  type StudioCaptionBoardAnnotation,
  type StudioCaptionBoardAnnotationKind,
  type StudioCaptionBoardCrop,
  type StudioCaptionBoardLabel,
  type StudioCaptionBoardState,
  writeStudioCaptionBoardState,
} from "../../../../studio/StudioCaptionBoardState";
import type { StudioJsonValue, StudioNodeInstance } from "../../../../studio/types";
import type { StudioGraphNodeMutationOptions } from "../StudioGraphNodeCardTypes";
import {
  ANNOTATION_MIN_HEIGHT,
  ANNOTATION_MIN_WIDTH,
  clamp,
  CROP_MIN_HEIGHT,
  CROP_MIN_WIDTH,
  LABEL_MIN_HEIGHT,
  LABEL_MIN_WIDTH,
  normalizeSelection,
  resolveSelectedAnnotation,
  resolveSelectedLabel,
  sortBoardAnnotations,
  sortBoardLabels,
  type StudioImageEditorFrame,
  type StudioImageEditorModalOptions,
  type StudioImageEditorSelection,
} from "./StudioImageEditorTypes";

const CONFIG_KEY = "captionBoard";
const LABEL_WIDTH = 0.44;
const LABEL_HEIGHT = 0.18;
const ANNOTATION_WIDTH = 0.26;
const ANNOTATION_HEIGHT = 0.18;
const CROP_WIDTH = 0.82;
const CROP_HEIGHT = 0.82;

type StudioImageEditorModelChange = {
  previewInvalidated: boolean;
};

export class StudioImageEditorModel {
  private boardState: StudioCaptionBoardState;
  private selectedItem: StudioImageEditorSelection | null;

  constructor(
    private readonly options: Pick<
      StudioImageEditorModalOptions,
      "node" | "onNodeConfigMutated" | "onNodeConfigValueChange"
    >,
    private readonly onChange: (change: StudioImageEditorModelChange) => void
  ) {
    this.boardState = readStudioCaptionBoardState(options.node.config);
    this.selectedItem = normalizeSelection(this.boardState, null);
  }

  get state(): StudioCaptionBoardState {
    return this.boardState;
  }

  get selection(): StudioImageEditorSelection | null {
    return this.selectedItem;
  }

  get selectedLabel(): StudioCaptionBoardLabel | null {
    return resolveSelectedLabel(this.boardState, this.selectedItem);
  }

  get selectedAnnotation(): StudioCaptionBoardAnnotation | null {
    return resolveSelectedAnnotation(this.boardState, this.selectedItem);
  }

  select(selection: StudioImageEditorSelection | null): void {
    this.selectedItem = selection;
    this.onChange({ previewInvalidated: false });
  }

  selectionFrame(selection: StudioImageEditorSelection | null): StudioImageEditorFrame | null {
    if (!selection) {
      return null;
    }
    if (selection.kind === "label") {
      const label = resolveSelectedLabel(this.boardState, selection);
      return label ? pickFrame(label) : null;
    }
    if (selection.kind === "annotation") {
      const annotation = resolveSelectedAnnotation(this.boardState, selection);
      return annotation ? pickFrame(annotation) : null;
    }
    return this.boardState.crop ? pickFrame(this.boardState.crop) : null;
  }

  addLabel(): void {
    const count = this.boardState.labels.length;
    const label = createStudioCaptionBoardLabel({
      text: count === 0 ? "New caption" : `Caption ${count + 1}`,
      x: clamp(0.5 - LABEL_WIDTH / 2 + count * 0.02, 0, 1 - LABEL_WIDTH),
      y: clamp(0.5 - LABEL_HEIGHT / 2 + count * 0.02, 0, 1 - LABEL_HEIGHT),
      width: LABEL_WIDTH,
      height: LABEL_HEIGHT,
      zIndex: count,
    });
    this.selectedItem = { kind: "label", id: label.id };
    this.commitDraft({ ...this.boardState, labels: [...this.boardState.labels, label] });
  }

  addAnnotation(kind: StudioCaptionBoardAnnotationKind): void {
    const count = this.boardState.annotations.length;
    const annotation = createStudioCaptionBoardAnnotation({
      kind,
      x: clamp(0.5 - ANNOTATION_WIDTH / 2 + count * 0.02, 0, 1 - ANNOTATION_WIDTH),
      y: clamp(0.5 - ANNOTATION_HEIGHT / 2 + count * 0.02, 0, 1 - ANNOTATION_HEIGHT),
      width: ANNOTATION_WIDTH,
      height: ANNOTATION_HEIGHT,
      color: "#ff4d4f",
      strokeWidth: 8,
      blurRadius: 16,
      zIndex: count,
    });
    this.selectedItem = { kind: "annotation", id: annotation.id };
    this.commitDraft({
      ...this.boardState,
      annotations: [...this.boardState.annotations, annotation],
    });
  }

  ensureCrop(): void {
    if (this.boardState.crop) {
      this.select({ kind: "crop" });
      return;
    }
    this.selectedItem = { kind: "crop" };
    this.commitDraft({
      ...this.boardState,
      crop: createStudioCaptionBoardCrop({
        x: (1 - CROP_WIDTH) / 2,
        y: (1 - CROP_HEIGHT) / 2,
        width: CROP_WIDTH,
        height: CROP_HEIGHT,
      }),
    });
  }

  clearCrop(): void {
    this.selectedItem = null;
    this.commitDraft({ ...this.boardState, crop: null });
  }

  patchSelectionFrame(
    selection: StudioImageEditorSelection,
    patch: Partial<StudioCaptionBoardCrop>,
    mutationOptions?: StudioGraphNodeMutationOptions
  ): void {
    if (selection.kind === "label") {
      this.patchLabel(selection.id, patch, mutationOptions);
    } else if (selection.kind === "annotation") {
      this.patchAnnotation(selection.id, patch, mutationOptions);
    } else {
      this.patchCrop(patch, mutationOptions);
    }
  }

  patchSelectedLabel(patch: Partial<StudioCaptionBoardLabel>): void {
    if (this.selectedItem?.kind === "label") {
      this.patchLabel(this.selectedItem.id, patch);
    }
  }

  patchSelectedAnnotation(patch: Partial<StudioCaptionBoardAnnotation>): void {
    if (this.selectedItem?.kind === "annotation") {
      this.patchAnnotation(this.selectedItem.id, patch);
    }
  }

  patchCrop(
    patch: Partial<StudioCaptionBoardCrop>,
    mutationOptions?: StudioGraphNodeMutationOptions
  ): void {
    const current = this.boardState.crop;
    if (!current) {
      return;
    }
    this.commitDraft(
      {
        ...this.boardState,
        crop: patchFrame(current, patch, CROP_MIN_WIDTH, CROP_MIN_HEIGHT),
      },
      mutationOptions
    );
  }

  duplicateSelected(): void {
    const label = this.selectedLabel;
    if (label) {
      const duplicate = createStudioCaptionBoardLabel({
        ...label,
        id: "",
        x: clamp(label.x + 0.03, 0, 1 - label.width),
        y: clamp(label.y + 0.03, 0, 1 - label.height),
        zIndex: this.boardState.labels.length,
      });
      this.selectedItem = { kind: "label", id: duplicate.id };
      this.commitDraft({
        ...this.boardState,
        labels: [...this.boardState.labels, duplicate],
      });
      return;
    }
    const annotation = this.selectedAnnotation;
    if (!annotation) {
      return;
    }
    const duplicate = createStudioCaptionBoardAnnotation({
      ...annotation,
      id: "",
      x: clamp(annotation.x + 0.03, 0, 1 - annotation.width),
      y: clamp(annotation.y + 0.03, 0, 1 - annotation.height),
      zIndex: this.boardState.annotations.length,
    });
    this.selectedItem = { kind: "annotation", id: duplicate.id };
    this.commitDraft({
      ...this.boardState,
      annotations: [...this.boardState.annotations, duplicate],
    });
  }

  deleteSelected(): void {
    const selection = this.selectedItem;
    if (!selection) {
      return;
    }
    if (selection.kind === "label") {
      this.commitDraft({
        ...this.boardState,
        labels: this.boardState.labels.filter(({ id }) => id !== selection.id),
      });
    } else if (selection.kind === "annotation") {
      this.commitDraft({
        ...this.boardState,
        annotations: this.boardState.annotations.filter(({ id }) => id !== selection.id),
      });
    } else {
      this.clearCrop();
    }
  }

  bumpSelected(direction: -1 | 1): void {
    if (this.selectedLabel) {
      const labels = reorderById(sortBoardLabels(this.boardState.labels), this.selectedLabel.id, direction);
      if (labels) {
        this.commitDraft({ ...this.boardState, labels });
      }
      return;
    }
    if (this.selectedAnnotation) {
      const annotations = reorderById(
        sortBoardAnnotations(this.boardState.annotations),
        this.selectedAnnotation.id,
        direction
      );
      if (annotations) {
        this.commitDraft({ ...this.boardState, annotations });
      }
    }
  }

  commitSavedState(state: StudioCaptionBoardState): void {
    this.commit(state, { mode: "discrete" });
  }

  private patchLabel(
    id: string,
    patch: Partial<StudioCaptionBoardLabel | StudioCaptionBoardCrop>,
    mutationOptions?: StudioGraphNodeMutationOptions
  ): void {
    const labels = this.boardState.labels.map((label) => {
      if (label.id !== id) {
        return label;
      }
      const frame = patchFrame(label, patch, LABEL_MIN_WIDTH, LABEL_MIN_HEIGHT);
      const fontSize = Number((patch as Partial<StudioCaptionBoardLabel>).fontSize);
      return {
        ...label,
        ...(patch as Partial<StudioCaptionBoardLabel>),
        ...frame,
        fontSize: Number.isFinite(fontSize) ? clamp(fontSize, 18, 160) : label.fontSize,
      };
    });
    this.commitDraft({ ...this.boardState, labels }, mutationOptions);
  }

  private patchAnnotation(
    id: string,
    patch: Partial<StudioCaptionBoardAnnotation | StudioCaptionBoardCrop>,
    mutationOptions?: StudioGraphNodeMutationOptions
  ): void {
    const annotations = this.boardState.annotations.map((annotation) => {
      if (annotation.id !== id) {
        return annotation;
      }
      const typedPatch = patch as Partial<StudioCaptionBoardAnnotation>;
      const strokeWidth = Number(typedPatch.strokeWidth);
      const blurRadius = Number(typedPatch.blurRadius);
      return {
        ...annotation,
        ...typedPatch,
        ...patchFrame(annotation, patch, ANNOTATION_MIN_WIDTH, ANNOTATION_MIN_HEIGHT),
        color: String(typedPatch.color || "").trim() || annotation.color,
        strokeWidth: Number.isFinite(strokeWidth)
          ? clamp(strokeWidth, 2, 24)
          : annotation.strokeWidth,
        blurRadius: Number.isFinite(blurRadius)
          ? clamp(blurRadius, 4, 48)
          : annotation.blurRadius,
      };
    });
    this.commitDraft({ ...this.boardState, annotations }, mutationOptions);
  }

  private commitDraft(
    state: StudioCaptionBoardState,
    mutationOptions: StudioGraphNodeMutationOptions = { mode: "continuous" }
  ): void {
    this.commit(
      {
        ...state,
        lastRenderedAsset: null,
        sourceAssetPath: "",
        updatedAt: new Date().toISOString(),
      },
      mutationOptions
    );
    this.onChange({ previewInvalidated: true });
  }

  private commit(
    state: StudioCaptionBoardState,
    mutationOptions?: StudioGraphNodeMutationOptions
  ): void {
    const draftNode: StudioNodeInstance = {
      ...this.options.node,
      config: { ...this.options.node.config },
    };
    writeStudioCaptionBoardState(draftNode, state);
    const normalizedState = readStudioCaptionBoardState(draftNode.config);
    if (this.options.onNodeConfigValueChange) {
      this.options.onNodeConfigValueChange(
        this.options.node.id,
        CONFIG_KEY,
        (draftNode.config[CONFIG_KEY] ?? null) as StudioJsonValue,
        mutationOptions
      );
    } else {
      writeStudioCaptionBoardState(this.options.node, normalizedState);
      this.options.onNodeConfigMutated(this.options.node);
    }
    this.boardState = normalizedState;
    this.selectedItem = normalizeSelection(this.boardState, this.selectedItem);
  }
}

function pickFrame(frame: StudioImageEditorFrame): StudioImageEditorFrame {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

function patchFrame(
  current: StudioImageEditorFrame,
  patch: Partial<StudioImageEditorFrame>,
  minWidth: number,
  minHeight: number
): StudioImageEditorFrame {
  const width = Number.isFinite(Number(patch.width))
    ? clamp(Number(patch.width), minWidth, 1 - current.x)
    : current.width;
  const height = Number.isFinite(Number(patch.height))
    ? clamp(Number(patch.height), minHeight, 1 - current.y)
    : current.height;
  return {
    x: Number.isFinite(Number(patch.x)) ? clamp(Number(patch.x), 0, 1 - width) : current.x,
    y: Number.isFinite(Number(patch.y)) ? clamp(Number(patch.y), 0, 1 - height) : current.y,
    width,
    height,
  };
}

function reorderById<T extends { id: string; zIndex: number }>(
  items: T[],
  id: string,
  direction: -1 | 1
): T[] | null {
  const index = items.findIndex((item) => item.id === id);
  const nextIndex = clamp(index + direction, 0, items.length - 1);
  if (index < 0 || nextIndex === index) {
    return null;
  }
  const [moved] = items.splice(index, 1);
  items.splice(nextIndex, 0, moved);
  return items.map((item, zIndex) => ({ ...item, zIndex }));
}
