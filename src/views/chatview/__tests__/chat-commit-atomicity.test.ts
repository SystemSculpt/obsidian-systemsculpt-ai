/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";
import { ChatIdAllocator } from "../persistence/ChatIdAllocator";
import { ChatPersistenceError } from "../persistence/ChatPersistenceError";
import type { ChatMessage } from "../../../types";

const fixedDate = new Date(2026, 6, 10, 12, 34, 56);

function createView(messages: ChatMessage[] = []) {
  const view = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
  view.messages = messages;
  view.chatId = "chat-existing";
  view.chatTitle = "Atomic chat";
  view.chatVersion = 1;
  view.isFullyLoaded = true;
  view.chatBackend = "legacy";
  view.chatFontSize = "medium";
  view.hideSystemMessages = false;
  view.agentModeEnabled = false;
  view.chatContainer = document.createElement("div");
  view.chatStorage = {
    saveChat: jest.fn().mockResolvedValue({ version: 2 }),
    createChatExclusive: jest.fn().mockResolvedValue({ version: 1 }),
    loadChat: jest.fn(),
  };
  view.plugin = { settings: { chatsDirectory: "Chats" } };
  view.app = {
    vault: {
      getAbstractFileByPath: jest.fn(() => null),
      adapter: { exists: jest.fn(async () => false) },
    },
    workspace: { trigger: jest.fn() },
  };
  view.contextManager = { getContextFiles: jest.fn(() => new Set()) };
  view.messageRenderer = {
    renderMessage: jest.fn(async ({ messageId }: any) => {
      const messageEl = document.createElement("div");
      messageEl.dataset.messageId = messageId;
      return { messageEl, contentEl: document.createElement("div") };
    }),
    normalizeMessageToParts: jest.fn(() => ({ parts: [] })),
  };
  view.shouldRenderMessageRole = jest.fn(() => true);
  view.manageDomSize = jest.fn();
  view.register = jest.fn();
  view.updateViewState = jest.fn();
  view.getPersistedSelectedModelId = jest.fn(() => "model");
  view.generateMessageId = jest.fn(() => "generated");
  view.initializeChatTitle = jest.fn();
  view.clearPiSessionState = jest.fn();
  view.renderMessagesInChunks = jest.fn(async () => {});
  view.addMessage = jest.fn(async (_role: string, _content: unknown, messageId: string) => {
    const node = document.createElement("div");
    node.dataset.messageId = messageId;
    view.chatContainer.appendChild(node);
  });
  return view;
}

describe("authoritative transcript commits", () => {
  it("allocates distinct deterministic IDs for same-second chats", async () => {
    const existing = new Set(["2026-07-10 12-34-56"]);
    const allocator = new ChatIdAllocator(async (id) => {
      if (existing.has(id)) return null;
      existing.add(id);
      return id;
    }, () => fixedDate);

    await expect(allocator.allocate()).resolves.toEqual({
      chatId: "2026-07-10 12-34-56-2",
      value: "2026-07-10 12-34-56-2",
    });

    const view = createView([]);
    view.chatId = "";
    const allocationCause = new Error("exclusive create unavailable");
    (view.chatStorage.createChatExclusive as jest.Mock).mockRejectedValue(allocationCause);
    await expect(view.persistSubmittedUserMessage({
      role: "user", content: "hello", message_id: "user-new",
    } as ChatMessage)).rejects.toEqual(expect.objectContaining({
      code: "chat_persistence_failed",
      operation: "user_commit",
      cause: allocationCause,
    }));
  });

  it("leaves user memory, ID, DOM, and events unchanged when storage fails", async () => {
    const original = [{ role: "system", content: "seed", message_id: "seed" }] as ChatMessage[];
    const view = createView(original);
    const cause = new Error("disk full");
    (view.chatStorage.saveChat as jest.Mock).mockRejectedValue(cause);
    const beforeDom = view.chatContainer.innerHTML;

    await expect(view.persistSubmittedUserMessage({
      role: "user", content: "hello", message_id: "user-1",
    } as ChatMessage)).rejects.toEqual(expect.objectContaining({
      code: "chat_persistence_failed",
      operation: "user_commit",
      chatId: "chat-existing",
      cause,
    }));

    expect(view.messages).toBe(original);
    expect(view.messages).toHaveLength(1);
    expect(view.chatId).toBe("chat-existing");
    expect(view.chatContainer.innerHTML).toBe(beforeDom);
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();
  });

  it("leaves assistant memory, DOM, and events unchanged when storage fails", async () => {
    const original = [{ role: "user", content: "hello", message_id: "user-1" }] as ChatMessage[];
    const view = createView(original);
    (view.chatStorage.saveChat as jest.Mock).mockRejectedValue(new Error("offline"));

    await expect(view.persistAssistantMessage({
      role: "assistant", content: "reply", message_id: "assistant-1",
    } as ChatMessage, { syncPiTranscript: false })).rejects.toEqual(expect.objectContaining({
      operation: "assistant_commit",
    }));

    expect(view.messages).toBe(original);
    expect(view.chatContainer.childElementCount).toBe(0);
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();
  });

  it("reports initial tool-bearing assistant persistence as assistant_commit", async () => {
    const view = createView([{ role: "user", content: "use tool", message_id: "user-1" }] as ChatMessage[]);
    const cause = new Error("offline");
    (view.chatStorage.saveChat as jest.Mock).mockRejectedValue(cause);

    await expect(view.persistAssistantMessage({
      role: "assistant", content: "", message_id: "assistant-tool", tool_calls: [{ id: "call-1" }],
    } as ChatMessage, { syncPiTranscript: false, operation: "assistant_commit" })).rejects.toEqual(expect.objectContaining({
      code: "chat_persistence_failed",
      operation: "assistant_commit",
      cause,
    }));
  });

  it("leaves tool checkpoint memory, DOM, and events unchanged when storage fails", async () => {
    const original = [{ role: "user", content: "use tool", message_id: "user-1" }] as ChatMessage[];
    const view = createView(original);
    (view.chatStorage.saveChat as jest.Mock).mockRejectedValue(new Error("offline"));

    await expect(view.persistAssistantMessage({
      role: "assistant", content: "", message_id: "assistant-tool", tool_calls: [{ id: "call-1" }],
    } as ChatMessage, { syncPiTranscript: false })).rejects.toEqual(expect.objectContaining({
      operation: "tool_checkpoint",
    }));

    expect(view.messages).toBe(original);
    expect(view.chatContainer.childElementCount).toBe(0);
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();
  });

  it("projects a user commit only after durable storage succeeds", async () => {
    let release!: (value: { version: number }) => void;
    const view = createView([]);
    (view.chatStorage.saveChat as jest.Mock).mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const promise = view.persistSubmittedUserMessage({ role: "user", content: "hello", message_id: "user-1" } as ChatMessage);
    expect(view.messages).toEqual([]);
    expect(view.chatContainer.childElementCount).toBe(0);
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();

    release({ version: 2 });
    await promise;
    expect(view.messages.map((message) => message.message_id)).toEqual(["user-1"]);
    expect(view.chatContainer.childElementCount).toBe(1);
    expect(view.app.workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("projects an assistant commit only after durable storage succeeds", async () => {
    let release!: (value: { version: number }) => void;
    const view = createView([]);
    (view.chatStorage.saveChat as jest.Mock).mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const promise = view.persistAssistantMessage({ role: "assistant", content: "reply", message_id: "assistant-1" } as ChatMessage, { syncPiTranscript: false });
    expect(view.messages).toEqual([]);
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();

    release({ version: 2 });
    await promise;
    expect(view.messages.map((message) => message.message_id)).toEqual(["assistant-1"]);
    expect(view.app.workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("projects a tool checkpoint only after durable storage succeeds", async () => {
    let release!: (value: { version: number }) => void;
    const view = createView([]);
    (view.chatStorage.saveChat as jest.Mock).mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const promise = view.persistAssistantMessage({
      role: "assistant", content: "", message_id: "assistant-tool", tool_calls: [{ id: "call-1" }],
    } as ChatMessage, { syncPiTranscript: false });
    expect(view.messages).toEqual([]);
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();

    release({ version: 2 });
    await promise;
    expect(view.messages[0].tool_calls?.[0].id).toBe("call-1");
    expect(view.app.workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("skips suffix collisions and keeps resend retries and projection recovery authoritative", async () => {
    const existing = new Set([
      "2026-07-10 12-34-56",
      "2026-07-10 12-34-56-2",
      "2026-07-10 12-34-56-3",
    ]);
    const createExclusive = async (id: string) => {
      if (existing.has(id)) return null;
      existing.add(id);
      return id;
    };
    const allocator = new ChatIdAllocator(createExclusive, () => fixedDate);
    await expect(allocator.allocate()).resolves.toEqual({
      chatId: "2026-07-10 12-34-56-4",
      value: "2026-07-10 12-34-56-4",
    });

    const concurrentIds = new Set<string>();
    const concurrentCreate = async (id: string) => {
      if (concurrentIds.has(id)) return null;
      concurrentIds.add(id);
      await Promise.resolve();
      return id;
    };
    const [first, second] = await Promise.all([
      new ChatIdAllocator(concurrentCreate, () => fixedDate).allocate(),
      new ChatIdAllocator(concurrentCreate, () => fixedDate).allocate(),
    ]);
    expect([first.chatId, second.chatId].sort()).toEqual([
      "2026-07-10 12-34-56",
      "2026-07-10 12-34-56-2",
    ]);

    for (const index of [0, 2]) {
      const original = [
        { role: "user", content: "first", message_id: "user-1" },
        { role: "assistant", content: "reply", message_id: "assistant-1" },
        { role: "user", content: "again", message_id: "user-2" },
      ] as ChatMessage[];
      const view = createView(original);
      const failure = new Error("disk failed");
      (view.chatStorage.saveChat as jest.Mock).mockRejectedValue(failure);
      (view.chatStorage.createChatExclusive as jest.Mock).mockRejectedValue(failure);
      await expect(view.commitResendBranch(index)).rejects.toEqual(expect.objectContaining({
        operation: "resend_branch",
      }));
      expect(view.messages).toBe(original);
      expect(view.chatId).toBe("chat-existing");
    }

    const retryView = createView([
      { role: "user", content: "first", message_id: "user-1" },
      { role: "assistant", content: "reply", message_id: "assistant-1" },
      { role: "user", content: "again", message_id: "user-2" },
    ] as ChatMessage[]);
    (retryView.chatStorage.saveChat as jest.Mock)
      .mockRejectedValueOnce(new Error("retry"))
      .mockResolvedValueOnce({ version: 2 });
    await expect(retryView.commitResendBranch(2)).rejects.toBeInstanceOf(ChatPersistenceError);
    await retryView.commitResendBranch(2);
    expect(retryView.messages.map((message) => message.message_id)).toEqual(["user-1", "assistant-1"]);

    const recoveryView = createView([
      { role: "user", content: "first", message_id: "user-1" },
      { role: "assistant", content: "reply", message_id: "assistant-1" },
      { role: "user", content: "again", message_id: "user-2" },
    ] as ChatMessage[]);
    const durable = recoveryView.messages.slice(0, 2);
    (recoveryView.chatStorage.loadChat as jest.Mock).mockResolvedValue({ messages: durable, version: 2 });
    (recoveryView.renderMessagesInChunks as jest.Mock)
      .mockRejectedValueOnce(new Error("projection failed"))
      .mockResolvedValueOnce(undefined);
    await recoveryView.commitResendBranch(2);
    expect(recoveryView.chatStorage.loadChat).toHaveBeenCalledWith("chat-existing");
    expect(recoveryView.messages).toEqual(durable);
    expect(recoveryView.renderMessagesInChunks).toHaveBeenCalledTimes(2);

    const firstMessageRetryView = createView([
      { role: "user", content: "first", message_id: "user-first" },
      { role: "assistant", content: "reply", message_id: "assistant-first" },
    ] as ChatMessage[]);
    (firstMessageRetryView.chatStorage.createChatExclusive as jest.Mock).mockResolvedValue({ version: 1 });
    (firstMessageRetryView.chatStorage.loadChat as jest.Mock).mockResolvedValue({ messages: [], version: 1 });
    (firstMessageRetryView.renderMessagesInChunks as jest.Mock)
      .mockRejectedValueOnce(new Error("initial projection failed"))
      .mockRejectedValueOnce(new Error("recovery projection failed"))
      .mockResolvedValueOnce(undefined);

    await expect(firstMessageRetryView.commitResendBranch(0, "user-first")).rejects.toThrow(
      "recovery projection failed"
    );
    const durableBranchId = firstMessageRetryView.chatId;
    expect(durableBranchId).not.toBe("chat-existing");
    expect(firstMessageRetryView.chatStorage.createChatExclusive).toHaveBeenCalledTimes(1);

    await expect(firstMessageRetryView.retryPendingResend("user-first")).resolves.toBe(true);
    expect(firstMessageRetryView.chatId).toBe(durableBranchId);
    expect(firstMessageRetryView.chatStorage.createChatExclusive).toHaveBeenCalledTimes(1);
    expect(firstMessageRetryView.chatStorage.saveChat).not.toHaveBeenCalled();
  });
});
