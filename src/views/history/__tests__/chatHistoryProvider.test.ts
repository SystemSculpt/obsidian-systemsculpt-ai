import { TFile, TFolder } from "obsidian";
import { createChatHistoryProvider } from "../chatHistoryProvider";
import * as ChatResumeUtils from "../../chatview/ChatResumeUtils";

jest.mock("../../chatview/ChatResumeUtils", () => ({
  openChatResumeDescriptor: jest.fn(),
}));

jest.mock("../../chatview/storage/ChatMarkdownSerializer", () => ({
  ChatMarkdownSerializer: {
    parseMarkdown: jest.fn((content: string) => ({
      metadata: {},
      messages: content.split("\n").map((line) => ({ role: "user", content: line })),
    })),
  },
}));

type Handler = (...args: unknown[]) => void;

function chatFile(path: string, mtime: number, size = 100): TFile {
  return new TFile({ path, stat: { mtime, ctime: mtime, size } });
}

function vaultHarness() {
  const current = chatFile("New/Chats/chat-new.md", Date.parse("2026-03-10T10:00:00.000Z"));
  const older = chatFile("Old/Chats/chat-old.md", Date.parse("2026-02-01T10:00:00.000Z"));
  const note = chatFile("New/Chats/Plain note.md", 1);
  const unindexed = chatFile("New/Chats/unindexed.md", 1);
  const folders = new Map<string, TFolder>([
    ["New/Chats", new TFolder({ path: "New/Chats", children: [current, note, unindexed] })],
    ["Old/Chats", new TFolder({ path: "Old/Chats", children: [older] })],
  ]);
  const files = new Map<string, TFile>([
    [current.path, current],
    [older.path, older],
    [note.path, note],
  ]);
  const frontmatter = new Map<string, Record<string, unknown>>([
    [current.path, {
      id: "chat-new",
      title: "Current chat",
      created: "2026-03-10T09:00:00.000Z",
      messageCount: 2,
    }],
    [older.path, {
      id: "chat-old",
      title: "Older chat",
      lastModified: "2026-02-01T10:00:00.000Z",
    }],
    [note.path, { title: "Not a chat" }],
  ]);
  const handlers = new Map<string, Handler>();
  const contents = new Map<string, string>([
    [current.path, "Hello\nThe Quarterly plan"],
    [older.path, "Archived question"],
  ]);
  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => folders.get(path) ?? files.get(path) ?? null),
    cachedRead: jest.fn(async (file: TFile) => contents.get(file.path) ?? ""),
    read: jest.fn(),
    adapter: { read: jest.fn(), list: jest.fn() },
    on: jest.fn((name: string, handler: Handler) => {
      handlers.set(`vault:${name}`, handler);
      return { name };
    }),
  };
  const metadataCache = {
    getFileCache: jest.fn((file: TFile) => file === unindexed
      ? null
      : { frontmatter: frontmatter.get(file.path) }),
    on: jest.fn((name: string, handler: Handler) => {
      handlers.set(`metadata:${name}`, handler);
      return { name };
    }),
  };
  const plugin = {
    app: { vault, metadataCache },
    settings: {
      chatsDirectory: "New/Chats",
      knownChatsDirectories: ["Old/Chats"],
      favoriteChats: ["chat-old"],
    },
    registerEvent: jest.fn(),
  } as any;
  return { plugin, vault, metadataCache, handlers, current, older, contents, frontmatter };
}

describe("chatHistoryProvider", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("lists chats in every known folder from cached frontmatter without reading them", async () => {
    const { plugin, vault } = vaultHarness();
    const entries = await createChatHistoryProvider(plugin).loadEntries();

    expect(entries.map((entry) => [entry.id, entry.title, entry.subtitle, entry.isFavorite]))
      .toEqual([
        ["chat:chat-new", "Current chat", "2 messages", false],
        ["chat:chat-old", "Older chat", "", true],
      ]);
    expect(entries[0].timestampMs).toBe(Date.parse("2026-03-10T10:00:00.000Z"));
    expect(entries[0].searchText).toBe("current chat\nchat-new");
    expect(vault.cachedRead).not.toHaveBeenCalled();
    expect(vault.read).not.toHaveBeenCalled();
    expect(vault.adapter.read).not.toHaveBeenCalled();
    expect(vault.adapter.list).not.toHaveBeenCalled();
  });

  it("opens chat history entries through the minimal managed resume descriptor", async () => {
    const { plugin } = vaultHarness();
    const [entry] = await createChatHistoryProvider(plugin).loadEntries();

    await entry.openPrimary();
    expect(ChatResumeUtils.openChatResumeDescriptor).toHaveBeenCalledWith(plugin, {
      chatId: "chat-new",
      title: "Current chat",
      chatPath: "New/Chats/chat-new.md",
      lastModified: Date.parse("2026-03-10T10:00:00.000Z"),
      messageCount: 2,
    }, undefined);

    const originLeaf = { id: "origin-chat-leaf" } as any;
    await entry.openPrimary(originLeaf);
    expect(ChatResumeUtils.openChatResumeDescriptor).toHaveBeenLastCalledWith(
      plugin,
      expect.objectContaining({ chatId: "chat-new" }),
      originLeaf,
    );
  });

  it("caches records and message text until a chat file changes", async () => {
    const { plugin, metadataCache, vault, handlers, current, contents, frontmatter } = vaultHarness();
    const provider = createChatHistoryProvider(plugin);
    const [first] = await provider.loadEntries();
    await provider.loadEntries();
    expect(metadataCache.getFileCache).toHaveBeenCalledTimes(4);
    expect(plugin.registerEvent).toHaveBeenCalledTimes(5);

    expect(await first.loadSearchText!()).toBe("hello\nthe quarterly plan");
    expect(await first.loadSearchText!()).toBe("hello\nthe quarterly plan");
    expect(vault.cachedRead).toHaveBeenCalledTimes(1);

    // An unrelated note elsewhere in the vault keeps the cache.
    handlers.get("vault:modify")!({ path: "Elsewhere/Note.md" });
    await provider.loadEntries();
    expect(metadataCache.getFileCache).toHaveBeenCalledTimes(4);

    frontmatter.set(current.path, { ...frontmatter.get(current.path), title: "Renamed chat" });
    contents.set(current.path, "Rewritten text");
    handlers.get("metadata:changed")!(current);
    const [renamed] = await provider.loadEntries();
    expect(renamed.title).toBe("Renamed chat");
    expect(await renamed.loadSearchText!()).toBe("rewritten text");
    expect(vault.cachedRead).toHaveBeenCalledTimes(2);

    handlers.get("vault:rename")!({ path: "Archive/moved.md" }, current.path);
    await provider.loadEntries();
    expect(metadataCache.getFileCache).toHaveBeenCalledTimes(12);
  });

  it("lists a chat created or deleted in a chats folder on the next load", async () => {
    const { plugin, handlers, current } = vaultHarness();
    const provider = createChatHistoryProvider(plugin);
    expect((await provider.loadEntries()).map((entry) => entry.id)).toEqual(["chat:chat-new", "chat:chat-old"]);

    const folder = plugin.app.vault.getAbstractFileByPath("New/Chats") as TFolder;
    folder.children.splice(folder.children.indexOf(current), 1);
    handlers.get("vault:delete")!(current);
    expect((await provider.loadEntries()).map((entry) => entry.id)).toEqual(["chat:chat-old"]);

    folder.children.push(current);
    handlers.get("vault:create")!(current);
    expect((await provider.loadEntries()).map((entry) => entry.id)).toEqual(["chat:chat-new", "chat:chat-old"]);
  });

  it("reads a chat again for search when a read failed, and keeps a corrupt chat's empty text", async () => {
    const { plugin, vault, older } = vaultHarness();
    const { ChatMarkdownSerializer } = jest.requireMock("../../chatview/storage/ChatMarkdownSerializer");
    const [current] = await createChatHistoryProvider(plugin).loadEntries();

    vault.cachedRead.mockRejectedValueOnce(new Error("busy"));
    expect(await current.loadSearchText!()).toBe("");
    expect(await current.loadSearchText!()).toBe("hello\nthe quarterly plan");
    expect(vault.cachedRead).toHaveBeenCalledTimes(2);

    const entries = await createChatHistoryProvider(plugin).loadEntries();
    const archived = entries.find((entry) => entry.id === "chat:chat-old")!;
    ChatMarkdownSerializer.parseMarkdown.mockReturnValueOnce(null);
    expect(await archived.loadSearchText!()).toBe("");
    expect(await archived.loadSearchText!()).toBe("");
    expect(vault.cachedRead.mock.calls.filter(([file]: [TFile]) => file === older)).toHaveLength(1);
  });
});
