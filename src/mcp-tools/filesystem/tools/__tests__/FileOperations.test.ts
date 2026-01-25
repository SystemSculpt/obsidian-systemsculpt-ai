/**
 * @jest-environment jsdom
 */
import { App, TFile, TFolder, normalizePath } from "obsidian";
import { FileOperations } from "../FileOperations";
import { FILESYSTEM_LIMITS } from "../../constants";

// Mock utils
jest.mock("../../utils", () => ({
  validatePath: jest.fn((path, allowedPaths) => {
    if (path === "blocked/file.md") return false;
    return true;
  }),
  normalizeLineEndings: jest.fn((text) => text.replace(/\r\n/g, "\n")),
  createSimpleDiff: jest.fn((original, modified, path) => `diff for ${path}`),
  isHiddenSystemPath: jest.fn(() => false),
  ensureAdapterFolder: jest.fn(async () => {}),
  adapterPathExists: jest.fn(async () => false),
  readAdapterText: jest.fn(async () => ""),
  writeAdapterText: jest.fn(async () => {}),
  statAdapterPath: jest.fn(async () => null),
}));

// Mock constants
jest.mock("../../constants", () => ({
  FILESYSTEM_LIMITS: {
    MAX_OPERATIONS: 10,
    MAX_FILE_READ_LENGTH: 100000,
    MAX_CONTENT_SIZE: 500000,
  },
}));

describe("FileOperations", () => {
  let app: App;
  let fileOps: FileOperations;
  const allowedPaths = ["/"];

  beforeEach(() => {
    jest.clearAllMocks();

    app = new App();

    // Setup default mocks
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.read as jest.Mock).mockResolvedValue("");
    (app.vault.modify as jest.Mock).mockResolvedValue(undefined);
    (app.vault.create as jest.Mock).mockResolvedValue({});
    (app.vault.createFolder as jest.Mock).mockResolvedValue(undefined);

    fileOps = new FileOperations(app, allowedPaths);
  });

  describe("readFiles", () => {
    it("throws error when paths is missing", async () => {
      await expect(fileOps.readFiles({} as any)).rejects.toThrow(
        "Missing required 'paths'"
      );
    });

    it("throws error when paths is empty array", async () => {
      await expect(fileOps.readFiles({ paths: [] } as any)).rejects.toThrow(
        "Missing required 'paths'"
      );
    });

    it("throws error when paths array has only whitespace", async () => {
      await expect(
        fileOps.readFiles({ paths: ["  ", ""] } as any)
      ).rejects.toThrow("Missing required 'paths'");
    });

    it("throws error when too many files requested", async () => {
      const paths = Array(15).fill("file.md");
      await expect(fileOps.readFiles({ paths } as any)).rejects.toThrow(
        "Too many files requested"
      );
    });

    it("returns access denied for blocked paths", async () => {
      const result = await fileOps.readFiles({
        paths: ["blocked/file.md"],
      } as any);

      expect(result.files[0].error).toBe("Access denied");
      expect(result.files[0].content).toBe("");
    });

    it("returns file not found for non-existent files", async () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await fileOps.readFiles({ paths: ["missing.md"] } as any);

      expect(result.files[0].error).toBe("File not found or is a directory");
    });

    it("reads file successfully with metadata", async () => {
      const mockFile = new TFile({
        path: "test.md",
        stat: { ctime: 1000, mtime: 2000, size: 100 },
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("Hello world");

      const result = await fileOps.readFiles({ paths: ["test.md"] } as any);

      expect(result.files[0].path).toBe("test.md");
      expect(result.files[0].content).toBe("Hello world");
      expect(result.files[0].metadata?.fileSize).toBe(11);
      expect(result.files[0].metadata?.hasMore).toBe(false);
    });

    it("handles windowed reading with offset", async () => {
      const mockFile = new TFile({
        path: "test.md",
        stat: { ctime: 1000, mtime: 2000, size: 100 },
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("0123456789");

      const result = await fileOps.readFiles({
        paths: ["test.md"],
        offset: 5,
        length: 3,
      } as any);

      expect(result.files[0].content).toBe("567");
      expect(result.files[0].metadata?.windowStart).toBe(5);
      expect(result.files[0].metadata?.windowEnd).toBe(8);
    });

    it("adds truncation notice when file exceeds default max window", async () => {
      const mockFile = new TFile({
        path: "big.md",
        stat: { ctime: 1000, mtime: 2000, size: 100 },
      });
      // Create content larger than MAX_FILE_READ_LENGTH (100000 in mock)
      const longContent = "a".repeat(150000);
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue(longContent);

      // Don't provide length - will use default which gets clamped
      const result = await fileOps.readFiles({
        paths: ["big.md"],
      } as any);

      expect(result.files[0].content).toContain("[... truncated:");
      expect(result.files[0].metadata?.hasMore).toBe(true);
    });

    it("handles read errors gracefully", async () => {
      const mockFile = new TFile({
        path: "error.md",
        stat: { ctime: 1000, mtime: 2000, size: 100 },
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockRejectedValue(new Error("Read failed"));

      const result = await fileOps.readFiles({ paths: ["error.md"] } as any);

      expect(result.files[0].error).toBe("Failed to read file");
    });

    it("reads multiple files", async () => {
      const mockFile1 = new TFile({
        path: "file1.md",
        stat: { ctime: 1000, mtime: 2000, size: 10 },
      });
      const mockFile2 = new TFile({
        path: "file2.md",
        stat: { ctime: 1000, mtime: 2000, size: 10 },
      });

      (app.vault.getAbstractFileByPath as jest.Mock)
        .mockReturnValueOnce(mockFile1)
        .mockReturnValueOnce(mockFile2);
      (app.vault.read as jest.Mock)
        .mockResolvedValueOnce("content1")
        .mockResolvedValueOnce("content2");

      const result = await fileOps.readFiles({
        paths: ["file1.md", "file2.md"],
      } as any);

      expect(result.files.length).toBe(2);
      expect(result.files[0].content).toBe("content1");
      expect(result.files[1].content).toBe("content2");
    });

    it("trims path strings", async () => {
      const mockFile = new TFile({
        path: "test.md",
        stat: { ctime: 1000, mtime: 2000, size: 10 },
      });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("content");

      const result = await fileOps.readFiles({
        paths: ["  test.md  "],
      } as any);

      expect(result.files[0].content).toBe("content");
    });
  });

  describe("writeFile", () => {
    it("throws error for blocked paths", async () => {
      await expect(
        fileOps.writeFile({ path: "blocked/file.md", content: "test" })
      ).rejects.toThrow("Access denied");
    });

    it("throws error when content too large", async () => {
      const largeContent = "a".repeat(600000);

      await expect(
        fileOps.writeFile({ path: "test.md", content: largeContent })
      ).rejects.toThrow("Content too large");
    });

    it("creates new file when it does not exist", async () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await fileOps.writeFile({
        path: "new.md",
        content: "hello",
      });

      expect(result.success).toBe(true);
      expect(app.vault.create).toHaveBeenCalledWith("new.md", "hello");
    });

    it("creates parent directories when createDirs is true", async () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      await fileOps.writeFile({
        path: "parent/child/file.md",
        content: "hello",
        createDirs: true,
      } as any);

      expect(app.vault.createFolder).toHaveBeenCalledWith("parent/child");
    });

    it("overwrites existing file by default", async () => {
      const mockFile = new TFile({ path: "existing.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      const result = await fileOps.writeFile({
        path: "existing.md",
        content: "new content",
      });

      expect(result.success).toBe(true);
      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "new content");
    });

    it("skips when ifExists is skip", async () => {
      const mockFile = new TFile({ path: "existing.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      const result = await fileOps.writeFile({
        path: "existing.md",
        content: "ignored",
        ifExists: "skip",
      } as any);

      expect(result.success).toBe(true);
      expect(app.vault.modify).not.toHaveBeenCalled();
    });

    it("throws error when ifExists is error", async () => {
      const mockFile = new TFile({ path: "existing.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);

      await expect(
        fileOps.writeFile({
          path: "existing.md",
          content: "content",
          ifExists: "error",
        } as any)
      ).rejects.toThrow("File already exists");
    });

    it("appends content when ifExists is append", async () => {
      const mockFile = new TFile({ path: "existing.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("existing");

      await fileOps.writeFile({
        path: "existing.md",
        content: " appended",
        ifExists: "append",
      } as any);

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "existing appended");
    });

    it("adds newline before append when appendNewline is true", async () => {
      const mockFile = new TFile({ path: "existing.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("existing");

      await fileOps.writeFile({
        path: "existing.md",
        content: "appended",
        ifExists: "append",
        appendNewline: true,
      } as any);

      expect(app.vault.modify).toHaveBeenCalledWith(
        mockFile,
        "existing\nappended"
      );
    });

    it("does not add extra newline when content already ends with newline", async () => {
      const mockFile = new TFile({ path: "existing.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("existing\n");

      await fileOps.writeFile({
        path: "existing.md",
        content: "appended",
        ifExists: "append",
        appendNewline: true,
      } as any);

      expect(app.vault.modify).toHaveBeenCalledWith(
        mockFile,
        "existing\nappended"
      );
    });
  });

  describe("editFile", () => {
    it("throws error when file not found", async () => {
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      await expect(
        fileOps.editFile({
          path: "missing.md",
          edits: [{ oldText: "a", newText: "b" }],
        })
      ).rejects.toThrow("File not found");
    });

    it("falls back to Folder Notes path when present", async () => {
      const folder = new TFolder();
      (folder as any).path = "missing";
      const fallbackFile = new TFile({ path: "missing/missing.md" });

      (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((p: string) => {
        if (p === "missing.md") return null;
        if (p === "missing") return folder;
        if (p === "missing/missing.md") return fallbackFile;
        return null;
      });
      (app.vault.read as jest.Mock).mockResolvedValue("hello world");

      const result = await fileOps.editFile({
        path: "missing.md",
        edits: [{ oldText: "world", newText: "universe" }],
      });

      expect(app.vault.modify).toHaveBeenCalledWith(fallbackFile, "hello universe");
      expect(result).toContain("missing/missing.md");
    });

    it("applies simple text replacement", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("hello world");

      const result = await fileOps.editFile({
        path: "test.md",
        edits: [{ oldText: "world", newText: "universe" }],
      });

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "hello universe");
      expect(result).toContain("diff");
    });

    it("applies multiple edits in sequence", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("aaa bbb ccc");

      await fileOps.editFile({
        path: "test.md",
        edits: [
          { oldText: "aaa", newText: "AAA" },
          { oldText: "ccc", newText: "CCC" },
        ],
      });

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "AAA bbb CCC");
    });

    it("throws error when edit produces no changes in strict mode", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("hello world");

      await expect(
        fileOps.editFile({
          path: "test.md",
          edits: [{ oldText: "notfound", newText: "replacement" }],
          strict: true,
        } as any)
      ).rejects.toThrow("Edit produced no changes");
    });

    it("silently skips failed edits when strict is false", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("hello world");

      const result = await fileOps.editFile({
        path: "test.md",
        edits: [
          { oldText: "notfound", newText: "replacement" },
          { oldText: "hello", newText: "HELLO" },
        ],
        strict: false,
      } as any);

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "HELLO world");
    });

    it("replaces all occurrences when occurrence is all", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("a a a");

      await fileOps.editFile({
        path: "test.md",
        edits: [{ oldText: "a", newText: "b", occurrence: "all" }],
      });

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "b b b");
    });

    it("replaces last occurrence when occurrence is last", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("a a a");

      await fileOps.editFile({
        path: "test.md",
        edits: [{ oldText: "a", newText: "b", occurrence: "last" }],
      });

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "a a b");
    });

    it("handles regex replacements", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("foo123bar");

      await fileOps.editFile({
        path: "test.md",
        edits: [
          { oldText: "\\d+", newText: "###", isRegex: true, occurrence: "all" },
        ],
      });

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "foo###bar");
    });

    it("respects line range constraints", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("line1\nline2\nline3");

      await fileOps.editFile({
        path: "test.md",
        edits: [
          {
            oldText: "line",
            newText: "LINE",
            range: { startLine: 2, endLine: 2 },
          },
        ],
      });

      // Should only modify line 2
      expect(app.vault.modify).toHaveBeenCalledWith(
        mockFile,
        "line1\nLINE2\nline3"
      );
    });

    it("respects index range constraints", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("hello world");

      await fileOps.editFile({
        path: "test.md",
        edits: [
          {
            oldText: "o",
            newText: "0",
            range: { startIndex: 5, endIndex: 11 },
          },
        ],
      });

      // Should only modify the "o" in "world", not "hello"
      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "hello w0rld");
    });
  });

  describe("private methods via public interface", () => {
    it("handles loose mode matching with whitespace differences", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("  hello  \n  world  ");

      await fileOps.editFile({
        path: "test.md",
        edits: [
          {
            oldText: "hello\nworld",
            newText: "HELLO\nWORLD",
            mode: "loose",
          },
        ],
      });

      // In loose mode, whitespace differences are ignored when matching
      expect(app.vault.modify).toHaveBeenCalled();
    });

    it("preserves indentation when preserveIndent is true", async () => {
      const mockFile = new TFile({ path: "test.md" });
      (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (app.vault.read as jest.Mock).mockResolvedValue("    indented line");

      await fileOps.editFile({
        path: "test.md",
        edits: [
          {
            oldText: "indented line",
            newText: "new line",
            mode: "loose",
            preserveIndent: true,
          },
        ],
      });

      expect(app.vault.modify).toHaveBeenCalledWith(mockFile, "    new line");
    });
  });
});
