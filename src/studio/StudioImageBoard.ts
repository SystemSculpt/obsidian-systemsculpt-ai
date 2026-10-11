import type { StudioAssetRef, StudioJsonValue, StudioNodeInstance } from "./types";
import type { StudioFillTextAlign, StudioFillTextStyle } from "./StudioFillText";
import { randomId } from "./utils";
import {
  boxBounds,
  clampNumber,
  keepFrameWithin,
  normalizeRotation,
  STUDIO_IMAGE_BOARD_UNIT_FRAME,
  type StudioImageBoardBox,
  type StudioImageBoardFrame,
  type StudioImageBoardSize,
} from "./StudioImageBoardGeometry";

/**
 * The image board is the edit state of one Studio image node: an ordered
 * stack of layers over (or instead of) the node's own image, plus an output
 * frame. It is DOM-free; StudioImageBoardRenderer turns it into pixels.
 *
 * Geometry is normalized to the node image, so 0..1 spans it and anything
 * outside hangs off it. Wherever no layer covers the output it is transparent.
 */

/** A caption is fill text; on a picture every style carries its own contrast. */
export type StudioImageBoardTextStyle = Exclude<StudioFillTextStyle, "plain">;
export type StudioImageBoardTextAlign = StudioFillTextAlign;
export type StudioImageBoardShape = "rect" | "ellipse" | "arrow";
export type StudioImageBoardRedactStyle = "blur" | "pixelate" | "solid";
export type StudioImageBoardLensShape = "rect" | "ellipse";

type StudioImageBoardLayerBase = StudioImageBoardBox & { id: string };

/** The node's own image. Deleting it leaves a transparent background. */
export type StudioImageBoardBaseLayer = StudioImageBoardLayerBase & { kind: "base" };

/** An extra image stacked onto the board. */
export type StudioImageBoardImageLayer = StudioImageBoardLayerBase & {
  kind: "image";
  asset: StudioAssetRef;
};

/** Text always fills its box; lines break only where the author broke them. */
export type StudioImageBoardTextLayer = StudioImageBoardLayerBase & {
  kind: "text";
  text: string;
  style: StudioImageBoardTextStyle;
  color: string;
  align: StudioImageBoardTextAlign;
};

export type StudioImageBoardShapeLayer = StudioImageBoardLayerBase & {
  kind: "shape";
  shape: StudioImageBoardShape;
  color: string;
  /** Fraction of the node image's shorter side, so it survives a resolution change. */
  strokeWidth: number;
};

export type StudioImageBoardHighlightLayer = StudioImageBoardLayerBase & {
  kind: "highlight";
  color: string;
};

/** Hides everything beneath it. See StudioImageBoardRedaction for the guarantee. */
export type StudioImageBoardRedactLayer = StudioImageBoardLayerBase & {
  kind: "redact";
  style: StudioImageBoardRedactStyle;
};

/**
 * A magnified piece of the picture. `source` is the area it enlarges, which
 * stays where it was marked; the layer's own box is the enlarged copy, which
 * goes anywhere. The painter joins the two with a beam.
 */
export type StudioImageBoardMagnifyLayer = StudioImageBoardLayerBase & {
  kind: "magnify";
  source: StudioImageBoardFrame;
  shape: StudioImageBoardLensShape;
  color: string;
};

export type StudioImageBoardLayer =
  | StudioImageBoardBaseLayer
  | StudioImageBoardImageLayer
  | StudioImageBoardTextLayer
  | StudioImageBoardShapeLayer
  | StudioImageBoardHighlightLayer
  | StudioImageBoardRedactLayer
  | StudioImageBoardMagnifyLayer;

export type StudioImageBoardLayerKind = StudioImageBoardLayer["kind"];

export type StudioImageBoard = {
  version: 2;
  /** Paint order: first is the bottom. */
  layers: StudioImageBoardLayer[];
  /** Output frame; null means exactly the node image. It may extend past the image. */
  crop: StudioImageBoardFrame | null;
  /** Source the cached render below was made from. */
  sourceAssetPath: string;
  lastRenderedAsset: StudioAssetRef | null;
  updatedAt: string;
};

/**
 * Persisted under the key the first editor used, with the same render-cache
 * field names, so a project opened by an older plugin still shows its baked
 * image.
 */
export const STUDIO_IMAGE_BOARD_CONFIG_KEY = "captionBoard";
export const STUDIO_IMAGE_BOARD_BASE_LAYER_ID = "base";

export const STUDIO_IMAGE_BOARD_DEFAULT_SHAPE_COLOR = "#ff3b30";
export const STUDIO_IMAGE_BOARD_DEFAULT_HIGHLIGHT_COLOR = "#ffe600";
export const STUDIO_IMAGE_BOARD_DEFAULT_TEXT_COLOR = "#ffffff";
export const STUDIO_IMAGE_BOARD_DEFAULT_STROKE_WIDTH = 0.008;
export const STUDIO_IMAGE_BOARD_DEFAULT_LENS_COLOR = "#ffe600";
export const STUDIO_IMAGE_BOARD_DEFAULT_ZOOM = 2;
/** The zooms offered for a lens, gentlest first. */
export const STUDIO_IMAGE_BOARD_ZOOM_STEPS: readonly number[] = [1.5, 2, 3, 4];

const BOARD_VERSION = 2 as const;
const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const MIN_LAYER_SIZE = 0.004;
const MAX_LAYER_SIZE = 16;
const MAX_LAYER_OFFSET = 16;
const MIN_CROP_SIZE = 0.02;
const MAX_CROP_SIZE = 8;
const MAX_CROP_OFFSET = 8;
const MIN_STROKE_WIDTH = 0.001;
const MAX_STROKE_WIDTH = 0.06;
const MAX_LAYERS = 200;
/** Room left between a marked area and the lens that lands beside it, as a share of the lens's shorter side. */
const LENS_GAP = 0.35;
/** Where a new lens may land around its area: nearest first, straight up before anything else. */
const LENS_SIDES: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

const LEGACY_CAPTION_KEYS = {
  text: "captionText",
  normalizedX: "captionNormalizedX",
  normalizedY: "captionNormalizedY",
  fontSize: "captionFontSize",
  alignment: "captionAlignment",
  textColor: "captionTextColor",
  styleVariant: "captionStyleVariant",
} as const;

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

function readChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  const candidate = readString(value).trim().toLowerCase();
  return (choices as readonly string[]).includes(candidate) ? (candidate as T) : fallback;
}

function normalizeColor(value: unknown, fallback: string): string {
  const candidate = readString(value).trim().toLowerCase();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(candidate) ? candidate : fallback;
}

function normalizeAssetRef(value: unknown): StudioAssetRef | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const hash = readString(record.hash).trim();
  const path = readString(record.path).trim();
  const mimeType = readString(record.mimeType || record.mime_type).trim();
  const size = Number(record.sizeBytes ?? record.size_bytes);
  if (!hash || !path || !mimeType || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  return { hash, path, mimeType, sizeBytes: Math.floor(size) };
}

function normalizeBox(
  value: Record<string, unknown>,
  fallback: StudioImageBoardFrame
): StudioImageBoardBox {
  const read = (key: keyof StudioImageBoardFrame): number => {
    const candidate = Number(value[key]);
    return Number.isFinite(candidate) ? candidate : fallback[key];
  };
  return {
    x: clampNumber(read("x"), -MAX_LAYER_OFFSET, MAX_LAYER_OFFSET),
    y: clampNumber(read("y"), -MAX_LAYER_OFFSET, MAX_LAYER_OFFSET),
    width: clampNumber(read("width"), MIN_LAYER_SIZE, MAX_LAYER_SIZE),
    height: clampNumber(read("height"), MIN_LAYER_SIZE, MAX_LAYER_SIZE),
    rotation: normalizeRotation(Number(value.rotation)),
  };
}

function normalizeCrop(value: unknown): StudioImageBoardFrame | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const width = Number(record.width);
  const height = Number(record.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    x: clampNumber(Number(record.x), -MAX_CROP_OFFSET, MAX_CROP_OFFSET),
    y: clampNumber(Number(record.y), -MAX_CROP_OFFSET, MAX_CROP_OFFSET),
    width: clampNumber(width, MIN_CROP_SIZE, MAX_CROP_SIZE),
    height: clampNumber(height, MIN_CROP_SIZE, MAX_CROP_SIZE),
  };
}

const LAYER_DEFAULT_FRAME: Record<StudioImageBoardLayerKind, StudioImageBoardFrame> = {
  base: STUDIO_IMAGE_BOARD_UNIT_FRAME,
  image: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  text: { x: 0.05, y: 0.04, width: 0.9, height: 0.16 },
  shape: { x: 0.35, y: 0.38, width: 0.3, height: 0.24 },
  highlight: { x: 0.3, y: 0.44, width: 0.4, height: 0.12 },
  redact: { x: 0.3, y: 0.42, width: 0.4, height: 0.16 },
  magnify: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
};

function normalizeLayer(value: unknown, fallbackId: string): StudioImageBoardLayer | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const kind = readChoice<StudioImageBoardLayerKind | "">(
    record.kind,
    ["base", "image", "text", "shape", "highlight", "redact", "magnify"],
    ""
  );
  if (!kind) {
    return null;
  }
  const box = normalizeBox(record, LAYER_DEFAULT_FRAME[kind]);
  const id = readString(record.id).trim() || fallbackId;
  switch (kind) {
    case "base":
      return { ...box, id: STUDIO_IMAGE_BOARD_BASE_LAYER_ID, kind };
    case "image": {
      const asset = normalizeAssetRef(record.asset);
      return asset ? { ...box, id, kind, asset } : null;
    }
    case "text":
      return {
        ...box,
        id,
        kind,
        text: readString(record.text).replace(/\r\n?/g, "\n"),
        style: readChoice(record.style, ["meme", "outline", "shadow", "banner"], "meme"),
        color: normalizeColor(record.color, STUDIO_IMAGE_BOARD_DEFAULT_TEXT_COLOR),
        align: readChoice(record.align, ["left", "center", "right"], "center"),
      };
    case "shape": {
      const strokeWidth = Number(record.strokeWidth);
      return {
        ...box,
        id,
        kind,
        shape: readChoice(record.shape, ["rect", "ellipse", "arrow"], "rect"),
        color: normalizeColor(record.color, STUDIO_IMAGE_BOARD_DEFAULT_SHAPE_COLOR),
        strokeWidth: Number.isFinite(strokeWidth)
          ? clampNumber(strokeWidth, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH)
          : STUDIO_IMAGE_BOARD_DEFAULT_STROKE_WIDTH,
      };
    }
    case "highlight":
      return {
        ...box,
        id,
        kind,
        color: normalizeColor(record.color, STUDIO_IMAGE_BOARD_DEFAULT_HIGHLIGHT_COLOR),
      };
    case "redact":
      return {
        ...box,
        id,
        kind,
        style: readChoice(record.style, ["blur", "pixelate", "solid"], "blur"),
      };
    case "magnify": {
      // With no area given, the lens enlarges its own middle.
      const inset = (1 - 1 / STUDIO_IMAGE_BOARD_DEFAULT_ZOOM) / 2;
      const source = normalizeBox(asRecord(record.source) ?? {}, {
        x: box.x + box.width * inset,
        y: box.y + box.height * inset,
        width: box.width / STUDIO_IMAGE_BOARD_DEFAULT_ZOOM,
        height: box.height / STUDIO_IMAGE_BOARD_DEFAULT_ZOOM,
      });
      return {
        ...box,
        id,
        kind,
        source: { x: source.x, y: source.y, width: source.width, height: source.height },
        shape: readChoice(record.shape, ["rect", "ellipse"], "rect"),
        color: normalizeColor(record.color, STUDIO_IMAGE_BOARD_DEFAULT_LENS_COLOR),
      };
    }
  }
}

/** Ids are unique and there is at most one base layer. */
function normalizeLayers(values: unknown[]): StudioImageBoardLayer[] {
  const layers: StudioImageBoardLayer[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.slice(0, MAX_LAYERS).entries()) {
    const layer = normalizeLayer(value, `layer-${index + 1}`);
    if (!layer || seen.has(layer.id)) {
      continue;
    }
    seen.add(layer.id);
    layers.push(layer);
  }
  return layers;
}

export function createStudioImageBoardBaseLayer(): StudioImageBoardBaseLayer {
  return { ...STUDIO_IMAGE_BOARD_UNIT_FRAME, rotation: 0, id: STUDIO_IMAGE_BOARD_BASE_LAYER_ID, kind: "base" };
}

/** Builds one valid layer from a loose description; the id is assigned when absent. */
export function createStudioImageBoardLayer(
  description: { kind: StudioImageBoardLayerKind } & Record<string, unknown>
): StudioImageBoardLayer {
  const layer = normalizeLayer(description, randomId("layer"));
  if (!layer) {
    throw new Error(`Cannot create an image board layer of kind "${description.kind}".`);
  }
  return layer;
}

export function createEmptyStudioImageBoard(): StudioImageBoard {
  return {
    version: BOARD_VERSION,
    layers: [createStudioImageBoardBaseLayer()],
    crop: null,
    sourceAssetPath: "",
    lastRenderedAsset: null,
    updatedAt: DEFAULT_UPDATED_AT,
  };
}

function sortByLegacyZIndex(values: unknown[]): Record<string, unknown>[] {
  return values
    .map((value, index) => ({ record: asRecord(value), index }))
    .filter((entry): entry is { record: Record<string, unknown>; index: number } => entry.record !== null)
    .sort((a, b) => {
      const zA = Number(a.record.zIndex);
      const zB = Number(b.record.zIndex);
      return (Number.isFinite(zA) ? zA : a.index) - (Number.isFinite(zB) ? zB : b.index) || a.index - b.index;
    })
    .map((entry) => entry.record);
}

/**
 * The first editor kept labels and annotations in separate lists and always
 * painted blurs, then outlines, then labels. That order becomes the stack.
 */
function migrateLegacyBoard(record: Record<string, unknown>): StudioImageBoardLayer[] {
  const annotations = sortByLegacyZIndex(Array.isArray(record.annotations) ? record.annotations : []);
  const labels = sortByLegacyZIndex(Array.isArray(record.labels) ? record.labels : []);
  const blurs = annotations.filter((annotation) => readString(annotation.kind) === "blur_rect");
  const outlines = annotations.filter((annotation) => readString(annotation.kind) !== "blur_rect");
  const descriptions: Record<string, unknown>[] = [
    { kind: "base" },
    ...blurs.map((annotation) => ({ ...annotation, kind: "redact", style: "blur", rotation: 0 })),
    ...outlines.map((annotation) => {
      const stroke = Number(annotation.strokeWidth);
      return {
        ...annotation,
        kind: "shape",
        shape: readString(annotation.kind) === "highlight_circle" ? "ellipse" : "rect",
        // Legacy strokes were absolute pixels on a roughly 1000px image.
        strokeWidth: Number.isFinite(stroke) ? stroke / 1000 : STUDIO_IMAGE_BOARD_DEFAULT_STROKE_WIDTH,
        rotation: 0,
      };
    }),
    ...labels.map((label) => ({
      ...label,
      kind: "text",
      style: readChoice(label.styleVariant, ["outline", "shadow", "banner"], "shadow"),
      color: label.textColor,
      align: label.textAlign,
      rotation: 0,
    })),
  ];
  return normalizeLayers(descriptions);
}

function migrateLegacyCaption(config: Record<string, StudioJsonValue>): StudioImageBoardLayer | null {
  const text = readString(config[LEGACY_CAPTION_KEYS.text]).trim();
  if (!text) {
    return null;
  }
  const centerX = clampNumber(Number(config[LEGACY_CAPTION_KEYS.normalizedX]), 0, 1);
  const centerY = clampNumber(Number(config[LEGACY_CAPTION_KEYS.normalizedY]), 0, 1);
  return normalizeLayer(
    {
      kind: "text",
      id: "legacy-caption",
      text,
      x: clampNumber(centerX - 0.22, 0, 0.56),
      y: clampNumber(centerY - 0.09, 0, 0.82),
      width: 0.44,
      height: 0.18,
      style: readChoice(config[LEGACY_CAPTION_KEYS.styleVariant], ["outline", "shadow", "banner"], "shadow"),
      color: config[LEGACY_CAPTION_KEYS.textColor],
      align: config[LEGACY_CAPTION_KEYS.alignment],
    },
    "legacy-caption"
  );
}

export function readStudioImageBoard(config: Record<string, StudioJsonValue>): StudioImageBoard {
  const record = asRecord(config[STUDIO_IMAGE_BOARD_CONFIG_KEY]);
  if (!record) {
    const caption = migrateLegacyCaption(config);
    const board = createEmptyStudioImageBoard();
    return caption ? { ...board, layers: [...board.layers, caption] } : board;
  }
  const current = Number(record.version) === BOARD_VERSION && Array.isArray(record.layers);
  return {
    version: BOARD_VERSION,
    layers: current ? normalizeLayers(record.layers as unknown[]) : migrateLegacyBoard(record),
    crop: normalizeCrop(record.crop),
    sourceAssetPath: readString(record.sourceAssetPath).trim(),
    lastRenderedAsset: normalizeAssetRef(record.lastRenderedAsset),
    updatedAt: readString(record.updatedAt).trim() || DEFAULT_UPDATED_AT,
  };
}

function serializeLayer(layer: StudioImageBoardLayer): StudioJsonValue {
  const box = {
    id: layer.id,
    kind: layer.kind,
    x: layer.x,
    y: layer.y,
    width: layer.width,
    height: layer.height,
    rotation: layer.rotation,
  };
  switch (layer.kind) {
    case "base":
      return box;
    case "image":
      return { ...box, asset: { ...layer.asset } };
    case "text":
      return { ...box, text: layer.text, style: layer.style, color: layer.color, align: layer.align };
    case "shape":
      return { ...box, shape: layer.shape, color: layer.color, strokeWidth: layer.strokeWidth };
    case "highlight":
      return { ...box, color: layer.color };
    case "redact":
      return { ...box, style: layer.style };
    case "magnify":
      return { ...box, source: { ...layer.source }, shape: layer.shape, color: layer.color };
  }
}

/** The persisted form of `board`, re-validated so nothing malformed is ever saved. */
export function serializeStudioImageBoard(board: StudioImageBoard): StudioJsonValue {
  const layers = normalizeLayers(board.layers);
  return {
    version: BOARD_VERSION,
    layers: layers.map(serializeLayer),
    crop: board.crop ? { ...(normalizeCrop(board.crop) ?? STUDIO_IMAGE_BOARD_UNIT_FRAME) } : null,
    sourceAssetPath: readString(board.sourceAssetPath).trim(),
    lastRenderedAsset: board.lastRenderedAsset ? { ...board.lastRenderedAsset } : null,
    updatedAt: readString(board.updatedAt).trim() || new Date().toISOString(),
  };
}

export function writeStudioImageBoard(
  node: StudioNodeInstance,
  board: StudioImageBoard
): StudioNodeInstance {
  node.config[STUDIO_IMAGE_BOARD_CONFIG_KEY] = serializeStudioImageBoard(board);
  for (const key of Object.values(LEGACY_CAPTION_KEYS)) {
    delete node.config[key];
  }
  return node;
}

export function findStudioImageBoardLayer(
  board: StudioImageBoard,
  id: string | null
): StudioImageBoardLayer | null {
  return id ? board.layers.find((layer) => layer.id === id) ?? null : null;
}

export function studioImageBoardHasBase(board: StudioImageBoard): boolean {
  return board.layers.some((layer) => layer.kind === "base");
}

export function studioImageBoardOutputFrame(board: StudioImageBoard): StudioImageBoardFrame {
  return board.crop ? { ...board.crop } : { ...STUDIO_IMAGE_BOARD_UNIT_FRAME };
}

function isPristineBase(layer: StudioImageBoardLayer): boolean {
  return (
    layer.kind === "base" &&
    layer.x === 0 &&
    layer.y === 0 &&
    layer.width === 1 &&
    layer.height === 1 &&
    layer.rotation === 0
  );
}

type StudioImageBoardLens = StudioImageBoardFrame & { source: StudioImageBoardFrame };

/** How many times larger a lens shows its area. */
export function studioImageBoardLensZoom(lens: StudioImageBoardLens): number {
  return Math.max(lens.width / lens.source.width, lens.height / lens.source.height);
}

/**
 * The part of the picture that fills a lens: its area, widened one way when
 * the lens was stretched to another shape, so the picture is never distorted.
 */
export function studioImageBoardLensView(lens: StudioImageBoardLens): StudioImageBoardFrame {
  const zoom = studioImageBoardLensZoom(lens);
  const width = lens.width / zoom;
  const height = lens.height / zoom;
  return {
    x: lens.source.x + (lens.source.width - width) / 2,
    y: lens.source.y + (lens.source.height - height) / 2,
    width,
    height,
  };
}

/**
 * A lens given a new size because its area or its zoom changed. Where the
 * lens lies wholly to one side of its area it keeps its distance from the
 * area and grows away from it, so it never creeps over what it enlarges;
 * otherwise it grows about its own middle.
 */
function refitLens(
  lens: StudioImageBoardLens,
  area: StudioImageBoardFrame,
  width: number,
  height: number
): StudioImageBoardFrame {
  const along = (
    start: number,
    extent: number,
    wasStart: number,
    wasExtent: number,
    areaStart: number,
    areaExtent: number,
    next: number
  ): number => {
    if (start + extent <= wasStart) {
      return areaStart - (wasStart - (start + extent)) - next;
    }
    if (start >= wasStart + wasExtent) {
      return areaStart + areaExtent + (start - (wasStart + wasExtent));
    }
    return start + (extent - next) / 2;
  };
  return {
    x: along(lens.x, lens.width, lens.source.x, lens.source.width, area.x, area.width, width),
    y: along(lens.y, lens.height, lens.source.y, lens.source.height, area.y, area.height, height),
    width,
    height,
  };
}

/** The lens resized to show its area exactly `zoom` times larger. */
export function studioImageBoardLensAtZoom(lens: StudioImageBoardLens, zoom: number): StudioImageBoardFrame {
  return refitLens(lens, lens.source, lens.source.width * zoom, lens.source.height * zoom);
}

/** The lens resized to show `area` as large as it shows its present one, so adjusting what is marked never changes the zoom. */
export function studioImageBoardLensForArea(
  lens: StudioImageBoardLens,
  area: StudioImageBoardFrame
): StudioImageBoardFrame {
  return refitLens(
    lens,
    area,
    lens.width * (area.width / lens.source.width),
    lens.height * (area.height / lens.source.height)
  );
}

/**
 * `next`, a lens that has just changed size, moved back inside `within` if
 * growing pushed it out. A lens that was already hanging off before, as
 * `before`, was put there on purpose and is left where it is.
 */
export function studioImageBoardKeepLensInside(
  before: StudioImageBoardBox,
  next: StudioImageBoardBox,
  within: StudioImageBoardFrame,
  base: StudioImageBoardSize
): StudioImageBoardBox {
  const shift = (box: StudioImageBoardBox): { x: number; y: number } => {
    const bounds = boxBounds(box, base);
    const kept = keepFrameWithin(bounds, within);
    return { x: kept.x - bounds.x, y: kept.y - bounds.y };
  };
  const was = shift(before);
  if (Math.abs(was.x) > 1e-9 || Math.abs(was.y) > 1e-9) {
    return next;
  }
  const move = shift(next);
  return { ...next, x: next.x + move.x, y: next.y + move.y };
}

/**
 * Where the lens for a freshly marked `area` lands: beside the area, never
 * over it, on the nearest side where it fits inside `within`. It is the
 * default zoom, or the gentlest when that leaves it more room.
 */
export function studioImageBoardLensOver(
  area: StudioImageBoardFrame,
  within: StudioImageBoardFrame,
  base: StudioImageBoardSize
): StudioImageBoardFrame {
  // Pixels, so that "nearest" and "gap" mean the same across and down.
  const centerX = (area.x + area.width / 2) * base.width;
  const centerY = (area.y + area.height / 2) * base.height;
  const left = within.x * base.width;
  const top = within.y * base.height;
  const right = left + within.width * base.width;
  const bottom = top + within.height * base.height;
  let best: { x: number; y: number; width: number; height: number; spill: number; reach: number } | null = null;
  for (const zoom of [STUDIO_IMAGE_BOARD_DEFAULT_ZOOM, STUDIO_IMAGE_BOARD_ZOOM_STEPS[0]]) {
    const width = area.width * base.width * zoom;
    const height = area.height * base.height * zoom;
    const gap = Math.min(width, height) * LENS_GAP;
    for (const [sideX, sideY] of LENS_SIDES) {
      const offsetX = sideX * ((area.width * base.width + width) / 2 + gap);
      const offsetY = sideY * ((area.height * base.height + height) / 2 + gap);
      const x = centerX + offsetX - width / 2;
      const y = centerY + offsetY - height / 2;
      const inside =
        Math.max(0, Math.min(x + width, right) - Math.max(x, left)) *
        Math.max(0, Math.min(y + height, bottom) - Math.max(y, top));
      const spill = 1 - inside / (width * height);
      const reach = Math.hypot(offsetX, offsetY);
      if (!best || spill < best.spill - 1e-6 || (spill < best.spill + 1e-6 && reach < best.reach - 1e-6)) {
        best = { x, y, width, height, spill, reach };
      }
    }
    if (best && best.spill < 1e-6) {
      break;
    }
  }
  const lens = best ?? { x: centerX, y: centerY, width: 1, height: 1 };
  return {
    x: lens.x / base.width,
    y: lens.y / base.height,
    width: lens.width / base.width,
    height: lens.height / base.height,
  };
}

/** Whether a layer paints anything; an empty text box does not. */
export function studioImageBoardLayerIsVisible(layer: StudioImageBoardLayer): boolean {
  return layer.kind !== "text" || layer.text.trim().length > 0;
}

/** False only when rendering the board would reproduce the node image exactly. */
export function studioImageBoardHasEdits(board: StudioImageBoard): boolean {
  if (board.crop) {
    return true;
  }
  const visible = board.layers.filter(studioImageBoardLayerIsVisible);
  return !(visible.length === 1 && isPristineBase(visible[0]));
}

/** The cached render, unless it was made from a different source image. */
export function resolveStudioImageBoardRenderedAsset(
  config: Record<string, StudioJsonValue>,
  sourcePathHint: string
): StudioAssetRef | null {
  const board = readStudioImageBoard(config);
  if (!board.lastRenderedAsset) {
    return null;
  }
  const hint = readString(sourcePathHint).trim();
  if (hint && board.sourceAssetPath && board.sourceAssetPath !== hint) {
    return null;
  }
  return board.lastRenderedAsset;
}
