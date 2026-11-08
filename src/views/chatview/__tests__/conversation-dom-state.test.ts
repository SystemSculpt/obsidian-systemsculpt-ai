/**
 * @jest-environment jsdom
 */

import {
  captureDetailsState,
  captureDomSelection,
  findFocusKey,
  focusedElementWithin,
  restoreDetailsState,
  restoreDomSelection,
} from "../ConversationDomState";

describe("conversation DOM state", () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.body.empty();
  });

  it("captures only owned focus and matches literal focus keys", () => {
    const root = document.body.createDiv();
    const button = root.createEl("button");
    button.dataset.focusKey = 'tool:"quoted"\\summary';
    button.focus();
    expect(focusedElementWithin(root)).toBe(button);
    expect(focusedElementWithin(document.body.createDiv())).toBeNull();
    expect(findFocusKey(root, button.dataset.focusKey)).toBe(button);
    expect(findFocusKey(root, "missing")).toBeNull();
  });

  it("preserves backward selection across ownership transfer and clamps changed text", () => {
    const active = document.body.createDiv();
    const history = document.body.createDiv();
    const text = active.createEl("p", { text: "Selected history" }).firstChild!;
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(text, 8, text, 0);
    const preserved = captureDomSelection(active);
    expect(captureDomSelection(history)).toBeNull();
    history.appendChild(active.firstChild!);
    text.nodeValue = "Select";
    restoreDomSelection(preserved);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(6);
    expect(selection.focusNode).toBe(text);
    expect(selection.focusOffset).toBe(0);
    expect(selection.toString()).toBe("Select");
  });

  it("does not move a reader's selection when captured nodes were removed", () => {
    const root = document.body.createDiv();
    const oldText = root.createEl("p", { text: "Old" }).firstChild!;
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(oldText, 0, oldText, 3);
    const preserved = captureDomSelection(root);
    root.empty();
    const current = root.createEl("p", { text: "Current" }).firstChild!;
    selection.setBaseAndExtent(current, 0, current, 7);
    restoreDomSelection(preserved);
    expect(selection.toString()).toBe("Current");
  });

  it("keeps exact disclosures or transfers their state to authoritative replacements", () => {
    const active = document.body.createDiv();
    const first = active.createEl("details");
    const second = active.createEl("details");
    first.open = true;
    const state = captureDetailsState(active.querySelectorAll("details"));
    const history = document.body.createDiv();
    const replacement = history.createEl("details");
    history.appendChild(second);
    second.open = true;
    const restored = jest.fn();
    restoreDetailsState(history, state, [replacement, second], restored);
    expect(replacement.open).toBe(true);
    expect(second.open).toBe(false);
    expect(restored.mock.calls).toEqual([[replacement, true], [second, false]]);
  });
});
