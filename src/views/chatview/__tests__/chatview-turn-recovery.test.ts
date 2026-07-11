/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";
import { ERROR_CODES, SystemSculptError } from "../../../utils/errors";
import { TOOL_LOOP_ERROR_CODE } from "../../../utils/tooling";
import type { ChatMessage, MessagePart } from "../../../types";

const contentPart = (id: string, text: string, timestamp = 1): MessagePart => ({
  id,
  type: "content",
  timestamp,
  data: text,
});

const createRecoverableView = (messages: ChatMessage[]) => {
  const chatContainer = document.createElement("div");
  const messageRenderer = {
    normalizeMessageToParts: jest.fn((message: ChatMessage) => ({
      parts:
        message.messageParts ||
        (typeof message.content === "string" && message.content.length > 0
          ? [contentPart(`content-${message.message_id}`, message.content)]
          : []),
    })),
    renderUnifiedMessageParts: jest.fn(),
    finalizeInlineBlocks: jest.fn(),
  };

  const view = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
  view.messages = messages;
  view.chatContainer = chatContainer;
  view.messageRenderer = messageRenderer;
  view.inputHandler = {
    isAutomationRequestActive: jest.fn(() => true),
    peekSubmittedInputSnapshot: jest.fn(),
    clearSubmittedInputSnapshot: jest.fn(),
    consumeSubmittedInputSnapshot: jest.fn(),
    setInputText: jest.fn(),
  };
  view.getEffectiveSelectedModelId = jest.fn(() => "systemsculpt@@systemsculpt/ai-agent");
  view.saveChat = jest.fn().mockResolvedValue(undefined);
  view.isPiBackedChat = jest.fn(() => false);
  view.getPiSessionFile = jest.fn(() => undefined);
  view.generateMessageId = jest.fn(() => "assistant-failure");
  view.addMessage = jest.fn().mockResolvedValue(undefined);
  view.chatId = "chat-recovery";
  view.isGenerating = false;
  view.app = {} as any;

  return { view, chatContainer, messageRenderer };
};

describe("ChatView committed turn recovery", () => {
  it("retains the submitted-input snapshot when durable deletion fails and clears it only after retry succeeds", async () => {
    const failed = { role: "user", content: "raw prompt", message_id: "user-failed" } as ChatMessage;
    const { view } = createRecoverableView([failed]);
    const snapshot = { messageId: "user-failed", rawText: "raw prompt" };
    view.inputHandler.peekSubmittedInputSnapshot.mockReturnValue(snapshot);
    const transcript = {
      candidateDeleteMessage: jest.fn(() => ({ operation: "history_delete" })),
      commit: jest.fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce({ chatId: "chat-recovery", version: 2, messages: [] }),
      snapshot: jest.fn(() => ({ chatId: "chat-recovery", version: 2, messages: [] })),
    };
    view.chatTranscript = transcript;
    view.projectTranscript = jest.fn(() => { view.messages = []; });

    await expect(view.removeFailedSubmissionTurn()).rejects.toThrow("disk full");
    expect(view.inputHandler.clearSubmittedInputSnapshot).not.toHaveBeenCalled();
    expect(view.inputHandler.setInputText).not.toHaveBeenCalled();
    expect(view.messages).toEqual([failed]);

    await expect(view.removeFailedSubmissionTurn()).resolves.toBe(true);
    expect(view.inputHandler.clearSubmittedInputSnapshot).toHaveBeenCalledWith("user-failed");
    expect(view.inputHandler.setInputText).toHaveBeenCalledWith("raw prompt");
    expect(transcript.commit).toHaveBeenCalledTimes(2);
  });

  it("keeps submitted user and completed tool rows when post-tool continuation fails", async () => {
    const completedToolCall = {
      id: "call_1",
      messageId: "assistant-1",
      request: {
        id: "call_1",
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          arguments: "{\"paths\":[\"alpha.md\"]}",
        },
      },
      state: "completed",
      timestamp: 2,
      executionStartedAt: 2,
      executionCompletedAt: 3,
      result: {
        success: true,
        data: { contents: ["alpha"] },
      },
    } as any;

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Read alpha.md and explain it.",
        message_id: "user-1",
      } as any,
      {
        role: "assistant",
        content: "",
        message_id: "assistant-1",
        tool_calls: [completedToolCall],
        messageParts: [
          {
            id: "tool-call-1",
            type: "tool_call",
            timestamp: 2,
            data: completedToolCall,
          },
        ],
      } as any,
    ];

    const { view, chatContainer, messageRenderer } = createRecoverableView(messages);
    const assistantEl = document.createElement("div");
    assistantEl.classList.add("systemsculpt-message");
    assistantEl.dataset.messageId = "assistant-1";
    assistantEl.appendChild(document.createElement("div")).classList.add("systemsculpt-message-content");
    chatContainer.appendChild(assistantEl);

    await ChatView.prototype.handleError.call(
      view,
      new SystemSculptError(
        "The hosted agent returned an empty continuation after tool execution.",
        ERROR_CODES.STREAM_ERROR,
        502,
        {
          errorCode: TOOL_LOOP_ERROR_CODE,
          recoverCommittedTurn: true,
          reason: "empty-continuation",
          assistantMessageId: "assistant-empty",
          committedAssistantMessageId: "assistant-1",
          committedPhase: "tool_execution_committed",
          completedToolCount: 1,
        }
      )
    );

    expect(view.inputHandler.consumeSubmittedInputSnapshot).not.toHaveBeenCalled();
    expect(view.messages).toHaveLength(2);
    expect(view.messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: "Read alpha.md and explain it.",
      })
    );
    expect(view.messages[1].tool_calls?.[0]).toEqual(
      expect.objectContaining({
        id: "call_1",
        state: "completed",
        result: expect.objectContaining({ success: true }),
      })
    );
    expect(view.messages[1].content).toContain("SystemSculpt stopped after the turn was already in progress");
    expect(view.messages[1].messageParts?.some((part) =>
      part.type === "content" &&
      typeof part.data === "string" &&
      part.data.includes("completed tool result was kept")
    )).toBe(true);
    expect(view.saveChat).toHaveBeenCalledTimes(1);
    expect(messageRenderer.renderUnifiedMessageParts).toHaveBeenCalledTimes(1);
  });

  it("keeps the user turn and replaces an unpersisted empty assistant draft with a visible failure marker", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Find the document and write the handoff.",
        message_id: "user-1",
      } as any,
    ];

    const { view, chatContainer } = createRecoverableView(messages);
    const emptyAssistantEl = document.createElement("div");
    emptyAssistantEl.classList.add("systemsculpt-message");
    emptyAssistantEl.dataset.messageId = "assistant-empty";
    chatContainer.appendChild(emptyAssistantEl);

    await ChatView.prototype.handleError.call(
      view,
      new SystemSculptError(
        "The hosted agent returned an empty response.",
        ERROR_CODES.STREAM_ERROR,
        502,
        {
          errorCode: TOOL_LOOP_ERROR_CODE,
          recoverCommittedTurn: true,
          reason: "empty-response",
          assistantMessageId: "assistant-empty",
          committedPhase: "submitted_user",
          completedToolCount: 0,
        }
      )
    );

    expect(emptyAssistantEl.isConnected).toBe(false);
    expect(view.inputHandler.consumeSubmittedInputSnapshot).not.toHaveBeenCalled();
    expect(view.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Find the document and write the handoff.",
      }),
      expect.objectContaining({
        role: "assistant",
        message_id: "assistant-failure",
        content: expect.stringContaining("SystemSculpt stopped after the turn was already in progress"),
      }),
    ]);
    expect(view.addMessage).toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("SystemSculpt stopped after the turn was already in progress"),
      "assistant-failure",
      expect.objectContaining({ message_id: "assistant-failure" })
    );
    expect(view.saveChat).toHaveBeenCalledTimes(1);
  });
});
