/** @jest-environment jsdom */

jest.mock("obsidian", () => {
  const actual = jest.requireActual("../../../../../tests/mocks/obsidian.js");
  return { ...actual, Notice: jest.fn() };
});

import { Notice, type App } from "obsidian";
import {
  readStudioImageBoard,
  studioImageBoardDrawingKey,
  type StudioImageBoardLayer,
} from "../../../../../studio/StudioImageBoard";
import type { StudioJsonValue, StudioNodeInstance } from "../../../../../studio/types";
import { tryCopyImageBytesToClipboard } from "../../../../../utils/clipboard";
import { mountStudioImageBoardEditor } from "../StudioImageBoardEditor";
import {
  drag,
  flushImageBoard,
  installImageBoardTestCanvas,
  pointer,
  restoreImageBoardTestCanvas,
} from "./imageBoardTestCanvas";

jest.mock("../../../../../utils/clipboard", () => ({
  tryCopyImageBytesToClipboard: jest.fn(async () => true),
}));

const SOURCE = { hash: "s".repeat(64), path: "Studio/assets/source.png", mimeType: "image/png", sizeBytes: 42 };

async function mount(config: Record<string, StudioJsonValue> = {}) {
  const { encoded } = installImageBoardTestCanvas();
  const contentEl = document.body.createDiv({ cls: "ss-studio-media-content" });
  const toolbarHost = document.body.createDiv();
  const store: Record<string, StudioJsonValue> = { ...config };
  const node: StudioNodeInstance = {
    id: "node_media",
    kind: "studio.media_ingest",
    version: "1.0.0",
    title: "Media",
    position: { x: 0, y: 0 },
    config: store,
    continueOnError: false,
    disabled: false,
  };
  let stored = 0;
  const storeAsset = jest.fn(async (_bytes: ArrayBuffer, mimeType: string) => {
    stored += 1;
    return { hash: `hash-${stored}`, path: `Studio/assets/stored-${stored}.png`, mimeType, sizeBytes: 4 };
  });
  const commits: Array<{ mode?: string; captureHistory?: boolean } | undefined> = [];
  const onClose = jest.fn();
  const editor = mountStudioImageBoardEditor({
    app: {} as App,
    contentEl,
    toolbarHost,
    toolbarDocked: false,
    node,
    nodeRunState: {
      status: "idle",
      message: "",
      updatedAt: null,
      outputs: { source_preview_asset: SOURCE, source_preview_path: SOURCE.path },
    },
    getGraphZoom: () => 1,
    readAsset: async () => new ArrayBuffer(8),
    storeAsset,
    onNodeConfigValueChange: (_nodeId, key, value, options) => {
      store[key] = value;
      commits.push(options);
    },
    onClose,
  });
  await flushImageBoard();
  const stage = contentEl.querySelector<HTMLElement>(".ss-studio-image-board")!;
  const toolbar = toolbarHost.querySelector<HTMLElement>(".ss-studio-image-board-toolbar")!;
  const button = (testId: string): HTMLButtonElement =>
    toolbar.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
  const layers = (): StudioImageBoardLayer[] => readStudioImageBoard(store).layers;
  const key = (name: string, init: KeyboardEventInit = {}): boolean => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: document.body });
    return editor.handleKeyDown(event);
  };
  return { editor, stage, toolbar, button, layers, key, store, storeAsset, commits, onClose, encoded, contentEl };
}

afterEach(() => {
  restoreImageBoardTestCanvas();
  document.body.empty();
  jest.clearAllMocks();
});

describe("in-place image editor", () => {
  it("edits on the card itself: a stage where the picture was, tools in one bar, no modal", async () => {
    const { stage, toolbar, contentEl } = await mount();

    expect(contentEl.contains(stage)).toBe(true);
    expect(stage.querySelector("canvas")).not.toBeNull();
    expect(stage.classList.contains("is-unavailable")).toBe(false);
    expect(document.querySelector(".modal, .ss-modal")).toBeNull();
    expect(
      Array.from(toolbar.querySelectorAll(".is-tools button")).map((el) => el.getAttribute("data-testid"))
    ).toEqual([
      "studio.image.tool.select",
      "studio.image.tool.text",
      "studio.image.tool.rect",
      "studio.image.tool.ellipse",
      "studio.image.tool.arrow",
      "studio.image.tool.highlight",
      "studio.image.tool.redact",
      "studio.image.tool.magnify",
      "studio.image.tool.crop",
      "studio.image.add-image",
      "studio.image.copy",
      "studio.image.done",
    ]);
    expect(toolbar.querySelector(".is-tools button[disabled]")).toBeNull();
  });

  it("puts meme text on with one click and types straight onto the image", async () => {
    const { stage, button, layers } = await mount();

    button("studio.image.tool.text").click();
    drag(stage, [200, 30]);

    const input = stage.querySelector<HTMLTextAreaElement>('[data-testid="studio.image.text-input"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.dataset.style).toBe("meme");

    input.value = "top text";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // The caption spans the image at the height that was clicked.
    const text = layers()[1];
    expect(text).toMatchObject({ kind: "text", text: "top text", style: "meme", color: "#ffffff", align: "center" });
    expect(text.x).toBeCloseTo(0.05, 6);
    expect(text.width).toBeCloseTo(0.9, 6);
    expect(text.y + text.height / 2).toBeCloseTo(0.15, 6);
  });

  it("drops a caption nobody typed into, leaving nothing to undo", async () => {
    const { stage, button, layers, commits } = await mount();
    button("studio.image.tool.text").click();
    drag(stage, [200, 30]);
    expect(layers()).toHaveLength(2);

    drag(stage, [200, 150]);

    expect(layers().map((layer) => layer.kind)).toEqual(["base"]);
    expect(stage.querySelector("textarea")).toBeNull();
    // Neither the empty box nor its removal is a step of its own.
    expect(commits).toEqual([
      { mode: "discrete", captureHistory: false },
      { mode: "discrete", captureHistory: false },
    ]);
  });

  it("makes a new caption one step to undo: its first keystroke", async () => {
    const { stage, button, commits } = await mount();
    button("studio.image.tool.text").click();
    drag(stage, [200, 30]);
    const input = stage.querySelector<HTMLTextAreaElement>('[data-testid="studio.image.text-input"]')!;

    for (const value of ["t", "to", "top"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    expect(commits.filter((commit) => commit?.captureHistory !== false)).toHaveLength(1);
    expect(commits[1]).toEqual({ mode: "continuous", captureHistory: true });
  });

  it("leaves out an empty caption that an undo brings back, but not the one being typed into", async () => {
    const { editor, stage, button, layers, store } = await mount();
    const nodeWith = (config: Record<string, StudioJsonValue>): StudioNodeInstance => ({
      id: "node_media", kind: "studio.media_ingest", version: "1.0.0", title: "Media",
      position: { x: 0, y: 0 }, config, continueOnError: false, disabled: false,
    });
    button("studio.image.tool.text").click();
    drag(stage, [200, 30]);
    const withEmptyCaption = JSON.parse(JSON.stringify(store)) as Record<string, StudioJsonValue>;

    // Something else changes while the caption is still being typed into: it stays.
    editor.syncNode(nodeWith(withEmptyCaption));
    expect(stage.querySelector("textarea")).not.toBeNull();
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(true);

    // Typed into, then undone back to the empty box with nobody typing.
    const input = stage.querySelector<HTMLTextAreaElement>('[data-testid="studio.image.text-input"]')!;
    input.value = "top";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    drag(stage, [200, 150]);
    expect(layers().map((layer) => layer.kind)).toEqual(["base", "text"]);
    Object.assign(store, withEmptyCaption);
    editor.syncNode(nodeWith(store));

    // Nothing invisible is left selected or open, and the next edit saves the board without it.
    expect(stage.querySelector("textarea")).toBeNull();
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(false);
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);
    expect(layers().map((layer) => layer.kind)).toEqual(["base", "shape"]);
  });

  it("lets an input method finish a word before Escape or Enter end the caption", async () => {
    const { stage, button } = await mount();
    button("studio.image.tool.text").click();
    drag(stage, [200, 30]);
    const input = stage.querySelector<HTMLTextAreaElement>('[data-testid="studio.image.text-input"]')!;
    input.value = "ka";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const composing = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(stage.querySelector("textarea")).not.toBeNull();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(stage.querySelector("textarea")).toBeNull();
  });

  it("saves nothing once it has been taken down, even with a caption still open", async () => {
    const { editor, stage, button, commits } = await mount();
    button("studio.image.tool.text").click();
    drag(stage, [200, 30]);
    const input = stage.querySelector<HTMLTextAreaElement>('[data-testid="studio.image.text-input"]')!;
    const before = commits.length;

    editor.dispose();
    // Removing a focused field blurs it; the caption's deferred clean-up must not run.
    input.dispatchEvent(new FocusEvent("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commits).toHaveLength(before);
  });

  it("draws a box exactly where it is dragged, then goes back to selecting", async () => {
    const { stage, button, layers } = await mount();

    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [200, 90], [300, 150]);

    expect(layers()[1]).toMatchObject({ kind: "shape", shape: "rect", x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 });
    expect(button("studio.image.tool.select").getAttribute("aria-pressed")).toBe("true");
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(true);
  });

  it("circles, points, and highlights with their own tools", async () => {
    const { stage, button, layers } = await mount();

    button("studio.image.tool.ellipse").click();
    drag(stage, [40, 40], [120, 100]);
    button("studio.image.tool.arrow").click();
    drag(stage, [200, 20], [200, 180]);
    button("studio.image.tool.highlight").click();
    drag(stage, [240, 100], [360, 120]);

    const [, circle, arrow, highlight] = layers();
    expect(circle).toMatchObject({ kind: "shape", shape: "ellipse" });
    expect(arrow).toMatchObject({ kind: "shape", shape: "arrow", rotation: 90 });
    expect(arrow.width * 400).toBeCloseTo(160, 4);
    expect(highlight).toMatchObject({ kind: "highlight", color: "#ffe600", x: 0.6, y: 0.5 });
  });

  it("moves a layer by dragging it, as one undo step", async () => {
    const { stage, button, layers, commits } = await mount();
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);
    commits.length = 0;

    drag(stage, [200, 100], [220, 110], [240, 120]);

    expect(layers()[1].x).toBeCloseTo(0.35, 6);
    expect(layers()[1].y).toBeCloseTo(0.35, 6);
    // Only the first commit of the drag opens a history entry.
    expect(commits.filter((options) => options?.captureHistory === true)).toHaveLength(1);
    expect(commits.every((options) => options?.mode === "continuous")).toBe(true);
  });

  it("rotates from the rotate handle and resizes from a corner", async () => {
    const { stage, button, layers } = await mount();
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);

    // Centre is (200, 100): grab straight above it and swing to the right.
    drag(stage.querySelector('[data-board-handle="rotate"]')!, [200, 20], [260, 60], [300, 100]);
    expect(layers()[1].rotation).toBe(90);

    drag(stage.querySelector('[data-board-handle="rotate"]')!, [300, 100], [240, 40], [200, 20]);
    expect(layers()[1].rotation).toBe(0);

    drag(stage.querySelector('[data-board-handle="se"]')!, [300, 150], [350, 175]);
    expect(layers()[1]).toMatchObject({ x: 0.25, y: 0.25 });
    expect(layers()[1].width).toBeCloseTo(0.625, 6);
    expect(layers()[1].height).toBeCloseTo(0.625, 6);
  });

  it("blurs out with a fill that can be switched to pixelate or blackout", async () => {
    const { stage, toolbar, button, layers } = await mount();

    button("studio.image.tool.redact").click();
    expect(toolbar.querySelector(".ss-studio-image-board-toolbar__hint")!.textContent).toContain("cannot be recovered");
    drag(stage, [40, 80], [240, 120]);

    expect(layers()[1]).toMatchObject({ kind: "redact", style: "blur" });
    expect(button("studio.image.redact-style.blur").getAttribute("aria-pressed")).toBe("true");

    button("studio.image.redact-style.solid").click();

    expect(layers()[1]).toMatchObject({ kind: "redact", style: "solid" });
    expect(button("studio.image.redact-style.solid").getAttribute("aria-pressed")).toBe("true");
  });

  it("lines blur boxes up with each other as they are drawn, moved and resized", async () => {
    const { stage, button, layers } = await mount();
    const guide = (axis: "vertical" | "horizontal"): HTMLElement =>
      stage.querySelector<HTMLElement>(`.ss-studio-image-board__guide.is-${axis}`)!;
    button("studio.image.tool.redact").click();
    drag(stage, [40, 80], [140, 120]);

    // Drawn a couple of pixels off: the new box takes the first one's top and bottom.
    button("studio.image.tool.redact").click();
    drag(stage, [200, 82], [300, 117]);
    expect(layers()[2]).toMatchObject({ kind: "redact", x: 0.5, y: 0.4 });
    expect(layers()[2].height).toBeCloseTo(0.2, 9);

    // Dragged to within reach of the first box, it lands flush against it.
    pointer(stage, "pointerdown", 250, 100);
    pointer(window, "pointermove", 193, 101);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(guide("vertical").classList.contains("is-visible")).toBe(true);
    expect(guide("vertical").style.left).toBe("35%");
    pointer(window, "pointerup", 193, 101);
    expect(layers()[2].x).toBeCloseTo(0.35, 9);
    expect(layers()[2].y).toBeCloseTo(0.4, 9);
    expect(guide("vertical").classList.contains("is-visible")).toBe(false);
    expect(guide("horizontal").classList.contains("is-visible")).toBe(false);

    // Pulled away and resized back: the dragged edge stops on the neighbour's.
    drag(stage, [190, 100], [290, 100]);
    expect(layers()[2].x).toBeCloseTo(0.6, 9);
    drag(stage.querySelector('[data-board-handle="w"]')!, [240, 100], [144, 100]);
    expect(layers()[2].x).toBeCloseTo(0.35, 9);
    expect(layers()[2].x + layers()[2].width).toBeCloseTo(0.85, 9);
  });

  it("leaves other layers, and turned blur boxes, to move freely", async () => {
    const { stage, button, layers } = await mount();
    button("studio.image.tool.redact").click();
    drag(stage, [40, 80], [140, 120]);

    // An outline dragged to the same spot is not pulled onto the blur box's edge.
    button("studio.image.tool.rect").click();
    drag(stage, [200, 20], [300, 60]);
    drag(stage, [201, 40], [144, 40]);
    expect(layers()[2].x).toBeCloseTo(0.3575, 9);

    // Nor is a blur box once it has been turned.
    button("studio.image.tool.redact").click();
    drag(stage, [200, 140], [300, 180]);
    drag(stage.querySelector('[data-board-handle="rotate"]')!, [250, 110], [290, 130], [300, 160]);
    expect(layers()[3].rotation).toBe(90);
    drag(stage, [250, 160], [193, 160]);
    expect(layers()[3].x).toBeCloseTo(0.3575, 9);
  });

  it("magnifies what is dragged over: the area stays put and its enlarged copy lands beside it", async () => {
    const { stage, toolbar, button, layers, key } = await mount();

    expect(key("m")).toBe(true);
    expect(button("studio.image.tool.magnify").getAttribute("aria-pressed")).toBe("true");
    expect(toolbar.querySelector(".ss-studio-image-board-toolbar__hint")!.textContent).toContain("pops out");

    // Mark 40×20 px of the 400×200 stage.
    pointer(stage, "pointerdown", 180, 110);
    pointer(window, "pointermove", 220, 130);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stage.querySelector<HTMLElement>(".ss-studio-image-board__draft")!.dataset.tool).toBe("magnify");
    pointer(window, "pointerup", 220, 130);

    // The area is exactly what was marked; the lens is twice its size, straight above it.
    const lens = layers()[1];
    expect(lens).toMatchObject({ kind: "magnify", shape: "rect", color: "#ffe600", rotation: 0 });
    if (lens.kind !== "magnify") throw new Error("expected a lens");
    expect(lens.source.x).toBeCloseTo(0.45, 9);
    expect(lens.source.y).toBeCloseTo(0.55, 9);
    expect(lens.source.width).toBeCloseTo(0.1, 9);
    expect(lens.source.height).toBeCloseTo(0.1, 9);
    expect(lens.x).toBeCloseTo(0.4, 9);
    expect(lens.y).toBeCloseTo(0.28, 9);
    expect(lens.width).toBeCloseTo(0.2, 9);
    expect(lens.height).toBeCloseTo(0.2, 9);
    expect(button("studio.image.tool.select").getAttribute("aria-pressed")).toBe("true");
    expect(button("studio.image.lens-zoom.2x").getAttribute("aria-pressed")).toBe("true");

    // With the lens selected, its area is marked on the picture too.
    const area = stage.querySelector<HTMLElement>(".ss-studio-image-board__lens-area")!;
    expect(area.classList.contains("is-visible")).toBe(true);
    expect(parseFloat(area.style.left)).toBeCloseTo(50, 6);
    expect(parseFloat(area.style.top)).toBeCloseTo(60, 6);
    expect(parseFloat(area.style.width)).toBeCloseTo(10, 6);
  });

  it("moves the lens anywhere while its area stays, and moves the area while the lens stays", async () => {
    const { stage, button, layers } = await mount();
    const lens = () => {
      const layer = layers()[1];
      if (layer.kind !== "magnify") throw new Error("expected a lens");
      return layer;
    };
    button("studio.image.tool.magnify").click();
    drag(stage, [180, 110], [220, 130]);

    // The lens sits at (160–240, 56–96): drag it to the top right corner.
    drag(stage, [200, 76], [300, 46]);
    expect(lens().x).toBeCloseTo(0.65, 9);
    expect(lens().y).toBeCloseTo(0.13, 9);
    expect(lens().source.x).toBeCloseTo(0.45, 9);
    expect(lens().source.y).toBeCloseTo(0.55, 9);

    // Now drag the area itself: the lens does not move, it just looks somewhere else.
    drag(stage, [200, 120], [120, 150]);
    expect(lens().source.x).toBeCloseTo(0.25, 9);
    expect(lens().source.y).toBeCloseTo(0.7, 9);
    expect(lens().source.width).toBeCloseTo(0.1, 9);
    expect(lens().x).toBeCloseTo(0.65, 9);
    expect(lens().y).toBeCloseTo(0.13, 9);

    // Deselected, the area still leads back to its lens.
    drag(stage, [20, 20]);
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(false);
    drag(stage, [120, 150]);
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(true);
    expect(stage.querySelector(".ss-studio-image-board__lens-area")!.classList.contains("is-visible")).toBe(true);
  });

  it("adjusts what is marked from the area's own handles, at the same zoom", async () => {
    const { stage, button, layers, commits } = await mount();
    const lens = () => {
      const layer = layers()[1];
      if (layer.kind !== "magnify") throw new Error("expected a lens");
      return layer;
    };
    const areaHandle = (name: string): HTMLElement =>
      stage.querySelector<HTMLElement>(`.ss-studio-image-board__lens-area [data-board-handle="${name}"]`)!;
    button("studio.image.tool.magnify").click();
    drag(stage, [180, 110], [220, 130]);
    commits.length = 0;

    // Missed a bit on the right and below: pull the corner out to (240, 140).
    drag(areaHandle("se"), [220, 130], [230, 135], [240, 140]);
    expect(lens().source.x).toBeCloseTo(0.45, 9);
    expect(lens().source.y).toBeCloseTo(0.55, 9);
    expect(lens().source.width).toBeCloseTo(0.15, 9);
    expect(lens().source.height).toBeCloseTo(0.15, 9);
    // Still twice the size. Sitting above its area, the lens grows upwards and
    // to both sides: its lower edge stays the same 14 px clear of the area.
    expect(lens().width).toBeCloseTo(0.3, 9);
    expect(lens().height).toBeCloseTo(0.3, 9);
    expect(lens().x + lens().width / 2).toBeCloseTo(0.5, 9);
    expect(lens().y + lens().height).toBeCloseTo(0.48, 9);
    expect(commits.filter((options) => options?.captureHistory === true)).toHaveLength(1);

    // The opposite corner moves on its own; the one just set stays put.
    drag(areaHandle("nw"), [180, 110], [170, 100]);
    expect(lens().source.x).toBeCloseTo(0.425, 9);
    expect(lens().source.y).toBeCloseTo(0.5, 9);
    expect(lens().source.x + lens().source.width).toBeCloseTo(0.6, 9);
    expect(lens().source.y + lens().source.height).toBeCloseTo(0.7, 9);
    expect(lens().width / lens().source.width).toBeCloseTo(2, 9);
    expect(lens().height / lens().source.height).toBeCloseTo(2, 9);
    // The area's top edge came 10 px closer; the lens moved up to keep its distance.
    expect(lens().source.y - (lens().y + lens().height)).toBeCloseTo(0.07, 9);
    // An edge moves alone, whatever the pointer does along it.
    drag(areaHandle("e"), [240, 120], [260, 131]);
    expect(lens().source.x).toBeCloseTo(0.425, 9);
    expect(lens().source.width).toBeCloseTo(0.225, 9);
    expect(lens().source.height).toBeCloseTo(0.2, 9);

    // The lens's own corners still resize the lens, not the area.
    const before = lens().source;
    drag(stage.querySelector('.ss-studio-image-board__selection [data-board-handle="se"]')!, [290, 116], [310, 126]);
    expect(lens().source).toEqual(before);
    expect(lens().width / lens().source.width).toBeGreaterThan(2);
  });

  it("keeps the lens on the picture when adjusting its area or its zoom makes it grow", async () => {
    const { stage, button, layers } = await mount();
    const lens = () => {
      const layer = layers()[1];
      if (layer.kind !== "magnify") throw new Error("expected a lens");
      return layer;
    };
    button("studio.image.tool.magnify").click();
    drag(stage, [180, 110], [220, 130]);
    // Park the lens in the top left corner, flush with both edges.
    drag(stage, [200, 76], [40, 20]);
    expect(lens().x).toBeCloseTo(0, 9);
    expect(lens().y).toBeCloseTo(0, 9);

    // Widening the area doubles the lens's width; it grows inwards rather than off the edge.
    drag(stage.querySelector('.ss-studio-image-board__lens-area [data-board-handle="e"]')!, [220, 120], [260, 120]);
    expect(lens().width).toBeCloseTo(0.4, 9);
    expect(lens().x).toBeCloseTo(0, 9);

    button("studio.image.lens-zoom.3x").click();
    expect(lens().width).toBeCloseTo(0.6, 9);
    expect(lens().x).toBeCloseTo(0, 9);
    expect(lens().y).toBeCloseTo(0, 9);

    // A lens left hanging off on purpose is not pulled back.
    drag(stage, [100, 30], [40, 30]);
    const hanging = lens().x;
    expect(hanging).toBeLessThan(0);
    button("studio.image.lens-zoom.2x").click();
    expect(lens().x + lens().width / 2).toBeCloseTo(hanging + 0.3, 9);
  });

  it("zooms, reshapes and recolours a lens from the context row", async () => {
    const { stage, button, layers } = await mount();
    button("studio.image.tool.magnify").click();
    drag(stage, [180, 110], [220, 130]);

    // More zoom makes the lens larger, away from its area; the area is untouched.
    button("studio.image.lens-zoom.3x").click();
    const lens = layers()[1];
    if (lens.kind !== "magnify") throw new Error("expected a lens");
    expect(lens.width).toBeCloseTo(0.3, 9);
    expect(lens.height).toBeCloseTo(0.3, 9);
    expect(lens.x + lens.width / 2).toBeCloseTo(0.5, 9);
    expect(lens.y + lens.height).toBeCloseTo(0.48, 9);
    expect(lens.source.width).toBeCloseTo(0.1, 9);
    expect(button("studio.image.lens-zoom.3x").getAttribute("aria-pressed")).toBe("true");
    expect(button("studio.image.lens-zoom.2x").getAttribute("aria-pressed")).toBe("false");

    button("studio.image.lens-shape.ellipse").click();
    button("studio.image.color.red").click();
    expect(layers()[1]).toMatchObject({ kind: "magnify", shape: "ellipse", color: "#ff3b30" });
    expect(button("studio.image.lens-shape.ellipse").getAttribute("aria-pressed")).toBe("true");

    // A corner drag keeps the lens in proportion, so what it shows is never squashed.
    drag(stage.querySelector('.ss-studio-image-board__selection [data-board-handle="se"]')!, [260, 96], [300, 110]);
    const resized = layers()[1];
    expect(resized.width / resized.height).toBeCloseTo(1, 6);
    expect(resized.width).toBeGreaterThan(0.3);
  });

  it("drops a lens for the spot where the magnifier is clicked", async () => {
    const { stage, button, layers } = await mount();

    button("studio.image.tool.magnify").click();
    drag(stage, [100, 60]);

    const lens = layers()[1];
    if (lens.kind !== "magnify") throw new Error("expected a lens");
    // The area is centred on the click; too near the top for the lens to go above, it lands below.
    expect(lens.source.x + lens.source.width / 2).toBeCloseTo(0.25, 9);
    expect(lens.source.y + lens.source.height / 2).toBeCloseTo(0.3, 9);
    expect(lens.source.width).toBeCloseTo(0.16, 9);
    expect(lens.width).toBeCloseTo(0.32, 9);
    expect(lens.y).toBeGreaterThan(lens.source.y + lens.source.height);
  });

  it("restyles text and recolours shapes from the context row", async () => {
    const { stage, button, layers } = await mount();
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);

    button("studio.image.color.blue").click();
    button("studio.image.weight.bold").click();
    expect(layers()[1]).toMatchObject({ color: "#0a84ff", strokeWidth: 0.016 });

    button("studio.image.layer.duplicate").click();
    expect(layers()).toHaveLength(3);
    button("studio.image.layer.backward").click();
    expect(layers()[1].id).not.toBe(layers()[2].id);
    button("studio.image.layer.delete").click();
    expect(layers()).toHaveLength(2);
  });

  it("makes a drag through the colour picker one step to undo", async () => {
    const { stage, button, toolbar, layers, commits } = await mount();
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);
    const picker = toolbar.querySelector<HTMLInputElement>('[data-testid="studio.image.color.custom"]')!;
    const before = commits.length;

    for (const value of ["#111111", "#222222", "#333333"]) {
      picker.value = value;
      picker.dispatchEvent(new Event("input", { bubbles: true }));
    }
    picker.dispatchEvent(new Event("change", { bubbles: true }));

    expect(layers()[1]).toMatchObject({ color: "#333333" });
    expect(commits.slice(before)).toEqual([
      { mode: "continuous", captureHistory: true },
      { mode: "continuous", captureHistory: false },
      { mode: "continuous", captureHistory: false },
    ]);

    // The next drag is a step of its own.
    picker.value = "#444444";
    picker.dispatchEvent(new Event("input", { bubbles: true }));
    expect(commits[commits.length - 1]).toEqual({ mode: "continuous", captureHistory: true });
  });

  it("crops by dragging the frame, past the image for transparent space, and resets", async () => {
    const { stage, button, store } = await mount();

    button("studio.image.tool.crop").click();
    const crop = stage.querySelector<HTMLElement>(".ss-studio-image-board__crop")!;
    expect(crop.classList.contains("is-visible")).toBe(true);
    // In crop mode the stage shows the image with room around it.
    const before = readStudioImageBoard(store).crop;
    expect(before).toBeNull();

    drag(crop.querySelector('[data-board-handle="e"]')!, [200, 100], [120, 100]);

    const cropped = readStudioImageBoard(store).crop!;
    expect(cropped.x).toBe(0);
    expect(cropped.width).toBeLessThan(1);
    expect(cropped.height).toBeCloseTo(1, 6);

    button("studio.image.crop.reset").click();
    expect(readStudioImageBoard(store).crop).toBeNull();

    button("studio.image.crop.apply").click();
    expect(button("studio.image.tool.select").getAttribute("aria-pressed")).toBe("true");
    expect(crop.classList.contains("is-visible")).toBe(false);
  });

  it("makes the background transparent when the bottom layer is deleted, and can restore it", async () => {
    const { stage, button, layers, key } = await mount();
    const now = jest.spyOn(Date, "now");

    // A single press only selects the background; it cannot be dragged by accident.
    now.mockReturnValue(1000);
    drag(stage, [200, 100], [260, 140]);
    expect(layers()[0]).toMatchObject({ kind: "base", x: 0, y: 0 });
    expect(stage.querySelector(".ss-studio-image-board__selection")!.getAttribute("data-kind")).toBe("base");

    expect(key("Delete")).toBe(true);
    expect(layers()).toEqual([]);

    button("studio.image.restore-background").click();
    expect(layers().map((layer) => layer.kind)).toEqual(["base"]);
  });

  it("keeps Delete and plain keys away from the canvas underneath", async () => {
    const { stage, button, layers, key } = await mount();
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);

    expect(key("Delete")).toBe(true);
    expect(layers().map((layer) => layer.kind)).toEqual(["base"]);
    // Nothing is selected now. The key is still spent, so Studio never deletes the node.
    expect(key("Backspace")).toBe(true);
    expect(key("s")).toBe(true);
    expect(key("t")).toBe(true);
    expect(button("studio.image.tool.text").getAttribute("aria-pressed")).toBe("true");
    // Undo belongs to Studio history.
    expect(key("z", { metaKey: true })).toBe(false);
  });

  it("leaves typing alone while a text field has focus", async () => {
    const { stage, button, editor } = await mount();
    button("studio.image.tool.text").click();
    drag(stage, [200, 30]);
    const input = stage.querySelector<HTMLTextAreaElement>("textarea")!;
    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: input });

    expect(editor.handleKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("steps out with Escape: tool, then selection, then the editor", async () => {
    const { stage, button, key, onClose } = await mount();
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);
    button("studio.image.tool.highlight").click();

    key("Escape");
    expect(button("studio.image.tool.select").getAttribute("aria-pressed")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();

    drag(stage, [200, 51]);
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(true);
    key("Escape");
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(false);

    key("Escape");
    await flushImageBoard();
    expect(onClose).toHaveBeenCalledWith("node_media");
  });

  it("copies the whole flattened image to the clipboard in one click", async () => {
    const { stage, button, encoded } = await mount();
    button("studio.image.tool.redact").click();
    drag(stage, [40, 80], [240, 120]);

    button("studio.image.copy").click();
    await flushImageBoard();

    expect(tryCopyImageBytesToClipboard).toHaveBeenCalledTimes(1);
    expect(tryCopyImageBytesToClipboard).toHaveBeenCalledWith(encoded, "image/png", stage);
    expect(Notice).toHaveBeenCalledWith("Image copied to clipboard.");
  });

  it("says so when the clipboard refuses the image", async () => {
    const { button } = await mount();
    (tryCopyImageBytesToClipboard as jest.Mock).mockResolvedValueOnce(false);

    button("studio.image.copy").click();
    await flushImageBoard();

    expect(Notice).toHaveBeenCalledWith("The image could not be copied to the clipboard.");
  });

  it("adds pasted and picked images as layers on the same board", async () => {
    const { editor, toolbar, layers, storeAsset } = await mount();
    const file = { type: "image/png", name: "a.png", size: 4, lastModified: 1, arrayBuffer: async () => new ArrayBuffer(4) };
    const paste = {
      target: document.body,
      clipboardData: { items: [{ kind: "file", getAsFile: () => file }], files: [], getData: () => "" },
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as unknown as ClipboardEvent;

    expect(editor.handlePaste(paste)).toBe(true);
    await flushImageBoard();

    expect(paste.preventDefault).toHaveBeenCalled();
    expect(storeAsset).toHaveBeenCalledWith(expect.any(ArrayBuffer), "image/png");
    // The 400×200 picture takes a comfortable share of the 400×200 frame, centred.
    expect(layers()[1]).toMatchObject({ kind: "image", asset: { path: "Studio/assets/stored-1.png" } });
    expect(layers()[1].width).toBeCloseTo(0.6, 6);
    expect(layers()[1].x).toBeCloseTo(0.2, 6);

    const picker = toolbar.querySelector<HTMLInputElement>('[data-testid="studio.image.file-input"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [file, { ...file, type: "application/pdf" }] });
    picker.dispatchEvent(new Event("change"));
    await flushImageBoard();

    expect(layers().filter((layer) => layer.kind === "image")).toHaveLength(2);
  });

  it("places a small stacked image large enough to grab", async () => {
    const { toolbar, layers } = await mount();
    (globalThis.createImageBitmap as jest.Mock).mockResolvedValueOnce({ width: 40, height: 20, close: jest.fn() });
    const file = { type: "image/png", name: "tiny.png", size: 4, lastModified: 1, arrayBuffer: async () => new ArrayBuffer(4) };

    const picker = toolbar.querySelector<HTMLInputElement>('[data-testid="studio.image.file-input"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [file] });
    picker.dispatchEvent(new Event("change"));
    await flushImageBoard();

    // A tenth of the frame at its own size, so it is shown at three tenths.
    expect(layers()[1]).toMatchObject({ kind: "image" });
    expect(layers()[1].width).toBeCloseTo(0.3, 6);
    expect(layers()[1].height).toBeCloseTo(0.3, 6);
    expect(layers()[1].x).toBeCloseTo(0.35, 6);
  });

  it("flattens once on Done, records the image, and closes", async () => {
    const { stage, button, store, storeAsset, onClose, encoded, commits } = await mount();
    button("studio.image.tool.redact").click();
    drag(stage, [40, 80], [240, 120]);

    button("studio.image.done").click();
    await flushImageBoard();

    expect(storeAsset).toHaveBeenCalledTimes(1);
    expect(storeAsset).toHaveBeenCalledWith(encoded, "image/png");
    const board = readStudioImageBoard(store);
    expect(board.lastRenderedAsset).toMatchObject({ path: "Studio/assets/stored-1.png" });
    expect(board.sourceAssetPath).toBe(SOURCE.path);
    // The picture is on record as being of exactly these layers.
    expect(board.lastRenderedOf).toBe(studioImageBoardDrawingKey(board));
    // Recording the render is bookkeeping, not an edit to undo.
    expect(commits[commits.length - 1]).toEqual({ mode: "discrete", captureHistory: false });
    expect(onClose).toHaveBeenCalledWith("node_media");
  });

  it("closes without producing anything when nothing was edited", async () => {
    const { button, storeAsset, onClose, commits } = await mount();

    button("studio.image.done").click();
    await flushImageBoard();

    expect(storeAsset).not.toHaveBeenCalled();
    expect(commits).toEqual([]);
    expect(onClose).toHaveBeenCalledWith("node_media");
  });

  it("follows an undo made by Studio without remounting", async () => {
    const { editor, stage, button, store } = await mount();
    const empty = JSON.parse(JSON.stringify(store)) as Record<string, StudioJsonValue>;
    button("studio.image.tool.rect").click();
    drag(stage, [100, 50], [300, 150]);
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(true);

    editor.syncNode({ id: "node_media", kind: "studio.media_ingest", version: "1.0.0", title: "Media", position: { x: 0, y: 0 }, config: empty, continueOnError: false, disabled: false });

    expect(stage.isConnected).toBe(true);
    expect(stage.querySelector(".ss-studio-image-board__selection")!.classList.contains("is-visible")).toBe(false);
  });

  it("says why when the image cannot be opened, and still lets you leave", async () => {
    installImageBoardTestCanvas();
    const contentEl = document.body.createDiv();
    const toolbarHost = document.body.createDiv();
    const onClose = jest.fn();
    mountStudioImageBoardEditor({
      app: {} as App,
      contentEl,
      toolbarHost,
      toolbarDocked: true,
      node: { id: "n", kind: "studio.media_ingest", version: "1.0.0", title: "", position: { x: 0, y: 0 }, config: {}, continueOnError: false, disabled: false },
      nodeRunState: { status: "idle", message: "", updatedAt: null, outputs: null },
      getGraphZoom: () => 1,
      readAsset: async () => new ArrayBuffer(8),
      storeAsset: jest.fn(),
      onNodeConfigValueChange: jest.fn(),
      onClose,
    });
    await flushImageBoard();

    const stage = contentEl.querySelector<HTMLElement>(".ss-studio-image-board")!;
    expect(stage.classList.contains("is-unavailable")).toBe(true);
    expect(stage.textContent).toContain("Run this image node once");
    expect(toolbarHost.querySelector(".ss-studio-image-board-toolbar")!.classList.contains("is-docked")).toBe(true);
    expect(toolbarHost.querySelector<HTMLButtonElement>('[data-testid="studio.image.tool.text"]')!.disabled).toBe(true);

    toolbarHost.querySelector<HTMLButtonElement>('[data-testid="studio.image.done"]')!.click();
    await flushImageBoard();
    expect(onClose).toHaveBeenCalledWith("n");
  });
});
