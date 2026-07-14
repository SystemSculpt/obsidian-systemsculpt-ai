import type { App } from "obsidian";
import type {
  StudioCaptionBoardAnnotation,
  StudioCaptionBoardAnnotationKind,
  StudioCaptionBoardLabel,
  StudioCaptionBoardState,
} from "../../../../studio/StudioCaptionBoardState";
import type {
  StudioAssetRef,
  StudioJsonValue,
  StudioNodeInstance,
} from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import type { StudioGraphNodeMutationOptions } from "../StudioGraphNodeCardTypes";

export type StudioImageEditorSelection =
  | { kind: "label"; id: string }
  | { kind: "annotation"; id: string }
  | { kind: "crop" };

export type StudioImageEditorFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StudioImageEditorSurfaceLayout = {
  surfaceWidth: number;
  surfaceHeight: number;
  stageLeft: number;
  stageTop: number;
  stageWidth: number;
  stageHeight: number;
};

export type StudioImageEditorModalOptions = {
  app: App;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  projectPath: string;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
  storeAsset: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onRenderedAssetCommitted?: (node: StudioNodeInstance) => void;
};

export const LABEL_MIN_WIDTH = 0.12;
export const LABEL_MIN_HEIGHT = 0.08;
export const ANNOTATION_MIN_WIDTH = 0.08;
export const ANNOTATION_MIN_HEIGHT = 0.08;
export const CROP_MIN_WIDTH = 0.12;
export const CROP_MIN_HEIGHT = 0.12;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export function selectionEquals(
  a: StudioImageEditorSelection | null,
  b: StudioImageEditorSelection | null
): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  return a.kind === b.kind &&
    (a.kind === "crop" || b.kind === "crop" ? true : a.id === b.id);
}

export function annotationLabel(kind: StudioCaptionBoardAnnotationKind): string {
  if (kind === "highlight_circle") {
    return "Red Circle";
  }
  if (kind === "blur_rect") {
    return "Blur Box";
  }
  return "Red Rectangle";
}

export function sortBoardLabels(
  labels: StudioCaptionBoardLabel[]
): StudioCaptionBoardLabel[] {
  return labels
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
}

export function sortBoardAnnotations(
  annotations: StudioCaptionBoardAnnotation[]
): StudioCaptionBoardAnnotation[] {
  return annotations
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
}

export function resolveSelectedLabel(
  state: StudioCaptionBoardState,
  selection: StudioImageEditorSelection | null
): StudioCaptionBoardLabel | null {
  if (selection?.kind !== "label") {
    return null;
  }
  return state.labels.find((label) => label.id === selection.id) || null;
}

export function resolveSelectedAnnotation(
  state: StudioCaptionBoardState,
  selection: StudioImageEditorSelection | null
): StudioCaptionBoardAnnotation | null {
  if (selection?.kind !== "annotation") {
    return null;
  }
  return state.annotations.find((annotation) => annotation.id === selection.id) || null;
}

export function normalizeSelection(
  state: StudioCaptionBoardState,
  selection: StudioImageEditorSelection | null
): StudioImageEditorSelection | null {
  if (selection?.kind === "label" && state.labels.some(({ id }) => id === selection.id)) {
    return selection;
  }
  if (
    selection?.kind === "annotation" &&
    state.annotations.some(({ id }) => id === selection.id)
  ) {
    return selection;
  }
  if (selection?.kind === "crop" && state.crop) {
    return selection;
  }
  const label = state.labels[0];
  if (label) {
    return { kind: "label", id: label.id };
  }
  const annotation = state.annotations[0];
  if (annotation) {
    return { kind: "annotation", id: annotation.id };
  }
  return state.crop ? { kind: "crop" } : null;
}
