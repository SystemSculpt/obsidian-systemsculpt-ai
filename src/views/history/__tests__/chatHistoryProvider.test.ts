import { createChatHistoryProvider } from "../chatHistoryProvider";
import { ChatStorageService } from "../../chatview/ChatStorageService";
import { ChatFavoritesService } from "../../chatview/ChatFavoritesService";
import * as ChatResumeUtils from "../../chatview/ChatResumeUtils";

jest.mock("../../chatview/ChatStorageService", () => ({
  ChatStorageService: jest.fn(),
}));

jest.mock("../../chatview/ChatFavoritesService", () => ({
  ChatFavoritesService: {
    getInstance: jest.fn(),
  },
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
    (ChatFavoritesService.getInstance as jest.Mock).mockReturnValue({
      isFavorite: jest.fn(() => false),
      toggleFavorite: jest.fn(async () => false),
    });

    const plugin = {
      app: {},
      settings: {
        chatsDirectory: "SystemSculpt/Chats",
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
    });
  });

  it("labels portable metadata-only entries without inventing a message count", async () => {
    const loadChats = jest.fn(async () => [
      {
        id: "mobile-chat",
        title: "Mobile Chat",
        lastModified: Date.parse("2026-07-15T10:00:00.000Z"),
        messages: [],
        messagesLoaded: false,
        chatPath: "SystemSculpt/Chats/mobile-chat.md",
      },
    ]);
    (ChatStorageService as jest.Mock).mockImplementation(() => ({ loadChats }));
    (ChatFavoritesService.getInstance as jest.Mock).mockReturnValue({
      isFavorite: jest.fn(() => false),
      toggleFavorite: jest.fn(async () => false),
    });

    const plugin = {
      app: {},
      settings: { chatsDirectory: "SystemSculpt/Chats" },
    } as any;

    const [entry] = await createChatHistoryProvider(plugin).loadEntries();

    expect(entry.subtitle).toBe("Saved chat");
    expect(entry.searchText).toContain("mobile chat");
  });
});
