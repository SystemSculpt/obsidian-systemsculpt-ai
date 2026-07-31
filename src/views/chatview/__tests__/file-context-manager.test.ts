import { App, TFile } from "obsidian";
import { FileContextManager } from "../FileContextManager";

const createManager = () => {
  const app = new App();
  const onContextChange = jest.fn(async () => {});
  const manager = new FileContextManager({
    app,
    plugin: {} as any,
    onContextChange,
  });
  return { app, onContextChange, manager };
};

describe("FileContextManager", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes and deduplicates pinned files", () => {
    const { app, manager } = createManager();
    const trigger = jest.spyOn(app.workspace, "trigger");
    expect(manager.pinFile("Note.md")).toBe(true);
    expect(Array.from(manager.getPinnedFiles())).toEqual(["[[Note.md]]"]);
    expect(manager.hasPinnedFile("Note.md")).toBe(true);
    expect(manager.pinFile("[[Note.md]]")).toBe(false);
    expect(trigger).toHaveBeenCalledWith(
      "systemsculpt:file-context-state-changed",
      expect.objectContaining({ manager, kind: "context" }),
    );
  });

  it("unpins files and persists the metadata change", async () => {
    const { manager, onContextChange } = createManager();
    manager.pinFile("Note.md");
    expect(await manager.unpinFile("Note.md")).toBe(true);
    expect(manager.getPinnedFiles().size).toBe(0);
    expect(onContextChange).toHaveBeenCalledTimes(1);
  });

  it("keeps only existing files when restoring the pinned set", async () => {
    const { app, manager } = createManager();
    const noteFile = new TFile({ path: "Note.md" });
    app.metadataCache.getFirstLinkpathDest = jest.fn((link) => (link === "Note" ? noteFile : null));
    app.vault.getAbstractFileByPath = jest.fn((path) => (path === "Note.md" ? noteFile : null));

    await manager.setPinnedFiles(["Note", "[[Note]]", "Missing"]);
    expect(Array.from(manager.getPinnedFiles())).toEqual(["[[Note]]"]);
  });

});
