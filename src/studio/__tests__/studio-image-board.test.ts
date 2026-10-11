import {
  createEmptyStudioImageBoard,
  createStudioImageBoardLayer,
  readStudioImageBoard,
  resolveStudioImageBoardRenderedAsset,
  serializeStudioImageBoard,
  STUDIO_IMAGE_BOARD_CONFIG_KEY,
  studioImageBoardArrowThicknessPx,
  studioImageBoardDrawingKey,
  studioImageBoardHasBase,
  studioImageBoardHasEdits,
  studioImageBoardLensAtZoom,
  studioImageBoardLensForArea,
  studioImageBoardLensOver,
  studioImageBoardLensView,
  studioImageBoardLensZoom,
  studioImageBoardOutputFrame,
  studioImageBoardWithoutRender,
  studioImageBoardWithRender,
  writeStudioImageBoard,
} from "../StudioImageBoard";
import {
  applyAffine,
  boxBetweenPoints,
  boxBounds,
  boxesTouch,
  hitTestBox,
  invertAffine,
  multiplyAffine,
  resizeBox,
  rotateAffine,
  rotationToward,
  snapFrameMove,
  snapFrameResize,
  snapPointToLines,
  translateAffine,
  convexHull,
  keepFrameWithin,
} from "../StudioImageBoardGeometry";
import type { StudioJsonValue, StudioNodeInstance } from "../types";

const RENDERED = { hash: "r".repeat(64), path: "assets/rendered.png", mimeType: "image/png", sizeBytes: 12 };
const STICKER = { hash: "s".repeat(64), path: "assets/sticker.png", mimeType: "image/png", sizeBytes: 9 };

function node(config: Record<string, StudioJsonValue>): StudioNodeInstance {
  return {
    id: "media",
    kind: "studio.media_ingest",
    version: "1.0.0",
    title: "Media",
    position: { x: 0, y: 0 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

describe("image board state", () => {
  it("is just the node image until something is added", () => {
    const board = readStudioImageBoard({});

    expect(board.layers).toEqual([{ id: "base", kind: "base", x: 0, y: 0, width: 1, height: 1, rotation: 0 }]);
    expect(board.crop).toBeNull();
    expect(studioImageBoardHasEdits(board)).toBe(false);
    expect(studioImageBoardOutputFrame(board)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("defaults new text to the meme style", () => {
    expect(createStudioImageBoardLayer({ kind: "text", text: "hi" })).toMatchObject({
      kind: "text",
      style: "meme",
      color: "#ffffff",
      align: "center",
    });
  });

  it("round-trips every layer kind through the persisted form", () => {
    const board = createEmptyStudioImageBoard();
    board.layers.push(
      createStudioImageBoardLayer({ kind: "image", asset: STICKER, x: 0.2, y: 0.2, width: 0.3, height: 0.2, rotation: 12 }),
      createStudioImageBoardLayer({ kind: "redact", style: "pixelate", x: 0.1, y: 0.5, width: 0.4, height: 0.1 }),
      createStudioImageBoardLayer({ kind: "highlight", color: "#34c759" }),
      createStudioImageBoardLayer({
        kind: "magnify",
        source: { x: 0.1, y: 0.7, width: 0.1, height: 0.1 },
        shape: "ellipse",
        color: "#0a84ff",
        x: 0.5,
        y: 0.1,
        width: 0.3,
        height: 0.3,
        rotation: 8,
      }),
      createStudioImageBoardLayer({ kind: "shape", shape: "arrow", rotation: -45, strokeWidth: 0.016 }),
      createStudioImageBoardLayer({ kind: "text", text: "top\ntext", style: "banner", align: "left", color: "#ffe600" })
    );
    board.crop = { x: -0.1, y: 0.1, width: 1.3, height: 0.8 };

    const restored = readStudioImageBoard({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(board) });

    expect(restored.layers).toEqual(board.layers);
    expect(restored.crop).toEqual(board.crop);
  });

  it("gives a lens with no area the middle of its own box, at double size", () => {
    const lens = createStudioImageBoardLayer({ kind: "magnify", x: 0.2, y: 0.4, width: 0.4, height: 0.2 });

    expect(lens).toMatchObject({ kind: "magnify", shape: "rect", color: "#ffe600" });
    if (lens.kind !== "magnify") throw new Error("expected a lens");
    expect(lens.source.x).toBeCloseTo(0.3, 9);
    expect(lens.source.y).toBeCloseTo(0.45, 9);
    expect(lens.source.width).toBeCloseTo(0.2, 9);
    expect(lens.source.height).toBeCloseTo(0.1, 9);
    expect(createStudioImageBoardLayer({ kind: "magnify", shape: "star", color: "glow", source: "there" })).toMatchObject({
      shape: "rect",
      color: "#ffe600",
    });
  });

  it("reads a lens's zoom from its size, and resizes it away from its area for another", () => {
    // Up and to the right of its area, 0.3 away across and 0.3 away down.
    const lens = { x: 0.5, y: 0.1, width: 0.3, height: 0.3, source: { x: 0.1, y: 0.7, width: 0.1, height: 0.1 } };

    expect(studioImageBoardLensZoom(lens)).toBeCloseTo(3, 9);
    expect(studioImageBoardLensView(lens)).toEqual(lens.source);

    // The corner nearest the area stays where it is.
    const doubled = studioImageBoardLensAtZoom(lens, 2);
    expect(doubled.x).toBeCloseTo(0.5, 9);
    expect(doubled.y + doubled.height).toBeCloseTo(0.4, 9);
    expect(doubled.width).toBeCloseTo(0.2, 9);
    expect(doubled.height).toBeCloseTo(0.2, 9);

    // Straight above its area instead, it grows evenly to either side.
    const above = { ...lens, x: 0, y: 0.1 };
    const larger = studioImageBoardLensAtZoom(above, 4);
    expect(larger.x + larger.width / 2).toBeCloseTo(0.15, 9);
    expect(larger.y + larger.height).toBeCloseTo(0.4, 9);
  });

  it("keeps a lens's zoom and its distance when its area is adjusted", () => {
    const lens = { x: 0.5, y: 0.1, width: 0.3, height: 0.3, source: { x: 0.1, y: 0.7, width: 0.1, height: 0.1 } };

    // The area's right edge moves 0.05 towards the lens: the lens gives way by as much, and widens.
    const area = { x: 0.1, y: 0.7, width: 0.15, height: 0.1 };
    const wider = studioImageBoardLensForArea(lens, area);
    expect(wider.x).toBeCloseTo(0.55, 9);
    expect(wider.width).toBeCloseTo(0.45, 9);
    expect(wider.y).toBeCloseTo(0.1, 9);
    expect(wider.height).toBeCloseTo(0.3, 9);
    expect(studioImageBoardLensZoom({ ...wider, source: area })).toBeCloseTo(3, 9);

    // The area's top edge moves up 0.1: the lens keeps its 0.3 clearance above it.
    const taller = studioImageBoardLensForArea(lens, { x: 0.1, y: 0.6, width: 0.1, height: 0.2 });
    expect(taller.height).toBeCloseTo(0.6, 9);
    expect(taller.y + taller.height).toBeCloseTo(0.3, 9);
  });

  it("widens what a stretched lens shows rather than distorting it or leaving any of the area out", () => {
    // Twice as wide as its area needs at 3×: it shows twice the width, around the same middle.
    const lens = { x: 0.2, y: 0.1, width: 0.6, height: 0.3, source: { x: 0.1, y: 0.7, width: 0.1, height: 0.1 } };

    const view = studioImageBoardLensView(lens);
    expect(studioImageBoardLensZoom(lens)).toBeCloseTo(3, 9);
    expect(view.width).toBeCloseTo(0.2, 9);
    expect(view.height).toBeCloseTo(0.1, 9);
    expect(view.x + view.width / 2).toBeCloseTo(0.15, 9);
    expect(view.y + view.height / 2).toBeCloseTo(0.75, 9);
    // Everything that was marked is inside what the lens shows.
    expect(view.x).toBeLessThanOrEqual(lens.source.x);
    expect(view.x + view.width).toBeGreaterThanOrEqual(lens.source.x + lens.source.width);
    expect(view.y).toBeCloseTo(lens.source.y, 9);

    // Stretched the other way, it is the height that gains.
    const tall = studioImageBoardLensView({ ...lens, width: 0.2, height: 0.6, source: lens.source });
    expect(tall.width).toBeCloseTo(0.1, 9);
    expect(tall.height).toBeCloseTo(0.3, 9);
  });

  it("sizes an arrow's box from its stroke and the picture's short side", () => {
    expect(studioImageBoardArrowThicknessPx(0.008, { width: 2000, height: 1000 })).toBeCloseTo(36, 9);
    expect(studioImageBoardArrowThicknessPx(0.016, { width: 500, height: 1000 })).toBeCloseTo(36, 9);
  });

  it("lands a new lens beside the area it enlarges, on the nearest side with room", () => {
    const unit = { x: 0, y: 0, width: 1, height: 1 };
    const base = { width: 1000, height: 1000 };
    const overlaps = (a: typeof unit, b: typeof unit): boolean =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    // Room all round: straight above, at twice the size, a gap away.
    const area = { x: 0.45, y: 0.6, width: 0.1, height: 0.06 };
    const above = studioImageBoardLensOver(area, unit, base);
    expect(above.width).toBeCloseTo(0.2, 9);
    expect(above.height).toBeCloseTo(0.12, 9);
    expect(above.x + above.width / 2).toBeCloseTo(0.5, 9);
    expect(above.y + above.height).toBeLessThan(area.y);
    expect(above.y + above.height).toBeGreaterThan(area.y - 0.06);

    // Against the top edge there is no room above: it goes below instead.
    const top = { x: 0.45, y: 0.02, width: 0.1, height: 0.06 };
    const below = studioImageBoardLensOver(top, unit, base);
    expect(below.y).toBeGreaterThan(top.y + top.height);
    expect(below.y + below.height).toBeLessThanOrEqual(1);

    // A wide strip across the middle: nowhere fits at double size, so it lands gentler.
    const strip = { x: 0.2, y: 0.4, width: 0.6, height: 0.2 };
    const gentle = studioImageBoardLensOver(strip, unit, base);
    expect(gentle.width).toBeCloseTo(0.9, 9);
    expect(overlaps(gentle, strip)).toBe(false);
    for (const lens of [above, below]) {
      expect(overlaps(lens, unit)).toBe(true);
    }
    expect(overlaps(above, area)).toBe(false);
    expect(overlaps(below, top)).toBe(false);
  });

  it("measures the gap to a new lens in pixels, not in stretched units", () => {
    // On a wide picture a square area gets a square lens with the same gap as on a square one.
    const lens = studioImageBoardLensOver(
      { x: 0.475, y: 0.6, width: 0.05, height: 0.1 },
      { x: 0, y: 0, width: 1, height: 1 },
      { width: 2000, height: 1000 }
    );

    expect(lens.width * 2000).toBeCloseTo(200, 6);
    expect(lens.height * 1000).toBeCloseTo(200, 6);
    expect((0.6 - (lens.y + lens.height)) * 1000).toBeCloseTo(70, 6);
  });

  it("drops what it cannot trust instead of guessing", () => {
    const board = readStudioImageBoard({
      [STUDIO_IMAGE_BOARD_CONFIG_KEY]: {
        version: 2,
        layers: [
          { kind: "base" },
          { kind: "base", x: 0.5 },
          { kind: "sparkles", id: "unknown" },
          { kind: "image", id: "no-asset" },
          { kind: "text", id: "same", text: "first" },
          { kind: "text", id: "same", text: "second" },
          { kind: "shape", id: "wild", width: 9999, height: -4, rotation: 725, strokeWidth: 50, color: "red" },
          "not a layer",
        ],
        crop: { x: 0, y: 0, width: "wide", height: 1 },
      },
    });

    expect(board.layers.map((layer) => layer.id)).toEqual(["base", "same", "wild"]);
    expect(board.layers[1]).toMatchObject({ kind: "text", text: "first" });
    expect(board.layers[2]).toMatchObject({ width: 16, height: 0.004, rotation: 5, strokeWidth: 0.06, color: "#ff3b30" });
    expect(board.crop).toBeNull();
  });

  it("knows an edit from a no-op", () => {
    const pristine = createEmptyStudioImageBoard();
    const emptyText = { ...pristine, layers: [...pristine.layers, createStudioImageBoardLayer({ kind: "text", text: "  " })] };
    const moved = { ...pristine, layers: [{ ...pristine.layers[0], x: 0.1 }] };
    const transparent = { ...pristine, layers: [] };

    expect(studioImageBoardHasEdits(emptyText)).toBe(false);
    expect(studioImageBoardHasEdits(moved)).toBe(true);
    expect(studioImageBoardHasEdits(transparent)).toBe(true);
    expect(studioImageBoardHasBase(transparent)).toBe(false);
    expect(studioImageBoardHasEdits({ ...pristine, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } })).toBe(true);
    expect(
      studioImageBoardHasEdits({ ...pristine, layers: [...pristine.layers, createStudioImageBoardLayer({ kind: "redact" })] })
    ).toBe(true);
  });

  it("keeps a cached render only for the source it was made from", () => {
    const board = createEmptyStudioImageBoard();
    const config = {
      [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(
        studioImageBoardWithRender(board, board, "assets/source.png", RENDERED)
      ),
    };

    expect(resolveStudioImageBoardRenderedAsset(config, "assets/source.png")).toEqual(RENDERED);
    expect(resolveStudioImageBoardRenderedAsset(config, "")).toEqual(RENDERED);
    expect(resolveStudioImageBoardRenderedAsset(config, "assets/other.png")).toBeNull();
    expect(resolveStudioImageBoardRenderedAsset({}, "assets/source.png")).toBeNull();
  });
});

describe("image board cached render", () => {
  const save = (board: Parameters<typeof serializeStudioImageBoard>[0]) => ({
    [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(board),
  });

  /** One of every kind of layer, each away from its defaults, under a crop. */
  function busyBoard() {
    const board = createEmptyStudioImageBoard();
    board.layers.push(
      createStudioImageBoardLayer({ kind: "image", asset: STICKER, x: 0.11, y: 0.22, width: 0.31, height: 0.17, rotation: 12.5 }),
      createStudioImageBoardLayer({ kind: "text", text: "Top\ntext", style: "banner", align: "right", color: "#0A84FF", x: 0.05, y: 0.6, width: 0.9, height: 0.15 }),
      createStudioImageBoardLayer({ kind: "shape", shape: "arrow", color: "#34c759", strokeWidth: 0.016, x: 0.3, y: 0.3, width: 0.2, height: 0.05, rotation: 33 }),
      createStudioImageBoardLayer({ kind: "highlight", color: "#ffe600", x: 0.1, y: 0.4, width: 0.3, height: 0.07 }),
      createStudioImageBoardLayer({ kind: "redact", style: "pixelate", x: 0.5, y: 0.5, width: 0.2, height: 0.1 }),
      createStudioImageBoardLayer({ kind: "magnify", shape: "ellipse", color: "#ff3b30", x: 0.6, y: 0.1, width: 0.3, height: 0.2, source: { x: 0.2, y: 0.2, width: 0.1, height: 0.0666 } })
    );
    board.crop = { x: -0.1, y: 0.05, width: 1.2, height: 0.9 };
    return board;
  }

  it("survives being saved and read back, whatever the board holds", () => {
    const board = busyBoard();
    const config = save(studioImageBoardWithRender(board, board, "assets/source.png", RENDERED));

    const read = readStudioImageBoard(config);
    expect(read.lastRenderedAsset).toEqual(RENDERED);
    expect(read.sourceAssetPath).toBe("assets/source.png");
    expect(read.lastRenderedOf).toBe(studioImageBoardDrawingKey(board));
    // And again: nothing drifts on the way through.
    expect(readStudioImageBoard(save(read)).lastRenderedAsset).toEqual(RENDERED);
  });

  it("names a drawing by its layers and crop, and by nothing else", () => {
    const board = busyBoard();
    const key = studioImageBoardDrawingKey(board);

    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(studioImageBoardDrawingKey({ ...board, updatedAt: "2030-01-01T00:00:00.000Z" } as never)).toBe(key);
    expect(studioImageBoardDrawingKey(studioImageBoardWithRender(board, board, "assets/source.png", RENDERED))).toBe(key);
    expect(studioImageBoardDrawingKey(readStudioImageBoard(save(board)))).toBe(key);

    expect(studioImageBoardDrawingKey({ ...board, crop: null })).not.toBe(key);
    expect(studioImageBoardDrawingKey({ ...board, layers: board.layers.slice(0, -1) })).not.toBe(key);
    expect(studioImageBoardDrawingKey({ ...board, layers: [...board.layers].reverse() })).not.toBe(key);
    const nudged = board.layers.map((layer) => (layer.kind === "redact" ? { ...layer, x: layer.x + 0.001 } : layer));
    expect(studioImageBoardDrawingKey({ ...board, layers: nudged })).not.toBe(key);
  });

  it("is dropped when the layers it shows are not the layers the board has", () => {
    // An undo puts the layers back but leaves the render recorded since: a
    // picture without the blur must not stand for a board that has one.
    const blurred = createEmptyStudioImageBoard();
    blurred.layers.push(createStudioImageBoardLayer({ kind: "redact", id: "blur" }));
    const unblurred = createEmptyStudioImageBoard();
    unblurred.layers.push(createStudioImageBoardLayer({ kind: "shape", shape: "arrow", id: "arrow" }));
    const saved = save(studioImageBoardWithRender(unblurred, unblurred, "assets/source.png", RENDERED));
    const record = saved[STUDIO_IMAGE_BOARD_CONFIG_KEY] as Record<string, StudioJsonValue>;
    const afterUndo = {
      [STUDIO_IMAGE_BOARD_CONFIG_KEY]: {
        ...record,
        layers: (serializeStudioImageBoard(blurred) as Record<string, StudioJsonValue>).layers,
      },
    };

    const board = readStudioImageBoard(afterUndo);
    expect(board.layers.map((layer) => layer.id)).toEqual(["base", "blur"]);
    expect(board.lastRenderedAsset).toBeNull();
    expect(board.sourceAssetPath).toBe("");
    expect(board.lastRenderedOf).toBe("");
    expect(resolveStudioImageBoardRenderedAsset(afterUndo, "assets/source.png")).toBeNull();
    // Saving it again does not bring the stale picture back.
    expect((serializeStudioImageBoard(board) as Record<string, StudioJsonValue>).lastRenderedAsset).toBeNull();
  });

  it("is not adopted by a board that moved on while the picture was being made", () => {
    const rendered = createEmptyStudioImageBoard();
    rendered.layers.push(createStudioImageBoardLayer({ kind: "highlight", id: "mark" }));
    const edited = { ...rendered, layers: [...rendered.layers, createStudioImageBoardLayer({ kind: "redact", id: "blur" })] };

    const config = save(studioImageBoardWithRender(edited, rendered, "assets/source.png", RENDERED));

    expect(readStudioImageBoard(config).layers.map((layer) => layer.id)).toEqual(["base", "mark", "blur"]);
    expect(readStudioImageBoard(config).lastRenderedAsset).toBeNull();
  });

  it("is never taken on trust: a render with no record of what it shows is dropped", () => {
    const board = busyBoard();
    const record = serializeStudioImageBoard(board) as Record<string, StudioJsonValue>;

    expect(
      readStudioImageBoard({
        [STUDIO_IMAGE_BOARD_CONFIG_KEY]: { ...record, sourceAssetPath: "assets/source.png", lastRenderedAsset: RENDERED },
      }).lastRenderedAsset
    ).toBeNull();
    expect(
      (serializeStudioImageBoard({ ...board, sourceAssetPath: "assets/source.png", lastRenderedAsset: RENDERED }) as Record<
        string,
        StudioJsonValue
      >).lastRenderedAsset
    ).toBeNull();
  });

  it("goes when the render is cleared", () => {
    const board = busyBoard();
    const cleared = studioImageBoardWithoutRender(studioImageBoardWithRender(board, board, "assets/source.png", RENDERED));

    expect(cleared).toMatchObject({ lastRenderedAsset: null, lastRenderedOf: "", sourceAssetPath: "" });
    expect(cleared.layers).toEqual(board.layers);
  });
});

describe("image board migration", () => {
  const legacy = {
    version: 1,
    labels: [
      { id: "label-b", text: "Second", x: 0.1, y: 0.7, width: 0.4, height: 0.2, fontSize: 56, textAlign: "left", textColor: "#FFE600", styleVariant: "outline", zIndex: 1 },
      { id: "label-a", text: "First", x: 0.1, y: 0.1, width: 0.4, height: 0.2, fontSize: 56, textAlign: "center", textColor: "#ffffff", styleVariant: "banner", zIndex: 0 },
    ],
    annotations: [
      { id: "ring", kind: "highlight_circle", x: 0.2, y: 0.2, width: 0.3, height: 0.2, color: "#ff4d4f", strokeWidth: 8, blurRadius: 16, zIndex: 0 },
      { id: "blur", kind: "blur_rect", x: 0.5, y: 0.2, width: 0.2, height: 0.2, color: "#ff4d4f", strokeWidth: 8, blurRadius: 20, zIndex: 1 },
      { id: "box", kind: "highlight_rect", x: 0.6, y: 0.6, width: 0.2, height: 0.2, color: "#00ff00", strokeWidth: 16, blurRadius: 16, zIndex: 2 },
    ],
    crop: { x: 0.1, y: 0.1, width: 0.6, height: 0.5 },
    sourceAssetPath: "assets/source.png",
    lastRenderedAsset: RENDERED,
    updatedAt: "2026-03-22T00:00:00.000Z",
  };

  it("turns a first-generation board into one stack in its old paint order", () => {
    const board = readStudioImageBoard({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: legacy });

    expect(board.version).toBe(2);
    // Blurs were painted first, then outlines, then labels.
    expect(board.layers.map((layer) => `${layer.kind}:${layer.id}`)).toEqual([
      "base:base",
      "redact:blur",
      "shape:ring",
      "shape:box",
      "text:label-a",
      "text:label-b",
    ]);
    expect(board.layers[1]).toMatchObject({ kind: "redact", style: "blur", x: 0.5, width: 0.2, rotation: 0 });
    expect(board.layers[2]).toMatchObject({ kind: "shape", shape: "ellipse", color: "#ff4d4f", strokeWidth: 0.008 });
    expect(board.layers[3]).toMatchObject({ kind: "shape", shape: "rect", color: "#00ff00", strokeWidth: 0.016 });
    expect(board.layers[4]).toMatchObject({ kind: "text", text: "First", style: "banner", align: "center" });
    expect(board.layers[5]).toMatchObject({ kind: "text", text: "Second", style: "outline", align: "left", color: "#ffe600" });
    expect(board.crop).toEqual(legacy.crop);
  });

  it("does not keep the image the first editor baked", () => {
    // That image was an SVG carrying the whole source picture under a blur
    // filter, so what a blur hid could be read back out of it. The board is
    // flattened afresh, and until then nothing stands in for it.
    const board = readStudioImageBoard({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: legacy });

    expect(board.layers.some((layer) => layer.kind === "redact")).toBe(true);
    expect(board.lastRenderedAsset).toBeNull();
    expect(board.sourceAssetPath).toBe("");
    expect(
      resolveStudioImageBoardRenderedAsset({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: legacy }, "assets/source.png")
    ).toBeNull();
  });

  it("adopts the single caption that predates boards and clears its keys on save", () => {
    const target = node({
      sourcePath: "photo.png",
      captionText: "Hello",
      captionNormalizedX: 0.5,
      captionNormalizedY: 0.5,
      captionFontSize: 48,
      captionAlignment: "right",
      captionTextColor: "#ff0000",
      captionStyleVariant: "outline",
    });
    const board = readStudioImageBoard(target.config);

    expect(board.layers[1]).toMatchObject({ kind: "text", text: "Hello", style: "outline", align: "right", color: "#ff0000" });

    writeStudioImageBoard(target, board);

    expect(Object.keys(target.config).sort()).toEqual([STUDIO_IMAGE_BOARD_CONFIG_KEY, "sourcePath"]);
    expect(readStudioImageBoard(target.config).layers).toEqual(board.layers);
  });
});

describe("image board geometry", () => {
  const base = { width: 1000, height: 500 };

  it("inverts its own transforms", () => {
    const matrix = multiplyAffine(translateAffine(40, -12), rotateAffine(33));
    const inverse = invertAffine(matrix);
    const back = applyAffine(inverse!, applyAffine(matrix, { x: 7, y: 9 }));

    expect(back.x).toBeCloseTo(7, 6);
    expect(back.y).toBeCloseTo(9, 6);
    expect(invertAffine([0, 0, 0, 0, 1, 1])).toBeNull();
  });

  it("hit-tests a rotated box in pixels, not in stretched units", () => {
    // A 200×100 px box turned a quarter: it now covers 100×200 px around its centre (500, 250).
    const box = { x: 0.4, y: 0.4, width: 0.2, height: 0.2, rotation: 90 };

    expect(hitTestBox(box, base, { x: 0.5, y: 0.5 })).toBe(true);
    expect(hitTestBox(box, base, { x: 0.5, y: 0.5 + 90 / 500 })).toBe(true);
    expect(hitTestBox(box, base, { x: 0.5 + 90 / 1000, y: 0.5 })).toBe(false);
    expect(boxBounds(box, base).width).toBeCloseTo(0.1, 6);
    expect(boxBounds(box, base).height).toBeCloseTo(0.4, 6);
  });

  it("resizes from a handle while the opposite corner stays put", () => {
    const box = { x: 0.2, y: 0.2, width: 0.2, height: 0.2, rotation: 0 };

    const grown = resizeBox(box, base, { x: 1, y: 1 }, { x: 0.6, y: 0.8 });

    expect(grown.x).toBeCloseTo(0.2, 6);
    expect(grown.y).toBeCloseTo(0.2, 6);
    expect(grown.width).toBeCloseTo(0.4, 6);
    expect(grown.height).toBeCloseTo(0.6, 6);
  });

  it("keeps the anchor fixed on screen when the box is rotated", () => {
    const box = { x: 0.4, y: 0.4, width: 0.2, height: 0.2, rotation: 90 };
    // Rotated a quarter turn, the box's local top-left corner sits at screen (550, 150).
    const before = applyAffine(multiplyAffine(translateAffine(500, 250), rotateAffine(90)), { x: -100, y: -50 });

    const resized = resizeBox(box, base, { x: 1, y: 1 }, { x: 0.3, y: 0.9 });
    const centre = { x: (resized.x + resized.width / 2) * 1000, y: (resized.y + resized.height / 2) * 500 };
    const after = applyAffine(multiplyAffine(translateAffine(centre.x, centre.y), rotateAffine(90)), {
      x: (-resized.width * 1000) / 2,
      y: (-resized.height * 500) / 2,
    });

    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
    expect(resized.rotation).toBe(90);
  });

  it("holds proportions when asked and never collapses below the minimum", () => {
    const box = { x: 0, y: 0, width: 0.4, height: 0.4, rotation: 0 };

    const locked = resizeBox(box, base, { x: 1, y: 1 }, { x: 0.8, y: 0.5 }, { keepAspect: true });
    const tiny = resizeBox(box, base, { x: 1, y: 1 }, { x: -1, y: -1 }, { minPx: 10 });

    expect((locked.width * 1000) / (locked.height * 500)).toBeCloseTo(2, 6);
    expect(tiny.width * 1000).toBeCloseTo(10, 6);
    expect(tiny.height * 500).toBeCloseTo(10, 6);
  });

  it("reads rotation from the pointer with straight up as zero", () => {
    const box = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };

    expect(rotationToward(box, base, { x: 0.5, y: 0.1 })).toBe(0);
    expect(rotationToward(box, base, { x: 0.9, y: 0.5 })).toBe(90);
    expect(rotationToward(box, base, { x: 0.5, y: 0.9 })).toBe(180);
  });

  it("lays an arrow along the drag from tail to point", () => {
    const arrow = boxBetweenPoints({ x: 0.1, y: 0.2 }, { x: 0.1, y: 0.8 }, base, 30);

    expect(arrow.rotation).toBe(90);
    expect(arrow.width * 1000).toBeCloseTo(300, 6);
    expect(arrow.height * 500).toBeCloseTo(30, 6);
    expect((arrow.x + arrow.width / 2) * 1000).toBeCloseTo(100, 6);
    expect((arrow.y + arrow.height / 2) * 500).toBeCloseTo(250, 6);
  });

  it("knows when two boxes touch or overlap, at any rotation", () => {
    const box = { x: 0.2, y: 0.2, width: 0.2, height: 0.2, rotation: 0 };

    expect(boxesTouch(box, { ...box, x: 0.3, y: 0.3 }, base)).toBe(true);
    // Flush edge to edge counts; a visible gap does not.
    expect(boxesTouch(box, { ...box, x: 0.4 }, base)).toBe(true);
    expect(boxesTouch(box, { ...box, x: 0.402 }, base)).toBe(false);
    // Bounding boxes overlap here, but the tilted box itself stays clear.
    const tilted = { x: 0.41, y: 0.0, width: 0.3, height: 0.04, rotation: 45 };
    expect(boxesTouch(box, tilted, base)).toBe(false);
    expect(boxesTouch(box, { ...tilted, x: 0.3, y: 0.28 }, base)).toBe(true);
  });

  it("snaps a moved box by whichever edge is nearest a line, and reports the guide", () => {
    const lines = { x: [0.5], y: [0.1, 0.9] };
    const reach = { x: 0.02, y: 0.02 };

    const leftEdge = snapFrameMove({ x: 0.51, y: 0.4, width: 0.2, height: 0.2 }, lines, reach);
    expect(leftEdge.value).toEqual({ x: 0.5, y: 0.4, width: 0.2, height: 0.2 });
    expect([leftEdge.guideX, leftEdge.guideY]).toEqual([0.5, null]);

    const rightAndBottom = snapFrameMove({ x: 0.29, y: 0.71, width: 0.2, height: 0.2 }, lines, reach);
    expect(rightAndBottom.value.x).toBeCloseTo(0.3, 9);
    expect(rightAndBottom.value.y).toBeCloseTo(0.7, 9);
    expect([rightAndBottom.guideX, rightAndBottom.guideY]).toEqual([0.5, 0.9]);

    const free = snapFrameMove({ x: 0.1, y: 0.4, width: 0.2, height: 0.2 }, lines, reach);
    expect(free.value).toEqual({ x: 0.1, y: 0.4, width: 0.2, height: 0.2 });
    expect([free.guideX, free.guideY]).toEqual([null, null]);
  });

  it("snaps only the edges a resize handle drags, and never below the minimum size", () => {
    const lines = { x: [0.3, 0.5], y: [0.3] };
    const reach = { x: 0.02, y: 0.02 };
    const least = { width: 0.05, height: 0.05 };
    const frame = { x: 0.31, y: 0.31, width: 0.18, height: 0.2 };

    const east = snapFrameResize(frame, { x: 1, y: 0 }, lines, reach, least);
    expect(east.value.x).toBe(0.31);
    expect(east.value.x + east.value.width).toBeCloseTo(0.5, 9);
    expect(east.guideX).toBe(0.5);
    expect(east.guideY).toBeNull();

    const northWest = snapFrameResize(frame, { x: -1, y: -1 }, lines, reach, least);
    expect(northWest.value.x).toBe(0.3);
    expect(northWest.value.y).toBe(0.3);
    // The far edges did not move.
    expect(northWest.value.x + northWest.value.width).toBeCloseTo(0.49, 9);
    expect(northWest.value.y + northWest.value.height).toBeCloseTo(0.51, 9);

    const tooSmall = snapFrameResize({ x: 0.47, y: 0.4, width: 0.04, height: 0.2 }, { x: -1, y: 0 }, lines, { x: 0.05, y: 0 }, least);
    expect(tooSmall.value.x).toBe(0.47);
    expect(tooSmall.guideX).toBeNull();
  });

  it("moves a frame back inside another by the least it can, centring what cannot fit", () => {
    const within = { x: 0, y: 0, width: 1, height: 1 };

    expect(keepFrameWithin({ x: 0.2, y: 0.3, width: 0.4, height: 0.4 }, within)).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.4 });
    expect(keepFrameWithin({ x: -0.1, y: 0.8, width: 0.4, height: 0.4 }, within)).toEqual({ x: 0, y: 0.6, width: 0.4, height: 0.4 });
    const wide = keepFrameWithin({ x: 0.5, y: 0.1, width: 1.4, height: 0.2 }, within);
    expect(wide.x).toBeCloseTo(-0.2, 9);
    expect(wide.y).toBeCloseTo(0.1, 9);
  });

  it("wraps a set of points in their convex outline", () => {
    // Two squares, one up and to the right of the other: the outline skips the corners between them.
    const hull = convexHull([
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
      { x: 3, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 5 }, { x: 3, y: 5 },
      { x: 1, y: 1 },
    ]);

    expect(hull).toHaveLength(6);
    expect(hull).toEqual(expect.arrayContaining([
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 3 }, { x: 5, y: 5 }, { x: 3, y: 5 }, { x: 0, y: 2 },
    ]));
    expect(convexHull([{ x: 1, y: 1 }, { x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it("snaps a point on each axis on its own", () => {
    const snapped = snapPointToLines({ x: 0.49, y: 0.6 }, { x: [0.5], y: [0.1] }, { x: 0.02, y: 0.02 });

    expect(snapped.value).toEqual({ x: 0.5, y: 0.6 });
    expect([snapped.guideX, snapped.guideY]).toEqual([0.5, null]);
  });
});
