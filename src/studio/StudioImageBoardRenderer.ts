import type { StudioAssetRef } from "./types";
import {
  studioImageBoardHasEdits,
  studioImageBoardLayerIsVisible,
  studioImageBoardLensView,
  studioImageBoardOutputFrame,
  type StudioImageBoard,
  type StudioImageBoardLayer,
  type StudioImageBoardLensShape,
  type StudioImageBoardMagnifyLayer,
  type StudioImageBoardRedactLayer,
  type StudioImageBoardShapeLayer,
  type StudioImageBoardTextLayer,
} from "./StudioImageBoard";
import { layoutStudioFillText } from "./StudioFillText";
import {
  applyAffine,
  boxLocalTransform,
  boxSizePx,
  convexHull,
  framesOverlap,
  invertAffine,
  multiplyAffine,
  scaleAffine,
  translateAffine,
  viewTransform,
  type StudioImageBoardAffine,
  type StudioImageBoardFrame,
  type StudioImageBoardPoint,
  type StudioImageBoardSize,
} from "./StudioImageBoardGeometry";
import {
  createStudioRedactionGenerator,
  planStudioImageBoardRedactions,
  rasterizeStudioRedactionMask,
  resolveStudioRedactionGrid,
  studioImageBoardPaintReach,
  synthesizeStudioRedactionFill,
} from "./StudioImageBoardRedaction";

/**
 * The one painter for the image board. The in-place editor, the card preview,
 * clipboard copy, and the node's exported asset all go through
 * paintStudioImageBoard, so what is edited is exactly what is produced.
 *
 * Output is always a flattened raster. There is deliberately no vector
 * fallback: a document that still embeds the source image would leak whatever
 * a crop or redaction was meant to remove.
 */

export type StudioImageBoardImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
};

export type StudioImageBoardDecodedImage = StudioImageBoardImage & { close: () => void };

export type StudioImageBoardScene = {
  board: StudioImageBoard;
  /** Pixel size every normalized coordinate refers to: the node image's. */
  baseSize: StudioImageBoardSize;
  /** The node image, painted by the base layer. */
  base: StudioImageBoardImage | null;
  /** Stacked images by asset path. */
  images: ReadonlyMap<string, StudioImageBoardImage>;
};

export type StudioImageBoardPaintOptions = {
  /** Normalized region shown by the whole target canvas. */
  view: StudioImageBoardFrame;
  /** A layer drawn elsewhere for now, e.g. text being typed in place. */
  skipLayerId?: string | null;
  /** Darkens everything outside this frame; the crop tool's mask. */
  dimOutside?: StudioImageBoardFrame | null;
  /** Reused intermediate canvases; pass one per long-lived surface. */
  scratch?: StudioImageBoardScratch;
};

export type StudioRenderedImageBoard = {
  bytes: ArrayBuffer;
  mimeType: "image/png";
  width: number;
  height: number;
};

/** @internal Tests assert against this value. */
export const STUDIO_IMAGE_BOARD_MAX_OUTPUT_SIDE = 8192;
export const STUDIO_IMAGE_BOARD_RENDER_UNAVAILABLE =
  "Image rendering is unavailable here, so this edited image cannot be produced.";

const OUTPUT_MIME = "image/png" as const;
const INK = "#000000";
const HIGHLIGHT_ALPHA = 0.4;
const CROP_MASK = "rgba(0, 0, 0, 0.58)";
const REDACT_EDGE_PX = 1;
/** A lens's rim, as a share of the node image's shorter side, so every lens on a picture matches. */
const LENS_RIM = 0.005;
/** The rest of a lens's look, as shares of its own shorter side. */
const LENS_CORNER = 0.09;
const LENS_SHADOW_BLUR = 0.1;
const LENS_SHADOW_DROP = 0.035;
const LENS_SHADOW = "rgba(0, 0, 0, 0.5)";
const LENS_EDGE_COLOR = "rgba(0, 0, 0, 0.4)";
/** The beam from a marked area to its lens: strongest where it leaves the area. */
const LENS_BEAM_NEAR = 0.34;
const LENS_BEAM_FAR = 0.08;
const LENS_BEAM_EDGE = 0.7;
const LENS_ROUND_STEPS = 48;
const LENS_CORNER_STEPS = 6;
const LENS_GLASS_MAX_SIDE = 4096;
/** How many lenses may look at one another before the innermost is left empty. */
const LENS_MAX_DEPTH = 3;
const REDACT_GRAIN_TILE = 64;
const REDACT_GRAIN_ALPHA = 0.02;
const REDACT_GRAIN_READY = new WeakSet<HTMLCanvasElement>();

/** Intermediate canvases keyed by role and resized on demand. */
export class StudioImageBoardScratch {
  private readonly canvases = new Map<string, HTMLCanvasElement>();

  context(key: string, width: number, height: number, readback: boolean = false): CanvasRenderingContext2D {
    let canvas = this.canvases.get(key);
    if (!canvas) {
      canvas = createEl("canvas");
      this.canvases.set(key, canvas);
    }
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    const context = canvas.getContext("2d", readback ? { willReadFrequently: true } : undefined);
    if (!context) {
      throw new Error(STUDIO_IMAGE_BOARD_RENDER_UNAVAILABLE);
    }
    return context;
  }

  dispose(): void {
    for (const canvas of this.canvases.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.canvases.clear();
  }
}

type ScratchSource = Pick<StudioImageBoardScratch, "context">;

/**
 * The scratch canvases for a picture painted inside another: the same roles
 * under their own names, so the two never fight over one canvas.
 */
function scratchAt(scratch: StudioImageBoardScratch, depth: number): ScratchSource {
  return depth === 0
    ? scratch
    : { context: (key, width, height, readback) => scratch.context(`${key}@${depth}`, width, height, readback) };
}

function affineScale(matrix: StudioImageBoardAffine): number {
  return Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])) || 1;
}

function setTransform(ctx: CanvasRenderingContext2D, matrix: StudioImageBoardAffine): void {
  ctx.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function paintImage(
  ctx: CanvasRenderingContext2D,
  image: StudioImageBoardImage | null | undefined,
  size: StudioImageBoardSize
): void {
  if (!image) {
    return;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.source, -size.width / 2, -size.height / 2, size.width, size.height);
}

function paintShape(
  ctx: CanvasRenderingContext2D,
  layer: StudioImageBoardShapeLayer,
  size: StudioImageBoardSize,
  baseSize: StudioImageBoardSize
): void {
  const { width, height } = size;
  ctx.strokeStyle = layer.color;
  ctx.fillStyle = layer.color;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (layer.shape === "arrow") {
    // The box is the arrow: its length runs along x and its height is the head.
    const shaft = Math.max(1, height * 0.3);
    const head = Math.min(width * 0.6, height * 1.15);
    ctx.lineWidth = shaft;
    ctx.beginPath();
    ctx.moveTo(-width / 2 + shaft / 2, 0);
    ctx.lineTo(width / 2 - head * 0.85, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2 - head, -height / 2);
    ctx.lineTo(width / 2 - head, height / 2);
    ctx.closePath();
    ctx.fill();
    return;
  }
  // The stroke stays inside the box so the selection frame hugs what is drawn.
  const stroke = Math.max(
    1,
    Math.min(layer.strokeWidth * Math.min(baseSize.width, baseSize.height), width / 2, height / 2)
  );
  ctx.lineWidth = stroke;
  if (layer.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(0.5, (width - stroke) / 2), Math.max(0.5, (height - stroke) / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  roundedRectPath(
    ctx,
    -width / 2 + stroke / 2,
    -height / 2 + stroke / 2,
    width - stroke,
    height - stroke,
    Math.min(width, height) * 0.06
  );
  ctx.stroke();
}

function paintText(
  ctx: CanvasRenderingContext2D,
  layer: StudioImageBoardTextLayer,
  size: StudioImageBoardSize,
  deviceScale: number
): void {
  const layout = layoutStudioFillText(
    (font, text) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    },
    layer,
    size.width,
    size.height
  );
  if (layer.style === "banner") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
    roundedRectPath(ctx, -size.width / 2, -size.height / 2, size.width, size.height, layout.fontPx * 0.18);
    ctx.fill();
  }
  ctx.font = layout.font;
  ctx.textBaseline = "middle";
  ctx.textAlign = layer.align;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.fillStyle = layer.color;
  const anchorX = layer.align === "left"
    ? -size.width / 2 + layout.padPx
    : layer.align === "right"
      ? size.width / 2 - layout.padPx
      : 0;
  // Capitals sit high in the em box; nudge all-caps text back to optical centre.
  const opticalShift = layer.style === "meme" ? layout.fontPx * 0.04 : 0;
  const top = -(layout.lines.length * layout.lineHeightPx) / 2;
  if (layer.style === "shadow") {
    // Shadows are specified in device pixels, not in the current transform.
    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = layout.fontPx * 0.22 * deviceScale;
    ctx.shadowOffsetY = layout.fontPx * 0.07 * deviceScale;
  }
  layout.lines.forEach((line, index) => {
    const y = top + (index + 0.5) * layout.lineHeightPx + opticalShift;
    if (layout.strokePx > 0) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = layout.strokePx;
      ctx.strokeText(line, anchorX, y);
    }
    ctx.fillText(line, anchorX, y);
  });
}

/** The noise tile for the frosted grain: seeded, so every render is identical. */
function redactionGrain(scratch: ScratchSource): HTMLCanvasElement {
  const context = scratch.context("redact-grain", REDACT_GRAIN_TILE, REDACT_GRAIN_TILE);
  if (!REDACT_GRAIN_READY.has(context.canvas)) {
    const random = createStudioRedactionGenerator("grain");
    const image = context.createImageData(REDACT_GRAIN_TILE, REDACT_GRAIN_TILE);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const shade = random() < 0.5 ? 0 : 255;
      image.data[offset] = shade;
      image.data[offset + 1] = shade;
      image.data[offset + 2] = shade;
      image.data[offset + 3] = random() * REDACT_GRAIN_ALPHA * 255;
    }
    context.putImageData(image, 0, 0);
    REDACT_GRAIN_READY.add(context.canvas);
  }
  return context.canvas;
}

/** One redaction box with where it lands on the canvas being painted. */
type RedactionTarget = {
  layer: StudioImageBoardRedactLayer;
  local: StudioImageBoardAffine;
  size: StudioImageBoardSize;
};

function redactionCorners(target: RedactionTarget, grow: number): StudioImageBoardPoint[] {
  const halfWidth = target.size.width / 2 + grow;
  const halfHeight = target.size.height / 2 + grow;
  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((corner) => applyAffine(target.local, corner));
}

/**
 * Paints `members` as one hidden region. `pending` is every redaction not yet
 * painted, the members included: all of it is taken out of the picture before
 * the surroundings are sampled.
 */
function paintRedaction(
  ctx: CanvasRenderingContext2D,
  members: readonly RedactionTarget[],
  pending: readonly RedactionTarget[],
  scratch: ScratchSource
): void {
  const seed = members[0];
  const style = seed.layer.style;
  const deviceScale = affineScale(seed.local);
  // The cover reaches one device pixel past each box, so a pixel a box only
  // partly overlaps is covered whole instead of blended with what it hides.
  const edge = REDACT_EDGE_PX / deviceScale;
  const coverPath = (): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    for (const member of members) {
      const [first, ...rest] = redactionCorners(member, edge);
      ctx.moveTo(first.x, first.y);
      for (const corner of rest) {
        ctx.lineTo(corner.x, corner.y);
      }
      ctx.closePath();
    }
  };
  if (style === "solid") {
    coverPath();
    ctx.fillStyle = INK;
    ctx.fill();
    return;
  }
  const seedInverse = invertAffine(seed.local);
  if (!seedInverse) {
    return;
  }

  // The region's frame: the lowest member's orientation, around the bounds of
  // them all. One box alone is its own frame exactly.
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const member of members) {
    for (const corner of redactionCorners(member, 0)) {
      const point = applyAffine(seedInverse, corner);
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  }
  const width = right - left;
  const height = bottom - top;
  const frame = multiplyAffine(seed.local, translateAffine((left + right) / 2, (top + bottom) / 2));
  const frameInverse = invertAffine(frame);
  if (!frameInverse || !(width > 0) || !(height > 0)) {
    return;
  }
  const shortSides = members.map((member) => Math.min(member.size.width, member.size.height));
  const grid = resolveStudioRedactionGrid(
    { width, height, thinnest: Math.min(...shortSides), thickest: Math.max(...shortSides) },
    style
  );
  const canvas = ctx.canvas;

  // 1. Copy what is painted so far and erase from the copy everything this
  //    and every later redaction hides, a device pixel wider than its cover.
  //    From here on those pixels do not exist for anything that samples it.
  const copy = scratch.context("redact-copy", canvas.width, canvas.height);
  copy.setTransform(1, 0, 0, 1, 0, 0);
  copy.globalCompositeOperation = "copy";
  copy.drawImage(canvas, 0, 0);
  copy.globalCompositeOperation = "destination-out";
  copy.fillStyle = INK;
  for (const target of pending) {
    const guard = (REDACT_EDGE_PX + 1) / affineScale(target.local);
    setTransform(copy, target.local);
    copy.fillRect(
      -target.size.width / 2 - guard,
      -target.size.height / 2 - guard,
      target.size.width + guard * 2,
      target.size.height + guard * 2
    );
  }
  copy.globalCompositeOperation = "source-over";

  // 2. Shrink the region and a band of its surroundings into a small patch
  //    and read it. Only the surroundings hold anything by now.
  const cellWidth = width / grid.columns;
  const cellHeight = height / grid.rows;
  const patchColumns = grid.columns + grid.bandColumns * 2;
  const patchRows = grid.rows + grid.bandRows * 2;
  const toCells = multiplyAffine(
    multiplyAffine(scaleAffine(1 / cellWidth, 1 / cellHeight), translateAffine(width / 2, height / 2)),
    frameInverse
  );
  const patch = scratch.context("redact-patch", patchColumns, patchRows, true);
  patch.setTransform(1, 0, 0, 1, 0, 0);
  patch.clearRect(0, 0, patchColumns, patchRows);
  patch.imageSmoothingEnabled = true;
  patch.imageSmoothingQuality = "high";
  setTransform(patch, multiplyAffine(translateAffine(grid.bandColumns, grid.bandRows), toCells));
  patch.drawImage(copy.canvas, 0, 0);
  const surroundings = patch.getImageData(0, 0, patchColumns, patchRows).data;

  // 3. Synthesize the fill from the surroundings alone and paint it over the covers.
  const fromCells = invertAffine(toCells);
  const hidden = members.length > 1 && fromCells
    ? rasterizeStudioRedactionMask(
        grid.columns,
        grid.rows,
        members.flatMap((member) => {
          const inverse = invertAffine(member.local);
          return inverse
            ? [{
                fromCells: multiplyAffine(inverse, fromCells),
                halfWidth: member.size.width / 2,
                halfHeight: member.size.height / 2,
              }]
            : [];
        })
      )
    : undefined;
  const fill = synthesizeStudioRedactionFill({
    patch: surroundings,
    columns: grid.columns,
    rows: grid.rows,
    bandColumns: grid.bandColumns,
    bandRows: grid.bandRows,
    style,
    seed: seed.layer.id,
    hidden,
    sigmaColumns: grid.sigmaColumns,
    sigmaRows: grid.sigmaRows,
  });
  const fillContext = scratch.context("redact-fill", grid.columns, grid.rows, true);
  const fillImage = fillContext.createImageData(grid.columns, grid.rows);
  fillImage.data.set(fill);
  fillContext.putImageData(fillImage, 0, 0);
  coverPath();
  ctx.clip();
  // Replace what is hidden outright first. A scaled image can land a hair
  // short of opaque, and whatever shows through it must not be the secret.
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  setTransform(ctx, frame);
  ctx.imageSmoothingEnabled = style === "blur";
  ctx.imageSmoothingQuality = "high";
  // Drawn a little past the cover, so the image's own soft edge falls outside
  // the clip instead of letting the underlay show as a hairline.
  const bleed = edge * 3;
  ctx.drawImage(fillContext.canvas, -width / 2 - bleed, -height / 2 - bleed, width + bleed * 2, height + bleed * 2);
  if (style === "blur") {
    // Fine grain, one device pixel across: frosted glass rather than a smear,
    // and no banding in the smooth fill.
    const grain = ctx.createPattern(redactionGrain(scratch), "repeat");
    if (grain) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = grain;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
}

type MagnifierTarget = {
  layer: StudioImageBoardMagnifyLayer;
  local: StudioImageBoardAffine;
  size: StudioImageBoardSize;
};

/** What shows in a lens: the part of `canvas` to enlarge into it. */
type LensGlass = StudioImageBoardFrame & { canvas: HTMLCanvasElement };

/** A lens outline around the origin of its own box. */
type LensOutline = {
  shape: StudioImageBoardLensShape;
  width: number;
  height: number;
  radius: number;
};

function lensOutline(shape: StudioImageBoardLensShape, size: StudioImageBoardSize): LensOutline {
  return { shape, width: size.width, height: size.height, radius: Math.min(size.width, size.height) * LENS_CORNER };
}

/** Traces `outline`, pulled in by `inset` on every side (pushed out when negative). */
function lensPath(ctx: CanvasRenderingContext2D, outline: LensOutline, inset: number): void {
  const width = Math.max(1e-3, outline.width - inset * 2);
  const height = Math.max(1e-3, outline.height - inset * 2);
  if (outline.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
    return;
  }
  roundedRectPath(ctx, -width / 2, -height / 2, width, height, Math.max(0, outline.radius - inset));
}

/** Points around `outline`, close enough together to stand in for its curves. */
function lensOutlinePoints(outline: LensOutline): StudioImageBoardPoint[] {
  const { width, height } = outline;
  if (outline.shape === "ellipse") {
    return Array.from({ length: LENS_ROUND_STEPS }, (_, step) => {
      const angle = (step / LENS_ROUND_STEPS) * Math.PI * 2;
      return { x: (Math.cos(angle) * width) / 2, y: (Math.sin(angle) * height) / 2 };
    });
  }
  const radius = Math.max(0, Math.min(outline.radius, width / 2, height / 2));
  const points: StudioImageBoardPoint[] = [];
  // Each corner's quarter turn, clockwise from the top right.
  for (const [signX, signY, start] of [[1, -1, -90], [1, 1, 0], [-1, 1, 90], [-1, -1, 180]]) {
    for (let step = 0; step <= LENS_CORNER_STEPS; step += 1) {
      const angle = ((start + (step / LENS_CORNER_STEPS) * 90) * Math.PI) / 180;
      points.push({
        x: signX * (width / 2 - radius) + Math.cos(angle) * radius,
        y: signY * (height / 2 - radius) + Math.sin(angle) * radius,
      });
    }
  }
  return points;
}

/** `color` (#rgb or #rrggbb) at `alpha`. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.length === 4 ? color.replace(/[0-9a-f]/gi, "$&$&") : color;
  const channel = (at: number): number => parseInt(hex.slice(at, at + 2), 16) || 0;
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${alpha})`;
}

/**
 * Paints a lens: the outline of the area it enlarges, a beam of light from
 * that area to the lens, and the lens itself, rimmed and casting a shadow so
 * it reads as lifted off the page. `area` is the marked area on this canvas;
 * `glass` is what shows in the lens.
 */
function paintMagnifier(
  ctx: CanvasRenderingContext2D,
  target: MagnifierTarget,
  area: { local: StudioImageBoardAffine; size: StudioImageBoardSize },
  baseSize: StudioImageBoardSize,
  glass: LensGlass | null
): void {
  const { layer, local, size } = target;
  const canvas = ctx.canvas;
  const deviceScale = affineScale(local);
  const short = Math.min(size.width, size.height);
  const rim = Math.max(
    1.5 / deviceScale,
    Math.min(LENS_RIM * Math.min(baseSize.width, baseSize.height), short * 0.12)
  );
  const edge = Math.max(1 / deviceScale, rim * 0.2);
  const lens = lensOutline(layer.shape, size);
  const marked = lensOutline(layer.shape, area.size);

  // 1. The beam: everything between the two outlines, but not the area
  //    itself, which stays exactly as it is in the picture.
  const from = lensOutlinePoints(marked).map((point) => applyAffine(area.local, point));
  const onto = lensOutlinePoints(lens).map((point) => applyAffine(local, point));
  const trace = (points: readonly StudioImageBoardPoint[]): void => {
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
  };
  const beam = convexHull([...from, ...onto]);
  const start = applyAffine(area.local, { x: 0, y: 0 });
  const end = applyAffine(local, { x: 0, y: 0 });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (Math.hypot(end.x - start.x, end.y - start.y) >= 1) {
    const light = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
    light.addColorStop(0, withAlpha(layer.color, LENS_BEAM_NEAR));
    light.addColorStop(1, withAlpha(layer.color, LENS_BEAM_FAR));
    ctx.fillStyle = light;
  } else {
    ctx.fillStyle = withAlpha(layer.color, LENS_BEAM_FAR);
  }
  ctx.beginPath();
  trace(beam);
  trace(from);
  ctx.fill("evenodd");
  ctx.lineJoin = "round";
  ctx.strokeStyle = withAlpha(layer.color, LENS_BEAM_EDGE);
  ctx.lineWidth = Math.max(1, rim * 0.3 * deviceScale);
  ctx.beginPath();
  trace(beam);
  ctx.stroke();

  // 2. The marked area, outlined just outside its edge.
  setTransform(ctx, area.local);
  const line = Math.max(1.5 / deviceScale, rim * 0.6);
  ctx.strokeStyle = LENS_EDGE_COLOR;
  ctx.lineWidth = line + edge * 2;
  lensPath(ctx, marked, -line / 2);
  ctx.stroke();
  ctx.strokeStyle = layer.color;
  ctx.lineWidth = line;
  lensPath(ctx, marked, -line / 2);
  ctx.stroke();

  // 3. The shadow the lens casts. Shadows are set in device pixels.
  setTransform(ctx, local);
  ctx.shadowColor = LENS_SHADOW;
  ctx.shadowBlur = short * LENS_SHADOW_BLUR * deviceScale;
  ctx.shadowOffsetY = short * LENS_SHADOW_DROP * deviceScale;
  ctx.fillStyle = INK;
  lensPath(ctx, lens, 0);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // 4. The glass: emptied, then filled with the enlarged area.
  ctx.save();
  lensPath(ctx, lens, 0);
  ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (glass) {
    setTransform(ctx, local);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      glass.canvas,
      glass.x,
      glass.y,
      glass.width,
      glass.height,
      -size.width / 2,
      -size.height / 2,
      size.width,
      size.height
    );
  }
  ctx.restore();

  // 5. The rim: a band of the lens's colour with a dark line on either side,
  //    so it stands out on a pale picture as well as on a dark one.
  setTransform(ctx, local);
  ctx.strokeStyle = layer.color;
  ctx.lineWidth = rim;
  lensPath(ctx, lens, rim / 2);
  ctx.stroke();
  ctx.strokeStyle = LENS_EDGE_COLOR;
  ctx.lineWidth = edge;
  lensPath(ctx, lens, edge / 2);
  ctx.stroke();
  lensPath(ctx, lens, rim - edge / 2);
  ctx.stroke();
}

function paintLayer(
  ctx: CanvasRenderingContext2D,
  layer: StudioImageBoardLayer,
  scene: StudioImageBoardScene,
  local: StudioImageBoardAffine,
  size: StudioImageBoardSize
): void {
  switch (layer.kind) {
    case "base":
      paintImage(ctx, scene.base, size);
      return;
    case "image":
      paintImage(ctx, scene.images.get(layer.asset.path), size);
      return;
    case "text":
      paintText(ctx, layer, size, affineScale(local));
      return;
    case "shape":
      paintShape(ctx, layer, size, scene.baseSize);
      return;
    case "highlight":
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.fillStyle = layer.color;
      roundedRectPath(ctx, -size.width / 2, -size.height / 2, size.width, size.height, Math.min(size.width, size.height) * 0.12);
      ctx.fill();
      return;
    case "redact":
    case "magnify":
      // Painted by paintLayers, which knows the rest of the stack.
      return;
  }
}

type PaintPass = {
  scratch: StudioImageBoardScratch;
  skipLayerId: string | null;
  /** 0 for the picture itself; one more for each lens this pass is seen through. */
  depth: number;
};

/** Paints `layers`, bottom first, so that `frame` exactly fills the context's canvas. */
function paintLayers(
  ctx: CanvasRenderingContext2D,
  scene: StudioImageBoardScene,
  layers: readonly StudioImageBoardLayer[],
  frame: StudioImageBoardFrame,
  pass: PaintPass
): void {
  const target = { width: ctx.canvas.width, height: ctx.canvas.height };
  const scratch = scratchAt(pass.scratch, pass.depth);
  const view = viewTransform(frame, scene.baseSize, target);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, target.width, target.height);

  const painted = layers.flatMap((layer) => {
    if (layer.id === pass.skipLayerId || !studioImageBoardLayerIsVisible(layer)) {
      return [];
    }
    // Through a lens only a corner of the picture shows; the rest is not worth painting.
    if (pass.depth > 0 && !framesOverlap(studioImageBoardPaintReach(layer, scene.baseSize), frame)) {
      return [];
    }
    const size = boxSizePx(layer, scene.baseSize);
    if (size.width <= 0 || size.height <= 0) {
      return [];
    }
    return [{ layer, size, local: multiplyAffine(view, boxLocalTransform(layer, scene.baseSize)) }];
  });
  const isRedaction = (entry: (typeof painted)[number]): entry is RedactionTarget => entry.layer.kind === "redact";
  const isMagnifier = (entry: (typeof painted)[number]): entry is MagnifierTarget => entry.layer.kind === "magnify";
  const redactions = planStudioImageBoardRedactions(painted.map((entry) => entry.layer), scene.baseSize);

  /**
   * What shows in a lens: the picture beneath it, painted afresh so it is as
   * sharp as the picture allows, and only then enlarged. The lens sees every
   * layer under it and every redaction above it: without those, a lens under
   * a blur would show what the blur hides.
   *
   * It is painted at the picture's own pixel size, on the picture's own pixel
   * grid, and never larger. Enlarging happens afterwards, from pixels that
   * are already redacted; enlarging first would smear the pixels just inside
   * a blur out past its edge before the blur could replace them.
   */
  const glassFor = (lens: MagnifierTarget): LensGlass | null => {
    if (pass.depth >= LENS_MAX_DEPTH) {
      return null;
    }
    const base = scene.baseSize;
    const shown = studioImageBoardLensView(lens.layer);
    const shownWidth = shown.width * base.width;
    const shownHeight = shown.height * base.height;
    // Device pixels the lens has for each pixel of the picture, when that is fewer than one.
    const scale = Math.min(
      1,
      (lens.size.width * affineScale(lens.local)) / shownWidth,
      LENS_GLASS_MAX_SIDE / Math.max(shownWidth, shownHeight)
    );
    let frame = shown;
    let part = { x: 0, y: 0, width: Math.ceil(shownWidth * scale), height: Math.ceil(shownHeight * scale) };
    let size = { width: part.width, height: part.height };
    if (scale === 1) {
      const left = Math.floor(shown.x * base.width);
      const top = Math.floor(shown.y * base.height);
      size = {
        width: Math.ceil(shown.x * base.width + shownWidth) - left,
        height: Math.ceil(shown.y * base.height + shownHeight) - top,
      };
      frame = { x: left / base.width, y: top / base.height, width: size.width / base.width, height: size.height / base.height };
      part = { x: shown.x * base.width - left, y: shown.y * base.height - top, width: shownWidth, height: shownHeight };
    }
    const glass = scratchAt(pass.scratch, pass.depth + 1).context("lens-glass", size.width, size.height);
    const at = layers.indexOf(lens.layer);
    const seen = [...layers.slice(0, at), ...layers.slice(at + 1).filter((layer) => layer.kind === "redact")];
    paintLayers(glass, scene, seen, frame, { ...pass, depth: pass.depth + 1 });
    // A lens shows the picture, and what is cropped off is not in the picture.
    const output = studioImageBoardOutputFrame(scene.board);
    setTransform(glass, viewTransform(frame, base, { width: glass.canvas.width, height: glass.canvas.height }));
    glass.globalCompositeOperation = "destination-in";
    glass.fillStyle = INK;
    glass.fillRect(output.x * base.width, output.y * base.height, output.width * base.width, output.height * base.height);
    glass.globalCompositeOperation = "source-over";
    return { canvas: glass.canvas, ...part };
  };

  painted.forEach((entry, index) => {
    const { layer, local, size } = entry;
    if (isRedaction(entry)) {
      if (redactions.absorbed.has(layer.id)) {
        return;
      }
      const pending = painted.slice(index).filter(isRedaction);
      const group = redactions.groups.get(layer.id);
      const members = group ? pending.filter((target) => group.includes(target.layer)) : [entry];
      ctx.save();
      paintRedaction(ctx, members, pending, scratch);
      ctx.restore();
      return;
    }
    if (isMagnifier(entry)) {
      const glass = glassFor(entry);
      const marked = { ...entry.layer.source, rotation: 0 };
      ctx.save();
      paintMagnifier(
        ctx,
        entry,
        {
          local: multiplyAffine(view, boxLocalTransform(marked, scene.baseSize)),
          size: boxSizePx(marked, scene.baseSize),
        },
        scene.baseSize,
        glass
      );
      ctx.restore();
      return;
    }
    ctx.save();
    setTransform(ctx, local);
    paintLayer(ctx, layer, scene, local, size);
    ctx.restore();
  });
}

/** Paints `scene` so that `options.view` exactly fills the context's canvas. */
export function paintStudioImageBoard(
  ctx: CanvasRenderingContext2D,
  scene: StudioImageBoardScene,
  options: StudioImageBoardPaintOptions
): void {
  const target = { width: ctx.canvas.width, height: ctx.canvas.height };
  const scratch = options.scratch ?? new StudioImageBoardScratch();
  paintLayers(ctx, scene, scene.board.layers, options.view, {
    scratch,
    skipLayerId: options.skipLayerId ?? null,
    depth: 0,
  });

  const mask = options.dimOutside;
  if (mask) {
    const view = viewTransform(options.view, scene.baseSize, target);
    const topLeft = applyAffine(view, {
      x: mask.x * scene.baseSize.width,
      y: mask.y * scene.baseSize.height,
    });
    const bottomRight = applyAffine(view, {
      x: (mask.x + mask.width) * scene.baseSize.width,
      y: (mask.y + mask.height) * scene.baseSize.height,
    });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = CROP_MASK;
    ctx.beginPath();
    ctx.rect(0, 0, target.width, target.height);
    ctx.rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.fill("evenodd");
    ctx.restore();
  }
  if (!options.scratch) {
    scratch.dispose();
  }
}

/** Pixel size of the output frame, scaled down only if a side would be enormous. */
export function resolveStudioImageBoardOutputSize(
  board: StudioImageBoard,
  baseSize: StudioImageBoardSize
): StudioImageBoardSize {
  const frame = studioImageBoardOutputFrame(board);
  const width = Math.max(1, frame.width * baseSize.width);
  const height = Math.max(1, frame.height * baseSize.height);
  const scale = Math.min(1, STUDIO_IMAGE_BOARD_MAX_OUTPUT_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function decodeStudioImageBoardImage(
  bytes: ArrayBuffer,
  mimeType: string
): Promise<StudioImageBoardDecodedImage> {
  const blob = new Blob([bytes], { type: mimeType });
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => {
          try {
            bitmap.close();
          } catch {
            // Already released.
          }
        },
      };
    } catch (error) {
      // Vector sources decode only through an image element.
      if (!mimeType.includes("svg")) {
        throw error;
      }
    }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Image decoding is unavailable here.");
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("The image could not be decoded."));
      element.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width || 1600,
      height: image.naturalHeight || image.height || 900,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function encodePng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((next) => {
        if (next) resolve(next);
        else reject(new Error("The edited image could not be encoded."));
      }, OUTPUT_MIME);
    });
    return blob.arrayBuffer();
  }
  if (typeof atob !== "function") {
    throw new Error("The edited image could not be encoded.");
  }
  const binary = atob(canvas.toDataURL(OUTPUT_MIME).split(",")[1] || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/** Flattens an already decoded scene to PNG bytes at full output resolution. */
export async function renderStudioImageBoardScene(
  scene: StudioImageBoardScene
): Promise<StudioRenderedImageBoard> {
  const size = resolveStudioImageBoardOutputSize(scene.board, scene.baseSize);
  const scratch = new StudioImageBoardScratch();
  try {
    const context = scratch.context("output", size.width, size.height);
    paintStudioImageBoard(context, scene, {
      view: studioImageBoardOutputFrame(scene.board),
      scratch,
    });
    const bytes = await encodePng(context.canvas);
    return { bytes, mimeType: OUTPUT_MIME, width: size.width, height: size.height };
  } finally {
    scratch.dispose();
  }
}

/**
 * Decodes the node image and every stacked image, renders, and releases them.
 * @internal Unit-tested directly.
 */
export async function renderStudioImageBoard(options: {
  board: StudioImageBoard;
  baseImage: StudioAssetRef;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
}): Promise<StudioRenderedImageBoard> {
  const { board, baseImage, readAsset } = options;
  const decoded: StudioImageBoardDecodedImage[] = [];
  const decode = async (asset: StudioAssetRef): Promise<StudioImageBoardDecodedImage> => {
    const image = await decodeStudioImageBoardImage(await readAsset(asset), asset.mimeType);
    decoded.push(image);
    return image;
  };
  try {
    const base = await decode(baseImage);
    const images = new Map<string, StudioImageBoardImage>();
    for (const layer of board.layers) {
      if (layer.kind === "image" && !images.has(layer.asset.path)) {
        images.set(layer.asset.path, await decode(layer.asset));
      }
    }
    return await renderStudioImageBoardScene({
      board,
      baseSize: { width: base.width, height: base.height },
      base,
      images,
    });
  } finally {
    for (const image of decoded) {
      image.close();
    }
  }
}

/** The node's output asset: the node image itself when nothing was edited. */
export async function composeStudioImageBoardAsset(options: {
  baseImage: StudioAssetRef;
  board: StudioImageBoard;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
  storeAsset: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
}): Promise<StudioAssetRef> {
  if (!studioImageBoardHasEdits(options.board)) {
    return options.baseImage;
  }
  const rendered = await renderStudioImageBoard(options);
  return options.storeAsset(rendered.bytes, rendered.mimeType);
}
