import { createChatHistoryProvider } from "../chatHistoryProvider";
import { ChatStorageService } from "../../chatview/ChatStorageService";
import * as ChatResumeUtils from "../../chatview/ChatResumeUtils";

jest.mock("../../chatview/ChatStorageService", () => ({
  ChatStorageService: jest.fn(),
}));

jest.mock("../../chatview/ChatResumeUtils", () => ({
  openChatResumeDescriptor: jest.fn(),
}));

describe("chatHistoryProvider", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("opens chat history entries through the minimal managed resume descriptor", async () => {
    const loadChats = jest.fn(async () => [
      {
        id: "chat-1",
        title: "Chat 1",
        lastModified: Date.parse("2026-03-10T10:00:00.000Z"),
        messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }],
        chatPath: "SystemSculpt/Chats/chat-1.md",
      },
    ]);
    (ChatStorageService as jest.Mock).mockImplementation(() => ({ loadChats }));

    const plugin = {
      app: {},
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
        favoriteChats: [],
      },
    } as any;

    const provider = createChatHistoryProvider(plugin);
    const [entry] = await provider.loadEntries();

    expect(entry.badge).toBeUndefined();
    expect(entry.subtitle).toBe("2 messages");

    await entry.openPrimary();

    expect(ChatResumeUtils.openChatResumeDescriptor).toHaveBeenCalledWith(plugin, {
      chatId: "chat-1",
      title: "Chat 1",
      chatPath: "SystemSculpt/Chats/chat-1.md",
      lastModified: Date.parse("2026-03-10T10:00:00.000Z"),
      messageCount: 2,
    }, undefined);

    const originLeaf = { id: "origin-chat-leaf" } as any;
    await entry.openPrimary(originLeaf);

    expect(ChatResumeUtils.openChatResumeDescriptor).toHaveBeenLastCalledWith(plugin, {
      chatId: "chat-1",
      title: "Chat 1",
      chatPath: "SystemSculpt/Chats/chat-1.md",
      lastModified: Date.parse("2026-03-10T10:00:00.000Z"),
      messageCount: 2,
    }, originLeaf);
  });

});
