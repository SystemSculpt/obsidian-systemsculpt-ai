/** @jest-environment jsdom */

import { App, Scope, type WorkspaceLeaf } from "obsidian";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

type KeydownContext = {
  isActiveStudioView: jest.Mock<boolean, []>;
  isEditableKeyboardTarget: jest.Mock<boolean, [EventTarget | null]>;
  fitSelectedGraphNodesInViewport: jest.Mock<boolean, []>;
  fitGraphOverviewInViewport: jest.Mock<boolean, []>;
  arrangeGraphFromCommand: jest.Mock<unknown, []>;
  clipboardAndDropController: {
    copySelectedGraphNodes: jest.Mock<boolean, []>;
    cutSelectedGraphNodes: jest.Mock<boolean, []>;
  };
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
    fitGraphOverviewInViewport: jest.fn(() => true),
    arrangeGraphFromCommand: jest.fn(() => ({})),
    clipboardAndDropController: {
      copySelectedGraphNodes: jest.fn(() => false),
      cutSelectedGraphNodes: jest.fn(() => false),
    },
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
  it.each(["a", "f"])("handles Mod+%s in the view scope before host bindings, only once", (key) => {
    const app = new App();
    app.scope = new Scope();
    const view = new SystemSculptStudioView({ app } as WorkspaceLeaf, {} as any);
    jest.spyOn(view as any, "isActiveStudioView").mockReturnValue(true);
    const fit = jest.spyOn(view as any, "fitSelectedGraphNodesInViewport").mockReturnValue(true);
    const arrange = jest.spyOn(view, "arrangeGraphFromCommand").mockReturnValue({} as any);
    const scope = view.scope as unknown as {
      parent: Scope;
      keys: { key: string; modifiers: string[]; func: (event: KeyboardEvent) => unknown }[];
    };
    const binding = scope.keys.find((entry) => entry.key === key)!;
    const event = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true });

    expect(scope.parent).toBe(app.scope);
    expect(binding.modifiers).toEqual(["Mod"]);
    expect(binding.func(event)).toBe(false);
    (view as any).handleWindowKeyDown(event);
    expect(key === "f" ? fit : arrange).toHaveBeenCalledTimes(1);

    const fieldEvent = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true });
    Object.defineProperty(fieldEvent, "target", { value: document.createElement("textarea") });
    expect(binding.func(fieldEvent)).toBeUndefined();
    expect(fieldEvent.defaultPrevented).toBe(false);
    expect(key === "f" ? fit : arrange).toHaveBeenCalledTimes(1);
  });

  it.each(["metaKey", "ctrlKey"])("fits selected nodes with %s+F", (modifier) => {
    const context = createContext();
    const event = createKeydownEvent({
      key: "f", code: "KeyF", metaKey: false, shiftKey: false, [modifier]: true,
    });

    handleWindowKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).toHaveBeenCalledTimes(1);
    expect(context.fitGraphOverviewInViewport).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("fits the whole graph with Mod+F when nothing is selected", () => {
    const context = createContext({ fitSelectedGraphNodesInViewport: jest.fn(() => false) });
    const event = createKeydownEvent({ key: "f", code: "KeyF", shiftKey: false });

    handleWindowKeyDown.call(context, event);

    expect(context.fitGraphOverviewInViewport).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each(["a", "f"])("preserves Mod+%s in text fields and embedded editors", (key) => {
    const context = createContext({ isEditableKeyboardTarget: jest.fn(() => true) });
    const event = createKeydownEvent({ key, code: `Key${key.toUpperCase()}`, shiftKey: false });

    handleWindowKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).not.toHaveBeenCalled();
    expect(context.fitGraphOverviewInViewport).not.toHaveBeenCalled();
    expect(context.arrangeGraphFromCommand).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each(["a", "f"])("ignores Mod+%s outside the active Studio view", (key) => {
    const context = createContext({ isActiveStudioView: jest.fn(() => false) });
    const event = createKeydownEvent({ key, code: `Key${key.toUpperCase()}`, shiftKey: false });

    handleWindowKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).not.toHaveBeenCalled();
    expect(context.fitGraphOverviewInViewport).not.toHaveBeenCalled();
    expect(context.arrangeGraphFromCommand).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

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
      clipboardAndDropController: {
        copySelectedGraphNodes: jest.fn(() => true),
        cutSelectedGraphNodes: jest.fn(() => false),
      },
    });
    const event = createKeydownEvent({
      key: "c",
      code: "KeyC",
      shiftKey: false,
    });

    handleWindowKeyDown.call(context, event);

    expect(context.clipboardAndDropController.copySelectedGraphNodes).not.toHaveBeenCalled();
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
