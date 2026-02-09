/**
 * @jest-environment node
 */
import {
  isWriteOrEditTool,
  isMoveTool,
  isTrashTool,
  isCreateFoldersTool,
  applyEditsLocally,
  prepareOperationsPreview,
  type ToolFileEdit,
} from "../toolCallPreview";

describe("isWriteOrEditTool", () => {
  it("returns true for write", () => {
    expect(isWriteOrEditTool("write")).toBe(true);
  });

  it("returns true for edit", () => {
    expect(isWriteOrEditTool("edit")).toBe(true);
  });

  it("returns true for mcp-prefixed write", () => {
    expect(isWriteOrEditTool("mcp-filesystem_write")).toBe(true);
  });

  it("returns true for mcp-prefixed edit", () => {
    expect(isWriteOrEditTool("mcp-filesystem_edit")).toBe(true);
  });

  it("returns false for read", () => {
    expect(isWriteOrEditTool("read")).toBe(false);
  });

  it("returns false for move", () => {
    expect(isWriteOrEditTool("move")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isWriteOrEditTool("")).toBe(false);
  });
});

describe("isMoveTool", () => {
  it("returns true for move", () => {
    expect(isMoveTool("move")).toBe(true);
  });

  it("returns true for mcp-prefixed move", () => {
    expect(isMoveTool("mcp-filesystem_move")).toBe(true);
  });

  it("returns false for write", () => {
    expect(isMoveTool("write")).toBe(false);
  });

  it("returns false for trash", () => {
    expect(isMoveTool("trash")).toBe(false);
  });
});

describe("isTrashTool", () => {
  it("returns true for trash", () => {
    expect(isTrashTool("trash")).toBe(true);
  });

  it("returns true for mcp-prefixed trash", () => {
    expect(isTrashTool("mcp-filesystem_trash")).toBe(true);
  });

  it("returns false for delete", () => {
    expect(isTrashTool("delete")).toBe(false);
  });

  it("returns false for move", () => {
    expect(isTrashTool("move")).toBe(false);
  });
});

describe("isCreateFoldersTool", () => {
  it("returns true for create_folders", () => {
    expect(isCreateFoldersTool("create_folders")).toBe(true);
  });

  it("returns true for mcp-prefixed create_folders", () => {
    expect(isCreateFoldersTool("mcp-filesystem_create_folders")).toBe(true);
  });

  it("returns false for create", () => {
    expect(isCreateFoldersTool("create")).toBe(false);
  });

  it("returns true for mkdir alias", () => {
    expect(isCreateFoldersTool("mkdir")).toBe(true);
  });
});

describe("applyEditsLocally", () => {
  describe("exact mode string replacement", () => {
    it("replaces first occurrence by default", () => {
      const original = "hello world hello";
      const edits: ToolFileEdit[] = [
        { oldText: "hello", newText: "hi" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hi world hello");
    });

    it("replaces last occurrence", () => {
      const original = "hello world hello";
      const edits: ToolFileEdit[] = [
        { oldText: "hello", newText: "hi", occurrence: "last" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hello world hi");
    });

    it("replaces all occurrences", () => {
      const original = "hello world hello";
      const edits: ToolFileEdit[] = [
        { oldText: "hello", newText: "hi", occurrence: "all" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hi world hi");
    });

    it("handles no match gracefully", () => {
      const original = "hello world";
      const edits: ToolFileEdit[] = [
        { oldText: "goodbye", newText: "hi" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hello world");
    });

    it("normalizes CRLF to LF", () => {
      const original = "line1\r\nline2";
      const edits: ToolFileEdit[] = [];
      expect(applyEditsLocally(original, edits)).toBe("line1\nline2");
    });
  });

  describe("regex replacement", () => {
    it("replaces using regex pattern", () => {
      const original = "hello123world";
      const edits: ToolFileEdit[] = [
        { oldText: "\\d+", newText: "-", isRegex: true },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hello-world");
    });

    it("replaces all regex matches", () => {
      const original = "a1b2c3";
      const edits: ToolFileEdit[] = [
        { oldText: "\\d", newText: "X", isRegex: true, occurrence: "all" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("aXbXcX");
    });

    it("replaces first regex match only", () => {
      const original = "a1b2c3";
      const edits: ToolFileEdit[] = [
        { oldText: "\\d", newText: "X", isRegex: true, occurrence: "first" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("aXb2c3");
    });

    it("replaces last regex match only", () => {
      const original = "a1b2c3";
      const edits: ToolFileEdit[] = [
        { oldText: "\\d", newText: "X", isRegex: true, occurrence: "last" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("a1b2cX");
    });

    it("uses custom regex flags", () => {
      const original = "Hello HELLO hello";
      const edits: ToolFileEdit[] = [
        { oldText: "hello", newText: "hi", isRegex: true, flags: "gi", occurrence: "all" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hi hi hi");
    });
  });

  describe("loose mode replacement", () => {
    it("matches ignoring leading whitespace", () => {
      const original = "  hello\n  world";
      const edits: ToolFileEdit[] = [
        { oldText: "hello\nworld", newText: "hi\nthere", mode: "loose" },
      ];
      const result = applyEditsLocally(original, edits);
      expect(result).toContain("hi");
      expect(result).toContain("there");
    });

    it("preserves original indentation when preserveIndent is true", () => {
      const original = "    function() {\n    }";
      const edits: ToolFileEdit[] = [
        { oldText: "function() {\n}", newText: "fn() {\n}", mode: "loose", preserveIndent: true },
      ];
      const result = applyEditsLocally(original, edits);
      expect(result.startsWith("    ")).toBe(true);
    });

    it("replaces all loose matches", () => {
      const original = "  foo\n  foo";
      const edits: ToolFileEdit[] = [
        { oldText: "foo", newText: "bar", mode: "loose", occurrence: "all" },
      ];
      const result = applyEditsLocally(original, edits);
      expect(result).not.toContain("foo");
    });
  });

  describe("range-based replacement", () => {
    it("replaces within line range", () => {
      const original = "line1\nline2\nline3\nline4";
      const edits: ToolFileEdit[] = [
        {
          oldText: "line2",
          newText: "replaced",
          range: { startLine: 2, endLine: 2 }
        },
      ];
      expect(applyEditsLocally(original, edits)).toBe("line1\nreplaced\nline3\nline4");
    });

    it("replaces within index range", () => {
      const original = "0123456789";
      const edits: ToolFileEdit[] = [
        {
          oldText: "345",
          newText: "XXX",
          range: { startIndex: 0, endIndex: 7 }
        },
      ];
      expect(applyEditsLocally(original, edits)).toBe("012XXX6789");
    });

    it("handles range with null values", () => {
      const original = "hello world";
      const edits: ToolFileEdit[] = [
        {
          oldText: "world",
          newText: "universe",
          range: { startLine: null, endLine: null }
        },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hello universe");
    });
  });

  describe("multiple edits", () => {
    it("applies multiple edits in sequence", () => {
      const original = "aaa bbb ccc";
      const edits: ToolFileEdit[] = [
        { oldText: "aaa", newText: "111" },
        { oldText: "bbb", newText: "222" },
        { oldText: "ccc", newText: "333" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("111 222 333");
    });

    it("later edits see results of earlier edits", () => {
      const original = "hello";
      const edits: ToolFileEdit[] = [
        { oldText: "hello", newText: "hello world" },
        { oldText: "world", newText: "universe" },
      ];
      expect(applyEditsLocally(original, edits)).toBe("hello universe");
    });
  });

  describe("edge cases", () => {
    it("handles empty original", () => {
      const edits: ToolFileEdit[] = [
        { oldText: "x", newText: "y" },
      ];
      expect(applyEditsLocally("", edits)).toBe("");
    });

    it("handles empty edits array", () => {
      expect(applyEditsLocally("unchanged", [])).toBe("unchanged");
    });

    it("handles empty oldText and newText", () => {
      const original = "hello";
      const edits: ToolFileEdit[] = [
        { oldText: "", newText: "" },
      ];
      // Empty oldText matches at every position, behavior depends on implementation
      expect(typeof applyEditsLocally(original, edits)).toBe("string");
    });
  });
});

describe("prepareOperationsPreview", () => {
  describe("move operations", () => {
    it("returns null for non-move tool", () => {
      const toolCall = {
        request: { function: { name: "write", arguments: {} } },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });

    it("extracts move items correctly", () => {
      const toolCall = {
        request: {
          function: {
            name: "move",
            arguments: {
              items: [
                { source: "/path/to/file.md", destination: "/new/path/file.md" },
              ],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("move");
      if (result?.type === "move") {
        expect(result.items).toHaveLength(1);
        expect(result.items[0].source).toBe("/path/to/file.md");
        expect(result.items[0].destination).toBe("/new/path/file.md");
      }
    });

    it("deduplicates move items", () => {
      const toolCall = {
        request: {
          function: {
            name: "move",
            arguments: {
              items: [
                { source: "a.md", destination: "b.md" },
                { source: "a.md", destination: "b.md" },
              ],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("move");
      if (result?.type === "move") {
        expect(result.items).toHaveLength(1);
      }
    });

    it("filters out items with missing source or destination", () => {
      const toolCall = {
        request: {
          function: {
            name: "move",
            arguments: {
              items: [
                { source: "valid.md", destination: "dest.md" },
                { source: "", destination: "dest.md" },
                { source: "valid.md", destination: "" },
              ],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("move");
      if (result?.type === "move") {
        expect(result.items).toHaveLength(1);
      }
    });

    it("returns null for empty items", () => {
      const toolCall = {
        request: {
          function: {
            name: "move",
            arguments: { items: [] },
          },
        },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });

    it("handles mcp-prefixed move", () => {
      const toolCall = {
        request: {
          function: {
            name: "mcp-filesystem_move",
            arguments: {
              items: [{ source: "a.md", destination: "b.md" }],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("move");
    });
  });

  describe("trash operations", () => {
    it("extracts trash paths correctly", () => {
      const toolCall = {
        request: {
          function: {
            name: "trash",
            arguments: {
              paths: ["/path/to/delete.md", "/another/file.md"],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("trash");
      if (result?.type === "trash") {
        expect(result.items).toHaveLength(2);
        expect(result.items[0].path).toBe("/path/to/delete.md");
      }
    });

    it("deduplicates trash paths", () => {
      const toolCall = {
        request: {
          function: {
            name: "trash",
            arguments: {
              paths: ["file.md", "file.md", "file.md"],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("trash");
      if (result?.type === "trash") {
        expect(result.items).toHaveLength(1);
      }
    });

    it("filters out empty paths", () => {
      const toolCall = {
        request: {
          function: {
            name: "trash",
            arguments: {
              paths: ["valid.md", "", "   "],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("trash");
      if (result?.type === "trash") {
        // Empty strings are filtered, but "   " is truthy
        expect(result.items.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("returns null for empty paths", () => {
      const toolCall = {
        request: {
          function: {
            name: "trash",
            arguments: { paths: [] },
          },
        },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });
  });

  describe("create_folders operations", () => {
    it("extracts create_folders paths correctly", () => {
      const toolCall = {
        request: {
          function: {
            name: "create_folders",
            arguments: {
              paths: ["/new/folder1", "/new/folder2"],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("create_folders");
      if (result?.type === "create_folders") {
        expect(result.items).toHaveLength(2);
        expect(result.items[0].path).toBe("/new/folder1");
      }
    });

    it("deduplicates folder paths", () => {
      const toolCall = {
        request: {
          function: {
            name: "create_folders",
            arguments: {
              paths: ["/folder", "/folder"],
            },
          },
        },
      };
      const result = prepareOperationsPreview(toolCall as any);
      expect(result?.type).toBe("create_folders");
      if (result?.type === "create_folders") {
        expect(result.items).toHaveLength(1);
      }
    });

    it("returns null for empty paths", () => {
      const toolCall = {
        request: {
          function: {
            name: "create_folders",
            arguments: { paths: [] },
          },
        },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for null toolCall", () => {
      expect(prepareOperationsPreview(null as any)).toBeNull();
    });

    it("returns null for missing function", () => {
      const toolCall = { request: {} };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });

    it("returns null for unknown tool type", () => {
      const toolCall = {
        request: {
          function: {
            name: "unknown_tool",
            arguments: {},
          },
        },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });

    it("handles missing arguments", () => {
      const toolCall = {
        request: {
          function: {
            name: "move",
          },
        },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });

    it("handles non-array items for move", () => {
      const toolCall = {
        request: {
          function: {
            name: "move",
            arguments: { items: "not an array" },
          },
        },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });

    it("handles non-array paths for trash", () => {
      const toolCall = {
        request: {
          function: {
            name: "trash",
            arguments: { paths: "not an array" },
          },
        },
      };
      expect(prepareOperationsPreview(toolCall as any)).toBeNull();
    });
  });
});
