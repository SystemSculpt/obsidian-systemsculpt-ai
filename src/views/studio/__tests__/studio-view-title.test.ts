import { DEFAULT_STUDIO_VIEW_TITLE, resolveStudioViewTitle } from "../studio-view-title";

describe("resolveStudioViewTitle", () => {
  it("returns default title when project path is missing", () => {
    expect(resolveStudioViewTitle(null)).toBe(DEFAULT_STUDIO_VIEW_TITLE);
    expect(resolveStudioViewTitle(undefined)).toBe(DEFAULT_STUDIO_VIEW_TITLE);
    expect(resolveStudioViewTitle("  ")).toBe(DEFAULT_STUDIO_VIEW_TITLE);
  });

  it("returns the filename from a vault-style project path", () => {
    expect(resolveStudioViewTitle("SystemSculpt/Studio/Automation Graph.systemsculpt")).toBe(
      "Automation Graph.systemsculpt"
    );
  });

  it("returns the filename from a Windows-style project path", () => {
    expect(resolveStudioViewTitle("SystemSculpt\\Studio\\Windows Flow.systemsculpt")).toBe(
      "Windows Flow.systemsculpt"
    );
  });
});
