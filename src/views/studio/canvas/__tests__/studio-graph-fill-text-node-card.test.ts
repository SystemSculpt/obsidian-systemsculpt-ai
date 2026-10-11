/**
 * @jest-environment jsdom
 */
import type { StudioNodeInstance } from "../../../../studio/types";
import { renderFillTextNodeCard } from "../StudioGraphFillTextNodeCard";

function createFillTextNode(value: string, overrides: Partial<StudioNodeInstance> = {}): StudioNodeInstance {
  return {
    id: "text_node",
    kind: "studio.text",
    version: "1.0.0",
    title: "Text",
    position: { x: 10, y: 20 },
    size: { width: 320, height: 72 },
    config: { layout: "fill", value },
    continueOnError: false,
    disabled: false,
    ...overrides,
  };
}

function createGraphInteractionStub() {
  return {
    startNodeDrag: jest.fn(),
    getGraphZoom: jest.fn(() => 1),
    toggleNodeSelection: jest.fn(),
    ensureSingleSelection: jest.fn(),
    showNodeResizeGuides: jest.fn(() => null),
    clearAlignmentGuides: jest.fn(),
  };
}

type HarnessOptions = {
  value?: string;
  node?: StudioNodeInstance;
  isEditing?: boolean;
  busy?: boolean;
  shouldAutoFocus?: boolean;
  docked?: boolean;
  registerEditorTeardown?: jest.Mock;
  initialEditorSnapshot?: { selection: { anchor: number; head: number }; scrollTop: number; focused: boolean };
};

function renderHarness(options: HarnessOptions = {}) {
  const node = options.node ?? createFillTextNode(options.value ?? "");
  const workspaceEl = options.docked === false
    ? document.body
    : document.body.createDiv({ cls: "ss-studio-graph-workspace" });
  const nodeEl = workspaceEl.createDiv({ cls: "ss-studio-node-card" });
  const graphInteraction = createGraphInteractionStub();
  const onNodeConfigMutated = jest.fn();
  const onNodeConfigValueChange = jest.fn();
  const onNodeResize = jest.fn();
  const onRequestTextNodeEdit = jest.fn();
  const onStopTextNodeEdit = jest.fn();
  const dispose = renderFillTextNodeCard({
    nodeEl,
    node,
    busy: options.busy ?? false,
    graphInteraction: graphInteraction as never,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeResize,
    onNodeGeometryMutated: jest.fn(),
    isEditing: options.isEditing ?? false,
    shouldAutoFocus: options.shouldAutoFocus ?? false,
    initialEditorSnapshot: options.initialEditorSnapshot,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
    registerEditorTeardown: options.registerEditorTeardown,
  });
  const surface = (): HTMLElement => {
    const el = nodeEl.querySelector<HTMLElement>(".ss-studio-fill-text");
    if (!el) throw new Error("Expected the fill text surface");
    return el;
  };
  const field = (): HTMLTextAreaElement => surface() as HTMLTextAreaElement;
  const toolbar = (): HTMLElement | null => workspaceEl.querySelector<HTMLElement>(".ss-studio-image-board-toolbar");
  const press = (testId: string): void => {
    const button = toolbar()?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!button) throw new Error(`Expected ${testId}`);
    button.click();
  };
  return {
    node,
    nodeEl,
    workspaceEl,
    graphInteraction,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeResize,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
    dispose,
    surface,
    field,
    toolbar,
    press,
    fontPx: (): number => parseFloat(surface().style.fontSize),
  };
}

function pointer(type: string, init: MouseEventInit & { pointerId?: number } = {}): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1, configurable: true });
  return event as PointerEvent;
}

function type(field: HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

// Where there is no canvas to measure with, as here, a character is half an
// em wide at any size, so the sizes below are exact.
describe("renderFillTextNodeCard", () => {
  beforeEach(() => {
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("at rest", () => {
    it("shows the text at the size that fills the box", () => {
      const h = renderHarness({ value: "Hello" });

      expect(h.nodeEl.classList.contains("ss-studio-fill-text-card")).toBe(true);
      expect(h.surface().tagName).toBe("DIV");
      expect(h.surface().textContent).toBe("Hello");
      expect(h.surface().dataset.style).toBe("plain");
      // One line in a 72px box: 72 / (1.12 + 0.12). The width leaves room to spare.
      expect(h.fontPx()).toBeCloseTo(72 / 1.24, 3);
      expect(h.toolbar()).toBeNull();
    });

    it("shrinks the type until the widest line fits the width", () => {
      const short = renderHarness({ value: "Hello" });
      const long = renderHarness({ value: "A much longer line of text than that" });

      // 36 characters at half an em, plus the padding either side, across 320px.
      expect(long.fontPx()).toBeCloseTo(320 / (18 + 0.24), 3);
      expect(long.fontPx()).toBeLessThan(short.fontPx());
    });

    it("shrinks the type until every line fits the height", () => {
      const h = renderHarness({ value: "One\nTwo\nThree" });

      expect(h.fontPx()).toBeCloseTo(72 / (3 * 1.12 + 0.12), 3);
    });

    it("shows a faint placeholder for text that is empty", () => {
      const h = renderHarness({ value: "" });

      expect(h.surface().textContent).toBe("Text");
      expect(h.surface().classList.contains("is-placeholder")).toBe(true);
    });

    it("sizes text with no box of its own to the default box", () => {
      const h = renderHarness({ node: createFillTextNode("Hello", { size: undefined }) });

      expect(h.fontPx()).toBeCloseTo(72 / 1.24, 3);
    });

    it("drags the card on a press and edits on a double click", () => {
      const h = renderHarness({ value: "Hello" });

      h.surface().dispatchEvent(pointer("pointerdown", { clientX: 5, clientY: 5 }));
      expect(h.graphInteraction.startNodeDrag).toHaveBeenCalledWith("text_node", expect.anything(), h.nodeEl);

      h.surface().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      expect(h.graphInteraction.ensureSingleSelection).toHaveBeenCalledWith("text_node");
      expect(h.onRequestTextNodeEdit).toHaveBeenCalledWith("text_node", { x: 5, y: 5 });
    });

    it("toggles selection on a modifier press instead of dragging", () => {
      const h = renderHarness({ value: "Hello" });

      h.surface().dispatchEvent(pointer("pointerdown", { shiftKey: true }));

      expect(h.graphInteraction.toggleNodeSelection).toHaveBeenCalledWith("text_node");
      expect(h.graphInteraction.startNodeDrag).not.toHaveBeenCalled();
    });

    it("stays at rest while the project is busy, even mid-edit", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, busy: true });

      expect(h.surface().tagName).toBe("DIV");
      expect(h.toolbar()).toBeNull();
    });
  });

  describe("resizing", () => {
    it("resizes the type with the box: a bigger box is bigger text", () => {
      const h = renderHarness({ value: "Hello" });
      const before = h.fontPx();

      const zone = h.nodeEl.querySelector<HTMLElement>('[data-resize-zone="se"]');
      zone?.dispatchEvent(pointer("pointerdown", { pointerId: 7, clientX: 0, clientY: 0 }));
      window.dispatchEvent(pointer("pointermove", { pointerId: 7, clientX: 320, clientY: 72 }));
      window.dispatchEvent(pointer("pointerup", { pointerId: 7, clientX: 320, clientY: 72 }));

      expect(h.nodeEl.style.width).toBe("640px");
      expect(h.nodeEl.style.minHeight).toBe("144px");
      expect(h.fontPx()).toBeCloseTo(before * 2, 3);
      // The box is what is saved: both sides, and no font size.
      const patch = h.onNodeResize.mock.calls.at(-1)?.[1];
      expect(patch.size).toEqual({ width: 640, height: 144 });
      expect(patch.fontSize).toBeUndefined();
    });

    it("lets one side move on its own, unlike a Markdown text card", () => {
      const h = renderHarness({ value: "Hello" });

      const zone = h.nodeEl.querySelector<HTMLElement>('[data-resize-zone="s"]');
      zone?.dispatchEvent(pointer("pointerdown", { pointerId: 7, clientX: 0, clientY: 0 }));
      window.dispatchEvent(pointer("pointermove", { pointerId: 7, clientX: 0, clientY: 28 }));
      window.dispatchEvent(pointer("pointerup", { pointerId: 7, clientX: 0, clientY: 28 }));

      expect(h.nodeEl.style.width).toBe("320px");
      expect(h.nodeEl.style.minHeight).toBe("100px");
      expect(h.fontPx()).toBeCloseTo(100 / 1.24, 3);
    });
  });

  describe("editing", () => {
    it("types on the card itself, at the size the text will have", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true });

      expect(h.field().tagName).toBe("TEXTAREA");
      expect(h.field().value).toBe("Hello");
      expect(h.fontPx()).toBeCloseTo(72 / 1.24, 3);
      expect(document.activeElement).toBe(h.field());
      // Typing replaces what was there.
      expect(h.field().selectionStart).toBe(0);
      expect(h.field().selectionEnd).toBe(5);
    });

    it("refits on every keystroke and saves the text as one running edit", () => {
      const h = renderHarness({ value: "", isEditing: true });
      const empty = h.fontPx();

      type(h.field(), "A much longer line of text than that");

      expect(h.fontPx()).toBeCloseTo(320 / (18 + 0.24), 3);
      expect(h.fontPx()).toBeLessThan(empty);
      expect(h.onNodeConfigValueChange).toHaveBeenCalledWith(
        "text_node",
        "value",
        "A much longer line of text than that",
        { mode: "continuous", captureHistory: false }
      );
    });

    it("starts an empty box at the size of its placeholder", () => {
      const h = renderHarness({ value: "", isEditing: true });

      expect(h.field().placeholder).toBe("Text");
      expect(h.fontPx()).toBeCloseTo(72 / 1.24, 3);
    });

    it.each([
      ["Escape", {}],
      ["Enter", { metaKey: true }],
      ["Enter", { ctrlKey: true }],
    ])("finishes on %s %j", (key, modifiers) => {
      const h = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true });

      h.field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));

      expect(h.onStopTextNodeEdit).toHaveBeenCalledWith("text_node");
    });

    it("keeps a plain Enter as a new line", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true });

      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      h.field().dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(h.onStopTextNodeEdit).not.toHaveBeenCalled();
    });

    it("finishes when focus leaves the text", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true });

      h.field().blur();

      expect(h.onStopTextNodeEdit).toHaveBeenCalledWith("text_node");
    });

    it("picks the caret up where it was when the card is remounted mid-edit", () => {
      const registerEditorTeardown = jest.fn();
      const first = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true, registerEditorTeardown });
      first.field().setSelectionRange(2, 4);

      const snapshot = registerEditorTeardown.mock.calls[0][1]();
      first.dispose();
      first.field().blur();

      expect(snapshot).toEqual({ selection: { anchor: 2, head: 4 }, scrollTop: 0, focused: true });
      // Taking the card down is not leaving the text.
      expect(first.onStopTextNodeEdit).not.toHaveBeenCalled();

      const second = renderHarness({ value: "Hello", isEditing: true, initialEditorSnapshot: snapshot });
      expect(second.field().selectionStart).toBe(2);
      expect(second.field().selectionEnd).toBe(4);
      expect(document.activeElement).toBe(second.field());
    });
  });

  describe("style bar", () => {
    it("docks in the workspace while the text is being typed and leaves with the edit", () => {
      const h = renderHarness({ value: "Hello", isEditing: true });

      expect(h.toolbar()?.parentElement).toBe(h.workspaceEl);
      expect(h.toolbar()?.classList.contains("is-docked")).toBe(true);
      expect(h.toolbar()?.querySelector('[data-testid="studio.text.style.plain"]')?.classList.contains("is-selected")).toBe(true);
      expect(h.toolbar()?.querySelector('[data-testid="studio.text.align.center"]')?.classList.contains("is-selected")).toBe(true);
      expect(h.toolbar()?.querySelector('[data-testid="studio.text.color.auto"]')?.classList.contains("is-selected")).toBe(true);

      h.dispose();
      expect(h.toolbar()).toBeNull();
    });

    it("hangs off the card where there is no workspace to dock in", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, docked: false });

      const toolbar = h.nodeEl.querySelector(".ss-studio-image-board-toolbar");
      expect(toolbar).not.toBeNull();
      expect(toolbar?.classList.contains("is-docked")).toBe(false);
    });

    it("restyles the text in place and saves each choice as its own step", () => {
      const h = renderHarness({ value: "Hello", isEditing: true });
      const plain = h.fontPx();

      h.press("studio.text.style.meme");
      expect(h.field().dataset.style).toBe("meme");
      // The meme outline needs a little more room, so the same box sets it a touch smaller.
      expect(h.fontPx()).toBeCloseTo(72 / (1.12 + 0.14), 3);
      expect(h.fontPx()).toBeLessThan(plain);
      expect(h.field().style.webkitTextStroke).not.toBe("");

      h.press("studio.text.align.left");
      expect(h.field().style.textAlign).toBe("left");

      h.press("studio.text.color.red");
      expect(h.field().style.color).toBe("rgb(255, 59, 48)");

      const chosen = { mode: "discrete", captureHistory: true };
      expect(h.onNodeConfigValueChange.mock.calls).toEqual([
        ["text_node", "textStyle", "meme", chosen],
        ["text_node", "textAlign", "left", chosen],
        ["text_node", "textColor", "#ff3b30", chosen],
      ]);
      expect(h.toolbar()?.querySelector('[data-testid="studio.text.style.meme"]')?.classList.contains("is-selected")).toBe(true);
      expect(h.toolbar()?.querySelector('[data-testid="studio.text.color.red"]')?.classList.contains("is-selected")).toBe(true);
      expect(h.toolbar()?.querySelector('[data-testid="studio.text.color.auto"]')?.classList.contains("is-selected")).toBe(false);
    });

    it("goes back to the canvas's own ink on Auto", () => {
      const node = createFillTextNode("Hello", { config: { layout: "fill", value: "Hello", textColor: "#ff3b30" } });
      const h = renderHarness({ node, isEditing: true });
      expect(h.field().style.color).toBe("rgb(255, 59, 48)");

      h.press("studio.text.color.auto");

      expect(h.field().style.color).toBe("");
      expect(h.onNodeConfigValueChange).toHaveBeenCalledWith("text_node", "textColor", "", {
        mode: "discrete",
        captureHistory: true,
      });
    });

    it("keeps the caret in the text when a control is pressed", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true });
      const button = h.toolbar()?.querySelector<HTMLElement>('[data-testid="studio.text.style.meme"]');

      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      button?.dispatchEvent(down);

      expect(down.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(h.field());
      expect(h.onStopTextNodeEdit).not.toHaveBeenCalled();
    });

    it("treats the colour picker as part of the edit, and one drag through it as one step", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true });
      const picker = h.toolbar()?.querySelector<HTMLInputElement>('[data-testid="studio.text.color.custom"]');
      if (!picker) throw new Error("Expected the colour picker");

      h.field().dispatchEvent(new FocusEvent("blur", { relatedTarget: picker }));
      expect(h.onStopTextNodeEdit).not.toHaveBeenCalled();

      picker.value = "#123456";
      picker.dispatchEvent(new Event("input", { bubbles: true }));
      picker.value = "#654321";
      picker.dispatchEvent(new Event("input", { bubbles: true }));

      expect(h.field().style.color).toBe("rgb(101, 67, 33)");
      expect(h.onNodeConfigValueChange.mock.calls).toEqual([
        ["text_node", "textColor", "#123456", { mode: "continuous", captureHistory: true }],
        ["text_node", "textColor", "#654321", { mode: "continuous", captureHistory: false }],
      ]);

      // Closing the picker hands the caret back.
      h.field().blur();
      h.onStopTextNodeEdit.mockClear();
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      expect(document.activeElement).toBe(h.field());
      expect(h.onStopTextNodeEdit).not.toHaveBeenCalled();
    });

    it("ends the edit when focus leaves the colour picker for anything but the text", () => {
      const h = renderHarness({ value: "Hello", isEditing: true, shouldAutoFocus: true });
      const picker = h.toolbar()?.querySelector<HTMLInputElement>('[data-testid="studio.text.color.custom"]');

      picker?.dispatchEvent(new FocusEvent("blur", { relatedTarget: h.field() }));
      expect(h.onStopTextNodeEdit).not.toHaveBeenCalled();

      picker?.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
      expect(h.onStopTextNodeEdit).toHaveBeenCalledWith("text_node");
    });
  });
});
