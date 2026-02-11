/**
 * @jest-environment jsdom
 */

import type { MessagePart } from "../../../types";
import { StreamingController } from "../controllers/StreamingController";

const createController = () => {
  const saveChat = jest.fn().mockResolvedValue(undefined);
  const onAssistantResponse = jest.fn().mockResolvedValue(undefined);
  const onError = jest.fn();

  return {
    controller: new StreamingController({
      toolCallManager: {
        shouldAutoApprove: jest.fn(() => false),
        createToolCall: jest.fn(),
        getToolCall: jest.fn(),
      } as any,
      scrollManager: {
        requestStickToBottom: jest.fn(),
      } as any,
      messageRenderer: {
        renderMessageParts: jest.fn(),
      } as any,
      saveChat,
      generateMessageId: jest.fn(() => "generated-id"),
      extractAnnotations: jest.fn(() => []),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      toggleStopButton: jest.fn(),
      onAssistantResponse,
      onError,
    }),
    saveChat,
    onAssistantResponse,
    onError,
  };
};

describe("StreamingController stream behavior", () => {
  test("continues from seeded parts when streaming again into the same message id", async () => {
    const { controller, onAssistantResponse } = createController();

    const stream = (async function* () {
      yield { type: "content", text: " world" } as any;
    })();

    const seedParts: MessagePart[] = [
      {
        id: "content-1",
        type: "content",
        timestamp: 1,
        data: "Hello",
      },
    ];

    const messageEl = document.createElement("div");
    messageEl.dataset.messageId = "assistant-seeded";

    const abortController = new AbortController();
    const result = await controller.stream(stream, messageEl, "assistant-seeded", abortController.signal, seedParts);

    expect(result.completed).toBe(true);
    expect(result.messageId).toBe("assistant-seeded");
    expect(result.message.content).toBe("Hello world");
    expect(onAssistantResponse).toHaveBeenCalledTimes(1);
  });

  test("captures PI stop reason metadata on the assistant message", async () => {
    const { controller } = createController();
    const stream = (async function* () {
      yield { type: "content", text: "Tool phase done." } as any;
      yield { type: "meta", key: "stop-reason", value: "toolUse" } as any;
    })();

    const messageEl = document.createElement("div");
    messageEl.dataset.messageId = "assistant-stop-reason";

    const abortController = new AbortController();
    const result = await controller.stream(stream, messageEl, "assistant-stop-reason", abortController.signal);

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe("toolUse");
    expect((result.message as any).stopReason).toBe("toolUse");
  });

  test("backfills reasoning_details ids from tool_calls", async () => {
    const saveChat = jest.fn().mockResolvedValue(undefined);
    const onAssistantResponse = jest.fn().mockResolvedValue(undefined);

    const toolCallId = "tool_default_api:mcp-filesystem_read_szyfwOy5FpnrUXatzq4y";
    const toolCall = {
      id: toolCallId,
      messageId: "assistant-tools",
      request: {
        id: toolCallId,
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          arguments: "{\"paths\":[\"a.md\"]}",
        },
      },
      state: "pending",
      timestamp: Date.now(),
    };

    const controller = new StreamingController({
      toolCallManager: {
        shouldAutoApprove: jest.fn(() => false),
        createToolCall: jest.fn(() => toolCall),
        getToolCall: jest.fn(),
      } as any,
      scrollManager: {
        requestStickToBottom: jest.fn(),
      } as any,
      messageRenderer: {
        renderMessageParts: jest.fn(),
      } as any,
      saveChat,
      generateMessageId: jest.fn(() => "generated-id"),
      extractAnnotations: jest.fn(() => []),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      toggleStopButton: jest.fn(),
      onAssistantResponse,
      onError: jest.fn(),
    });

    const stream = (async function* () {
      yield {
        type: "reasoning-details",
        details: [
          {
            data: "EjQKMgFyyNp8SPuiB0PXK2u/TRDihYvTDLkpGxw7hJXN1hytYiIhY+++/WUy+KnnsO2MbRBt",
            format: "google-gemini-v1",
            index: 0,
            type: "reasoning.encrypted",
          },
        ],
      } as any;

      yield {
        type: "tool-call",
        phase: "final",
        call: {
          id: toolCallId,
          index: 0,
          type: "function",
          function: { name: "mcp-filesystem_read", arguments: "{\"paths\":[\"a.md\"]}" },
        },
      } as any;
    })();

    const messageEl = document.createElement("div");
    messageEl.dataset.messageId = "assistant-tools";

    const abortController = new AbortController();
    const result = await controller.stream(stream, messageEl, "assistant-tools", abortController.signal);

    expect(result.completed).toBe(true);
    expect(Array.isArray((result.message as any).reasoning_details)).toBe(true);
    expect((result.message as any).reasoning_details[0].id).toBe(toolCallId);
  });

  test("returns completed=false when aborted", async () => {
    const { controller, saveChat } = createController();

    const stream = (async function* () {
      yield { type: "content", text: "hello" } as any;
    })();

    const messageEl = document.createElement("div");
    messageEl.dataset.messageId = "assistant-abort";

    const abortController = new AbortController();
    abortController.abort();

    const result = await controller.stream(stream, messageEl, "assistant-abort", abortController.signal);

    expect(result.completed).toBe(false);
    expect(saveChat).not.toHaveBeenCalled();
  });

  test("treats abort-during-next-event wait as cancellation (not empty completion)", async () => {
    const { controller, saveChat, onError } = createController();
    const abortController = new AbortController();

    const stream = (async function* () {
      yield { type: "meta", key: "inline-footnote", value: "Retrying…" } as any;
      await new Promise((resolve) => setTimeout(resolve, 5));
    })();

    const messageEl = document.createElement("div");
    messageEl.dataset.messageId = "assistant-abort-after-meta";
    document.body.appendChild(messageEl);

    setTimeout(() => abortController.abort(), 0);
    const result = await controller.stream(
      stream,
      messageEl,
      "assistant-abort-after-meta",
      abortController.signal
    );

    expect(result.completed).toBe(false);
    expect(saveChat).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("does not persist an empty assistant message when stream has no output", async () => {
    const { controller, saveChat, onAssistantResponse, onError } = createController();

    const stream = (async function* () {})();

    const messageEl = document.createElement("div");
    messageEl.dataset.messageId = "assistant-empty";
    document.body.appendChild(messageEl);

    const abortController = new AbortController();
    const result = await controller.stream(stream, messageEl, "assistant-empty", abortController.signal);

    expect(result.completed).toBe(false);
    expect(saveChat).not.toHaveBeenCalled();
    expect(onAssistantResponse).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message || "").toContain("empty completion");
    expect(messageEl.isConnected).toBe(false);
  });
});
