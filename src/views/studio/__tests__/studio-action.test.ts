/** @jest-environment jsdom */

import { createStudioAction } from "../StudioAction";

describe("createStudioAction", () => {
  it("keeps Studio actions on the canonical action grammar and contains graph clicks", () => {
    const parent = document.createElement("div");
    const parentClick = jest.fn();
    const onSelect = jest.fn();
    parent.addEventListener("click", parentClick);

    const button = createStudioAction(parent, {
      className: "ss-studio-test-action",
      label: "Inspect",
      ariaLabel: "Inspect node",
      size: "small",
      selected: true,
      onSelect,
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(click);

    expect(button.classList.contains("ss-button")).toBe(true);
    expect(button.classList.contains("ss-button--small")).toBe(true);
    expect(button.classList.contains("ss-studio-test-action")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Inspect node");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(click.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("optionally contains pointerdown on draggable graph surfaces", () => {
    const parent = document.createElement("div");
    const parentPointerDown = jest.fn();
    parent.addEventListener("pointerdown", parentPointerDown);
    const button = createStudioAction(parent, {
      label: "Rename",
      stopPointerDown: true,
    });

    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(parentPointerDown).not.toHaveBeenCalled();
  });
});
