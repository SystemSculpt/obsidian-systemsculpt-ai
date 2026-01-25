/**
 * @jest-environment node
 */
import { toApiBaseMessages } from "../toApiMessages";
import type { ChatMessage } from "../../../types";

describe("toApiBaseMessages", () => {
  it("returns empty array for empty input", () => {
    expect(toApiBaseMessages([])).toEqual([]);
  });

  it("preserves core message properties", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Hello",
        message_id: "msg_1",
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello");
    expect(result[0].message_id).toBe("msg_1");
  });

  it("preserves tool_call_id when present", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "Result data",
        message_id: "msg_2",
        tool_call_id: "call_123",
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].tool_call_id).toBe("call_123");
  });

  it("preserves name when present", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "Result",
        message_id: "msg_3",
        name: "search_tool",
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].name).toBe("search_tool");
  });

  it("preserves tool_calls when present", () => {
    const toolCalls = [
      { id: "call_1", function: { name: "search", arguments: "{}" } },
    ];
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        message_id: "msg_4",
        tool_calls: toolCalls as any,
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].tool_calls).toEqual(toolCalls);
  });

  it("preserves documentContext when present", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Analyze this",
        message_id: "msg_5",
        documentContext: "# Document Content",
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].documentContext).toBe("# Document Content");
  });

  it("preserves systemPromptType when present", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "You are helpful",
        message_id: "msg_6",
        systemPromptType: "custom",
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].systemPromptType).toBe("custom");
  });

  it("preserves systemPromptPath when present", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "You are helpful",
        message_id: "msg_7",
        systemPromptPath: "/prompts/helper.md",
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].systemPromptPath).toBe("/prompts/helper.md");
  });

  it("excludes messageParts", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Response",
        message_id: "msg_8",
        messageParts: [{ type: "text", content: "Response" }],
      } as any,
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0]).not.toHaveProperty("messageParts");
  });

  it("excludes streaming property", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Response",
        message_id: "msg_9",
        streaming: true,
      } as any,
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0]).not.toHaveProperty("streaming");
  });

  it("excludes annotations property", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Response",
        message_id: "msg_10",
        annotations: [{ type: "citation", url: "https://example.com" }],
      } as any,
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0]).not.toHaveProperty("annotations");
  });

  it("handles multiple messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello", message_id: "msg_a" },
      { role: "assistant", content: "Hi there!", message_id: "msg_b" },
      { role: "user", content: "How are you?", message_id: "msg_c" },
    ];

    const result = toApiBaseMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("Hello");
    expect(result[1].content).toBe("Hi there!");
    expect(result[2].content).toBe("How are you?");
  });

  it("handles message with all optional fields", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "Search result",
        message_id: "msg_full",
        tool_call_id: "call_xyz",
        name: "web_search",
        documentContext: "Context here",
        systemPromptType: "agent",
        systemPromptPath: "/agent/search.md",
      },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe("Search result");
    expect(result[0].message_id).toBe("msg_full");
    expect(result[0].tool_call_id).toBe("call_xyz");
    expect(result[0].name).toBe("web_search");
    expect(result[0].documentContext).toBe("Context here");
    expect(result[0].systemPromptType).toBe("agent");
    expect(result[0].systemPromptPath).toBe("/agent/search.md");
  });

  it("does not mutate original messages", () => {
    const original: ChatMessage[] = [
      {
        role: "user",
        content: "Test",
        message_id: "msg_orig",
        streaming: true,
      } as any,
    ];

    const originalCopy = JSON.parse(JSON.stringify(original));
    toApiBaseMessages(original);

    expect(original).toEqual(originalCopy);
  });

  it("handles empty content", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", message_id: "msg_empty" },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].content).toBe("");
  });

  it("handles null/undefined optional fields", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Test",
        message_id: "msg_nulls",
        tool_call_id: undefined,
        name: undefined,
      } as any,
    ];

    const result = toApiBaseMessages(messages);
    // Undefined fields should not be included
    expect(result[0]).not.toHaveProperty("tool_call_id");
    expect(result[0]).not.toHaveProperty("name");
  });

  it("preserves multipart content", () => {
    const content = [
      { type: "text", text: "Describe this" },
      { type: "image_url", image_url: { url: "data:..." } },
    ];
    const messages: ChatMessage[] = [
      { role: "user", content: content as any, message_id: "msg_multi" },
    ];

    const result = toApiBaseMessages(messages);
    expect(result[0].content).toEqual(content);
  });
});
