import { normalizePiTools } from "../PiToolAdapter";

describe("PiToolAdapter", () => {
  it("normalizes mixed tool shapes into PI-native definitions", () => {
    const result = normalizePiTools([
      {
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          description: "Read files",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      {
        name: "mcp-filesystem_write",
        description: "Write files",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);

    expect(result).toEqual([
      {
        name: "mcp-filesystem_read",
        description: "Read files",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "mcp-filesystem_write",
        description: "Write files",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("sanitizes provider wrappers while keeping stable MCP tool names", () => {
    const result = normalizePiTools([
      {
        type: "function",
        function: {
          name: "functions.default_api:mcp-filesystem_edit:1_provider",
          description: "Edit file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);

    expect(result).toEqual([
      {
        name: "mcp-filesystem_edit",
        description: "Edit file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("drops invalid tools with missing name or parameters", () => {
    const result = normalizePiTools([
      null,
      {},
      { name: "", parameters: { type: "object" } },
      { name: "mcp-filesystem_read" },
      { type: "function", function: { name: "mcp-filesystem_read", parameters: null } },
    ]);

    expect(result).toEqual([]);
  });
});
