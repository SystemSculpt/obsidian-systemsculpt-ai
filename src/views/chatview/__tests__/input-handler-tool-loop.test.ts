/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import type { ChatMessage } from "../../../types";
import { InputHandler } from "../InputHandler";
import { messageHandling } from "../messageHandling";

jest.mock("../../../services/RecorderService", () => ({
  RecorderService: {
    getInstance: jest.fn(() => ({
      onToggle: jest.fn(() => () => {}),
      toggleRecording: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

jest.mock("../SlashCommandMenu", () => ({
  SlashCommandMenu: jest.fn().mockImplementation(() => ({
    unload: jest.fn(),
  })),
}));

jest.mock("../../../components/AtMentionMenu", () => ({
  AtMentionMenu: jest.fn().mockImplementation(() => ({
    unload: jest.fn(),
  })),
}));

jest.mock("../ui/createInputUI", () => ({
  createChatComposer: jest.fn((container: HTMLElement) => {
    const inputWrap = document.createElement("div");
    const input = document.createElement("textarea");
    const attachments = document.createElement("div");
    inputWrap.appendChild(input);
    container.appendChild(inputWrap);
    container.appendChild(attachments);

    const makeButton = () => ({
      buttonEl: document.createElement("button"),
      setDisabled: jest.fn(),
      setTooltip: jest.fn(),
    });

    return {
      input,
      inputWrap,
      attachments,
      micButton: makeButton(),
      sendButton: makeButton(),
      stopButton: makeButton(),
      settingsButton: makeButton(),
      attachButton: makeButton(),
    };
  }),
}));

jest.mock("../../../core/ui/", () => ({
  showPopup: jest.fn().mockResolvedValue({ confirmed: true, action: "primary" }),
}));

jest.mock("../messageHandling", () => ({
  messageHandling: {
    addMessage: jest.fn().mockResolvedValue(undefined),
  },
}));

describe("InputHandler hosted tool loop", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("executes hosted tool calls locally and continues the turn after toolUse", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const messages: ChatMessage[] = [];
    const aiService = {
      streamMessage: jest.fn(),
      executeHostedToolCall: jest.fn().mockResolvedValue({
        success: true,
        data: { contents: ["alpha", "beta"] },
      }),
    } as any;

    const plugin = {
      app,
      settings: {
        licenseKey: "license",
        licenseValid: true,
        autoSubmitAfterTranscription: false,
      },
    } as any;

    const onMessageSubmit = jest.fn(async (message: ChatMessage) => {
      messages.push(message);
    });
    const onAssistantResponse = jest.fn(async (message: ChatMessage) => {
      const index = messages.findIndex((entry) => entry.message_id === message.message_id);
      if (index === -1) {
        messages.push(message);
      } else {
        messages[index] = message;
      }
    });

    const chatView = {
      contextManager: {
        getContextFiles: jest.fn(() => new Set<string>()),
        validateAndCleanContextFiles: jest.fn().mockResolvedValue(undefined),
      },
      getDebugLogService: jest.fn(() => ({
        createStreamLogger: jest.fn(() => undefined),
      })),
      refreshCreditsBalance: jest.fn(),
      isLegacyReadOnlyChat: jest.fn(() => false),
      isPiBackedChat: jest.fn(() => false),
      getPiSessionFile: jest.fn(() => undefined),
      getPiSessionId: jest.fn(() => undefined),
      getSelectedModelId: jest.fn(() => "systemsculpt@@systemsculpt/ai-agent"),
      saveChat: jest.fn().mockResolvedValue(undefined),
      isFullyLoaded: true,
    } as any;

    const handler = new InputHandler({
      app,
      container,
      aiService,
      getMessages: () => messages,
      getContextFiles: () => new Set<string>(),
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn((message: ChatMessage) => ({
          parts: message.messageParts || [],
        })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit,
      onAssistantResponse,
      onContextFileAdd: jest.fn(),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      addMessageToHistory: jest.fn().mockResolvedValue(undefined),
      chatStorage: {},
      getChatId: jest.fn(() => "chat-1"),
      chatView,
    });

    const firstAssistantMessage: ChatMessage = {
      role: "assistant",
      content: "",
      message_id: "assistant-1",
      tool_calls: [
        {
          id: "call_1",
          messageId: "assistant-1",
          request: {
            id: "call_1",
            type: "function",
            function: {
              name: "mcp-filesystem_read",
              arguments: "{\"paths\":[\"alpha.md\",\"beta.md\"]}",
            },
          },
          state: "executing",
          timestamp: 1,
          executionStartedAt: 1,
        },
      ],
      messageParts: [],
    } as any;

    const finalAssistantMessage: ChatMessage = {
      role: "assistant",
      content: "Done with the file work.",
      message_id: "assistant-2",
    } as any;

    const streamAssistantTurn = jest.spyOn(handler as any, "streamAssistantTurn");
    streamAssistantTurn
      .mockResolvedValueOnce({
        messageId: "assistant-1",
        message: firstAssistantMessage,
        messageEl: document.createElement("div"),
        completed: true,
        stopReason: "toolUse",
      })
      .mockImplementationOnce(async () => {
        await (handler as any).onAssistantResponse(finalAssistantMessage);
        return {
          messageId: "assistant-2",
          message: finalAssistantMessage,
          messageEl: document.createElement("div"),
          completed: true,
        };
      });

    handler.setValue("Use tools for real.");
    await handler.submitWithOverrides({ includeContextFiles: false });

    expect(streamAssistantTurn).toHaveBeenCalledTimes(2);
    expect(aiService.executeHostedToolCall).toHaveBeenCalledTimes(1);
    expect(aiService.executeHostedToolCall).toHaveBeenCalledWith({
      toolCall: expect.objectContaining({
        id: "call_1",
      }),
      chatView,
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Use tools for real." }),
        expect.objectContaining({
          message_id: "assistant-1",
          tool_calls: [
            expect.objectContaining({
              id: "call_1",
              state: "completed",
              result: expect.objectContaining({ success: true }),
            }),
          ],
        }),
        expect.objectContaining({
          message_id: "assistant-2",
          content: "Done with the file work.",
        }),
      ])
    );
    expect(messageHandling.addMessage).toHaveBeenCalled();
    expect(chatView.refreshCreditsBalance).toHaveBeenCalledTimes(1);
  });
});
