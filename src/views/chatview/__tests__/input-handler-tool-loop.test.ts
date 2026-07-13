/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import type { ChatMessage } from "../../../types";
import { InputHandler } from "../InputHandler";
import { messageHandling } from "../messageHandling";
import { createDeterministicManagedChatClient } from "../../../services/managed/__tests__/ManagedChatTestHarness";
import type { AcceptedUserCommitInput } from "../ChatView";
import { ChatTurnLifecycleController } from "../controllers/ChatTurnLifecycleController";

const managedHarness = createDeterministicManagedChatClient();
const managedChatAdmission = managedHarness.client;
function commitAccepted(messages: ChatMessage[], input: AcceptedUserCommitInput) {
  const next = input.kind === "resend" ? [...messages.slice(0, input.expectedIndex), input.message]
    : messages.some((entry) => entry.message_id === input.message.message_id) ? [...messages] : [...messages, input.message];
  messages.splice(0, messages.length, ...next);
  const snapshot = Object.freeze({ chatId: "chat-1", version: 1, messages: Object.freeze([...messages]) });
  return Promise.resolve(Object.freeze({
    status: "accepted_current" as const,
    snapshot,
    message: snapshot.messages[snapshot.messages.length - 1],
    ownership: Object.freeze({ transcriptIdentity: messages, generation: 1, originalChatId: "chat-1", acceptedChatId: "chat-1" }),
  }));
}

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
  it("uses the production managed fixture admission path", async () => {
    await expect(managedHarness.transport.getCatalog()).resolves.toMatchObject({ contract_version: "managed-capabilities-v2" });
    await expect(managedHarness.transport.getAdmission()).resolves.toMatchObject({ outcome: "allowed" });
    await expect(managedChatAdmission.acquireChatTurnLease()).resolves.toMatchObject({ outcome: "allowed" });
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createHostedToolLoopHarness = () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const messages: ChatMessage[] = [];
    const aiService = {
      streamMessage: jest.fn(),
      prepareAcceptedChatRequest: jest.fn(async (operation: any) => ({
        runtime: operation.runtime,
        operation,
        durableTurnId: operation.durableTurnId,
        durableSnapshot: operation.initialDurableSnapshot,
        acceptedMessageCount: operation.initialDurableSnapshot.messages.length,
        model: "ai-agent",
        policy: { prompt: "none", contextCount: 0, imageContextIncluded: true, documentContextIncluded: false, tools: "omitted" },
        notices: [], diagnostics: [], messages: operation.initialDurableSnapshot.messages.map((message: ChatMessage) => ({ role: message.role, content: message.content })),
      })),
      releaseAcceptedChatRequest: jest.fn(),
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
    const getMessages = jest.fn(() => messages);

    const currentRuntimeAdapter = {
      dispatch: jest.fn(async () => ({
        kind: "stream" as const,
        events: (async function* () {
          yield { type: "content", text: "done" } as any;
        })(),
        diagnostic: {},
      })),
      notifyDurablyTerminal: jest.fn(),
    };

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
      getCurrentRuntimeAdapter: jest.fn(() => currentRuntimeAdapter),
      recoverManagedChatConflict: jest.fn().mockResolvedValue(true),
      getSelectedModelId: jest.fn(() => "systemsculpt@@systemsculpt/ai-agent"),
      saveChat: jest.fn().mockResolvedValue(undefined),
      getDurableTranscriptSnapshot: jest.fn(() => Object.freeze({ chatId: "chat-1", version: 1, messages: Object.freeze([...messages]) })),
      isFullyLoaded: true,
    } as any;

    const handler = new InputHandler({
      managedChatAdmission,
      commitAcceptedUserMessage: async (input) => { await onMessageSubmit(input.message); return commitAccepted(messages, input); },
      claimAcceptedUserCommit: () => true,
      app,
      container,
      aiService,
      getMessages,
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

    const bindAcceptedRequest = async () => {
      const message = messages.find((entry) => entry.role === "user") ?? { role: "user", content: "accepted", message_id: "u" } as ChatMessage;
      const durable = Object.freeze({ chatId: "chat-1", version: 1, messages: Object.freeze([message]) });
      const base = { durableTurnId: message.message_id || "u", acceptedUserMessage: message, initialDurableSnapshot: durable, turnBoundaryId: "b" } as const;
      const operation = Object.freeze({ ...base, runtime: "managed" as const, lease: {} as never });
      (handler as any).acceptedOperation = operation;
      (handler as any).acceptedRequestSnapshot = await aiService.prepareAcceptedChatRequest(operation);
      return operation;
    };

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
      getMessages,
      chatView,
      currentRuntimeAdapter,
      handler,
      bindAcceptedRequest,
    };
  };

  it("synchronously reserves one of two idle submissions before deferred admission or large-paste consumption", async () => {
    const { aiService, currentRuntimeAdapter, handler, onMessageSubmit } = createHostedToolLoopHarness();
    const allowed = await managedChatAdmission.acquireChatTurnLease();
    let resolveAdmission!: (value: typeof allowed) => void;
    const deferredAdmission = new Promise<typeof allowed>((resolve) => {
      resolveAdmission = resolve;
    });
    const admission = jest
      .spyOn(managedChatAdmission, "acquireChatTurnLease")
      .mockImplementationOnce(() => deferredAdmission);
    (handler as any).pendingLargeTextContent = "full large paste";
    (handler as any).createAssistantMessageContainer = jest.fn(() => {
      const messageEl = document.createElement("div");
      messageEl.dataset.messageId = "assistant-race";
      return { messageEl, contentEl: messageEl };
    });
    handler.setValue("Summarize [PASTED TEXT - 20 LINES OF TEXT]");
    aiService.streamMessage.mockImplementation(() => (async function* () {
      yield { type: "content", text: "done" } as any;
    })());

    const first = handler.submitForAutomation();
    const second = handler.submitForAutomation();

    await expect(second).rejects.toEqual(expect.objectContaining({
      code: "chat_turn_already_active",
      state: "reserved",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admission).toHaveBeenCalledTimes(1);
    expect(handler.getValue()).toBe("Summarize [PASTED TEXT - 20 LINES OF TEXT]");
    expect((handler as any).pendingLargeTextContent).toBe("full large paste");
    expect(onMessageSubmit).not.toHaveBeenCalled();
    expect(aiService.streamMessage).not.toHaveBeenCalled();

    resolveAdmission(allowed);
    await first;

    expect(onMessageSubmit).toHaveBeenCalledTimes(1);
    expect(onMessageSubmit.mock.calls[0]?.[0]?.content).toBe("Summarize full large paste");
    expect(String(onMessageSubmit.mock.calls[0]?.[0]?.content)).not.toContain("[PASTED TEXT");
    expect(aiService.streamMessage).not.toHaveBeenCalled();
    expect(currentRuntimeAdapter.dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches standard Chat from only the exact accepted snapshot and durable continuation snapshot", async () => {
    const { chatView, currentRuntimeAdapter, getMessages, handler, bindAcceptedRequest } = createHostedToolLoopHarness();
    const operation = await bindAcceptedRequest();
    const acceptedRequestSnapshot = (handler as any).acceptedRequestSnapshot;
    const fence = { isOpen: (candidate?: unknown) => !candidate || candidate === operation };
    jest.spyOn(handler as any, "createAssistantMessageContainer").mockImplementation(() => {
      const messageEl = document.createElement("div");
      messageEl.dataset.messageId = `assistant-${Math.random()}`;
      return { messageEl, contentEl: messageEl };
    });
    getMessages.mockClear();
    chatView.contextManager.getContextFiles.mockClear();
    chatView.getSelectedModelId.mockClear();
    currentRuntimeAdapter.dispatch.mockClear();

    await (handler as any).streamAssistantTurn(
      operation,
      new AbortController().signal,
      undefined,
      { phase: "initial", fence },
    );
    expect(currentRuntimeAdapter.dispatch).toHaveBeenCalledTimes(1);
    expect(currentRuntimeAdapter.dispatch.mock.calls[0]?.[0]?.acceptedRequestSnapshot).toBe(acceptedRequestSnapshot);
    expect(currentRuntimeAdapter.dispatch.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      phase: "initial",
      continuationIndex: 0,
    }));
    expect(getMessages).not.toHaveBeenCalled();
    expect(chatView.contextManager.getContextFiles).not.toHaveBeenCalled();
    expect(chatView.getSelectedModelId).not.toHaveBeenCalled();

    const postCheckpointDurableSnapshot = Object.freeze({
      chatId: "chat-1",
      version: 2,
      messages: Object.freeze([operation.acceptedUserMessage]),
    });
    currentRuntimeAdapter.dispatch.mockClear();
    getMessages.mockClear();
    await (handler as any).streamAssistantTurn(
      operation,
      new AbortController().signal,
      undefined,
      {
        phase: "continuation",
        postCheckpointSnapshot: postCheckpointDurableSnapshot,
        durableContinuationIndex: 1,
        fence,
      },
    );
    expect(currentRuntimeAdapter.dispatch.mock.calls[0]?.[0]?.acceptedRequestSnapshot).toBe(acceptedRequestSnapshot);
    expect(currentRuntimeAdapter.dispatch.mock.calls[0]?.[0]?.postCheckpointDurableSnapshot).toBe(postCheckpointDurableSnapshot);
    expect(currentRuntimeAdapter.dispatch.mock.calls[0]?.[0]?.continuationIndex).toBe(1);
    expect(getMessages).not.toHaveBeenCalled();
    expect(chatView.contextManager.getContextFiles).not.toHaveBeenCalled();
  });

  it.each([
    "operation_in_progress",
    "operation_already_completed",
    "operation_terminal",
    "settlement_pending",
  ] as const)("recovers managed %s before creating any assistant projection", async (disposition) => {
    const { aiService, chatView, currentRuntimeAdapter, handler, bindAcceptedRequest } = createHostedToolLoopHarness();
    const operation = await bindAcceptedRequest();
    currentRuntimeAdapter.dispatch.mockResolvedValueOnce({ kind: "recovery", disposition, diagnostic: { status: 409 } });
    const createProjection = jest.spyOn(handler as any, "createAssistantMessageContainer");
    const fence = { isOpen: () => true };

    await expect((handler as any).streamAssistantTurn(
      operation,
      new AbortController().signal,
      undefined,
      { phase: "initial", fence },
    )).rejects.toThrow("Explicit resend is required");

    expect(chatView.recoverManagedChatConflict).toHaveBeenCalledTimes(1);
    expect(chatView.recoverManagedChatConflict).toHaveBeenCalledWith(
      operation,
      expect.any(AbortSignal),
      fence,
    );
    expect(createProjection).not.toHaveBeenCalled();
    expect(aiService.streamMessage).not.toHaveBeenCalled();
    expect(currentRuntimeAdapter.dispatch).toHaveBeenCalledTimes(1);
  });

  it("suppresses late managed recovery and projection after local abort", async () => {
    const { chatView, currentRuntimeAdapter, handler, bindAcceptedRequest } = createHostedToolLoopHarness();
    const operation = await bindAcceptedRequest();
    let resolveDispatch!: (value: unknown) => void;
    currentRuntimeAdapter.dispatch.mockImplementationOnce(() => new Promise((resolve) => { resolveDispatch = resolve; }));
    const createProjection = jest.spyOn(handler as any, "createAssistantMessageContainer");
    const abort = new AbortController();
    const pending = (handler as any).streamAssistantTurn(
      operation,
      abort.signal,
      undefined,
      { phase: "initial", fence: { isOpen: () => true } },
    );
    abort.abort();
    resolveDispatch({ kind: "recovery", disposition: "operation_in_progress", diagnostic: { status: 409 } });
    await expect(pending).rejects.toThrow("cancelled before projection");
    expect(chatView.recoverManagedChatConflict).not.toHaveBeenCalled();
    expect(createProjection).not.toHaveBeenCalled();
  });

  it("does not record a hosted tool completion that resolves after local abort", async () => {
    const { aiService, handler, bindAcceptedRequest } = createHostedToolLoopHarness();
    const operation = await bindAcceptedRequest();
    let resolveTool!: (value: unknown) => void;
    aiService.executeHostedToolCall.mockImplementationOnce(() => new Promise((resolve) => { resolveTool = resolve; }));
    const toolCall = {
      id: "late-tool",
      request: { id: "late-tool", type: "function", function: { name: "read", arguments: "{}" } },
      state: "pending",
    } as any;
    const abort = new AbortController();
    const execution = (handler as any).executeHostedToolCall(toolCall, abort.signal, { isOpen: () => true }, operation);
    await Promise.resolve();
    abort.abort();
    resolveTool({ success: true, data: "late" });
    await execution;
    expect(toolCall.state).toBe("executing");
    expect(toolCall.result).toBeUndefined();
    expect(toolCall.executionCompletedAt).toBeUndefined();
  });

  it("records an outcome-unknown tool result so cancellation can be checkpointed honestly", async () => {
    const { aiService, handler, bindAcceptedRequest } = createHostedToolLoopHarness();
    const operation = await bindAcceptedRequest();
    let resolveTool!: (value: unknown) => void;
    aiService.executeHostedToolCall.mockImplementationOnce(() => new Promise((resolve) => { resolveTool = resolve; }));
    const toolCall = {
      id: "unknown-tool",
      request: { id: "unknown-tool", type: "function", function: { name: "write", arguments: "{}" } },
      state: "pending",
    } as any;
    const abort = new AbortController();
    const execution = (handler as any).executeHostedToolCall(toolCall, abort.signal, { isOpen: () => true }, operation);
    await Promise.resolve();
    abort.abort();
    resolveTool({
      success: false,
      error: { code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN", message: "Outcome unknown" },
    });
    await execution;
    expect(toolCall.state).toBe("failed");
    expect(toolCall.result.error.code).toBe("TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN");
    expect(toolCall.executionCompletedAt).toEqual(expect.any(Number));
  });

  it("submits the immutable composer candidate captured before awaited readiness", async () => {
    const { handler, onMessageSubmit } = createHostedToolLoopHarness();
    let resolveReadiness!: (ready: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { resolveReadiness = resolve; });
    (handler as any).ensureProviderReadyForChat = jest.fn(() => readiness);
    handler.setValue("captured before readiness");

    jest.spyOn(handler as any, "streamAssistantTurn").mockResolvedValue({
      messageId: "assistant",
      message: { role: "assistant", content: "done", message_id: "assistant" },
      messageEl: document.createElement("div"),
      completed: true,
      completionState: "completed",
    });
    const submission = handler.submitForAutomation();
    await Promise.resolve();
    handler.setValue("   \n\t");
    resolveReadiness(true);
    await submission;

    expect(onMessageSubmit).toHaveBeenCalledTimes(1);
    expect(onMessageSubmit).toHaveBeenCalledWith(expect.objectContaining({
      role: "user",
      content: "captured before readiness",
    }));
  });

  it("invalidates and awaits deferred readiness when disposed before lifecycle promotion", async () => {
    const { aiService, handler, onMessageSubmit } = createHostedToolLoopHarness();
    let resolveReadiness!: (ready: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { resolveReadiness = resolve; });
    const ensureReady = jest.fn(() => readiness);
    const cleanupIndicators = jest.spyOn(handler as any, "cleanupAllStatusIndicators");
    (handler as any).ensureProviderReadyForChat = ensureReady;
    (handler as any).pendingLargeTextContent = "preserve on close";
    handler.setValue("Close [PASTED TEXT - 8 LINES OF TEXT]");

    const submission = handler.submitForAutomation();
    const firstDisposal = handler.disposeLocalResources();
    const repeatedDisposal = handler.disposeLocalResources();

    expect(repeatedDisposal).toBe(firstDisposal);
    expect(cleanupIndicators).not.toHaveBeenCalled();
    expect((handler as any).turnLifecycle).toBeNull();

    resolveReadiness(true);
    await expect(submission).resolves.toBeUndefined();
    await expect(firstDisposal).resolves.toBeUndefined();

    expect(handler.getValue()).toBe("Close [PASTED TEXT - 8 LINES OF TEXT]");
    expect((handler as any).pendingLargeTextContent).toBe("preserve on close");
    expect(onMessageSubmit).not.toHaveBeenCalled();
    expect(aiService.streamMessage).not.toHaveBeenCalled();
    expect((handler as any).turnLifecycle).toBeNull();
    expect(cleanupIndicators).toHaveBeenCalledTimes(1);

    await expect(handler.disposeLocalResources()).resolves.toBeUndefined();
    expect(cleanupIndicators).toHaveBeenCalledTimes(1);
  });

  it("onunload invalidates a reserved preflight before it can promote a turn", async () => {
    const { aiService, handler, onMessageSubmit } = createHostedToolLoopHarness();
    let resolveReadiness!: (ready: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { resolveReadiness = resolve; });
    (handler as any).ensureProviderReadyForChat = jest.fn(() => readiness);
    handler.setValue("do not submit after close");

    const submission = handler.submitForAutomation();
    handler.onunload();
    resolveReadiness(true);
    await submission;
    await Promise.resolve();

    expect(onMessageSubmit).not.toHaveBeenCalled();
    expect(aiService.streamMessage).not.toHaveBeenCalled();
    expect((handler as any).turnLifecycle).toBeNull();
  });

  it("releases reservation and restores composer plus large-paste state when the first durable commit fails", async () => {
    const { handler, onMessageSubmit } = createHostedToolLoopHarness();
    (handler as any).ensureProviderReadyForChat = jest.fn().mockResolvedValue(true);
    (handler as any).pendingLargeTextContent = "recover this paste";
    handler.setValue("Use [PASTED TEXT - 12 LINES OF TEXT]");
    onMessageSubmit.mockRejectedValueOnce(new Error("disk failed"));

    await expect(handler.submitForAutomation()).rejects.toThrow("disk failed");

    expect(handler.getValue()).toBe("Use [PASTED TEXT - 12 LINES OF TEXT]");
    expect((handler as any).pendingLargeTextContent).toBe("recover this paste");
    expect((handler as any).submissionReserved).toBe(false);
  });

  it("exits whitespace-only submission before admission with zero effects", async () => {
    const { aiService, handler, onMessageSubmit, chatView } = createHostedToolLoopHarness();
    const admission = jest.spyOn(managedChatAdmission, "acquireChatTurnLease");
    const ensureReady = jest.fn().mockResolvedValue(true);
    (handler as any).ensureProviderReadyForChat = ensureReady;
    handler.setValue(" \n\t  ");
    chatView.contextManager.getContextFiles.mockClear();

    await handler.submitWithOverrides({ includeContextFiles: true });

    expect(ensureReady).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(onMessageSubmit).not.toHaveBeenCalled();
    expect(aiService.prepareAcceptedChatRequest).not.toHaveBeenCalled();
    expect(aiService.streamMessage).not.toHaveBeenCalled();
    expect(chatView.contextManager.getContextFiles).not.toHaveBeenCalled();
    expect((handler as any).turnLifecycle).toBeNull();
  });

  it("reads only composer emptiness before admission and defers other payload sources until acceptance", async () => {
    const { aiService, chatView, handler } = createHostedToolLoopHarness();
    handler.setValue("accepted payload");
    const input = (handler as unknown as { input: HTMLTextAreaElement }).input;
    let stored = input.value;
    const inputReads: string[] = [];
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => { inputReads.push(stored); return stored; },
      set: (value: string) => { stored = value; },
    });
    const contextGetter = chatView.contextManager.getContextFiles as jest.Mock;
    contextGetter.mockClear();
    const admission = jest.spyOn(managedChatAdmission, "acquireChatTurnLease").mockResolvedValueOnce({ outcome: "unavailable" } as never);
    await handler.submitWithOverrides({ includeContextFiles: true });
    expect(inputReads).toEqual(["accepted payload"]);
    expect(contextGetter).not.toHaveBeenCalled();

    admission.mockRestore();
    inputReads.length = 0;
    jest.spyOn(handler as never, "streamAssistantTurn" as never).mockResolvedValue({
      messageId: "assistant", message: { role: "assistant", content: "done", message_id: "assistant" },
      messageEl: document.createElement("div"), completed: true, completionState: "completed",
    } as never);
    await handler.submitWithOverrides({ includeContextFiles: true });
    expect(inputReads.filter((value) => value === "accepted payload")).toHaveLength(1);
    expect(contextGetter).toHaveBeenCalledTimes(1);
    expect(aiService.prepareAcceptedChatRequest).toHaveBeenCalledTimes(1);
  });

  it("does not create a lifecycle or stream when a durable commit is no longer current", async () => {
    const { handler, messages } = createHostedToolLoopHarness();
    handler.setValue("old chat message");
    const acceptedMessage = { role: "user", content: "old chat message", message_id: "durable-old" } as ChatMessage;
    const snapshot = Object.freeze({ chatId: "old-chat", version: 2, messages: Object.freeze([acceptedMessage]) });
    (handler as any).commitAcceptedUserMessage = jest.fn(async () => Object.freeze({ status: "accepted_not_current", snapshot, message: acceptedMessage }));
    (handler as any).claimAcceptedUserCommit = jest.fn(() => false);
    const stream = jest.spyOn(handler as any, "streamAssistantTurn");
    await handler.submitWithOverrides({ includeContextFiles: false });
    expect((handler as any).turnLifecycle).toBeNull();
    expect(stream).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it("rejects a concurrent submission before consuming input, admission, commit, or stream", async () => {
    const { aiService, handler, onMessageSubmit } = createHostedToolLoopHarness();
    (handler as any).turnLifecycle = new ChatTurnLifecycleController({ getIsGenerating: () => false, setGenerating: jest.fn() });
    let settle!: () => void;
    const activeReady = new Promise<void>((resolve) => {
      void (handler as any).turnLifecycle.runTurn(async () => {
        resolve();
        await new Promise<void>((done) => { settle = done; });
      });
    });
    await activeReady;
    handler.setValue("keep this draft");

    await expect(handler.submitForAutomation()).rejects.toEqual(expect.objectContaining({
      code: "chat_turn_already_active",
    }));
    expect(handler.getValue()).toBe("keep this draft");
    expect(onMessageSubmit).not.toHaveBeenCalled();
    expect(aiService.streamMessage).not.toHaveBeenCalled();

    settle();
    await (handler as any).turnLifecycle.stop();
  });

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
      signal: expect.any(AbortSignal),
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

  it("surfaces an unrecoverable empty hosted turn instead of silently succeeding", async () => {
    const { handler, onError } = createHostedToolLoopHarness();

    const streamAssistantTurn = jest.spyOn(handler as any, "streamAssistantTurn").mockResolvedValue({
      messageId: "assistant-empty",
      message: {
        role: "assistant",
        content: "",
        message_id: "assistant-empty",
      } as any,
      messageEl: document.createElement("div"),
      completed: false,
      completionState: "no_events",
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
    expect(onError.mock.calls[0]?.[0]?.metadata).toEqual(
      expect.objectContaining({
        recoverCommittedTurn: true,
        reason: "empty-response",
        latestStreamCompletionState: "no_events",
        committedPhase: "submitted_user",
      })
    );
    expect(streamAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it("surfaces a toolUse stop with no tool calls instead of stalling silently (#210, #146)", async () => {
    const { aiService, handler, onError } = createHostedToolLoopHarness();

    // The model signals it wants a tool (stopReason "toolUse") but no tool call
    // materialised on the message — the #146 continuation-failure shape. The
    // turn must surface an actionable error, not end silently after one round.
    const streamAssistantTurn = jest
      .spyOn(handler as any, "streamAssistantTurn")
      .mockResolvedValue({
        messageId: "assistant-tooluse-empty",
        message: {
          role: "assistant",
          content: "Let me read that file for you.",
          message_id: "assistant-tooluse-empty",
          tool_calls: [],
        } as any,
        messageEl: document.createElement("div"),
        completed: true,
        completionState: "completed",
        stopReason: "toolUse",
      });

    handler.setValue("Read my note.");

    await expect(
      handler.submitForAutomation({
        includeContextFiles: false,
        approvalMode: "auto-approve",
        focusAfterSend: false,
      })
    ).rejects.toThrow(/tool call/i);

    expect(streamAssistantTurn).toHaveBeenCalledTimes(1);
    expect(aiService.executeHostedToolCall).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.metadata).toEqual(
      expect.objectContaining({
        recoverCommittedTurn: true,
        reason: "tool-use-without-tool-calls",
        stopReason: "toolUse",
      })
    );
  });

  it("keeps the submitted user message and completed tool result when continuation retries are exhausted", async () => {
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
              name: "mcp-filesystem_read",
              arguments: "{\"paths\":[\"alpha.md\"]}",
            },
          },
          state: "executing",
          timestamp: 1,
          executionStartedAt: 1,
        },
      ],
      messageParts: [],
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
      .mockResolvedValue({
        messageId: "assistant-empty-continuation",
        message: {
          role: "assistant",
          content: "",
          message_id: "assistant-empty-continuation",
        } as any,
        messageEl: document.createElement("div"),
        completed: false,
        completionState: "empty_after_seed",
      });

    handler.setValue("Read the note and summarize it.");

    await expect(
      handler.submitForAutomation({
        includeContextFiles: false,
        approvalMode: "auto-approve",
        focusAfterSend: false,
      })
    ).rejects.toThrow("empty continuation");

    expect(streamAssistantTurn).toHaveBeenCalledTimes(2);
    expect(aiService.executeHostedToolCall).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Read the note and summarize it.",
        }),
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
      ])
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.metadata).toEqual(
      expect.objectContaining({
        recoverCommittedTurn: true,
        reason: "empty-continuation",
        latestStreamCompletionState: "empty_after_seed",
        committedPhase: "tool_execution_committed",
        completedToolCount: 1,
        committedAssistantMessageId: "assistant-1",
      })
    );
  });

  it("uses one managed admission result and fails automation before payload preparation", async () => {
    const { aiService, handler } = createHostedToolLoopHarness();
    const admission = jest.fn().mockResolvedValue({
      outcome: "license_required",
      lease: { outcome: "license_required" },
    });
    (handler as any).managedChatAdmission = { acquireChatTurnLease: admission };
    handler.setValue("blocked before preparation");

    await expect(handler.submitForAutomation()).rejects.toThrow(
      "Activate your SystemSculpt license in Account",
    );

    expect(admission).toHaveBeenCalledTimes(1);
    expect(aiService.prepareAcceptedChatRequest).not.toHaveBeenCalled();
  });

  it("auto-approves destructive hosted tool calls during automation when configured", async () => {
    const app = new App();
    const container = document.createElement("div");
    const chatContainer = document.createElement("div");
    container.appendChild(chatContainer);

    const handler = new InputHandler({
      managedChatAdmission,
      commitAcceptedUserMessage: (input) => commitAccepted([], input),
      claimAcceptedUserCommit: () => true,
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
      managedChatAdmission,
      commitAcceptedUserMessage: (input) => commitAccepted([], input),
      claimAcceptedUserCommit: () => true,
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

  it("marks an unknown tool outcome terminal even when the caller signal is not aborted", async () => {
    const { handler, aiService } = createHostedToolLoopHarness();
    aiService.executeHostedToolCall.mockResolvedValue({
      success: false,
      error: {
        code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN",
        message: "Outcome unknown",
      },
    });
    const message = {
      role: "assistant",
      content: "",
      message_id: "assistant-unknown",
      tool_calls: [{
        id: "call_unknown",
        messageId: "assistant-unknown",
        request: {
          id: "call_unknown",
          type: "function",
          function: { name: "mcp-filesystem_write", arguments: "{}" },
        },
        state: "executing",
        timestamp: 1,
      }],
    } as any;

    await (handler as any).executeHostedToolCall(message.tool_calls[0], new AbortController().signal);

    expect(message.tool_calls[0].result.error.code).toBe("TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN");
    expect(message.tool_calls[0].state).toBe("failed");
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
      managedChatAdmission,
      commitAcceptedUserMessage: (input) => commitAccepted([], input),
      claimAcceptedUserCommit: () => true,
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

});
