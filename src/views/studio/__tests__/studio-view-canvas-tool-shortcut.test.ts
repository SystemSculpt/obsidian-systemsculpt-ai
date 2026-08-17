/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";
import type { StudioCanvasTool } from "../StudioCanvasTool";

/**
 * "A" is the way back to the pointer. An armed shape or arrow tool otherwise
 * stays armed, so this key has to work from anywhere on the canvas — and never
 * while the user is typing.
 */
type KeydownContext = {
  isActiveStudioView: jest.Mock<boolean, []>;
  isEditableKeyboardTarget: jest.Mock<boolean, [EventTarget | null]>;
  activeCanvasTool: StudioCanvasTool;
  selectCanvasTool: jest.Mock<void, [StudioCanvasTool]>;
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
    isEditableKeyboardTarget: jest.fn(() => false),
    activeCanvasTool: "diamond",
    selectCanvasTool: jest.fn(),
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
    key: "a",
    code: "KeyA",
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

  it("does not consume the key when the pointer is already the active tool", () => {
    const context = createContext({ activeCanvasTool: "select" });
    const event = createKeydownEvent();

    handleWindowKeyDown.call(context, event);

    expect(context.selectCanvasTool).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps Mod+A available for the host", () => {
    const context = createContext();
    const event = createKeydownEvent({ metaKey: true });

    handleWindowKeyDown.call(context, event);

    expect(context.selectCanvasTool).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
