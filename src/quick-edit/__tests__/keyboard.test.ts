/** @jest-environment jsdom */
import { describe, expect, it } from "@jest/globals";
import { getQuickEditKeyAction } from "../keyboard";
import type { QuickEditState } from "../controller";

const makeEvent = (init: Partial<KeyboardEventInit> & { key?: string; code?: string } = {}) => {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    ...init,
  });
};

describe("getQuickEditKeyAction", () => {
  it("submits on Enter (idle)", () => {
    const state: QuickEditState = "idle";
    expect(getQuickEditKeyAction(makeEvent({ key: "Enter" }), state)).toBe("submit");
  });

  it("does not submit on Shift+Enter (idle)", () => {
    const state: QuickEditState = "idle";
    expect(getQuickEditKeyAction(makeEvent({ key: "Enter", shiftKey: true }), state)).toBe("none");
  });

  it("confirms on Cmd/Ctrl+Enter (awaiting-confirmation)", () => {
    const state: QuickEditState = "awaiting-confirmation";
    expect(getQuickEditKeyAction(makeEvent({ key: "Enter", metaKey: true }), state)).toBe("confirm");
    expect(getQuickEditKeyAction(makeEvent({ key: "Enter", ctrlKey: true }), state)).toBe("confirm");
  });

  it("ignores plain Enter while awaiting confirmation", () => {
    const state: QuickEditState = "awaiting-confirmation";
    expect(getQuickEditKeyAction(makeEvent({ key: "Enter" }), state)).toBe("none");
  });

  it("ignores composing Enter", () => {
    const state: QuickEditState = "idle";
    expect(getQuickEditKeyAction(makeEvent({ key: "Enter", isComposing: true }), state)).toBe("none");
  });
});

