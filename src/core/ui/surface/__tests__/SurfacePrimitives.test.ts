/** @jest-environment jsdom */

import {
  createUiAction,
  createUiSearch,
  createUiState,
  updateUiAction,
} from "../SurfacePrimitives";

describe("SurfacePrimitives", () => {
  it("creates an icon action with accessible text and canonical state", () => {
    const parent = document.createElement("div");
    const onSelect = jest.fn();
    const button = createUiAction(parent, {
      label: "Delete note",
      icon: "trash",
      size: "icon",
      tone: "danger",
      selected: true,
      onSelect,
    });

    button.click();
    expect(button.getAttribute("aria-label")).toBe("Delete note");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("ss-button--danger")).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("updates mutable action state without exposing class or ARIA grammar", () => {
    const parent = document.createElement("div");
    const button = createUiAction(parent, {
      label: "Send message",
      icon: "arrow-up",
      size: "icon",
    });

    updateUiAction(button, {
      label: "Queue follow-up",
      icon: "list-plus",
      selected: true,
      busy: true,
      disabled: true,
    });

    expect(button.getAttribute("aria-label")).toBe("Queue follow-up");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.classList.contains("is-selected")).toBe(true);
    expect(button.classList.contains("is-busy")).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it("keeps search clear state and query callbacks synchronized", () => {
    const parent = document.createElement("div");
    const onQuery = jest.fn();
    const search = createUiSearch(parent, {
      placeholder: "Search notes",
      onQuery,
    });

    search.setValue("daily");
    expect(onQuery).toHaveBeenLastCalledWith("daily");
    expect(search.root.querySelector("button")?.hidden).toBe(false);

    search.clear();
    expect(onQuery).toHaveBeenLastCalledWith("");
    expect(search.root.querySelector("button")?.hidden).toBe(true);
  });

  it.each(["empty", "loading", "error", "success", "info"] as const)(
    "renders the %s state with live-region semantics",
    (kind) => {
      const parent = document.createElement("div");
      const state = createUiState(parent, { kind, title: "State title" });
      expect(state.classList.contains(`is-${kind}`)).toBe(true);
      expect(state.getAttribute("role")).toBe(kind === "error" ? "alert" : "status");
      expect(state.textContent).toContain("State title");
    },
  );
});
