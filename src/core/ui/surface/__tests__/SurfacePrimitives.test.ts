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
      label: "Search vault notes",
      placeholder: "Search notes",
      value: "inbox",
      onQuery,
    });

    expect(search.input.value).toBe("inbox");
    expect(search.input.placeholder).toBe("Search notes");
    expect(search.input.getAttribute("aria-label")).toBe("Search vault notes");
    search.setValue("daily");
    expect(onQuery).toHaveBeenLastCalledWith("daily");
    const nativeContainer = search.root.querySelector(":scope > .search-input-container");
    expect(nativeContainer).not.toBeNull();
    expect(search.input.closest(".search-input-container")).toBe(nativeContainer);
    expect(nativeContainer?.parentElement).toBe(search.root);
    expect(search.root.querySelector(".search-input-clear-button")).not.toBeNull();
    expect(search.root.querySelector(".ss-search-field__icon")).toBeNull();

    search.setValue("", { notify: false });
    expect(onQuery).toHaveBeenLastCalledWith("daily");

    const focus = jest.spyOn(search.input, "focus");
    search.clear();
    expect(onQuery).toHaveBeenLastCalledWith("");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("stops delivering native search callbacks after cleanup", () => {
    const parent = document.createElement("div");
    const onQuery = jest.fn();
    const search = createUiSearch(parent, {
      label: "Search notes",
      placeholder: "Search notes",
      onQuery,
    });

    search.input.value = "before cleanup";
    search.input.dispatchEvent(new Event("input", { bubbles: true }));
    const focus = jest.spyOn(search.input, "focus");
    search.destroy();
    search.clear();
    search.setValue("ignored");
    search.input.value = "after cleanup";
    search.input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenLastCalledWith("before cleanup");
    expect(focus).not.toHaveBeenCalled();
    expect(search.root.isConnected).toBe(false);
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
