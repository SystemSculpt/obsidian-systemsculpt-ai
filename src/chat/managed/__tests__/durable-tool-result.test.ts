import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { MAX_BATCH_OPERATIONS } from "../../../tools/vault/constants";
import {
  DURABLE_TOOL_LIST_LIMIT,
  DURABLE_TOOL_TEXT_LIMIT,
  durableToolResult,
  withDurableToolResults,
} from "../DurableToolResult";

const marker = (omitted: number) => `… [${omitted} more characters]`;

describe("durableToolResult", () => {
  it("keeps what history presents and cuts long text such as note content", () => {
    const content = "a".repeat(20_000);
    const result = {
      success: true,
      data: {
        summary: "Read 1 file",
        files: [{ path: "Projects/Plan.md", content, success: true }],
      },
    };
    const bounded = durableToolResult(result);
    const file = (bounded.data as { files: Array<Record<string, unknown>> }).files[0];
    expect(bounded.success).toBe(true);
    expect((bounded.data as { summary: string }).summary).toBe("Read 1 file");
    expect(file.path).toBe("Projects/Plan.md");
    expect(file.success).toBe(true);
    // The marker counts toward the limit.
    const kept = DURABLE_TOOL_TEXT_LIMIT - marker(20_000).length;
    expect(file.content).toBe(`${"a".repeat(kept)}${marker(20_000 - kept)}`);
    expect(file.content).toHaveLength(DURABLE_TOOL_TEXT_LIMIT);
    expect(JSON.stringify(bounded).length).toBeLessThan(1_000);
    // The live result is never modified.
    expect(result.data.files[0].content).toBe(content);
  });

  it("keeps long artifact paths whole so a reopened chat still links to the file", () => {
    const deep = `${"Archive/".repeat(80)}Plan.md`;
    const moved = `${"Moved/".repeat(100)}Plan.md`;
    const result = {
      success: true,
      data: {
        results: [{ path: deep, destination: moved, note: "b".repeat(2_000), success: true }],
        opened: [deep],
      },
    };
    const bounded = durableToolResult(result);
    const data = bounded.data as { results: Array<Record<string, unknown>>; opened: string[] };
    expect(deep.length).toBeGreaterThan(DURABLE_TOOL_TEXT_LIMIT);
    expect(data.results[0].path).toBe(deep);
    expect(data.results[0].destination).toBe(moved);
    expect(data.opened).toEqual([deep]);
    expect(data.results[0].note).toHaveLength(DURABLE_TOOL_TEXT_LIMIT);
    expect(durableToolResult(bounded)).toEqual(bounded);
  });

  it("keeps the head of long lists, bounds depth, and bounds errors", () => {
    const matches = Array.from({ length: 500 }, (_, index) => ({ path: `Note ${index}.md` }));
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    const bounded = durableToolResult({
      success: false,
      data: { matches, nested },
      error: {
        code: "TOOL_PARTIAL_FAILURE",
        message: "x".repeat(2_000),
        details: { reasons: ["y".repeat(2_000)] },
      },
    });
    const data = bounded.data as { matches: unknown[]; nested: unknown };
    expect(data.matches).toHaveLength(DURABLE_TOOL_LIST_LIMIT);
    expect(data.matches[0]).toEqual({ path: "Note 0.md" });
    expect(JSON.stringify(data.nested)).toContain("[omitted]");
    expect(bounded.error?.code).toBe("TOOL_PARTIAL_FAILURE");
    expect(bounded.error?.message).toHaveLength(DURABLE_TOOL_TEXT_LIMIT);
    expect(JSON.stringify(bounded.error?.details).length).toBeLessThan(700);
  });

  it("keeps every item outcome of the largest batch, so history counts a partial failure correctly", () => {
    expect(DURABLE_TOOL_LIST_LIMIT).toBe(2 * MAX_BATCH_OPERATIONS);
    const results = Array.from({ length: MAX_BATCH_OPERATIONS }, (_, index) => index < 95
      ? { path: `Inbox/${index}.md`, success: true }
      : { path: `Inbox/${index}.md`, success: false, error: "Target exists" });
    const bounded = durableToolResult({ success: false, data: { results } });
    const kept = (bounded.data as { results: Array<{ success: boolean }> }).results;
    expect(kept).toHaveLength(MAX_BATCH_OPERATIONS);
    expect(kept.filter((entry) => !entry.success)).toHaveLength(5);
  });

  it("never splits a surrogate pair and leaves short values untouched", () => {
    const emoji = "\u{1F600}";
    // The cut would fall between the two halves of the emoji.
    const head = DURABLE_TOOL_TEXT_LIMIT - marker(600).length - 1;
    const text = `${"b".repeat(head)}${emoji}${"t".repeat(600 - head - emoji.length)}`;
    expect(text).toHaveLength(600);
    const bounded = durableToolResult({ success: true, data: text });
    expect(bounded.data).toBe(`${"b".repeat(head)}${marker(600 - head)}`);
    expect(durableToolResult({ success: true, data: { count: 3, ok: null } }))
      .toEqual({ success: true, data: { count: 3, ok: null } });
    expect(durableToolResult({ success: true })).toEqual({ success: true });
  });

  it("bounds a bounded result to itself, so a saved result matches the server's copy", () => {
    let nested: Record<string, unknown> = { leaf: "z".repeat(900) };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    const once = durableToolResult({
      success: false,
      data: {
        files: [{ path: "Plan.md", content: "c".repeat(123_456) }],
        matches: Array.from({ length: 500 }, (_, index) => ({ path: `Note ${index}.md` })),
        nested,
      },
      error: { code: "TOOL_PARTIAL_FAILURE", message: "m".repeat(3_000), details: ["d".repeat(900)] },
    });
    expect(durableToolResult(once)).toEqual(once);
  });
});

describe("withDurableToolResults", () => {
  it("bounds each tool result once and keeps a call shared by tool_calls and its part", () => {
    const call: ToolCall = {
      id: "call-read",
      messageId: "assistant-1",
      request: { id: "call-read", type: "function", function: { name: "read", arguments: "{}" } },
      state: "completed",
      timestamp: 1,
      result: { success: true, data: { files: [{ path: "Plan.md", content: "p".repeat(5_000) }] } },
    };
    const message: ChatMessage = {
      role: "assistant",
      message_id: "assistant-1",
      content: "Done.",
      tool_calls: [call],
      messageParts: [
        { id: "tool", type: "tool_call", timestamp: 1, data: call },
        { id: "text", type: "content", timestamp: 2, data: "Done." },
      ],
    };

    const durable = withDurableToolResults(message);

    const bounded = durable.tool_calls![0];
    expect(bounded.result).toEqual(durableToolResult(call.result!));
    expect(durable.messageParts![0].data).toBe(bounded);
    expect(durable.messageParts![1]).toBe(message.messageParts![1]);
    // The loaded message is not modified.
    expect(call.result!.data).toEqual({ files: [{ path: "Plan.md", content: "p".repeat(5_000) }] });
    const plain: ChatMessage = { role: "user", message_id: "user-1", content: "Hi" };
    expect(withDurableToolResults(plain)).toBe(plain);
  });
});
