/**
 * @jest-environment jsdom
 */

import type { ChatMessage, ChatRole, MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { ChatMarkdownSerializer } from "../storage/ChatMarkdownSerializer";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    parseYaml: jest.fn((yaml: string) => {
      const result: Record<string, string> = {};
      for (const rawLine of yaml.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const match = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
        if (match) {
          result[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
        }
      }
      return result;
    }),
  };
});

const createToolCall = (id: string, timestamp: number, name: string): ToolCall => ({
  id,
  messageId: "assistant-1",
  request: {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify({ query: id }),
    },
  },
  state: "completed",
  timestamp,
});

describe("ChatMarkdownSerializer chronology", () => {
  test("round-trips sequential assistant parts in chronological order", () => {
    const messageParts: MessagePart[] = [
      { id: "reasoning-1", type: "reasoning", timestamp: 1, data: "Plan A" },
      { id: "tool-1", type: "tool_call", timestamp: 2, data: createToolCall("call-1", 2, "web_search") },
      { id: "reasoning-2", type: "reasoning", timestamp: 3, data: "Plan B" },
      { id: "tool-2", type: "tool_call", timestamp: 4, data: createToolCall("call-2", 4, "mcp-filesystem_read") },
      { id: "content-1", type: "content", timestamp: 5, data: "Final answer" },
    ];

    const message: ChatMessage = {
      role: "assistant" as ChatRole,
      content: "Final answer",
      message_id: "assistant-1",
      messageParts,
      tool_calls: [
        messageParts[1].data as ToolCall,
        messageParts[3].data as ToolCall,
      ],
      reasoning: "Plan APlan B",
    };

    const file = [
      "---",
      "id: chronology-test",
      "model: gpt-5.4",
      "title: Chronology Test",
      "created: 2026-03-31T00:00:00.000Z",
      "lastModified: 2026-03-31T00:00:00.000Z",
      "---",
      "",
      ChatMarkdownSerializer.serializeMessages([message]),
    ].join("\n");

    const parsed = ChatMarkdownSerializer.parseMarkdown(file);

    expect(parsed).not.toBeNull();
    expect(parsed?.messages).toHaveLength(1);

    const [roundTripped] = parsed!.messages;
    expect(roundTripped.messageParts?.map((part) => part.type)).toEqual([
      "reasoning",
      "tool_call",
      "reasoning",
      "tool_call",
      "content",
    ]);
    expect(roundTripped.tool_calls?.map((toolCall) => toolCall.id)).toEqual(["call-1", "call-2"]);
    expect(roundTripped.content).toBe("Final answer");
    expect(roundTripped.reasoning).toBe("Plan APlan B");
  });
});
