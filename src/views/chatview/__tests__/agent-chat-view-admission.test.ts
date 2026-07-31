/**
 * @jest-environment jsdom
 */

import { App, TFile } from "obsidian";
import { AgentChatView } from "../AgentChatView";
import { AgentTranscriptRepository } from "../AgentTranscriptRepository";
import {
  AgentComposer,
  type AgentComposerSubmit,
} from "../AgentComposer";
import { AgentWorkspace } from "../AgentWorkspace";
import { ChatStorageService } from "../ChatStorageService";
import type { ChatMessageAttachment } from "../attachments/ChatMessageAttachments";
import type {
  FirstPartyAgentRunInput,
  FirstPartyAgentRunResult,
} from "../thin/FirstPartyAgentChatSession";
import type { ChatMessage } from "../../../types";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    parseYaml: jest.fn((yaml: string) => Object.fromEntries(
      yaml
        .split("\n")
        .map((line) => line.match(/^(\w+):\s*(.+)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => {
          try {
            return [match[1], JSON.parse(match[2])];
          } catch {
            return [match[1], match[2].trim()];
          }
        }),
    )),
    stringifyYaml: jest.fn((value: Record<string, unknown>) => Object.entries(value)
      .map(([key, entry]) => `${key}: ${JSON.stringify(entry)}`)
      .join("\n") + "\n"),
  };
});

const ORIGINAL_ATTACHMENT: ChatMessageAttachment = Object.freeze({
  status: "ready",
  id: "original-attachment",
  name: "original.md",
  mimeType: "text/markdown",
  byteLength: 8,
  kind: "text",
  contentPart: {
    type: "text",
    text: "--- BEGIN ATTACHED FILE: original.md (text/markdown) ---\nOriginal\n--- END ATTACHED FILE: original.md ---",
  },
  contentRef: {
    schema: "systemsculpt-chat-attachment-v1",
    payload: "utf8-content-part",
    sha256: "a".repeat(64),
    byteLength: 8,
  },
});

const NEWER_ATTACHMENT: ChatMessageAttachment = Object.freeze({
  status: "ready",
  id: "newer-attachment",
  name: "newer.md",
  mimeType: "text/markdown",
  byteLength: 5,
  kind: "text",
  contentPart: {
    type: "text",
    text: "--- BEGIN ATTACHED FILE: newer.md (text/markdown) ---\nNewer\n--- END ATTACHED FILE: newer.md ---",
  },
  contentRef: {
    schema: "systemsculpt-chat-attachment-v1",
    payload: "utf8-content-part",
    sha256: "b".repeat(64),
    byteLength: 5,
  },
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function failedRun(code: string, message: string): FirstPartyAgentRunResult {
  return {
    kind: "failed",
    snapshot: {
      runId: "run-admission",
      turnId: "user-admission",
      status: "failed",
      messages: [],
      parts: [],
      terminalError: { code, message },
    },
    error: { code, message },
  };
}

function createHarness(failure: "before-start" | "before-commit" | "after-commit") {
  const parent = document.body.createDiv();
  const builtBodies: Array<Record<string, unknown> | undefined> = [];
  const runGate = deferred();
  const runStarted = deferred<FirstPartyAgentRunInput>();
  const runFinished = deferred();
  const durableMessages: ChatMessage[] = [];
  const snapshot = () => ({
    chatId: durableMessages.length > 0 ? "durable-chat" : "",
    title: "Admission test",
    version: durableMessages.length,
    messages: [...durableMessages],
    contextFiles: [],
  });
  const transcript = {
    snapshot: jest.fn(snapshot),
    setTitle: jest.fn(),
    commitUser: jest.fn(async (input: { message: ChatMessage }) => {
      if (failure === "before-commit") throw new Error("disk full");
      durableMessages.push(input.message);
      return snapshot();
    }),
  };
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
  const composer = new AgentComposer(parent, {
    onSubmit: (submission) => (
      view as unknown as { acceptComposerSubmission: (value: AgentComposerSubmit) => void }
    ).acceptComposerSubmission(submission),
    onStop: jest.fn(),
    onAttach: jest.fn(),
    onRemoveAttachment: jest.fn(),
  });
  composer.load();

  let setHistoryCalls = 0;
  const restoreRejectedSubmission = jest.fn((submission: AgentComposerSubmit) => {
    composer.restoreRejectedSubmission(submission);
  });
  const workspace = {
    setHistory: jest.fn(async () => {
      setHistoryCalls += 1;
      // Call order: (1) baseline history, (2) optimistic user bubble at
      // admission, (3) durable render after commitUserTurn.
      if (failure === "after-commit" && setHistoryCalls === 3) {
        throw new Error("render failed after durable commit");
      }
    }),
    setAgentSnapshot: jest.fn(async () => undefined),
    setRunPending: jest.fn((pending: boolean) => {
      if (!pending) runFinished.resolve();
    }),
    setBanner: jest.fn(),
    settleCompletedRun: jest.fn(async () => undefined),
    restoreRejectedSubmission,
    resetMessageEditor: jest.fn(),
  };
  const agent = {
    start: jest.fn((input: FirstPartyAgentRunInput) => {
      runStarted.resolve(input);
      return runGate.promise.then(async () => {
        builtBodies.push(await input.buildBody?.(new AbortController().signal));
        try {
          await input.beforeSend?.();
        } catch {
          return failedRun("agent_local_commit_failed", "The local user turn could not be saved.");
        }
        return failedRun("agent_provider_failed", "The admitted run failed later.");
      });
    }),
    disconnect: jest.fn(),
    stageContext: jest.fn(async () => ({
      context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })),
  };

  Object.assign(view, {
    workspace,
    transcript,
    agent,
    builtBodies,
    attachmentStore: {
      hydrateMessage: jest.fn(async (message: ChatMessage) => {
        if (failure === "before-start") throw new Error("attachment hydration failed");
        return message;
      }),
    },
    contextManager: { getPinnedFiles: jest.fn(() => []) },
    plugin: { settings: { licenseKey: "test-license" } },
    automationApprovalMode: "interactive",
    approvalMode: "ask",
    sessionTrustedToolNames: new Set<string>(),
    queuedFollowUps: [],
    conversationOriginToken: "origin-admission",
    runConversationOrigins: new Map<string, string>(),
    suppressQueueDrain: false,
    pendingRetry: null,
    pendingThinConversationId: null,
    thinClientId: `client_${"c".repeat(32)}`,
    chatId: "",
    chatTitle: "New chat",
    readThinAgentContextSources: jest.fn(async () => []),
    getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
    applyTranscriptIdentity: jest.fn(),
    bindQueueToChat: jest.fn(async () => undefined),
    updateViewState: jest.fn(),
  });

  return {
    agent,
    builtBodies,
    composer,
    durableMessages,
    parent,
    restoreRejectedSubmission,
    runFinished,
    runGate,
    runStarted,
    view,
    workspace,
  };
}

function createHistoricalResubmitHarness(
  initialMessages: ChatMessage[],
  targetIndex: number,
  failBeforeCommit = false,
  agentConversationId: string | null =
    "conversation_11111111111111111111111111111111",
) {
  const oldConversationId = agentConversationId ?? undefined;
  let durableMessages = initialMessages.map((message) => ({ ...message }));
  let version = 12;
  const operationOrder: string[] = [];
  const snapshot = () => ({
    chatId: "2026-07-30 08-02-11",
    title: "Saved chat",
    version,
    ...(oldConversationId ? { agentConversationId: oldConversationId } : {}),
    messages: durableMessages.map((message) => ({ ...message })),
  });
  const transcript = {
    snapshot: jest.fn(snapshot),
    setTitle: jest.fn(),
    commitUser: jest.fn(async (input: any, conversationId: string) => {
      operationOrder.push("commit");
      expect(input.expectedVersion).toBe(version);
      if (input.kind === "resend") {
        durableMessages = [
          ...durableMessages.slice(0, input.expectedIndex),
          input.message,
        ];
      } else {
        durableMessages = [...durableMessages, input.message];
      }
      version += 1;
      return { ...snapshot(), agentConversationId: conversationId };
    }),
    reconcileServerHistory: jest.fn(async (messages: readonly ChatMessage[]) => {
      operationOrder.push("reconcile");
      durableMessages = messages.map((message) => ({ ...message }));
      version += 1;
      return snapshot();
    }),
  };
  const logger = { warn: jest.fn(), error: jest.fn() };
  const recordLifecycle = jest.fn();
  const workspace = {
    setHistory: jest.fn(async () => undefined),
    setAgentSnapshot: jest.fn(async () => undefined),
    setRunPending: jest.fn(),
    setBanner: jest.fn(),
    setComposerReadOnly: jest.fn(),
    settleCompletedRun: jest.fn(async () => undefined),
    restoreRejectedSubmission: jest.fn(),
    resetMessageEditor: jest.fn(),
  };
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
  const agent = {
    disconnect: jest.fn(),
    recordLifecycle,
    start: jest.fn((input: FirstPartyAgentRunInput) => (async (): Promise<FirstPartyAgentRunResult> => {
      const bootstrapPrefix = initialMessages.slice(0, targetIndex);
      await (view as any).reconcileAgentHistory(bootstrapPrefix);
      if (failBeforeCommit) {
        return failedRun("agent_bootstrap_failed", "Could not start the edited response.");
      }
      await input.beforeSend?.();
      await (view as any).reconcileAgentHistory(transcript.snapshot().messages);
      return {
        kind: "cancelled",
        snapshot: {
          runId: "run-resubmit",
          turnId: input.turnId,
          status: "cancelled",
          messages: [],
          parts: [],
        },
      };
    })()),
  };
  Object.assign(view, {
    workspace,
    transcript,
    agent,
    attachmentStore: {
      hydrateMessage: jest.fn(async (message: ChatMessage) => message),
    },
    contextManager: { getPinnedFiles: jest.fn(() => []) },
    plugin: {
      settings: { licenseKey: "test-license" },
      getLogger: () => logger,
    },
    automationApprovalMode: "interactive",
    approvalMode: "ask",
    sessionTrustedToolNames: new Set<string>(),
    queuedFollowUps: [],
    conversationOriginToken: "origin-resubmit",
    runConversationOrigins: new Map<string, string>(),
    suppressQueueDrain: true,
    pendingRetry: null,
    pendingRejectedRetry: null,
    pendingThinConversationId: null,
    thinBootstrapRequest: null,
    pendingForkHistory: null,
    thinClientId: `client_${"c".repeat(32)}`,
    chatId: "2026-07-30 08-02-11",
    chatTitle: "Saved chat",
    readThinAgentContextSources: jest.fn(async () => []),
    getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
    applyTranscriptIdentity: jest.fn(),
    bindQueueToChat: jest.fn(async () => undefined),
    updateViewState: jest.fn(),
  });

  return {
    agent,
    get durableMessages() { return durableMessages; },
    logger,
    oldConversationId,
    operationOrder,
    recordLifecycle,
    transcript,
    view,
    workspace,
  };
}

async function createPersistentHistoricalResubmitHarness(
  options: Readonly<{
    failBeforeCommit?: boolean;
    initialMessages?: readonly ChatMessage[];
  }> = {},
) {
  const chatDirectory = "SystemSculpt/Chats";
  const chatId = "2026-07-30 08-02-11";
  const oldConversationId = "conversation_11111111111111111111111111111111";
  const initialMessages: ChatMessage[] = options.initialMessages
    ? options.initialMessages.map((message) => ({ ...message }))
    : [
        { role: "user", content: "Original request", message_id: "user-original" },
        { role: "assistant", content: "Original answer", message_id: "assistant-original" },
        { role: "user", content: "Later request", message_id: "user-later" },
        { role: "assistant", content: "Later answer", message_id: "assistant-later" },
      ];
  const files = new Map<string, { file: TFile; content: string }>();
  let rejectedModifyCount = 0;
  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
    read: jest.fn(async (file: TFile) => files.get(file.path)?.content ?? ""),
    modify: jest.fn(async (file: TFile, content: string) => {
      if (rejectedModifyCount > 0) {
        rejectedModifyCount -= 1;
        throw new Error("disk unavailable");
      }
      const stored = files.get(file.path);
      if (!stored) throw new Error(`Missing file: ${file.path}`);
      stored.content = content;
    }),
    create: jest.fn(async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      const file = new TFile({ path });
      files.set(path, { file, content });
      return file;
    }),
    createFolder: jest.fn(async () => undefined),
    adapter: {
      exists: jest.fn(async (path: string) => path === chatDirectory || files.has(path)),
      mkdir: jest.fn(async () => undefined),
      readBinary: jest.fn(async () => new ArrayBuffer(0)),
      writeBinary: jest.fn(async () => undefined),
    },
  };
  const app = new App();
  Object.assign(app, {
    vault,
    plugins: { plugins: {} },
  });
  const storage = new ChatStorageService(app, chatDirectory);
  await storage.saveChat(chatId, initialMessages, {
    title: "Saved chat",
    agentConversationId: oldConversationId,
  });
  const saveChat = jest.spyOn(storage, "saveChat");
  const transcript = new AgentTranscriptRepository(storage, () => ({
    title: "Saved chat",
    contextFiles: new Set<string>(),
    chatFontSize: "medium" as const,
    approvalMode: "ask" as const,
  }));
  const loaded = await transcript.load(chatId);
  if (!loaded) throw new Error("Persistent resubmit harness could not load its chat.");

  const logger = { warn: jest.fn(), error: jest.fn() };
  const workspace = {
    setHistory: jest.fn(async () => undefined),
    setAgentSnapshot: jest.fn(async () => undefined),
    setRunPending: jest.fn(),
    setBanner: jest.fn(),
    setTitle: jest.fn(),
    setComposerReadOnly: jest.fn(),
    settleCompletedRun: jest.fn(async () => undefined),
    restoreRejectedSubmission: jest.fn(),
    resetMessageEditor: jest.fn(),
    showMessageEditor: jest.fn(async () => undefined),
    hideMessageEditor: jest.fn(async () => undefined),
  };
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
  const replacementAssistant: ChatMessage = {
    role: "assistant",
    content: "Replacement answer",
    message_id: "assistant-replacement",
  };
  const agent = {
    getSnapshot: jest.fn(() => null),
    disconnect: jest.fn(),
    recordLifecycle: jest.fn(),
    stageContext: jest.fn(async () => ({
      context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })),
    start: jest.fn((input: FirstPartyAgentRunInput) => (async (): Promise<FirstPartyAgentRunResult> => {
      // This is the exact fork bootstrap that produced the screenshot failure:
      // editing the first user turn means the validated server prefix is empty.
      await (view as any).reconcileAgentHistory([]);
      if (options.failBeforeCommit) {
        return failedRun(
          "agent_bootstrap_failed",
          "The edited response could not be started.",
        );
      }
      try {
        await input.beforeSend?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : "The edited turn could not be saved.";
        return failedRun("message_save_failed", message);
      }
      await (view as any).reconcileAgentHistory(transcript.snapshot().messages);
      await (view as any).reconcileAgentHistory([
        ...transcript.snapshot().messages,
        replacementAssistant,
      ]);
      return {
        kind: "completed",
        snapshot: {
          runId: "run-resubmit-persistent",
          turnId: input.turnId,
          status: "completed",
          messages: [],
          parts: [],
        },
        message: replacementAssistant,
      };
    })()),
  };
  Object.assign(view, {
    app,
    workspace,
    transcript,
    agent,
    attachmentStore: {
      hydrateMessage: jest.fn(async (message: ChatMessage) => message),
    },
    contextManager: { getPinnedFiles: jest.fn(() => []) },
    plugin: {
      settings: { licenseKey: "test-license" },
      getLogger: () => logger,
    },
    automationApprovalMode: "interactive",
    approvalMode: "ask",
    sessionTrustedToolNames: new Set<string>(),
    activeSubmissionOperation: null,
    queuedFollowUps: [],
    queueDrainSuppressionDepth: 0,
    conversationOriginToken: "origin-resubmit-persistent",
    runConversationOrigins: new Map<string, string>(),
    pendingRetry: null,
    pendingRejectedRetry: null,
    pendingThinConversationId: oldConversationId,
    thinBootstrapRequest: null,
    pendingForkHistory: null,
    legacyHistoryViewOnly: false,
    messageEditGeneration: 0,
    thinClientId: `client_${"c".repeat(32)}`,
    chatId,
    chatTitle: "Saved chat",
    readThinAgentContextSources: jest.fn(async () => []),
    getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
    prepareSubmission: jest.fn(async (submission: AgentComposerSubmit) => submission),
    bindQueueToChat: jest.fn(async () => undefined),
    updateViewState: jest.fn(),
  });

  return {
    agent,
    app,
    chatId,
    initialMessages,
    loaded,
    oldConversationId,
    rejectNextModify: () => { rejectedModifyCount += 1; },
    replacementAssistant,
    saveChat,
    storage,
    transcript,
    view,
    workspace,
  };
}

async function confirmHistoricalResubmit(
  view: AgentChatView,
  messageIdToResubmit: string,
  text: string,
): Promise<boolean> {
  const result = (view as any).resubmitMessage(messageIdToResubmit, text) as Promise<boolean>;
  await Promise.resolve();
  const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent === "Resubmit");
  if (!confirm) throw new Error("Historical resubmit confirmation was not shown.");
  confirm.click();
  return result;
}

function createSavedChatLoadHarness(
  messages: ChatMessage[],
  options: Readonly<{
    agentConversationId?: string;
    hydrate?: () => Promise<void>;
  }> = {},
) {
  const app = new App();
  const loaded = {
    chatId: "legacy-chat",
    title: "Older saved chat",
    version: 3,
    messages,
    contextFiles: [] as string[],
    approvalMode: "ask" as const,
    ...(options.agentConversationId
      ? { agentConversationId: options.agentConversationId }
      : {}),
  };
  const workspace = {
    setRunPending: jest.fn(),
    setBanner: jest.fn(),
    resetMessageEditor: jest.fn(),
    setApprovalMode: jest.fn(),
    setTitle: jest.fn(),
    setHistory: jest.fn(async () => undefined),
    setAgentSnapshot: jest.fn(async () => undefined),
    setComposerReadOnly: jest.fn(),
  };
  const agent = {
    cancel: jest.fn(async () => undefined),
    disconnect: jest.fn(),
    hydrate: jest.fn(options.hydrate ?? (async () => undefined)),
    getSnapshot: jest.fn(() => ({ status: "idle" })),
  };
  const transcript = {
    load: jest.fn(async () => loaded),
    saveMetadata: jest.fn(async () => loaded),
    snapshot: jest.fn(() => loaded),
  };
  const logger = { error: jest.fn() };
  const prepareThinConversation = jest.fn(async () => undefined);
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
  Object.assign(view, {
    app,
    activeSubmissionOperation: null,
    conversationOriginToken: "origin-before-load",
    messageEditGeneration: 0,
    pendingRetry: null,
    pendingRejectedRetry: null,
    queuedFollowUps: [],
    queueHydrated: false,
    queuePersistence: Promise.resolve(),
    pendingForkHistory: null,
    deferredRecoveredCompletion: null,
    pendingThinConversationId: null,
    thinBootstrapRequest: null,
    sessionTrustedToolNames: new Set<string>(),
    legacyHistoryViewOnly: false,
    chatId: "previous-chat",
    chatTitle: "Previous chat",
    chatVersion: 2,
    chatFontSize: "medium",
    approvalMode: "ask",
    isFullyLoaded: true,
    plugin: { getLogger: () => logger },
    workspace,
    agent,
    transcript,
    contextManager: {
      setPinnedFiles: jest.fn(async () => undefined),
    },
    hydrateQueue: jest.fn(async () => undefined),
    applyFontSize: jest.fn(),
    applyTranscriptIdentity: jest.fn((snapshot: typeof loaded) => {
      (view as any).chatId = snapshot.chatId;
      (view as any).chatTitle = snapshot.title;
      (view as any).chatVersion = snapshot.version;
    }),
    syncAttachments: jest.fn(),
    updateViewState: jest.fn(),
    getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
    prepareThinConversation,
  });
  return { agent, loaded, logger, transcript, view, prepareThinConversation, workspace };
}

function cachedExecutingToolHistory(): ChatMessage[] {
  const tool = {
    id: "call-cached-write",
    messageId: "assistant-cached-write",
    request: {
      id: "call-cached-write",
      type: "function" as const,
      function: {
        name: "write",
        arguments: JSON.stringify({ path: "Cached.md", content: "Pending" }),
      },
    },
    state: "executing" as const,
    timestamp: 2,
    executionStartedAt: 3,
  };
  return [{
    role: "user",
    content: "Write the cached note",
    message_id: "user-cached-write",
  }, {
    role: "assistant",
    content: "",
    message_id: "assistant-cached-write",
    tool_calls: [tool],
    messageParts: [{
      id: "tool:call-cached-write",
      type: "tool_call",
      timestamp: 2,
      data: tool,
    }],
  }];
}

describe("AgentChatView composer admission", () => {
  afterEach(() => {
    document.body.empty();
  });

  it("merges text and attachments back when local transcript persistence rejects before admission", async () => {
    const harness = createHarness("before-commit");
    harness.composer.setValue("Original request");
    harness.composer.restoreMessageAttachments([ORIGINAL_ATTACHMENT]);

    await (harness.composer as unknown as { submit: () => Promise<void> }).submit();
    await harness.runStarted.promise;
    expect(harness.composer.getValue()).toBe("");
    expect(harness.composer.getMessageAttachments()).toEqual([]);

    harness.composer.setValue("Newer draft typed while saving");
    harness.composer.restoreMessageAttachments([NEWER_ATTACHMENT]);
    harness.runGate.resolve();

    await harness.runFinished.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.durableMessages).toEqual([]);
    expect(harness.restoreRejectedSubmission).toHaveBeenCalledTimes(1);
    expect(harness.composer.getValue()).toBe(
      "Original request\n\nNewer draft typed while saving",
    );
    expect(harness.composer.getMessageAttachments()).toEqual([
      ORIGINAL_ATTACHMENT,
      NEWER_ATTACHMENT,
    ]);
    harness.composer.unload();
  });

  it("clears pending state and restores the draft when pre-start preparation fails", async () => {
    const harness = createHarness("before-start");
    harness.composer.setValue("Original request");
    harness.composer.restoreMessageAttachments([ORIGINAL_ATTACHMENT]);

    await (harness.composer as unknown as { submit: () => Promise<void> }).submit();
    await harness.runFinished.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.agent.start).not.toHaveBeenCalled();
    expect(harness.restoreRejectedSubmission).toHaveBeenCalledTimes(1);
    expect(harness.composer.getValue()).toBe("Original request");
    expect(harness.composer.getMessageAttachments()).toEqual([ORIGINAL_ATTACHMENT]);
    harness.composer.unload();
  });

  it("does not restore an admitted draft when a later local projection failure terminalizes the run", async () => {
    const harness = createHarness("after-commit");
    harness.composer.setValue("Original request");
    harness.composer.restoreMessageAttachments([ORIGINAL_ATTACHMENT]);

    await (harness.composer as unknown as { submit: () => Promise<void> }).submit();
    await harness.runStarted.promise;
    harness.composer.setValue("Newer draft");
    harness.composer.restoreMessageAttachments([NEWER_ATTACHMENT]);
    harness.runGate.resolve();

    await harness.runFinished.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.durableMessages).toHaveLength(1);
    expect(harness.durableMessages[0]).toMatchObject({
      role: "user",
      message_id: expect.any(String),
    });
    expect(harness.restoreRejectedSubmission).not.toHaveBeenCalled();
    expect(harness.composer.getValue()).toBe("Newer draft");
    expect(harness.composer.getMessageAttachments()).toEqual([NEWER_ATTACHMENT]);
    harness.composer.unload();
  });

  it("omits obsolete web-search preferences from the autonomous thin turn body", async () => {
    const harness = createHarness("before-commit");
    harness.composer.setValue("Research this");

    await (harness.composer as unknown as { submit: () => Promise<void> }).submit();
    await harness.runStarted.promise;
    harness.runGate.resolve();
    await harness.runFinished.promise;

    expect(harness.builtBodies).toEqual([{
      context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }]);
    harness.composer.unload();
  });

  it("rereads the same pinned set on later messages and honors explicit exclusion", async () => {
    const harness = createHarness("before-commit");
    const pinnedFiles = new Set(["[[Projects/Plan.md]]", "[[Notes/Brief.md]]"]);
    const getPinnedFiles = jest.fn(() => pinnedFiles);
    const capturedPinnedSets: string[][] = [];
    const readThinAgentContextSources = jest.fn(async (entries: ReadonlySet<string>) => {
      capturedPinnedSets.push([...entries]);
      return [];
    });
    (harness.view as any).contextManager = { getPinnedFiles };
    (harness.view as any).readThinAgentContextSources = readThinAgentContextSources;
    harness.runGate.resolve();

    await (harness.view as any).executeSubmission(
      { text: "First message", mode: "send" },
      { expectedConversationOriginToken: "origin-admission" },
    );
    await (harness.view as any).executeSubmission(
      { text: "Later message", mode: "send" },
      { expectedConversationOriginToken: "origin-admission" },
    );
    await (harness.view as any).executeSubmission(
      { text: "Do not include pinned files", mode: "send" },
      {
        expectedConversationOriginToken: "origin-admission",
        includeContextFiles: false,
      },
    );

    expect(capturedPinnedSets).toEqual([
      ["[[Projects/Plan.md]]", "[[Notes/Brief.md]]"],
      ["[[Projects/Plan.md]]", "[[Notes/Brief.md]]"],
      [],
    ]);
    expect(getPinnedFiles).toHaveBeenCalledTimes(2);
    harness.composer.unload();
  });

  it("does not pin a file merely because the agent read it", async () => {
    const pinnedFiles = new Set(["[[Projects/Plan.md]]"]);
    const contextManager = {
      getPinnedFiles: jest.fn(() => pinnedFiles),
      pinFile: jest.fn(),
      unpinFile: jest.fn(),
    };
    const workspace = {
      setAgentSnapshot: jest.fn(async () => undefined),
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      contextManager,
      workspace,
      conversationOriginToken: "origin-read",
      runConversationOrigins: new Map([["user-read", "origin-read"]]),
    });

    (view as any).renderAgentSnapshot({
      runId: "run-read",
      turnId: "user-read",
      status: "running",
      messages: [{
        id: "assistant-read",
        role: "assistant",
        partIds: ["tool-read"],
      }],
      parts: [{
        id: "tool-read",
        kind: "tool",
        messageId: "assistant-read",
        callId: "call-read",
        name: "read",
        location: "vault",
        input: { paths: ["Notes/Evidence.md"] },
        state: "succeeded",
        order: 0,
      }],
    });
    await Promise.resolve();

    expect(workspace.setAgentSnapshot).toHaveBeenCalledTimes(1);
    expect(contextManager.pinFile).not.toHaveBeenCalled();
    expect(contextManager.unpinFile).not.toHaveBeenCalled();
    expect([...contextManager.getPinnedFiles()]).toEqual(["[[Projects/Plan.md]]"]);
  });

  it("retries a pre-commit failure from the inline error without resending the newer draft", async () => {
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    let inputText = "Original request\n\nNewer draft typed while saving";
    let messageAttachments: ChatMessageAttachment[] = [ORIGINAL_ATTACHMENT, NEWER_ATTACHMENT];
    const executeSubmission = jest.fn(async () => undefined);
    const handleError = jest.fn(async () => undefined);
    Object.assign(view, {
      transcript: {
        snapshot: jest.fn(() => ({
          version: 0,
          messages: [],
        })),
      },
      pendingRejectedRetry: {
        turnId: "user-precommit",
        submission: {
          text: "Original request",
          mode: "send",
          attachments: [ORIGINAL_ATTACHMENT],
        },
      },
      workspace: {
        getMessageAttachments: jest.fn(() => messageAttachments),
        setMessageAttachments: jest.fn((attachments: readonly ChatMessageAttachment[]) => {
          messageAttachments = [...attachments];
        }),
        restoreRejectedSubmission: jest.fn(),
        focus: jest.fn(),
      },
      getInputText: jest.fn(() => inputText),
      setInputText: jest.fn((value: string) => {
        inputText = value;
      }),
      executeSubmission,
      handleError,
      conversationOriginToken: "origin-retry",
    });

    await (view as any).prepareRetry("user-precommit");

    expect(executeSubmission).toHaveBeenCalledWith(
      {
        text: "Original request",
        mode: "send",
        attachments: [ORIGINAL_ATTACHMENT],
      },
      {
        expectedConversationOriginToken: "origin-retry",
      },
    );
    expect(inputText).toBe("Newer draft typed while saving");
    expect(messageAttachments).toEqual([NEWER_ATTACHMENT]);
    expect(handleError).not.toHaveBeenCalled();
  });

  it("consumes an exact text-only rejected draft before retrying it", async () => {
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    let inputText = "Original request";
    const executeSubmission = jest.fn(async () => undefined);
    Object.assign(view, {
      transcript: {
        snapshot: jest.fn(() => ({
          version: 0,
          messages: [],
        })),
      },
      pendingRejectedRetry: {
        turnId: "user-text-only",
        submission: {
          text: "Original request",
          mode: "send",
        },
      },
      workspace: {
        getMessageAttachments: jest.fn(() => []),
        setMessageAttachments: jest.fn(),
        restoreRejectedSubmission: jest.fn(),
        focus: jest.fn(),
      },
      getInputText: jest.fn(() => inputText),
      setInputText: jest.fn((value: string) => {
        inputText = value;
      }),
      executeSubmission,
      handleError: jest.fn(),
      conversationOriginToken: "origin-retry",
    });

    await (view as any).prepareRetry("user-text-only");

    expect(executeSubmission).toHaveBeenCalledWith(
      {
        text: "Original request",
        mode: "send",
      },
      {
        expectedConversationOriginToken: "origin-retry",
      },
    );
    expect(inputText).toBe("");
  });

  it("directly forks and retries the current failed turn without opening the message editor", async () => {
    const harness = await createPersistentHistoricalResubmitHarness({
      initialMessages: [{
        role: "user",
        content: "Original request",
        message_id: "user-original",
      }],
    });
    (harness.agent.getSnapshot as jest.Mock).mockReturnValue({
      runId: "run-capacity-failed",
      turnId: "user-original",
      status: "failed",
      phase: "complete",
      terminalError: {
        code: "response_capacity_unavailable",
        message: "SystemSculpt does not currently have enough service capacity.",
        retryable: true,
      },
      messages: [{
        id: "assistant-partial",
        role: "assistant",
        partIds: ["text:assistant-partial:0"],
      }],
      parts: [{
        id: "text:assistant-partial:0",
        kind: "text",
        messageId: "assistant-partial",
        state: "complete",
        markdown: "A harmless partial response.",
        order: 0,
      }],
    });

    await (harness.view as any).retryFailedTurn("user-original");

    expect(harness.workspace.showMessageEditor).not.toHaveBeenCalled();
    expect(harness.agent.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.agent.start).toHaveBeenCalledTimes(1);
    expect((harness.view as any).thinBootstrapRequest).toMatchObject({
      fork: {
        source_conversation_id: harness.oldConversationId,
        before_message_id: "user-original",
      },
    });
    const retryInput = (harness.agent.start as jest.Mock).mock.calls[0][0];
    expect(retryInput.message).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Original request" }],
    });
    expect(harness.transcript.snapshot().messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Original request",
        message_id: expect.not.stringMatching(/^user-original$/),
      }),
      harness.replacementAssistant,
    ]);
  });

  it("keeps a failed-turn retry explicit when replay could repeat a vault mutation", async () => {
    const harness = await createPersistentHistoricalResubmitHarness({
      initialMessages: [{
        role: "user",
        content: "Update the project note",
        message_id: "user-original",
      }],
    });
    (harness.agent.getSnapshot as jest.Mock).mockReturnValue({
      runId: "run-mutation-failed",
      turnId: "user-original",
      status: "failed",
      phase: "complete",
      messages: [{
        id: "assistant-mutation",
        role: "assistant",
        partIds: ["tool:write-1"],
      }],
      parts: [{
        id: "tool:write-1",
        kind: "tool",
        messageId: "assistant-mutation",
        callId: "write-1",
        name: "write",
        location: "vault",
        input: { path: "Project.md", content: "Updated" },
        state: "succeeded",
        order: 0,
      }],
    });

    await (harness.view as any).retryFailedTurn("user-original");

    expect(harness.agent.start).not.toHaveBeenCalled();
    expect(harness.workspace.showMessageEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "user-original",
        text: expect.stringContaining("Update the project note"),
        requiresReplayConfirmation: true,
      }),
    );
  });

  it("does not silently drop an unavailable attachment during failed-turn retry", async () => {
    const harness = await createPersistentHistoricalResubmitHarness({
      initialMessages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Use the attached plan",
        }, {
          type: "text",
          text: "--- BEGIN ATTACHED FILE: plan.md (text/markdown) ---\nPlan content\n--- END ATTACHED FILE: plan.md ---",
        }],
        message_id: "user-original",
        attachmentMetadata: [{
          id: "missing-plan",
          name: "plan.md",
          mimeType: "text/markdown",
          byteLength: 12,
          kind: "text",
          contentPartIndex: 1,
          contentRef: {
            schema: "systemsculpt-chat-attachment-v1",
            payload: "utf8-content-part",
            sha256: "e".repeat(64),
            byteLength: 12,
          },
        }],
      }],
    });
    (harness.agent.getSnapshot as jest.Mock).mockReturnValue({
      runId: "run-attachment-failed",
      turnId: "user-original",
      status: "failed",
      phase: "complete",
      messages: [],
      parts: [],
    });

    await (harness.view as any).retryFailedTurn("user-original");

    expect(harness.agent.start).not.toHaveBeenCalled();
    expect(harness.workspace.showMessageEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "user-original",
        unavailableAttachmentCount: 1,
      }),
    );
  });

  it("drops an ordinary composer admission when New chat wins attachment preparation", async () => {
    const preparation = deferred<AgentComposerSubmit>();
    const prepared: AgentComposerSubmit = {
      text: "Old chat request",
      mode: "send",
      attachments: [ORIGINAL_ATTACHMENT],
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const executeSubmission = jest.fn(async () => undefined);
    const restoreRejectedSubmission = jest.fn();
    const handleError = jest.fn();
    Object.assign(view, {
      conversationOriginToken: "origin-old",
      queuedFollowUps: [],
      prepareSubmission: jest.fn(() => preparation.promise),
      executeSubmission,
      workspace: {
        restoreRejectedSubmission,
        setRunPending: jest.fn(),
        setBanner: jest.fn(),
      },
      handleError,
    });

    (view as any).acceptComposerSubmission(prepared);
    await Promise.resolve();
    expect((view as any).prepareSubmission).toHaveBeenCalledWith(prepared);

    (view as any).conversationOriginToken = "origin-new";
    preparation.resolve(prepared);
    await Promise.resolve();
    await Promise.resolve();

    expect(executeSubmission).not.toHaveBeenCalled();
    expect((view as any).queuedFollowUps).toEqual([]);
    expect(restoreRejectedSubmission).not.toHaveBeenCalled();
    expect(handleError).not.toHaveBeenCalled();
  });

  it("claims preflight synchronously and queues a second composer submission in FIFO order", async () => {
    const preparation = deferred<AgentComposerSubmit>();
    const first: AgentComposerSubmit = {
      text: "First request",
      mode: "send",
      attachments: [ORIGINAL_ATTACHMENT],
    };
    const second: AgentComposerSubmit = {
      text: "Prepared follow-up",
      mode: "queue",
      attachments: [NEWER_ATTACHMENT],
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const executeSubmission = jest.fn(async () => undefined);
    const restoreRejectedSubmission = jest.fn();
    const setRunPending = jest.fn();
    Object.assign(view, {
      conversationOriginToken: "origin-queue",
      queuedFollowUps: [],
      prepareSubmission: jest.fn(() => preparation.promise),
      executeSubmission,
      workspace: {
        restoreRejectedSubmission,
        setRunPending,
        setBanner: jest.fn(),
      },
      handleError: jest.fn(),
      syncQueue: jest.fn(),
      scheduleQueuePersistence: jest.fn(),
    });

    (view as any).acceptComposerSubmission(first);
    expect((view as any).activeSubmissionOperation).toBeTruthy();
    expect(setRunPending).toHaveBeenCalledWith(true, expect.stringMatching(/^user-/));
    await expect(view.setApprovalMode("full-access")).rejects.toThrow(
      "Tool access cannot change while SystemSculpt is working.",
    );

    (view as any).acceptComposerSubmission(second);
    expect((view as any).queuedFollowUps).toEqual([
      expect.objectContaining({
        text: "Prepared follow-up",
        attachments: [NEWER_ATTACHMENT],
      }),
    ]);
    expect((view as any).prepareSubmission).toHaveBeenCalledTimes(1);
    expect((view as any).syncQueue).toHaveBeenCalledTimes(1);
    expect((view as any).scheduleQueuePersistence).toHaveBeenCalledTimes(1);
    expect(executeSubmission).not.toHaveBeenCalled();

    await (view as any).stopActiveRun();
    expect((view as any).activeSubmissionOperation).toBeNull();
    expect(setRunPending).toHaveBeenLastCalledWith(false);
    expect(restoreRejectedSubmission).toHaveBeenCalledWith(first);

    preparation.resolve(first);
    await Promise.resolve();
    await Promise.resolve();

    expect(executeSubmission).not.toHaveBeenCalled();
  });

  it("retires an ordinary run when New chat wins without mutating the replacement chat", async () => {
    const runStarted = deferred<FirstPartyAgentRunInput>();
    const runFinished = deferred<FirstPartyAgentRunResult>();
    const durableMessages: ChatMessage[] = [];
    const snapshot = () => ({
      chatId: "",
      title: "Old chat",
      version: durableMessages.length,
      messages: [...durableMessages],
      contextFiles: [],
    });
    const transcript = {
      snapshot: jest.fn(snapshot),
      setTitle: jest.fn(),
      commitUser: jest.fn(async (input: { message: ChatMessage }) => {
        durableMessages.push(input.message);
        return snapshot();
      }),
    };
    const workspace = {
      setHistory: jest.fn(async () => undefined),
      setAgentSnapshot: jest.fn(async () => undefined),
      setRunPending: jest.fn(),
      setBanner: jest.fn(),
      settleCompletedRun: jest.fn(async () => undefined),
      restoreRejectedSubmission: jest.fn(),
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      workspace,
      transcript,
      agent: {
        start: jest.fn((input: FirstPartyAgentRunInput) => {
          runStarted.resolve(input);
          return runFinished.promise;
        }),
        stageContext: jest.fn(async () => ({
          context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        })),
      },
      attachmentStore: {
        hydrateMessage: jest.fn(async (message: ChatMessage) => message),
      },
      contextManager: { getPinnedFiles: jest.fn(() => []) },
      plugin: { settings: { licenseKey: "test-license" } },
      automationApprovalMode: "interactive",
      approvalMode: "ask",
      sessionTrustedToolNames: new Set<string>(),
      queuedFollowUps: [{
        id: "old-queued",
        text: "Do not drain this into the replacement chat",
        includeContextFiles: true,
      }],
      conversationOriginToken: "origin-old",
      runConversationOrigins: new Map<string, string>(),
      suppressQueueDrain: false,
      pendingRetry: null,
      pendingRejectedRetry: null,
      pendingThinConversationId: null,
      thinClientId: `client_${"c".repeat(32)}`,
      chatId: "",
      chatTitle: "Old chat",
      readThinAgentContextSources: jest.fn(async () => []),
      getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
      applyTranscriptIdentity: jest.fn(),
      bindQueueToChat: jest.fn(async () => undefined),
      updateViewState: jest.fn(),
    });

    const execution = (view as any).executeSubmission(
      { text: "Old chat request", mode: "send" },
      { expectedConversationOriginToken: "origin-old" },
    );
    const input = await runStarted.promise;
    expect(workspace.setRunPending).toHaveBeenCalledWith(true, input.turnId);

    workspace.setAgentSnapshot.mockClear();
    workspace.setBanner.mockClear();
    workspace.setHistory.mockClear();
    workspace.setRunPending.mockClear();
    (view as any).conversationOriginToken = "origin-new";
    const transition = (view as any).beginConversationTransition("origin-new");
    workspace.setRunPending.mockClear();

    await expect(input.beforeSend?.()).rejects.toThrow(
      "This chat changed before the request was admitted.",
    );
    (view as any).renderAgentSnapshot({
      runId: "run-old",
      turnId: input.turnId,
      status: "running",
      messages: [],
      parts: [],
    });
    expect(workspace.setAgentSnapshot).not.toHaveBeenCalled();

    runFinished.resolve({
      kind: "completed",
      snapshot: {
        runId: "run-old",
        turnId: input.turnId,
        status: "completed",
        messages: [],
        parts: [],
      },
      message: {
        role: "assistant",
        content: "Stale answer",
        message_id: "assistant-old",
      },
    });
    await expect(execution).resolves.toBeUndefined();

    expect(transcript.commitUser).not.toHaveBeenCalled();
    expect(workspace.restoreRejectedSubmission).not.toHaveBeenCalled();
    expect(workspace.setRunPending).not.toHaveBeenCalled();
    expect(workspace.setBanner).not.toHaveBeenCalled();
    expect(workspace.setHistory).not.toHaveBeenCalled();
    expect(workspace.settleCompletedRun).not.toHaveBeenCalled();
    expect((view as any).queuedFollowUps).toEqual([
      expect.objectContaining({ id: "old-queued" }),
    ]);
    (view as any).finishSubmissionOperation(transition);
  });

  it("keeps a completed run durable and drains its queue when history settlement rendering fails", async () => {
    const settlementError = new Error("Durable history rendering failed.");
    const durableMessages: ChatMessage[] = [];
    const snapshot = () => ({
      chatId: durableMessages.length > 0 ? "durable-chat" : "",
      title: "Settlement test",
      version: durableMessages.length,
      messages: [...durableMessages],
      contextFiles: [],
    });
    const transcript = {
      snapshot: jest.fn(snapshot),
      setTitle: jest.fn(),
      commitUser: jest.fn(async (input: { message: ChatMessage }) => {
        durableMessages.push(input.message);
        return snapshot();
      }),
    };
    const workspace = {
      setHistory: jest.fn(async () => undefined),
      setAgentSnapshot: jest.fn(async () => undefined),
      setRunPending: jest.fn(),
      setBanner: jest.fn(),
      settleCompletedRun: jest.fn(async () => {
        throw settlementError;
      }),
      restoreRejectedSubmission: jest.fn(),
      resetMessageEditor: jest.fn(),
    };
    const logAgentError = jest.fn();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      workspace,
      transcript,
      agent: {
        start: jest.fn(async (input: FirstPartyAgentRunInput): Promise<FirstPartyAgentRunResult> => {
          await input.beforeSend?.();
          const assistant: ChatMessage = {
            role: "assistant",
            content: "Durable answer",
            message_id: "assistant-settlement",
          };
          durableMessages.push(assistant);
          return {
            kind: "completed",
            snapshot: {
              runId: "run-settlement",
              turnId: input.turnId,
              status: "completed",
              messages: [],
              parts: [],
            },
            message: assistant,
          };
        }),
        stageContext: jest.fn(async () => ({
          context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        })),
      },
      attachmentStore: {
        hydrateMessage: jest.fn(async (message: ChatMessage) => message),
      },
      contextManager: { getPinnedFiles: jest.fn(() => []) },
      plugin: { settings: { licenseKey: "test-license" } },
      automationApprovalMode: "interactive",
      approvalMode: "ask",
      sessionTrustedToolNames: new Set<string>(),
      queuedFollowUps: [],
      conversationOriginToken: "origin-settlement",
      runConversationOrigins: new Map<string, string>(),
      suppressQueueDrain: false,
      pendingRetry: null,
      pendingRejectedRetry: null,
      pendingThinConversationId: null,
      thinClientId: `client_${"c".repeat(32)}`,
      chatId: "",
      chatTitle: "Settlement test",
      readThinAgentContextSources: jest.fn(async () => []),
      getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
      applyTranscriptIdentity: jest.fn(),
      bindQueueToChat: jest.fn(async () => undefined),
      updateViewState: jest.fn(),
      logAgentError,
    });

    await expect((view as any).executeSubmission(
      { text: "Finish durably", mode: "send" },
      { expectedConversationOriginToken: "origin-settlement" },
    )).resolves.toBeUndefined();

    expect(durableMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(workspace.settleCompletedRun).toHaveBeenCalledWith(durableMessages);
    expect(logAgentError).toHaveBeenCalledWith(
      settlementError,
      "completedRunSettlement",
    );
    expect(workspace.restoreRejectedSubmission).not.toHaveBeenCalled();
    expect((view as any).pendingRejectedRetry).toBeNull();
    expect((view as any).activeSubmissionOperation).toBeNull();
    expect(workspace.setRunPending).toHaveBeenLastCalledWith(false);
  });

  it("settles a cache-missed completed assistant as an ephemeral live history row", async () => {
    const durableMessages: ChatMessage[] = [];
    const snapshot = () => ({
      chatId: durableMessages.length > 0 ? "cache-missed-chat" : "",
      title: "Cache missed settlement",
      version: durableMessages.length,
      messages: [...durableMessages],
      contextFiles: [],
    });
    const transcript = {
      snapshot: jest.fn(snapshot),
      setTitle: jest.fn(),
      commitUser: jest.fn(async (input: { message: ChatMessage }) => {
        durableMessages.push(input.message);
        return snapshot();
      }),
    };
    const workspace = {
      setHistory: jest.fn(async () => undefined),
      setAgentSnapshot: jest.fn(async () => undefined),
      setRunPending: jest.fn(),
      setBanner: jest.fn(),
      settleCompletedRun: jest.fn(async () => undefined),
      restoreRejectedSubmission: jest.fn(),
      resetMessageEditor: jest.fn(),
    };
    const assistant: ChatMessage = {
      role: "assistant",
      content: "The server response remains visible.",
      message_id: "assistant-cache-missed",
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      workspace,
      transcript,
      agent: {
        start: jest.fn(async (input: FirstPartyAgentRunInput): Promise<FirstPartyAgentRunResult> => {
          await input.beforeSend?.();
          return {
            kind: "completed",
            snapshot: {
              runId: "run-cache-missed",
              turnId: input.turnId,
              status: "completed",
              phase: "complete",
              messages: [],
              parts: [],
            },
            message: assistant,
          };
        }),
        stageContext: jest.fn(async () => ({
          context_ref: "ctx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        })),
      },
      attachmentStore: {
        hydrateMessage: jest.fn(async (message: ChatMessage) => message),
      },
      contextManager: { getPinnedFiles: jest.fn(() => []) },
      plugin: { settings: { licenseKey: "test-license" } },
      automationApprovalMode: "interactive",
      approvalMode: "ask",
      sessionTrustedToolNames: new Set<string>(),
      queuedFollowUps: [],
      conversationOriginToken: "origin-cache-missed",
      runConversationOrigins: new Map<string, string>(),
      suppressQueueDrain: false,
      pendingRetry: null,
      pendingRejectedRetry: null,
      pendingThinConversationId: null,
      thinClientId: `client_${"c".repeat(32)}`,
      chatId: "",
      chatTitle: "Cache missed settlement",
      readThinAgentContextSources: jest.fn(async () => []),
      getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
      applyTranscriptIdentity: jest.fn(),
      bindQueueToChat: jest.fn(async () => undefined),
      updateViewState: jest.fn(),
      logAgentError: jest.fn(),
    });

    await expect((view as any).executeSubmission(
      { text: "Keep the successful response visible", mode: "send" },
      { expectedConversationOriginToken: "origin-cache-missed" },
    )).resolves.toBeUndefined();

    expect(durableMessages).toHaveLength(1);
    expect(durableMessages[0].role).toBe("user");
    expect(workspace.settleCompletedRun).toHaveBeenCalledWith([
      durableMessages[0],
      assistant,
    ]);
    expect(workspace.restoreRejectedSubmission).not.toHaveBeenCalled();
    expect((view as any).pendingRejectedRetry).toBeNull();
    expect((view as any).activeSubmissionOperation).toBeNull();
  });

  it("Stop during hydration retires preflight synchronously and late work cannot start", async () => {
    const harness = createHarness("before-commit");
    const hydrationStarted = deferred<ChatMessage>();
    const hydration = deferred<ChatMessage>();
    (harness.view as any).attachmentStore.hydrateMessage = jest.fn((message: ChatMessage) => {
      hydrationStarted.resolve(message);
      return hydration.promise;
    });
    harness.composer.setValue("Stop this before hydration finishes");

    await (harness.composer as unknown as { submit: () => Promise<void> }).submit();
    const pendingMessage = await hydrationStarted.promise;
    expect((harness.view as any).activeSubmissionOperation).toBeTruthy();

    await (harness.view as any).stopActiveRun();

    expect((harness.view as any).activeSubmissionOperation).toBeNull();
    expect(harness.workspace.setRunPending).toHaveBeenLastCalledWith(false);
    expect(harness.restoreRejectedSubmission).toHaveBeenCalledTimes(1);
    expect(harness.composer.getValue()).toBe("Stop this before hydration finishes");

    hydration.resolve(pendingMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.agent.start).not.toHaveBeenCalled();
    expect((harness.view as any).transcript.commitUser).not.toHaveBeenCalled();
    expect(harness.restoreRejectedSubmission).toHaveBeenCalledTimes(1);
    expect(harness.workspace.setBanner).not.toHaveBeenCalledWith(
      expect.any(String),
      "error",
    );
    harness.composer.unload();
  });

  it("Stop during session preparation guards context staging and durable admission", async () => {
    const harness = createHarness("before-commit");
    const started = deferred<FirstPartyAgentRunInput>();
    const terminal = deferred<FirstPartyAgentRunResult>();
    harness.agent.start.mockImplementation((input: FirstPartyAgentRunInput) => {
      started.resolve(input);
      return terminal.promise;
    });
    const cancel = jest.fn(async () => undefined);
    (harness.agent as any).cancel = cancel;
    harness.composer.setValue("Stop during bootstrap");

    await (harness.composer as unknown as { submit: () => Promise<void> }).submit();
    const input = await started.promise;
    const stopping = (harness.view as any).stopActiveRun();
    await Promise.resolve();

    await expect(input.buildBody?.(new AbortController().signal)).rejects.toThrow(
      "This chat changed before the request was admitted.",
    );
    await expect(input.beforeSend?.()).rejects.toThrow(
      "This chat changed before the request was admitted.",
    );
    expect(harness.agent.stageContext).not.toHaveBeenCalled();
    expect((harness.view as any).transcript.commitUser).not.toHaveBeenCalled();

    terminal.resolve({
      kind: "cancelled",
      snapshot: {
        runId: "run-bootstrap-stop",
        turnId: input.turnId,
        status: "cancelled",
        messages: [],
        parts: [],
      },
    });
    await stopping;
    await harness.runFinished.promise;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.restoreRejectedSubmission).toHaveBeenCalledTimes(1);
    expect((harness.view as any).activeSubmissionOperation).toBeNull();
    expect(harness.workspace.setBanner).not.toHaveBeenCalledWith(
      expect.any(String),
      "error",
    );
    harness.composer.unload();
  });

  it("retry hydration cannot open an editor after a submission claims the view", async () => {
    const message: ChatMessage = {
      role: "user",
      content: "Edit me",
      message_id: "user-edit",
    };
    const hydrationStarted = deferred();
    const hydration = deferred<ChatMessage>();
    const showMessageEditor = jest.fn(async () => undefined);
    const setRunPending = jest.fn();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-edit",
      messageEditGeneration: 0,
      pendingRetry: null,
      transcript: {
        snapshot: jest.fn(() => ({
          chatId: "saved-chat",
          version: 4,
          messages: [message],
        })),
      },
      attachmentStore: {
        hydrateMessage: jest.fn(() => {
          hydrationStarted.resolve();
          return hydration.promise;
        }),
      },
      agent: { getSnapshot: jest.fn(() => ({ status: "idle" })) },
      workspace: {
        showMessageEditor,
        setRunPending,
        setBanner: jest.fn(),
      },
    });

    const retrying = (view as any).prepareRetry("user-edit");
    await hydrationStarted.promise;
    const active = (view as any).beginSubmissionOperation(
      "origin-edit",
      { text: "New request", mode: "send" },
    );
    expect(active).toBeTruthy();
    hydration.resolve(message);
    await retrying;

    expect(showMessageEditor).not.toHaveBeenCalled();
    expect((view as any).pendingRetry).toBeNull();
    (view as any).retireSubmissionOperation(active, false);
  });

  it("late operation settlement cannot clear its same-origin replacement or overtake FIFO", () => {
    const setRunPending = jest.fn();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-same",
      queuedFollowUps: [],
      agent: { getSnapshot: jest.fn(() => ({ status: "idle" })) },
      workspace: {
        setRunPending,
        setBanner: jest.fn(),
        restoreRejectedSubmission: jest.fn(),
      },
      syncQueue: jest.fn(),
      scheduleQueuePersistence: jest.fn(),
    });
    const operationA = (view as any).beginSubmissionOperation(
      "origin-same",
      { text: "A", mode: "send" },
    );
    (view as any).retireSubmissionOperation(operationA, false);
    const operationB = (view as any).beginSubmissionOperation(
      "origin-same",
      { text: "B", mode: "send" },
    );
    setRunPending.mockClear();

    (view as any).finishSubmissionOperation(operationA);

    expect((view as any).activeSubmissionOperation).toBe(operationB);
    expect(setRunPending).not.toHaveBeenCalled();

    (view as any).queuedFollowUps = [
      { id: "older", text: "Older queued", includeContextFiles: true },
      { id: "newer", text: "Newer queued", includeContextFiles: false },
    ];
    const promotion = (view as any).promoteQueuedSubmission(
      operationB,
      "origin-same",
    );
    expect(promotion).toBeTruthy();
    expect((view as any).activeSubmissionOperation).toBe(promotion.operation);
    expect(setRunPending).toHaveBeenLastCalledWith(
      true,
      promotion.operation.turnId,
    );
    expect(setRunPending).not.toHaveBeenCalledWith(false);

    (view as any).acceptComposerSubmission({ text: "Newest", mode: "queue" });

    expect((view as any).queuedFollowUps.map((item: any) => item.text)).toEqual([
      "Newer queued",
      "Newest",
    ]);
    (view as any).retireSubmissionOperation(promotion.operation, false);
  });
});

describe("AgentChatView controls", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.empty();
  });

  it("clicking New chat clears the owned draft and retires an in-flight attachment retry", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const retryStarted = deferred();
    const retryPrepared = deferred<Readonly<{ operationId: string; markdown: string }>>();
    const retryCompleted = deferred();
    let prepareAttempt = 0;
    const noticeLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const newChatFinished = deferred();
    let newChatError: unknown;
    const workspace = new AgentWorkspace(parent, {
      app,
      sourcePath: () => "",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: async () => {
        try {
          await (view as any).startNewChat();
        } catch (error) {
          newChatError = error;
        } finally {
          newChatFinished.resolve();
        }
      },
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
      documentAttachmentProcessor: {
        prepare: jest.fn(async () => {
          prepareAttempt += 1;
          if (prepareAttempt === 1) throw new Error("conversion failed");
          retryStarted.resolve();
          return retryPrepared.promise;
        }),
        complete: jest.fn(async (operationId) => {
          if (operationId === "retry-operation") retryCompleted.resolve();
        }),
        discard: jest.fn(async () => undefined),
      },
    });
    workspace.load();

    const cancel = jest.fn(async () => {
      expect((view as any).pendingThinConversationId).toBeNull();
      expect((view as any).thinBootstrapRequest).toBeNull();
    });
    const disconnect = jest.fn();
    const recordLifecycle = jest.fn();
    const clearPinnedFiles = jest.fn();
    const saveQueue = jest.fn(async () => undefined);
    Object.assign(view, {
      app,
      workspace,
      agent: { cancel, disconnect, recordLifecycle },
      thinBootstrapRequest: { contract_version: "thin-agent-v1" },
      pendingThinConversationId: "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      conversationOriginToken: "old-origin",
      pendingForkHistory: null,
      suppressQueueDrain: false,
      draftKey: "saved-chat",
      chatId: "saved-chat",
      chatTitle: "Saved chat",
      chatVersion: 4,
      queuedFollowUps: [{
        id: "saved-queue",
        text: "Keep this with the saved chat",
        includeContextFiles: true,
      }],
      queueHydrated: true,
      queuePersistence: Promise.resolve(),
      queueRepository: {
        save: saveQueue,
        move: jest.fn(async () => undefined),
      },
      messageEditGeneration: 0,
      pendingRetry: null,
      pendingRejectedRetry: null,
      sessionTrustedToolNames: new Set(["write"]),
      approvalMode: "full-access",
      contextLoading: false,
      contextManager: {
        clearPinnedFiles,
        getPinnedFiles: jest.fn(() => []),
      },
      transcript: {
        reset: jest.fn(() => ({
          chatId: "",
          title: "New chat",
          version: 0,
          messages: [],
          contextFiles: [],
        })),
      },
      syncAttachments: jest.fn(() => workspace.setAttachments([])),
      updateViewState: jest.fn(),
      prepareThinConversation: jest.fn(async () => undefined),
      isFullyLoaded: true,
    });

    workspace.setQueue((view as any).queuedFollowUps);
    workspace.setApprovalMode("full-access");
    workspace.setAttachments([{
      id: "context",
      label: "Context.md",
      path: "Context.md",
      kind: "vault",
    }]);
    workspace.setInputText("UNSENT DRAFT");
    workspace.restoreMessageAttachments([ORIGINAL_ATTACHMENT]);
    const pdf = new File(["%PDF"], "broken.pdf", { type: "application/pdf" });
    Object.defineProperty(pdf, "arrayBuffer", {
      value: async () => new TextEncoder().encode("%PDF").buffer,
    });
    await (workspace.composer as any).ingestFiles([pdf]);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(2);
    expect(parent.querySelector(".systemsculpt-agent-attachment.is-failed")).not.toBeNull();

    parent.querySelector<HTMLButtonElement>('[aria-label="Retry broken.pdf"]')!.click();
    await retryStarted.promise;
    expect(workspace.composer.element.classList.contains("is-processing-attachments")).toBe(true);

    parent.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click();
    await newChatFinished.promise;

    expect(newChatError).toBeUndefined();
    expect(workspace.getInputText()).toBe("");
    expect(workspace.getMessageAttachments()).toEqual([]);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(0);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-pinned")).toHaveLength(0);
    expect(parent.querySelectorAll(".systemsculpt-agent-queue-item")).toHaveLength(0);
    expect(parent.querySelector<HTMLSelectElement>('[aria-label="Vault changes"]')?.value).toBe("ask");
    expect(document.activeElement).toBe(parent.querySelector("textarea"));
    expect(clearPinnedFiles).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(recordLifecycle).toHaveBeenCalledWith({
      code: "conversation_reset",
      phase: "session",
      conversationId: (view as any).pendingThinConversationId,
    });
    expect(saveQueue).toHaveBeenCalledWith(
      "saved-chat",
      expect.arrayContaining([expect.objectContaining({ id: "saved-queue" })]),
    );

    const newDraftFile = new File(["new"], "new-draft.md", { type: "text/markdown" });
    Object.defineProperty(newDraftFile, "arrayBuffer", {
      value: async () => new TextEncoder().encode("new").buffer,
    });
    await (workspace.composer as any).ingestFiles([newDraftFile]);
    expect(workspace.getMessageAttachments().map((attachment) => attachment.name))
      .toEqual(["new-draft.md"]);

    retryPrepared.resolve({
      operationId: "retry-operation",
      markdown: "Recovered old document",
    });
    await retryCompleted.promise;
    await Promise.resolve();

    expect(workspace.getMessageAttachments().map((attachment) => attachment.name))
      .toEqual(["new-draft.md"]);
    expect(parent.textContent).not.toContain("broken.pdf");
    expect(noticeLog).toHaveBeenCalledWith(
      "Notice: broken.pdf could not be processed: conversion failed",
    );
    workspace.unload();
  });

  it("clicking New chat clears an unsaved draft queue and owns the pending-state reset", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const newChatFinished = deferred();
    let newChatError: unknown;
    const workspace = new AgentWorkspace(parent, {
      app,
      sourcePath: () => "",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: async () => {
        try {
          await (view as any).startNewChat();
        } catch (error) {
          newChatError = error;
        } finally {
          newChatFinished.resolve();
        }
      },
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();

    const oldQueue = [{
      id: "unsaved-queue",
      text: "Do not carry this into the new chat",
      includeContextFiles: true,
    }];
    const cancel = jest.fn(async () => undefined);
    const disconnect = jest.fn();
    const save = jest.fn(async () => undefined);
    const move = jest.fn(async () => undefined);
    Object.assign(view, {
      app,
      workspace,
      agent: { cancel, disconnect },
      thinBootstrapRequest: { contract_version: "thin-agent-v1" },
      pendingThinConversationId: "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      conversationOriginToken: "old-origin",
      pendingForkHistory: null,
      suppressQueueDrain: false,
      draftKey: "old-unsaved-draft",
      chatId: "",
      chatTitle: "Unsaved chat",
      chatVersion: 0,
      queuedFollowUps: [...oldQueue],
      queueHydrated: true,
      queuePersistence: Promise.resolve(),
      queueRepository: { save, move },
      messageEditGeneration: 0,
      pendingRetry: null,
      pendingRejectedRetry: null,
      sessionTrustedToolNames: new Set<string>(),
      approvalMode: "ask",
      contextLoading: false,
      contextManager: {
        clearPinnedFiles: jest.fn(),
        getPinnedFiles: jest.fn(() => []),
      },
      transcript: {
        reset: jest.fn(() => ({
          chatId: "",
          title: "New chat",
          version: 0,
          messages: [],
          contextFiles: [],
        })),
      },
      syncAttachments: jest.fn(() => workspace.setAttachments([])),
      updateViewState: jest.fn(),
      prepareThinConversation: jest.fn(async () => undefined),
      isFullyLoaded: true,
    });
    workspace.setQueue(oldQueue);
    const retiredOperation = (view as any).beginSubmissionOperation(
      "old-origin",
      { text: "Old preflight", mode: "send" },
    );
    expect(workspace.composer.element.classList.contains("is-running")).toBe(true);

    parent.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click();
    await newChatFinished.promise;

    expect(newChatError).toBeUndefined();
    expect((view as any).queuedFollowUps).toEqual([]);
    expect(parent.querySelectorAll(".systemsculpt-agent-queue-item")).toHaveLength(0);
    expect(workspace.composer.element.classList.contains("is-running")).toBe(false);
    expect(save).toHaveBeenNthCalledWith(1, "old-unsaved-draft", oldQueue);
    expect(save).toHaveBeenNthCalledWith(2, expect.stringMatching(/^draft-/), []);
    expect(move).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(retiredOperation.controller.signal.aborted).toBe(true);
    expect(retiredOperation.settled).toBe(true);
    workspace.unload();
  });

  it("clicking Stop and send now restores a removed item when setup fails", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const runNowFinished = deferred();
    let runNowError: unknown;
    const workspace = new AgentWorkspace(parent, {
      app,
      sourcePath: () => "",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
      onRunQueuedNow: async (id) => {
        try {
          await (view as any).runQueuedFollowUpNow(id);
        } catch (error) {
          runNowError = error;
        } finally {
          runNowFinished.resolve();
        }
      },
    });
    workspace.load();

    const queued = {
      id: "queued-now",
      text: "Queued request",
      includeContextFiles: false,
      attachments: [ORIGINAL_ATTACHMENT],
    };
    const executeSubmission = jest.fn(async () => {
      throw new Error("Attachment preparation failed.");
    });
    const cancel = jest.fn(async () => undefined);
    const handleError = jest.fn(async (error: unknown) => {
      await AgentChatView.prototype.handleError.call(view, error);
    });
    Object.assign(view, {
      workspace,
      queuedFollowUps: [queued],
      queueHydrated: true,
      draftKey: "chat-queue",
      queuePersistence: Promise.resolve(),
      queueRepository: { save: jest.fn(async () => undefined) },
      suppressQueueDrain: false,
      agent: { cancel },
      executeSubmission,
      handleError,
      conversationOriginToken: "origin-run-now",
    });
    workspace.setInputText("Newer draft");
    workspace.restoreMessageAttachments([NEWER_ATTACHMENT]);
    workspace.setQueue((view as any).queuedFollowUps);

    parent.querySelector<HTMLButtonElement>(
      '[aria-label="Stop and send queued follow-up 1 of 1 now"]',
    )!.click();
    await runNowFinished.promise;

    expect(runNowError).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(executeSubmission).toHaveBeenCalledWith(
      {
        text: "Queued request",
        mode: "send",
        attachments: [ORIGINAL_ATTACHMENT],
      },
      {
        includeContextFiles: false,
        expectedConversationOriginToken: "origin-run-now",
      },
    );
    expect((view as any).queuedFollowUps).toEqual([]);
    expect(parent.querySelectorAll(".systemsculpt-agent-queue-item")).toHaveLength(0);
    expect(workspace.getInputText()).toBe("Queued request\n\nNewer draft");
    expect(workspace.getMessageAttachments()).toEqual([
      ORIGINAL_ATTACHMENT,
      NEWER_ATTACHMENT,
    ]);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(parent.querySelectorAll(".systemsculpt-agent-banner[role='alert']")).toHaveLength(1);
    expect(parent.querySelector(".systemsculpt-agent-banner")?.textContent)
      .toContain("Attachment preparation failed.");
    expect(parent.querySelectorAll(".systemsculpt-agent-error")).toHaveLength(0);
    workspace.unload();
  });

  it("Stop and send now supersedes deferred preflight exactly once", async () => {
    const preparation = deferred<AgentComposerSubmit>();
    const executeSubmission = jest.fn(async () => undefined);
    const restoreRejectedSubmission = jest.fn();
    const queued = {
      id: "queued-supersede",
      text: "Run this now",
      includeContextFiles: false,
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-supersede",
      queuedFollowUps: [queued],
      queueHydrated: true,
      draftKey: "chat-supersede",
      queuePersistence: Promise.resolve(),
      queueRepository: { save: jest.fn(async () => undefined) },
      prepareSubmission: jest.fn(() => preparation.promise),
      executeSubmission,
      agent: { getSnapshot: jest.fn(() => ({ status: "idle" })) },
      workspace: {
        setRunPending: jest.fn(),
        setBanner: jest.fn(),
        setQueue: jest.fn(),
        restoreRejectedSubmission,
      },
      handleError: jest.fn(),
      suppressQueueDrain: false,
    });
    const oldSubmission = {
      text: "Old deferred request",
      mode: "send" as const,
    };
    (view as any).acceptComposerSubmission(oldSubmission);
    expect((view as any).activeSubmissionOperation).toBeTruthy();

    await (view as any).runQueuedFollowUpNow("queued-supersede");

    expect(executeSubmission).toHaveBeenCalledTimes(1);
    expect(executeSubmission).toHaveBeenCalledWith(
      { text: "Run this now", mode: "send" },
      {
        includeContextFiles: false,
        expectedConversationOriginToken: "origin-supersede",
      },
    );
    expect(restoreRejectedSubmission).toHaveBeenCalledTimes(1);
    expect(restoreRejectedSubmission).toHaveBeenCalledWith(oldSubmission);

    preparation.resolve(oldSubmission);
    await Promise.resolve();
    await Promise.resolve();

    expect(executeSubmission).toHaveBeenCalledTimes(1);
    expect((view as any).queuedFollowUps).toEqual([]);
  });

  it("keeps the queued row when Stop and send now cannot persist its removal", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const runNowFinished = deferred();
    const noticeLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const workspace = new AgentWorkspace(parent, {
      app,
      sourcePath: () => "",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
      onRunQueuedNow: async (id) => {
        await (view as any).runQueuedFollowUpNow(id);
        runNowFinished.resolve();
      },
    });
    workspace.load();

    const queued = {
      id: "queued-persistence",
      text: "Keep queued",
      includeContextFiles: true,
    };
    const executeSubmission = jest.fn();
    const cancel = jest.fn();
    Object.assign(view, {
      workspace,
      queuedFollowUps: [queued],
      queueHydrated: true,
      draftKey: "chat-queue",
      queuePersistence: Promise.resolve(),
      queueRepository: {
        save: jest.fn(async () => {
          throw new Error("disk unavailable");
        }),
      },
      suppressQueueDrain: false,
      agent: { cancel },
      executeSubmission,
      conversationOriginToken: "origin-run-now",
    });
    workspace.setQueue((view as any).queuedFollowUps);

    parent.querySelector<HTMLButtonElement>(
      '[aria-label="Stop and send queued follow-up 1 of 1 now"]',
    )!.click();
    await runNowFinished.promise;

    expect((view as any).queuedFollowUps).toEqual([queued]);
    expect(parent.querySelectorAll(".systemsculpt-agent-queue-item")).toHaveLength(1);
    expect(workspace.getInputText()).toBe("");
    expect(cancel).not.toHaveBeenCalled();
    expect(executeSubmission).not.toHaveBeenCalled();
    expect(noticeLog).toHaveBeenCalledWith(
      "Notice: Queued follow-ups could not be saved. disk unavailable",
    );
    workspace.unload();
  });

  it("holds automatic FIFO promotion while Stop and send now takes over a queued item", async () => {
    const removalSaveStarted = deferred();
    const releaseRemovalSave = deferred();
    const persistedQueues: string[][] = [];
    const selected = {
      id: "queued-selected",
      text: "Run selected now",
      includeContextFiles: false,
    };
    const remaining = {
      id: "queued-remaining",
      text: "Keep me next",
      includeContextFiles: true,
    };
    const executeSubmission = jest.fn(async () => undefined);
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-takeover",
      queuedFollowUps: [selected, remaining],
      queueHydrated: true,
      draftKey: "chat-takeover",
      queuePersistence: Promise.resolve(),
      queueDrainSuppressionDepth: 0,
      queueRepository: {
        save: jest.fn(async (_key: string, items: Array<{ id: string }>) => {
          persistedQueues.push(items.map((item) => item.id));
          removalSaveStarted.resolve();
          await releaseRemovalSave.promise;
        }),
      },
      workspace: {
        setQueue: jest.fn(),
        restoreRejectedSubmission: jest.fn(),
      },
      stopActiveRun: jest.fn(async () => undefined),
      executeSubmission,
      handleError: jest.fn(),
    });

    const takeover = (view as any).runQueuedFollowUpNow(selected.id);
    await removalSaveStarted.promise;

    expect((view as any).isQueueDrainSuppressed()).toBe(true);
    expect((view as any).queuedFollowUps).toEqual([remaining]);
    // This is the exact completion-side guard used by executeSubmission.
    const automaticPromotion = !(view as any).isQueueDrainSuppressed()
      ? (view as any).queuedFollowUps.shift()
      : null;
    expect(automaticPromotion).toBeNull();
    expect((view as any).queuedFollowUps).toEqual([remaining]);

    releaseRemovalSave.resolve();
    await takeover;

    expect(executeSubmission).toHaveBeenCalledTimes(1);
    expect(executeSubmission).toHaveBeenCalledWith(
      { text: selected.text, mode: "send" },
      {
        includeContextFiles: false,
        expectedConversationOriginToken: "origin-takeover",
      },
    );
    expect((view as any).queuedFollowUps).toEqual([remaining]);
    expect(persistedQueues).toEqual([[remaining.id]]);
    expect((view as any).queueDrainSuppressionDepth).toBe(0);
  });

  it("restores a queued row when Remove queued follow-up cannot persist", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const removalFinished = deferred();
    let removalError: unknown;
    const noticeLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const workspace = new AgentWorkspace(parent, {
      app,
      sourcePath: () => "",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
      onCancelQueued: async (id) => {
        try {
          await (view as any).cancelQueuedFollowUp(id);
        } catch (error) {
          removalError = error;
        } finally {
          removalFinished.resolve();
        }
      },
    });
    workspace.load();

    const queued = {
      id: "queued-remove",
      text: "Keep this queued",
      includeContextFiles: true,
    };
    const save = jest.fn(async () => {
      throw new Error("disk unavailable");
    });
    Object.assign(view, {
      workspace,
      queuedFollowUps: [queued],
      queueHydrated: true,
      draftKey: "chat-queue",
      queuePersistence: Promise.resolve(),
      queueRepository: { save },
    });
    workspace.setInputText("Unsent replacement draft");
    workspace.restoreMessageAttachments([NEWER_ATTACHMENT]);
    workspace.setQueue((view as any).queuedFollowUps);

    parent.querySelector<HTMLButtonElement>(
      '[aria-label="Remove queued follow-up 1 of 1"]',
    )!.click();
    await removalFinished.promise;

    expect(removalError).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("chat-queue", []);
    expect((view as any).queuedFollowUps).toEqual([queued]);
    expect(parent.querySelectorAll(".systemsculpt-agent-queue-item")).toHaveLength(1);
    expect(workspace.getInputText()).toBe("Unsent replacement draft");
    expect(workspace.getMessageAttachments()).toEqual([NEWER_ATTACHMENT]);
    expect(parent.querySelectorAll(".systemsculpt-agent-banner[role='alert']")).toHaveLength(1);
    expect(parent.querySelector(".systemsculpt-agent-banner")?.textContent)
      .toContain("Queued follow-ups could not be saved. disk unavailable");
    expect(noticeLog).toHaveBeenCalledTimes(1);
    expect(noticeLog).toHaveBeenCalledWith(
      "Notice: Queued follow-ups could not be saved. disk unavailable",
    );
    workspace.unload();
  });
});

describe("AgentChatView thin conversation lifecycle", () => {
  it.each([
    {
      label: "first user turn",
      targetIndex: 0,
      targetMessageId: "user-first",
      expectedIdsBeforeEditedTurn: [],
    },
    {
      label: "later user turn",
      targetIndex: 2,
      targetMessageId: "user-later",
      expectedIdsBeforeEditedTurn: ["user-first", "assistant-first"],
    },
  ])("durably branches a saved chat when resubmitting the $label before reconciling fork history", async ({
    targetIndex,
    targetMessageId,
    expectedIdsBeforeEditedTurn,
  }) => {
    const initialMessages: ChatMessage[] = [
      { role: "user", content: "First", message_id: "user-first" },
      { role: "assistant", content: "First answer", message_id: "assistant-first" },
      { role: "user", content: "Later", message_id: "user-later" },
      { role: "assistant", content: "Later answer", message_id: "assistant-later" },
    ];
    const harness = createHistoricalResubmitHarness(initialMessages, targetIndex);
    const pending = {
      kind: "resend" as const,
      message: initialMessages[targetIndex],
      targetMessageId,
      expectedIndex: targetIndex,
      expectedVersion: 12,
      attachments: [],
      laterMessageCount: initialMessages.length - targetIndex - 1,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: false,
    };
    (harness.view as any).pendingRetry = pending;

    await (harness.view as any).executeSubmission(
      { text: `Edited ${targetMessageId}`, mode: "send" },
      {
        historicalResubmit: pending,
        restoreRejectedSubmission: false,
      },
    );

    expect(harness.transcript.commitUser).toHaveBeenCalledTimes(1);
    expect(harness.transcript.commitUser).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "resend",
        targetMessageId,
        expectedIndex: targetIndex,
        expectedVersion: 12,
        message: expect.objectContaining({
          role: "user",
          content: `Edited ${targetMessageId}`,
        }),
      }),
      expect.stringMatching(/^conversation_[a-f0-9]{32}$/),
    );
    expect(harness.operationOrder).toEqual(["commit", "reconcile"]);
    expect(harness.transcript.reconcileServerHistory).toHaveBeenCalledTimes(1);
    expect(harness.durableMessages.map((message) => message.message_id)).toEqual([
      ...expectedIdsBeforeEditedTurn,
      expect.stringMatching(/^user-/),
    ]);
    expect((harness.view as any).thinBootstrapRequest).toMatchObject({
      conversation_id: expect.stringMatching(/^conversation_[a-f0-9]{32}$/),
      fork: {
        source_conversation_id: harness.oldConversationId,
        before_message_id: targetMessageId,
      },
    });
    expect(harness.agent.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.recordLifecycle).toHaveBeenCalledWith({
      code: "submission_admitted",
      phase: "response",
    });
    expect(harness.recordLifecycle).toHaveBeenCalledWith({
      code: "historical_resubmit_committed",
      phase: "persistence",
    });
    expect(harness.workspace.setBanner).not.toHaveBeenCalledWith(
      expect.any(String),
      "error",
    );
  });

  it("never replaces a saved thin chat with an empty fork bootstrap when editing its first turn", async () => {
    const harness = await createPersistentHistoricalResubmitHarness();
    const pending = {
      kind: "resend" as const,
      message: harness.initialMessages[0],
      targetMessageId: "user-original",
      expectedIndex: 0,
      expectedVersion: harness.loaded.version,
      attachments: [],
      laterMessageCount: 3,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: true,
    };
    (harness.view as any).pendingRetry = pending;

    await expect(confirmHistoricalResubmit(
      harness.view,
      pending.targetMessageId,
      "Edited original request",
    )).resolves.toBe(true);

    const writes = harness.saveChat.mock.calls.map(([, messages, options]) => ({
      ids: messages.map((message) => message.message_id),
      authoritative:
        (options as { authoritativeServerHistoryReconciliation?: boolean })
          .authoritativeServerHistoryReconciliation === true,
    }));
    expect(writes).toEqual([
      {
        ids: [expect.stringMatching(/^user-/)],
        authoritative: false,
      },
      {
        ids: [expect.stringMatching(/^user-/), "assistant-replacement"],
        authoritative: true,
      },
    ]);
    expect(harness.saveChat.mock.calls.some(([, messages]) => messages.length === 0))
      .toBe(false);
    expect(harness.transcript.snapshot()).toMatchObject({
      chatId: harness.chatId,
      agentConversationId: expect.stringMatching(/^conversation_[a-f0-9]{32}$/),
      messages: [
        expect.objectContaining({
          role: "user",
          content: "Edited original request",
        }),
        harness.replacementAssistant,
      ],
    });
    expect(harness.transcript.snapshot().agentConversationId)
      .not.toBe(harness.oldConversationId);
    expect((harness.view as any).pendingForkHistory).toBeNull();
    expect((harness.view as any).pendingRetry).toBeNull();
    expect(harness.workspace.resetMessageEditor).toHaveBeenCalledTimes(1);
    expect(harness.agent.disconnect).toHaveBeenCalledTimes(1);
    expect((harness.view as any).thinBootstrapRequest).toMatchObject({
      fork: {
        source_conversation_id: harness.oldConversationId,
        before_message_id: "user-original",
      },
    });
  });

  it("rolls back an edited first turn when bootstrap fails without attempting an empty save", async () => {
    const harness = await createPersistentHistoricalResubmitHarness({
      failBeforeCommit: true,
    });
    const pending = {
      kind: "resend" as const,
      message: harness.initialMessages[0],
      targetMessageId: "user-original",
      expectedIndex: 0,
      expectedVersion: harness.loaded.version,
      attachments: [],
      laterMessageCount: 3,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: true,
    };
    (harness.view as any).pendingRetry = pending;

    await expect(confirmHistoricalResubmit(
      harness.view,
      pending.targetMessageId,
      "Edited original request",
    )).resolves.toBe(false);

    expect(harness.saveChat).not.toHaveBeenCalled();
    expect(harness.transcript.snapshot()).toMatchObject({
      version: harness.loaded.version,
      agentConversationId: harness.oldConversationId,
      messages: harness.loaded.messages,
    });
    expect((harness.view as any).pendingRetry).toBe(pending);
    expect((harness.view as any).pendingForkHistory).toBeNull();
    expect((harness.view as any).pendingRejectedRetry).toMatchObject({
      historicalResubmit: pending,
      submission: expect.objectContaining({
        text: "Edited original request",
      }),
    });
    expect(harness.workspace.resetMessageEditor).not.toHaveBeenCalled();
    expect(harness.workspace.restoreRejectedSubmission).not.toHaveBeenCalled();
    expect(harness.workspace.setBanner).not.toHaveBeenCalledWith(
      expect.any(String),
      "error",
    );
  });

  it("keeps the historical editor retryable when the replacement branch cannot be saved", async () => {
    const harness = await createPersistentHistoricalResubmitHarness();
    const pending = {
      kind: "resend" as const,
      message: harness.initialMessages[0],
      targetMessageId: "user-original",
      expectedIndex: 0,
      expectedVersion: harness.loaded.version,
      attachments: [],
      laterMessageCount: 3,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: true,
    };
    (harness.view as any).pendingRetry = pending;
    harness.rejectNextModify();

    await expect(confirmHistoricalResubmit(
      harness.view,
      pending.targetMessageId,
      "Edited original request",
    )).resolves.toBe(false);

    expect((harness.view as any).pendingRetry).toBe(pending);
    expect((harness.view as any).pendingForkHistory).toBeNull();
    expect(harness.workspace.resetMessageEditor).not.toHaveBeenCalled();
    expect(harness.transcript.snapshot()).toMatchObject({
      version: harness.loaded.version,
      agentConversationId: harness.oldConversationId,
      messages: harness.loaded.messages,
    });
    expect(harness.saveChat.mock.calls.some(([, messages]) => messages.length === 0))
      .toBe(false);

    await expect(confirmHistoricalResubmit(
      harness.view,
      pending.targetMessageId,
      "Edited original request",
    )).resolves.toBe(true);

    expect((harness.view as any).pendingRetry).toBeNull();
    expect(harness.workspace.resetMessageEditor).toHaveBeenCalledTimes(1);
    expect(harness.transcript.snapshot().messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Edited original request",
      }),
      harness.replacementAssistant,
    ]);
    expect(harness.saveChat.mock.calls.some(([, messages]) => messages.length === 0))
      .toBe(false);
  });

  it("refuses a pointerless legacy resubmit before allocating a blank server conversation", async () => {
    const initialMessages: ChatMessage[] = [
      { role: "user", content: "First", message_id: "user-first" },
      { role: "assistant", content: "First answer", message_id: "assistant-first" },
      { role: "user", content: "Later", message_id: "user-later" },
      { role: "assistant", content: "Later answer", message_id: "assistant-later" },
    ];
    const harness = createHistoricalResubmitHarness(
      initialMessages,
      2,
      false,
      null,
    );
    const pending = {
      kind: "resend" as const,
      message: initialMessages[2],
      targetMessageId: "user-later",
      expectedIndex: 2,
      expectedVersion: 12,
      attachments: [],
      laterMessageCount: 1,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: false,
    };
    (harness.view as any).pendingRetry = pending;
    const noticeLog = jest.spyOn(console, "log").mockImplementation(() => undefined);

    await (harness.view as any).executeSubmission(
      { text: "Edited later", mode: "send" },
      { historicalResubmit: pending, restoreRejectedSubmission: false },
    );

    expect((harness.view as any).legacyHistoryViewOnly).toBe(true);
    expect(harness.workspace.setComposerReadOnly).toHaveBeenLastCalledWith(
      "View-only saved chat. Start a new chat to continue.",
    );
    expect(harness.workspace.setBanner).toHaveBeenLastCalledWith(
      "This older saved chat is view-only. You can read or export it. Start a new chat to continue.",
    );
    expect(harness.transcript.commitUser).not.toHaveBeenCalled();
    expect(harness.agent.start).not.toHaveBeenCalled();
    expect(harness.agent.disconnect).not.toHaveBeenCalled();
    expect((harness.view as any).thinBootstrapRequest).toBeNull();
    expect((harness.view as any).pendingForkHistory).toBeNull();
    expect(harness.durableMessages).toEqual(initialMessages);
    expect(noticeLog).toHaveBeenCalledWith(
      "Notice: This older saved chat is view-only. Start a new chat to continue.",
    );
  });

  it("drops a historical resubmit when New chat wins its replay confirmation", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Original", message_id: "user-original" },
      { role: "assistant", content: "Original answer", message_id: "assistant-original" },
    ];
    const pending = {
      kind: "resend" as const,
      message: messages[0],
      targetMessageId: "user-original",
      expectedIndex: 0,
      expectedVersion: 7,
      attachments: [],
      laterMessageCount: 1,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: true,
    };
    const prepareSubmission = jest.fn(async (submission: AgentComposerSubmit) => submission);
    const executeSubmission = jest.fn(async () => undefined);
    const handleError = jest.fn(async () => undefined);
    const commitUser = jest.fn();
    const restoreRejectedSubmission = jest.fn();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      app: new App(),
      conversationOriginToken: "origin-old",
      messageEditGeneration: 5,
      pendingRetry: pending,
      transcript: {
        snapshot: jest.fn(() => ({
          chatId: "saved-chat",
          title: "Saved chat",
          version: 7,
          messages,
        })),
        commitUser,
      },
      workspace: { restoreRejectedSubmission },
      prepareSubmission,
      executeSubmission,
      handleError,
    });

    const resubmission = (view as any).resubmitMessage(
      "user-original",
      "Edited original",
    );
    await Promise.resolve();
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Resubmit");
    expect(confirm).toBeDefined();

    (view as any).conversationOriginToken = "origin-new";
    (view as any).messageEditGeneration += 1;
    (view as any).pendingRetry = null;
    confirm!.click();

    await expect(resubmission).resolves.toBe(false);
    expect(prepareSubmission).not.toHaveBeenCalled();
    expect(executeSubmission).not.toHaveBeenCalled();
    expect(commitUser).not.toHaveBeenCalled();
    expect(restoreRejectedSubmission).not.toHaveBeenCalled();
    expect(handleError).not.toHaveBeenCalled();
  });

  it("drops a prepared historical resubmit when its editor generation is retired", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Original", message_id: "user-original" },
      { role: "assistant", content: "Original answer", message_id: "assistant-original" },
    ];
    const pending = {
      kind: "resend" as const,
      message: messages[0],
      targetMessageId: "user-original",
      expectedIndex: 0,
      expectedVersion: 7,
      attachments: [],
      laterMessageCount: 1,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: false,
    };
    const preparation = deferred<AgentComposerSubmit>();
    const prepareSubmission = jest.fn(() => preparation.promise);
    const executeSubmission = jest.fn(async () => undefined);
    const handleError = jest.fn(async () => undefined);
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      activeSubmissionOperation: null,
      queuedFollowUps: [],
      conversationOriginToken: "origin-stable",
      messageEditGeneration: 9,
      pendingRetry: pending,
      transcript: {
        snapshot: jest.fn(() => ({
          chatId: "saved-chat",
          title: "Saved chat",
          version: 7,
          messages,
        })),
      },
      prepareSubmission,
      executeSubmission,
      handleError,
    });

    const resubmission = (view as any).resubmitMessage(
      "user-original",
      "Edited original",
    );
    await Promise.resolve();
    expect(prepareSubmission).toHaveBeenCalledTimes(1);
    expect((view as any).activeSubmissionOperation).toMatchObject({
      kind: "submission",
      conversationOriginToken: "origin-stable",
      restoreRejectedSubmission: false,
    });
    expect((view as any).queuedFollowUps).toEqual([]);

    (view as any).messageEditGeneration += 1;
    (view as any).pendingRetry = null;
    preparation.resolve({ text: "Edited original", mode: "send" });

    await expect(resubmission).resolves.toBe(false);
    expect(executeSubmission).not.toHaveBeenCalled();
    expect(handleError).not.toHaveBeenCalled();
  });

  it("clears an edited branch on later authoritative empty history without a stale restore banner", async () => {
    const initialMessages: ChatMessage[] = [
      { role: "user", content: "Original", message_id: "user-original" },
      { role: "assistant", content: "Original answer", message_id: "assistant-original" },
    ];
    const harness = createHistoricalResubmitHarness(initialMessages, 0);
    const pending = {
      kind: "resend" as const,
      message: initialMessages[0],
      targetMessageId: "user-original",
      expectedIndex: 0,
      expectedVersion: 12,
      attachments: [],
      laterMessageCount: 1,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: false,
    };
    (harness.view as any).pendingRetry = pending;
    await (harness.view as any).executeSubmission(
      { text: "Edited original", mode: "send" },
      { historicalResubmit: pending, restoreRejectedSubmission: false },
    );
    harness.transcript.reconcileServerHistory.mockClear();
    harness.workspace.setHistory.mockClear();
    harness.workspace.setBanner.mockClear();
    harness.workspace.setAgentSnapshot.mockClear();
    harness.logger.warn.mockClear();

    await (harness.view as any).reconcileAgentHistory([]);

    expect(harness.transcript.reconcileServerHistory).toHaveBeenCalledWith([]);
    expect(harness.durableMessages).toEqual([]);
    expect(harness.workspace.setHistory).toHaveBeenCalledTimes(1);
    expect(harness.workspace.setHistory).toHaveBeenCalledWith([]);
    expect(harness.workspace.setBanner).not.toHaveBeenCalled();
    expect(harness.workspace.setAgentSnapshot).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  it("renders durable history only when authoritative reconciliation changes its identity", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Question", message_id: "user-stable" },
      { role: "assistant", content: "Answer", message_id: "assistant-stable" },
    ];
    const initial = {
      chatId: "chat-stable",
      title: "Stable chat",
      version: 7,
      messages,
    };
    const changed = {
      ...initial,
      version: 8,
      messages: [
        ...messages,
        { role: "assistant" as const, content: "Updated", message_id: "assistant-updated" },
      ],
    };
    let current = initial;
    let next = initial;
    const transcript = {
      snapshot: jest.fn(() => current),
      reconcileServerHistory: jest.fn(async () => {
        current = next;
        return current;
      }),
    };
    const workspace = {
      setHistory: jest.fn(async () => undefined),
      setBanner: jest.fn(),
    };
    const applyTranscriptIdentity = jest.fn();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      transcript,
      workspace,
      pendingForkHistory: null,
      applyTranscriptIdentity,
    });

    await (view as any).reconcileAgentHistory(messages.map((message) => ({ ...message })));

    expect(transcript.reconcileServerHistory).toHaveBeenCalledTimes(1);
    expect(workspace.setHistory).not.toHaveBeenCalled();
    expect(applyTranscriptIdentity).toHaveBeenLastCalledWith(initial);

    next = changed;
    await (view as any).reconcileAgentHistory(changed.messages);

    expect(transcript.reconcileServerHistory).toHaveBeenCalledTimes(2);
    expect(workspace.setHistory).toHaveBeenCalledTimes(1);
    expect(workspace.setHistory).toHaveBeenCalledWith(changed.messages);
    expect(applyTranscriptIdentity).toHaveBeenLastCalledWith(changed);
  });

  it("loading a saved chat retires deferred local preflight before replacing history", async () => {
    const preparation = deferred<AgentComposerSubmit>();
    const cancellation = deferred();
    const executeSubmission = jest.fn(async () => undefined);
    const restoreRejectedSubmission = jest.fn();
    const setRunPending = jest.fn();
    const loaded = {
      chatId: "loaded-chat",
      title: "Loaded chat",
      version: 3,
      messages: [
        { role: "user" as const, content: "Loaded", message_id: "user-loaded" },
      ],
      contextFiles: new Set<string>(),
      approvalMode: "ask" as const,
      agentConversationId: "conversation_0123456789abcdef0123456789abcdef",
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const app = new App();
    Object.assign(view, {
      app,
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-old",
      messageEditGeneration: 0,
      pendingRetry: null,
      pendingRejectedRetry: null,
      queuedFollowUps: [],
      queueHydrated: false,
      queuePersistence: Promise.resolve(),
      pendingForkHistory: null,
      pendingThinConversationId: null,
      thinBootstrapRequest: null,
      sessionTrustedToolNames: new Set<string>(),
      chatId: "old-chat",
      chatTitle: "Old chat",
      chatVersion: 2,
      chatFontSize: "medium",
      approvalMode: "ask",
      isFullyLoaded: true,
      prepareSubmission: jest.fn(() => preparation.promise),
      executeSubmission,
      handleError: jest.fn(),
      workspace: {
        setRunPending,
        setBanner: jest.fn(),
        restoreRejectedSubmission,
        resetMessageEditor: jest.fn(),
        setApprovalMode: jest.fn(),
        setTitle: jest.fn(),
        setHistory: jest.fn(async () => undefined),
        setAgentSnapshot: jest.fn(async () => undefined),
        setComposerReadOnly: jest.fn(),
      },
      agent: {
        getSnapshot: jest.fn(() => ({ status: "idle" })),
        cancel: jest.fn(() => cancellation.promise),
        disconnect: jest.fn(),
        hydrate: jest.fn(async () => undefined),
      },
      transcript: {
        load: jest.fn(async () => loaded),
      },
      contextManager: {
        setPinnedFiles: jest.fn(async () => undefined),
      },
      hydrateQueue: jest.fn(async () => undefined),
      applyFontSize: jest.fn(),
      applyTranscriptIdentity: jest.fn((snapshot: typeof loaded) => {
        (view as any).chatId = snapshot.chatId;
        (view as any).chatTitle = snapshot.title;
        (view as any).chatVersion = snapshot.version;
      }),
      syncAttachments: jest.fn(),
      updateViewState: jest.fn(),
      getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
    });

    const oldSubmission = { text: "Old preflight", mode: "send" as const };
    (view as any).acceptComposerSubmission(oldSubmission);
    expect((view as any).activeSubmissionOperation?.kind).toBe("submission");

    const loading = view.loadChatById("loaded-chat");
    expect((view as any).activeSubmissionOperation?.kind).toBe("transition");
    expect(setRunPending).toHaveBeenLastCalledWith(false);

    preparation.resolve(oldSubmission);
    await Promise.resolve();
    await Promise.resolve();
    expect(executeSubmission).not.toHaveBeenCalled();
    expect(restoreRejectedSubmission).not.toHaveBeenCalled();

    cancellation.resolve();
    await loading;

    expect((view as any).activeSubmissionOperation).toBeNull();
    expect((view as any).chatId).toBe("loaded-chat");
    const nextOperation = (view as any).beginSubmissionOperation(
      (view as any).conversationOriginToken,
      { text: "Loaded chat request", mode: "send" },
    );
    expect(nextOperation).toBeTruthy();
    (view as any).retireSubmissionOperation(nextOperation, false);
  });

  it("loads nonempty history without a server conversation as readable, exportable, and view-only", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Legacy question", message_id: "legacy-user" },
      { role: "assistant", content: "Legacy answer", message_id: "legacy-assistant" },
    ];
    const harness = createSavedChatLoadHarness(messages);

    await harness.view.loadChatById("legacy-chat");
    await harness.view.saveChat();

    expect((harness.view as any).legacyHistoryViewOnly).toBe(true);
    expect(harness.workspace.setHistory).toHaveBeenCalledWith(messages);
    expect(harness.workspace.setComposerReadOnly).toHaveBeenLastCalledWith(
      "View-only saved chat. Start a new chat to continue.",
    );
    expect(harness.workspace.setBanner).toHaveBeenLastCalledWith(
      "This older saved chat is view-only. You can read or export it. Start a new chat to continue.",
    );
    expect(harness.agent.hydrate).not.toHaveBeenCalled();
    expect(harness.prepareThinConversation).not.toHaveBeenCalled();
    expect(harness.transcript.saveMetadata).not.toHaveBeenCalled();
    expect(harness.loaded.messages).toEqual(messages);
  });

  it("retires a draft warm-up before restoring a saved chat", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Saved question", message_id: "saved-user" },
      { role: "assistant", content: "Saved answer", message_id: "saved-assistant" },
    ];
    const harness = createSavedChatLoadHarness(messages);
    (harness.view as any).pendingThinConversationId =
      "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    (harness.view as any).thinBootstrapRequest = {
      contract_version: "thin-agent-v1",
    };
    harness.agent.cancel.mockImplementationOnce(async () => {
      expect((harness.view as any).pendingThinConversationId).toBeNull();
      expect((harness.view as any).thinBootstrapRequest).toBeNull();
    });

    await harness.view.loadChatById("legacy-chat");

    expect(harness.agent.cancel).toHaveBeenCalledTimes(1);
    expect(harness.agent.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.prepareThinConversation).not.toHaveBeenCalled();
  });

  it("keeps an empty saved chat without a server conversation writable", async () => {
    const harness = createSavedChatLoadHarness([]);

    await harness.view.loadChatById("legacy-chat");
    await Promise.resolve();

    expect((harness.view as any).legacyHistoryViewOnly).toBe(false);
    expect(harness.workspace.setComposerReadOnly).toHaveBeenLastCalledWith(null);
    expect(harness.workspace.setBanner).toHaveBeenLastCalledWith(null);
    expect(harness.prepareThinConversation).toHaveBeenCalledWith(
      expect.stringMatching(/^conversation_[a-f0-9]{32}$/),
    );
  });

  it("presents a cached executing tool as recovering until authoritative hydration settles", async () => {
    const conversationId = "conversation_11111111111111111111111111111111";
    const hydrateStarted = deferred();
    const releaseHydrate = deferred();
    const harness = createSavedChatLoadHarness(cachedExecutingToolHistory(), {
      agentConversationId: conversationId,
      hydrate: async () => {
        hydrateStarted.resolve(undefined);
        await releaseHydrate.promise;
      },
    });

    const loading = harness.view.loadChatById("cached-running-chat");
    await hydrateStarted.promise;

    const presentedHistory = harness.workspace.setHistory.mock.calls.at(-1)?.[0];
    expect(presentedHistory?.[1]?.tool_calls?.[0]).toMatchObject({
      state: "executing",
    });
    expect(JSON.stringify(presentedHistory))
      .not.toContain("TOOL_OUTCOME_UNKNOWN_AFTER_RESTART");
    expect(harness.workspace.setAgentSnapshot).toHaveBeenLastCalledWith({
      runId: null,
      turnId: null,
      status: "running",
      phase: "retrying",
      statusLabel: "Recovering",
      messages: [],
      parts: [],
    });
    expect(harness.workspace.setBanner).toHaveBeenLastCalledWith("Loading chat…");

    releaseHydrate.resolve(undefined);
    await loading;
    expect(harness.workspace.setBanner).toHaveBeenLastCalledWith(null);
  });

  it("shows a session restore error without fabricating or saving cached tool failure", async () => {
    const conversationId = "conversation_22222222222222222222222222222222";
    const hydrateError = new Error("PRIVATE_HYDRATE_FAILURE");
    const harness = createSavedChatLoadHarness(cachedExecutingToolHistory(), {
      agentConversationId: conversationId,
      hydrate: async () => { throw hydrateError; },
    });

    await harness.view.loadChatById("cached-failed-hydrate-chat");

    const presentedHistory = harness.workspace.setHistory.mock.calls.at(-1)?.[0];
    expect(presentedHistory?.[1]?.tool_calls?.[0]).toMatchObject({
      state: "executing",
    });
    expect(JSON.stringify(presentedHistory))
      .not.toContain("TOOL_OUTCOME_UNKNOWN_AFTER_RESTART");
    expect(harness.workspace.setAgentSnapshot.mock.calls.map(([snapshot]) => snapshot))
      .toEqual([
        expect.objectContaining({
          status: "running",
          phase: "retrying",
          statusLabel: "Recovering",
        }),
        null,
      ]);
    expect(harness.workspace.setBanner).toHaveBeenLastCalledWith(
      "The agent session could not be restored. This cached transcript is shown for reference. Reload the chat to try again.",
      "error",
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      "ChatView agent session failed",
      hydrateError,
      expect.objectContaining({
        source: "AgentChatView",
        method: "loadChatHydration",
      }),
    );
    expect(harness.transcript.saveMetadata).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.loaded.messages))
      .not.toContain("TOOL_OUTCOME_UNKNOWN_AFTER_RESTART");
  });

  it("releases fork reconciliation after an edited turn fails before its durable commit", async () => {
    const initialMessages: ChatMessage[] = [
      { role: "user", content: "First", message_id: "user-first" },
      { role: "assistant", content: "First answer", message_id: "assistant-first" },
      { role: "user", content: "Later", message_id: "user-later" },
    ];
    const harness = createHistoricalResubmitHarness(initialMessages, 2, true);
    const pending = {
      kind: "resend" as const,
      message: initialMessages[2],
      targetMessageId: "user-later",
      expectedIndex: 2,
      expectedVersion: 12,
      attachments: [],
      laterMessageCount: 0,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: false,
    };
    (harness.view as any).pendingRetry = pending;

    await (harness.view as any).executeSubmission(
      { text: "Edited later", mode: "send" },
      { historicalResubmit: pending, restoreRejectedSubmission: false },
    );

    expect(harness.transcript.commitUser).not.toHaveBeenCalled();
    expect(harness.recordLifecycle).toHaveBeenCalledWith({
      code: "historical_resubmit_failed",
      phase: "response",
    });
    expect((harness.view as any).pendingForkHistory).toBeNull();
    expect((harness.view as any).pendingRetry).toBe(pending);
    expect(harness.operationOrder).toEqual([]);
    expect(harness.workspace.resetMessageEditor).not.toHaveBeenCalled();
    expect(harness.workspace.setBanner).not.toHaveBeenCalledWith(
      expect.any(String),
      "error",
    );

    // Simulate cancelling the abandoned inline edit, then accepting an
    // ordinary authoritative history update for the saved chat.
    (harness.view as any).pendingRetry = null;
    await (harness.view as any).reconcileAgentHistory(initialMessages);

    expect(harness.transcript.reconcileServerHistory).toHaveBeenCalledTimes(1);
    expect(harness.transcript.reconcileServerHistory).toHaveBeenCalledWith(initialMessages);
  });

  it("counts one rendered response instead of its assistant protocol records when editing history", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Original", message_id: "user-original" },
      { role: "assistant", content: "", message_id: "assistant-reasoning" },
      { role: "assistant", content: "", message_id: "assistant-tool" },
      { role: "assistant", content: "First answer", message_id: "assistant-answer" },
      { role: "user", content: "Follow-up", message_id: "user-follow-up" },
      { role: "assistant", content: "Second answer", message_id: "assistant-second-answer" },
    ];
    const snapshot = {
      chatId: "chat-history",
      title: "History",
      version: 7,
      messages,
    };
    const showMessageEditor = jest.fn(async () => undefined);
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      messageEditGeneration: 0,
      pendingRetry: null,
      agent: { getSnapshot: jest.fn(() => null) },
      transcript: { snapshot: jest.fn(() => snapshot) },
      attachmentStore: {
        hydrateMessage: jest.fn(async (message: ChatMessage) => message),
      },
      workspace: { showMessageEditor },
    });

    await (view as any).prepareRetry("user-original");

    expect(showMessageEditor).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "user-original",
      laterMessageCount: 3,
    }));
    expect((view as any).pendingRetry).toMatchObject({
      targetMessageId: "user-original",
      laterMessageCount: 3,
    });
  });

  it("drains a persisted FIFO once when a saved chat loads without reconnecting", async () => {
    const conversationId = "conversation_22222222222222222222222222222222";
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Finish while detached",
        message_id: "user-terminal-hydrate",
      },
      {
        role: "assistant",
        content: "Finished on the server",
        message_id: "assistant-terminal-hydrate",
      },
    ];
    const loaded = {
      chatId: "chat-terminal-hydrate",
      title: "Terminal hydrate",
      version: 4,
      messages,
      contextFiles: [] as string[],
      approvalMode: "ask" as const,
      agentConversationId: conversationId,
    };
    const terminalSnapshot = {
      runId: "run-terminal-hydrate",
      turnId: "user-terminal-hydrate",
      status: "completed" as const,
      messages: [],
      parts: [],
    };
    const queued = [
      { id: "queued-first", text: "First queued", includeContextFiles: true },
      { id: "queued-second", text: "Second queued", includeContextFiles: false },
    ];
    const app = new App();
    const setRunPending = jest.fn();
    const workspace = {
      setRunPending,
      setBanner: jest.fn(),
      resetMessageEditor: jest.fn(),
      setApprovalMode: jest.fn(),
      setTitle: jest.fn(),
      setHistory: jest.fn(async () => undefined),
      setAgentSnapshot: jest.fn(async () => undefined),
      setComposerReadOnly: jest.fn(),
    };
    const transcript = {
      load: jest.fn(async () => loaded),
      snapshot: jest.fn(() => loaded),
    };
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const runPromotedQueuedSubmission = jest.fn(async () => undefined);
    const agent = {
      getSnapshot: jest.fn(() => terminalSnapshot),
      cancel: jest.fn(async () => undefined),
      disconnect: jest.fn(),
      // A settled saved chat loads entirely from cache: the session must not
      // reconnect, and the persisted FIFO still promotes exactly once.
      hydrate: jest.fn(async () => undefined),
    };
    Object.assign(view, {
      app,
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-before-terminal-hydrate",
      messageEditGeneration: 0,
      pendingRetry: null,
      pendingRejectedRetry: null,
      queuedFollowUps: [],
      queueHydrated: false,
      queuePersistence: Promise.resolve(),
      queueDrainSuppressionDepth: 0,
      pendingForkHistory: null,
      pendingThinConversationId: null,
      thinBootstrapRequest: null,
      deferredRecoveredCompletion: null,
      sessionTrustedToolNames: new Set<string>(),
      runConversationOrigins: new Map<string, string>(),
      legacyHistoryViewOnly: false,
      thinClientId: `client_${"c".repeat(32)}`,
      chatId: "previous-chat",
      chatTitle: "Previous chat",
      chatVersion: 3,
      chatFontSize: "medium",
      approvalMode: "ask",
      isFullyLoaded: true,
      workspace,
      agent,
      transcript,
      contextManager: {
        setPinnedFiles: jest.fn(async () => undefined),
      },
      hydrateQueue: jest.fn(async () => {
        (view as any).queuedFollowUps = [...queued];
        (view as any).queueHydrated = true;
        (view as any).syncQueue();
      }),
      syncQueue: jest.fn(),
      applyFontSize: jest.fn(),
      applyTranscriptIdentity: jest.fn((snapshot: typeof loaded) => {
        (view as any).chatId = snapshot.chatId;
        (view as any).chatTitle = snapshot.title;
        (view as any).chatVersion = snapshot.version;
      }),
      syncAttachments: jest.fn(),
      updateViewState: jest.fn(),
      getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
      runPromotedQueuedSubmission,
    });

    await view.loadChatById(loaded.chatId);
    await Promise.resolve();

    expect(agent.hydrate).not.toHaveBeenCalled();
    expect(runPromotedQueuedSubmission).toHaveBeenCalledTimes(1);
    expect(runPromotedQueuedSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        item: queued[0],
        submission: expect.objectContaining({ text: "First queued" }),
      }),
      expect.stringMatching(/^conversation-origin-/),
    );
    expect((view as any).queuedFollowUps).toEqual([queued[1]]);
    expect((view as any).activeSubmissionOperation).toMatchObject({
      kind: "submission",
      originalSubmission: expect.objectContaining({ text: "First queued" }),
    });
    expect(setRunPending).toHaveBeenLastCalledWith(
      true,
      expect.stringMatching(/^user-/),
    );
  });

  it("promotes recovered-run follow-ups in FIFO order without exposing an idle gap", async () => {
    const finished = deferred();
    const executions: string[] = [];
    const setRunPending = jest.fn();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const executeSubmission = jest.fn(async (
      submission: AgentComposerSubmit,
      options: { activeOperation: any },
    ) => {
      executions.push(submission.text);
      const next = (view as any).promoteQueuedSubmission(
        options.activeOperation,
        "origin-recovered",
      );
      if (next) {
        await (view as any).runPromotedQueuedSubmission(
          next,
          "origin-recovered",
        );
      } else {
        (view as any).finishSubmissionOperation(options.activeOperation);
      }
      if (executions.length === 3) finished.resolve();
    });
    Object.assign(view, {
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-recovered",
      queuedFollowUps: [
        { id: "first", text: "First queued", includeContextFiles: true },
        { id: "second", text: "Second queued", includeContextFiles: false },
      ],
      runConversationOrigins: new Map<string, string>(),
      agent: {
        getSnapshot: jest.fn(() => ({ status: "completed" })),
      },
      workspace: {
        setAgentSnapshot: jest.fn(async () => undefined),
        setRunPending,
        setBanner: jest.fn(),
        restoreRejectedSubmission: jest.fn(),
      },
      syncQueue: jest.fn(),
      persistQueueState: jest.fn(async () => undefined),
      scheduleQueuePersistence: jest.fn(),
      executeSubmission,
    });

    (view as any).renderAgentSnapshot({
      runId: "run-recovered",
      turnId: "user-recovered",
      status: "completed",
      messages: [],
      parts: [],
    });
    expect((view as any).activeSubmissionOperation?.kind).toBe("submission");
    expect(setRunPending).toHaveBeenCalledWith(true, expect.stringMatching(/^user-/));

    (view as any).acceptComposerSubmission({
      text: "Fresh composer send",
      mode: "queue",
    });

    await finished.promise;

    expect(executions).toEqual([
      "First queued",
      "Second queued",
      "Fresh composer send",
    ]);
    expect((view as any).activeSubmissionOperation).toBeNull();
    expect(setRunPending).toHaveBeenLastCalledWith(false);
  });

  it.each(["failed", "cancelled"] as const)(
    "retains queued follow-ups when a recovered run terminalizes as %s",
    (status) => {
      const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
      const queued = {
        id: "retained",
        text: "Keep queued",
        includeContextFiles: true,
      };
      const executeSubmission = jest.fn();
      Object.assign(view, {
        activeSubmissionOperation: null,
        conversationOriginToken: "origin-recovered",
        queuedFollowUps: [queued],
        runConversationOrigins: new Map<string, string>(),
        workspace: {
          setAgentSnapshot: jest.fn(async () => undefined),
        },
        executeSubmission,
      });

      (view as any).renderAgentSnapshot({
        runId: "run-recovered",
        turnId: "user-recovered",
        status,
        messages: [],
        parts: [],
      });

      expect((view as any).queuedFollowUps).toEqual([queued]);
      expect((view as any).activeSubmissionOperation).toBeNull();
      expect(executeSubmission).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["bootstrap-after-admission", new Error("The transport bootstrap failed.")],
    ["midstream", new Error("The WebSocket connection ticket is invalid.")],
  ])("keeps %s failures diagnostics-only so the inline projection is the sole error", (
    _phase,
    error,
  ) => {
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const logger = { error: jest.fn() };
    const handleError = jest.fn();
    const setBanner = jest.fn();
    Object.assign(view, {
      plugin: { getLogger: () => logger },
      chatId: "chat-1",
      agent: { getSnapshot: () => ({ status: "running" }) },
      workspace: { setBanner },
      handleError,
      updateViewState: jest.fn(),
    });

    (view as any).logAgentError(error, "agentBridge");
    (view as any).handleRunResult();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(handleError).not.toHaveBeenCalled();
    expect(setBanner).not.toHaveBeenCalled();
  });

  it("does not let a retained failed snapshot suppress a later view error", async () => {
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const logger = { error: jest.fn() };
    const handleError = jest.fn(async () => undefined);
    const laterError = new Error("The current chat could not be restored.");
    Object.assign(view, {
      plugin: { getLogger: () => logger },
      chatId: "chat-failed-snapshot",
      agent: { getSnapshot: () => ({ status: "failed" }) },
      handleError,
    });

    (view as any).reportAgentError(laterError);
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledWith(laterError);
  });

  it("logs an asynchronous snapshot render rejection without adding a second UI error", async () => {
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const renderError = new Error("Markdown rendering rejected");
    const logger = { error: jest.fn() };
    const handleError = jest.fn();
    const setBanner = jest.fn();
    Object.assign(view, {
      plugin: { getLogger: () => logger },
      chatId: "chat-render-rejection",
      workspace: {
        setAgentSnapshot: jest.fn(async () => {
          throw renderError;
        }),
        setBanner,
      },
      handleError,
      runConversationOrigins: new Map<string, string>(),
    });

    (view as any).renderAgentSnapshot({
      runId: "run-render-rejection",
      turnId: "user-render-rejection",
      status: "running",
      messages: [],
      parts: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      "ChatView agent session failed",
      renderError,
      expect.objectContaining({
        source: "AgentChatView",
        method: "agentSnapshotRender",
      }),
    );
    expect(handleError).not.toHaveBeenCalled();
    expect(setBanner).not.toHaveBeenCalled();
  });

  it("does not restart a live draft when Obsidian replays its own leaf state", async () => {
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const startNewChat = jest.fn(async () => undefined);
    const setTitle = jest.fn();
    Object.assign(view, {
      isFullyLoaded: true,
      chatId: "",
      chatTitle: "Live draft",
      draftKey: "draft-live",
      workspace: { setTitle },
      startNewChat,
    });

    await view.setState({
      chatId: "",
      chatTitle: "Restored draft",
      draftKey: "draft-live",
    });

    expect(startNewChat).not.toHaveBeenCalled();
    expect((view as any).chatTitle).toBe("Restored draft");
    expect(setTitle).toHaveBeenCalledWith("Restored draft");
  });

  it("prepares a draft locally without ever opening a server connection", async () => {
    const conversationId = "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const hydrate = jest.fn(async () => undefined);
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      plugin: { settings: { licenseKey: "test-license" } },
      getLoadedPluginBuildId: jest.fn(async () => `sha256:${"d".repeat(64)}`),
      pendingThinConversationId: conversationId,
      thinBootstrapRequest: null,
      thinClientId: `client_${"c".repeat(32)}`,
      agent: { hydrate },
    });

    await expect((view as any).prepareThinConversation(conversationId))
      .resolves.toBeUndefined();

    expect(hydrate).not.toHaveBeenCalled();
    expect((view as any).thinBootstrapRequest).toMatchObject({
      conversation_id: conversationId,
    });
  });

  it("silently retires a superseded draft preparation without claiming the bootstrap", async () => {
    const conversationId = "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const replacementId = "conversation_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const buildIdStarted = deferred();
    let releaseBuildId!: (value: `sha256:${string}`) => void;
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      plugin: { settings: { licenseKey: "test-license" } },
      getLoadedPluginBuildId: jest.fn(() => {
        buildIdStarted.resolve();
        return new Promise<`sha256:${string}`>((resolve) => {
          releaseBuildId = resolve;
        });
      }),
      pendingThinConversationId: conversationId,
      thinBootstrapRequest: null,
      thinClientId: `client_${"c".repeat(32)}`,
      agent: { hydrate: jest.fn(async () => undefined) },
    });

    const preparing = (view as any).prepareThinConversation(conversationId);
    await buildIdStarted.promise;
    (view as any).pendingThinConversationId = replacementId;
    releaseBuildId(`sha256:${"d".repeat(64)}`);

    await expect(preparing).resolves.toBeUndefined();
    expect((view as any).thinBootstrapRequest).toBeNull();
    expect((view as any).agent.hydrate).not.toHaveBeenCalled();
  });

  it("still surfaces a draft preparation failure for the current draft", async () => {
    const conversationId = "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      plugin: { settings: { licenseKey: "test-license" } },
      getLoadedPluginBuildId: jest.fn(async () => {
        throw new Error("Current build identity is unavailable.");
      }),
      pendingThinConversationId: conversationId,
      thinBootstrapRequest: null,
      thinClientId: `client_${"c".repeat(32)}`,
      agent: { hydrate: jest.fn(async () => undefined) },
    });

    await expect((view as any).prepareThinConversation(conversationId))
      .rejects.toThrow("Current build identity is unavailable.");
    expect((view as any).agent.hydrate).not.toHaveBeenCalled();
  });

  it("detaches a transient Obsidian view without invoking explicit Stop", async () => {
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    const restoreRejectedSubmission = jest.fn();
    const setRunPending = jest.fn();
    const detach = jest.fn(async () => {
      expect((view as any).pendingThinConversationId).toBeNull();
      expect((view as any).thinBootstrapRequest).toBeNull();
    });
    const close = jest.fn(async () => undefined);
    const cancel = jest.fn(async () => undefined);
    const recordLifecycle = jest.fn();
    Object.assign(view, {
      queueDrainSuppressionDepth: 0,
      queuedFollowUps: [],
      pendingThinConversationId: "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      thinBootstrapRequest: { contract_version: "thin-agent-v1" },
      agent: { detach, close, cancel, recordLifecycle },
      chatId: "",
      draftKey: "draft",
      queueHydrated: false,
      queuePersistence: Promise.resolve(),
      transcript: { idle: jest.fn(async () => undefined) },
      agentUnsubscribe: null,
      transcriptCommitUnsubscribe: null,
      recorderToggleUnsubscribe: null,
      recorderTranscriptUnsubscribe: null,
      workspace: { setRunPending, restoreRejectedSubmission, setBanner: jest.fn() },
      activeSubmissionOperation: null,
      conversationOriginToken: "origin-close",
      syncQueue: jest.fn(),
    });
    const retiredOperation = (view as any).beginSubmissionOperation(
      "origin-close",
      { text: "Do not restore after close", mode: "send" },
    );
    recordLifecycle.mockClear();

    await view.onClose();

    expect(detach).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(recordLifecycle).not.toHaveBeenCalled();
    expect((view as any).workspace).toBeNull();
    expect(retiredOperation.controller.signal.aborted).toBe(true);
    expect(retiredOperation.settled).toBe(true);
    expect(restoreRejectedSubmission).not.toHaveBeenCalled();
    expect((view as any).queuedFollowUps).toEqual([
      expect.objectContaining({
        text: "Do not restore after close",
        includeContextFiles: true,
      }),
    ]);
    expect((view as any).activeSubmissionOperation).toBeNull();
  });

  it("remembers Allow for chat as trust for every non-trash vault mutation", () => {
    const sessionTrustedToolNames = new Set<string>();
    const respondToApproval = jest.fn(() => true);
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      sessionTrustedToolNames,
      agent: {
        getSnapshot: jest.fn(() => ({
          parts: [{
            kind: "tool",
            approvalId: "approval-create-folders",
            name: "create_folders",
            location: "vault",
          }],
        })),
        respondToApproval,
      },
    });

    (view as any).respondToToolApproval("approval-create-folders", true, true);

    expect(sessionTrustedToolNames).toEqual(new Set(["*"]));
    expect(respondToApproval).toHaveBeenCalledWith("approval-create-folders", true);
  });

  it("rolls back newly remembered chat trust when approval submission fails", () => {
    const sessionTrustedToolNames = new Set<string>();
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      sessionTrustedToolNames,
      agent: {
        getSnapshot: jest.fn(() => ({
          parts: [{
            kind: "tool",
            approvalId: "approval-create-folders",
            name: "create_folders",
            location: "vault",
          }],
        })),
        respondToApproval: jest.fn(() => false),
      },
    });

    (view as any).respondToToolApproval("approval-create-folders", true, true);

    expect(sessionTrustedToolNames).toEqual(new Set());
  });

  it("preserves pre-existing chat trust when a later approval submission fails", () => {
    const sessionTrustedToolNames = new Set<string>(["*"]);
    const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, any>;
    Object.assign(view, {
      sessionTrustedToolNames,
      agent: {
        getSnapshot: jest.fn(() => ({
          parts: [{
            kind: "tool",
            approvalId: "approval-write",
            name: "write",
            location: "vault",
          }],
        })),
        respondToApproval: jest.fn(() => false),
      },
    });

    (view as any).respondToToolApproval("approval-write", true, true);

    expect(sessionTrustedToolNames).toEqual(new Set(["*"]));
  });
});
