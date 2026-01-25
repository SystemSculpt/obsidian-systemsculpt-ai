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
});
