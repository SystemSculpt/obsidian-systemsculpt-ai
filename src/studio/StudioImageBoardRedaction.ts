import type {
  StudioImageBoardLayer,
  StudioImageBoardRedactLayer,
  StudioImageBoardRedactStyle,
} from "./StudioImageBoard";
import {
  boxBounds,
  boxesTouch,
  boxSizePx,
  framesOverlap,
  unionFrames,
  type StudioImageBoardAffine,
  type StudioImageBoardFrame,
  type StudioImageBoardSize,
} from "./StudioImageBoardGeometry";

/**
 * Secure redaction.
 *
 * A blur or mosaic computed from the hidden pixels can be reversed: averaged
 * text still carries its ink pattern, and published attacks recover it. This
 * fill never reads the hidden pixels at all. It builds a decoy for the hidden
 * region out of what surrounds it — the pixels just OUTSIDE, reflected
 * inwards across each edge — and then genuinely blurs (or pixelates) that
 * decoy together with the real surroundings. The blur is real; the content
 * under it is not. The result looks like the picture seen through frosted
 * glass while containing zero information about what it covers, so there is
 * nothing to recover by sharpening it.
 *
 * Two rules keep that true when a picture carries several redactions:
 *
 * - Whatever any redaction still to be painted will hide is already gone
 *   when an earlier one samples its surroundings, so one box can never fold
 *   its neighbour's secret into its own fill.
 * - Boxes of one style that touch or overlap are one hidden region with one
 *   fill, so they read as a single pane instead of a stack of them.
 *
 * `patch` is an RGBA grid of (columns + 2·bandColumns) × (rows + 2·bandRows)
 * cells: the hidden region's bounding box in the middle and a band of
 * surroundings on every side, a little over half the box deep so a
 * reflection reaches the centre. Hidden cells are never read, whatever they
 * hold. The renderer additionally erases the hidden region before sampling,
 * so the surroundings cannot carry bleed from resampling either.
 */

export type StudioRedactionStyle = Exclude<StudioImageBoardRedactStyle, "solid">;

export type StudioRedactionGrid = {
  columns: number;
  rows: number;
  /** Cells of surroundings sampled beyond the left and right edges. */
  bandColumns: number;
  /** Cells of surroundings sampled beyond the top and bottom edges. */
  bandRows: number;
  /** Blur spread in cells along each axis; 0 for the mosaic. */
  sigmaColumns: number;
  sigmaRows: number;
};

export type StudioRedactionPlan = {
  /** Redactions painted as one region, keyed by the id of the lowest in the stack. */
  groups: ReadonlyMap<string, readonly StudioImageBoardRedactLayer[]>;
  /** Members painted with that lowest layer instead of at their own place in the stack. */
  absorbed: ReadonlySet<string>;
};

type Tuning = {
  /** Cells across the thinnest box of a region. */
  shortSideCells: number;
  maxSideCells: number;
  maxCells: number;
  /** Gaussian sigma as a share of the thickest box's short side; 0 leaves cells crisp. */
  blurShare: number;
  /** Per-cell brightness variation, so flat surroundings still show blocks. */
  jitter: number;
};

const TUNING: Record<StudioRedactionStyle, Tuning> = {
  blur: { shortSideCells: 32, maxSideCells: 256, maxCells: 24576, blurShare: 0.13, jitter: 0 },
  pixelate: { shortSideCells: 8, maxSideCells: 64, maxCells: 2048, blurShare: 0, jitter: 7 },
};

const MIN_VALID_ALPHA = 24;
const NEUTRAL = 128;
/** Surroundings sampled past each edge, as a share of the region along that axis. */
const BAND_SHARE = 0.6;
/** Pull of the surroundings' average colour where no reflection reaches. */
const AVERAGE_WEIGHT = 0.02;
/** Frost: how far the fill's brightness is drawn toward the middle so it reads as a pane. */
const FROST = 0.07;
const BLUR_PASSES = 3;
/** How far a layer may paint past its own box, as a share of its short side: shadows, outlines. */
const PAINT_OVERHANG = 0.5;

/**
 * The cell grid for a hidden region `width` × `height` across (any unit).
 * `thinnest` and `thickest` are the short sides of the slimmest and the
 * stoutest box in it; for a single box both are its own short side.
 */
export function resolveStudioRedactionGrid(
  region: { width: number; height: number; thinnest?: number; thickest?: number },
  style: StudioRedactionStyle
): StudioRedactionGrid {
  const tuning = TUNING[style];
  const width = Math.max(1e-6, region.width);
  const height = Math.max(1e-6, region.height);
  const short = Math.min(width, height);
  const thinnest = Math.max(1e-6, Math.min(short, region.thinnest ?? short));
  const thickest = Math.max(thinnest, Math.min(short, region.thickest ?? short));
  // Roughly square cells sized for the thinnest box, then held to a budget.
  const cell = thinnest / tuning.shortSideCells;
  let columns = Math.min(tuning.maxSideCells, Math.max(1, Math.round(width / cell)));
  let rows = Math.min(tuning.maxSideCells, Math.max(1, Math.round(height / cell)));
  if (columns * rows > tuning.maxCells) {
    const shrink = Math.sqrt(tuning.maxCells / (columns * rows));
    columns = Math.max(1, Math.round(columns * shrink));
    rows = Math.max(1, Math.round(rows * shrink));
  }
  const sigma = thickest * tuning.blurShare;
  return {
    columns,
    rows,
    bandColumns: Math.ceil(columns * BAND_SHARE),
    bandRows: Math.ceil(rows * BAND_SHARE),
    sigmaColumns: (sigma * columns) / width,
    sigmaRows: (sigma * rows) / height,
  };
}

/** Everything a layer may paint, generously: its bounds plus room for shadows and outlines. */
export function studioImageBoardPaintReach(
  layer: StudioImageBoardLayer,
  base: StudioImageBoardSize
): StudioImageBoardFrame {
  // A lens also paints its area's outline and the beam between the two.
  const bounds = layer.kind === "magnify"
    ? unionFrames([boxBounds(layer, base), layer.source])
    : boxBounds(layer, base);
  const size = boxSizePx(layer, base);
  const pad = Math.min(size.width, size.height) * PAINT_OVERHANG + 2;
  const padX = pad / base.width;
  const padY = pad / base.height;
  return { x: bounds.x - padX, y: bounds.y - padY, width: bounds.width + padX * 2, height: bounds.height + padY * 2 };
}

/**
 * Decides which redactions are painted together. `layers` are the layers
 * about to be painted, bottom first.
 *
 * Blurs (or mosaics) that touch or overlap become one region, painted where
 * the lowest of them sits in the stack. A box joins only if nothing painted
 * between the two reaches into it: lifting it past a caption it was meant to
 * cover would leave that caption showing.
 */
export function planStudioImageBoardRedactions(
  layers: readonly StudioImageBoardLayer[],
  base: StudioImageBoardSize
): StudioRedactionPlan {
  const groups = new Map<string, StudioImageBoardRedactLayer[]>();
  const absorbed = new Set<string>();
  for (let index = 0; index < layers.length; index += 1) {
    const seed = layers[index];
    if (seed.kind !== "redact" || seed.style === "solid" || absorbed.has(seed.id)) {
      continue;
    }
    const between: StudioImageBoardFrame[] = [];
    const candidates: StudioImageBoardRedactLayer[] = [];
    for (let later = index + 1; later < layers.length; later += 1) {
      const layer = layers[later];
      if (layer.kind !== "redact") {
        between.push(studioImageBoardPaintReach(layer, base));
        continue;
      }
      if (layer.style !== seed.style || absorbed.has(layer.id)) {
        continue;
      }
      const bounds = boxBounds(layer, base);
      if (!between.some((reach) => framesOverlap(reach, bounds))) {
        candidates.push(layer);
      }
    }
    // Everything connected to the seed, directly or through another member.
    const members = [seed];
    for (let cursor = 0; cursor < members.length; cursor += 1) {
      for (const candidate of candidates) {
        if (!members.includes(candidate) && boxesTouch(members[cursor], candidate, base)) {
          members.push(candidate);
        }
      }
    }
    if (members.length > 1) {
      const ordered = members.slice(1).sort((a, b) => layers.indexOf(a) - layers.indexOf(b));
      groups.set(seed.id, [seed, ...ordered]);
      for (const member of ordered) {
        absorbed.add(member.id);
      }
    }
  }
  return { groups, absorbed };
}

/**
 * Flags the cells of a `columns` × `rows` grid whose centre lies inside any
 * of the boxes. Each box is its half size and the transform from grid cells
 * (origin at the grid's top-left corner) into that box's own centred frame.
 */
export function rasterizeStudioRedactionMask(
  columns: number,
  rows: number,
  boxes: ReadonlyArray<{ fromCells: StudioImageBoardAffine; halfWidth: number; halfHeight: number }>
): Uint8Array {
  const mask = new Uint8Array(columns * rows);
  for (const box of boxes) {
    const [a, b, c, d, e, f] = box.fromCells;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = a * (column + 0.5) + c * (row + 0.5) + e;
        const y = b * (column + 0.5) + d * (row + 0.5) + f;
        if (Math.abs(x) <= box.halfWidth && Math.abs(y) <= box.halfHeight) {
          mask[row * columns + column] = 1;
        }
      }
    }
  }
  return mask;
}

function seedFromString(value: string): number {
  let seed = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    seed ^= value.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

/** mulberry32: small, fast, and identical on every platform. */
export function createStudioRedactionGenerator(seed: string): () => number {
  let state = seedFromString(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), state | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One box-blur pass along rows or columns using a sliding window, so its cost
 * does not grow with the radius. Cells past the patch contribute nothing.
 */
function boxBlur(
  source: Float32Array,
  target: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean
): void {
  const length = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const step = horizontal ? 1 : width;
  const scale = 1 / (radius * 2 + 1);
  for (let line = 0; line < lines; line += 1) {
    const origin = horizontal ? line * width : line;
    let sum = 0;
    for (let index = 0; index <= radius && index < length; index += 1) {
      sum += source[origin + index * step];
    }
    for (let index = 0; index < length; index += 1) {
      target[origin + index * step] = sum * scale;
      const entering = index + radius + 1;
      const leaving = index - radius;
      if (entering < length) sum += source[origin + entering * step];
      if (leaving >= 0) sum -= source[origin + leaving * step];
    }
  }
}

/** Three box passes are indistinguishable from a Gaussian of the same spread. */
function gaussianBlur(
  plane: Float32Array,
  scratch: Float32Array,
  width: number,
  height: number,
  sigmaX: number,
  sigmaY: number
): void {
  const radiusFor = (sigma: number): number => Math.max(1, Math.round(Math.sqrt(sigma * sigma + 1 / 12) - 0.5));
  const radiusX = radiusFor(sigmaX);
  const radiusY = radiusFor(sigmaY);
  for (let pass = 0; pass < BLUR_PASSES; pass += 1) {
    boxBlur(plane, scratch, width, height, radiusX, true);
    boxBlur(scratch, plane, width, height, radiusY, false);
  }
}

/**
 * For every hidden cell, where its unbroken run of hidden cells starts and
 * ends along one axis. `lines` × `length` cells, `stride`/`step` walk the mask.
 */
function hiddenRuns(
  hidden: ArrayLike<number> | null,
  lines: number,
  length: number,
  lineStride: number,
  step: number
): { start: Int32Array; end: Int32Array } {
  const start = new Int32Array(lines * length);
  const end = new Int32Array(lines * length);
  for (let line = 0; line < lines; line += 1) {
    let index = 0;
    while (index < length) {
      if (hidden && !hidden[line * lineStride + index * step]) {
        index += 1;
        continue;
      }
      let last = index;
      while (last + 1 < length && (!hidden || hidden[line * lineStride + (last + 1) * step])) {
        last += 1;
      }
      for (let cell = index; cell <= last; cell += 1) {
        start[line * lineStride + cell * step] = index;
        end[line * lineStride + cell * step] = last;
      }
      index = last + 1;
    }
  }
  return { start, end };
}

export function synthesizeStudioRedactionFill(options: {
  patch: ArrayLike<number>;
  columns: number;
  rows: number;
  bandColumns: number;
  bandRows: number;
  style: StudioRedactionStyle;
  seed: string;
  /** `columns` × `rows` flags for the cells that are hidden. Omitted: all of them. */
  hidden?: ArrayLike<number>;
  /** Blur spread in cells; defaults to the style's share of the short side. */
  sigmaColumns?: number;
  sigmaRows?: number;
}): Uint8ClampedArray {
  const columns = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(1, Math.floor(options.rows));
  const bandColumns = Math.max(1, Math.floor(options.bandColumns));
  const bandRows = Math.max(1, Math.floor(options.bandRows));
  const patchColumns = columns + bandColumns * 2;
  const patchRows = rows + bandRows * 2;
  const { patch } = options;
  if (patch.length < patchColumns * patchRows * 4) {
    throw new Error("Redaction patch is smaller than its grid.");
  }
  const hidden = options.hidden ?? null;
  if (hidden && hidden.length < columns * rows) {
    throw new Error("Redaction mask is smaller than its grid.");
  }
  const tuning = TUNING[options.style];
  const isHidden = (column: number, row: number): boolean =>
    column >= 0 && column < columns && row >= 0 && row < rows && (!hidden || Boolean(hidden[row * columns + column]));

  // Colour planes are weighted by how much of each cell is real, visible
  // picture, so cells the image never reached drop out of every average.
  const cells = patchColumns * patchRows;
  const red = new Float32Array(cells);
  const green = new Float32Array(cells);
  const blue = new Float32Array(cells);
  const weight = new Float32Array(cells);
  const sum = [0, 0, 0];
  let total = 0;
  for (let row = 0; row < patchRows; row += 1) {
    for (let column = 0; column < patchColumns; column += 1) {
      if (isHidden(column - bandColumns, row - bandRows)) {
        // Hidden: never read.
        continue;
      }
      const offset = (row * patchColumns + column) * 4;
      const alpha = patch[offset + 3];
      if (!(alpha >= MIN_VALID_ALPHA)) {
        continue;
      }
      const index = row * patchColumns + column;
      const share = alpha / 255;
      red[index] = patch[offset] * share;
      green[index] = patch[offset + 1] * share;
      blue[index] = patch[offset + 2] * share;
      weight[index] = share;
      sum[0] += red[index];
      sum[1] += green[index];
      sum[2] += blue[index];
      total += share;
    }
  }
  const average = total > 0 ? [sum[0] / total, sum[1] / total, sum[2] / total] : [NEUTRAL, NEUTRAL, NEUTRAL];

  // 1. Decoy: every hidden cell becomes a blend of the surroundings reflected
  //    across each end of its hidden run, the nearest end counting most.
  //    Depth is measured against the run's own half length, so along a line
  //    of text the words either side of the box fold in to meet at its centre.
  const acrossRows = hiddenRuns(hidden, rows, columns, columns, 1);
  const acrossColumns = hiddenRuns(hidden, columns, rows, 1, columns);
  const reflect = (accumulator: number[], column: number, row: number, steps: number, halfRun: number): void => {
    const patchColumn = column + bandColumns;
    const patchRow = row + bandRows;
    if (patchColumn < 0 || patchRow < 0 || patchColumn >= patchColumns || patchRow >= patchRows || isHidden(column, row)) {
      return;
    }
    const index = patchRow * patchColumns + patchColumn;
    const present = weight[index];
    if (present <= 0) {
      return;
    }
    const depth = (steps + 0.5) / halfRun;
    const pull = present / (depth * depth);
    accumulator[0] += (red[index] / present) * pull;
    accumulator[1] += (green[index] / present) * pull;
    accumulator[2] += (blue[index] / present) * pull;
    accumulator[3] += pull;
  };
  const decoy = new Float32Array(columns * rows * 3);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!isHidden(column, row)) {
        continue;
      }
      const cell = row * columns + column;
      const accumulator = [
        average[0] * AVERAGE_WEIGHT,
        average[1] * AVERAGE_WEIGHT,
        average[2] * AVERAGE_WEIGHT,
        AVERAGE_WEIGHT,
      ];
      const left = acrossRows.start[cell];
      const right = acrossRows.end[cell];
      const top = acrossColumns.start[cell];
      const bottom = acrossColumns.end[cell];
      const halfAcross = (right - left + 1) / 2;
      const halfDown = (bottom - top + 1) / 2;
      reflect(accumulator, left * 2 - 1 - column, row, column - left, halfAcross);
      reflect(accumulator, right * 2 + 1 - column, row, right - column, halfAcross);
      reflect(accumulator, column, top * 2 - 1 - row, row - top, halfDown);
      reflect(accumulator, column, bottom * 2 + 1 - row, bottom - row, halfDown);
      decoy[cell * 3] = accumulator[0] / accumulator[3];
      decoy[cell * 3 + 1] = accumulator[1] / accumulator[3];
      decoy[cell * 3 + 2] = accumulator[2] / accumulator[3];
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!isHidden(column, row)) {
        continue;
      }
      const cell = row * columns + column;
      const index = (bandRows + row) * patchColumns + bandColumns + column;
      red[index] = decoy[cell * 3];
      green[index] = decoy[cell * 3 + 1];
      blue[index] = decoy[cell * 3 + 2];
      weight[index] = 1;
    }
  }

  // 2. A real blur over the decoy and the real surroundings together, so the
  //    picture melts into the region at its edges the way a blur does.
  if (tuning.blurShare > 0) {
    const fallback = Math.min(columns, rows) * tuning.blurShare;
    const scratch = new Float32Array(cells);
    for (const plane of [red, green, blue, weight]) {
      gaussianBlur(plane, scratch, patchColumns, patchRows, options.sigmaColumns ?? fallback, options.sigmaRows ?? fallback);
    }
  }

  // 3. Frost, then per-cell variation for the mosaic.
  const random = createStudioRedactionGenerator(`${options.style}:${options.seed}`);
  const fill = new Uint8ClampedArray(columns * rows * 4);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = (bandRows + row) * patchColumns + bandColumns + column;
      const present = weight[index];
      const color = present > 1e-4
        ? [red[index] / present, green[index] / present, blue[index] / present]
        : average;
      const jitter = tuning.jitter > 0 ? (random() * 2 - 1) * tuning.jitter : 0;
      const offset = (row * columns + column) * 4;
      // The same lift on every channel: brightness moves, colour does not grey.
      const luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
      const lift = (NEUTRAL - luminance) * FROST + jitter;
      for (let channel = 0; channel < 3; channel += 1) {
        fill[offset + channel] = color[channel] + lift;
      }
      fill[offset + 3] = 255;
    }
  }
  return fill;
}
