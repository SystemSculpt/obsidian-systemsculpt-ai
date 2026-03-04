/** @jest-environment jsdom */
import { isStudioGraphEditableTarget } from "../StudioGraphDomTargeting";

describe("isStudioGraphEditableTarget", () => {
  it("treats terminal surfaces as editable targets", () => {
    const root = document.createElement("div");
    const terminalSurface = document.createElement("div");
    terminalSurface.className = "ss-studio-terminal-surface";
    const terminalCanvas = document.createElement("canvas");
    terminalSurface.appendChild(terminalCanvas);
    root.appendChild(terminalSurface);
    document.body.appendChild(root);

    expect(isStudioGraphEditableTarget(terminalSurface)).toBe(true);
    expect(isStudioGraphEditableTarget(terminalCanvas)).toBe(true);

    root.remove();
  });

  it("treats terminal helper textarea as editable", () => {
    const root = document.createElement("div");
    const helperTextarea = document.createElement("textarea");
    helperTextarea.className = "xterm-helper-textarea";
    root.appendChild(helperTextarea);
    document.body.appendChild(root);

    expect(isStudioGraphEditableTarget(helperTextarea)).toBe(true);

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
