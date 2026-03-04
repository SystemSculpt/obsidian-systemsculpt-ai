import {
  isStudioProjectPath,
  remapPathScopedRecord,
  resolveProjectPathAfterFolderRename,
} from "../systemsculpt-studio-view/StudioProjectPathState";

describe("StudioProjectPathState", () => {
  it("detects studio project paths", () => {
    expect(isStudioProjectPath("flows/demo.systemsculpt")).toBe(true);
    expect(isStudioProjectPath("flows/DEMO.SYSTEMSCULPT")).toBe(true);
    expect(isStudioProjectPath("flows/demo.md")).toBe(false);
  });

  it("resolves remapped project path when parent folder is renamed", () => {
    expect(
      resolveProjectPathAfterFolderRename({
        currentProjectPath: "workspace/flows/demo.systemsculpt",
        previousFolderPath: "workspace/flows",
        nextFolderPath: "workspace/flows-archived",
      })
    ).toBe("workspace/flows-archived/demo.systemsculpt");
    expect(
      resolveProjectPathAfterFolderRename({
        currentProjectPath: "workspace/other/demo.systemsculpt",
        previousFolderPath: "workspace/flows",
        nextFolderPath: "workspace/flows-archived",
      })
    ).toBeNull();
  });

  it("remaps path-scoped record keys without mutating input", () => {
    const original = {
      "workspace/flows/demo.systemsculpt": { zoom: 1.2 },
      "workspace/flows/other.systemsculpt": { zoom: 1.1 },
    };
    const remapped = remapPathScopedRecord(
      original,
      "workspace/flows/demo.systemsculpt",
      "workspace/flows-archived/demo.systemsculpt"
    );

    expect(remapped).toEqual({
      "workspace/flows-archived/demo.systemsculpt": { zoom: 1.2 },
      "workspace/flows/other.systemsculpt": { zoom: 1.1 },
    });
    expect(original).toEqual({
      "workspace/flows/demo.systemsculpt": { zoom: 1.2 },
      "workspace/flows/other.systemsculpt": { zoom: 1.1 },
    });
  });

  it("returns original record when remap source is missing", () => {
    const original = { "workspace/flows/other.systemsculpt": { zoom: 1.1 } };
    expect(
      remapPathScopedRecord(
        original,
        "workspace/flows/demo.systemsculpt",
        "workspace/flows-archived/demo.systemsculpt"
      )
    ).toBe(original);
  });
});
