/**
 * @jest-environment jsdom
 */
import type { StudioDiagram } from "../../../../studio/types";
import {
  clearStudioShapeSelectionVisuals,
  EMPTY_STUDIO_SHAPE_SELECTION,
  renderStudioShapeLayer,
  type StudioShapeLayerOptions,
  type StudioShapeSelection,
} from "../StudioShapeLayer";

function pointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "button", { value: 0 });
  return event as PointerEvent;
}

function diagramFixture(): StudioDiagram {
  return {
    shapes: [
      {
        id: "s1",
        shape: "rectangle",
        position: { x: 100, y: 100 },
        size: { width: 100, height: 100 },
        label: "One",
      },
      {
        id: "s2",
        shape: "ellipse",
        position: { x: 400, y: 100 },
        size: { width: 100, height: 100 },
        label: "Two",
      },
    ],
    arrows: [{ id: "a1", fromShapeId: "s1", toShapeId: "s2" }],
  };
}

function mount(overrides?: Partial<StudioShapeLayerOptions>) {
  document.body.empty();
  const canvas = document.body.createDiv({ cls: "ss-studio-graph-canvas" });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  const spies = {
    onSelect: jest.fn(),
    onMoveSelection: jest.fn(),
    onResizeShape: jest.fn(),
    onLabelChange: jest.fn(),
    onArrowLabelChange: jest.fn(),
    onConnectShapes: jest.fn(),
  };
  const options: StudioShapeLayerOptions = {
    canvasEl: canvas,
    diagram: diagramFixture(),
    busy: false,
    activeCanvasTool: "select",
    selection: EMPTY_STUDIO_SHAPE_SELECTION,
    getGraphZoom: () => 1,
    ...spies,
    ...overrides,
  };
  renderStudioShapeLayer(options);
  return { canvas, ...spies };
}

function shapeEl(canvas: HTMLElement, shapeId: string): HTMLElement {
  const el = canvas.querySelector<HTMLElement>(`.ss-studio-shape[data-shape-id="${shapeId}"]`);
  if (!el) {
    throw new Error(`missing shape ${shapeId}`);
  }
  return el;
}

describe("studio shape layer", () => {
  it("renders shapes at their stored geometry and an arrow between them", () => {
    const { canvas } = mount();

    const first = shapeEl(canvas, "s1");
    expect(first.dataset.shape).toBe("rectangle");
    expect(first.style.left).toBe("100px");
    expect(first.style.width).toBe("100px");
    expect(canvas.querySelector(".ss-studio-shape-label")?.textContent).toBe("One");

    // Border to border along the center line, stopping 3px short of the target.
    const line = canvas.querySelector(".ss-studio-shape-arrow-line")?.getAttribute("d");
    expect(line).toBe("M 200.00 150.00 L 397.00 150.00");
  });

  it("draws each shape as its own outline path", () => {
    const { canvas } = mount({
      diagram: {
        shapes: [
          {
            id: "s1",
            shape: "diamond",
            position: { x: 0, y: 0 },
            size: { width: 200, height: 100 },
            label: "",
          },
          {
            id: "s2",
            shape: "cylinder",
            position: { x: 400, y: 0 },
            size: { width: 200, height: 100 },
            label: "",
          },
        ],
        arrows: [],
      },
    });

    const diamond = shapeEl(canvas, "s1");
    expect(diamond.querySelector(".ss-studio-shape-outline")?.getAttribute("viewBox")).toBe(
      "0 0 200 100"
    );
    expect(diamond.querySelector(".ss-studio-shape-outline-body")?.getAttribute("d")).toBe(
      "M 100.00 0.00 L 200.00 50.00 L 100.00 100.00 L 0.00 50.00 Z"
    );
    // Only kinds with an interior line carry one: the cylinder rim, not the diamond.
    expect(diamond.querySelector(".ss-studio-shape-outline-detail")?.getAttribute("d")).toBe("");
    expect(
      shapeEl(canvas, "s2").querySelector(".ss-studio-shape-outline-detail")?.getAttribute("d")
    ).not.toBe("");
  });

  it("fans the two directions of a round trip apart", () => {
    const diagram = diagramFixture();
    diagram.arrows.push({ id: "a2", fromShapeId: "s2", toShapeId: "s1" });
    const { canvas } = mount({ diagram });

    const lines = Array.from(canvas.querySelectorAll(".ss-studio-shape-arrow-line")).map((path) =>
      path.getAttribute("d")
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
  });

  it("reports one drag of the whole selection: first frame opens it, release closes it", () => {
    const { canvas, onMoveSelection, onSelect } = mount();

    shapeEl(canvas, "s1").dispatchEvent(pointerEvent("pointerdown", 150, 150));
    window.dispatchEvent(pointerEvent("pointermove", 190, 170));
    window.dispatchEvent(pointerEvent("pointermove", 250, 200));
    expect(shapeEl(canvas, "s1").style.left).toBe("200px");

    expect(onSelect).toHaveBeenCalledWith({ type: "shape", id: "s1" }, { additive: false });
    // Only the first frame opens the history entry, so the drag undoes as one.
    expect(onMoveSelection.mock.calls[0]).toEqual([{ x: 40, y: 20 }, { first: true, final: false }]);
    expect(onMoveSelection.mock.calls[1]).toEqual([
      { x: 100, y: 50 },
      { first: false, final: false },
    ]);

    window.dispatchEvent(pointerEvent("pointerup", 250, 200));

    expect(onMoveSelection).toHaveBeenLastCalledWith(
      { x: 100, y: 50 },
      { first: false, final: true }
    );
  });

  it("drags every selected shape, not just the one under the pointer", () => {
    const { canvas } = mount({ selection: { shapeIds: ["s1", "s2"], arrowIds: [] } });

    shapeEl(canvas, "s1").dispatchEvent(pointerEvent("pointerdown", 150, 150));
    window.dispatchEvent(pointerEvent("pointermove", 200, 150));

    expect(shapeEl(canvas, "s1").style.left).toBe("150px");
    expect(shapeEl(canvas, "s2").style.left).toBe("450px");
  });

  it("adds to the selection when the pointer chord is additive", () => {
    const { canvas, onSelect } = mount();
    const event = pointerEvent("pointerdown", 150, 150);
    Object.defineProperty(event, "shiftKey", { value: true });

    shapeEl(canvas, "s1").dispatchEvent(event);

    expect(onSelect).toHaveBeenCalledWith({ type: "shape", id: "s1" }, { additive: true });
  });

  it("redraws arrows live while a connected shape moves", () => {
    const { canvas } = mount();

    shapeEl(canvas, "s1").dispatchEvent(pointerEvent("pointerdown", 150, 150));
    window.dispatchEvent(pointerEvent("pointermove", 150, 350));

    const line = canvas.querySelector(".ss-studio-shape-arrow-line")?.getAttribute("d");
    expect(line).not.toBe("M 200.00 150.00 L 397.00 150.00");
  });

  it("ignores a move that never passes the drag threshold", () => {
    const { canvas, onMoveSelection } = mount();

    shapeEl(canvas, "s1").dispatchEvent(pointerEvent("pointerdown", 150, 150));
    window.dispatchEvent(pointerEvent("pointermove", 151, 151));
    window.dispatchEvent(pointerEvent("pointerup", 151, 151));

    expect(onMoveSelection).not.toHaveBeenCalled();
  });

  it("connects two shapes when the arrow tool is released over the target", () => {
    const { canvas, onConnectShapes } = mount({ activeCanvasTool: "arrow" });
    const target = shapeEl(canvas, "s2");
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => target;

    shapeEl(canvas, "s1").dispatchEvent(pointerEvent("pointerdown", 150, 150));
    window.dispatchEvent(pointerEvent("pointermove", 300, 150));
    expect(canvas.querySelector(".ss-studio-shape-arrow-preview")).not.toBeNull();

    window.dispatchEvent(pointerEvent("pointerup", 450, 150));

    expect(onConnectShapes).toHaveBeenCalledWith("s1", "s2");
    expect(canvas.querySelector(".ss-studio-shape-arrow-preview")).toBeNull();
  });

  it("never connects a shape to itself", () => {
    const { canvas, onConnectShapes } = mount({ activeCanvasTool: "arrow" });
    const source = shapeEl(canvas, "s1");
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => source;

    source.dispatchEvent(pointerEvent("pointerdown", 150, 150));
    window.dispatchEvent(pointerEvent("pointerup", 160, 160));

    expect(onConnectShapes).not.toHaveBeenCalled();
  });

  it("resizes from a corner handle, pinning the opposite edge", () => {
    const selection: StudioShapeSelection = { shapeIds: ["s1"], arrowIds: [] };
    const { canvas, onResizeShape } = mount({ selection });

    const handle = shapeEl(canvas, "s1").querySelector<HTMLElement>(
      '.ss-studio-shape-handle[data-corner="nw"]'
    );
    expect(handle).not.toBeNull();
    handle?.dispatchEvent(pointerEvent("pointerdown", 100, 100));
    window.dispatchEvent(pointerEvent("pointermove", 60, 50));
    window.dispatchEvent(pointerEvent("pointerup", 60, 50));

    expect(onResizeShape).toHaveBeenCalledWith("s1", { x: 60, y: 50, width: 140, height: 150 });
  });

  it("edits the label in place and commits multiline text on blur", () => {
    const { canvas, onLabelChange } = mount();

    shapeEl(canvas, "s1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const editor = canvas.querySelector<HTMLElement>('[data-testid="studio.shape.label-editor"]');
    // The label element itself becomes the editor; nothing is swapped in.
    expect(editor?.classList.contains("ss-studio-shape-label")).toBe(true);
    expect(editor?.textContent).toBe("One");

    editor!.textContent = "Line one\nLine two";
    editor!.dispatchEvent(new FocusEvent("blur"));

    expect(onLabelChange).toHaveBeenCalledWith("s1", "Line one\nLine two");
    expect(canvas.querySelector('[data-testid="studio.shape.label-editor"]')).toBeNull();
  });

  it("commits a label on Cmd+Enter and reverts it on Escape", () => {
    const { canvas, onLabelChange } = mount();

    shapeEl(canvas, "s1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const editor = canvas.querySelector<HTMLElement>('[data-testid="studio.shape.label-editor"]');
    editor!.textContent = "Renamed";
    // Plain Enter stays inside the editor: it is the newline key, not commit.
    editor!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onLabelChange).not.toHaveBeenCalled();
    editor!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    expect(onLabelChange).toHaveBeenCalledWith("s1", "Renamed");

    shapeEl(canvas, "s1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const second = canvas.querySelector<HTMLElement>('[data-testid="studio.shape.label-editor"]');
    second!.textContent = "Discarded";
    second!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onLabelChange).toHaveBeenCalledTimes(1);
    expect(canvas.querySelector('[data-testid="studio.shape.label-editor"]')).toBeNull();
    // The revert restores the text the edit started from.
    expect(canvas.querySelector(".ss-studio-shape-label")?.textContent).toBe("One");
  });

  it("renders an arrow label at the line's midpoint", () => {
    const diagram = diagramFixture();
    diagram.arrows = [{ id: "a1", fromShapeId: "s1", toShapeId: "s2", label: "flows" }];
    const { canvas } = mount({ diagram });

    const label = canvas.querySelector<HTMLElement>(".ss-studio-shape-arrow-label");
    expect(label?.textContent).toBe("flows");
    expect(label?.dataset.arrowId).toBe("a1");
    // Halfway along "M 200.00 150.00 L 397.00 150.00".
    expect(label?.style.left).toBe("298.5px");
    expect(label?.style.top).toBe("150px");
  });

  it("edits an arrow label from its hit path", () => {
    const { canvas, onArrowLabelChange } = mount();

    canvas
      .querySelector(".ss-studio-shape-arrow-hit")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const editor = canvas.querySelector<HTMLElement>('[data-testid="studio.arrow.label-editor"]');
    expect(editor?.classList.contains("ss-studio-shape-arrow-label")).toBe(true);

    editor!.textContent = "hands off";
    editor!.dispatchEvent(new FocusEvent("blur"));

    expect(onArrowLabelChange).toHaveBeenCalledWith("a1", "hands off");
    expect(canvas.querySelector('[data-testid="studio.arrow.label-editor"]')).toBeNull();
  });

  it("selects an arrow from its label", () => {
    const diagram = diagramFixture();
    diagram.arrows = [{ id: "a1", fromShapeId: "s1", toShapeId: "s2", label: "flows" }];
    const { canvas, onSelect } = mount({ diagram });

    canvas
      .querySelector(".ss-studio-shape-arrow-label")
      ?.dispatchEvent(pointerEvent("pointerdown", 298, 150));

    expect(onSelect).toHaveBeenCalledWith({ type: "arrow", id: "a1" }, { additive: false });
  });

  it("selects an arrow from its hit path", () => {
    const { canvas, onSelect } = mount();

    canvas
      .querySelector(".ss-studio-shape-arrow-hit")
      ?.dispatchEvent(pointerEvent("pointerdown", 300, 150));

    expect(onSelect).toHaveBeenCalledWith({ type: "arrow", id: "a1" }, { additive: false });
  });

  it("clears selection visuals in place, without a re-render", () => {
    const { canvas } = mount({ selection: { shapeIds: ["s1"], arrowIds: [] } });
    expect(canvas.querySelectorAll(".ss-studio-shape-handle")).toHaveLength(4);

    clearStudioShapeSelectionVisuals(canvas);

    expect(canvas.querySelectorAll(".ss-studio-shape-handle")).toHaveLength(0);
    expect(shapeEl(canvas, "s1").classList.contains("is-selected")).toBe(false);
  });

  it("draws in graph coordinates under zoom", () => {
    const { canvas, onMoveSelection } = mount({ getGraphZoom: () => 2 });

    shapeEl(canvas, "s1").dispatchEvent(pointerEvent("pointerdown", 300, 300));
    window.dispatchEvent(pointerEvent("pointermove", 400, 300));
    window.dispatchEvent(pointerEvent("pointerup", 400, 300));

    // 100 screen px at 2× zoom is 50 graph px.
    expect(onMoveSelection).toHaveBeenCalledWith({ x: 50, y: 0 }, { first: true, final: false });
  });
});
