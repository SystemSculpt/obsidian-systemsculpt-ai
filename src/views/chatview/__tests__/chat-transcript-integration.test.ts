/**
 * @jest-environment jsdom
 */

import type { ChatMessage } from "../../../types";
import { ChatView } from "../ChatView";
import { ChatTurn } from "../turn/ChatTurn";

function msg(message_id: string, role: "user" | "assistant" | "tool", content = message_id): ChatMessage {
  return { message_id, role, content } as ChatMessage;
}

function createView(initial: ChatMessage[] = []) {
  const view = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  let durable = clone(initial);
  let version = 1;
  view.messages = initial;
  view.chatId = "chat-1";
  view.chatVersion = version;
  view.isFullyLoaded = true;
  view.chatTitle = "Transcript";
  view.chatBackend = "legacy";
  view.chatFontSize = "medium";
  view.plugin = { settings: { chatsDirectory: "Chats" } };
  view.app = { workspace: { trigger: jest.fn() } };
  view.contextManager = { getContextFiles: jest.fn(() => new Set()) };
  view.inputHandler = { waitForPersistenceIdle: jest.fn().mockResolvedValue(undefined) };
  view.getPersistedSelectedModelId = jest.fn(() => "model");
  view.updateViewState = jest.fn();
  view.addMessage = jest.fn(async () => {});
  view.clearPiSessionState = jest.fn();
  view.chatStorage = {
    saveChat: jest.fn(async (_id: string, messages: ChatMessage[]) => {
      durable = clone(messages);
      return { version: ++version };
    }),
    createChatExclusive: jest.fn(async (_id: string, messages: ChatMessage[]) => {
      durable = clone(messages);
      return { version: ++version };
    }),
    loadChat: jest.fn(async () => ({ messages: clone(durable), version })),
  };
  return {
    view,
    durable: () => durable,
    completeLegacyAutosave: (messages: ChatMessage[]) => { durable = clone(messages); },
  };
}

describe("ChatView ChatTranscript integration", () => {
  it("keeps user durable and mutable projections in parity", async () => {
    const { view, durable } = createView();
    await view.persistSubmittedUserMessage(msg("u1", "user"));
    expect(view.messages).toEqual(durable());
  });

  it("keeps assistant durable and mutable projections in parity", async () => {
    const { view, durable } = createView([msg("u1", "user")]);
    await view.persistAssistantMessage(msg("a1", "assistant"), { syncPiTranscript: false });
    expect(view.messages).toEqual(durable());
  });

  it("keeps tool checkpoint durable and mutable projections in parity", async () => {
    const { view, durable } = createView();
    await view.addMessageToHistory(msg("t1", "tool"));
    expect(view.messages).toEqual(durable());
  });

  it("uses one transcript across sequential user and assistant commits", async () => {
    const { view } = createView();
    await view.persistSubmittedUserMessage(msg("u1", "user"));
    await view.persistAssistantMessage(msg("a1", "assistant"), { syncPiTranscript: false });
    expect(view.messages.map((entry) => entry.message_id)).toEqual(["u1", "a1"]);
  });

  it("preserves workspace event order after durable user commit", async () => {
    const { view } = createView();
    await view.persistSubmittedUserMessage(msg("u1", "user"));
    expect(view.updateViewState).toHaveBeenCalled();
    expect(view.app.workspace.trigger).toHaveBeenCalledWith("systemsculpt:chat-message-added", "chat-1");
  });

  it("does not publish a failed user candidate", async () => {
    const { view } = createView();
    view.chatStorage.saveChat.mockRejectedValueOnce(new Error("disk"));
    await expect(view.persistSubmittedUserMessage(msg("u1", "user"))).rejects.toMatchObject({ operation: "user_commit" });
    expect(view.messages).toEqual([]);
  });

  it("does not publish a failed assistant candidate", async () => {
    const original = [msg("u1", "user")];
    const { view } = createView(original);
    view.chatStorage.saveChat.mockRejectedValueOnce(new Error("disk"));
    await expect(view.persistAssistantMessage(msg("a1", "assistant"), { syncPiTranscript: false })).rejects.toMatchObject({ operation: "assistant_commit" });
    expect(view.messages).toBe(original);
  });

  it("does not publish a failed tool checkpoint", async () => {
    const { view } = createView();
    view.chatStorage.saveChat.mockRejectedValueOnce(new Error("disk"));
    await expect(view.addMessageToHistory(msg("t1", "tool"))).rejects.toMatchObject({ operation: "tool_checkpoint" });
    expect(view.messages).toEqual([]);
  });

  it("retries a failed candidate through the same transcript", async () => {
    const { view } = createView();
    view.chatStorage.saveChat.mockRejectedValueOnce(new Error("disk"));
    await expect(view.persistSubmittedUserMessage(msg("u1", "user"))).rejects.toBeTruthy();
    await expect(view.persistSubmittedUserMessage(msg("u1", "user"))).resolves.toBeUndefined();
    expect(view.chatStorage.saveChat).toHaveBeenCalledTimes(2);
  });

  it("rejects an out-of-order candidate built from the shared base", async () => {
    const { view } = createView();
    let release!: (value: { version: number }) => void;
    view.chatStorage.saveChat.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = view.persistSubmittedUserMessage(msg("u1", "user"));
    const second = view.persistSubmittedUserMessage(msg("u2", "user"));
    release({ version: 2 });
    await first;
    await expect(second).rejects.toMatchObject({ cause: { code: "chat_transcript_stale_transition" } });
  });

  it("rebuilds the mutable projection when a workspace projection fails", async () => {
    const { view, durable } = createView();
    view.updateViewState.mockImplementationOnce(() => { throw new Error("projection"); });
    await view.persistSubmittedUserMessage(msg("u1", "user"));
    expect(view.chatStorage.loadChat).toHaveBeenCalledTimes(1);
    expect(view.messages).toEqual(durable());
  });

  it("waits for an in-flight legacy autosave before a user commit wins durable state", async () => {
    const { view, durable, completeLegacyAutosave } = createView();
    let release!: () => void;
    view.inputHandler.waitForPersistenceIdle.mockReturnValueOnce(new Promise<void>((resolve) => {
      release = () => {
        completeLegacyAutosave([msg("stale-user", "user")]);
        resolve();
      };
    }));

    const commit = view.persistSubmittedUserMessage(msg("u-race", "user"));
    expect(view.chatStorage.saveChat).not.toHaveBeenCalled();
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();
    release();
    await commit;

    expect(durable().map((entry) => entry.message_id)).toEqual(["u-race"]);
    expect(view.app.workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight legacy autosave before an assistant commit wins durable state", async () => {
    const { view, durable, completeLegacyAutosave } = createView([msg("u1", "user")]);
    let release!: () => void;
    view.inputHandler.waitForPersistenceIdle.mockReturnValueOnce(new Promise<void>((resolve) => {
      release = () => {
        completeLegacyAutosave([msg("u1", "user"), msg("stale-assistant", "assistant")]);
        resolve();
      };
    }));

    const commit = view.persistAssistantMessage(msg("a-race", "assistant"), { syncPiTranscript: false });
    expect(view.chatStorage.saveChat).not.toHaveBeenCalled();
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();
    release();
    await commit;

    expect(durable().map((entry) => entry.message_id)).toEqual(["u1", "a-race"]);
    expect(view.app.workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight legacy autosave before a tool checkpoint wins durable state", async () => {
    const { view, durable, completeLegacyAutosave } = createView([msg("u1", "user")]);
    let release!: () => void;
    view.inputHandler.waitForPersistenceIdle.mockReturnValueOnce(new Promise<void>((resolve) => {
      release = () => {
        completeLegacyAutosave([msg("u1", "user"), msg("stale-tool", "tool")]);
        resolve();
      };
    }));

    const commit = view.addMessageToHistory(msg("t-race", "tool"));
    expect(view.chatStorage.saveChat).not.toHaveBeenCalled();
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();
    release();
    await commit;

    expect(durable().map((entry) => entry.message_id)).toEqual(["u1", "t-race"]);
    expect(view.app.workspace.trigger).toHaveBeenCalledTimes(1);
  });

  it("prevents an authoritative commit when the legacy autosave join fails", async () => {
    const { view } = createView();
    const failure = { code: "chat_persistence_failed", operation: "flush", chatId: "chat-1" };
    view.inputHandler.waitForPersistenceIdle.mockRejectedValueOnce(failure);

    await expect(view.persistSubmittedUserMessage(msg("u-blocked", "user"))).rejects.toMatchObject(failure);
    expect(view.chatStorage.saveChat).not.toHaveBeenCalled();
    expect(view.messages).toEqual([]);
    expect(view.app.workspace.trigger).not.toHaveBeenCalled();
  });

  it("keeps a durable tool checkpoint and truthful continuation when Pi transcript sync rejects", async () => {
    const pendingTool = {
      id: "tool-1",
      state: "pending",
      request: { function: { name: "search", arguments: "{}" } },
    } as any;
    const initialAssistant = {
      role: "assistant",
      content: "",
      message_id: "a-tool",
      tool_calls: [pendingTool],
    } as ChatMessage;
    const { view, durable } = createView([msg("u1", "user")]);
    view.isPiBackedChat = jest.fn(() => true);
    view.getPiSessionFile = jest.fn(() => "/tmp/session.jsonl");
    const piFailure = new Error("Pi transcript unavailable");
    view.syncPiSessionTranscript = jest.fn().mockRejectedValue(piFailure);
    const continuation = jest.fn(async () => ({
      message: msg("a-final", "assistant", "done"),
      messageId: "a-final",
      messageEl: {} as HTMLElement,
      completionState: "content",
      stopReason: "stop",
    }));
    const turn = new ChatTurn({
      signal: new AbortController().signal,
      commitUser: async () => {},
      commitAssistant: async () => {},
      runInitialStream: async () => ({
        message: initialAssistant,
        messageId: "a-tool",
        messageEl: {} as HTMLElement,
        completionState: "content",
        stopReason: "tool_calls",
      }),
      shouldContinueTools: () => true,
      requestToolApproval: async () => true,
      executeTool: async (toolCall) => {
        toolCall.state = "completed";
        toolCall.result = { success: true, data: "result" };
      },
      commitToolCheckpoint: (message) => view.persistAssistantMessage(message, { operation: "tool_checkpoint" }).then(() => undefined),
      renderToolCheckpoint: async () => {},
      runContinuationStream: continuation,
    });

    await turn.run(msg("turn-user", "user", "search"));

    expect(view.syncPiSessionTranscript).toHaveBeenCalledTimes(1);
    expect(view.syncPiSessionTranscript).toHaveBeenCalledWith({ syncTitle: true, render: false, persist: true, force: true });
    expect(turn.outcome).toBe("completed");
    expect(continuation).toHaveBeenCalledTimes(1);
    expect(durable()).toEqual([
      msg("u1", "user"),
      expect.objectContaining({
        message_id: "a-tool",
        tool_calls: [expect.objectContaining({
          id: "tool-1",
          state: "completed",
          result: { success: true, data: "result" },
        })],
      }),
    ]);
    expect(view.messages).toEqual(durable());
    expect(view.messages.some((entry) => entry.message_id === "a-tool")).toBe(true);
  });

  it("keeps the accepted projection readonly and the durable snapshot isolated", async () => {
    const { view, durable } = createView();
    await view.persistAssistantMessage(msg("a1", "assistant"), { syncPiTranscript: false });
    expect(() => { view.messages[0].content = "legacy mutation"; }).toThrow();
    expect(durable()[0].content).toBe("a1");
  });
});
