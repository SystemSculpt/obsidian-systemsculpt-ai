/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";

const viewPrototype = (SystemSculptStudioView as any).prototype;

function createHarness(editingNodeIds: string[] = ["text_1"]): any {
  return {
    editingTextNodeIds: new Set(editingNodeIds),
    textNodeEditorTeardowns: new Map(),
    textNodeEditorSnapshots: new Map(),
    registerTextNodeEditorTeardown: viewPrototype.registerTextNodeEditorTeardown,
    disposeTextNodeEditors: viewPrototype.disposeTextNodeEditors,
    consumeTextNodeEditorSnapshot: viewPrototype.consumeTextNodeEditorSnapshot,
  };
}

describe("SystemSculptStudioView text editor lifecycle", () => {
  it("carries the native editor snapshot through a whole-graph re-render", () => {
    const harness = createHarness();
    const snapshot = {
      selection: { anchor: 4, head: 9 },
      scrollTop: 33,
      focused: true,
    };
    const teardown = jest.fn(() => snapshot);

    harness.registerTextNodeEditorTeardown("text_1", teardown);
    harness.disposeTextNodeEditors();

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(harness.consumeTextNodeEditorSnapshot("text_1")).toEqual(snapshot);
    expect(harness.consumeTextNodeEditorSnapshot("text_1")).toBeUndefined();
  });

  it("drops the snapshot when the edit session ended before teardown", () => {
    const harness = createHarness([]);
    const teardown = jest.fn(() => ({
      selection: { anchor: 2, head: 2 },
      scrollTop: 0,
      focused: false,
    }));

    harness.registerTextNodeEditorTeardown("text_1", teardown);
    harness.disposeTextNodeEditors();

    expect(harness.consumeTextNodeEditorSnapshot("text_1")).toBeUndefined();
  });

  it("registers the replacement editor when the previous teardown throws", () => {
    const harness = createHarness();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedTeardown = jest.fn(() => {
      throw new Error("commit failed");
    });
    const replacementTeardown = jest.fn();

    harness.registerTextNodeEditorTeardown("text_1", failedTeardown);
    expect(() =>
      harness.registerTextNodeEditorTeardown("text_1", replacementTeardown)
    ).not.toThrow();

    expect(failedTeardown).toHaveBeenCalledTimes(1);
    expect(harness.textNodeEditorTeardowns.get("text_1")).toBe(replacementTeardown);
    expect(warn).toHaveBeenCalledWith(
      "[SystemSculpt Studio] Failed to replace a text-node editor",
      expect.objectContaining({ error: "commit failed" })
    );
  });
});
