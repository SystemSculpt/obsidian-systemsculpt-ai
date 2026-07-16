/**
 * @jest-environment jsdom
 */
import { App, Platform, TFile } from "obsidian";
import { ChatStorageService } from "../ChatStorageService";
import { ChatMessage, ChatRole } from "../../../types";

// Mock parseYaml and stringifyYaml
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    parseYaml: jest.fn((yaml) => {
      // Simple YAML parsing for tests
      const result: any = {};
      const lines = yaml.split("\n");
      for (const line of lines) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          result[match[1]] = match[2].trim();
        }
      }
      return result;
    }),
    stringifyYaml: jest.fn((obj) => {
      return Object.entries(obj)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
    }),
  };
});

// Mock ChatMarkdownSerializer
jest.mock("../storage/ChatMarkdownSerializer", () => ({
  ChatMarkdownSerializer: {
    serializeMessages: jest.fn().mockReturnValue("## Messages\n\nSerialized content here"),
    parseMetadata: jest.fn().mockReturnValue({
      id: "test-chat",
      title: "Test Chat",
      created: "2024-01-01T00:00:00.000Z",
      lastModified: "2024-01-01T00:00:00.000Z",
      version: 1,
      tags: [],
    }),
    parseMarkdown: jest.fn().mockReturnValue({
      metadata: {
        id: "test-chat",
        title: "Test Chat",
        created: "2024-01-01T00:00:00.000Z",
        lastModified: "2024-01-01T00:00:00.000Z",
        version: 1,
      },
      messages: [],
    }),
  },
}));

describe("ChatStorageService", () => {
  let service: ChatStorageService;
  let mockApp: App;
  let mockVault: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockVault = {
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      read: jest.fn().mockResolvedValue(""),
      modify: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      createFolder: jest.fn().mockResolvedValue(undefined),
      cachedRead: jest.fn().mockResolvedValue(""),
      adapter: {
        exists: jest.fn().mockResolvedValue(true),
      },
    };

    mockApp = {
      vault: mockVault,
      plugins: {
        plugins: {},
      },
    } as unknown as App;

    service = new ChatStorageService(mockApp, "SystemSculpt/Chats");
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(ChatStorageService);
    });

    it("stores chat directory", () => {
      expect((service as any).chatDirectory).toBe("SystemSculpt/Chats");
    });

  });

  describe("saveChat", () => {
    const testMessages: ChatMessage[] = [
      { role: "user" as ChatRole, content: "Hello" },
      { role: "assistant" as ChatRole, content: "Hi there!" },
    ];

    it("saves chat and returns version", async () => {
      const result = await service.saveChat(
        "test-chat-123",
        testMessages
      );

      expect(result.version).toBe(1);
    });

    it("exclusively creates only one artifact for concurrent writers", async () => {
      const created = new Set<string>();
      mockVault.create.mockImplementation(async (path: string) => {
        if (created.has(path)) throw new Error("File already exists");
        created.add(path);
        await Promise.resolve();
      });
      mockVault.adapter.exists.mockImplementation(async (path: string) => created.has(path));

      const results = await Promise.all([
        service.createChatExclusive("same-chat", testMessages),
        service.createChatExclusive("same-chat", testMessages),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect(created).toEqual(new Set(["SystemSculpt/Chats/same-chat.md"]));
    });

    it("creates file when it does not exist", async () => {
      await service.saveChat("new-chat", testMessages);

      expect(mockVault.create).toHaveBeenCalled();
    });

    it("checks if file exists before saving", async () => {
      await service.saveChat("new-chat-2", testMessages);

      // getAbstractFileByPath should be called to check if file exists
      expect(mockVault.getAbstractFileByPath).toHaveBeenCalled();
    });

    it("includes context files when provided", async () => {
      const contextFiles = new Set(["path/to/file.md", "path/to/Extractions/doc.md"]);

      await service.saveChat(
        "test-chat",
        testMessages,
        { contextFiles }
      );

      expect(mockVault.create).toHaveBeenCalled();
    });

    it("writes the current managed chat metadata schema", async () => {
      await service.saveChat("test-chat", testMessages);

      const createdContent = mockVault.create.mock.calls[0][1] as string;
      expect(createdContent).toContain('id: "test-chat"');
      expect(createdContent).toContain('title: "Untitled Chat"');
      expect(createdContent).toContain('approvalMode: "ask"');
    });

    it("persists only a chat-bound managed session checkpoint", async () => {
      await service.saveChat("session-chat", testMessages, {
        managedSession: {
          id: "mchat_0123456789abcdef0123456789abcdef",
          revision: 2,
          boundChatId: "session-chat",
          checkpointMessageId: "assistant-2",
          toolsetFingerprint: "2:741638a5:5967d5",
          budget: { messageCount: 2, imageCount: 0, attachmentBytes: 0, storedJsonBytes: 256 },
        },
      });
      expect(mockVault.create.mock.calls[0][1]).toContain("managedSession:");

      jest.clearAllMocks();
      mockVault.getAbstractFileByPath.mockReturnValue(null);
      await service.saveChat("other-chat", testMessages, {
        managedSession: {
          id: "mchat_0123456789abcdef0123456789abcdef",
          revision: 2,
          boundChatId: "session-chat",
          checkpointMessageId: "assistant-2",
          toolsetFingerprint: "2:741638a5:5967d5",
          budget: { messageCount: 2, imageCount: 0, attachmentBytes: 0, storedJsonBytes: 256 },
        },
      });
      expect(mockVault.create.mock.calls[0][1]).not.toContain("managedSession:");
    });

    it("adds default chat tag to new history files", async () => {
      (mockApp as any).plugins.plugins["systemsculpt-ai"] = {
        settings: { defaultChatTag: "#project" },
      };

      await service.saveChat("tagged-chat", testMessages);

      const createdContent = mockVault.create.mock.calls[0][1] as string;
      expect(createdContent).toContain('tags: ["project"]');
    });

    it("merges existing tags when saving", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/test-chat.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: test-chat
title: Test Chat
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-02T00:00:00.000Z
version: 1
tags: ["existing", "#keep"]
---

Content here`);

      (mockApp as any).plugins.plugins["systemsculpt-ai"] = {
        settings: { defaultChatTag: "new" },
      };
      const { ChatMarkdownSerializer } = jest.requireMock("../storage/ChatMarkdownSerializer") as {
        ChatMarkdownSerializer: { parseMetadata: jest.Mock };
      };
      ChatMarkdownSerializer.parseMetadata.mockReturnValueOnce({
        id: "test-chat",
        title: "Test Chat",
        created: "2024-01-01T00:00:00.000Z",
        lastModified: "2024-01-02T00:00:00.000Z",
        version: 1,
        tags: ["existing", "keep"],
      });

      await service.saveChat("test-chat", testMessages);

      const modifiedContent = mockVault.modify.mock.calls[0][1] as string;
      expect(modifiedContent).toContain('tags: ["existing","keep","new"]');
    });

    it("throws error on save failure", async () => {
      mockVault.create.mockRejectedValue(new Error("Write failed"));

      await expect(
        service.saveChat("test-chat", testMessages)
      ).rejects.toThrow("Failed to save chat");
    });

    it("creates directory when it does not exist", async () => {
      mockVault.adapter.exists.mockResolvedValue(false);

      await service.saveChat("test-chat", testMessages);

      expect(mockVault.createFolder).toHaveBeenCalledWith("SystemSculpt/Chats");
    });

    it("uses DirectoryManager when available", async () => {
      const mockDirManager = {
        ensureDirectoryByPath: jest.fn().mockResolvedValue(undefined),
      };
      (mockApp as any).plugins.plugins["systemsculpt-ai"] = {
        directoryManager: mockDirManager,
      };

      await service.saveChat("test-chat", testMessages);

      expect(mockDirManager.ensureDirectoryByPath).toHaveBeenCalledWith("SystemSculpt/Chats");
    });
  });

  describe("loadChats", () => {
    it("returns chat summaries", async () => {
      // The loadChats method should return chat summaries
      const chats = await service.loadChats();

      expect(Array.isArray(chats)).toBe(true);
    });
  });

});

describe("ChatStorageService resume descriptor contract", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns a minimal managed resume descriptor", async () => {
    const service = new ChatStorageService({} as App, "SystemSculpt/Chats");
    jest.spyOn(service, "loadChat").mockResolvedValue({
      id: "chat-9",
      messages: [{ role: "user" as ChatRole, content: "Hello" }],
      lastModified: 1741600800000,
      title: "Chat 9",
      chatPath: "SystemSculpt/Chats/chat-9.md",
    });

    await expect(service.getChatResumeDescriptor("chat-9")).resolves.toEqual({
      chatId: "chat-9",
      title: "Chat 9",
      chatPath: "SystemSculpt/Chats/chat-9.md",
      lastModified: 1741600800000,
      messageCount: 1,
    });
  });
});

describe("ChatStorageService extended", () => {
  let service: ChatStorageService;
  let mockApp: App;
  let mockVault: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockVault = {
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      read: jest.fn().mockResolvedValue(""),
      modify: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      createFolder: jest.fn().mockResolvedValue(undefined),
      cachedRead: jest.fn().mockResolvedValue(""),
      adapter: {
        exists: jest.fn().mockResolvedValue(true),
        list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
        read: jest.fn().mockResolvedValue(""),
      },
    };

    mockApp = {
      vault: mockVault,
      plugins: { plugins: {} },
    } as unknown as App;

    service = new ChatStorageService(mockApp, "SystemSculpt/Chats");
  });

  describe("loadChat", () => {
    it("returns null when file does not exist", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      const result = await service.loadChat("nonexistent-chat");

      expect(result).toBeNull();
    });

    it("returns null when file is not a TFile", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue({ path: "folder" });

      const result = await service.loadChat("folder-not-file");

      expect(result).toBeNull();
    });

    it("loads and parses chat file", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/test-chat.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: test-chat
title: Test Chat
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
version: 1
---

<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="msg-1" -->
Hello
<!-- SYSTEMSCULPT-MESSAGE-END -->`);

      const result = await service.loadChat("test-chat");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-chat");
    });

    it("returns null on read error", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/error-chat.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockRejectedValue(new Error("Read error"));

      const result = await service.loadChat("error-chat");

      expect(result).toBeNull();
    });
  });

  describe("loadChats", () => {
    it("returns empty array when no files", async () => {
      mockVault.adapter.list.mockResolvedValue({ files: [], folders: [] });

      const result = await service.loadChats();

      expect(result).toEqual([]);
    });

    it("filters for markdown files only", async () => {
      mockVault.adapter.list.mockResolvedValue({
        files: ["SystemSculpt/Chats/chat.md", "SystemSculpt/Chats/data.json"],
        folders: [],
      });
      mockVault.adapter.read.mockResolvedValue("");

      await service.loadChats();

      // Should only try to process .md file
      expect(mockVault.adapter.read).toHaveBeenCalledTimes(1);
    });

    it("uses Obsidian's cached reader for indexed chat files", async () => {
      const chatFile = new TFile({ path: "SystemSculpt/Chats/indexed.md" });
      mockVault.adapter.list.mockResolvedValue({
        files: [chatFile.path],
        folders: [],
      });
      mockVault.getAbstractFileByPath.mockReturnValue(chatFile);

      await service.loadChats();

      expect(mockVault.cachedRead).toHaveBeenCalledWith(chatFile);
      expect(mockVault.adapter.read).not.toHaveBeenCalled();
    });

    it("handles errors in individual file reads gracefully", async () => {
      mockVault.adapter.list.mockResolvedValue({
        files: ["SystemSculpt/Chats/chat1.md", "SystemSculpt/Chats/chat2.md"],
        folders: [],
      });
      mockVault.adapter.read
        .mockRejectedValueOnce(new Error("Read error"))
        .mockResolvedValueOnce("");

      const result = await service.loadChats();

      expect(Array.isArray(result)).toBe(true);
    });

    it("bounds parallel reads so mobile vault adapters are not saturated", async () => {
      const files = Array.from(
        { length: 24 },
        (_value, index) => `SystemSculpt/Chats/chat-${index}.md`,
      );
      let activeReads = 0;
      let maxActiveReads = 0;
      mockVault.adapter.list.mockResolvedValue({ files, folders: [] });
      mockVault.adapter.read.mockImplementation(async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeReads -= 1;
        return "";
      });

      await service.loadChats();

      expect(mockVault.adapter.read).toHaveBeenCalledTimes(files.length);
      expect(maxActiveReads).toBeLessThanOrEqual(8);
      expect(maxActiveReads).toBeGreaterThan(1);
    });

    it("serializes reads when the host has no local filesystem capability", async () => {
      const originalDesktopApp = Platform.isDesktopApp;
      const files = Array.from(
        { length: 6 },
        (_value, index) => `SystemSculpt/Chats/portable-${index}.md`,
      );
      let activeReads = 0;
      let maxActiveReads = 0;
      mockVault.adapter.list.mockResolvedValue({ files, folders: [] });
      mockVault.adapter.read.mockImplementation(async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeReads -= 1;
        return "";
      });

      (Platform as typeof Platform & { isDesktopApp: boolean }).isDesktopApp = false;
      try {
        await service.loadChats();
      } finally {
        (Platform as typeof Platform & { isDesktopApp: boolean }).isDesktopApp = originalDesktopApp;
      }

      expect(mockVault.adapter.read).toHaveBeenCalledTimes(files.length);
      expect(maxActiveReads).toBe(1);
    });

    it("returns empty array on list error", async () => {
      mockVault.adapter.list.mockRejectedValue(new Error("List error"));

      const result = await service.loadChats();

      expect(result).toEqual([]);
    });
  });

  describe("saveChat edge cases", () => {
    it("modifies existing file instead of creating new", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/existing.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: existing
title: Existing
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
version: 1
---`);

      await service.saveChat(
        "existing",
        [{ role: "user" as ChatRole, content: "Hello" }]
      );

      expect(mockVault.modify).toHaveBeenCalled();
      expect(mockVault.create).not.toHaveBeenCalled();
    });

    it("throws error when trying to save empty messages over existing content", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/nonempty.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: nonempty
title: Non Empty
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
version: 1
---

<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="1" -->
Hello
<!-- SYSTEMSCULPT-MESSAGE-END -->`);

      await expect(
        service.saveChat("nonempty", [])
      ).rejects.toThrow();
    });

    it("includes title in save", async () => {
      await service.saveChat(
        "titled-chat",
        [{ role: "user" as ChatRole, content: "Hello" }],
        { title: "My Custom Title" }
      );

      expect(mockVault.create).toHaveBeenCalled();
      const createCall = mockVault.create.mock.calls[0];
      expect(createCall[1]).toContain("My Custom Title");
    });

    it("includes chatFontSize in save", async () => {
      await service.saveChat(
        "font-size-chat",
        [{ role: "user" as ChatRole, content: "Hello" }],
        { chatFontSize: "large" }
      );

      expect(mockVault.create).toHaveBeenCalled();
      const createCall = mockVault.create.mock.calls[0];
      expect(createCall[1]).toContain("large");
    });

  });

  describe("isValidChatFile", () => {
    it("accepts files with frontmatter", () => {
      const content = `---
id: test
---
Some content`;
      expect((service as any).isValidChatFile(content)).toBe(true);
    });

    it("accepts files with message markers", () => {
      const content = `<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="1" -->
Hello
<!-- SYSTEMSCULPT-MESSAGE-END -->`;
      expect((service as any).isValidChatFile(content)).toBe(true);
    });

    it("rejects unrelated fenced notes", () => {
      const content = `# AI Chat History

\`\`\`\`\`user
Hello
\`\`\`\`\``;
      expect((service as any).isValidChatFile(content)).toBe(false);
    });

    it("rejects plain text files", () => {
      const content = "Just some plain text without any special format.";
      expect((service as any).isValidChatFile(content)).toBe(false);
    });
  });

});
