import type { MessagePart } from "../../../../types";
import type { ToolCall } from "../../../../types/toolCalls";
import { mergeAdjacentReasoningParts } from "../MessagePartCoalescing";

describe("mergeAdjacentReasoningParts", () => {
  test("merges only consecutive reasoning parts", () => {
    const parts: MessagePart[] = [
      { id: "r-1", type: "reasoning", timestamp: 1, data: "A" },
      { id: "r-2", type: "reasoning", timestamp: 2, data: "B" },
      { id: "c-1", type: "content", timestamp: 3, data: "X" },
      { id: "r-3", type: "reasoning", timestamp: 4, data: "C" },
      { id: "r-4", type: "reasoning", timestamp: 5, data: "D" },
    ];

    const merged = mergeAdjacentReasoningParts(parts);

    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({
      id: "r-1",
      type: "reasoning",
      timestamp: 2,
      data: "AB",
    });
    expect(merged[1].type).toBe("content");
    expect(merged[2]).toEqual({
      id: "r-3",
      type: "reasoning",
      timestamp: 5,
      data: "CD",
    });
  });

  test("does not merge reasoning separated by tool calls", () => {
    const toolCall: ToolCall = {
      id: "call_1",
      messageId: "m1",
      request: {
        id: "call_1",
        type: "function",
        function: { name: "mcp-filesystem_read", arguments: "{}" },
      },
      state: "completed",
      timestamp: 2,
    };

    const parts: MessagePart[] = [
      { id: "r-1", type: "reasoning", timestamp: 1, data: "A" },
      { id: "t-1", type: "tool_call", timestamp: 2, data: toolCall },
      { id: "r-2", type: "reasoning", timestamp: 3, data: "B" },
    ];

    const merged = mergeAdjacentReasoningParts(parts);

    expect(merged).toHaveLength(3);
    expect(merged[0].type).toBe("reasoning");
    expect(merged[1].type).toBe("tool_call");
    expect(merged[2].type).toBe("reasoning");
  });
});

