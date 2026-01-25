/**
 * @jest-environment jsdom
 */

import { TranscriptAssembler } from "../TranscriptAssembler";
import type { StreamEvent } from "../../../streaming/types";
import type { MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";

describe("TranscriptAssembler", () => {
  const create = () => new TranscriptAssembler();

  const reasoningEvent = (text: string): StreamEvent => ({ type: "reasoning", text });
  const contentEvent = (text: string): StreamEvent => ({ type: "content", text });

  const buildToolCall = (id: string): ToolCall => ({
    id,
    messageId: "assistant-1",
    request: {
      id,
      type: "function",
      function: { name: "planner", arguments: "{}" },
    },
    state: "pending",
    timestamp: Date.now(),
  });

  test("accumulates reasoning immediately without newline dependency", () => {
    const assembler = create();
    assembler.begin();

    assembler.apply(reasoningEvent("**Plan**"));

    const parts = assembler.getParts();
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("reasoning");
    expect(parts[0].data).toBe("**Plan**");
  });

  test("flushes content only when newline encountered or finalize called", () => {
    const assembler = create();
    assembler.begin();

    assembler.apply(contentEvent("Hello"));
    let parts = assembler.getParts();
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject<MessagePart>({ type: "content", data: "Hello" });

    assembler.apply(contentEvent(" world\nHow are you?"));
    parts = assembler.getParts();
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject<MessagePart>({
      type: "content",
      data: "Hello world\n",
    });

    const summary = assembler.finalize();
    expect(summary.content).toBe("Hello world\nHow are you?");
  });

  test("inserts tool call parts in chronological order when attached", () => {
    const assembler = create();
    assembler.begin();

    assembler.apply(reasoningEvent("Plan"));
    assembler.attachToolCall(buildToolCall("call_1"));
    assembler.apply(reasoningEvent("Next"));

    const parts = assembler.getParts();
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "tool_call", "reasoning"]);
    expect((parts[1].data as ToolCall).id).toBe("call_1");
  });

  test("finalize returns accumulated reasoning and content strings", () => {
    const assembler = create();
    assembler.begin();

    assembler.apply(reasoningEvent("Why this works: "));
    assembler.apply(reasoningEvent("step by step"));
    assembler.apply(contentEvent("Answer line 1\n"));
    assembler.apply(contentEvent("Answer line 2"));

    const summary = assembler.finalize();
    expect(summary.reasoning).toBe("Why this works: step by step");
    expect(summary.content).toBe("Answer line 1\nAnswer line 2");
  });
});
