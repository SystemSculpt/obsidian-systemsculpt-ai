/**
 * @jest-environment jsdom
 */
import { trimOuterBlankLines } from "../textUtils";

describe("textUtils", () => {
  describe("trimOuterBlankLines", () => {
    it("returns empty string for null input", () => {
      expect(trimOuterBlankLines(null)).toBe("");
    });

    it("returns empty string for undefined input", () => {
      expect(trimOuterBlankLines(undefined)).toBe("");
    });

    it("returns empty string for empty input", () => {
      expect(trimOuterBlankLines("")).toBe("");
    });

    it("trims leading blank lines", () => {
      expect(trimOuterBlankLines("\n\n\nHello")).toBe("Hello");
    });

    it("trims trailing blank lines", () => {
      expect(trimOuterBlankLines("Hello\n\n\n")).toBe("Hello");
    });

    it("trims both leading and trailing blank lines", () => {
      expect(trimOuterBlankLines("\n\nHello\n\n")).toBe("Hello");
    });

    it("preserves internal blank lines", () => {
      expect(trimOuterBlankLines("\nHello\n\nWorld\n")).toBe("Hello\n\nWorld");
    });

    it("handles lines with only spaces/tabs as blank", () => {
      expect(trimOuterBlankLines("  \t\nHello\n  \t")).toBe("Hello");
    });

    it("preserves leading spaces on first non-blank line", () => {
      expect(trimOuterBlankLines("\n  Hello")).toBe("  Hello");
    });

    it("preserves trailing spaces on last non-blank line", () => {
      expect(trimOuterBlankLines("Hello  \n")).toBe("Hello  ");
    });

    it("handles Windows-style line endings (CRLF)", () => {
      expect(trimOuterBlankLines("\r\n\r\nHello\r\n\r\n")).toBe("Hello");
    });

    it("handles mixed line endings", () => {
      expect(trimOuterBlankLines("\n\r\nHello\r\n\n")).toBe("Hello");
    });

    it("handles string with only blank lines", () => {
      expect(trimOuterBlankLines("\n\n\n")).toBe("");
    });

    it("handles string with only whitespace on multiple lines", () => {
      // Only removes blank *lines*, not the content of a single non-blank line
      expect(trimOuterBlankLines("  \t  \n  \t  ")).toBe("  \t  ");
    });

    it("leaves single line without newlines unchanged", () => {
      expect(trimOuterBlankLines("Hello World")).toBe("Hello World");
    });

    it("converts non-string values to strings", () => {
      // @ts-expect-error - Testing edge case with number input
      expect(trimOuterBlankLines(42)).toBe("42");
    });
  });
});
