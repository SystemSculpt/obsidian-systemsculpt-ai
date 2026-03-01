/**
 * @jest-environment jsdom
 */
import {
  appendStudioPathBrowseButtonIcon,
  resolveStudioNotePathState,
} from "../StudioPathFieldUi";

describe("StudioPathFieldUi", () => {
  it("resolves note-path state for missing, invalid, and ready values", () => {
    expect(resolveStudioNotePathState("")).toEqual({
      tone: "missing",
      message: "Select a markdown file to continue.",
    });
    expect(resolveStudioNotePathState("Notes/file.txt")).toEqual({
      tone: "invalid",
      message: "Use a .md file path.",
    });
    expect(resolveStudioNotePathState("Notes/file.md")).toEqual({
      tone: "ready",
      message: "",
    });
  });

  it("appends a browse icon svg to a button element", () => {
    const button = document.createElement("button");
    appendStudioPathBrowseButtonIcon(button, "test-icon");

    const iconEl = button.querySelector(".test-icon");
    const svgEl = iconEl?.querySelector("svg");

    expect(iconEl).toBeDefined();
    expect(iconEl?.getAttribute("aria-hidden")).toBe("true");
    expect(svgEl).toBeDefined();
    expect(svgEl?.getAttribute("viewBox")).toBe("0 0 16 16");
  });
});
