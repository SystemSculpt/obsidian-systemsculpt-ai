/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import type { ChatMessage } from "../../../types";
import type SystemSculptPlugin from "../../../main";
import { AgentTranscriptRepository } from "../AgentTranscriptRepository";
import {
  ChatStorageService,
  resolveChatsDirectory,
  resolveKnownChatsDirectories,
} from "../ChatStorageService";
import { ChatMarkdownSerializer } from "../storage/ChatMarkdownSerializer";
import { ChatAttachmentVaultStore, type ChatAttachmentStoreAdapter } from "../attachments/ChatAttachmentVaultStore";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    stringifyYaml: jest.fn((value: Record<string, unknown>) => Object.entries(value)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join("\n") + "\n"),
    parseYaml: jest.fn((content: string) => {
      const result: Record<string, any> = {};
      for (const line of content.split("\n")) {
        const match = line.match(/^(\w+):\s*(.*)$/);
        if (!match) continue;
        const [, key, value] = match;
        if (value === "true" || value === "false") result[key] = value === "true";
        else if (!Number.isNaN(Number(value)) && value.trim() !== "") result[key] = Number(value);
        else result[key] = value.replace(/^["']|["']$/g, "");
      }
      return result;
    }),
  };
});

function appHarness(markdown: string) {
  const binaryFiles = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const adapter: ChatAttachmentStoreAdapter & { read: jest.Mock; exists: jest.Mock; mkdir: jest.Mock } = {
    exists: jest.fn(async (path: string) => directories.has(path) || binaryFiles.has(path) || path === "SystemSculpt/Chats"),
    mkdir: jest.fn(async (path: string) => { directories.add(path); }),
    read: jest.fn(async () => markdown),
    readBinary: jest.fn(async (path: string) => {
      const bytes = binaryFiles.get(path);
      if (!bytes) throw new Error("missing");
      return bytes.slice().buffer;
    }),
    writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
      binaryFiles.set(path, new Uint8Array(data));
    }),
    list: jest.fn(async (path: string) => ({
      files: path === "SystemSculpt/Chats" ? ["SystemSculpt/Chats/test-chat.md"] : [],
      folders: [],
    })),
  };
  const file = new TFile({ path: "SystemSculpt/Chats/test-chat.md" });
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: jest.fn(() => file),
      read: jest.fn(async () => markdown),
      modify: jest.fn(async () => undefined),
      create: jest.fn(async () => file),
      createFolder: jest.fn(async () => undefined),
    },
    plugins: { plugins: {} },
  } as unknown as App;
  return { app, adapter, binaryFiles };
}

function buildMarkdown(message: ChatMessage): string {
  return [
    "---",
    "id: test-chat",
    "created: 2026-07-13T00:00:00.000Z",
    "lastModified: 2026-07-13T00:00:00.000Z",
    "title: Test chat",
    "version: 1",
    "---",
    "",
    ChatMarkdownSerializer.serializeMessages([message]),
  ].join("\n");
}

function imageAttachment(id: string) {
  return {
    status: "ready" as const,
    id,
    name: "diagram.png",
    mimeType: "image/png",
    byteLength: 3,
    kind: "image" as const,
    contentPart: { type: "image_url" as const, image_url: { url: "data:image/png;base64,AQID" } },
  };
}

describe("ChatStorageService attachment hydration", () => {
  it("keeps ref-backed attachments lazy while loading and hydrates them on demand", async () => {
    const runtimeMessage: ChatMessage = {
      role: "user",
      message_id: "user-1",
      content: [
        { type: "text", text: "Compare this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    };
    const { app, adapter } = appHarness("");
    const store = new ChatAttachmentVaultStore(adapter);
    const [externalized] = await store.externalizeAttachments([{
      status: "ready",
      id: "image-1",
      name: "diagram.png",
      mimeType: "image/png",
      byteLength: 3,
      kind: "image",
      contentPart: runtimeMessage.content![1] as any,
    }]);
    const markdown = buildMarkdown({
      ...runtimeMessage,
      attachmentMetadata: [{
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image",
        contentPartIndex: 1,
        contentRef: externalized.contentRef,
      }],
    });
    (app.vault.read as jest.Mock).mockResolvedValue(markdown);
    adapter.read.mockResolvedValue(markdown);

    const service = new ChatStorageService(app, "SystemSculpt/Chats");
    const loaded = await service.loadChat("test-chat");

    expect(String(loaded?.messages[0].content).trim()).toBe("Compare this");
    expect(adapter.readBinary).not.toHaveBeenCalled();

    const hydrated = await store.hydrateMessage(loaded!.messages[0]);
    expect(hydrated.content).toEqual(runtimeMessage.content);
    expect(adapter.readBinary).toHaveBeenCalledTimes(1);
    await expect(service.collectAttachmentRefKeys()).resolves.toEqual(new Set([
      `${externalized.contentRef.payload}:${externalized.contentRef.sha256}`,
    ]));

    adapter.readBinary.mockClear();
    await service.saveChat("test-chat", loaded!.messages);
    expect(adapter.readBinary).not.toHaveBeenCalled();
    const savedMarkdown = (app.vault.modify as jest.Mock).mock.calls[0][1] as string;
    const saved = ChatMarkdownSerializer.parseMarkdown(savedMarkdown);
    expect(saved?.messages[0].attachmentMetadata?.[0].contentRef).toEqual(externalized.contentRef);
    expect(savedMarkdown).not.toContain("data:image/png;base64,AQID");
  });

  it("keeps a missing blob lazy until requested, then returns an unavailable placeholder", async () => {
    const { app, adapter, binaryFiles } = appHarness("");
    const store = new ChatAttachmentVaultStore(adapter);
    const [externalized] = await store.externalizeAttachments([imageAttachment("image-1")]);
    binaryFiles.clear();
    const markdown = buildMarkdown({
      role: "user",
      message_id: "user-1",
      content: [
        { type: "text", text: "Compare this" },
        externalized.contentPart,
      ],
      attachmentMetadata: [{
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image",
        contentPartIndex: 1,
        contentRef: externalized.contentRef,
      }],
    });
    (app.vault.read as jest.Mock).mockResolvedValue(markdown);
    adapter.read.mockResolvedValue(markdown);
    const service = new ChatStorageService(app, "SystemSculpt/Chats");

    const loaded = await service.loadChat("test-chat");

    expect(String(loaded?.messages[0].content).trim()).toBe("Compare this");
    expect(adapter.readBinary).not.toHaveBeenCalled();

    const hydrated = await store.hydrateMessage(loaded!.messages[0]);
    expect(hydrated.content).toEqual([
      { type: "text", text: "Compare this" },
      {
        type: "text",
        text: [
          "--- BEGIN ATTACHED FILE: diagram.png (image/png) ---",
          "[[SYSTEMSCULPT_ATTACHMENT_UNAVAILABLE]]",
          "--- END ATTACHED FILE: diagram.png ---",
        ].join("\n"),
      },
    ]);
  });

  it("fails attachment reachability closed when a raw metadata attribute is unreadable", async () => {
    const { app, adapter } = appHarness("");
    const markdown = buildMarkdown({
      role: "user",
      message_id: "user-1",
      content: "Hello",
    }).replace(
      'message-id="user-1"',
      'message-id="user-1" attachment-metadata="not/base64!"',
    );
    adapter.read.mockResolvedValue(markdown);
    const service = new ChatStorageService(app, "SystemSculpt/Chats");

    await expect(service.collectAttachmentRefKeys()).resolves.toBeNull();
  });
});

/**
 * An in-memory vault shared by every "session". Attachment-store claims are
 * per adapter object, so `nextSession()` hands out a fresh adapter identity
 * over the same files: cleanup there is protected only by what it scans.
 */
function memoryVault() {
  const notes = new Map<string, string>();
  const binaries = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const addFolders = (path: string) => {
    const segments = path.split("/").filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      folders.add(segments.slice(0, index).join("/"));
    }
  };
  const failingLists = new Set<string>();
  const adapterFunctions = {
    exists: async (path: string) => notes.has(path) || binaries.has(path) || folders.has(path),
    list: async (path: string) => {
      if (failingLists.has(path)) throw new Error("listing failed");
      return {
        files: [...notes.keys(), ...binaries.keys()].filter((file) => parentOf(file) === path),
        folders: [...folders].filter((folder) => folder !== path && parentOf(folder) === path),
      };
    },
    read: async (path: string) => {
      const content = notes.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    },
    readBinary: async (path: string) => {
      const bytes = binaries.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return bytes.slice().buffer;
    },
    writeBinary: async (path: string, data: ArrayBuffer) => {
      addFolders(parentOf(path));
      binaries.set(path, new Uint8Array(data));
    },
    mkdir: async (path: string) => { addFolders(path); },
    remove: async (path: string) => { binaries.delete(path); notes.delete(path); },
    // Every payload is far past the orphan grace period.
    stat: async (path: string) => (binaries.has(path) || notes.has(path) ? { mtime: 0, ctime: 0 } : null),
  };
  const nextSession = () => {
    const adapter = { ...adapterFunctions };
    const app = {
      vault: {
        adapter,
        getAbstractFileByPath: (path: string) => (notes.has(path) ? new TFile({ path }) : null),
        read: async (file: TFile) => notes.get(file.path)!,
        cachedRead: async (file: TFile) => notes.get(file.path)!,
        modify: async (file: TFile, content: string) => { notes.set(file.path, content); },
        create: async (path: string, content: string) => {
          if (notes.has(path)) throw new Error("File already exists.");
          addFolders(parentOf(path));
          notes.set(path, content);
          return new TFile({ path });
        },
        createFolder: async (path: string) => { addFolders(path); },
      },
    } as unknown as App;
    return { app, adapter };
  };
  return { notes, binaries, failingLists, nextSession };
}

/** The slice of the plugin storage reads, with an appending settings manager. */
function pluginStub(settings: { chatsDirectory: string; knownChatsDirectories?: string[] }) {
  const plugin = {
    settings,
    getSettingsManager: () => ({ updateSettings }),
  };
  const updateSettings = jest.fn(async (patch: { knownChatsDirectories?: string[] }) => {
    plugin.settings = {
      ...plugin.settings,
      knownChatsDirectories: [
        ...(plugin.settings.knownChatsDirectories ?? []),
        ...(patch.knownChatsDirectories ?? []),
      ],
    };
  });
  return { plugin, updateSettings };
}

function liveStorage(app: App, plugin: ReturnType<typeof pluginStub>["plugin"]) {
  return new ChatStorageService(
    app,
    () => resolveChatsDirectory(plugin.settings),
    plugin as unknown as SystemSculptPlugin,
  );
}

describe("ChatStorageService after the chats folder setting changes", () => {
  it("keeps saving an open chat to its own file, and only new chats use the new folder", async () => {
    const vault = memoryVault();
    const { app } = vault.nextSession();
    const { plugin } = pluginStub({ chatsDirectory: "Old/Chats", knownChatsDirectories: ["Old/Chats"] });
    const storage = liveStorage(app, plugin);
    const transcript = new AgentTranscriptRepository(storage, () => ({}));

    const created = await transcript.commitUser({
      kind: "append",
      message: { role: "user", message_id: "user-1", content: "Hello" },
    });
    const chatPath = `Old/Chats/${created.chatId}.md`;
    expect([...vault.notes.keys()]).toEqual([chatPath]);

    plugin.settings = { ...plugin.settings, chatsDirectory: "New/Chats" };
    await transcript.persistAssistant({ role: "assistant", message_id: "assistant-1", content: "Hi" });
    await transcript.saveMetadata();

    // No second transcript: the chat did not fork into the new folder.
    expect([...vault.notes.keys()]).toEqual([chatPath]);
    expect(transcript.chatPath(created.chatId)).toBe(chatPath);
    expect(ChatMarkdownSerializer.parseMarkdown(vault.notes.get(chatPath)!)?.messages
      .map((message) => message.message_id)).toEqual(["user-1", "assistant-1"]);

    // Reopened later (a restored leaf), the chat is found in the folder it
    // stayed in and keeps saving there.
    const reopened = new AgentTranscriptRepository(storage, () => ({}));
    await expect(reopened.load(created.chatId)).resolves.toMatchObject({ version: 3 });
    await reopened.persistAssistant({ role: "assistant", message_id: "assistant-1", content: "Hi again" });
    expect([...vault.notes.keys()]).toEqual([chatPath]);

    const next = await new AgentTranscriptRepository(storage, () => ({})).commitUser({
      kind: "append",
      message: { role: "user", message_id: "user-2", content: "New chat" },
    });
    expect(vault.notes.has(`New/Chats/${next.chatId}.md`)).toBe(true);
  });

  it("keeps attachments referenced only by a chat left in an earlier chats folder", async () => {
    const vault = memoryVault();
    // Seeded while the default folder was configured; the user then moved
    // chats to Old/Chats before creating this chat.
    const { plugin, updateSettings } = pluginStub({
      chatsDirectory: "Old/Chats",
      knownChatsDirectories: ["SystemSculpt/Chats"],
    });

    const first = vault.nextSession();
    const firstStore = new ChatAttachmentVaultStore(first.adapter);
    const [kept, orphan] = await firstStore.externalizeAttachments([
      imageAttachment("image-kept"),
      { ...imageAttachment("image-orphan"), contentPart: { type: "image_url" as const, image_url: { url: "data:image/png;base64,BAUG" } } },
    ]);
    const transcript = new AgentTranscriptRepository(liveStorage(first.app, plugin), () => ({}));
    await transcript.commitUser({
      kind: "append",
      message: {
        role: "user",
        message_id: "user-1",
        content: [{ type: "text", text: "Compare this" }, kept.contentPart],
        attachmentMetadata: [{
          id: kept.id,
          name: kept.name,
          mimeType: kept.mimeType,
          byteLength: kept.byteLength,
          kind: kept.kind,
          contentPartIndex: 1,
          contentRef: kept.contentRef,
        }],
      },
    });
    expect(updateSettings).toHaveBeenCalledWith({ knownChatsDirectories: ["Old/Chats"] });

    plugin.settings = { ...plugin.settings, chatsDirectory: "New/Chats" };
    const next = vault.nextSession();
    const storage = liveStorage(next.app, plugin);
    const store = new ChatAttachmentVaultStore(next.adapter);
    await store.pruneOncePerSession(() => storage.collectAttachmentRefKeys());

    const payloadPath = (ref: { payload: string; sha256: string }) =>
      `.systemsculpt/chat-attachments/${ref.sha256.slice(0, 2)}/${ref.sha256}.${ref.payload === "image-bytes" ? "bin" : "txt"}`;
    expect(vault.binaries.has(payloadPath(kept.contentRef))).toBe(true);
    expect(vault.binaries.has(payloadPath(orphan.contentRef))).toBe(false);
  });

  it("skips cleanup when an earlier chats folder cannot be listed", async () => {
    const vault = memoryVault();
    const { plugin } = pluginStub({
      chatsDirectory: "New/Chats",
      knownChatsDirectories: ["Old/Chats", "Gone/Chats"],
    });
    const first = vault.nextSession();
    const [orphan] = await new ChatAttachmentVaultStore(first.adapter)
      .externalizeAttachments([imageAttachment("image-1")]);
    await first.app.vault.create("Old/Chats/Plain note.md", "note");
    vault.failingLists.add("Old/Chats");

    const next = vault.nextSession();
    const storage = liveStorage(next.app, plugin);
    await expect(storage.collectAttachmentRefKeys()).resolves.toBeNull();
    await new ChatAttachmentVaultStore(next.adapter)
      .pruneOncePerSession(() => storage.collectAttachmentRefKeys());
    expect([...vault.binaries.keys()]).toEqual([
      `.systemsculpt/chat-attachments/${orphan.contentRef.sha256.slice(0, 2)}/${orphan.contentRef.sha256}.bin`,
    ]);

    // Gone/Chats no longer exists: it holds no chats and is skipped.
    vault.failingLists.clear();
    await expect(storage.collectAttachmentRefKeys()).resolves.toEqual(new Set());
  });

  it("records a chats folder once, before its first transcript is written", async () => {
    const vault = memoryVault();
    const { app } = vault.nextSession();
    const { plugin, updateSettings } = pluginStub({
      chatsDirectory: "SystemSculpt/Chats",
      knownChatsDirectories: [],
    });
    const storage = liveStorage(app, plugin);

    // The default folder is always scanned; it needs no entry.
    await storage.createChatExclusive("chat-default", [{ role: "user", message_id: "u1", content: "a" }]);
    expect(updateSettings).not.toHaveBeenCalled();

    plugin.settings = { ...plugin.settings, chatsDirectory: "Work/Chats/" };
    await expect(storage.createChatExclusive("chat-work", [{ role: "user", message_id: "u2", content: "b" }]))
      .resolves.toEqual({ version: 1, chatDirectory: "Work/Chats" });
    await storage.createChatExclusive("chat-work-2", [{ role: "user", message_id: "u3", content: "c" }]);
    expect(updateSettings.mock.calls).toEqual([[{ knownChatsDirectories: ["Work/Chats"] }]]);
    expect(resolveKnownChatsDirectories({ ...plugin.settings, chatsDirectory: "Home/Chats" }))
      .toEqual(["Home/Chats", "SystemSculpt/Chats", "Work/Chats"]);
  });
});
