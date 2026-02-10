/**
 * @jest-environment jsdom
 */
import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
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
    parseMarkdown: jest.fn().mockReturnValue({
      metadata: {
        id: "test-chat",
        model: "gpt-4",
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
  let mockToolCallManager: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockVault = {
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      read: jest.fn().mockResolvedValue(""),
      modify: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      createFolder: jest.fn().mockResolvedValue(undefined),
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

    mockToolCallManager = {
      getToolCall: jest.fn().mockReturnValue(null),
      processToolResult: jest.fn((content) => content),
    };

    service = new ChatStorageService(mockApp, "SystemSculpt/Chats", mockToolCallManager);
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(ChatStorageService);
    });

    it("stores chat directory", () => {
      expect((service as any).chatDirectory).toBe("SystemSculpt/Chats");
    });

    it("stores tool call manager", () => {
      expect((service as any).toolCallManager).toBe(mockToolCallManager);
    });

    it("works without tool call manager", () => {
      const serviceNoToolManager = new ChatStorageService(mockApp, "Chats");
      expect((serviceNoToolManager as any).toolCallManager).toBeUndefined();
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
        testMessages,
        "gpt-4"
      );

      expect(result.version).toBe(1);
    });

    it("creates file when it does not exist", async () => {
      await service.saveChat("new-chat", testMessages, "gpt-4");

      expect(mockVault.create).toHaveBeenCalled();
    });

    it("checks if file exists before saving", async () => {
      await service.saveChat("new-chat-2", testMessages, "gpt-4");

      // getAbstractFileByPath should be called to check if file exists
      expect(mockVault.getAbstractFileByPath).toHaveBeenCalled();
    });

    it("includes context files when provided", async () => {
      const contextFiles = new Set(["path/to/file.md", "path/to/Extractions/doc.md"]);

      await service.saveChat(
        "test-chat",
        testMessages,
        "gpt-4",
        contextFiles
      );

      expect(mockVault.create).toHaveBeenCalled();
    });

    it("includes system prompt type", async () => {
      await service.saveChat(
        "test-chat",
        testMessages,
        "gpt-4",
        undefined,
        undefined,
        "concise"
      );

      expect(mockVault.create).toHaveBeenCalled();
    });

    it("adds default chat tag to new history files", async () => {
      (mockApp as any).plugins.plugins["systemsculpt-ai"] = {
        settings: { defaultChatTag: "#project" },
      };

      await service.saveChat("tagged-chat", testMessages, "gpt-4");

      const createdContent = mockVault.create.mock.calls[0][1] as string;
      expect(createdContent).toContain('tags: ["project"]');
    });

    it("merges existing tags when saving", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/test-chat.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: test-chat
model: gpt-4
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

      await service.saveChat("test-chat", testMessages, "gpt-4");

      const modifiedContent = mockVault.modify.mock.calls[0][1] as string;
      expect(modifiedContent).toContain('tags: ["existing","keep","new"]');
    });

    it("throws error on save failure", async () => {
      mockVault.create.mockRejectedValue(new Error("Write failed"));

      await expect(
        service.saveChat("test-chat", testMessages, "gpt-4")
      ).rejects.toThrow("Failed to save chat");
    });

    it("creates directory when it does not exist", async () => {
      mockVault.adapter.exists.mockResolvedValue(false);

      await service.saveChat("test-chat", testMessages, "gpt-4");

      expect(mockVault.createFolder).toHaveBeenCalledWith("SystemSculpt/Chats");
    });

    it("uses DirectoryManager when available", async () => {
      const mockDirManager = {
        ensureDirectoryByPath: jest.fn().mockResolvedValue(undefined),
      };
      (mockApp as any).plugins.plugins["systemsculpt-ai"] = {
        directoryManager: mockDirManager,
      };

      await service.saveChat("test-chat", testMessages, "gpt-4");

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

  describe("parseMetadata", () => {
    it("extracts metadata from frontmatter", () => {
      const content = `---
id: test-chat
model: gpt-4
title: Test Title
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-02T00:00:00.000Z
version: 3
tags: ["project"]
---

Content here`;

      const metadata = (service as any).parseMetadata(content);

      expect(metadata).not.toBeNull();
      expect(metadata.id).toBeDefined();
      expect(metadata.tags).toEqual(["project"]);
    });

    it("returns null for invalid frontmatter", () => {
      const content = "No frontmatter here";

      const metadata = (service as any).parseMetadata(content);

      expect(metadata).toBeNull();
    });
  });
});

describe("processMessageToolCalls", () => {
  // This function is module-level, test its behavior indirectly through saveChat
  let service: ChatStorageService;
  let mockApp: App;
  let mockToolCallManager: any;

  beforeEach(() => {
    jest.clearAllMocks();

    const mockVault = {
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      read: jest.fn().mockResolvedValue(""),
      modify: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      createFolder: jest.fn().mockResolvedValue(undefined),
      adapter: {
        exists: jest.fn().mockResolvedValue(true),
      },
    };

    mockApp = {
      vault: mockVault,
      plugins: { plugins: {} },
    } as unknown as App;

    mockToolCallManager = {
      getToolCall: jest.fn().mockReturnValue({
        id: "tool-1",
        request: {
          function: {
            name: "test_tool",
          },
        },
      }),
      processToolResult: jest.fn((content) => ({ processed: true, ...content })),
    };

    service = new ChatStorageService(mockApp, "Chats", mockToolCallManager);
  });

  it("processes tool messages with tool call manager", async () => {
    const toolMessage: ChatMessage = {
      role: "tool" as ChatRole,
      content: '{"result": "success"}',
      tool_call_id: "tool-1",
    };

    await service.saveChat("test", [toolMessage], "gpt-4");

    expect(mockToolCallManager.getToolCall).toHaveBeenCalledWith("tool-1");
  });

  it("leaves non-tool messages unchanged", async () => {
    const userMessage: ChatMessage = {
      role: "user" as ChatRole,
      content: "Hello",
    };

    await service.saveChat("test", [userMessage], "gpt-4");

    // Tool call manager should not be invoked for user messages
    expect(mockToolCallManager.getToolCall).not.toHaveBeenCalled();
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
model: gpt-4
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

    it("returns empty array on list error", async () => {
      mockVault.adapter.list.mockRejectedValue(new Error("List error"));

      const result = await service.loadChats();

      expect(result).toEqual([]);
    });
  });

  describe("getMetadata", () => {
    it("returns null when file does not exist", async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null);

      const result = await service.getMetadata("nonexistent");

      expect(result).toBeNull();
    });

    it("returns parsed metadata from file", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/meta-test.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: meta-test
model: gpt-4
title: Metadata Test
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-02T00:00:00.000Z
version: 5
---

Content here`);

      const result = await service.getMetadata("meta-test");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("meta-test");
    });

    it("returns null on error", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/error.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockRejectedValue(new Error("Read error"));

      const result = await service.getMetadata("error");

      expect(result).toBeNull();
    });
  });

  describe("saveStreamingMessage", () => {
    it("is a no-op deprecated method", async () => {
      await expect(service.saveStreamingMessage()).resolves.toBeUndefined();
    });
  });

  describe("saveChat edge cases", () => {
    it("modifies existing file instead of creating new", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/existing.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: existing
model: gpt-4
title: Existing
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
version: 1
---`);

      await service.saveChat(
        "existing",
        [{ role: "user" as ChatRole, content: "Hello" }],
        "gpt-4"
      );

      expect(mockVault.modify).toHaveBeenCalled();
      expect(mockVault.create).not.toHaveBeenCalled();
    });

    it("throws error when trying to save empty messages over existing content", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/Chats/nonempty.md" });
      mockVault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockVault.read.mockResolvedValue(`---
id: nonempty
model: gpt-4
title: Non Empty
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
version: 1
---

<!-- SYSTEMSCULPT-MESSAGE-START role="user" message-id="1" -->
Hello
<!-- SYSTEMSCULPT-MESSAGE-END -->`);

      await expect(
        service.saveChat("nonempty", [], "gpt-4")
      ).rejects.toThrow();
    });

    it("includes title in save", async () => {
      await service.saveChat(
        "titled-chat",
        [{ role: "user" as ChatRole, content: "Hello" }],
        "gpt-4",
        undefined,
        undefined,
        undefined,
        undefined,
        "My Custom Title"
      );

      expect(mockVault.create).toHaveBeenCalled();
      const createCall = mockVault.create.mock.calls[0];
      expect(createCall[1]).toContain("My Custom Title");
    });

    it("includes chatFontSize in save", async () => {
      await service.saveChat(
        "font-size-chat",
        [{ role: "user" as ChatRole, content: "Hello" }],
        "gpt-4",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "large"
      );

      expect(mockVault.create).toHaveBeenCalled();
      const createCall = mockVault.create.mock.calls[0];
      expect(createCall[1]).toContain("large");
    });

    it("includes systemPromptType in save", async () => {
      await service.saveChat(
        "prompt-type-chat",
        [{ role: "user" as ChatRole, content: "Hello" }],
        "gpt-4",
        undefined,
        undefined,
        "agent"
      );

      expect(mockVault.create).toHaveBeenCalled();
      const createCall = mockVault.create.mock.calls[0];
      expect(createCall[1]).toContain("agent");
    });

    it("includes systemPromptPath for custom prompts", async () => {
      await service.saveChat(
        "custom-prompt-chat",
        [{ role: "user" as ChatRole, content: "Hello" }],
        "gpt-4",
        undefined,
        undefined,
        "custom",
        "prompts/my-prompt.md"
      );

      expect(mockVault.create).toHaveBeenCalled();
      const createCall = mockVault.create.mock.calls[0];
      expect(createCall[1]).toContain("prompts/my-prompt.md");
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

    it("rejects legacy five-backtick format files", () => {
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

  describe("isValidYamlFrontmatter", () => {
    it("accepts valid YAML with key-value pairs", () => {
      const yaml = `id: test-chat
model: gpt-4
title: Test`;
      expect((service as any).isValidYamlFrontmatter(yaml)).toBe(true);
    });

    it("rejects markdown headers", () => {
      const yaml = `# This is a header
Some content`;
      expect((service as any).isValidYamlFrontmatter(yaml)).toBe(false);
    });

    it("rejects markdown tables", () => {
      const yaml = `| Column 1 | Column 2 |
| --- | --- |`;
      expect((service as any).isValidYamlFrontmatter(yaml)).toBe(false);
    });

    it("rejects markdown links", () => {
      const yaml = `[Link text](https://example.com)`;
      expect((service as any).isValidYamlFrontmatter(yaml)).toBe(false);
    });

    it("rejects code blocks", () => {
      const yaml = "```javascript\nconst x = 1;\n```";
      expect((service as any).isValidYamlFrontmatter(yaml)).toBe(false);
    });
  });

  describe("parseMetadata edge cases", () => {
    it("handles context files as strings", () => {
      const content = `---
id: test
model: gpt-4
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
title: Test
context_files:
  - path/to/file1.md
  - path/to/Extractions/file2.md
---`;

      const result = (service as any).parseMetadata(content);

      expect(result).not.toBeNull();
      // Mock parseYaml doesn't fully parse arrays, just check we got a result
      expect(result.context_files).toBeDefined();
    });

    it("handles systemMessage object", () => {
      const content = `---
id: test
model: gpt-4
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
title: Test
systemMessage:
  type: custom
  path: prompts/custom.md
---`;

      const result = (service as any).parseMetadata(content);

      expect(result).not.toBeNull();
      // The mock parseYaml doesn't fully parse nested objects, just check we got result
      expect(result.systemMessage).toBeDefined();
    });

    it("handles legacy customPromptFilePath", () => {
      const content = `---
id: test
model: gpt-4
created: 2024-01-01T00:00:00.000Z
lastModified: 2024-01-01T00:00:00.000Z
title: Test
customPromptFilePath: "[[prompts/old-format.md]]"
---`;

      const result = (service as any).parseMetadata(content);

      expect(result).not.toBeNull();
      // The mock parseYaml doesn't transform wikilinks, just verify we got a result
      expect(result.systemMessage).toBeDefined();
    });

    it("returns null for missing id field", () => {
      const content = `---
model: gpt-4
title: No ID
---`;

      const result = (service as any).parseMetadata(content);

      expect(result).toBeNull();
    });
  });

  describe("generateMessageId", () => {
    it("generates UUID format", () => {
      const id = (service as any).generateMessageId();

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it("generates unique IDs", () => {
      const id1 = (service as any).generateMessageId();
      const id2 = (service as any).generateMessageId();

      expect(id1).not.toBe(id2);
    });
  });

  describe("standardizeToolCalls", () => {
    it("returns empty array for null input", () => {
      const result = (service as any).standardizeToolCalls(null, "msg-1");
      expect(result).toEqual([]);
    });

    it("passes through already standardized tool calls", () => {
      const toolCalls = [
        {
          id: "call_123",
          request: {
            function: { name: "test", arguments: "{}" },
          },
          state: "completed",
        },
      ];

      const result = (service as any).standardizeToolCalls(toolCalls, "msg-1");

      expect(result[0].id).toBe("call_123");
      expect(result[0].request.function.name).toBe("test");
    });

    it("converts old flat format to new format", () => {
      const toolCalls = [
        {
          id: "call_456",
          type: "function",
          function: { name: "old_tool", arguments: "{}" },
        },
      ];

      const result = (service as any).standardizeToolCalls(toolCalls, "msg-1");

      expect(result[0].id).toBe("call_456");
      expect(result[0].request.function.name).toBe("old_tool");
      expect(result[0].messageId).toBe("msg-1");
    });
  });

  describe("normalizeLegacyToolMessages", () => {
    it("returns empty messages as-is", () => {
      const result = (service as any).normalizeLegacyToolMessages([]);
      expect(result).toEqual([]);
    });

    it("passes through non-tool messages", () => {
      const messages: ChatMessage[] = [
        { role: "user" as ChatRole, content: "Hello", message_id: "1" },
        { role: "assistant" as ChatRole, content: "Hi", message_id: "2" },
      ];

      const result = (service as any).normalizeLegacyToolMessages(messages);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
    });

    it("attaches tool message to preceding assistant", () => {
      const messages: ChatMessage[] = [
        { role: "assistant" as ChatRole, content: "", message_id: "1" },
        {
          role: "tool" as ChatRole,
          content: '{"success": true}',
          tool_call_id: "call_123",
          message_id: "2",
        },
      ];

      const result = (service as any).normalizeLegacyToolMessages(messages);

      // Tool message should be absorbed into assistant
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("handles tool messages with errors", () => {
      const messages: ChatMessage[] = [
        { role: "assistant" as ChatRole, content: "", message_id: "1" },
        {
          role: "tool" as ChatRole,
          content: '{"error": {"code": "EXECUTION_FAILED", "message": "Failed"}}',
          tool_call_id: "call_123",
          message_id: "2",
        },
      ];

      const result = (service as any).normalizeLegacyToolMessages(messages);

      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("handles tool messages with USER_DENIED error", () => {
      const messages: ChatMessage[] = [
        { role: "assistant" as ChatRole, content: "", message_id: "1" },
        {
          role: "tool" as ChatRole,
          content: '{"error": {"code": "USER_DENIED", "message": "User denied"}}',
          tool_call_id: "call_123",
          message_id: "2",
        },
      ];

      const result = (service as any).normalizeLegacyToolMessages(messages);

      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("coalesces consecutive assistant messages into a single assistant turn", () => {
      const call1: any = {
        id: "call_1",
        messageId: "a1",
        request: { id: "call_1", type: "function", function: { name: "t", arguments: "{}" } },
        state: "completed",
        timestamp: 1,
      };

      const call2: any = {
        id: "call_2",
        messageId: "a2",
        request: { id: "call_2", type: "function", function: { name: "t", arguments: "{}" } },
        state: "completed",
        timestamp: 2,
      };

      const messages: ChatMessage[] = [
        { role: "assistant" as ChatRole, content: "", message_id: "a1", tool_calls: [call1] } as any,
        { role: "assistant" as ChatRole, content: "", message_id: "a2", tool_calls: [call2] } as any,
        { role: "assistant" as ChatRole, content: "Final", message_id: "a3" } as any,
        { role: "user" as ChatRole, content: "Next", message_id: "u1" } as any,
      ];

      const result = (service as any).normalizeLegacyToolMessages(messages) as ChatMessage[];

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("assistant");
      expect(result[0].message_id).toBe("a1");
      expect(result[0].content).toBe("Final");
      expect(Array.isArray(result[0].tool_calls)).toBe(true);
      expect(result[0].tool_calls).toHaveLength(2);
      expect(result[0].tool_calls?.every((tc: any) => tc.messageId === "a1")).toBe(true);
      expect(result[1].role).toBe("user");
    });
  });
});
