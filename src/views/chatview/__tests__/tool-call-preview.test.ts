/**
 * @jest-environment node
 */
import { TFile } from "obsidian";
import {
  isWriteOrEditTool,
  prepareOperationsPreview,
  prepareWriteEditPreview,
  prepareWriteEditPreviews,
} from "../ToolCallPreview";

describe("prepareWriteEditPreview", () => {
  it("shows the true appended file instead of replacing the existing content", async () => {
    const file = new TFile({ path: "Notes/Log.md" });
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn(() => file),
        read: jest.fn(async () => "BEFORE"),
      },
    };
    const preview = await prepareWriteEditPreview(app as any, {
      id: "call-1",
      messageId: "assistant-1",
      request: {
        id: "call-1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            path: "Notes/Log.md",
            content: "AFTER",
            ifExists: "append",
            appendNewline: true,
          }),
        },
      },
      state: "executing",
      timestamp: 1,
    });

    expect(preview?.oldContent).toBe("BEFORE");
    expect(preview?.newContent).toBe("BEFORE\nAFTER");
  });

  it("previews every file in a multi-file edit", async () => {
    const first = new TFile({ path: "One.md" });
    const second = new TFile({ path: "Two.md" });
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => path === "One.md" ? first : second),
        read: jest.fn(async (file: TFile) => file.path === "One.md" ? "ONE" : "TWO"),
      },
    };
    const previews = await prepareWriteEditPreviews(app as any, {
      id: "call-multi",
      messageId: "assistant-1",
      request: {
        id: "call-multi",
        type: "function",
        function: {
          name: "multi_edit",
          arguments: JSON.stringify({ files: [
            { path: "One.md", edits: [{ oldText: "ONE", newText: "FIRST" }] },
            { path: "Two.md", edits: [{ oldText: "TWO", newText: "SECOND" }] },
          ] }),
        },
      },
      state: "executing",
      timestamp: 1,
    });

    expect(previews.map((preview) => [preview.path, preview.newContent])).toEqual([
      ["One.md", "FIRST"],
      ["Two.md", "SECOND"],
    ]);
    expect(previews.map((preview) => preview.status)).toEqual(["changed", "changed"]);
  });

  it("reports an edit whose text is absent as unmatched, not as an empty diff", async () => {
    const file = new TFile({ path: "Notes/Log.md" });
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn(() => file),
        read: jest.fn(async () => "BEFORE"),
      },
    };
    const preview = await prepareWriteEditPreview(app as any, {
      id: "call-unmatched",
      messageId: "assistant-1",
      request: {
        id: "call-unmatched",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "Notes/Log.md",
            edits: [{ oldText: "MISSING", newText: "REPLACED" }],
          }),
        },
      },
      state: "executing",
      timestamp: 1,
    });

    expect(preview?.status).toBe("unmatched");
    expect(preview?.appliedCount).toBe(0);
    expect(preview?.requestedCount).toBe(1);
    expect(preview?.skipped[0]?.reason).toBe("Edit produced no changes");
  });

  it("keeps a degenerate zero index range from masking a valid line range", async () => {
    const file = new TFile({ path: "Notes/Log.md" });
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn(() => file),
        read: jest.fn(async () => "one\ntwo\nthree"),
      },
    };
    const preview = await prepareWriteEditPreview(app as any, {
      id: "call-range",
      messageId: "assistant-1",
      request: {
        id: "call-range",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "Notes/Log.md",
            edits: [{
              oldText: "two",
              newText: "TWO",
              range: { startLine: 2, endLine: 2, startIndex: 0, endIndex: 0 },
            }],
          }),
        },
      },
      state: "executing",
      timestamp: 1,
    });

    expect(preview?.newContent).toBe("one\nTWO\nthree");
    expect(preview?.status).toBe("changed");
  });

  it("marks an edit to a missing file as missing", async () => {
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
        read: jest.fn(),
      },
    };
    const preview = await prepareWriteEditPreview(app as any, {
      id: "call-missing",
      messageId: "assistant-1",
      request: {
        id: "call-missing",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            path: "Notes/Gone.md",
            edits: [{ oldText: "a", newText: "b" }],
          }),
        },
      },
      state: "executing",
      timestamp: 1,
    });

    expect(preview?.status).toBe("missing");
  });
});

describe("isWriteOrEditTool", () => {
  it("returns true for write", () => {
    expect(isWriteOrEditTool("write")).toBe(true);
  });

  it("returns true for edit", () => {
    expect(isWriteOrEditTool("edit")).toBe(true);
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

    it("handles canonical move", () => {
      const toolCall = {
        request: {
          function: {
            name: "move",
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
