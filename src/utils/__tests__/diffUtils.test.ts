/**
 * @jest-environment jsdom
 */
import { generateDiff, isFileOpen, getFileContent, DiffLine, DiffResult } from "../diffUtils";
import { MarkdownView, TFile } from "obsidian";

function createMarkdownView(path: string, editor: { getValue: jest.Mock } | null = null): MarkdownView {
  const view = new MarkdownView();
  Object.assign(view, {
    file: new TFile({ path }),
    editor,
  });
  return view;
}

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

  describe("generateDiff at scale", () => {
    // The full-matrix LCS diff generateDiff used before prefix/suffix
    // trimming. It is the reference for small inputs only.
    function legacyGenerateDiff(oldContent: string, newContent: string, contextLines: number): DiffResult {
      const split = (content: string) => {
        if (!content) return [];
        const lines = content.split("\n");
        if (content.endsWith("\n")) lines.pop();
        return lines;
      };
      const oldLines = split(oldContent);
      const newLines = split(newContent);
      const m = oldLines.length;
      const n = newLines.length;
      const matrix: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          matrix[i][j] = oldLines[i - 1] === newLines[j - 1]
            ? matrix[i - 1][j - 1] + 1
            : Math.max(matrix[i - 1][j], matrix[i][j - 1]);
        }
      }
      const sequence: Array<{ type: DiffLine["type"]; line: string }> = [];
      let i = m;
      let j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
          sequence.push({ type: "unchanged", line: oldLines[i - 1] });
          i--;
          j--;
        } else if (j > 0 && (i === 0 || matrix[i][j - 1] >= matrix[i - 1][j])) {
          sequence.push({ type: "added", line: newLines[j - 1] });
          j--;
        } else if (i > 0) {
          sequence.push({ type: "removed", line: oldLines[i - 1] });
          i--;
        }
      }
      sequence.reverse();
      const stats = { additions: 0, deletions: 0 };
      const full: DiffLine[] = [];
      let oldLineNumber = 1;
      let newLineNumber = 1;
      for (const operation of sequence) {
        if (operation.type === "unchanged") {
          full.push({ type: "unchanged", content: operation.line, oldLineNumber: oldLineNumber++, newLineNumber: newLineNumber++ });
        } else if (operation.type === "removed") {
          full.push({ type: "removed", content: operation.line, oldLineNumber: oldLineNumber++ });
          stats.deletions++;
        } else {
          full.push({ type: "added", content: operation.line, newLineNumber: newLineNumber++ });
          stats.additions++;
        }
      }
      const changed = full.map((line, index) => line.type === "unchanged" ? -1 : index).filter((index) => index >= 0);
      if (changed.length === 0) return { lines: full, stats, isTruncated: false };
      const startIndex = Math.max(0, changed[0] - contextLines);
      const endIndex = Math.min(full.length - 1, changed[changed.length - 1] + contextLines);
      return { lines: full.slice(startIndex, endIndex + 1), stats, isTruncated: endIndex < full.length - 1 };
    }

    function seededRandom(seed: number): () => number {
      let state = seed;
      return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x1_0000_0000;
      };
    }

    const ALL_LINES = Number.MAX_SAFE_INTEGER;

    function expectFaithful(result: DiffResult, oldContent: string, newContent: string): void {
      const oldText = result.lines.filter((line) => line.type !== "added").map((line) => line.content);
      const newText = result.lines.filter((line) => line.type !== "removed").map((line) => line.content);
      expect(oldText.join("\n")).toBe(oldContent.replace(/\n$/, ""));
      expect(newText.join("\n")).toBe(newContent.replace(/\n$/, ""));
      expect(result.stats.additions).toBe(result.lines.filter((line) => line.type === "added").length);
      expect(result.stats.deletions).toBe(result.lines.filter((line) => line.type === "removed").length);
    }

    /** Minimal line edits (insertions plus deletions), from a two-row LCS. */
    function minimalEdits(oldLines: readonly string[], newLines: readonly string[]): number {
      let previous = new Uint32Array(newLines.length + 1);
      let current = new Uint32Array(newLines.length + 1);
      for (let i = 1; i <= oldLines.length; i++) {
        for (let j = 1; j <= newLines.length; j++) {
          current[j] = oldLines[i - 1] === newLines[j - 1]
            ? previous[j - 1] + 1
            : Math.max(previous[j], current[j - 1]);
        }
        [previous, current] = [current, previous];
      }
      return oldLines.length + newLines.length - 2 * previous[newLines.length];
    }

    it("matches the full-matrix diff line for line on ordinary note edits", () => {
      const note = [
        "# Plan", "", "Intro paragraph.", "", "## Tasks", "- [ ] one", "- [ ] two", "",
        "## Notes", "", "Closing paragraph.", "",
      ].join("\n");
      const edits = [
        note.replace("- [ ] two", "- [x] two"),
        note.replace("Intro paragraph.\n\n", ""),
        note.replace("## Notes\n", "## Notes\n\nA new paragraph.\n"),
        `Preface\n\n${note}`,
        `${note}Appendix\n`,
        note.replace("# Plan", "# Renamed plan").replace("Closing paragraph.", "Closing line."),
        "",
        note,
      ];
      for (const edited of edits) {
        for (const context of [0, 3, 5, 10]) {
          expect(generateDiff(note, edited, context)).toEqual(legacyGenerateDiff(note, edited, context));
          expect(generateDiff(edited, note, context)).toEqual(legacyGenerateDiff(edited, note, context));
        }
      }
    });

    it("matches the full-matrix diff on generated ambiguous inputs", () => {
      const random = seededRandom(384);
      const vocabulary = ["", "", "a", "b", "c", "- item", "# h"];
      const lines = () => Array.from(
        { length: Math.floor(random() * 24) },
        () => vocabulary[Math.floor(random() * vocabulary.length)],
      );
      for (let iteration = 0; iteration < 1_500; iteration++) {
        const oldContent = lines().join("\n") + (random() < 0.3 ? "\n" : "");
        const newContent = lines().join("\n") + (random() < 0.3 ? "\n" : "");
        const context = Math.floor(random() * 8);
        expect(generateDiff(oldContent, newContent, context))
          .toEqual(legacyGenerateDiff(oldContent, newContent, context));
      }
    });

    it("diffs a small edit in a 20,000-line note without a full matrix", () => {
      // The full matrix here would be 400 million cells.
      const oldLines = Array.from({ length: 20_000 }, (_, index) => `Line ${index}`);
      const newLines = [...oldLines];
      newLines[10_000] = "Edited line";
      newLines.splice(15_000, 0, "Inserted line");
      const oldContent = oldLines.join("\n");
      const newContent = newLines.join("\n");

      const result = generateDiff(oldContent, newContent, 5);

      expect(result.stats).toEqual({ additions: 2, deletions: 1 });
      expect(result.lines.filter((line) => line.type !== "unchanged")).toEqual([
        { type: "removed", content: "Line 10000", oldLineNumber: 10_001 },
        { type: "added", content: "Edited line", newLineNumber: 10_001 },
        { type: "added", content: "Inserted line", newLineNumber: 15_001 },
      ]);
      expect(result.isTruncated).toBe(true);
      expectFaithful(generateDiff(oldContent, newContent, ALL_LINES), oldContent, newContent);
    });

    it("finds minimal diffs for scattered edits across a large changed middle", () => {
      const random = seededRandom(0x1384);
      const vocabulary = Array.from({ length: 30 }, (_, index) => `word ${index}`);
      for (let iteration = 0; iteration < 4; iteration++) {
        const oldLines = Array.from({ length: 1_500 }, () => vocabulary[Math.floor(random() * vocabulary.length)]);
        const newLines = [...oldLines];
        newLines[0] = "changed first line";
        newLines[newLines.length - 1] = "changed last line";
        for (let edit = 0; edit < 40; edit++) {
          const at = 1 + Math.floor(random() * (newLines.length - 2));
          if (random() < 0.5) newLines.splice(at, 1);
          else newLines.splice(at, 0, `inserted ${edit}`);
        }
        const oldContent = oldLines.join("\n");
        const newContent = newLines.join("\n");

        const result = generateDiff(oldContent, newContent, ALL_LINES);

        expectFaithful(result, oldContent, newContent);
        expect(result.stats.additions + result.stats.deletions).toBe(minimalEdits(oldLines, newLines));
      }
    });

    it("shows an unrelated rewrite of a large note as one replaced block", () => {
      const oldLines = Array.from({ length: 6_000 }, (_, index) => `Old ${index}`);
      const newLines = Array.from({ length: 6_000 }, (_, index) => `New ${index}`);
      oldLines[0] = newLines[0] = "# Same title";
      oldLines[5_999] = newLines[5_999] = "Same footer";
      const oldContent = oldLines.join("\n");
      const newContent = newLines.join("\n");

      const result = generateDiff(oldContent, newContent, ALL_LINES);

      expect(result.stats).toEqual({ additions: 5_998, deletions: 5_998 });
      expectFaithful(result, oldContent, newContent);
      const changed = result.lines.slice(1, -1).map((line) => line.type);
      expect(changed).toEqual([
        ...Array(5_998).fill("removed"),
        ...Array(5_998).fill("added"),
      ]);
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
              view: createMarkdownView("test.md"),
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
              view: createMarkdownView("test.md", {
                getValue: jest.fn().mockReturnValue("editor content"),
              }),
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
      const mockFile = new TFile({ path: "test.md" });
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
      const mockFile = new TFile({ path: "test.md" });
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
      const mockFile = new TFile({ path: "test.md" });
      const mockApp = {
        workspace: {
          getLeavesOfType: jest.fn().mockReturnValue([
            {
              view: createMarkdownView("test.md"),
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
