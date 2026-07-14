/**
 * @jest-environment node
 */

import { toolDefinitions } from "../toolDefinitions";

const EXPECTED_TOOL_NAMES = [
  "context",
  "create_folders",
  "edit",
  "find",
  "list_items",
  "move",
  "multi_edit",
  "open",
  "read",
  "search",
  "trash",
  "write",
];

describe("Filesystem tool definitions", () => {
  test("expose only the supported tool names", () => {
    const exportedNames = toolDefinitions.map((tool) => tool.name).sort();
    expect(exportedNames).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  test("exposes canonical multi-edit, search paging, and list paging inputs", () => {
    const multiEdit = toolDefinitions.find((tool) => tool.name === "multi_edit")!;
    expect(multiEdit.inputSchema.properties.files.maxItems).toBe(20);

    const search = toolDefinitions.find((tool) => tool.name === "search")!;
    expect(search.inputSchema.properties.patternMode.default).toBe("literal");
    expect(search.inputSchema.properties.cursor.type).toBe("string");

    const list = toolDefinitions.find((tool) => tool.name === "list_items")!;
    expect(list.inputSchema.properties.offset.type).toBe("number");
    expect(list.inputSchema.properties.limit.maximum).toBe(50);
  });
});
