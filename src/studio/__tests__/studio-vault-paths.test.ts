import { deriveStudioAssetsDir, deriveStudioPolicyPath, normalizeStudioProjectPath } from "../paths";
import { isStudioOwnedPersistencePath, isStudioProjectDocumentPath } from "../StudioProjectAgentFileGuard";

describe("Studio vault paths", () => {
  it.each([
    [" /Studio\\nested//Example/ ", "Studio/nested/Example.systemsculpt"],
    ["Studio/Example.SYSTEMSCULPT/", "Studio/Example.SYSTEMSCULPT"],
    ["Studio/Literal%20name", "Studio/Literal%20name.systemsculpt"],
  ])("normalizes project %j before enforcing its extension", (input, expected) => {
    expect(normalizeStudioProjectPath(input)).toBe(expected);
    const base = expected.slice(0, -".systemsculpt".length);
    expect(deriveStudioAssetsDir(input)).toBe(`${base}.systemsculpt-assets`);
    expect(deriveStudioPolicyPath(input)).toBe(`${base}.systemsculpt-assets/policy/grants.json`);
  });

  it.each(["", " / ", "\\\\", "///"])("rejects empty project path %j", (input) => {
    expect(() => normalizeStudioProjectPath(input)).toThrow("Studio project path cannot be empty.");
  });

  it.each([
    ".systemsculpt/studio/", ".systemsculpt/studio", "\\.systemsculpt\\studio\\runs\\a.json",
    "Studio/Example.systemsculpt-assets/", "Studio/Example.systemsculpt-assets//policy/grants.json",
    "Studio/Example.SYSTEMSCULPT.identity.json/",
  ])("keeps private persistence protected after normalizing %j", (path) => {
    expect(isStudioOwnedPersistencePath(path)).toBe(true);
  });

  it("matches whole protected path segments and recognizes project paths with wrappers", () => {
    expect(isStudioOwnedPersistencePath(".systemsculpt/studio-other/a.json")).toBe(false);
    expect(isStudioOwnedPersistencePath("Studio/Example.systemsculpt-assets-other/a.json")).toBe(false);
    expect(isStudioProjectDocumentPath(" /Studio\\Example.SYSTEMSCULPT/ ")).toBe(true);
    expect(isStudioProjectDocumentPath("Studio/Example.systemsculpt.md")).toBe(false);
  });
});
