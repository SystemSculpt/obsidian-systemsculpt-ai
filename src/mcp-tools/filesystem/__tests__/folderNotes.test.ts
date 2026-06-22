/**
 * @jest-environment jsdom
 */
import { App, TFile, TFolder } from "obsidian";
import { resolveFolderNotePath, resolveExistingVaultFile } from "../folderNotes";

describe("folderNotes (#154)", () => {
  let app: App;

  // Wire getAbstractFileByPath to a fixed Folder Notes vault layout:
  //   Projects/        (folder)
  //   Projects/Projects.md   (the folder note)
  //   loose.md         (an ordinary note)
  const folder = new TFolder();
  (folder as any).path = "Projects";
  const folderNote = new TFile({ path: "Projects/Projects.md" });
  const looseNote = new TFile({ path: "loose.md" });

  beforeEach(() => {
    jest.clearAllMocks();
    app = new App();
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((p: string) => {
      if (p === "Projects") return folder;
      if (p === "Projects/Projects.md") return folderNote;
      if (p === "loose.md") return looseNote;
      return null;
    });
  });

  describe("resolveFolderNotePath", () => {
    it("resolves a folder-style path to the folder note (X.md -> X/X.md)", () => {
      expect(resolveFolderNotePath(app, "Projects.md")).toBe("Projects/Projects.md");
    });

    it("returns null for non-markdown paths", () => {
      expect(resolveFolderNotePath(app, "Projects")).toBeNull();
      expect(resolveFolderNotePath(app, "image.png")).toBeNull();
    });

    it("returns null when the sibling folder does not exist", () => {
      expect(resolveFolderNotePath(app, "Ghost.md")).toBeNull();
    });

    it("returns null when the candidate folder note does not exist", () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((p: string) =>
        p === "Empty" ? folder : null
      );
      expect(resolveFolderNotePath(app, "Empty.md")).toBeNull();
    });

    it("does not resolve an ordinary note that has no matching folder", () => {
      expect(resolveFolderNotePath(app, "loose.md")).toBeNull();
    });
  });

  describe("resolveExistingVaultFile", () => {
    it("returns the file directly when it exists at the requested path", () => {
      expect(resolveExistingVaultFile(app, "loose.md")).toBe(looseNote);
    });

    it("falls back to the folder note when the direct path is not a file", () => {
      expect(resolveExistingVaultFile(app, "Projects.md")).toBe(folderNote);
    });

    it("returns null when neither the direct path nor a folder note exists", () => {
      expect(resolveExistingVaultFile(app, "Ghost.md")).toBeNull();
    });
  });
});
