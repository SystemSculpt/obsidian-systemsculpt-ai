/**
 * @jest-environment jsdom
 */

import { ChatTurnOrchestrator } from "../controllers/ChatTurnOrchestrator";
import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import type { App } from "obsidian";
import { RuntimeIncompatibilityService } from "../../../services/RuntimeIncompatibilityService";
import { SystemSculptError, ERROR_CODES } from "../../../utils/errors";
import { TOOL_LOOP_ERROR_CODE } from "../../../utils/tooling";

// Clear singleton between tests
beforeEach(() => {
  RuntimeIncompatibilityService.clearInstance();
});

afterEach(() => {
  RuntimeIncompatibilityService.clearInstance();
});

// Mock plugin for tests
const createMockPlugin = () => ({
  settings: {
    runtimeToolIncompatibleModels: {},
    runtimeImageIncompatibleModels: {},
  },
  getSettingsManager: () => ({
    updateSettings: jest.fn().mockResolvedValue(undefined),
  }),
});

const createAsyncStream = () => (async function* () {
  return;
})();

describe("ChatTurnOrchestrator compact assistant handling", () => {
  const saveMessage = (messages: ChatMessage[]) => async (message: ChatMessage) => {
    const index = messages.findIndex((m) => m.message_id === message.message_id);
    if (index === -1) {
      messages.push({ ...message });
    } else {
      messages[index] = { ...messages[index], ...message };
    }
  };

  test("creates a new assistant container for continuations (no overwrite)", async () => {
    const messages: ChatMessage[] = [];
    let containerCalls = 0;
    let generatedId = 0;
    const chatRoot = document.createElement("div");
    document.body.appendChild(chatRoot);

    const host = {
      app: {} as App,
      plugin: createMockPlugin(),
      aiService: {
        streamMessage: jest.fn(() => createAsyncStream()),
      },
      streamingController: {
        stream: jest.fn(async (
          stream: AsyncGenerator<any>,
          messageEl: HTMLElement,
          messageId: string,
        ) => {
          for await (const _chunk of stream) {
            // consume generator
          }
          return {
            messageId,
            messageEl,
            message: {
              role: "assistant",
              content: "",
              message_id: messageId,
            } as ChatMessage,
            completed: true,
          };
        }),
        finalizeMessage: jest.fn(),
      },
      toolCallManager: undefined,
      messageRenderer: {} as any,
      getMessages: jest.fn(() => messages),
      getSelectedModelId: jest.fn(() => "test-model"),
      getSystemPrompt: jest.fn(() => ({ type: "default", path: "default" })),
      getContextFiles: jest.fn(() => new Set<string>()),
      agentMode: jest.fn(() => true),
      webSearchEnabled: jest.fn(() => false),
      createAssistantMessageContainer: jest.fn(() => {
        containerCalls += 1;
        const messageEl = document.createElement("div");
        const contentEl = document.createElement("div");
        contentEl.className = "systemsculpt-message-content";
        messageEl.dataset.messageId = `assistant-${containerCalls}`;
        messageEl.appendChild(contentEl);
        chatRoot.appendChild(messageEl);
        return { messageEl, contentEl };
      }),
      generateMessageId: jest.fn(() => `generated-${++generatedId}`),
      onAssistantResponse: saveMessage(messages),
      onError: jest.fn(),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      setStreamingFootnote: jest.fn(),
      clearStreamingFootnote: jest.fn(),
    } as unknown as ConstructorParameters<typeof ChatTurnOrchestrator>[0];

    const orchestrator = new ChatTurnOrchestrator(host);

    const runStream = () => {
      const controller = new AbortController();
      return (orchestrator as any).streamAssistant({ includeContextFiles: false, signal: controller.signal });
    };

    const first = await runStream();
    const second = await runStream();

    expect(host.createAssistantMessageContainer).toHaveBeenCalledTimes(1);
    expect(second?.messageId).toBe(first?.messageId);

    document.body.removeChild(chatRoot);
  });

  test("halts continuation when no new tool calls appear", async () => {
    const messages: ChatMessage[] = [];
    let containerCalls = 0;
    let generatedId = 0;
    const chatRoot = document.createElement("div");
    document.body.appendChild(chatRoot);

    const toolCalls: ToolCall[] = [
      {
        id: "tc1",
        messageId: "assistant-1",
        state: "completed",
        timestamp: Date.now(),
        request: {
          id: "tc1",
          type: "function",
          function: { name: "mcp-test", arguments: "{}" },
        },
      },
    ];

    const toolCallManager = {
      getToolCallsForMessage: jest.fn((messageId: string) => toolCalls.filter((tc) => tc.messageId === messageId)),
      on: jest.fn(() => () => {}),
      getToolCall: jest.fn((id: string) => toolCalls.find((tc) => tc.id === id)),
      shouldAutoApprove: jest.fn(() => true),
      createToolCall: jest.fn(),
    } as any;

    const streamingController = {
      stream: jest.fn(async (
        stream: AsyncGenerator<any>,
        messageEl: HTMLElement,
        messageId: string,
      ) => {
        for await (const _chunk of stream) {
          // consume generator
        }
        return {
          messageId,
          messageEl,
          message: {
            role: "assistant",
            content: "",
            message_id: messageId,
          } as ChatMessage,
          completed: true,
        };
      }),
      finalizeMessage: jest.fn(),
    } as any;

    const aiService = {
      streamMessage: jest.fn(() => createAsyncStream()),
    } as any;

    const host = {
      app: {} as App,
      plugin: createMockPlugin(),
      aiService,
      streamingController,
      toolCallManager,
      messageRenderer: {} as any,
      getMessages: jest.fn(() => messages),
      getSelectedModelId: jest.fn(() => "test-model"),
      getSystemPrompt: jest.fn(() => ({ type: "default", path: "default" })),
      getContextFiles: jest.fn(() => new Set<string>()),
      agentMode: jest.fn(() => true),
      webSearchEnabled: jest.fn(() => false),
      createAssistantMessageContainer: jest.fn(() => {
        containerCalls += 1;
        const messageEl = document.createElement("div");
        messageEl.dataset.messageId = `assistant-${containerCalls}`;
        const contentEl = document.createElement("div");
        messageEl.appendChild(contentEl);
        chatRoot.appendChild(messageEl);
        return { messageEl, contentEl };
      }),
      generateMessageId: jest.fn(() => `generated-${++generatedId}`),
      onAssistantResponse: saveMessage(messages),
      onError: jest.fn(),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      setStreamingFootnote: jest.fn(),
      clearStreamingFootnote: jest.fn(),
    } as unknown as ConstructorParameters<typeof ChatTurnOrchestrator>[0];

    const orchestrator = new ChatTurnOrchestrator(host);
    const controller = new AbortController();
    await orchestrator.runTurn({ includeContextFiles: false, signal: controller.signal });

    expect(aiService.streamMessage).toHaveBeenCalledTimes(2);
    expect(streamingController.finalizeMessage).toHaveBeenCalledWith("assistant-1");

    document.body.removeChild(chatRoot);
  });

  test("continues when new tool calls are produced", async () => {
    const messages: ChatMessage[] = [];
    let containerCalls = 0;
    let generatedId = 0;
    const chatRoot = document.createElement("div");
    document.body.appendChild(chatRoot);

    const toolCalls: ToolCall[] = [
      {
        id: "tc1",
        messageId: "assistant-1",
        state: "completed",
        timestamp: Date.now(),
        request: {
          id: "tc1",
          type: "function",
          function: { name: "mcp-test", arguments: "{}" },
        },
      },
    ];

    const toolCallManager = {
      getToolCallsForMessage: jest.fn((messageId: string) => toolCalls.filter((tc) => tc.messageId === messageId)),
      on: jest.fn(() => () => {}),
      getToolCall: jest.fn((id: string) => toolCalls.find((tc) => tc.id === id)),
      shouldAutoApprove: jest.fn(() => true),
      createToolCall: jest.fn(),
    } as any;

    const streamingController = {
      stream: jest.fn(async (
        stream: AsyncGenerator<any>,
        messageEl: HTMLElement,
        messageId: string,
      ) => {
        for await (const _chunk of stream) {
          // consume generator
        }
        return {
          messageId,
          messageEl,
          message: {
            role: "assistant",
            content: "",
            message_id: messageId,
          } as ChatMessage,
          completed: true,
        };
      }),
      finalizeMessage: jest.fn(),
    } as any;

    let streamInvocation = 0;
    const aiService = {
      streamMessage: jest.fn(() => {
        streamInvocation += 1;
        if (streamInvocation === 2) {
          toolCalls.push({
            id: "tc2",
            messageId: "assistant-1",
            state: "completed",
            timestamp: Date.now() + 1,
            request: {
              id: "tc2",
              type: "function",
              function: { name: "mcp-extra", arguments: "{}" },
            },
          });
        }
        return createAsyncStream();
      }),
    } as any;

    const host = {
      app: {} as App,
      plugin: createMockPlugin(),
      aiService,
      streamingController,
      toolCallManager,
      messageRenderer: {} as any,
      getMessages: jest.fn(() => messages),
      getSelectedModelId: jest.fn(() => "test-model"),
      getSystemPrompt: jest.fn(() => ({ type: "default", path: "default" })),
      getContextFiles: jest.fn(() => new Set<string>()),
      agentMode: jest.fn(() => true),
      webSearchEnabled: jest.fn(() => false),
      createAssistantMessageContainer: jest.fn(() => {
        containerCalls += 1;
        const messageEl = document.createElement("div");
        messageEl.dataset.messageId = `assistant-${containerCalls}`;
        const contentEl = document.createElement("div");
        messageEl.appendChild(contentEl);
        chatRoot.appendChild(messageEl);
        return { messageEl, contentEl };
      }),
      requestDebouncedStreamingSave: jest.fn(),
      generateMessageId: jest.fn(() => `generated-${++generatedId}`),
      onAssistantResponse: saveMessage(messages),
      onError: jest.fn(),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      setStreamingFootnote: jest.fn(),
      clearStreamingFootnote: jest.fn(),
    } as unknown as ConstructorParameters<typeof ChatTurnOrchestrator>[0];

    const orchestrator = new ChatTurnOrchestrator(host);
    const controller = new AbortController();
    await orchestrator.runTurn({ includeContextFiles: false, signal: controller.signal });

    expect(aiService.streamMessage).toHaveBeenCalledTimes(3);
    expect(streamingController.finalizeMessage).toHaveBeenCalledWith("assistant-1");

    document.body.removeChild(chatRoot);
  });

  test("aborts tool-wait promptly when signal is aborted", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", message_id: "assistant-1" } as ChatMessage,
    ];

    const toolCalls: ToolCall[] = [
      {
        id: "tc_pending",
        messageId: "assistant-1",
        state: "pending",
        timestamp: Date.now(),
        request: {
          id: "tc_pending",
          type: "function",
          function: { name: "mcp-filesystem_write", arguments: "{\"path\":\"X\",\"content\":\"Y\"}" },
        },
      } as any,
    ];

    const toolCallManager = {
      getToolCallsForMessage: jest.fn(() => toolCalls),
      on: jest.fn(() => () => {}),
    } as any;

    const host = {
      app: {} as App,
      plugin: createMockPlugin(),
      aiService: {} as any,
      streamingController: {} as any,
      toolCallManager,
      messageRenderer: {} as any,
      getMessages: jest.fn(() => messages),
      getSelectedModelId: jest.fn(() => "test-model"),
      getSystemPrompt: jest.fn(() => ({ type: "default", path: "default" })),
      getContextFiles: jest.fn(() => new Set<string>()),
      agentMode: jest.fn(() => true),
      webSearchEnabled: jest.fn(() => false),
      createAssistantMessageContainer: jest.fn(() => ({ messageEl: document.createElement("div"), contentEl: document.createElement("div") })),
      generateMessageId: jest.fn(() => "generated-1"),
      onAssistantResponse: jest.fn(async () => {}),
      onError: jest.fn(),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      setStreamingFootnote: jest.fn(),
      clearStreamingFootnote: jest.fn(),
    } as unknown as ConstructorParameters<typeof ChatTurnOrchestrator>[0];

    const orchestrator = new ChatTurnOrchestrator(host);
    const controller = new AbortController();

    const promise = (orchestrator as any).continueAfterTools("assistant-1", controller.signal);
    controller.abort();
    const result = await promise;

    expect(result).toBeNull();
    expect(host.onError).not.toHaveBeenCalled();
  });

  test("notifies host when tools are disabled after runtime rejection", async () => {
    const messages: ChatMessage[] = [];
    const chatRoot = document.createElement("div");
    document.body.appendChild(chatRoot);

    let streamCalls = 0;
    const streamingController = {
      stream: jest.fn(async (_stream: AsyncGenerator<any>, messageEl: HTMLElement, messageId: string) => {
        streamCalls += 1;
        if (streamCalls === 1) {
          throw new SystemSculptError("Tools not supported", ERROR_CODES.STREAM_ERROR, 400, {
            shouldResubmitWithoutTools: true,
          });
        }
        return {
          messageId,
          messageEl,
          message: { role: "assistant", content: "", message_id: messageId } as ChatMessage,
          completed: true,
        };
      }),
      finalizeMessage: jest.fn(),
    } as any;

    const host = {
      app: {} as App,
      plugin: createMockPlugin(),
      aiService: { streamMessage: jest.fn(() => createAsyncStream()) } as any,
      streamingController,
      toolCallManager: undefined,
      messageRenderer: {} as any,
      getMessages: jest.fn(() => messages),
      getSelectedModelId: jest.fn(() => "test-model"),
      getSystemPrompt: jest.fn(() => ({ type: "default", path: "default" })),
      getContextFiles: jest.fn(() => new Set<string>()),
      getChatId: jest.fn(() => "chat-1"),
      getDebugLogger: jest.fn(() => null),
      agentMode: jest.fn(() => true),
      webSearchEnabled: jest.fn(() => false),
      createAssistantMessageContainer: jest.fn(() => {
        const messageEl = document.createElement("div");
        messageEl.dataset.messageId = "assistant-1";
        const contentEl = document.createElement("div");
        messageEl.appendChild(contentEl);
        chatRoot.appendChild(messageEl);
        return { messageEl, contentEl };
      }),
      generateMessageId: jest.fn(() => "assistant-1"),
      onAssistantResponse: jest.fn(async () => {}),
      onError: jest.fn(),
      onCompatibilityNotice: jest.fn(),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      setStreamingFootnote: jest.fn(),
      clearStreamingFootnote: jest.fn(),
    } as unknown as ConstructorParameters<typeof ChatTurnOrchestrator>[0];

    const orchestrator = new ChatTurnOrchestrator(host);
    const controller = new AbortController();
    await (orchestrator as any).streamAssistant({ includeContextFiles: false, signal: controller.signal });

    expect(streamingController.stream).toHaveBeenCalledTimes(2);
    expect(host.onCompatibilityNotice).toHaveBeenCalledWith({
      modelId: "test-model",
      tools: true,
      images: false,
      source: "runtime",
    });

    document.body.removeChild(chatRoot);
  });

  test("halts continuation when loop guard tool error is present", async () => {
    const messages: ChatMessage[] = [];
    const toolCalls: ToolCall[] = [
      {
        id: "tc_loop",
        messageId: "assistant-1",
        state: "failed",
        timestamp: Date.now(),
        request: {
          id: "tc_loop",
          type: "function",
          function: { name: "mcp-filesystem_move", arguments: "{\"from\":\"A\",\"to\":\"B\"}" },
        },
        result: {
          success: false,
          error: { code: TOOL_LOOP_ERROR_CODE, message: "Blocked repeated tool call" },
        },
      },
    ];

    const toolCallManager = {
      getToolCallsForMessage: jest.fn(() => toolCalls),
      on: jest.fn(() => () => {}),
    } as any;

    const host = {
      app: {} as App,
      plugin: createMockPlugin(),
      aiService: {} as any,
      streamingController: {} as any,
      toolCallManager,
      messageRenderer: {} as any,
      getMessages: jest.fn(() => messages),
      getSelectedModelId: jest.fn(() => "test-model"),
      getSystemPrompt: jest.fn(() => ({ type: "default", path: "default" })),
      getContextFiles: jest.fn(() => new Set<string>()),
      agentMode: jest.fn(() => true),
      webSearchEnabled: jest.fn(() => false),
      createAssistantMessageContainer: jest.fn(() => ({ messageEl: document.createElement("div"), contentEl: document.createElement("div") })),
      generateMessageId: jest.fn(() => "generated-1"),
      onAssistantResponse: jest.fn(async () => {}),
      onError: jest.fn(),
      showStreamingStatus: jest.fn(),
      hideStreamingStatus: jest.fn(),
      updateStreamingStatus: jest.fn(),
      setStreamingFootnote: jest.fn(),
      clearStreamingFootnote: jest.fn(),
    } as unknown as ConstructorParameters<typeof ChatTurnOrchestrator>[0];

    const orchestrator = new ChatTurnOrchestrator(host);
    const controller = new AbortController();
    const result = await (orchestrator as any).continueAfterTools("assistant-1", controller.signal);

    expect(result).toBeNull();
    expect(host.onError).toHaveBeenCalled();
  });
});
