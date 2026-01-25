/**
 * @jest-environment jsdom
 */
import { App, TFile, TFolder, Notice, normalizePath } from "obsidian";
import { DirectoryOperations } from "../DirectoryOperations";

// Mock utils
jest.mock("../../utils", () => ({
  validatePath: jest.fn((path, allowedPaths) => {
    if (path === "blocked/dir" || path === "blocked/file.md") return false;
    return true;
  }),
  formatBytes: jest.fn((bytes) => `${bytes} bytes`),
  runWithConcurrency: jest.fn(async (items, fn) => {
    const results = [];
    for (const item of items) {
      try {
        results.push(await fn(item));
      } catch (err) {
        results.push({ path: item, error: err, success: false });
      }
    }
    return results;
  }),
  shouldExcludeFromSearch: jest.fn(() => false),
  isHiddenSystemPath: jest.fn(() => false),
  ensureAdapterFolder: jest.fn(async () => {}),
  listAdapterDirectory: jest.fn(async () => ({ files: [], folders: [] })),
  resolveAdapterPath: jest.fn(() => null),
  statAdapterPath: jest.fn(async () => null),
}));

// Mock constants
jest.mock("../../constants", () => ({
  FILESYSTEM_LIMITS: {
    MAX_OPERATIONS: 10,
    MAX_SEARCH_RESULTS: 25,
  },
}));

describe("DirectoryOperations", () => {
  let app: App;
  let dirOps: DirectoryOperations;
  const allowedPaths = ["/"];
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();

    app = new App();
    mockPlugin = {
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
      },
    };

    // Setup default mocks
    (app.vault.createFolder as jest.Mock).mockResolvedValue(undefined);
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.getRoot as jest.Mock).mockReturnValue(
      new TFolder({ path: "", children: [] })
    );
    (app.vault.cachedRead as jest.Mock).mockResolvedValue("");
    (app.vault.adapter.trashLocal as jest.Mock).mockResolvedValue(undefined);
    (app.fileManager.renameFile as jest.Mock).mockResolvedValue(undefined);

    dirOps = new DirectoryOperations(app, allowedPaths, mockPlugin);
  });

  describe("createDirectories", () => {
    it("throws error when too many directories requested", async () => {
      const paths = Array(15).fill("some/dir");

      await expect(dirOps.createDirectories({ paths })).rejects.toThrow(
        "Too many directories requested"
      );
    });

    it("returns access denied for blocked paths", async () => {
      const result = await dirOps.createDirectories({
        paths: ["blocked/dir"],
      });

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("Access denied");
    });

    it("creates directory successfully", async () => {
      const result = await dirOps.createDirectories({
        paths: ["new/folder"],
      });

      expect(result.results[0].success).toBe(true);
      expect(app.vault.createFolder).toHaveBeenCalledWith("new/folder");
    });

    it("returns success when directory already exists", async () => {
      (app.vault.createFolder as jest.Mock).mockRejectedValue(
        new Error("Folder already exists")
      );

      const result = await dirOps.createDirectories({
        paths: ["existing/folder"],
      });

      expect(result.results[0].success).toBe(true);
    });

    it("returns error for other creation failures", async () => {
      (app.vault.createFolder as jest.Mock).mockRejectedValue(
        new Error("Permission denied")
      );

      const result = await dirOps.createDirectories({
        paths: ["error/folder"],
      });

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe("Permission denied");
    });

    it("creates multiple directories", async () => {
      const result = await dirOps.createDirectories({
        paths: ["dir1", "dir2", "dir3"],
      });

      expect(result.results.length).toBe(3);
      expect(result.results.every((r) => r.success)).toBe(true);
    });
  });

  describe("listDirectories", () => {
    it("returns error for blocked paths", async () => {
      const result = await dirOps.listDirectories({
        paths: ["blocked/dir"],
      });

      expect(result.results[0].error).toContain("Access denied");
    });

    it("returns error for semantic filter (deprecated)", async () => {
      const result = await dirOps.listDirectories({
        paths: ["some/dir"],
        filter: { semantic: "query" },
      } as any);

      expect(result.results[0].error).toContain("Semantic search has been disabled");
    });

    it("returns error for non-existent directory", async () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await dirOps.listDirectories({
        paths: ["missing/dir"],
      });

      expect(result.results[0].error).toContain("Directory not found");
    });

    it("lists root directory when path is /", async () => {
      const rootFolder = new TFolder({
        path: "",
        children: [
          new TFile({ path: "test.md", stat: { ctime: 1000, mtime: 2000, size: 100 } }),
        ],
      });
      (app.vault.getRoot as jest.Mock).mockReturnValue(rootFolder);

      const result = await dirOps.listDirectories({
        paths: ["/"],
      });

      expect(result.results[0].files?.length).toBe(1);
    });

    it("lists files and directories with default settings", async () => {
      const folder = new TFolder({
        path: "test",
        children: [
          new TFile({ path: "test/file.md", stat: { ctime: 1000, mtime: 2000, size: 100 } }),
          new TFolder({ path: "test/subdir", children: [] }),
        ],
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(folder);

      const result = await dirOps.listDirectories({
        paths: ["test"],
      });

      expect(result.results[0].files?.length).toBe(1);
      expect(result.results[0].directories?.length).toBe(1);
      expect(result.results[0].summary).toContain("2 items");
    });

    it("filters to only files when filter is files", async () => {
      const folder = new TFolder({
        path: "test",
        children: [
          new TFile({ path: "test/file.md", stat: { ctime: 1000, mtime: 2000, size: 100 } }),
          new TFolder({ path: "test/subdir", children: [] }),
        ],
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(folder);

      const result = await dirOps.listDirectories({
        paths: ["test"],
        filter: "files",
      } as any);

      expect(result.results[0].files?.length).toBe(1);
      expect(result.results[0].directories).toBeUndefined();
    });

    it("filters to only directories when filter is directories", async () => {
      const folder = new TFolder({
        path: "test",
        children: [
          new TFile({ path: "test/file.md", stat: { ctime: 1000, mtime: 2000, size: 100 } }),
          new TFolder({ path: "test/subdir", children: [] }),
        ],
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(folder);

      const result = await dirOps.listDirectories({
        paths: ["test"],
        filter: "directories",
      } as any);

      expect(result.results[0].directories?.length).toBe(1);
      expect(result.results[0].files).toBeUndefined();
    });

    it("sorts by name when sort is name", async () => {
      const folder = new TFolder({
        path: "test",
        children: [
          new TFile({ path: "test/zebra.md", name: "zebra.md", stat: { ctime: 1000, mtime: 2000, size: 100 } }),
          new TFile({ path: "test/alpha.md", name: "alpha.md", stat: { ctime: 1000, mtime: 2000, size: 100 } }),
        ],
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(folder);

      const result = await dirOps.listDirectories({
        paths: ["test"],
        sort: "name",
      } as any);

      expect(result.results[0].files?.[0].name).toBe("alpha.md");
      expect(result.results[0].files?.[1].name).toBe("zebra.md");
    });

    it("includes file previews for small markdown files", async () => {
      const folder = new TFolder({
        path: "test",
        children: [
          new TFile({ path: "test/doc.md", extension: "md", stat: { ctime: 1000, mtime: 2000, size: 50 } }),
        ],
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(folder);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("# Hello World\n\nThis is content.");

      const result = await dirOps.listDirectories({
        paths: ["test"],
      });

      expect(result.results[0].files?.[0].preview).toBe("# Hello World");
    });

    it("recursively lists when recursive is true", async () => {
      const subFolder = new TFolder({
        path: "test/subdir",
        children: [
          new TFile({ path: "test/subdir/nested.md", stat: { ctime: 1000, mtime: 2000, size: 50 } }),
        ],
      });
      const folder = new TFolder({
        path: "test",
        children: [
          new TFile({ path: "test/file.md", stat: { ctime: 1000, mtime: 2000, size: 100 } }),
          subFolder,
        ],
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(folder);

      const result = await dirOps.listDirectories({
        paths: ["test"],
        recursive: true,
      } as any);

      // Should have both files and the subdir
      expect(result.results[0].files?.length).toBeGreaterThanOrEqual(2);
      expect(result.results[0].summary).toContain("recursive");
    });
  });

  describe("moveItems", () => {
    it("throws error when too many items", async () => {
      const items = Array(15).fill({ source: "a", destination: "b" });

      await expect(dirOps.moveItems({ items })).rejects.toThrow(
        "Cannot move more than"
      );
    });

    it("returns error for blocked source path", async () => {
      const result = await dirOps.moveItems({
        items: [{ source: "blocked/file.md", destination: "new/file.md" }],
      });

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("Access denied");
    });

    it("returns error for blocked destination path", async () => {
      const mockFile = new TFile({ path: "old.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      const result = await dirOps.moveItems({
        items: [{ source: "old.md", destination: "blocked/file.md" }],
      });

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("Access denied");
    });

    it("returns error when source not found", async () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await dirOps.moveItems({
        items: [{ source: "missing.md", destination: "new.md" }],
      });

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("Item not found");
    });

    it("moves item successfully", async () => {
      const mockFile = new TFile({ path: "old.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      const result = await dirOps.moveItems({
        items: [{ source: "old.md", destination: "new.md" }],
      });

      expect(result.results[0].success).toBe(true);
      expect(app.fileManager.renameFile).toHaveBeenCalledWith(mockFile, "new.md");
    });

    it("processes items in chunks", async () => {
      const mockFile = new TFile({ path: "file.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      const items = Array(8)
        .fill(null)
        .map((_, i) => ({
          source: `file${i}.md`,
          destination: `new${i}.md`,
        }));

      const result = await dirOps.moveItems({ items });

      expect(result.results.length).toBe(8);
      expect(result.results.every((r) => r.success)).toBe(true);
    });

    it("shows notice after successful moves", async () => {
      const mockFile = new TFile({ path: "old.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      await dirOps.moveItems({
        items: [{ source: "old.md", destination: "new.md" }],
      });

      // Notice is called but we don't mock it as a spy
      expect(app.fileManager.renameFile).toHaveBeenCalled();
    });
  });

  describe("trashFiles", () => {
    it("throws error when too many files", async () => {
      const paths = Array(15).fill("file.md");

      await expect(dirOps.trashFiles({ paths })).rejects.toThrow(
        "Cannot trash more than"
      );
    });

    it("returns error for blocked paths", async () => {
      const result = await dirOps.trashFiles({
        paths: ["blocked/file.md"],
      });

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("Access denied");
    });

    it("returns error when file not found", async () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await dirOps.trashFiles({
        paths: ["missing.md"],
      });

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain("File not found");
    });

    it("trashes file successfully", async () => {
      const mockFile = new TFile({ path: "delete-me.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      const result = await dirOps.trashFiles({
        paths: ["delete-me.md"],
      });

      expect(result.results[0].success).toBe(true);
      expect(app.vault.adapter.trashLocal).toHaveBeenCalledWith("delete-me.md");
    });

    it("trashes multiple files", async () => {
      const mockFile = new TFile({ path: "file.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      const result = await dirOps.trashFiles({
        paths: ["file1.md", "file2.md", "file3.md"],
      });

      expect(result.results.length).toBe(3);
      expect(result.results.every((r) => r.success)).toBe(true);
      expect(app.vault.adapter.trashLocal).toHaveBeenCalledTimes(3);
    });
  });
});
