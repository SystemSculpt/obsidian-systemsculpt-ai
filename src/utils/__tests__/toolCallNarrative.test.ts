/**
 * @jest-environment node
 */

import type { ToolCall } from "../../types/toolCalls";
import {
  buildToolCallNarrative,
  getToolCallStatusText,
} from "../toolCallNarrative";

const createToolCall = (name: string, args: Record<string, unknown>, state: ToolCall["state"] = "executing"): ToolCall =>
  ({
    id: "call-1",
    messageId: "message-1",
    request: {
      id: "call-1",
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    },
    state,
    timestamp: Date.now(),
  }) as ToolCall;

describe("toolCallNarrative", () => {
  test("maps executing tool state to running status", () => {
    expect(getToolCallStatusText("executing")).toBe("Running");
  });

  test("builds move summaries with from-to context", () => {
    const narrative = buildToolCallNarrative(
      createToolCall("mcp-filesystem_move", {
        items: [{ source: "docs/old/a.md", destination: "docs/new/a.md" }],
      })
    );

    expect(narrative.summary.label).toBe("Moving");
    expect(narrative.summary.detail).toBe("old/a.md -> new/a.md");
  });

  test("builds write/edit summaries using layman phrasing", () => {
    const writeNarrative = buildToolCallNarrative(
      createToolCall("mcp-filesystem_write", {
        path: "notes/todo.md",
        content: "hello",
        ifExists: "append",
      })
    );
    expect(writeNarrative.summary.label).toBe("Appending to file");
    expect(writeNarrative.summary.detail).toBe("notes/todo.md");

    const editNarrative = buildToolCallNarrative(
      createToolCall("mcp-filesystem_edit", {
        path: "docs/spec.md",
        edits: [{ oldText: "A", newText: "B" }, { oldText: "C", newText: "D" }],
      })
    );
    expect(editNarrative.summary.label).toBe("Editing file");
    expect(editNarrative.summary.detail).toBe("docs/spec.md (2 change blocks)");
  });
});
