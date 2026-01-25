import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { ChatStorageService } from "../ChatStorageService";

describe("ChatStorageService.normalizeLegacyToolMessages", () => {
  const createToolCall = (id: string, messageId: string, name: string): ToolCall => ({
    id,
    messageId,
    request: {
      id,
      type: "function",
      function: {
        name,
        arguments: "{}",
      },
    },
    state: "completed",
    timestamp: 100,
    result: {
      success: true,
      data: { ok: true },
    },
    autoApproved: true,
  });

  const service = new ChatStorageService({} as any, "", undefined);

  it("coalesces consecutive assistant messages into one assistant turn", () => {
    const firstToolCall = createToolCall("call_emlistitems0", "msg-1", "mcp-filesystem_list_items");
    const secondToolCall = createToolCall("call_esystemread1", "msg-2", "mcp-filesystem_read");

    const toolMessageA: ChatMessage = {
      role: "assistant",
      content: "",
      message_id: "msg-1",
      tool_calls: [firstToolCall],
      messageParts: [
        {
          id: `tool_call_part-${firstToolCall.id}`,
          type: "tool_call",
          data: firstToolCall,
          timestamp: 0,
        },
      ],
    };

    const toolMessageB: ChatMessage = {
      role: "assistant",
      content: "",
      message_id: "msg-2",
      tool_calls: [secondToolCall],
      messageParts: [
        {
          id: `tool_call_part-${secondToolCall.id}`,
          type: "tool_call",
          data: secondToolCall,
          timestamp: 0,
        },
      ],
    };

    const summaryMessage: ChatMessage = {
      role: "assistant",
      content: "You have 3 bases in your root directory.",
      message_id: "msg-3",
    };

    const normalized = (service as any).normalizeLegacyToolMessages([
      toolMessageA,
      toolMessageB,
      summaryMessage,
    ]) as ChatMessage[];

    expect(normalized).toHaveLength(1);

    const [grouped] = normalized;

    expect(grouped.message_id).toBe("msg-1");
    expect(grouped.tool_calls).toHaveLength(2);
    expect(grouped.tool_calls?.map((call) => call.id)).toEqual([
      "call_emlistitems0",
      "call_esystemread1",
    ]);
    expect(grouped.tool_calls?.every((call) => call.messageId === "msg-1")).toBe(true);
    expect(grouped.content).toBe("You have 3 bases in your root directory.");
    expect(Array.isArray((grouped as any).messageParts)).toBe(true);
  });
});
