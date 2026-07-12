/**
 * @jest-environment jsdom
 */

import type { ChatMessage } from "../../../types";
import { ChatView } from "../ChatView";

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
    await view.persistAssistantMessage(msg("a1", "assistant"));
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
    await view.persistAssistantMessage(msg("a1", "assistant"));
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
    await expect(view.persistAssistantMessage(msg("a1", "assistant"))).rejects.toMatchObject({ operation: "assistant_commit" });
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

    const commit = view.persistAssistantMessage(msg("a-race", "assistant"));
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

  it("keeps the accepted projection readonly and the durable snapshot isolated", async () => {
    const { view, durable } = createView();
    await view.persistAssistantMessage(msg("a1", "assistant"));
    expect(() => { view.messages[0].content = "legacy mutation"; }).toThrow();
    expect(durable()[0].content).toBe("a1");
  });
});
