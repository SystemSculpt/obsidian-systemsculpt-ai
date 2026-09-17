/** @jest-environment jsdom */

import { InlineMessageEditor } from "../InlineMessageEditor";

const edit = {
  messageId: "message-to-edit",
  text: "Original request",
  laterMessageCount: 0,
  hasAttachments: false,
  unavailableAttachmentCount: 0,
  requiresReplayConfirmation: false,
};

describe("inline editor keyboard lifecycle", () => {
  afterEach(() => {
    document.body.empty();
    jest.useRealTimers();
  });

  it("contains the saving keyup after the editor row has been replaced", () => {
    const root = document.body.createDiv();
    const onResubmitMessage = jest.fn(() => true);
    const editor = new InlineMessageEditor(root, { onResubmitMessage });
    editor.render(root, edit);
    root.querySelector('[data-testid="chat.editor.input"]')!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", metaKey: true, bubbles: true, cancelable: true,
    }));
    expect(onResubmitMessage).toHaveBeenCalledWith(edit.messageId, edit.text);
    root.empty();
    editor.deactivate();
    const keyup = new KeyboardEvent("keyup", {
      key: "Enter", bubbles: true, cancelable: true,
    });
    root.dispatchEvent(keyup);
    expect(keyup.defaultPrevented).toBe(true);
    editor.dispose();
  });

  it("releases window shortcuts and cancels deferred Escape on disposal", () => {
    jest.useFakeTimers();
    const root = document.body.createDiv();
    const onCancelMessageEdit = jest.fn();
    const editor = new InlineMessageEditor(root, { onCancelMessageEdit });
    editor.render(root, edit);
    root.querySelector('[data-testid="chat.editor.input"]')!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    }));
    editor.dispose();
    jest.advanceTimersByTime(500);
    expect(onCancelMessageEdit).not.toHaveBeenCalled();
    const keyup = new KeyboardEvent("keyup", {
      key: "Escape", bubbles: true, cancelable: true,
    });
    root.dispatchEvent(keyup);
    expect(keyup.defaultPrevented).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
