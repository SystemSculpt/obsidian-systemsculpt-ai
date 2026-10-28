/**
 * @jest-environment node
 */
import { applyFileEdits } from "../editApplication";
import type { FileEdit } from "../types";

function applyNonStrictEdits(original: string, edits: FileEdit[]): string {
  return applyFileEdits(original, edits, false).modifiedContent;
}

describe("applyNonStrictEdits", () => {
  describe("exact mode string replacement", () => {
    it("replaces first occurrence by default", () => {
      const original = "hello world hello";
      const edits: FileEdit[] = [
        { oldText: "hello", newText: "hi" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hi world hello");
    });

    it("replaces last occurrence", () => {
      const original = "hello world hello";
      const edits: FileEdit[] = [
        { oldText: "hello", newText: "hi", occurrence: "last" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hello world hi");
    });

    it("replaces all occurrences", () => {
      const original = "hello world hello";
      const edits: FileEdit[] = [
        { oldText: "hello", newText: "hi", occurrence: "all" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hi world hi");
    });

    it("handles no match gracefully", () => {
      const original = "hello world";
      const edits: FileEdit[] = [
        { oldText: "goodbye", newText: "hi" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hello world");
    });

    it("normalizes CRLF to LF", () => {
      const original = "line1\r\nline2";
      const edits: FileEdit[] = [];
      expect(applyNonStrictEdits(original, edits)).toBe("line1\nline2");
    });
  });

  describe("regex replacement", () => {
    it("replaces using regex pattern", () => {
      const original = "hello123world";
      const edits: FileEdit[] = [
        { oldText: "\\d+", newText: "-", isRegex: true },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hello-world");
    });

    it("replaces all regex matches", () => {
      const original = "a1b2c3";
      const edits: FileEdit[] = [
        { oldText: "\\d", newText: "X", isRegex: true, occurrence: "all" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("aXbXcX");
    });

    it("replaces first regex match only", () => {
      const original = "a1b2c3";
      const edits: FileEdit[] = [
        { oldText: "\\d", newText: "X", isRegex: true, occurrence: "first" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("aXb2c3");
    });

    it("replaces last regex match only", () => {
      const original = "a1b2c3";
      const edits: FileEdit[] = [
        { oldText: "\\d", newText: "X", isRegex: true, occurrence: "last" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("a1b2cX");
    });

    it("uses custom regex flags", () => {
      const original = "Hello HELLO hello";
      const edits: FileEdit[] = [
        { oldText: "hello", newText: "hi", isRegex: true, flags: "gi", occurrence: "all" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hi hi hi");
    });
  });

  describe("loose mode replacement", () => {
    it("matches ignoring leading whitespace", () => {
      const original = "  hello\n  world";
      const edits: FileEdit[] = [
        { oldText: "hello\nworld", newText: "hi\nthere", mode: "loose" },
      ];
      const result = applyNonStrictEdits(original, edits);
      expect(result).toContain("hi");
      expect(result).toContain("there");
    });

    it("preserves original indentation when preserveIndent is true", () => {
      const original = "    function() {\n    }";
      const edits: FileEdit[] = [
        { oldText: "function() {\n}", newText: "fn() {\n}", mode: "loose", preserveIndent: true },
      ];
      const result = applyNonStrictEdits(original, edits);
      expect(result.startsWith("    ")).toBe(true);
    });

    it("replaces all loose matches", () => {
      const original = "  foo\n  foo";
      const edits: FileEdit[] = [
        { oldText: "foo", newText: "bar", mode: "loose", occurrence: "all" },
      ];
      const result = applyNonStrictEdits(original, edits);
      expect(result).not.toContain("foo");
    });
  });

  describe("range-based replacement", () => {
    it("replaces within line range", () => {
      const original = "line1\nline2\nline3\nline4";
      const edits: FileEdit[] = [
        {
          oldText: "line2",
          newText: "replaced",
          range: { startLine: 2, endLine: 2 }
        },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("line1\nreplaced\nline3\nline4");
    });

    it("replaces within index range", () => {
      const original = "0123456789";
      const edits: FileEdit[] = [
        {
          oldText: "345",
          newText: "XXX",
          range: { startIndex: 0, endIndex: 7 }
        },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("012XXX6789");
    });

    it("handles range with null values", () => {
      const original = "hello world";
      const edits: FileEdit[] = [
        {
          oldText: "world",
          newText: "universe",
          range: { startLine: null, endLine: null }
        },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hello universe");
    });
  });

  describe("multiple edits", () => {
    it("applies multiple edits in sequence", () => {
      const original = "aaa bbb ccc";
      const edits: FileEdit[] = [
        { oldText: "aaa", newText: "111" },
        { oldText: "bbb", newText: "222" },
        { oldText: "ccc", newText: "333" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("111 222 333");
    });

    it("later edits see results of earlier edits", () => {
      const original = "hello";
      const edits: FileEdit[] = [
        { oldText: "hello", newText: "hello world" },
        { oldText: "world", newText: "universe" },
      ];
      expect(applyNonStrictEdits(original, edits)).toBe("hello universe");
    });
  });

  describe("edge cases", () => {
    it("handles empty original", () => {
      const edits: FileEdit[] = [
        { oldText: "x", newText: "y" },
      ];
      expect(applyNonStrictEdits("", edits)).toBe("");
    });

    it("handles empty edits array", () => {
      expect(applyNonStrictEdits("unchanged", [])).toBe("unchanged");
    });

    it("handles empty oldText and newText", () => {
      const original = "hello";
      const edits: FileEdit[] = [
        { oldText: "", newText: "" },
      ];
      // Empty oldText matches at every position, behavior depends on implementation
      expect(typeof applyNonStrictEdits(original, edits)).toBe("string");
    });
  });
});

