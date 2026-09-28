/** @jest-environment jsdom */

import { App, Scope, type WorkspaceLeaf } from "obsidian";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

type KeydownContext = {
  ownsKeyboardTarget: jest.Mock<boolean, [EventTarget | null]>;
  isEditableKeyboardTarget: jest.Mock<boolean, [EventTarget | null]>;
  fitSelectedGraphNodesInViewport: jest.Mock<boolean, []>;
  fitGraphOverviewInViewport: jest.Mock<boolean, []>;
  clipboardAndDropController: {
    copySelectedGraphNodes: jest.Mock<boolean, []>;
    cutSelectedGraphNodes: jest.Mock<boolean, []>;
  };
  undoGraphHistory: jest.Mock<boolean, []>;
  redoGraphHistory: jest.Mock<boolean, []>;
  busy: boolean;
  currentProject: unknown;
  graphInteraction: {
    getSelectedNodeIds: jest.Mock<string[], []>; setSelectedNodeIds: jest.Mock<void, [string[]]>;
  };
  shapeController: { setSelectedShapeIds: jest.Mock<void, [string[]]> };
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

const handleCanvasKeyDown = (SystemSculptStudioView as any).prototype.handleCanvasKeyDown as (
  this: KeydownContext,
  event: KeyboardEvent
) => boolean;

function createContext(overrides?: Partial<KeydownContext>): KeydownContext {
  return {
    ownsKeyboardTarget: jest.fn(() => true),
    isEditableKeyboardTarget: jest.fn(() => false),
    fitSelectedGraphNodesInViewport: jest.fn(() => true),
    fitGraphOverviewInViewport: jest.fn(() => true),
    clipboardAndDropController: {
      copySelectedGraphNodes: jest.fn(() => false),
      cutSelectedGraphNodes: jest.fn(() => false),
    },
    undoGraphHistory: jest.fn(() => false),
    redoGraphHistory: jest.fn(() => false),
    busy: false,
    currentProject: { graph: { nodes: [] } },
    graphInteraction: {
      setSelectedNodeIds: jest.fn(), getSelectedNodeIds: jest.fn(() => []),
    },
    shapeController: { setSelectedShapeIds: jest.fn() },
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
    document.body.appendChild(view.containerEl);
    const fit = jest.spyOn(view as any, "fitSelectedGraphNodesInViewport").mockReturnValue(true);
    const select = jest.spyOn((view as any).graphInteraction, "setSelectedNodeIds").mockImplementation(() => undefined);
    jest.spyOn(view as any, "currentProject", "get").mockReturnValue({ graph: { nodes: [] } });
    const scope = view.scope as unknown as {
      parent: Scope;
      keys: { key: string | null; modifiers: string[] | null; func: (event: KeyboardEvent) => unknown }[];
    };
    // One catch-all binding: canvas shortcuts win, anything unhandled falls through to app.scope.
    expect(scope.parent).toBe(app.scope);
    expect(scope.keys).toHaveLength(1);
    const binding = scope.keys[0];
    expect(binding.modifiers).toBeNull();
    expect(binding.key).toBeNull();

    const event = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(binding.func(event)).toBe(false);
    expect(key === "f" ? fit : select).toHaveBeenCalledTimes(1);

    const field = view.contentEl.createEl("textarea");
    const fieldEvent = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true });
    field.dispatchEvent(fieldEvent);
    expect(binding.func(fieldEvent)).toBeUndefined();
    expect(fieldEvent.defaultPrevented).toBe(false);
    expect(key === "f" ? fit : select).toHaveBeenCalledTimes(1);
    view.containerEl.remove();
  });

  it.each(["metaKey", "ctrlKey"])("fits selected nodes with %s+F", (modifier) => {
    const context = createContext();
    const event = createKeydownEvent({
      key: "f", code: "KeyF", metaKey: false, shiftKey: false, [modifier]: true,
    });

    handleCanvasKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).toHaveBeenCalledTimes(1);
    expect(context.fitGraphOverviewInViewport).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("fits the whole graph with Mod+F when nothing is selected", () => {
    const context = createContext({ fitSelectedGraphNodesInViewport: jest.fn(() => false) });
    const event = createKeydownEvent({ key: "f", code: "KeyF", shiftKey: false });

    handleCanvasKeyDown.call(context, event);

    expect(context.fitGraphOverviewInViewport).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each(["a", "f"])("preserves Mod+%s in text fields and embedded editors", (key) => {
    const context = createContext({ isEditableKeyboardTarget: jest.fn(() => true) });
    const event = createKeydownEvent({ key, code: `Key${key.toUpperCase()}`, shiftKey: false });

    handleCanvasKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).not.toHaveBeenCalled();
    expect(context.fitGraphOverviewInViewport).not.toHaveBeenCalled();
    expect(context.graphInteraction.setSelectedNodeIds).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each(["a", "f"])("ignores Mod+%s aimed outside the Studio view", (key) => {
    const context = createContext({ ownsKeyboardTarget: jest.fn(() => false) });
    const event = createKeydownEvent({ key, code: `Key${key.toUpperCase()}`, shiftKey: false });

    handleCanvasKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).not.toHaveBeenCalled();
    expect(context.fitGraphOverviewInViewport).not.toHaveBeenCalled();
    expect(context.graphInteraction.setSelectedNodeIds).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("handles Mod+Shift+1 even when focus is inside an editable studio target", () => {
    const context = createContext({
      isEditableKeyboardTarget: jest.fn(() => true),
    });
    const event = createKeydownEvent();

    handleCanvasKeyDown.call(context, event);

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

    handleCanvasKeyDown.call(context, event);

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

    handleCanvasKeyDown.call(context, event);

    expect(context.clipboardAndDropController.copySelectedGraphNodes).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("does not consume Mod+1 without Shift", () => {
    const context = createContext();
    const event = createKeydownEvent({
      shiftKey: false,
    });

    handleCanvasKeyDown.call(context, event);

    expect(context.fitSelectedGraphNodesInViewport).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
