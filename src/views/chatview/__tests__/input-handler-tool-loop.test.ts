/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import type { ChatMessage } from "../../../types";
import { InputHandler } from "../InputHandler";
import { messageHandling } from "../messageHandling";
import { ensureProviderRuntimeReady } from "../../../services/providerRuntime/ProviderRuntime";
import { getConfiguredRemoteProviderApiKey } from "../../../services/providerRuntime/RemoteProviderCatalog";
import {
  buildPiTextProviderSetupMessage,
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

jest.mock("../../../services/providerRuntime/ProviderRuntime", () => ({
  ensureProviderRuntimeReady: jest.fn(),
}));

jest.mock("../../../services/providerRuntime/RemoteProviderCatalog", () => ({
  getConfiguredRemoteProviderApiKey: jest.fn(() => ""),
}));

jest.mock("../../../services/pi-native/PiTextAuth", () => ({
  buildPiTextProviderSetupMessage: jest.fn((providerId: string, actualModelId?: string) =>
    actualModelId
      ? `Connect ${providerId} in Pi before running "${actualModelId}".`
      : `Connect ${providerId} in Pi before using this model.`
  ),
  loadPiTextProviderAuth: jest.fn(async () => new Map()),
  piTextProviderRequiresAuth: jest.fn(() => true),
}));

describe("InputHandler hosted tool loop", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getConfiguredRemoteProviderApiKey as jest.Mock).mockReturnValue("");
  });

  const createHostedToolLoopHarness = () => {
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
    const onError = jest.fn();

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
      onError,
      onAddContextFile: jest.fn(),
      onOpenChatSettings: jest.fn(),
      plugin,
      getChatMarkdown: jest.fn().mockResolvedValue(""),
      getChatTitle: jest.fn(() => "Chat"),
      addFileToContext: jest.fn(),
      getChatId: jest.fn(() => "chat-1"),
      chatView,
    });

    return {
      app,
      container,
      chatContainer,
      messages,
      aiService,
      plugin,
      onMessageSubmit,
      onAssistantResponse,
      onError,
      chatView,
      handler,
    };
  };

  it("executes hosted tool calls locally and continues the turn after toolUse", async () => {
    const { aiService, chatView, handler, messages } = createHostedToolLoopHarness();

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
        completionState: "completed",
        stopReason: "toolUse",
      })
      .mockImplementationOnce(async () => {
        await (handler as any).onAssistantResponse(finalAssistantMessage);
        return {
          messageId: "assistant-2",
          message: finalAssistantMessage,
          messageEl: document.createElement("div"),
          completed: true,
          completionState: "completed",
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

  it("reuses the last assistant root when a hosted continuation round starts", async () => {
    const { aiService, chatContainer, handler, messages } = createHostedToolLoopHarness();

    const existingMessageEl = document.createElement("div");
    existingMessageEl.classList.add("systemsculpt-message", "systemsculpt-assistant-message");
    existingMessageEl.dataset.messageId = "assistant-root";
    chatContainer.appendChild(existingMessageEl);

    const existingToolCall = {
      id: "call_1",
      messageId: "assistant-root",
      request: {
        id: "call_1",
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          arguments: "{\"paths\":[\"alpha.md\"]}",
        },
      },
      state: "completed",
      timestamp: 1,
      executionStartedAt: 1,
      executionCompletedAt: 2,
      result: {
        success: true,
        data: { contents: ["alpha"] },
      },
    };

    const existingParts = [
      {
        id: "tool_call_part-call_1",
        type: "tool_call",
        timestamp: 1,
        data: existingToolCall,
      },
    ];

    messages.push({
      role: "assistant",
      content: "",
      message_id: "assistant-root",
      tool_calls: [existingToolCall],
      messageParts: existingParts,
    } as any);

    aiService.streamMessage.mockReturnValue((async function* () {
      yield { type: "content", text: "Done." } as any;
    })());

    const createAssistantMessageContainerSpy = jest.spyOn(handler as any, "createAssistantMessageContainer");
    const streamSpy = jest
      .spyOn((handler as any).streamingController, "stream")
      .mockResolvedValue({
        messageId: "assistant-root",
        message: {
          role: "assistant",
          content: "Done.",
          message_id: "assistant-root",
        },
        messageEl: existingMessageEl,
        completed: true,
        completionState: "completed",
      });

    await (handler as any).streamAssistantTurn(new AbortController().signal, false);

    expect(createAssistantMessageContainerSpy).not.toHaveBeenCalled();
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(streamSpy.mock.calls[0]?.[1]).toBe(existingMessageEl);
    expect(streamSpy.mock.calls[0]?.[2]).toBe("assistant-root");
    expect(streamSpy.mock.calls[0]?.[4]).toEqual(existingParts);
  });

  it("does not continue the hosted tool loop when a local Pi tool call is already completed", async () => {
    const { aiService, handler, messages } = createHostedToolLoopHarness();

    const localPiAssistantMessage: ChatMessage = {
      role: "assistant",
      content: "Read the file locally.",
      message_id: "assistant-local-pi",
      tool_calls: [
        {
          id: "pi_call_1",
          messageId: "assistant-local-pi",
          request: {
            id: "pi_call_1",
            type: "function",
            function: {
              name: "read",
              arguments: "{\"filePath\":\"alpha.md\"}",
            },
          },
          state: "completed",
          timestamp: 1,
          executionStartedAt: 1,
          executionCompletedAt: 2,
          result: {
            success: true,
            data: { content: [{ type: "text", text: "ALPHA_20260311-194643" }] },
          },
        },
      ],
      messageParts: [],
    } as any;

    const streamAssistantTurn = jest.spyOn(handler as any, "streamAssistantTurn");
    streamAssistantTurn.mockImplementationOnce(async () => {
      await (handler as any).onAssistantResponse(localPiAssistantMessage);
      return {
        messageId: "assistant-local-pi",
        message: localPiAssistantMessage,
        messageEl: document.createElement("div"),
        completed: true,
        completionState: "completed",
        stopReason: "toolUse",
      };
    });

    handler.setValue("Use local Pi tools.");
    await handler.submitWithOverrides({ includeContextFiles: false });

    expect(streamAssistantTurn).toHaveBeenCalledTimes(1);
    expect(aiService.executeHostedToolCall).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Use local Pi tools." }),
        expect.objectContaining({
          message_id: "assistant-local-pi",
          content: "Read the file locally.",
          tool_calls: [
            expect.objectContaining({
              id: "pi_call_1",
              state: "completed",
            }),
          ],
        }),
      ])
    );
  });

  it("retries a reasoning-only continuation after hosted tool execution and finishes the turn", async () => {
    const { aiService, handler, messages, onError } = createHostedToolLoopHarness();

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
              name: "mcp-filesystem_write",
              arguments: "{\"path\":\"alpha.md\",\"content\":\"Hello\"}",
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
      content: "Saved the file and verified it.",
      message_id: "assistant-2",
    } as any;

    const streamAssistantTurn = jest.spyOn(handler as any, "streamAssistantTurn");
    streamAssistantTurn
      .mockResolvedValueOnce({
        messageId: "assistant-1",
        message: firstAssistantMessage,
        messageEl: document.createElement("div"),
        completed: true,
        completionState: "completed",
        stopReason: "toolUse",
      })
      .mockResolvedValueOnce({
        messageId: "assistant-empty",
        message: {
          role: "assistant",
          content: "",
          reasoning: "I already know the answer but failed to emit final content.",
          message_id: "assistant-empty",
        } as any,
        messageEl: document.createElement("div"),
        completed: false,
        completionState: "empty",
      })
      .mockImplementationOnce(async () => {
        await (handler as any).onAssistantResponse(finalAssistantMessage);
        return {
          messageId: "assistant-2",
          message: finalAssistantMessage,
          messageEl: document.createElement("div"),
          completed: true,
          completionState: "completed",
        };
      });

    handler.setValue("Retry the continuation if needed.");
    await handler.submitWithOverrides({ includeContextFiles: false });

    expect(streamAssistantTurn).toHaveBeenCalledTimes(3);
    expect(aiService.executeHostedToolCall).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message_id: "assistant-1",
          tool_calls: [
            expect.objectContaining({
              id: "call_1",
              state: "completed",
            }),
          ],
        }),
        expect.objectContaining({
          message_id: "assistant-2",
          content: "Saved the file and verified it.",
        }),
      ])
    );
  });

  it("surfaces an unrecoverable empty hosted turn instead of silently succeeding", async () => {
    const { handler, onError } = createHostedToolLoopHarness();

    jest.spyOn(handler as any, "streamAssistantTurn").mockResolvedValue({
      messageId: "assistant-empty",
      message: {
        role: "assistant",
        content: "",
        message_id: "assistant-empty",
      } as any,
      messageEl: document.createElement("div"),
      completed: false,
      completionState: "empty",
    });

    handler.setValue("Tell me something.");

    await expect(
      handler.submitForAutomation({
        includeContextFiles: false,
        approvalMode: "auto-approve",
        focusAfterSend: false,
      })
    ).rejects.toThrow("empty response");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message || "").toContain("empty response");
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
      completionState: "completed",
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

    (ensureProviderRuntimeReady as jest.Mock).mockRejectedValue(
      new Error('Connect OpenAI in Pi before running "openai/gpt-4.1".')
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

  it("accepts remote-provider mobile chats when plugin settings already contain the API key", async () => {
    const { handler, chatView, plugin } = createHostedToolLoopHarness();
    chatView.getSelectedModelId = jest.fn(() => "openrouter@@openai/gpt-5.4-mini");
    plugin.settings.selectedModelId = "openrouter@@openai/gpt-5.4-mini";
    plugin.modelService.getModelById = jest.fn(async () => ({
      id: "openrouter@@openai/gpt-5.4-mini",
      provider: "openrouter",
      sourceProviderId: "openrouter",
      sourceMode: "custom_endpoint",
      piRemoteAvailable: true,
      piExecutionModelId: "openai/gpt-5.4-mini",
    }));
    (ensureProviderRuntimeReady as jest.Mock).mockResolvedValue({
      mode: "remote",
      actualModelId: "openai/gpt-5.4-mini",
      providerId: "openrouter",
      authMode: "byok",
      endpoint: "https://openrouter.ai/api/v1",
      supportsTools: true,
      supportsImages: true,
    });

    await expect((handler as any).ensureProviderReadyForChat()).resolves.toBe(true);
    expect(ensureProviderRuntimeReady).toHaveBeenCalled();
  });

  it("uses the selected model setup target when automation blocks a setup prompt without overrides", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const chatView = {
      promptProviderSetup: jest.fn().mockResolvedValue(undefined),
      getSelectedModelId: jest.fn(() => "openai@@gpt-4.1"),
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
          selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
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

    await expect((handler as any).invokeProviderSetupPrompt()).rejects.toThrow(
      "Open Settings -> Providers to connect the selected provider."
    );

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

    const controller = (handler as any).modelSelectionController;
    const refreshSpy = jest.spyOn(controller, "refresh");
    (controller as any).modelPickerOptionsCache = [{ value: "model-a" } as any];
    const stalePromise = Promise.resolve([]);
    (controller as any).modelPickerOptionsPromise = stalePromise;

    handler.onModelChange({ refreshOptions: true });

    expect((controller as any).modelPickerOptionsCache).toBeNull();
    expect((controller as any).modelPickerOptionsPromise).not.toBe(stalePromise);
    expect(refreshSpy).toHaveBeenCalledWith({ reloadOptions: true });
    expect(onModelChange).toHaveBeenCalledWith({ refreshOptions: true });
  });
});
