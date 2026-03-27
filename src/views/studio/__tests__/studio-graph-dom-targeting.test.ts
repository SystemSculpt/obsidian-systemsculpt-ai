/** @jest-environment jsdom */
import { isStudioGraphEditableTarget } from "../StudioGraphDomTargeting";

describe("isStudioGraphEditableTarget", () => {
  it("treats form controls as editable targets", () => {
    const root = document.createElement("div");
    const textarea = document.createElement("textarea");
    root.appendChild(textarea);
    document.body.appendChild(root);

    expect(isStudioGraphEditableTarget(textarea)).toBe(true);

    root.remove();
  });

  it("treats Studio menus as editable targets", () => {
    const root = document.createElement("div");
    const menu = document.createElement("div");
    menu.className = "ss-studio-node-context-menu";
    const menuButton = document.createElement("button");
    menu.appendChild(menuButton);
    root.appendChild(menu);
    document.body.appendChild(root);

    expect(isStudioGraphEditableTarget(menuButton)).toBe(true);

    root.remove();
  });

  it("returns false for non-editable node surfaces", () => {
    const surface = document.createElement("div");
    surface.className = "ss-studio-node-card";
    document.body.appendChild(surface);

    expect(isStudioGraphEditableTarget(surface)).toBe(false);

    surface.remove();
  });
});
