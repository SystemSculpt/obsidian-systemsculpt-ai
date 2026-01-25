/**
 * @jest-environment jsdom
 */
import { TFile, Notice } from "obsidian";
import { ResumeChatService } from "../ResumeChatService";

// Mock Notice
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
  };
});

const createPluginStub = () => {
  const workspace = {
    on: jest.fn(() => ({ unload: jest.fn() })),
    iterateAllLeaves: jest.fn(),
    getLeaf: jest.fn(),
    setActiveLeaf: jest.fn(),
  };
  const metadataCache = {
    on: jest.fn(() => ({ unload: jest.fn() })),
    getCache: jest.fn(),
  };
  const app = { workspace, metadataCache } as any;
  const plugin = {
    app,
    settings: {
      chatsDirectory: "SystemSculpt/Chats",
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
    },
    registerEvent: jest.fn(),
  } as any;
  return { app, plugin };
};

describe("ResumeChatService", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("constructor", () => {
    it("creates instance and registers workspace events", () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      expect(service).toBeInstanceOf(ResumeChatService);
      // Should register 3 events: active-leaf-change, layout-change, metadata-changed
      expect(plugin.registerEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe("isChatHistoryFile", () => {
    it("identifies chat history files by path and metadata", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          id: "chat-1",
          model: "systemsculpt@@systemsculpt/ai-agent",
          created: "2025-01-01",
        },
      });

      expect(service.isChatHistoryFile(file)).toBe(true);
    });

    it("returns false for files outside chats directory", () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const otherFile = new TFile({ path: "Notes/Other.md" });
      expect(service.isChatHistoryFile(otherFile)).toBe(false);
    });

    it("returns false for non-markdown files", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const txtFile = new TFile({ path: "SystemSculpt/Chats/chat-1.txt" });
      expect(service.isChatHistoryFile(txtFile)).toBe(false);
    });

    it("returns false when frontmatter is missing", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({});
      expect(service.isChatHistoryFile(file)).toBe(false);
    });

    it("returns false when required metadata fields are missing", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });

      // Missing id
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          model: "systemsculpt@@systemsculpt/ai-agent",
          created: "2025-01-01",
        },
      });
      expect(service.isChatHistoryFile(file)).toBe(false);

      // Missing model
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          id: "chat-1",
          created: "2025-01-01",
        },
      });
      expect(service.isChatHistoryFile(file)).toBe(false);
    });

    it("accepts lastModified instead of created", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          id: "chat-1",
          model: "systemsculpt@@systemsculpt/ai-agent",
          lastModified: "2025-01-01",
        },
      });
      expect(service.isChatHistoryFile(file)).toBe(true);
    });

    it("uses default chats directory when not specified", () => {
      const { app, plugin } = createPluginStub();
      plugin.settings.chatsDirectory = "";
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          id: "chat-1",
          model: "systemsculpt@@systemsculpt/ai-agent",
          created: "2025-01-01",
        },
      });
      expect(service.isChatHistoryFile(file)).toBe(true);
    });

    it("handles cache returning null", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue(null);
      expect(service.isChatHistoryFile(file)).toBe(false);
    });
  });

  describe("extractChatId", () => {
    it("extracts chat id from frontmatter", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-2.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-2" },
      });
      expect(service.extractChatId(file)).toBe("chat-2");
    });

    it("falls back to filename when frontmatter id is missing", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-2.md" });
      app.metadataCache.getCache.mockReturnValue({});
      expect(service.extractChatId(file)).toBe("chat-2");
    });

    it("falls back to filename when cache is empty", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/my-chat.md" });
      app.metadataCache.getCache.mockReturnValue(null);
      expect(service.extractChatId(file)).toBe("my-chat");
    });

    it("handles files with complex names", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/2025-01-01_Chat about AI.md" });
      app.metadataCache.getCache.mockReturnValue({});
      expect(service.extractChatId(file)).toBe("2025-01-01_Chat about AI");
    });
  });

  describe("getModelFromFile", () => {
    it("returns model from frontmatter", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { model: "openai@@gpt-4" },
      });
      expect(service.getModelFromFile(file)).toBe("openai@@gpt-4");
    });

    it("falls back to plugin selected model when frontmatter model is missing", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {},
      });
      expect(service.getModelFromFile(file)).toBe("systemsculpt@@systemsculpt/ai-agent");
    });

    it("falls back to plugin selected model when cache is null", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue(null);
      expect(service.getModelFromFile(file)).toBe("systemsculpt@@systemsculpt/ai-agent");
    });
  });

  describe("openChat", () => {
    it("opens chat view with provided chat id and model", async () => {
      const { app, plugin } = createPluginStub();
      const leaf = { setViewState: jest.fn(async () => {}) };
      app.workspace.getLeaf.mockReturnValue(leaf);

      const service = new ResumeChatService(plugin);
      await service.openChat("chat-3", "systemsculpt@@systemsculpt/ai-agent");

      expect(leaf.setViewState).toHaveBeenCalledWith({
        type: "systemsculpt-chat-view",
        state: {
          chatId: "chat-3",
          selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        },
      });
      expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    });

    it("requests a new tab leaf", async () => {
      const { app, plugin } = createPluginStub();
      const leaf = { setViewState: jest.fn(async () => {}) };
      app.workspace.getLeaf.mockReturnValue(leaf);

      const service = new ResumeChatService(plugin);
      await service.openChat("chat-4", "openai@@gpt-4");

      expect(app.workspace.getLeaf).toHaveBeenCalledWith("tab");
    });

    it("shows notice on error", async () => {
      const { app, plugin } = createPluginStub();
      const leaf = {
        setViewState: jest.fn(async () => {
          throw new Error("Test error");
        }),
      };
      app.workspace.getLeaf.mockReturnValue(leaf);

      const service = new ResumeChatService(plugin);
      await service.openChat("chat-5", "openai@@gpt-4");

      expect(Notice).toHaveBeenCalledWith("Error opening chat. Please try again.");
    });
  });

  describe("cleanup", () => {
    it("removes all registered event listeners", () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      // Create mock elements with event listeners
      const button1 = document.createElement("button");
      const button2 = document.createElement("button");
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      // Access private method via any
      (service as any).registerListener(button1, "click", listener1);
      (service as any).registerListener(button2, "click", listener2);

      // Add spy to confirm removal
      const spy1 = jest.spyOn(button1, "removeEventListener");
      const spy2 = jest.spyOn(button2, "removeEventListener");

      service.cleanup();

      expect(spy1).toHaveBeenCalledWith("click", listener1);
      expect(spy2).toHaveBeenCalledWith("click", listener2);
    });

    it("clears listeners array after cleanup", () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const button = document.createElement("button");
      (service as any).registerListener(button, "click", jest.fn());

      expect((service as any).listeners.length).toBe(1);

      service.cleanup();

      expect((service as any).listeners.length).toBe(0);
    });

    it("handles cleanup when no listeners registered", () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      expect(() => service.cleanup()).not.toThrow();
    });
  });

  describe("workspace event handlers", () => {
    it("registers active-leaf-change event", () => {
      const { app, plugin } = createPluginStub();
      new ResumeChatService(plugin);

      const onCalls = app.workspace.on.mock.calls;
      const activeLeafCall = onCalls.find(
        (call: any[]) => call[0] === "active-leaf-change"
      );
      expect(activeLeafCall).toBeDefined();
    });

    it("registers layout-change event", () => {
      const { app, plugin } = createPluginStub();
      new ResumeChatService(plugin);

      const onCalls = app.workspace.on.mock.calls;
      const layoutCall = onCalls.find(
        (call: any[]) => call[0] === "layout-change"
      );
      expect(layoutCall).toBeDefined();
    });

    it("registers metadata-cache changed event", () => {
      const { app, plugin } = createPluginStub();
      new ResumeChatService(plugin);

      const onCalls = app.metadataCache.on.mock.calls;
      const changedCall = onCalls.find((call: any[]) => call[0] === "changed");
      expect(changedCall).toBeDefined();
    });
  });

  describe("debouncedRefreshAllLeaves", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("coalesces multiple calls", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const debounced = (service as any).debouncedRefreshAllLeaves();

      debounced();
      debounced();
      debounced();

      expect(app.workspace.iterateAllLeaves).not.toHaveBeenCalled();

      jest.advanceTimersByTime(50);

      expect(app.workspace.iterateAllLeaves).toHaveBeenCalledTimes(1);
    });

    it("allows subsequent calls after delay", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const debounced = (service as any).debouncedRefreshAllLeaves();

      debounced();
      jest.advanceTimersByTime(50);

      debounced();
      jest.advanceTimersByTime(50);

      expect(app.workspace.iterateAllLeaves).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge cases", () => {
    it("handles files in nested chat directories", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/2025/01/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          id: "chat-1",
          model: "openai@@gpt-4",
          created: "2025-01-01",
        },
      });

      expect(service.isChatHistoryFile(file)).toBe(true);
    });

    it("handles custom chats directory", () => {
      const { app, plugin } = createPluginStub();
      plugin.settings.chatsDirectory = "MyChats";
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "MyChats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          id: "chat-1",
          model: "openai@@gpt-4",
          created: "2025-01-01",
        },
      });

      expect(service.isChatHistoryFile(file)).toBe(true);

      const oldFile = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      expect(service.isChatHistoryFile(oldFile)).toBe(false);
    });

    it("handles files with special characters in name", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/Chat about AI & ML.md" });
      app.metadataCache.getCache.mockReturnValue({});

      expect(service.extractChatId(file)).toBe("Chat about AI & ML");
    });
  });
});

