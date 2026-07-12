/** @jest-environment jsdom */
import type { ChatMessage } from "../../../types";
import { ChatView } from "../ChatView";

function user(id: string): ChatMessage { return { role: "user", content: id, message_id: id } as ChatMessage; }

describe("ChatView accepted ownership", () => {
  it("keeps an accepted old-chat commit durable without projecting or claiming it after a concurrent chat switch", async () => {
    const view = Object.create(ChatView.prototype) as ChatView & Record<string, any>;
    let release!: (value: { version: number }) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    let durableOld: readonly ChatMessage[] = [];
    view.messages = [user("old-user")];
    view.chatId = "old-chat";
    view.chatVersion = 1;
    view.isFullyLoaded = true;
    view.chatTitle = "Old";
    view.chatBackend = "legacy";
    view.chatFontSize = "medium";
    view.plugin = { settings: { chatsDirectory: "Chats" } };
    view.app = { workspace: { trigger: jest.fn() } };
    view.contextManager = { getContextFiles: () => new Set() };
    view.inputHandler = { waitForPersistenceIdle: async () => {} };
    view.getPersistedSelectedModelId = () => "model";
    view.updateViewState = jest.fn();
    view.addMessage = jest.fn();
    view.chatOwnershipGeneration = 1;
    view.chatStorage = {
      saveChat: jest.fn(async (_chatId: string, messages: ChatMessage[]) => {
        durableOld = messages;
        markSaveStarted();
        return await new Promise<{ version: number }>((resolve) => { release = resolve; });
      }),
      loadChat: jest.fn(), createChatExclusive: jest.fn(),
    };

    const commit = view.commitAcceptedUserMessage({ kind: "append", message: user("accepted-old") });
    await saveStarted;
    view.chatOwnershipGeneration = 2;
    view.chatId = "new-chat";
    view.messages = [user("new-user")];
    view.chatTranscript = null;
    release({ version: 2 });

    const result = await commit;
    expect(result.status).toBe("accepted_not_current");
    expect(view.claimAcceptedUserCommit(result)).toBe(false);
    expect(view.chatId).toBe("new-chat");
    expect(view.messages.map((entry) => entry.message_id)).toEqual(["new-user"]);
    expect(durableOld.map((entry) => entry.message_id)).toEqual(["old-user", "accepted-old"]);
    expect(view.addMessage).not.toHaveBeenCalled();
  });
});
