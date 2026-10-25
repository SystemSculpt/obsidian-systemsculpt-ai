/** @jest-environment jsdom */
import {
  createEmptyStudioImageBoard,
  createStudioImageBoardLayer,
  type StudioImageBoard,
} from "../StudioImageBoard";
import {
  composeStudioImageBoardAsset,
  renderStudioImageBoard,
  resolveStudioImageBoardOutputSize,
  STUDIO_IMAGE_BOARD_MAX_OUTPUT_SIDE,
} from "../StudioImageBoardRenderer";
import type { StudioAssetRef } from "../types";

const sourceBytes = new TextEncoder().encode("private original image").buffer;
const source = { path: "assets/original.png", hash: "a".repeat(64), sizeBytes: sourceBytes.byteLength, mimeType: "image/png" };
const sticker = { path: "assets/sticker.png", hash: "b".repeat(64), sizeBytes: 4, mimeType: "image/png" };
const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");

type Op = { canvas: HTMLCanvasElement; name: string; args: unknown[]; composite: string };

/** Every canvas gets a context that records what was drawn on it, in order. */
function recordCanvases(): { ops: Op[]; bitmaps: Array<{ close: jest.Mock }> } {
  const ops: Op[] = [];
  const bitmaps: Array<{ close: jest.Mock }> = [];
  const contexts = new WeakMap<HTMLCanvasElement, unknown>();
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const existing = contexts.get(this);
    if (existing) return existing as CanvasRenderingContext2D;
    const canvas = this;
    const state: Record<string, unknown> = { canvas, globalCompositeOperation: "source-over" };
    const record = (name: string) => (...args: unknown[]) => {
      ops.push({ canvas, name, args, composite: String(state.globalCompositeOperation) });
    };
    for (const name of [
      "setTransform", "clearRect", "save", "restore", "drawImage", "fillRect", "beginPath", "rect", "clip",
      "fill", "stroke", "moveTo", "lineTo", "quadraticCurveTo", "closePath", "ellipse", "fillText", "strokeText",
      "putImageData",
    ]) {
      state[name] = record(name);
    }
    // Half an em a character at whatever size the font is set to.
    state.measureText = (text: string) => ({
      width: text.length * Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 16) * 0.5,
    });
    state.getImageData = (...args: number[]) => {
      ops.push({ canvas, name: "getImageData", args, composite: String(state.globalCompositeOperation) });
      return { data: new Uint8ClampedArray(args[2] * args[3] * 4) };
    };
    state.createImageData = (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) });
    state.createPattern = (...args: unknown[]) => {
      ops.push({ canvas, name: "createPattern", args, composite: String(state.globalCompositeOperation) });
      return {};
    };
    state.createLinearGradient = (...args: number[]) => {
      ops.push({ canvas, name: "createLinearGradient", args, composite: String(state.globalCompositeOperation) });
      return { addColorStop: () => undefined };
    };
    contexts.set(this, state);
    return state as unknown as CanvasRenderingContext2D;
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: jest.fn(async () => {
      const bitmap = { width: 1600, height: 900, close: jest.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    }),
  });
  return { ops, bitmaps };
}

function encodeAs(bytes: number[]): ArrayBuffer {
  const encoded = new Uint8Array(bytes).buffer;
  jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback({ arrayBuffer: async () => encoded } as Blob);
  });
  return encoded;
}

function boardWith(...descriptions: Array<Parameters<typeof createStudioImageBoardLayer>[0]>): StudioImageBoard {
  const board = createEmptyStudioImageBoard();
  board.layers.push(...descriptions.map((description) => createStudioImageBoardLayer(description)));
  return board;
}

afterEach(() => {
  jest.restoreAllMocks();
  if (bitmapDescriptor) Object.defineProperty(globalThis, "createImageBitmap", bitmapDescriptor);
  else Reflect.deleteProperty(globalThis, "createImageBitmap");
});

describe("image board export", () => {
  it("hands back the node image untouched when nothing was edited", async () => {
    const readAsset = jest.fn();
    const storeAsset = jest.fn();

    await expect(
      composeStudioImageBoardAsset({ baseImage: source, board: createEmptyStudioImageBoard(), readAsset, storeAsset })
    ).resolves.toBe(source);
    expect(readAsset).not.toHaveBeenCalled();
    expect(storeAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["redaction", boardWith({ kind: "redact" })],
    ["crop", { ...createEmptyStudioImageBoard(), crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
    ["caption", boardWith({ kind: "text", text: "Caption" })],
  ] as const)("refuses to export a %s when there is no canvas to flatten it on", async (_edit, board) => {
    recordCanvases();
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const storeAsset = jest.fn();

    await expect(
      composeStudioImageBoardAsset({ baseImage: source, board, readAsset: async () => sourceBytes, storeAsset })
    ).rejects.toThrow("Image rendering is unavailable");
    // Nothing recoverable, and nothing misleading, is ever published.
    expect(storeAsset).not.toHaveBeenCalled();
  });

  it("refuses to export when the source cannot be decoded, and never falls back to embedding it", async () => {
    recordCanvases();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: jest.fn(async () => {
        throw new Error("decode failed");
      }),
    });
    const storeAsset = jest.fn();

    await expect(
      composeStudioImageBoardAsset({ baseImage: source, board: boardWith({ kind: "redact" }), readAsset: async () => sourceBytes, storeAsset })
    ).rejects.toThrow("decode failed");
    expect(storeAsset).not.toHaveBeenCalled();
  });

  it("stores the flattened PNG and releases every decoded image", async () => {
    const { bitmaps } = recordCanvases();
    const encoded = encodeAs([7, 8, 9]);
    const stored = { ...source, path: "assets/edited.png" };
    const storeAsset = jest.fn(async () => stored);
    const readAsset = jest.fn(async (_asset: StudioAssetRef) => sourceBytes);
    const board = boardWith(
      { kind: "image", asset: sticker },
      { kind: "image", asset: sticker, x: 0.6 },
      { kind: "text", text: "top text" }
    );

    await expect(composeStudioImageBoardAsset({ baseImage: source, board, readAsset, storeAsset })).resolves.toBe(stored);

    expect(storeAsset).toHaveBeenCalledWith(encoded, "image/png");
    // The node image plus one decode for the picture stacked twice.
    expect(readAsset.mock.calls.map(([asset]) => asset.path)).toEqual([source.path, sticker.path]);
    expect(bitmaps).toHaveLength(2);
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("releases decoded images when rendering fails part-way", async () => {
    const { bitmaps } = recordCanvases();
    jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));

    await expect(
      renderStudioImageBoard({ board: boardWith({ kind: "highlight" }), baseImage: source, readAsset: async () => sourceBytes })
    ).rejects.toThrow("could not be encoded");
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
  });

  it("sizes the output to the frame, including space added past the image", async () => {
    recordCanvases();
    encodeAs([1]);

    const cropped = await renderStudioImageBoard({
      board: { ...createEmptyStudioImageBoard(), crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } },
      baseImage: source,
      readAsset: async () => sourceBytes,
    });
    const expanded = await renderStudioImageBoard({
      board: { ...createEmptyStudioImageBoard(), crop: { x: -0.5, y: 0, width: 2, height: 1 } },
      baseImage: source,
      readAsset: async () => sourceBytes,
    });

    expect([cropped.width, cropped.height]).toEqual([800, 225]);
    expect([expanded.width, expanded.height]).toEqual([3200, 900]);
    expect(cropped.mimeType).toBe("image/png");
  });

  it("caps an enormous output without changing its shape", () => {
    const size = resolveStudioImageBoardOutputSize(createEmptyStudioImageBoard(), { width: 32768, height: 8192 });

    expect(size).toEqual({ width: STUDIO_IMAGE_BOARD_MAX_OUTPUT_SIDE, height: 2048 });
  });

  it("paints nothing for a deleted background, leaving the output transparent", async () => {
    const { ops } = recordCanvases();
    encodeAs([1]);
    const board = { ...boardWith({ kind: "shape", shape: "ellipse" }), layers: [createStudioImageBoardLayer({ kind: "shape", shape: "ellipse" })] };

    await renderStudioImageBoard({ board, baseImage: source, readAsset: async () => sourceBytes });

    expect(ops.some((op) => op.name === "clearRect")).toBe(true);
    expect(ops.filter((op) => op.name === "drawImage")).toEqual([]);
    expect(ops.some((op) => op.name === "ellipse")).toBe(true);
  });
});

describe("image board redaction on canvas", () => {
  const box = { x: 0.25, y: 0.25, width: 0.5, height: 0.25 };
  const render = async (...layers: Array<Parameters<typeof createStudioImageBoardLayer>[0]>) => {
    const { ops } = recordCanvases();
    encodeAs([1]);
    await renderStudioImageBoard({ board: boardWith(...layers), baseImage: source, readAsset: async () => sourceBytes });
    const output = ops.find((op) => op.name === "clearRect")!.canvas;
    return { ops, output, on: (name: string) => ops.filter((op) => op.canvas === output && op.name === name) };
  };
  /** The corners of every closed outline laid on the output, in order. */
  const outlines = (ops: Op[], output: HTMLCanvasElement): number[][][] => {
    const paths: number[][][] = [];
    for (const op of ops) {
      if (op.canvas !== output) continue;
      if (op.name === "moveTo") paths.push([op.args as number[]]);
      else if (op.name === "lineTo") paths[paths.length - 1]?.push(op.args as number[]);
    }
    return paths;
  };

  it("erases the hidden region from a copy before anything samples it", async () => {
    const { ops, output } = await render({ kind: "redact", style: "blur", ...box });

    const copyDraw = ops.findIndex((op) => op.name === "drawImage" && op.args[0] === output);
    const copy = ops[copyDraw].canvas;
    const erase = ops.findIndex((op) => op.canvas === copy && op.name === "fillRect" && op.composite === "destination-out");
    const sample = ops.findIndex((op) => op.name === "drawImage" && op.args[0] === copy);
    const read = ops.findIndex((op) => op.name === "getImageData");
    const paint = ops.findIndex((op, index) => index > read && op.canvas === output && op.name === "drawImage");

    expect(copy).not.toBe(output);
    expect(copyDraw).toBeGreaterThan(-1);
    // copy → erase → shrink → read → paint, strictly in that order.
    expect(erase).toBeGreaterThan(copyDraw);
    expect(sample).toBeGreaterThan(erase);
    expect(read).toBeGreaterThan(sample);
    expect(paint).toBeGreaterThan(read);

    // The erased rectangle is the 800×225 px box plus two guard pixels a side.
    const [x, y, width, height] = ops[erase].args as number[];
    expect(width).toBeCloseTo(804, 5);
    expect(height).toBeCloseTo(229, 5);
    expect(x).toBeCloseTo(-402, 5);
    expect(y).toBeCloseTo(-114.5, 5);

    // The only pixels ever read back are the small patch, never the output.
    const reads = ops.filter((op) => op.name === "getImageData");
    expect(reads.every((op) => op.canvas !== output && op.canvas !== copy)).toBe(true);
    // The patch spans the box and its band of surroundings: (114 + 2·69) × (32 + 2·20) cells.
    expect(reads[0].args).toEqual([0, 0, 252, 72]);
  });

  it("replaces the hidden pixels outright before the fill is laid over them", async () => {
    const { ops, output } = await render({ kind: "redact", style: "blur", ...box });

    const clip = ops.findIndex((op) => op.canvas === output && op.name === "clip");
    const blank = ops.findIndex((op, index) => index > clip && op.canvas === output && op.name === "fillRect");
    const paint = ops.findIndex((op, index) => index > clip && op.canvas === output && op.name === "drawImage");

    // Clipped to the cover, an opaque fill of the whole canvas, then the image:
    // nothing of the original can show through a fill that is a hair short of opaque.
    expect(clip).toBeGreaterThan(ops.findIndex((op) => op.name === "getImageData"));
    expect(blank).toBeGreaterThan(clip);
    expect(ops[blank].args).toEqual([0, 0, 1600, 900]);
    expect(ops[blank].composite).toBe("source-over");
    expect(paint).toBeGreaterThan(blank);
    // The image overshoots the cover by two more pixels a side, so its soft
    // edge is clipped away rather than showing the underlay as a hairline.
    expect((ops[paint].args as number[]).slice(1)).toEqual([-403, -115.5, 806, 231]);
  });

  it.each(["blur", "pixelate", "solid"] as const)(
    "covers one pixel past the box so no edge pixel is left half-hidden (%s)",
    async (style) => {
      const { ops, output } = await render({ kind: "redact", style, ...box });

      // The 800×225 px box at (400, 225), grown by a pixel on every side.
      expect(outlines(ops, output)).toEqual([[[399, 224], [1201, 224], [1201, 451], [399, 451]]]);
    }
  );

  it("finishes a blur with grain and leaves the mosaic crisp", async () => {
    const blurred = await render({ kind: "redact", style: "blur", ...box });
    const pattern = blurred.ops.findIndex((op) => op.canvas === blurred.output && op.name === "createPattern");
    const clip = blurred.ops.findIndex((op) => op.canvas === blurred.output && op.name === "clip");
    // The grain is laid inside the same clip as the fill, over the whole canvas.
    expect(pattern).toBeGreaterThan(clip);
    expect(blurred.ops.slice(pattern).some((op) => op.canvas === blurred.output && op.name === "fillRect")).toBe(true);
    jest.restoreAllMocks();

    const mosaic = await render({ kind: "redact", style: "pixelate", ...box });
    expect(mosaic.ops.some((op) => op.name === "createPattern")).toBe(false);
  });

  it("paints a blackout without reading any pixels at all", async () => {
    const { ops, on } = await render({ kind: "redact", style: "solid" });

    expect(ops.some((op) => op.name === "getImageData")).toBe(false);
    expect(on("fill")).toHaveLength(1);
  });

  it("hides what a later redaction covers from an earlier one's surroundings", async () => {
    // Two blurs well apart, and a blackout: three separate redactions.
    const { ops, output } = await render(
      { kind: "redact", style: "blur", x: 0.05, y: 0.1, width: 0.2, height: 0.1 },
      { kind: "redact", style: "blur", x: 0.6, y: 0.6, width: 0.2, height: 0.1 },
      { kind: "redact", style: "solid", x: 0.3, y: 0.3, width: 0.1, height: 0.1 }
    );

    const copy = ops.find((op) => op.name === "drawImage" && op.args[0] === output)!.canvas;
    const reads = ops.map((op, index) => (op.name === "getImageData" ? index : -1)).filter((index) => index >= 0);
    const erasedBefore = (index: number, from: number): number =>
      ops.slice(from, index).filter((op) => op.canvas === copy && op.name === "fillRect" && op.composite === "destination-out").length;

    expect(reads).toHaveLength(2);
    // The first blur samples with all three regions gone, the second with its own and the blackout's.
    expect(erasedBefore(reads[0], 0)).toBe(3);
    expect(erasedBefore(reads[1], reads[0])).toBe(2);
  });

  it("paints blurs that touch as one region with one fill", async () => {
    const { ops, output, on } = await render(
      { kind: "redact", style: "blur", x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
      { kind: "redact", style: "blur", x: 0.5, y: 0.375, width: 0.25, height: 0.25 }
    );

    // One sample, one clip, one fill image for the pair.
    expect(ops.filter((op) => op.name === "getImageData")).toHaveLength(1);
    expect(on("clip")).toHaveLength(1);
    // The node image, then a single fill.
    expect(on("drawImage")).toHaveLength(2);
    // The clip is both covers together.
    expect(outlines(ops, output)).toEqual([
      [[399, 224], [801, 224], [801, 451], [399, 451]],
      [[799, 336.5], [1201, 336.5], [1201, 563.5], [799, 563.5]],
    ]);
    // The patch covers the bounds of both: 800 × 337.5 px, sized for the 225 px boxes.
    const [, , patchColumns, patchRows] = ops.find((op) => op.name === "getImageData")!.args as number[];
    expect(patchColumns / patchRows).toBeCloseTo(800 / 337.5, 1);
  });
});

describe("image board magnifier on canvas", () => {
  // On the 1600×900 picture: the area is the 400×225 px at (400, 225); the lens shows it at twice the size.
  const lens = {
    kind: "magnify" as const,
    source: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
    x: 0.5,
    y: 0.5,
    width: 0.5,
    height: 0.5,
  };
  const render = async (
    layers: Array<Parameters<typeof createStudioImageBoardLayer>[0]>,
    crop: StudioImageBoard["crop"] = null
  ) => {
    const { ops } = recordCanvases();
    encodeAs([1]);
    await renderStudioImageBoard({ board: { ...boardWith(...layers), crop }, baseImage: source, readAsset: async () => sourceBytes });
    const output = ops.find((op) => op.name === "clearRect")!.canvas;
    // The only draw onto the output that takes part of another canvas.
    const shown = ops.findIndex((op) => op.canvas === output && op.name === "drawImage" && op.args.length === 9);
    const glass = ops[shown].args[0] as HTMLCanvasElement;
    return {
      ops,
      output,
      shown,
      glass,
      on: (canvas: HTMLCanvasElement, name: string) => ops.filter((op) => op.canvas === canvas && op.name === name),
    };
  };

  it("paints its area afresh at the picture's own pixel size, and only then enlarges it", async () => {
    const { ops, output, shown, glass, on } = await render([lens]);

    // The glass is the area pixel for pixel: the node image is drawn into it, not a copy of the output.
    expect(glass).not.toBe(output);
    expect(on(glass, "clearRect")[0].args).toEqual([0, 0, 400, 225]);
    const painted = on(glass, "drawImage");
    expect(painted).toHaveLength(1);
    expect(painted[0].args[0]).not.toBeInstanceOf(HTMLCanvasElement);
    expect(ops.indexOf(painted[0])).toBeLessThan(shown);
    // All of it goes into the 800×450 px lens, inside the lens outline, onto glass emptied first.
    expect(ops[shown].args.slice(1)).toEqual([0, 0, 400, 225, -400, -225, 800, 450]);
    const clip = ops.slice(0, shown).map((op) => op.canvas === output && op.name === "clip").lastIndexOf(true);
    const emptied = ops.findIndex((op, index) => index > clip && op.canvas === output && op.name === "clearRect");
    expect(clip).toBeGreaterThan(-1);
    expect(emptied).toBeGreaterThan(clip);
    expect(emptied).toBeLessThan(shown);
  });

  it("ties the lens to its area with a beam of light and outlines both", async () => {
    const { ops, output, shown, on } = await render([lens]);

    // The beam runs from the middle of the area to the middle of the lens...
    const light = on(output, "createLinearGradient");
    expect(light).toHaveLength(1);
    expect(light[0].args).toEqual([600, 337.5, 1200, 675]);
    // ...and fills everything between the two but the area itself.
    const beam = ops.findIndex((op) => op.canvas === output && op.name === "fill" && op.args[0] === "evenodd");
    expect(beam).toBeGreaterThan(ops.indexOf(light[0]));
    expect(beam).toBeLessThan(shown);
    // Before the glass: the beam's edge and the area's two-tone outline. After it: the rim's three lines.
    const strokes = on(output, "stroke").map((op) => ops.indexOf(op));
    expect(strokes.filter((index) => index < shown)).toHaveLength(3);
    expect(strokes.filter((index) => index > shown)).toHaveLength(3);
    // The lens casts its shadow from a plain fill laid down before the glass.
    expect(ops.slice(beam + 1, shown).some((op) => op.canvas === output && op.name === "fill")).toBe(true);
  });

  it("draws a round lens, and its area, as ellipses", async () => {
    const { output, on } = await render([{ ...lens, shape: "ellipse" }]);

    // Area outline twice, then the lens: shadow, clip, and three rim lines.
    expect(on(output, "ellipse")).toHaveLength(7);
    expect(on(output, "quadraticCurveTo")).toHaveLength(0);
  });

  it("never shows what a blur drawn over its area hides", async () => {
    // The blur is above the lens in the stack and inside the area the lens enlarges.
    const { ops, output, shown, glass, on } = await render([
      lens,
      { kind: "redact", style: "blur", x: 0.3, y: 0.3, width: 0.1, height: 0.1 },
    ]);

    // The blur is painted into the glass, replacing what it hides, before the lens shows any of it.
    const hidden = ops.findIndex((op) => op.canvas === glass && op.name === "clip");
    const replaced = ops.findIndex((op, index) => index > hidden && op.canvas === glass && op.name === "fillRect");
    expect(hidden).toBeGreaterThan(ops.indexOf(on(glass, "drawImage")[0]));
    expect(replaced).toBeGreaterThan(hidden);
    expect(ops[replaced].args).toEqual([0, 0, 400, 225]);
    expect(replaced).toBeLessThan(shown);
    // Nothing is ever read back from the glass or the output: only the small patches.
    expect(ops.filter((op) => op.name === "getImageData").every((op) => op.canvas !== glass && op.canvas !== output)).toBe(true);
    // And the blur is still painted on the picture itself, where it sits in the stack.
    expect(ops.slice(shown).some((op) => op.canvas === output && op.name === "clip")).toBe(true);
  });

  it("shows a blur beneath it as the blur, not as what it covers", async () => {
    const { ops, shown, glass } = await render([
      { kind: "redact", style: "blur", x: 0.3, y: 0.3, width: 0.1, height: 0.1 },
      lens,
    ]);

    const hidden = ops.findIndex((op) => op.canvas === glass && op.name === "clip");
    expect(hidden).toBeGreaterThan(-1);
    expect(hidden).toBeLessThan(shown);
  });

  it("paints into the glass only what its area can see", async () => {
    // A blur and a caption in the far corner, nowhere near the area.
    const { output, glass, on } = await render([
      { kind: "text", text: "far", x: 0.8, y: 0.05, width: 0.15, height: 0.1 },
      lens,
      { kind: "redact", style: "blur", x: 0.8, y: 0.8, width: 0.1, height: 0.1 },
    ]);

    expect(on(glass, "fillText")).toHaveLength(0);
    expect(on(glass, "clip")).toHaveLength(0);
    expect(on(output, "fillText")).toHaveLength(1);
  });

  it("shows nothing that a crop cut off", async () => {
    // The crop keeps the right-hand 60%: only the area's right 160 px survive.
    const { ops, shown, glass } = await render([lens], { x: 0.4, y: 0, width: 0.6, height: 1 });

    const kept = ops.findIndex((op) => op.canvas === glass && op.name === "fillRect" && op.composite === "destination-in");
    expect(kept).toBeGreaterThan(-1);
    expect(kept).toBeLessThan(shown);
    expect(ops[kept].args).toEqual([640, 0, 960, 900]);
  });
});
