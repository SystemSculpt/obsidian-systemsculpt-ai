/**
 * @jest-environment node
 */
jest.mock("../../mcp-tools/filesystem/MCPFilesystemServer", () => ({
  MCPFilesystemServer: {
    getToolDisplayName: jest.fn(() => ""),
  },
}));

import {
  formatToolDisplayName,
  toTitleCase,
  getFunctionDataFromToolCall,
  getFriendlyArgLabel,
} from "../toolDisplay";

describe("toTitleCase", () => {
  it("capitalizes first letter of each word", () => {
    expect(toTitleCase("hello world")).toBe("Hello World");
  });

  it("handles single word", () => {
    expect(toTitleCase("hello")).toBe("Hello");
  });

  it("handles empty string", () => {
    expect(toTitleCase("")).toBe("");
  });

  it("preserves already capitalized words", () => {
    expect(toTitleCase("Hello World")).toBe("Hello World");
  });

  it("handles mixed case", () => {
    expect(toTitleCase("hELLO wORLD")).toBe("HELLO WORLD");
  });

  it("handles multiple spaces", () => {
    expect(toTitleCase("hello  world")).toBe("Hello  World");
  });

  it("handles underscores and dashes as word boundaries", () => {
    // Note: toTitleCase uses \b word boundary which matches after - and _
    expect(toTitleCase("hello-world")).toBe("Hello-World");
  });
});

describe("formatToolDisplayName", () => {
  it("removes mcp_ prefix and formats", () => {
    const result = formatToolDisplayName("mcp_search");
    expect(result).toBe("Search");
  });

  it("removes mcp- prefix and formats", () => {
    const result = formatToolDisplayName("mcp-search");
    expect(result).toBe("Search");
  });

  it("replaces underscores with spaces", () => {
    const result = formatToolDisplayName("read_file");
    expect(result).toBe("Read File");
  });

  it("replaces dashes with spaces", () => {
    const result = formatToolDisplayName("read-file");
    expect(result).toBe("Read File");
  });

  it("handles filesystem tools with prefix", () => {
    const result = formatToolDisplayName("mcp-filesystem_read");
    // Should format as Filesystem: Read (may have friendly name)
    expect(result).toContain("Filesystem");
  });

  it("falls back to title case for filesystem tools without friendly name", () => {
    const result = formatToolDisplayName("filesystem_custom_tool");
    expect(result).toBe("Filesystem: Custom Tool");
  });

  it("handles empty string", () => {
    const result = formatToolDisplayName("");
    expect(result).toBe("");
  });

  it("handles simple tool name", () => {
    const result = formatToolDisplayName("search");
    expect(result).toBe("Search");
  });

  it("handles complex tool name", () => {
    const result = formatToolDisplayName("create_new_folder_item");
    expect(result).toBe("Create New Folder Item");
  });

  it("returns original value when formatting throws", () => {
    const result = formatToolDisplayName(null as unknown as string);
    expect(result).toBeNull();
  });
});

describe("getFunctionDataFromToolCall", () => {
  it("extracts function data from tool call with object arguments", () => {
    const toolCall = {
      request: {
        function: {
          name: "search",
          arguments: { query: "test" },
        },
      },
    };

    const result = getFunctionDataFromToolCall(toolCall as any);
    expect(result).toEqual({
      name: "search",
      arguments: { query: "test" },
    });
  });

  it("parses string arguments as JSON", () => {
    const toolCall = {
      request: {
        function: {
          name: "search",
          arguments: '{"query":"test"}',
        },
      },
    };

    const result = getFunctionDataFromToolCall(toolCall as any);
    expect(result).toEqual({
      name: "search",
      arguments: { query: "test" },
    });
  });

  it("returns null for missing function", () => {
    const toolCall = { request: {} };
    const result = getFunctionDataFromToolCall(toolCall as any);
    expect(result).toBeNull();
  });

  it("returns null for missing request", () => {
    const toolCall = {};
    const result = getFunctionDataFromToolCall(toolCall as any);
    expect(result).toBeNull();
  });

  it("returns empty object for invalid JSON arguments", () => {
    const toolCall = {
      request: {
        function: {
          name: "search",
          arguments: "not-json",
        },
      },
    };

    const result = getFunctionDataFromToolCall(toolCall as any);
    expect(result).toEqual({
      name: "search",
      arguments: {},
    });
  });

  it("returns empty object for undefined arguments", () => {
    const toolCall = {
      request: {
        function: {
          name: "search",
        },
      },
    };

    const result = getFunctionDataFromToolCall(toolCall as any);
    expect(result).toEqual({
      name: "search",
      arguments: {},
    });
  });
});

describe("getFriendlyArgLabel", () => {
  it("returns friendly label for path", () => {
    expect(getFriendlyArgLabel("path")).toBe("File path");
  });

  it("returns friendly label for paths", () => {
    expect(getFriendlyArgLabel("paths")).toBe("File paths");
  });

  it("returns friendly label for content", () => {
    expect(getFriendlyArgLabel("content")).toBe("File content");
  });

  it("returns friendly label for patterns", () => {
    expect(getFriendlyArgLabel("patterns")).toBe("Search terms");
  });

  it("returns friendly label for searchIn", () => {
    expect(getFriendlyArgLabel("searchIn")).toBe("Where to search");
  });

  it("returns friendly label for maxResults", () => {
    expect(getFriendlyArgLabel("maxResults")).toBe("Max results");
  });

  it("returns title-cased key for unknown arg", () => {
    expect(getFriendlyArgLabel("customArg")).toBe("CustomArg");
  });

  it("replaces underscores in unknown args", () => {
    expect(getFriendlyArgLabel("custom_arg_name")).toBe("Custom Arg Name");
  });

  it("replaces dashes in unknown args", () => {
    expect(getFriendlyArgLabel("custom-arg-name")).toBe("Custom Arg Name");
  });

  it("returns friendly label for edits", () => {
    expect(getFriendlyArgLabel("edits")).toBe("Edits");
  });

  it("returns friendly label for items", () => {
    expect(getFriendlyArgLabel("items")).toBe("Items");
  });

  it("returns friendly label for includeDetails", () => {
    expect(getFriendlyArgLabel("includeDetails")).toBe("Include details");
  });
});
