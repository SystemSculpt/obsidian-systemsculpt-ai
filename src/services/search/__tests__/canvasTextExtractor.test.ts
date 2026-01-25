import { extractCanvasText } from "../canvasTextExtractor";

describe("extractCanvasText", () => {
  describe("input validation", () => {
    it("returns empty string for empty input", () => {
      expect(extractCanvasText("", { maxChars: 100 })).toBe("");
    });

    it("returns empty string for null-ish input", () => {
      expect(extractCanvasText(null as any, { maxChars: 100 })).toBe("");
      expect(extractCanvasText(undefined as any, { maxChars: 100 })).toBe("");
    });

    it("returns empty string for non-string input", () => {
      expect(extractCanvasText(123 as any, { maxChars: 100 })).toBe("");
      expect(extractCanvasText({} as any, { maxChars: 100 })).toBe("");
    });

    it("returns empty string when maxChars is 0", () => {
      const canvas = JSON.stringify({ nodes: [{ text: "hello" }] });
      expect(extractCanvasText(canvas, { maxChars: 0 })).toBe("");
    });

    it("returns empty string when maxChars is negative", () => {
      const canvas = JSON.stringify({ nodes: [{ text: "hello" }] });
      expect(extractCanvasText(canvas, { maxChars: -10 })).toBe("");
    });
  });

  describe("JSON parsing", () => {
    it("returns empty string for invalid JSON", () => {
      expect(extractCanvasText("not valid json", { maxChars: 100 })).toBe("");
      expect(extractCanvasText("{broken: json}", { maxChars: 100 })).toBe("");
      expect(extractCanvasText("{ unclosed", { maxChars: 100 })).toBe("");
    });

    it("returns empty string for non-object JSON", () => {
      expect(extractCanvasText('"just a string"', { maxChars: 100 })).toBe("");
      expect(extractCanvasText("123", { maxChars: 100 })).toBe("");
      expect(extractCanvasText("null", { maxChars: 100 })).toBe("");
      expect(extractCanvasText("true", { maxChars: 100 })).toBe("");
    });

    it("returns empty string for array JSON", () => {
      expect(extractCanvasText("[1, 2, 3]", { maxChars: 100 })).toBe("");
    });
  });

  describe("node extraction", () => {
    it("extracts text from nodes", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: "Hello world" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("Hello world");
    });

    it("extracts title from nodes", () => {
      const canvas = JSON.stringify({
        nodes: [{ title: "My Title" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("My Title");
    });

    it("extracts label from nodes", () => {
      const canvas = JSON.stringify({
        nodes: [{ label: "Node Label" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("Node Label");
    });

    it("extracts file from nodes", () => {
      const canvas = JSON.stringify({
        nodes: [{ file: "path/to/file.md" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("path/to/file.md");
    });

    it("extracts subpath from nodes", () => {
      const canvas = JSON.stringify({
        nodes: [{ subpath: "#heading" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("#heading");
    });

    it("extracts url from nodes", () => {
      const canvas = JSON.stringify({
        nodes: [{ url: "https://example.com" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("https://example.com");
    });

    it("extracts multiple fields from single node in order", () => {
      const canvas = JSON.stringify({
        nodes: [{ title: "Title", label: "Label", text: "Text" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("Title\nLabel\nText");
    });

    it("extracts from multiple nodes", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: "First" }, { text: "Second" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("First\nSecond");
    });

    it("skips non-object nodes", () => {
      const canvas = JSON.stringify({
        nodes: ["string", 123, null, { text: "valid" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("valid");
    });

    it("skips non-string field values", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: 123, title: null, label: { nested: true } }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("");
    });

    it("skips whitespace-only values", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: "   ", title: "\n\t" }, { text: "valid" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("valid");
    });

    it("handles missing nodes array", () => {
      const canvas = JSON.stringify({ edges: [] });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("");
    });

    it("handles non-array nodes", () => {
      const canvas = JSON.stringify({ nodes: "not an array" });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("");
    });
  });

  describe("edge extraction", () => {
    it("extracts label from edges", () => {
      const canvas = JSON.stringify({
        nodes: [],
        edges: [{ label: "Edge Label" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("Edge Label");
    });

    it("extracts from multiple edges", () => {
      const canvas = JSON.stringify({
        nodes: [],
        edges: [{ label: "First Edge" }, { label: "Second Edge" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("First Edge\nSecond Edge");
    });

    it("skips non-object edges", () => {
      const canvas = JSON.stringify({
        nodes: [],
        edges: ["string", 123, null, { label: "valid" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("valid");
    });

    it("handles missing edges array", () => {
      const canvas = JSON.stringify({ nodes: [{ text: "node" }] });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("node");
    });

    it("handles non-array edges", () => {
      const canvas = JSON.stringify({ nodes: [], edges: "not an array" });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("");
    });
  });

  describe("maxChars truncation", () => {
    it("truncates output to maxChars", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: "This is a very long text that should be truncated" }],
      });
      const result = extractCanvasText(canvas, { maxChars: 20 });
      expect(result.length).toBeLessThanOrEqual(20);
    });

    it("stops adding content when exhausted", () => {
      const canvas = JSON.stringify({
        nodes: [
          { text: "First text" },
          { text: "Second text that won't fit" },
          { text: "Third text" },
        ],
      });
      const result = extractCanvasText(canvas, { maxChars: 15 });
      expect(result.length).toBeLessThanOrEqual(15);
      expect(result).toContain("First");
    });

    it("sets exhausted when remaining space equals separator length", () => {
      // First entry is "abc" (3 chars), with maxChars 4, remaining is 1 which equals sep.length ("\n")
      const canvas = JSON.stringify({
        nodes: [{ text: "abc" }, { text: "def" }],
      });
      const result = extractCanvasText(canvas, { maxChars: 4 });
      expect(result).toBe("abc");
    });

    it("sets exhausted when remaining space is less than separator", () => {
      // First entry is "abcd" (4 chars), with maxChars 4, remaining is 0
      const canvas = JSON.stringify({
        nodes: [{ text: "abcd" }, { text: "more" }],
      });
      const result = extractCanvasText(canvas, { maxChars: 4 });
      expect(result).toBe("abcd");
    });

    it("slices content when it partially fits", () => {
      // First is "Hi" (2 chars), remaining is 8, second "World!" (6 chars) + sep (1) = 7, fits
      // Then third needs to be sliced
      const canvas = JSON.stringify({
        nodes: [{ text: "Hi" }, { text: "World!" }, { text: "Extra content" }],
      });
      const result = extractCanvasText(canvas, { maxChars: 15 });
      expect(result.length).toBeLessThanOrEqual(15);
    });

    it("handles slice resulting in empty trimmed string", () => {
      // When slice results in only whitespace after trim, set exhausted
      const canvas = JSON.stringify({
        nodes: [{ text: "Hello" }, { text: "   x" }], // After Hello (5) + \n (1), remaining is very small
      });
      // maxChars 7 means after "Hello\n" (6 chars), only 1 char remaining
      // Trying to add "   x" - sliceLen would be 1, sliced would be " ", trimmed is ""
      const result = extractCanvasText(canvas, { maxChars: 7 });
      expect(result.length).toBeLessThanOrEqual(7);
    });

    it("truncates mid-word when necessary", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: "Supercalifragilistic" }],
      });
      const result = extractCanvasText(canvas, { maxChars: 10 });
      expect(result).toBe("Supercalif");
      expect(result.length).toBe(10);
    });
  });

  describe("combined nodes and edges", () => {
    it("extracts from both nodes and edges in order", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: "Node text" }],
        edges: [{ label: "Edge label" }],
      });
      expect(extractCanvasText(canvas, { maxChars: 100 })).toBe("Node text\nEdge label");
    });

    it("respects maxChars across nodes and edges", () => {
      const canvas = JSON.stringify({
        nodes: [{ text: "Node" }],
        edges: [{ label: "Edge that is very long and should be truncated" }],
      });
      const result = extractCanvasText(canvas, { maxChars: 15 });
      expect(result.length).toBeLessThanOrEqual(15);
    });
  });
});
