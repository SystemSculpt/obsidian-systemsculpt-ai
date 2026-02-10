/**
 * @jest-environment jsdom
 */

import { StreamPipeline } from "../StreamPipeline";
import type { StreamEvent, StreamToolCall } from "../types";
import { SystemSculptError } from "../../utils/errors";

const enc = new TextEncoder();

const encode = (payload: string) => enc.encode(payload);
const wrapData = (json: any) => `data: ${JSON.stringify(json)}\n\n`;

describe("StreamPipeline", () => {
  const create = () => new StreamPipeline({ model: "openrouter/test" });

  test("emits content events for text deltas", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ choices: [{ delta: { content: "Hello" } }] }));
    const { events, done } = pipeline.push(chunk);

    expect(done).toBe(false);
    expect(events).toEqual<StreamEvent[]>([
      { type: "content", text: "Hello" },
    ]);
  });

  test("emits content for PI-native text_delta events", () => {
    const pipeline = create();
    const chunk = encode(
      `event: text_delta\ndata: ${JSON.stringify({ type: "text_delta", delta: "Hello from PI", contentIndex: 0 })}\n\n`
    );

    const { events, done } = pipeline.push(chunk);
    expect(done).toBe(false);
    expect(events).toEqual<StreamEvent[]>([{ type: "content", text: "Hello from PI" }]);
  });

  test("emits reasoning for PI-native thinking_delta events", () => {
    const pipeline = create();
    const chunk = encode(
      `event: thinking_delta\ndata: ${JSON.stringify({ type: "thinking_delta", delta: "thinking", contentIndex: 0 })}\n\n`
    );

    const { events, done } = pipeline.push(chunk);
    expect(done).toBe(false);
    expect(events).toEqual<StreamEvent[]>([{ type: "reasoning", text: "thinking" }]);
  });

  test("emits final tool-call for PI-native toolcall_end events", () => {
    const pipeline = create();
    const chunk = encode(
      `event: toolcall_end\ndata: ${JSON.stringify({
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: {
          id: "call_pi_tool_1",
          name: "functions.mcp-filesystem_read",
          arguments: { path: "README.md" },
        },
      })}\n\n`
    );

    const { events, done } = pipeline.push(chunk);
    expect(done).toBe(false);
    expect(events).toEqual<StreamEvent[]>([
      {
        type: "tool-call",
        phase: "final",
        call: expect.objectContaining({
          id: "call_pi_tool_1",
          index: 2,
          function: expect.objectContaining({
            name: "mcp-filesystem_read",
            arguments: "{\"path\":\"README.md\"}",
          }),
        }) as StreamToolCall,
      },
    ]);
  });

  test("does not duplicate content when PI stream emits text_delta then done message", () => {
    const pipeline = create();

    const first = pipeline.push(
      encode(
        `event: text_delta\ndata: ${JSON.stringify({ type: "text_delta", delta: "Hi. What do you need?", contentIndex: 0 })}\n\n`
      )
    );

    const second = pipeline.push(
      encode(
        `event: done\ndata: ${JSON.stringify({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi. What do you need?" }],
          },
        })}\n\n`
      )
    );

    expect(first.events).toEqual<StreamEvent[]>([{ type: "content", text: "Hi. What do you need?" }]);
    expect(second.events).toEqual<StreamEvent[]>([]);
    expect(second.done).toBe(true);
  });

  test("ignores PI marker events so aggregated marker payloads do not duplicate deltas", () => {
    const pipeline = create();

    const markerStart = pipeline.push(
      encode(
        `event: text_start\ndata: ${JSON.stringify({ type: "text_start", contentIndex: 0 })}\n\n`
      )
    );
    const delta = pipeline.push(
      encode(
        `event: text_delta\ndata: ${JSON.stringify({ type: "text_delta", delta: "Hello marker-safe", contentIndex: 0 })}\n\n`
      )
    );
    const markerEnd = pipeline.push(
      encode(
        `event: text_end\ndata: ${JSON.stringify({ type: "text_end", text: "Hello marker-safe", contentIndex: 0 })}\n\n`
      )
    );
    const done = pipeline.push(
      encode(
        `event: done\ndata: ${JSON.stringify({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello marker-safe" }],
          },
        })}\n\n`
      )
    );

    expect(markerStart.events).toEqual<StreamEvent[]>([]);
    expect(delta.events).toEqual<StreamEvent[]>([{ type: "content", text: "Hello marker-safe" }]);
    expect(markerEnd.events).toEqual<StreamEvent[]>([]);
    expect(done.events).toEqual<StreamEvent[]>([]);
    expect(done.done).toBe(true);
  });

  test("preserves PI toolcall_delta argument accumulation into final toolcall_end event", () => {
    const pipeline = create();

    const first = pipeline.push(
      encode(
        `event: toolcall_delta\ndata: ${JSON.stringify({
          type: "toolcall_delta",
          contentIndex: 1,
          toolCall: {
            id: "call_pi_edit_1",
            name: "functions.mcp-filesystem_edit",
            arguments: '{"path":"README.md","ops":[{"op":"replace","text":"hel',
          },
        })}\n\n`
      )
    );

    const second = pipeline.push(
      encode(
        `event: toolcall_delta\ndata: ${JSON.stringify({
          type: "toolcall_delta",
          contentIndex: 1,
          toolCall: {
            id: "call_pi_edit_1",
            arguments: 'lo"}]}',
          },
        })}\n\n`
      )
    );

    const final = pipeline.push(
      encode(
        `event: toolcall_end\ndata: ${JSON.stringify({
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: {
            id: "call_pi_edit_1",
            name: "functions.mcp-filesystem_edit",
          },
        })}\n\n`
      )
    );

    expect(first.events).toEqual<StreamEvent[]>([
      {
        type: "tool-call",
        phase: "delta",
        call: expect.objectContaining({
          id: "call_pi_edit_1",
          index: 1,
          function: expect.objectContaining({
            name: "mcp-filesystem_edit",
            arguments: '{"path":"README.md","ops":[{"op":"replace","text":"hel',
          }),
        }) as StreamToolCall,
      },
    ]);

    expect(second.events).toEqual<StreamEvent[]>([
      {
        type: "tool-call",
        phase: "delta",
        call: expect.objectContaining({
          id: "call_pi_edit_1",
          index: 1,
          function: expect.objectContaining({
            name: "mcp-filesystem_edit",
            arguments: '{"path":"README.md","ops":[{"op":"replace","text":"hello"}]}',
          }),
        }) as StreamToolCall,
      },
    ]);

    expect(final.events).toEqual<StreamEvent[]>([
      {
        type: "tool-call",
        phase: "final",
        call: expect.objectContaining({
          id: "call_pi_edit_1",
          index: 1,
          function: expect.objectContaining({
            name: "mcp-filesystem_edit",
            arguments: '{"path":"README.md","ops":[{"op":"replace","text":"hello"}]}',
          }),
        }) as StreamToolCall,
      },
    ]);
    expect(final.done).toBe(false);
  });

  test("falls back to done.message content when PI stream has no deltas", () => {
    const pipeline = create();
    const chunk = encode(
      `event: done\ndata: ${JSON.stringify({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final-only" }],
        },
      })}\n\n`
    );

    const { events, done } = pipeline.push(chunk);
    expect(done).toBe(true);
    expect(events).toEqual<StreamEvent[]>([{ type: "content", text: "final-only" }]);
  });

  test("splits <think> blocks into reasoning and content", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ choices: [{ delta: { content: "<think>Plan</think>Answer" } }] }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual<StreamEvent[]>([
      { type: "reasoning", text: "Plan" },
      { type: "content", text: "Answer" },
    ]);
  });

  test("emits reasoning-details events", () => {
    const pipeline = create();
    const reasoningDetails = [{ type: "reasoning.text", text: "Let me think.", id: "r1" }];
    const chunk = encode(wrapData({ choices: [{ delta: { reasoning_details: reasoningDetails } }] }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual<StreamEvent[]>([
      { type: "reasoning-details", details: reasoningDetails },
    ]);
  });

  test("aggregates tool call deltas and emits final normalized call", () => {
    const pipeline = create();
    const deltaChunk = encode(wrapData({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_partial00",
                function: {
                  name: "functions.mcp-filesystem_edit:1_foo",
                  arguments: '{"path":"test.md","ops":[{"op":"replace","text":""',
                },
              },
            ],
          },
        },
      ],
    }));

    const finalChunk = encode(wrapData({
      choices: [
        {
          message: {
            tool_calls: [
              {
                index: 0,
                id: "call_partial00",
                function: {
                  name: "functions.mcp-filesystem_edit:1_foo",
                  arguments: "{\"path\":\"test.md\",\"ops\":[{\"op\":\"replace\",\"text\":\"new\"}]}",
                },
              },
            ],
          },
        },
      ],
    }));

    const first = pipeline.push(deltaChunk);
    expect(first.events).toEqual<StreamEvent[]>([
      {
        type: "tool-call",
        phase: "delta",
        call: expect.objectContaining({
          id: "call_partial00",
          index: 0,
          function: expect.objectContaining({ name: "mcp-filesystem_edit", arguments: expect.any(String) }),
        }) as StreamToolCall,
      },
    ]);

    const second = pipeline.push(finalChunk);
    expect(second.events).toEqual<StreamEvent[]>([
      {
        type: "tool-call",
        phase: "final",
        call: expect.objectContaining({
          id: "call_partial00",
          index: 0,
          function: expect.objectContaining({
            name: "mcp-filesystem_edit",
            arguments: "{\"path\":\"test.md\",\"ops\":[{\"op\":\"replace\",\"text\":\"new\"}]}",
          }),
        }) as StreamToolCall,
      },
    ]);
  });

  test("emits meta events for web search flag", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ webSearchEnabled: true }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual<StreamEvent[]>([
      { type: "meta", key: "web-search-enabled", value: true },
    ]);
  });

  test("emits annotations events when citations are included", () => {
    const pipeline = create();
    const annotation = {
      type: "url_citation",
      url_citation: {
        url: "https://example.com/article",
        title: "Example",
        content: "Example snippet",
        start_index: 0,
        end_index: 10,
      },
    };
    const chunk = encode(wrapData({
      choices: [
        {
          message: {
            content: "Here is a sourced answer.",
            annotations: [annotation],
          },
        },
      ],
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual<StreamEvent[]>([
      { type: "content", text: "Here is a sourced answer." },
      { type: "annotations", annotations: [annotation] },
    ]);
  });

  test("ignores SSE comments and blank lines", () => {
    const pipeline = create();
    const chunk = encode(`: OPENROUTER PROCESSING\n\n`);

    const { events, done } = pipeline.push(chunk);
    expect(done).toBe(false);
    expect(events).toEqual([]);
  });

  test("marks done when [DONE] marker encountered", () => {
    const pipeline = create();
    const chunk = encode(`data: [DONE]\n\n`);
    const { done } = pipeline.push(chunk);
    expect(done).toBe(true);
  });

  test("throws SystemSculptError when stream delivers error payload", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      error: { code: "server_error", message: "Provider disconnected" },
      choices: [
        { delta: {}, finish_reason: "error" }
      ]
    }));

    expect(() => pipeline.push(chunk)).toThrow(SystemSculptError);
  });

  test("flush() emits any remaining tool calls", () => {
    const pipeline = create();
    pipeline.push(encode(wrapData({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_flushtest0",
                function: {
                  name: "planner",
                  arguments: "{\"step\":1",
                },
              },
            ],
          },
        },
      ],
    })));

    const remaining = pipeline.flush();
    expect(remaining).toEqual<StreamEvent[]>([
      {
        type: "tool-call",
        phase: "final",
        call: expect.objectContaining({ id: "call_flushtest0", index: 0 }) as StreamToolCall,
      },
    ]);
  });

  test("flush() processes trailing buffer content", () => {
    const pipeline = create();
    // Push a partial chunk without newline - this remains in buffer
    // The buffer needs just the JSON payload (without data: prefix and with newline removal)
    pipeline.push(encode(JSON.stringify({ choices: [{ delta: { content: "trailing" } }] })));

    const events = pipeline.flush();
    expect(events).toContainEqual({ type: "content", text: "trailing" });
  });

  test("flush() returns empty array when no trailing content or tool calls", () => {
    const pipeline = create();
    const events = pipeline.flush();
    expect(events).toEqual([]);
  });

  test("ignores uppercase status messages from providers", () => {
    const pipeline = create();
    // Simulate a provider status message that's not valid JSON
    const chunk = encode(`data: OPENROUTER PROCESSING\n\n`);

    const { events, done } = pipeline.push(chunk);
    expect(done).toBe(false);
    expect(events).toEqual([]);
    expect(pipeline.getDiagnostics().discardedPayloadCount).toBe(0);
  });

  test("tracks discarded non-JSON payloads", () => {
    const pipeline = create();
    const chunk = encode(`data: {bad json}\n\n`);

    const { events } = pipeline.push(chunk);
    const diagnostics = pipeline.getDiagnostics();

    expect(events).toEqual([]);
    expect(diagnostics.discardedPayloadCount).toBe(1);
    expect(diagnostics.discardedPayloadSamples[0]).toContain("{bad json}");
  });

  test("ignores SSE event: lines", () => {
    const pipeline = create();
    const chunk = encode(`event: message\ndata: ${JSON.stringify({ choices: [{ delta: { content: "test" } }] })}\n\n`);

    const { events } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "content", text: "test" });
  });

  test("ignores SSE id: lines", () => {
    const pipeline = create();
    const chunk = encode(`id: 12345\ndata: ${JSON.stringify({ choices: [{ delta: { content: "test" } }] })}\n\n`);

    const { events } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "content", text: "test" });
  });

  test("ignores SSE retry: lines", () => {
    const pipeline = create();
    const chunk = encode(`retry: 5000\ndata: ${JSON.stringify({ choices: [{ delta: { content: "test" } }] })}\n\n`);

    const { events } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "content", text: "test" });
  });

  test("handles done=true in JSON payload", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ done: true, choices: [{ delta: { content: "final" } }] }));

    const { events, done } = pipeline.push(chunk);
    expect(done).toBe(true);
    expect(events).toContainEqual({ type: "content", text: "final" });
  });

  test("handles reasoning chunks from delta", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ choices: [{ delta: { reasoning: "thinking..." } }] }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "reasoning", text: "thinking..." }]);
  });

  test("handles reasoning chunks from message", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ choices: [{ message: { reasoning: "concluded" } }] }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "reasoning", text: "concluded" }]);
  });

  test("handles delta.text field", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ choices: [{ delta: { text: "text field" } }] }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "text field" }]);
  });

  test("handles annotations in delta", () => {
    const pipeline = create();
    const annotation = { type: "citation", url: "https://example.com" };
    const chunk = encode(wrapData({
      choices: [{ delta: { content: "test", annotations: [annotation] } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "annotations", annotations: [annotation] });
  });

  test("handles function_call delta (legacy format)", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        delta: {
          function_call: {
            name: "search",
            arguments: '{"query":"test"}'
          }
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool-call");
    expect((events[0] as any).phase).toBe("delta");
  });

  test("handles function_call final (legacy format)", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        message: {
          function_call: {
            name: "search",
            arguments: '{"query":"test"}'
          }
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool-call");
    expect((events[0] as any).phase).toBe("final");
  });

  test("handles message.content format (non-choices)", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ message: { content: "direct message content" } }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "direct message content" }]);
  });

  test("handles message with annotations (non-choices)", () => {
    const pipeline = create();
    const annotation = { type: "file", path: "/test.md" };
    const chunk = encode(wrapData({
      message: { content: "test", annotations: [annotation] }
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "annotations", annotations: [annotation] });
  });

  test("handles raw text field format", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ text: "raw text field" }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "raw text field" }]);
  });

  test("handles JSON string payloads as content", () => {
    const pipeline = create();
    const chunk = encode(`data: ${JSON.stringify("plain text")}

`);

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "plain text" }]);
  });

  test("normalizes array content values", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: ["part1", "part2"] } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "part1part2" }]);
  });

  test("normalizes object with text property", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: { text: "object text" } } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "object text" }]);
  });

  test("normalizes object with output_text property", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: { output_text: "output text" } } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "output text" }]);
  });

  test("normalizes object with content property (nested)", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: { content: "nested content" } } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "nested content" }]);
  });

  test("normalizes object with value property", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: { value: "value text" } } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "value text" }]);
  });

  test("handles <think> tag spanning multiple chunks", () => {
    const pipeline = create();

    // First chunk opens think tag
    const chunk1 = encode(wrapData({ choices: [{ delta: { content: "before<think>thinking" } }] }));
    const result1 = pipeline.push(chunk1);
    expect(result1.events).toContainEqual({ type: "content", text: "before" });
    expect(result1.events).toContainEqual({ type: "reasoning", text: "thinking" });

    // Second chunk continues inside think
    const chunk2 = encode(wrapData({ choices: [{ delta: { content: " more thinking" } }] }));
    const result2 = pipeline.push(chunk2);
    expect(result2.events).toEqual([{ type: "reasoning", text: " more thinking" }]);

    // Third chunk closes think tag
    const chunk3 = encode(wrapData({ choices: [{ delta: { content: "</think>after" } }] }));
    const result3 = pipeline.push(chunk3);
    expect(result3.events).toContainEqual({ type: "content", text: "after" });
  });

  test("handles think tag without close across flush", () => {
    const pipeline = create();

    pipeline.push(encode(wrapData({ choices: [{ delta: { content: "<think>unclosed" } }] })));
    const events = pipeline.flush();

    // Should emit remaining reasoning
    expect(events).toEqual([]);
  });

  test("handles tool call without index (defaults to 0)", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        delta: {
          tool_calls: [{
            id: "call_noindex",
            function: { name: "test", arguments: "{}" }
          }]
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events[0].type).toBe("tool-call");
    expect((events[0] as any).call.index).toBe(0);
  });

  test("sanitizes tool names with functions. prefix", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        message: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name: "functions.myTool", arguments: "{}" }
          }]
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect((events[0] as any).call.function.name).toBe("myTool");
  });

  test("sanitizes tool names with colon suffix", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        message: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name: "myTool:suffix", arguments: "{}" }
          }]
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect((events[0] as any).call.function.name).toBe("myTool");
  });

  test("preserves OpenRouter namespace-prefixed tool names", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        message: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name: "default_api:mcp-filesystem_read", arguments: "{}" }
          }]
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect((events[0] as any).call.function.name).toBe("mcp-filesystem_read");
  });

  test("normalizes namespace-prefixed PI canonical tool names", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        message: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name: "functions.default_api:read", arguments: "{}" }
          }]
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect((events[0] as any).call.function.name).toBe("read");
  });

  test("normalizes canonical tool names with provider suffix payloads", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        message: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name: "functions.read:1_foo", arguments: "{}" }
          }]
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect((events[0] as any).call.function.name).toBe("read");
  });

  test("handles error without code", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      error: { message: "Generic error" }
    }));

    expect(() => pipeline.push(chunk)).toThrow(SystemSculptError);
  });

  test("handles error without message", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      error: { code: "rate_limit" }
    }));

    expect(() => pipeline.push(chunk)).toThrow(SystemSculptError);
  });

  test("handles carriage return line endings", () => {
    const pipeline = create();
    const chunk = encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "test" } }] })}\r\n\r\n`);

    const { events } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "content", text: "test" });
  });

  test("handles payload without data: prefix", () => {
    const pipeline = create();
    // Some providers send raw JSON without the data: prefix
    const chunk = encode(`${JSON.stringify({ choices: [{ delta: { content: "raw" } }] })}\n\n`);

    const { events } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "content", text: "raw" });
  });

  test("handles multi-line SSE data payloads", () => {
    const pipeline = create();
    const chunk = encode(
      `data: {"choices":[{"delta":{"content":"Hello"}}\n` +
      `data: ]}\n\n`
    );

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "Hello" }]);
  });

  test("handles null parsed payload", () => {
    const pipeline = create();
    const chunk = encode(`data: null\n\n`);

    const { events, done } = pipeline.push(chunk);
    expect(events).toEqual([]);
    expect(done).toBe(false);
  });

  test("handles empty choices array", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ choices: [] }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([]);
  });

  test("handles finish_reason stop", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: "final" }, finish_reason: "stop" }]
    }));

    const { events, done } = pipeline.push(chunk);
    expect(events).toContainEqual({ type: "content", text: "final" });
    // done is only true if also isFinalFlush=true, so it should be false here
    expect(done).toBe(false);
  });

  test("tool call updates rawId on subsequent deltas", () => {
    const pipeline = create();

    // First delta without id
    pipeline.push(encode(wrapData({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: "test", arguments: '{"a":' }
          }]
        }
      }]
    })));

    // Second delta with id
    const { events } = pipeline.push(encode(wrapData({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_updated",
            function: { arguments: '1}' }
          }]
        }
      }]
    })));

    expect(events[0].type).toBe("tool-call");
    // The sanitizeToolCallId preserves safe provider ids
    expect((events[0] as any).call.id).toBe("call_updated");
  });

  test("tool call final updates id from raw", () => {
    const pipeline = create();

    // Delta first
    pipeline.push(encode(wrapData({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_delta",
            function: { name: "test", arguments: '{}' }
          }]
        }
      }]
    })));

    // Final with different id
    const { events } = pipeline.push(encode(wrapData({
      choices: [{
        message: {
          tool_calls: [{
            index: 0,
            id: "call_final",
            function: { name: "test", arguments: '{"final":true}' }
          }]
        }
      }]
    })));

    // The sanitizeToolCallId preserves safe provider ids
    expect((events[0] as any).call.id).toBe("call_final");
  });

  test("handles tool call with name from raw instead of function", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            name: "rawName",
            function: { arguments: '{}' }
          }]
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    expect((events[0] as any).call.function.name).toBe("rawName");
  });

  test("handles function_call with id in raw", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{
        delta: {
          function_call: {
            id: "call_fc",
            name: "search",
            arguments: '{}'
          }
        }
      }]
    }));

    const { events } = pipeline.push(chunk);
    // The sanitizeToolCallId preserves safe provider ids
    expect((events[0] as any).call.id).toBe("call_fc");
  });

  test("webSearchEnabled false is still emitted", () => {
    const pipeline = create();
    const chunk = encode(wrapData({ webSearchEnabled: false }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "meta", key: "web-search-enabled", value: false }]);
  });

  test("handles array of objects with text in content normalization", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: [{ text: "a" }, { text: "b" }] } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "ab" }]);
  });

  test("filters out empty strings from array normalization", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: ["", "text", ""] } }]
    }));

    const { events } = pipeline.push(chunk);
    expect(events).toEqual([{ type: "content", text: "text" }]);
  });

  test("returns null for object without recognized properties", () => {
    const pipeline = create();
    const chunk = encode(wrapData({
      choices: [{ delta: { content: { unknown: "property" } } }]
    }));

    const { events } = pipeline.push(chunk);
    // Should emit nothing since content normalizes to null
    expect(events).toEqual([]);
  });

  test("discards non-JSON non-status payload with debug logging", () => {
    const pipeline = create();
    // A payload that's not valid JSON and not all-caps status
    const chunk = encode(`data: <html>not json</html>\n\n`);

    // Should not throw and should emit nothing
    const { events, done } = pipeline.push(chunk);
    expect(events).toEqual([]);
    expect(done).toBe(false);
  });
});
