/** @jest-environment jsdom */

import { createUiAction } from "../SurfacePrimitives";
import { createUiTabs } from "../SurfaceTabs";

describe("SurfaceTabs", () => {
  it("owns ARIA, selected state, panels, and arrow-key focus", () => {
    const root = document.body.createDiv();
    const tablist = root.createDiv();
    const panels = root.createDiv();
    const first = createUiAction(tablist, { label: "First", size: "small" });
    const second = createUiAction(tablist, { label: "Second", size: "small" });
    const firstPanel = panels.createDiv();
    const secondPanel = panels.createDiv();
    const onChange = jest.fn();
    const tabs = createUiTabs(tablist, [
      { id: "first", button: first, panel: firstPanel },
      { id: "second", button: second, panel: secondPanel },
    ], { activeId: "first", onChange });

    expect(tablist.getAttribute("role")).toBe("tablist");
    expect(first.getAttribute("role")).toBe("tab");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(first.hasAttribute("aria-pressed")).toBe(false);
    expect(secondPanel.hidden).toBe(true);

    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs.activeId).toBe("second");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(secondPanel.hidden).toBe(false);
    expect(document.activeElement).toBe(second);
    expect(onChange).toHaveBeenCalledWith("second", "first");

    tabs.destroy();
  });
});
