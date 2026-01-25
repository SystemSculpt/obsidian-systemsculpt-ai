/**
 * @jest-environment jsdom
 */
import { generateDiff, isFileOpen, getFileContent, DiffLine, DiffResult } from "../diffUtils";

describe("diffUtils", () => {
  describe("generateDiff", () => {
    it("returns empty diff for identical content", () => {
      const result = generateDiff("hello", "hello");

      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
    });

    it("detects added lines", () => {
      const oldContent = "line1\nline2";
      const newContent = "line1\nline2\nline3";

      const result = generateDiff(oldContent, newContent);

      expect(result.stats.additions).toBe(1);
      expect(result.stats.deletions).toBe(0);
      expect(result.lines.some(l => l.type === "added" && l.content === "line3")).toBe(true);
    });

    it("detects removed lines", () => {
      const oldContent = "line1\nline2\nline3";
      const newContent = "line1\nline2";

      const result = generateDiff(oldContent, newContent);

      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(1);
      expect(result.lines.some(l => l.type === "removed" && l.content === "line3")).toBe(true);
    });

    it("detects changed lines", () => {
      const oldContent = "hello";
      const newContent = "world";

      const result = generateDiff(oldContent, newContent);

      expect(result.stats.additions).toBe(1);
      expect(result.stats.deletions).toBe(1);
    });

    it("handles empty old content", () => {
      const result = generateDiff("", "new line");

      expect(result.stats.additions).toBe(1);
      expect(result.stats.deletions).toBe(0);
    });

    it("handles empty new content", () => {
      const result = generateDiff("old line", "");

      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(1);
    });

    it("handles both empty", () => {
      const result = generateDiff("", "");

      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
      expect(result.lines.length).toBe(0);
    });

    it("respects context lines parameter", () => {
      const oldContent = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
      const newContent = "line1\nline2\nline3\nline4\nchanged\nline6\nline7\nline8\nline9\nline10";

      const result = generateDiff(oldContent, newContent, 2);

      // Should include context lines around the change
      expect(result.lines.some(l => l.content === "changed")).toBe(true);
    });

    it("marks isTruncated when content is cut", () => {
      const oldContent = "line1\nline2\nchanged\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\nline13\nline14\nline15";
      const newContent = "line1\nline2\nmodified\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\nline13\nline14\nline15";

      const result = generateDiff(oldContent, newContent, 2);

      // Should indicate truncation happened
      expect(result.isTruncated).toBe(true);
    });

    it("handles trailing newlines correctly", () => {
      const oldContent = "line1\nline2\n";
      const newContent = "line1\nline2\n";

      const result = generateDiff(oldContent, newContent);

      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
    });

    it("assigns line numbers to diff lines", () => {
      const oldContent = "line1\nline2";
      const newContent = "line1\nmodified";

      const result = generateDiff(oldContent, newContent);

      const unchangedLine = result.lines.find(l => l.content === "line1");
      expect(unchangedLine?.oldLineNumber).toBeDefined();
      expect(unchangedLine?.newLineNumber).toBeDefined();
    });

    it("handles multi-line insertions", () => {
      const oldContent = "start\nend";
      const newContent = "start\nnew1\nnew2\nnew3\nend";

      const result = generateDiff(oldContent, newContent);

      expect(result.stats.additions).toBe(3);
      expect(result.stats.deletions).toBe(0);
    });

    it("handles multi-line deletions", () => {
      const oldContent = "start\nold1\nold2\nold3\nend";
      const newContent = "start\nend";

      const result = generateDiff(oldContent, newContent);

      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(3);
    });

    it("handles complex mixed changes", () => {
      const oldContent = "line1\nline2\nline3\nline4";
      const newContent = "line1\nmodified\nline3\nnew4\nnew5";

      const result = generateDiff(oldContent, newContent);

      // Should have some additions and deletions
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });
  });

  describe("isFileOpen", () => {
    it("returns false when no leaves match", () => {
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([]),
        },
      };

      expect(isFileOpen(mockApp, "test.md")).toBe(false);
    });

    it("returns true when file is found in a leaf", () => {
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([
            {
              view: {
                file: { path: "test.md" },
              },
            },
          ]),
        },
      };

      expect(isFileOpen(mockApp, "test.md")).toBe(true);
    });

    it("returns false when path does not match", () => {
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([
            {
              view: {
                file: { path: "other.md" },
              },
            },
          ]),
        },
      };

      expect(isFileOpen(mockApp, "test.md")).toBe(false);
    });

    it("handles leaf with no view", () => {
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([
            { view: null },
          ]),
        },
      };

      expect(isFileOpen(mockApp, "test.md")).toBe(false);
    });

    it("handles leaf with no file in view", () => {
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([
            { view: { file: null } },
          ]),
        },
      };

      expect(isFileOpen(mockApp, "test.md")).toBe(false);
    });
  });

  describe("getFileContent", () => {
    it("returns content from editor if file is open", async () => {
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([
            {
              view: {
                file: { path: "test.md" },
                editor: {
                  getValue: jest.fn().mockReturnValue("editor content"),
                },
              },
            },
          ]),
        },
        vault: {
          getAbstractFileByPath: jest.fn(),
          read: jest.fn(),
        },
      };

      const content = await getFileContent(mockApp, "test.md");
      expect(content).toBe("editor content");
    });

    it("falls back to vault when file not in editor", async () => {
      const mockFile = { path: "test.md", stat: {} };
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([]),
        },
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
          read: jest.fn().mockResolvedValue("vault content"),
        },
      };

      const content = await getFileContent(mockApp, "test.md");
      expect(content).toBe("vault content");
    });

    it("returns empty string when file not found", async () => {
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([]),
        },
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          read: jest.fn(),
        },
      };

      const content = await getFileContent(mockApp, "test.md");
      expect(content).toBe("");
    });

    it("handles read error gracefully", async () => {
      const mockFile = { path: "test.md", stat: {} };
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([]),
        },
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
          read: jest.fn().mockRejectedValue(new Error("Read error")),
        },
      };

      const content = await getFileContent(mockApp, "test.md");
      expect(content).toBe("");
    });

    it("handles open file without editor", async () => {
      const mockFile = { path: "test.md", stat: {} };
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([
            {
              view: {
                file: { path: "test.md" },
                editor: null,
              },
            },
          ]),
        },
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
          read: jest.fn().mockResolvedValue("vault content"),
        },
      };

      const content = await getFileContent(mockApp, "test.md");
      expect(content).toBe("vault content");
    });
  });
});
