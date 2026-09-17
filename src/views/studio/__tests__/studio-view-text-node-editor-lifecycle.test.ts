/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { StudioTextEditSessions } from "../StudioTextEditSessions";

const viewPrototype = (SystemSculptStudioView as any).prototype;
const snapshot = { selection: { anchor: 4, head: 9 }, scrollTop: 33, focused: true };

function createHarness(editingNodeIds: string[] = ["text_1"]): any {
  const textEdits = new StudioTextEditSessions();
  for (const id of editingNodeIds) textEdits.begin(id);
  return {
    textEdits,
    nodeTeardowns: new Map(),
    shapeController: { clearSelection: jest.fn() },
    render: jest.fn(),
    requestTextNodeEdit: viewPrototype.requestTextNodeEdit,
    clearProjectEditorState: viewPrototype.clearProjectEditorState,
    disposeTextNodeEditors: viewPrototype.disposeTextNodeEditors,
  };
}

describe("SystemSculptStudioView text editor lifecycle", () => {
  it("carries native selection, scroll and focus through a whole-graph re-render exactly once", () => {
    const harness = createHarness();
    const teardown = jest.fn(() => snapshot);
    harness.textEdits.registerEditor("text_1", teardown);
    harness.disposeTextNodeEditors();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(harness.textEdits.takeMountState("text_1")).toMatchObject({ isEditing: true, initialEditorSnapshot: snapshot });
    expect(harness.textEdits.takeMountState("text_1").initialEditorSnapshot).toBeUndefined();
  });

  it.each(["end", "project reset"])("destroys the native editor after %s without resurrecting its focus or dirty transaction", action => {
    const harness = createHarness();
    const teardown = jest.fn(() => snapshot);
    harness.requestTextNodeEdit("text_1", { autoFocus: true, focusAt: { x: 24, y: 48, sourceOffset: 7 } });
    harness.textEdits.markDirty("text_1");
    harness.textEdits.registerEditor("text_1", teardown);
    if (action === "end") harness.textEdits.end("text_1");
    else harness.clearProjectEditorState();
    harness.disposeTextNodeEditors();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(harness.textEdits.takeMountState("text_1")).toEqual({
      isEditing: false, shouldAutoFocus: false, initialFocusPoint: undefined, initialEditorSnapshot: undefined,
    });
    expect(harness.textEdits.end("text_1")).toBeNull();
    harness.requestTextNodeEdit("text_1");
    expect(harness.textEdits.end("text_1")).toEqual({ dirty: false });
  });

  it("keeps only the latest autofocus request and consumes mount state atomically", () => {
    const harness = createHarness([]);
    const focusAt = { x: 24, y: 48, sourceOffset: 7 };
    harness.requestTextNodeEdit("text_1", { autoFocus: true, focusAt });
    harness.requestTextNodeEdit("text_2", { autoFocus: true, focusAt });
    expect(harness.textEdits.takeMountState("text_1").shouldAutoFocus).toBe(false);
    expect(harness.textEdits.takeMountState("text_2")).toMatchObject({ isEditing: true, shouldAutoFocus: true, initialFocusPoint: focusAt });
    expect(harness.textEdits.takeMountState("text_2")).toMatchObject({ shouldAutoFocus: false, initialFocusPoint: undefined });
    harness.requestTextNodeEdit("text_2");
    expect(harness.render).toHaveBeenCalledTimes(2);
  });

  it("registers the replacement editor when the previous teardown throws", () => {
    const harness = createHarness();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedTeardown = jest.fn(() => { throw new Error("commit failed"); });
    const replacementTeardown = jest.fn(() => snapshot);
    harness.textEdits.registerEditor("text_1", failedTeardown);
    expect(() => harness.textEdits.registerEditor("text_1", replacementTeardown)).not.toThrow();
    expect(failedTeardown).toHaveBeenCalledTimes(1);
    harness.disposeTextNodeEditors();
    expect(replacementTeardown).toHaveBeenCalledTimes(1);
    expect(harness.textEdits.takeMountState("text_1").initialEditorSnapshot).toEqual(snapshot);
    expect(warn).toHaveBeenCalledWith("[SystemSculpt Studio] Failed to replace a text-node editor", expect.objectContaining({ error: "commit failed" }));
  });

  it("retains a replacement handle when destroying the old editor synchronously ends the edit", () => {
    const harness = createHarness();
    const old = jest.fn(() => { harness.textEdits.end("text_1"); return snapshot; });
    const replacement = jest.fn(() => snapshot);
    harness.textEdits.registerEditor("text_1", old);
    harness.textEdits.registerEditor("text_1", replacement);
    harness.disposeTextNodeEditors();
    expect(old).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(harness.textEdits.takeMountState("text_1").isEditing).toBe(false);
  });

  it("disposes the remaining editors even when a native commit throws", () => {
    const harness = createHarness(["text_1", "text_2"]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedTeardown = jest.fn(() => { throw new Error("snapshot failed"); });
    const successfulTeardown = jest.fn(() => snapshot);
    harness.textEdits.registerEditor("text_1", failedTeardown);
    harness.textEdits.registerEditor("text_2", successfulTeardown);
    expect(() => harness.disposeTextNodeEditors()).not.toThrow();
    harness.disposeTextNodeEditors();
    expect(failedTeardown).toHaveBeenCalledTimes(1);
    expect(successfulTeardown).toHaveBeenCalledTimes(1);
    expect(harness.textEdits.takeMountState("text_1").initialEditorSnapshot).toBeUndefined();
    expect(harness.textEdits.takeMountState("text_2").initialEditorSnapshot).toEqual(snapshot);
    expect(warn).toHaveBeenCalledWith("[SystemSculpt Studio] Failed to dispose a text-node editor", expect.objectContaining({ nodeId: "text_1", error: "snapshot failed" }));
  });
});
