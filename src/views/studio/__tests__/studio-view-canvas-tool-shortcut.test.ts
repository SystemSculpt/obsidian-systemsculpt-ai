/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";
import type { StudioCanvasTool } from "../StudioCanvasTool";
import { isStudioGraphEditableTarget } from "../StudioGraphDomTargeting";

/**
 * Canvas tool shortcuts must work across the canvas and leave typing alone.
 */
type KeydownContext = {
  isActiveStudioView: jest.Mock<boolean, []>;
  isEditableKeyboardTarget: jest.Mock<boolean, [EventTarget | null]>;
  activeCanvasTool: StudioCanvasTool;
  selectCanvasTool: jest.Mock<void, [StudioCanvasTool]>;
  arrangeGraphFromCommand: jest.Mock<unknown, []>;
  busy: boolean;
  currentProject: unknown;
  shapeController: { hasSelection: jest.Mock<boolean, []>; removeSelection: jest.Mock<void, []> };
  graphInteraction: { getSelectedNodeIds: jest.Mock<string[], []> };
  removeNodes: jest.Mock<void, [string[]]>;
};

const handleWindowKeyDown = (SystemSculptStudioView as any).prototype.handleWindowKeyDown as (
  this: KeydownContext,
  event: KeyboardEvent
) => void;

function createContext(overrides?: Partial<KeydownContext>): KeydownContext {
  return {
    isActiveStudioView: jest.fn(() => true),
    isEditableKeyboardTarget: jest.fn(isStudioGraphEditableTarget),
    activeCanvasTool: "diamond",
    selectCanvasTool: jest.fn(),
    arrangeGraphFromCommand: jest.fn(() => ({})),
    busy: false,
    currentProject: { graph: { nodes: [] } },
    shapeController: { hasSelection: jest.fn(() => false), removeSelection: jest.fn() },
    graphInteraction: { getSelectedNodeIds: jest.fn(() => []) },
    removeNodes: jest.fn(),
    ...overrides,
  };
}

function createKeydownEvent(overrides?: Partial<Record<string, unknown>>): KeyboardEvent {
  return {
    key: "s",
    code: "KeyS",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("SystemSculptStudioView canvas tool shortcut", () => {
  it.each([
    ["b", "rectangle"],
    ["c", "ellipse"],
    ["a", "arrow"],
    ["s", "select"],
    ["Escape", "select"],
  ] as const)("selects %s's tool", (key, tool) => {
    const context = createContext();
    const event = createKeydownEvent({ key });

    handleWindowKeyDown.call(context, event);

    expect(context.selectCanvasTool).toHaveBeenCalledWith(tool);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("disarms an armed shape tool back to the pointer", () => {
    const context = createContext();
    const event = createKeydownEvent();

    handleWindowKeyDown.call(context, event);

    expect(context.selectCanvasTool).toHaveBeenCalledWith("select");
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("disarms the arrow tool too", () => {
    const context = createContext({ activeCanvasTool: "arrow" });

    handleWindowKeyDown.call(context, createKeydownEvent());

    expect(context.selectCanvasTool).toHaveBeenCalledWith("select");
  });

  it("leaves the key alone while typing", () => {
    const context = createContext({ isEditableKeyboardTarget: jest.fn(() => true) });
    const event = createKeydownEvent();

    handleWindowKeyDown.call(context, event);

    expect(context.selectCanvasTool).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    '<input />',
    '<textarea></textarea>',
    '<select></select>',
    '<div contenteditable="true"><span></span></div>',
    '<div contenteditable=""><span></span></div>',
    '<div contenteditable="plaintext-only"><span></span></div>',
    '<div class="cm-editor"><div class="cm-content"></div></div>',
  ])("preserves typing inside %s", (markup) => {
    const root = document.createElement("div");
    root.innerHTML = markup;
    const target = root.querySelector("span, .cm-content") ?? root.firstElementChild;
    const context = createContext();
    for (const key of ["b", "c", "s", "a", "Escape"]) {
      const event = createKeydownEvent({ key, target });
      handleWindowKeyDown.call(context, event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(context.selectCanvasTool).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey", "altKey", "shiftKey", "isComposing"])(
    "leaves box shortcuts alone with %s",
    (modifier) => {
      const context = createContext();
      const event = createKeydownEvent({ key: "b", [modifier]: true });
      handleWindowKeyDown.call(context, event);
      expect(context.selectCanvasTool).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  );

  it.each([
    { busy: true },
    { currentProject: null },
    { isActiveStudioView: jest.fn(() => false) },
  ])("ignores tool shortcuts when unavailable (%j)", (overrides) => {
    const context = createContext(overrides);
    const event = createKeydownEvent({ key: "b" });
    handleWindowKeyDown.call(context, event);
    expect(context.selectCanvasTool).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("does not consume the key when the pointer is already the active tool", () => {
    const context = createContext({ activeCanvasTool: "select" });
    const event = createKeydownEvent();

    handleWindowKeyDown.call(context, event);

    expect(context.selectCanvasTool).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey"])("arranges the graph with %s+A without changing tools", (modifier) => {
    const context = createContext();
    const event = createKeydownEvent({ key: "a", code: "KeyA", [modifier]: true });

    handleWindowKeyDown.call(context, event);

    expect(context.selectCanvasTool).not.toHaveBeenCalled();
    expect(context.arrangeGraphFromCommand).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("SystemSculptStudioView canvas tool gestures", () => {
  it("cancels pending gestures before switching tools", () => {
    const context = {
      activeCanvasTool: "rectangle",
      shapeController: { cancelDrawGesture: jest.fn(), cancelArrowGesture: jest.fn() },
      graphInteraction: { clearPendingConnection: jest.fn() },
      render: jest.fn(),
    };

    (SystemSculptStudioView as any).prototype.selectCanvasTool.call(context, "select");

    expect(context.activeCanvasTool).toBe("select");
    expect(context.shapeController.cancelDrawGesture).toHaveBeenCalledTimes(1);
    expect(context.shapeController.cancelArrowGesture).toHaveBeenCalledTimes(1);
    expect(context.graphInteraction.clearPendingConnection).toHaveBeenCalledTimes(1);
    expect(context.render).toHaveBeenCalledTimes(1);
  });

  it("starts visual arrows from node inputs before editor and node handlers", () => {
    const input = document.createElement("input");
    const event = {
      button: 0,
      target: input,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    const context = {
      activeCanvasTool: "arrow",
      shapeController: { startArrowGesture: jest.fn(() => true) },
      isEditableKeyboardTarget: jest.fn(() => true),
      blurActiveStudioEditableTarget: jest.fn(),
    };

    (SystemSculptStudioView as any).prototype.handleGraphViewportPointerDown.call(context, event);

    expect(context.shapeController.startArrowGesture).toHaveBeenCalledWith(event);
    expect(context.isEditableKeyboardTarget).not.toHaveBeenCalled();
    expect(context.blurActiveStudioEditableTarget).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("leaves background gestures available when no arrow source is hit", () => {
    const event = { button: 0, preventDefault: jest.fn(), stopPropagation: jest.fn() };
    const context = {
      activeCanvasTool: "arrow",
      shapeController: { startArrowGesture: jest.fn(() => false) },
    };

    (SystemSculptStudioView as any).prototype.handleGraphViewportPointerDown.call(context, event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
