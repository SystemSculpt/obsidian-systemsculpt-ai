/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import type { ChatMessage } from "../../../types";
import { InputHandler } from "../InputHandler";
import { messageHandling } from "../messageHandling";
import { assertPiTextExecutionReady } from "../../../services/pi-native/PiTextRuntime";
import {
  buildPiTextProviderSetupMessage,
  hasPiTextProviderAuth,
} from "../../../services/pi-native/PiTextAuth";

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

jest.mock("../../../services/pi-native/PiTextRuntime", () => ({
  assertPiTextExecutionReady: jest.fn(),
}));

jest.mock("../../../services/pi-native/PiTextAuth", () => ({
  buildPiTextProviderSetupMessage: jest.fn((providerId: string, actualModelId?: string) =>
    actualModelId
      ? `Connect ${providerId} in Pi before running "${actualModelId}".`
      : `Connect ${providerId} in Pi before using this model.`
  ),
  hasPiTextProviderAuth: jest.fn(async () => true),
  loadPiTextProviderAuth: jest.fn(async () => new Map()),
  piTextProviderRequiresAuth: jest.fn(() => true),
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
      modelService: {
        getModels: jest.fn(async () => []),
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
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
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

  it("streams using the chat's selected model instead of forcing managed SystemSculpt", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const aiService = {
      streamMessage: jest.fn(() => ({}) as any),
    } as any;

    const plugin = {
      app,
      settings: {
        licenseKey: "license",
        licenseValid: true,
        autoSubmitAfterTranscription: false,
      },
      modelService: {
        getModels: jest.fn(async () => []),
      },
    } as any;

    const chatView = {
      contextManager: {
        getContextFiles: jest.fn(() => new Set<string>()),
      },
      getDebugLogService: jest.fn(() => ({
        createStreamLogger: jest.fn(() => undefined),
      })),
      getPiSessionFile: jest.fn(() => undefined),
      getPiSessionId: jest.fn(() => undefined),
      getSelectedModelId: jest.fn(() => "local-pi-openai@@gpt-4.1"),
      setPiSessionState: jest.fn(),
    } as any;

    const handler = new InputHandler({
      app,
      container,
      aiService,
      getMessages: () => [],
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit: jest.fn().mockResolvedValue(undefined),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-1"),
      chatView,
    });

    jest.spyOn(handler as any, "createAssistantMessageContainer").mockReturnValue({
      messageEl: document.createElement("div"),
    });
    jest.spyOn((handler as any).streamingController, "stream").mockResolvedValue({
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: "Done",
        message_id: "assistant-1",
      },
      messageEl: document.createElement("div"),
      completed: true,
    });

    await (handler as any).streamAssistantTurn(new AbortController().signal, false);

    expect(aiService.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "local-pi-openai@@gpt-4.1",
      })
    );
  });

  it("routes local Pi setup failures to Providers instead of forcing managed fallback", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const plugin = {
      app,
      settings: {
        licenseKey: "",
        licenseValid: false,
        autoSubmitAfterTranscription: false,
      },
      modelService: {
        getModels: jest.fn(async () => []),
      },
    } as any;

    const localModel = {
      id: "local-pi-openai@@gpt-4.1",
      name: "gpt-4.1",
      provider: "openai",
      sourceMode: "pi_local",
      sourceProviderId: "openai",
      piExecutionModelId: "openai/gpt-4.1",
      piLocalAvailable: true,
      context_length: 1000000,
      capabilities: ["chat"],
      architecture: { modality: "text->text" },
      pricing: { prompt: "0", completion: "0", image: "0", request: "0" },
    };

    const chatView = {
      getSelectedModelId: jest.fn(() => "local-pi-openai@@gpt-4.1"),
      getSelectedModelRecord: jest.fn(async () => localModel),
      promptProviderSetup: jest.fn().mockResolvedValue(undefined),
    } as any;

    const handler = new InputHandler({
      app,
      container,
      aiService: {
        streamMessage: jest.fn(),
      } as any,
      getMessages: () => [],
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit: jest.fn().mockResolvedValue(undefined),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-1"),
      chatView,
    });

    (assertPiTextExecutionReady as jest.Mock).mockResolvedValue({
      mode: "local",
      actualModelId: "openai/gpt-4.1",
      providerId: "openai",
      authMode: "local",
    });
    (hasPiTextProviderAuth as jest.Mock).mockResolvedValue(false);
    (buildPiTextProviderSetupMessage as jest.Mock).mockReturnValue(
      'Connect OpenAI in Pi before running "openai/gpt-4.1".'
    );

    await expect((handler as any).ensureProviderReadyForChat()).resolves.toBe(false);
    expect(chatView.promptProviderSetup).toHaveBeenCalledWith(
      'Connect OpenAI in Pi before running "openai/gpt-4.1".',
      expect.objectContaining({
        targetTab: "providers",
        primaryButton: "Open Providers",
      })
    );
  });

  it("fails fast instead of opening setup UI during automation", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const chatView = {
      promptProviderSetup: jest.fn().mockResolvedValue(undefined),
    } as any;

    const handler = new InputHandler({
      app,
      container,
      aiService: {
        streamMessage: jest.fn(),
      } as any,
      getMessages: () => [],
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit: jest.fn().mockResolvedValue(undefined),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin: {
        app,
        settings: {
          licenseKey: "",
          licenseValid: false,
          autoSubmitAfterTranscription: false,
        },
        modelService: {
          getModels: jest.fn(async () => []),
        },
      } as any,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-1"),
      chatView,
    });

    (handler as any).automationRequestDepth = 1;

    await expect(
      (handler as any).invokeProviderSetupPrompt("Automation setup failure.", {
        targetTab: "providers",
      })
    ).rejects.toThrow("Automation setup failure.");

    expect(chatView.promptProviderSetup).not.toHaveBeenCalled();
  });

  it("auto-approves destructive hosted tool calls during automation when configured", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const handler = new InputHandler({
      app,
      container,
      aiService: { streamMessage: jest.fn() } as any,
      getMessages: () => [],
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit: jest.fn().mockResolvedValue(undefined),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin: {
        app,
        settings: {
          licenseKey: "license",
          licenseValid: true,
          autoSubmitAfterTranscription: false,
        },
        modelService: {
          getModels: jest.fn(async () => []),
        },
      } as any,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-approval-auto"),
      chatView: {},
    });

    (handler as any).setAutomationApprovalMode("auto-approve");

    await expect(
      (handler as any).confirmHostedToolExecution({
        request: {
          function: {
            name: "mcp-filesystem_write",
            arguments: "{\"path\":\"SystemSculpt/test.md\"}",
          },
        },
      })
    ).resolves.toBe(true);
  });

  it("denies destructive hosted tool calls during automation when configured", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const handler = new InputHandler({
      app,
      container,
      aiService: { streamMessage: jest.fn() } as any,
      getMessages: () => [],
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit: jest.fn().mockResolvedValue(undefined),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin: {
        app,
        settings: {
          licenseKey: "license",
          licenseValid: true,
          autoSubmitAfterTranscription: false,
        },
        modelService: {
          getModels: jest.fn(async () => []),
        },
      } as any,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-approval-deny"),
      chatView: {},
    });

    (handler as any).setAutomationApprovalMode("deny");

    await expect(
      (handler as any).confirmHostedToolExecution({
        request: {
          function: {
            name: "mcp-filesystem_write",
            arguments: "{\"path\":\"SystemSculpt/test.md\"}",
          },
        },
      })
    ).resolves.toBe(false);
  });

  it("cleans local UI artifacts when the handler unloads", () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const plugin = {
      app,
      settings: {
        licenseKey: "license",
        licenseValid: true,
        autoSubmitAfterTranscription: false,
      },
      modelService: {
        getModels: jest.fn(async () => []),
      },
    } as any;

    const handler = new InputHandler({
      app,
      container,
      aiService: { streamMessage: jest.fn() } as any,
      getMessages: () => [],
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit: jest.fn().mockResolvedValue(undefined),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-unload"),
      chatView: {},
    });

    const streamingStatus = document.createElement("div");
    streamingStatus.className = "systemsculpt-streaming-status";
    chatContainer.appendChild(streamingStatus);

    const recorderVisualizer = document.createElement("div");
    container.appendChild(recorderVisualizer);
    const recorderToggleUnsubscribe = jest.fn();

    (handler as any).recorderVisualizer = recorderVisualizer;
    (handler as any).recorderToggleUnsubscribe = recorderToggleUnsubscribe;

    expect(() => handler.unload()).not.toThrow();
    expect(recorderToggleUnsubscribe).toHaveBeenCalledTimes(1);
    expect((handler as any).recorderVisualizer).toBeNull();
    expect(chatContainer.querySelector(".systemsculpt-streaming-status")).toBeNull();
  });

  it("preserves refreshOptions when model changes are forwarded", () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);
    const onModelChange = jest.fn();

    const plugin = {
      app,
      settings: {
        licenseKey: "license",
        licenseValid: true,
        autoSubmitAfterTranscription: false,
      },
      modelService: {
        getModels: jest.fn(async () => []),
      },
    } as any;

    const handler = new InputHandler({
      app,
      container,
      aiService: { streamMessage: jest.fn() } as any,
      getMessages: () => [],
      isChatReady: () => true,
      chatContainer,
      scrollManager: {
        requestStickToBottom: jest.fn(),
        setGenerating: jest.fn(),
      } as any,
      messageRenderer: {
        addMessageButtonToolbar: jest.fn(),
        normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
        renderUnifiedMessageParts: jest.fn(),
      } as any,
      onMessageSubmit: jest.fn().mockResolvedValue(undefined),
      onAssistantResponse: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-model-change"),
      onModelChange,
      chatView: {},
    });

    const renderModelPickerSpy = jest
      .spyOn(handler as any, "renderModelPicker")
      .mockImplementation(() => {});

    (handler as any).modelPickerOptionsCache = [{ value: "model-a" }];
    (handler as any).modelPickerOptionsPromise = Promise.resolve([]);

    handler.onModelChange({ refreshOptions: true });

    expect((handler as any).modelPickerOptionsCache).toBeNull();
    expect((handler as any).modelPickerOptionsPromise).toBeNull();
    expect(renderModelPickerSpy).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith({ refreshOptions: true });
  });
});
