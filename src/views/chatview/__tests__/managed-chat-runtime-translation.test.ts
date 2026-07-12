/** @jest-environment jsdom */

import type { ManagedChatRuntimeEvent } from "../turn/ManagedChatRuntimeAdapter";
import { translateManagedChatEvents } from "../turn/ManagedChatRuntimeAdapter";
import { StreamingController } from "../controllers/StreamingController";

async function* events(values: readonly ManagedChatRuntimeEvent[]): AsyncGenerator<ManagedChatRuntimeEvent> {
  for (const value of values) yield value;
}

function harness() {
  const renderMessageParts = jest.fn();
  const finalizeInlineBlocks = jest.fn();
  const onError = jest.fn();
  const controller = new StreamingController({
    scrollManager: { requestStickToBottom: jest.fn() } as never,
    messageRenderer: { renderMessageParts, finalizeInlineBlocks } as never,
    generateMessageId: () => "assistant-managed",
    extractAnnotations: () => [],
    showStreamingStatus: jest.fn(),
    hideStreamingStatus: jest.fn(),
    updateStreamingStatus: jest.fn(),
    toggleStopButton: jest.fn(),
    onError,
  });
  const messageEl = document.createElement("div");
  const abort = new AbortController();
  const fence = { isOpen: () => true };
  return { controller, messageEl, abort, fence, renderMessageParts, finalizeInlineBlocks, onError };
}

describe("managed Chat event translation through StreamingController", () => {
  it("preserves interleaved reasoning/content, fragmented tools, and normalized finish reason once", async () => {
    const h = harness();
    const translated = translateManagedChatEvents(events([
      { kind: "reasoning_delta", text: "think " },
      { kind: "content_delta", text: "Hello " },
      { kind: "reasoning_delta", text: "again" },
      { kind: "content_delta", text: "world" },
      { kind: "tool_call_delta", index: 0, id: "call_a", name: "search", arguments: "{\"q\":" },
      { kind: "tool_call_delta", index: 0, arguments: "\"alpha\"}" },
      { kind: "tool_call_completed", index: 0, id: "call_a", name: "search", arguments: "{\"q\":\"alpha\"}" },
      { kind: "finish_reason", reason: "tool_calls" },
      { kind: "request_id", requestId: "request-secret-free" },
      { kind: "usage", promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      { kind: "done" },
    ]), h.abort.signal, h.fence);

    const result = await h.controller.stream(translated, h.messageEl, "assistant-managed", h.abort.signal);

    expect(result.completionState).toBe("completed");
    expect(result.message.content).toBe("Hello world");
    expect(result.message.reasoning).toBe("think again");
    expect(result.stopReason).toBe("toolUse");
    expect(result.message.messageParts?.map((part) => part.type)).toEqual([
      "reasoning",
      "content",
      "reasoning",
      "content",
      "tool_call",
    ]);
    expect(result.message.tool_calls).toEqual([
      expect.objectContaining({
        id: "call_a",
        request: expect.objectContaining({
          id: "call_a",
          type: "function",
          function: { name: "search", arguments: "{\"q\":\"alpha\"}" },
        }),
      }),
    ]);
    expect(JSON.stringify(result.message)).not.toContain("request-secret-free");
    expect(h.finalizeInlineBlocks).toHaveBeenCalledTimes(1);
    expect(h.renderMessageParts).toHaveBeenCalled();
  });

  it.each(["stop", "length", "content_filter", "provider_specific"])(
    "preserves the %s finish reason exactly once",
    async (reason) => {
      const abort = new AbortController();
      const translated = translateManagedChatEvents(events([
        { kind: "finish_reason", reason },
        { kind: "done" },
      ]), abort.signal, { isOpen: () => true });
      const collected = [];
      for await (const event of translated) collected.push(event);
      expect(collected).toEqual([{ type: "meta", key: "stop-reason", value: reason }]);
    },
  );

  it("rejects duplicate finish reasons instead of emitting two terminal metadata events", async () => {
    const abort = new AbortController();
    const translated = translateManagedChatEvents(events([
      { kind: "finish_reason", reason: "stop" },
      { kind: "finish_reason", reason: "stop" },
      { kind: "done" },
    ]), abort.signal, { isOpen: () => true });
    await expect((async () => {
      for await (const event of translated) void event;
    })()).rejects.toThrow("more than one finish reason");
  });

  it("keeps multiple fragmented tool identities independent", async () => {
    const h = harness();
    const translated = translateManagedChatEvents(events([
      { kind: "tool_call_delta", index: 0, id: "call_0", name: "read", arguments: "{\"p\":" },
      { kind: "tool_call_delta", index: 1, id: "call_1", name: "write", arguments: "{\"p\":" },
      { kind: "tool_call_delta", index: 0, arguments: "\"a\"}" },
      { kind: "tool_call_delta", index: 1, arguments: "\"b\"}" },
      { kind: "tool_call_completed", index: 0, id: "call_0", name: "read", arguments: "{\"p\":\"a\"}" },
      { kind: "tool_call_completed", index: 1, id: "call_1", name: "write", arguments: "{\"p\":\"b\"}" },
      { kind: "finish_reason", reason: "tool_calls" },
      { kind: "done" },
    ]), h.abort.signal, h.fence);

    const result = await h.controller.stream(translated, h.messageEl, "assistant-managed", h.abort.signal);
    expect(result.message.tool_calls?.map((call) => [call.id, call.request.function.arguments])).toEqual([
      ["call_0", "{\"p\":\"a\"}"],
      ["call_1", "{\"p\":\"b\"}"],
    ]);
  });

  it("treats explicit DONE with no renderable output as a valid empty stream", async () => {
    const h = harness();
    const result = await h.controller.stream(
      translateManagedChatEvents(events([{ kind: "done" }]), h.abort.signal, h.fence),
      h.messageEl,
      "assistant-empty",
      h.abort.signal,
    );
    expect(result.completionState).toBe("no_events");
    expect(result.message.content).toBe("");
  });

  it("stops locally after abort and suppresses later managed events", async () => {
    const h = harness();
    async function* source(): AsyncGenerator<ManagedChatRuntimeEvent> {
      yield { kind: "content_delta", text: "before" };
      h.abort.abort();
      yield { kind: "content_delta", text: "after" };
      yield { kind: "done" };
    }
    const result = await h.controller.stream(
      translateManagedChatEvents(source(), h.abort.signal, h.fence),
      h.messageEl,
      "assistant-abort",
      h.abort.signal,
    );
    expect(result.completionState).toBe("aborted");
    expect(result.message.content).toBe("before");
    expect(JSON.stringify(result.message)).not.toContain("after");
  });

  it("stops promptly when locally aborted while waiting for the next managed event", async () => {
    const h = harness();
    let release!: () => void;
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    async function* source(): AsyncGenerator<ManagedChatRuntimeEvent> {
      markWaiting();
      await new Promise<void>((resolve) => { release = resolve; });
      yield { kind: "content_delta", text: "late" };
    }
    const streaming = h.controller.stream(
      translateManagedChatEvents(source(), h.abort.signal, h.fence),
      h.messageEl,
      "assistant-waiting-abort",
      h.abort.signal,
    );
    await waiting;
    h.abort.abort();
    const result = await streaming;
    release();
    expect(result.completionState).toBe("aborted");
    expect(result.message.content).toBe("");
  });

  it("throws transport failures into the existing controller error path", async () => {
    const h = harness();
    async function* source(): AsyncGenerator<ManagedChatRuntimeEvent> {
      yield { kind: "content_delta", text: "partial" };
      throw new Error("transport broke");
    }
    await expect(h.controller.stream(
      translateManagedChatEvents(source(), h.abort.signal, h.fence),
      h.messageEl,
      "assistant-failure",
      h.abort.signal,
    )).rejects.toThrow("transport broke");
    expect(h.onError).toHaveBeenCalledTimes(1);
  });
});
