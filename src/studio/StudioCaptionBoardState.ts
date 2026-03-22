import type { StudioAssetRef, StudioJsonValue, StudioNodeInstance } from "./types";
import { randomId } from "./utils";

export type StudioCaptionBoardTextAlign = "left" | "center" | "right";
export type StudioCaptionBoardStyleVariant = "shadow" | "outline" | "banner";
export type StudioCaptionBoardAnnotationKind = "highlight_rect" | "highlight_circle" | "blur_rect";

export type StudioCaptionBoardLabel = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  textAlign: StudioCaptionBoardTextAlign;
  textColor: string;
  styleVariant: StudioCaptionBoardStyleVariant;
  zIndex: number;
};

export type StudioCaptionBoardAnnotation = {
  id: string;
  kind: StudioCaptionBoardAnnotationKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  blurRadius: number;
  zIndex: number;
};

export type StudioCaptionBoardCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StudioCaptionBoardState = {
  version: 1;
  labels: StudioCaptionBoardLabel[];
  annotations: StudioCaptionBoardAnnotation[];
  crop: StudioCaptionBoardCrop | null;
  sourceAssetPath: string;
  lastRenderedAsset: StudioAssetRef | null;
  updatedAt: string;
};

const LEGACY_KEYS = {
  text: "captionText",
  normalizedX: "captionNormalizedX",
  normalizedY: "captionNormalizedY",
  fontSize: "captionFontSize",
  alignment: "captionAlignment",
  textColor: "captionTextColor",
  styleVariant: "captionStyleVariant",
} as const;

const BOARD_CONFIG_KEY = "captionBoard";
const BOARD_VERSION = 1 as const;
const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const DEFAULT_LABEL_WIDTH = 0.44;
const DEFAULT_LABEL_HEIGHT = 0.18;
const DEFAULT_FONT_SIZE = 56;
const DEFAULT_TEXT_COLOR = "#ffffff";
const DEFAULT_ANNOTATION_WIDTH = 0.26;
const DEFAULT_ANNOTATION_HEIGHT = 0.18;
const DEFAULT_ANNOTATION_COLOR = "#ff4d4f";
const DEFAULT_STROKE_WIDTH = 8;
const DEFAULT_BLUR_RADIUS = 16;
const DEFAULT_CROP_WIDTH = 0.82;
const DEFAULT_CROP_HEIGHT = 0.82;
const MIN_RECT_WIDTH = 0.08;
const MIN_RECT_HEIGHT = 0.08;
const MIN_CROP_WIDTH = 0.12;
const MIN_CROP_HEIGHT = 0.12;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTextAlign(value: unknown): StudioCaptionBoardTextAlign {
  const candidate = readString(value).trim().toLowerCase();
  if (candidate === "left" || candidate === "right") {
    return candidate;
  }
  return "center";
}

function normalizeStyleVariant(value: unknown): StudioCaptionBoardStyleVariant {
  const candidate = readString(value).trim().toLowerCase();
  if (candidate === "outline" || candidate === "banner") {
    return candidate;
  }
  return "shadow";
}

function normalizeAnnotationKind(value: unknown): StudioCaptionBoardAnnotationKind {
  const candidate = readString(value).trim().toLowerCase();
  if (candidate === "highlight_circle" || candidate === "blur_rect") {
    return candidate;
  }
  return "highlight_rect";
}

function normalizeColor(value: unknown, fallback: string): string {
  const candidate = readString(value).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(candidate)
    ? candidate
    : fallback;
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

function normalizeFrame(
  value: Record<string, unknown>,
  options: { defaultWidth: number; defaultHeight: number; minWidth: number; minHeight: number }
): { x: number; y: number; width: number; height: number } {
  const width = clamp(Number(value.width), options.minWidth, 1);
  const height = clamp(Number(value.height), options.minHeight, 1);
  const normalizedWidth = Number.isFinite(Number(value.width)) ? width : options.defaultWidth;
  const normalizedHeight = Number.isFinite(Number(value.height)) ? height : options.defaultHeight;
  const finalWidth = clamp(normalizedWidth, options.minWidth, 1);
  const finalHeight = clamp(normalizedHeight, options.minHeight, 1);
  const x = clamp(Number(value.x), 0, 1 - finalWidth);
  const y = clamp(Number(value.y), 0, 1 - finalHeight);
  return { x, y, width: finalWidth, height: finalHeight };
}

function normalizeLabel(value: unknown, fallbackIndex: number): StudioCaptionBoardLabel | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const fontSizeRaw = Number(record.fontSize);
  const frame = normalizeFrame(record, {
    defaultWidth: DEFAULT_LABEL_WIDTH,
    defaultHeight: DEFAULT_LABEL_HEIGHT,
    minWidth: 0.12,
    minHeight: 0.08,
  });
  return {
    id: readString(record.id).trim() || `label-${fallbackIndex + 1}`,
    text: readString(record.text),
    ...frame,
    fontSize: Number.isFinite(fontSizeRaw) ? clamp(fontSizeRaw, 18, 160) : DEFAULT_FONT_SIZE,
    textAlign: normalizeTextAlign(record.textAlign),
    textColor: normalizeColor(record.textColor, DEFAULT_TEXT_COLOR),
    styleVariant: normalizeStyleVariant(record.styleVariant),
    zIndex: Number.isFinite(Number(record.zIndex)) ? Math.max(0, Math.floor(Number(record.zIndex))) : fallbackIndex,
  };
}

function normalizeAnnotation(value: unknown, fallbackIndex: number): StudioCaptionBoardAnnotation | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const frame = normalizeFrame(record, {
    defaultWidth: DEFAULT_ANNOTATION_WIDTH,
    defaultHeight: DEFAULT_ANNOTATION_HEIGHT,
    minWidth: MIN_RECT_WIDTH,
    minHeight: MIN_RECT_HEIGHT,
  });
  const strokeWidthRaw = Number(record.strokeWidth);
  const blurRadiusRaw = Number(record.blurRadius);
  return {
    id: readString(record.id).trim() || `annotation-${fallbackIndex + 1}`,
    kind: normalizeAnnotationKind(record.kind),
    ...frame,
    color: normalizeColor(record.color, DEFAULT_ANNOTATION_COLOR),
    strokeWidth: Number.isFinite(strokeWidthRaw) ? clamp(strokeWidthRaw, 2, 24) : DEFAULT_STROKE_WIDTH,
    blurRadius: Number.isFinite(blurRadiusRaw) ? clamp(blurRadiusRaw, 4, 48) : DEFAULT_BLUR_RADIUS,
    zIndex: Number.isFinite(Number(record.zIndex)) ? Math.max(0, Math.floor(Number(record.zIndex))) : fallbackIndex,
  };
}

function normalizeCrop(value: unknown): StudioCaptionBoardCrop | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return normalizeFrame(record, {
    defaultWidth: DEFAULT_CROP_WIDTH,
    defaultHeight: DEFAULT_CROP_HEIGHT,
    minWidth: MIN_CROP_WIDTH,
    minHeight: MIN_CROP_HEIGHT,
  });
}

function sortLabels(labels: StudioCaptionBoardLabel[]): StudioCaptionBoardLabel[] {
  return labels
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
    .map((label, index) => ({ ...label, zIndex: index }));
}

function sortAnnotations(annotations: StudioCaptionBoardAnnotation[]): StudioCaptionBoardAnnotation[] {
  return annotations
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
    .map((annotation, index) => ({ ...annotation, zIndex: index }));
}

function createLegacyMigratedLabel(config: Record<string, StudioJsonValue>): StudioCaptionBoardLabel | null {
  const text = readString(config[LEGACY_KEYS.text]).trim();
  if (!text) {
    return null;
  }
  const fontSizeRaw = Number(config[LEGACY_KEYS.fontSize]);
  const fontSize = Number.isFinite(fontSizeRaw) ? clamp(fontSizeRaw, 18, 160) : DEFAULT_FONT_SIZE;
  const legacyCenterX = clamp(Number(config[LEGACY_KEYS.normalizedX]), 0, 1);
  const legacyCenterY = clamp(Number(config[LEGACY_KEYS.normalizedY]), 0, 1);
  const x = clamp(legacyCenterX - DEFAULT_LABEL_WIDTH / 2, 0, 1 - DEFAULT_LABEL_WIDTH);
  const y = clamp(legacyCenterY - DEFAULT_LABEL_HEIGHT / 2, 0, 1 - DEFAULT_LABEL_HEIGHT);
  return {
    id: "legacy-caption",
    text,
    x,
    y,
    width: DEFAULT_LABEL_WIDTH,
    height: DEFAULT_LABEL_HEIGHT,
    fontSize,
    textAlign: normalizeTextAlign(config[LEGACY_KEYS.alignment]),
    textColor: normalizeColor(config[LEGACY_KEYS.textColor], DEFAULT_TEXT_COLOR),
    styleVariant: normalizeStyleVariant(config[LEGACY_KEYS.styleVariant]),
    zIndex: 0,
  };
}

export function createStudioCaptionBoardLabel(
  patch: Partial<StudioCaptionBoardLabel> = {}
): StudioCaptionBoardLabel {
  const frame = normalizeFrame(patch as Record<string, unknown>, {
    defaultWidth: DEFAULT_LABEL_WIDTH,
    defaultHeight: DEFAULT_LABEL_HEIGHT,
    minWidth: 0.12,
    minHeight: 0.08,
  });
  const fontSize = Number(patch.fontSize);
  const zIndex = Number(patch.zIndex);
  return {
    id: readString(patch.id).trim() || randomId("caption"),
    text: readString(patch.text),
    ...frame,
    fontSize: Number.isFinite(fontSize) ? clamp(fontSize, 18, 160) : DEFAULT_FONT_SIZE,
    textAlign: normalizeTextAlign(patch.textAlign),
    textColor: normalizeColor(patch.textColor, DEFAULT_TEXT_COLOR),
    styleVariant: normalizeStyleVariant(patch.styleVariant),
    zIndex: Number.isFinite(zIndex) ? Math.max(0, Math.floor(zIndex)) : 0,
  };
}

export function createStudioCaptionBoardAnnotation(
  patch: Partial<StudioCaptionBoardAnnotation> = {}
): StudioCaptionBoardAnnotation {
  const frame = normalizeFrame(patch as Record<string, unknown>, {
    defaultWidth: DEFAULT_ANNOTATION_WIDTH,
    defaultHeight: DEFAULT_ANNOTATION_HEIGHT,
    minWidth: MIN_RECT_WIDTH,
    minHeight: MIN_RECT_HEIGHT,
  });
  const strokeWidth = Number(patch.strokeWidth);
  const blurRadius = Number(patch.blurRadius);
  const zIndex = Number(patch.zIndex);
  return {
    id: readString(patch.id).trim() || randomId("annotation"),
    kind: normalizeAnnotationKind(patch.kind),
    ...frame,
    color: normalizeColor(patch.color, DEFAULT_ANNOTATION_COLOR),
    strokeWidth: Number.isFinite(strokeWidth) ? clamp(strokeWidth, 2, 24) : DEFAULT_STROKE_WIDTH,
    blurRadius: Number.isFinite(blurRadius) ? clamp(blurRadius, 4, 48) : DEFAULT_BLUR_RADIUS,
    zIndex: Number.isFinite(zIndex) ? Math.max(0, Math.floor(zIndex)) : 0,
  };
}

export function createStudioCaptionBoardCrop(
  patch: Partial<StudioCaptionBoardCrop> = {}
): StudioCaptionBoardCrop {
  return normalizeFrame(patch as Record<string, unknown>, {
    defaultWidth: DEFAULT_CROP_WIDTH,
    defaultHeight: DEFAULT_CROP_HEIGHT,
    minWidth: MIN_CROP_WIDTH,
    minHeight: MIN_CROP_HEIGHT,
  });
}

export function createEmptyStudioCaptionBoardState(): StudioCaptionBoardState {
  return {
    version: BOARD_VERSION,
    labels: [],
    annotations: [],
    crop: null,
    sourceAssetPath: "",
    lastRenderedAsset: null,
    updatedAt: DEFAULT_UPDATED_AT,
  };
}

function normalizeBoardState(value: unknown): StudioCaptionBoardState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const labelsRaw = Array.isArray(record.labels) ? record.labels : [];
  const annotationsRaw = Array.isArray(record.annotations) ? record.annotations : [];
  const labels = sortLabels(
    labelsRaw
      .map((entry, index) => normalizeLabel(entry, index))
      .filter((entry): entry is StudioCaptionBoardLabel => Boolean(entry))
  );
  const annotations = sortAnnotations(
    annotationsRaw
      .map((entry, index) => normalizeAnnotation(entry, index))
      .filter((entry): entry is StudioCaptionBoardAnnotation => Boolean(entry))
  );

  return {
    version: BOARD_VERSION,
    labels,
    annotations,
    crop: normalizeCrop(record.crop),
    sourceAssetPath: readString(record.sourceAssetPath).trim(),
    lastRenderedAsset: normalizeAssetRef(record.lastRenderedAsset),
    updatedAt: readString(record.updatedAt).trim() || DEFAULT_UPDATED_AT,
  };
}

export function readStudioCaptionBoardState(
  config: Record<string, StudioJsonValue>
): StudioCaptionBoardState {
  const normalized = normalizeBoardState(config[BOARD_CONFIG_KEY]);
  if (normalized) {
    return normalized;
  }
  const legacyLabel = createLegacyMigratedLabel(config);
  if (!legacyLabel) {
    return createEmptyStudioCaptionBoardState();
  }
  return {
    version: BOARD_VERSION,
    labels: [legacyLabel],
    annotations: [],
    crop: null,
    sourceAssetPath: "",
    lastRenderedAsset: null,
    updatedAt: DEFAULT_UPDATED_AT,
  };
}

function serializeBoardState(state: StudioCaptionBoardState): StudioJsonValue {
  return {
    version: BOARD_VERSION,
    labels: state.labels.map((label) => ({
      id: label.id,
      text: label.text,
      x: label.x,
      y: label.y,
      width: label.width,
      height: label.height,
      fontSize: label.fontSize,
      textAlign: label.textAlign,
      textColor: label.textColor,
      styleVariant: label.styleVariant,
      zIndex: label.zIndex,
    })),
    annotations: state.annotations.map((annotation) => ({
      id: annotation.id,
      kind: annotation.kind,
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: annotation.height,
      color: annotation.color,
      strokeWidth: annotation.strokeWidth,
      blurRadius: annotation.blurRadius,
      zIndex: annotation.zIndex,
    })),
    crop: state.crop
      ? {
          x: state.crop.x,
          y: state.crop.y,
          width: state.crop.width,
          height: state.crop.height,
        }
      : null,
    sourceAssetPath: state.sourceAssetPath,
    lastRenderedAsset: state.lastRenderedAsset
      ? {
          hash: state.lastRenderedAsset.hash,
          path: state.lastRenderedAsset.path,
          mimeType: state.lastRenderedAsset.mimeType,
          sizeBytes: state.lastRenderedAsset.sizeBytes,
        }
      : null,
    updatedAt: state.updatedAt,
  };
}

function clearLegacyCaptionKeys(node: StudioNodeInstance): void {
  delete node.config[LEGACY_KEYS.text];
  delete node.config[LEGACY_KEYS.normalizedX];
  delete node.config[LEGACY_KEYS.normalizedY];
  delete node.config[LEGACY_KEYS.fontSize];
  delete node.config[LEGACY_KEYS.alignment];
  delete node.config[LEGACY_KEYS.textColor];
  delete node.config[LEGACY_KEYS.styleVariant];
}

export function writeStudioCaptionBoardState(
  node: StudioNodeInstance,
  nextState: StudioCaptionBoardState
): StudioNodeInstance {
  node.config[BOARD_CONFIG_KEY] = serializeBoardState({
    version: BOARD_VERSION,
    labels: sortLabels(nextState.labels).map((label) => ({
      ...createStudioCaptionBoardLabel(label),
      zIndex: label.zIndex,
    })),
    annotations: sortAnnotations(nextState.annotations).map((annotation) => ({
      ...createStudioCaptionBoardAnnotation(annotation),
      zIndex: annotation.zIndex,
    })),
    crop: nextState.crop ? createStudioCaptionBoardCrop(nextState.crop) : null,
    sourceAssetPath: readString(nextState.sourceAssetPath).trim(),
    lastRenderedAsset: nextState.lastRenderedAsset,
    updatedAt: readString(nextState.updatedAt).trim() || new Date().toISOString(),
  });
  clearLegacyCaptionKeys(node);
  return node;
}

export function updateStudioCaptionBoardState(
  node: StudioNodeInstance,
  updater: (current: StudioCaptionBoardState) => StudioCaptionBoardState
): StudioNodeInstance {
  const current = readStudioCaptionBoardState(node.config);
  const next = updater(current);
  return writeStudioCaptionBoardState(node, next);
}

export function clearStudioCaptionBoardRenderedAsset(node: StudioNodeInstance): StudioNodeInstance {
  return updateStudioCaptionBoardState(node, (current) => ({
    ...current,
    lastRenderedAsset: null,
    updatedAt: new Date().toISOString(),
  }));
}

export function boardStateHasRenderableLabels(state: StudioCaptionBoardState): boolean {
  return state.labels.some((label) => label.text.trim().length > 0);
}

export function boardStateHasRenderableEdits(state: StudioCaptionBoardState): boolean {
  return boardStateHasRenderableLabels(state) || state.annotations.length > 0 || Boolean(state.crop);
}

export function countStudioCaptionBoardEdits(state: StudioCaptionBoardState): number {
  return state.labels.length + state.annotations.length + (state.crop ? 1 : 0);
}

export function resolveStudioCaptionBoardRenderedAsset(
  config: Record<string, StudioJsonValue>,
  sourcePathHint: string
): StudioAssetRef | null {
  const state = readStudioCaptionBoardState(config);
  if (!state.lastRenderedAsset) {
    return null;
  }
  const hint = readString(sourcePathHint).trim();
  if (hint && state.sourceAssetPath && state.sourceAssetPath !== hint) {
    return null;
  }
  return state.lastRenderedAsset;
}
