import { createStudioImageBoardLayer, type StudioImageBoardLayer } from "../StudioImageBoard";
import { scaleAffine, translateAffine, multiplyAffine, rotateAffine } from "../StudioImageBoardGeometry";
import {
  planStudioImageBoardRedactions,
  rasterizeStudioRedactionMask,
  resolveStudioRedactionGrid,
  synthesizeStudioRedactionFill,
  type StudioRedactionGrid,
  type StudioRedactionStyle,
} from "../StudioImageBoardRedaction";

type Rgba = [number, number, number, number];
type Cell = (column: number, row: number) => Rgba;

const MOSAIC = resolveStudioRedactionGrid({ width: 400, height: 200 }, "pixelate");
const BLUR = resolveStudioRedactionGrid({ width: 400, height: 200 }, "blur");

/**
 * A patch whose surroundings are `around` and whose hidden box is whatever
 * `hidden` returns. Both are addressed in box cells: column 0 is the first
 * hidden column, column −1 the cell just left of the box.
 */
function patch(grid: StudioRedactionGrid, around: Cell, hidden: Cell): Uint8ClampedArray {
  const width = grid.columns + grid.bandColumns * 2;
  const height = grid.rows + grid.bandRows * 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const column = x - grid.bandColumns;
      const row = y - grid.bandRows;
      const inside = column >= 0 && column < grid.columns && row >= 0 && row < grid.rows;
      data.set((inside ? hidden : around)(column, row), (y * width + x) * 4);
    }
  }
  return data;
}

function fill(
  grid: StudioRedactionGrid,
  data: Uint8ClampedArray,
  style: StudioRedactionStyle,
  seed = "layer-1",
  hidden?: Uint8Array
): Uint8ClampedArray {
  return synthesizeStudioRedactionFill({ patch: data, ...grid, style, seed, hidden });
}

function red(result: Uint8ClampedArray, grid: StudioRedactionGrid, column: number, row: number): number {
  return result[(row * grid.columns + column) * 4];
}

const paper: Cell = () => [240, 240, 236, 255];
const nothing: Cell = () => [0, 0, 0, 0];
const secret: Cell = (column, row) => [(column * 53) % 256, (row * 97) % 256, (column * row * 31) % 256, 255];
const busy: Cell = (column, row) => [(column * 37 + row * 11) & 255, (column * 5 + row * 91) & 255, (column * row) & 255, 255];

describe("secure redaction fill", () => {
  it.each([
    ["blur", BLUR],
    ["pixelate", MOSAIC],
  ] as const)("is identical whatever the hidden pixels are (%s)", (style, grid) => {
    const blank = fill(grid, patch(grid, busy, nothing), style);

    expect(Array.from(fill(grid, patch(grid, busy, secret), style))).toEqual(Array.from(blank));
    expect(Array.from(fill(grid, patch(grid, busy, () => [255, 0, 255, 255]), style))).toEqual(Array.from(blank));
  });

  it("covers the whole box with opaque pixels close to its surroundings", () => {
    const result = fill(BLUR, patch(BLUR, paper, () => [0, 0, 0, 255]), "blur");

    expect(result).toHaveLength(BLUR.columns * BLUR.rows * 4);
    for (let offset = 0; offset < result.length; offset += 4) {
      expect(result[offset + 3]).toBe(255);
      // Paper is ~240; nothing of the black interior can pull the fill dark.
      expect(result[offset]).toBeGreaterThan(225);
    }
  });

  it("reflects the surroundings inwards across each edge", () => {
    // One white stripe three cells left of the box, and one three cells above it.
    const stripes: Cell = (column, row) => (column === -4 || row === -4 ? [255, 255, 255, 255] : [20, 20, 20, 255]);
    const result = fill(MOSAIC, patch(MOSAIC, stripes, nothing), "pixelate");
    const middleRow = Math.floor(MOSAIC.rows / 2);
    const middleColumn = Math.floor(MOSAIC.columns / 2);

    // Each stripe reappears the same distance inside the edge it lies beyond.
    expect(red(result, MOSAIC, 3, middleRow)).toBeGreaterThan(red(result, MOSAIC, 1, middleRow) + 40);
    expect(red(result, MOSAIC, 3, middleRow)).toBeGreaterThan(red(result, MOSAIC, 5, middleRow) + 40);
    expect(red(result, MOSAIC, middleColumn, 3)).toBeGreaterThan(red(result, MOSAIC, middleColumn, 1) + 40);
  });

  it("blurs that reflection into a soft gradient", () => {
    const split: Cell = (column) => (column < BLUR.columns / 2 ? [20, 20, 20, 255] : [220, 220, 220, 255]);
    const result = fill(BLUR, patch(BLUR, split, nothing), "blur");
    const row = Math.floor(BLUR.rows / 2);
    const across = Array.from({ length: BLUR.columns }, (_, column) => red(result, BLUR, column, row));

    expect(across[0]).toBeLessThan(60);
    expect(across[BLUR.columns - 1]).toBeGreaterThan(180);
    // Dark to light without a hard step anywhere along the way.
    for (let column = 1; column < across.length; column += 1) {
      expect(across[column]).toBeGreaterThanOrEqual(across[column - 1] - 1);
      expect(across[column] - across[column - 1]).toBeLessThan(40);
    }
  });

  it("keeps colour and shifts only brightness when it frosts the fill", () => {
    const pink: Cell = () => [236, 72, 153, 255];
    const result = fill(BLUR, patch(BLUR, pink, nothing), "blur");

    // Every channel moves by the same small amount, so the hue survives.
    const lift = result[0] - 236;
    expect(Math.abs(lift)).toBeLessThan(8);
    expect(result[1] - 72).toBeCloseTo(lift, 0);
    expect(result[2] - 153).toBeCloseTo(lift, 0);
  });

  it("stays visible as a pane on pure black and pure white", () => {
    const onBlack = fill(BLUR, patch(BLUR, () => [0, 0, 0, 255], nothing), "blur");
    const onWhite = fill(BLUR, patch(BLUR, () => [255, 255, 255, 255], nothing), "blur");

    expect(onBlack[0]).toBeGreaterThanOrEqual(6);
    expect(onBlack[0]).toBeLessThan(16);
    expect(onWhite[0]).toBeLessThanOrEqual(249);
    expect(onWhite[0]).toBeGreaterThan(239);
  });

  it("keeps mosaic blocks distinct on flat surroundings, per layer", () => {
    for (const shade of [0, 255]) {
      const data = patch(MOSAIC, () => [shade, shade, shade, 255], nothing);
      const result = fill(MOSAIC, data, "pixelate");
      const values = new Set<number>();
      for (let offset = 0; offset < result.length; offset += 4) values.add(result[offset]);

      expect(values.size).toBeGreaterThan(8);
      expect(Array.from(fill(MOSAIC, data, "pixelate"))).toEqual(Array.from(result));
      expect(Array.from(fill(MOSAIC, data, "pixelate", "layer-2"))).not.toEqual(Array.from(result));
    }
  });

  it("falls back to the visible surroundings where the band runs off the image", () => {
    const halfOff = fill(BLUR, patch(BLUR, (column) => (column < 0 ? [0, 0, 0, 0] : [200, 60, 60, 255]), nothing), "blur");
    const allOff = fill(BLUR, patch(BLUR, nothing, () => [9, 9, 9, 255]), "blur");

    // Nothing left of the box exists, so the rest of the surroundings fill it.
    expect(halfOff[0]).toBeGreaterThan(160);
    expect(halfOff[1]).toBeLessThan(100);
    // With nothing visible around it, the fill is neutral, never the interior.
    expect(allOff[0]).toBeGreaterThan(100);
    expect(allOff[0]).toBeLessThan(160);
  });

  it("rejects a patch that does not cover its grid", () => {
    expect(() => fill(BLUR, new Uint8ClampedArray(16), "blur")).toThrow("smaller than its grid");
  });

  it("uses roughly square cells, far fewer for the mosaic, and a band past half the box", () => {
    expect(resolveStudioRedactionGrid({ width: 400, height: 100 }, "blur")).toMatchObject({ columns: 128, rows: 32, bandColumns: 77, bandRows: 20 });
    expect(resolveStudioRedactionGrid({ width: 100, height: 400 }, "pixelate")).toMatchObject({ columns: 8, rows: 32, bandColumns: 5, bandRows: 20 });
    expect(resolveStudioRedactionGrid({ width: 5000, height: 10 }, "blur")).toMatchObject({ columns: 256, rows: 32, bandColumns: 154, bandRows: 20 });
    expect(resolveStudioRedactionGrid({ width: 0, height: 0 }, "pixelate")).toMatchObject({ columns: 8, rows: 8, bandColumns: 5, bandRows: 5 });
  });

  it("is the same grid at any zoom, with a blur sized to the box", () => {
    const small = resolveStudioRedactionGrid({ width: 400, height: 100 }, "blur");
    const large = resolveStudioRedactionGrid({ width: 4000, height: 1000 }, "blur");

    expect(large).toEqual(small);
    // 13% of the short side, in cells: 0.13 × 32.
    expect(small.sigmaRows).toBeCloseTo(4.16, 6);
    expect(small.sigmaColumns).toBeCloseTo(4.16, 6);
    expect(resolveStudioRedactionGrid({ width: 400, height: 100 }, "pixelate").sigmaRows).toBe(0);
  });

  it("sizes a merged region for its thinnest box and holds it to a budget", () => {
    // Two line-height boxes spanning a 1000 × 600 region.
    const grid = resolveStudioRedactionGrid({ width: 1000, height: 600, thinnest: 40, thickest: 40 }, "blur");

    expect(grid.columns * grid.rows).toBeLessThanOrEqual(24576 * 1.02);
    expect(grid.columns / grid.rows).toBeCloseTo(1, 1);
    // The blur follows the boxes, not the region around them: 0.13 × 40 px.
    expect((grid.sigmaRows * 600) / grid.rows).toBeCloseTo(5.2, 6);
    expect((grid.sigmaColumns * 1000) / grid.columns).toBeCloseTo(5.2, 6);
  });
});

describe("merged redaction regions", () => {
  /** An L: the top row of the grid and its left column are hidden, the rest is not. */
  function ell(grid: StudioRedactionGrid): Uint8Array {
    const mask = new Uint8Array(grid.columns * grid.rows);
    for (let row = 0; row < grid.rows; row += 1) {
      for (let column = 0; column < grid.columns; column += 1) {
        if (row < grid.rows / 2 || column < grid.columns / 2) mask[row * grid.columns + column] = 1;
      }
    }
    return mask;
  }
  const inEll = (grid: StudioRedactionGrid): Cell => (column, row) =>
    row < grid.rows / 2 || column < grid.columns / 2 ? [255, 0, 255, 255] : busy(column, row);

  it("treats a mask that hides everything exactly like no mask", () => {
    const data = patch(BLUR, busy, nothing);
    const everything = new Uint8Array(BLUR.columns * BLUR.rows).fill(1);

    expect(Array.from(fill(BLUR, data, "blur", "layer-1", everything))).toEqual(Array.from(fill(BLUR, data, "blur")));
  });

  it.each([
    ["blur", BLUR],
    ["pixelate", MOSAIC],
  ] as const)("never reads a hidden cell of an irregular region (%s)", (style, grid) => {
    const mask = ell(grid);
    const visible: Cell = (column, row) => (mask[row * grid.columns + column] ? nothing(column, row) : busy(column, row));
    const blank = fill(grid, patch(grid, busy, visible), style, "layer-1", mask);

    expect(Array.from(fill(grid, patch(grid, busy, inEll(grid)), style, "layer-1", mask))).toEqual(Array.from(blank));
  });

  it("uses the visible notch of an irregular region as surroundings", () => {
    const mask = ell(MOSAIC);
    // The notch (bottom right) is white, everything outside the box is dark.
    const notch: Cell = (column, row) => (mask[row * MOSAIC.columns + column] ? [0, 0, 0, 0] : [255, 255, 255, 255]);
    const result = fill(MOSAIC, patch(MOSAIC, () => [20, 20, 20, 255], notch), "pixelate", "layer-1", mask);
    const lastRow = MOSAIC.rows - 1;

    // Both arms beside the notch reflect it; the far top-left corner does not.
    expect(red(result, MOSAIC, MOSAIC.columns / 2 - 1, lastRow)).toBeGreaterThan(red(result, MOSAIC, 0, 0) + 60);
    expect(red(result, MOSAIC, MOSAIC.columns / 2 + 2, MOSAIC.rows / 2 - 1)).toBeGreaterThan(red(result, MOSAIC, 0, 0) + 60);
  });

  it("rejects a mask that does not cover its grid", () => {
    expect(() => fill(BLUR, patch(BLUR, busy, nothing), "blur", "layer-1", new Uint8Array(4))).toThrow("mask is smaller");
  });

  it("flags the cells whose centre a box covers, upright or turned", () => {
    // A 4 × 2 cell box centred at (3, 2) in a 8 × 4 grid.
    const upright = rasterizeStudioRedactionMask(8, 4, [
      { fromCells: translateAffine(-3, -2), halfWidth: 2, halfHeight: 1 },
    ]);
    expect(Array.from(upright)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 1, 1, 1, 1, 0, 0, 0,
      0, 1, 1, 1, 1, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);

    // The same box turned a quarter: now 2 × 4, hanging off the top and bottom.
    const turned = rasterizeStudioRedactionMask(8, 4, [
      { fromCells: multiplyAffine(rotateAffine(90), translateAffine(-3, -2)), halfWidth: 2, halfHeight: 1 },
    ]);
    expect(Array.from(turned)).toEqual([
      0, 0, 1, 1, 0, 0, 0, 0,
      0, 0, 1, 1, 0, 0, 0, 0,
      0, 0, 1, 1, 0, 0, 0, 0,
      0, 0, 1, 1, 0, 0, 0, 0,
    ]);

    // Cells twice as wide as the box's own units.
    const stretched = rasterizeStudioRedactionMask(4, 1, [
      { fromCells: multiplyAffine(translateAffine(-4, -0.5), scaleAffine(2, 1)), halfWidth: 2, halfHeight: 1 },
    ]);
    expect(Array.from(stretched)).toEqual([0, 1, 1, 0]);
  });
});

describe("which redactions are painted together", () => {
  const base = { width: 1000, height: 500 };
  const layer = (description: Record<string, unknown>): StudioImageBoardLayer =>
    createStudioImageBoardLayer(description as Parameters<typeof createStudioImageBoardLayer>[0]);
  const blur = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): StudioImageBoardLayer =>
    layer({ kind: "redact", style: "blur", id, x, y, width: 0.2, height: 0.1, ...extra });
  const groupsOf = (layers: StudioImageBoardLayer[]): string[][] =>
    Array.from(planStudioImageBoardRedactions(layers, base).groups.values()).map((group) => group.map((member) => member.id));

  it("joins blurs that touch or overlap, through one another if need be", () => {
    const layers = [blur("a", 0.1, 0.1), blur("b", 0.3, 0.1), blur("c", 0.45, 0.15), blur("far", 0.7, 0.7)];
    const plan = planStudioImageBoardRedactions(layers, base);

    // a touches b, b overlaps c; "far" stays on its own.
    expect(groupsOf(layers)).toEqual([["a", "b", "c"]]);
    expect(Array.from(plan.absorbed)).toEqual(["b", "c"]);
  });

  it("keeps different styles apart, and never merges a blackout", () => {
    const layers = [
      blur("a", 0.1, 0.1),
      blur("mosaic", 0.2, 0.1, { style: "pixelate" }),
      blur("black", 0.2, 0.15, { style: "solid" }),
      blur("black-2", 0.25, 0.15, { style: "solid" }),
      blur("mosaic-2", 0.3, 0.15, { style: "pixelate" }),
    ];

    expect(groupsOf(layers)).toEqual([["mosaic", "mosaic-2"]]);
  });

  it("merges past a layer that is out of the way", () => {
    const arrow = layer({ kind: "shape", shape: "arrow", id: "arrow", x: 0.7, y: 0.8, width: 0.2, height: 0.04 });

    expect(groupsOf([blur("a", 0.1, 0.1), arrow, blur("b", 0.3, 0.1)])).toEqual([["a", "b"]]);
  });

  it("will not lift a blur past something it was drawn over", () => {
    // The caption sits under blur b. Painting b down with a would leave it showing.
    const caption = layer({ kind: "text", text: "secret", id: "caption", x: 0.32, y: 0.11, width: 0.15, height: 0.06 });
    const layers = [blur("a", 0.1, 0.1), caption, blur("b", 0.3, 0.1), blur("c", 0.5, 0.1)];

    // b stays at its own place above the caption; c, drawn after it, joins b there.
    expect(groupsOf(layers)).toEqual([["b", "c"]]);
  });

  it("will not lift a blur from over a lens, its area or its beam to under them", () => {
    // The lens itself is far off; blur b covers the area it enlarges.
    const lens = layer({
      kind: "magnify",
      id: "lens",
      source: { x: 0.32, y: 0.12, width: 0.1, height: 0.06 },
      x: 0.6,
      y: 0.6,
      width: 0.2,
      height: 0.12,
    });

    expect(groupsOf([blur("a", 0.1, 0.1), lens, blur("b", 0.3, 0.1)])).toEqual([]);
    // Out of the way of all three, the blurs still join.
    const clear = layer({ ...lens, id: "clear", source: { x: 0.6, y: 0.4, width: 0.1, height: 0.06 } });
    expect(groupsOf([blur("a", 0.1, 0.1), clear, blur("b", 0.3, 0.1)])).toEqual([["a", "b"]]);
  });

  it("gives a wide berth to what a layer may paint past its box", () => {
    // A shadowed caption just above blur b: its shadow could fall into b.
    const caption = layer({ kind: "text", text: "x", style: "shadow", id: "caption", x: 0.3, y: 0.0, width: 0.2, height: 0.09 });

    expect(groupsOf([blur("a", 0.1, 0.1), caption, blur("b", 0.3, 0.1)])).toEqual([]);
  });
});
