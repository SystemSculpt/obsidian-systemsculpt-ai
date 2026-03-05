/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";

type KeydownContext = {
  isActiveStudioView: jest.Mock<boolean, []>;
  isEditableKeyboardTarget: jest.Mock<boolean, [EventTarget | null]>;
  fitSelectedGraphNodesInViewport: jest.Mock<boolean, []>;
  copySelectedGraphNodesToClipboard: jest.Mock<boolean, []>;
  cutSelectedGraphNodesToClipboard: jest.Mock<boolean, []>;
  undoGraphHistory: jest.Mock<boolean, []>;
  redoGraphHistory: jest.Mock<boolean, []>;
  busy: boolean;
  currentProject: unknown;
  graphInteraction: {
    getSelectedNodeIds: jest.Mock<string[], []>;
  };
  removeNodes: jest.Mock<void, [string[]]>;
};

type KeydownEventLike = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault: jest.Mock<void, []>;
  stopPropagation: jest.Mock<void, []>;
};

const handleWindowKeyDown = (SystemSculptStudioView as any).prototype.handleWindowKeyDown as (
  this: KeydownContext,
  event: KeyboardEvent
) => void;

function createContext(overrides?: Partial<KeydownContext>): KeydownContext {
  return {
    isActiveStudioView: jest.fn(() => true),
    isEditableKeyboardTarget: jest.fn(() => false),
    fitSelectedGraphNodesInViewport: jest.fn(() => true),
    copySelectedGraphNodesToClipboard: jest.fn(() => false),
    cutSelectedGraphNodesToClipboard: jest.fn(() => false),
    undoGraphHistory: jest.fn(() => false),
    redoGraphHistory: jest.fn(() => false),
    busy: false,
    currentProject: { graph: { nodes: [] } },
    graphInteraction: {
      getSelectedNodeIds: jest.fn(() => []),
    },
    removeNodes: jest.fn(),
    ...overrides,
  };
}

function createKeydownEvent(overrides?: Partial<KeydownEventLike>): KeyboardEvent {
  const event: KeydownEventLike = {
    key: "1",
    code: "Digit1",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    defaultPrevented: false,
    target: null,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    ...overrides,
  };
  return event as unknown as KeyboardEvent;
}

describe("SystemSculptStudioView fit-selection keyboard shortcut", () => {
  it("handles Mod+Shift+1 even when focus is inside an editable studio target", () => {
    const context = createContext({
      isEditableKeyboardTarget: jest.fn(() => true),
    });
    const event = createKeydownEvent();

    handleWindowKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("handles Mod+Shift+Numpad1 for fit-selection", () => {
    const context = createContext();
    const event = createKeydownEvent({
      key: "1",
      code: "Numpad1",
    });

    handleWindowKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("keeps copy shortcut blocked while editing text targets", () => {
    const context = createContext({
      isEditableKeyboardTarget: jest.fn(() => true),
      copySelectedGraphNodesToClipboard: jest.fn(() => true),
    });
    const event = createKeydownEvent({
      key: "c",
      code: "KeyC",
      shiftKey: false,
    });

    handleWindowKeyDown.call(context, event);

    expect(context.copySelectedGraphNodesToClipboard).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("does not consume Mod+1 without Shift", () => {
    const context = createContext();
    const event = createKeydownEvent({
      shiftKey: false,
    });

    handleWindowKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
