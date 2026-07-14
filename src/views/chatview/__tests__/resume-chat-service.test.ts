/**
 * @jest-environment jsdom
 */
import { MarkdownView, TFile, Notice } from "obsidian";
import { ResumeChatService } from "../ResumeChatService";
import * as ChatResumeUtils from "../ChatResumeUtils";

// Mock Notice
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(),
  };
});

jest.mock("../ChatResumeUtils", () => ({
  openChatResumeDescriptor: jest.fn(),
}));

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
    document.body.replaceChildren();
  });

  describe("constructor", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("creates instance and registers workspace events", () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      expect(service).toBeInstanceOf(ResumeChatService);
      // Should register 4 events: active-leaf-change, file-open, layout-change, metadata-changed
      expect(plugin.registerEvent).toHaveBeenCalledTimes(4);
    });

    it("refreshes existing leaves on startup", () => {
      const { app, plugin } = createPluginStub();
      new ResumeChatService(plugin);

      expect(app.workspace.iterateAllLeaves).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();

      expect(app.workspace.iterateAllLeaves).toHaveBeenCalledTimes(1);
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

    it("returns false when the chat id is missing", () => {
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
    });

    it("accepts managed chat history files even if old model metadata is absent", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      const file = new TFile({ path: "SystemSculpt/Chats/chat-1.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: {
          id: "chat-1",
          created: "2025-01-01",
        },
      });
      expect(service.isChatHistoryFile(file)).toBe(true);
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

  describe("openChat", () => {
    it("opens chat through the shared resume descriptor when chat metadata exists", async () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const descriptor = {
        chatId: "chat-3",
        title: "Chat 3",
        chatPath: "SystemSculpt/Chats/chat-3.md",
        lastModified: Date.now(),
        messageCount: 3,
      };
      (service as any).chatStorage = {
        getChatResumeDescriptor: jest.fn().mockResolvedValue(descriptor),
      };
      const openSpy = ChatResumeUtils.openChatResumeDescriptor as jest.Mock;
      openSpy.mockResolvedValue(undefined);

      await service.openChat("chat-3", "SystemSculpt/Chats/chat-3.md");

      expect(openSpy).toHaveBeenCalledWith(plugin, descriptor);
    });

    it("falls back to opening a tab directly when descriptor lookup is unavailable", async () => {
      const { app, plugin } = createPluginStub();
      const leaf = { setViewState: jest.fn(async () => {}) };
      app.workspace.getLeaf.mockReturnValue(leaf);

      const service = new ResumeChatService(plugin);
      (service as any).chatStorage = {
        getChatResumeDescriptor: jest.fn().mockResolvedValue(null),
      };

      await service.openChat("chat-4", "SystemSculpt/Chats/chat-4.md");

      expect(app.workspace.getLeaf).toHaveBeenCalledWith("tab");
      expect(leaf.setViewState).toHaveBeenCalledWith({
        type: "systemsculpt-chat-view",
        state: {
          chatId: "chat-4",
        },
      });
    });

    it("shows notice on error", async () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      (service as any).chatStorage = {
        getChatResumeDescriptor: jest.fn(async () => {
          throw new Error("Test error");
        }),
      };

      await service.openChat("chat-5", "SystemSculpt/Chats/chat-5.md");

      expect(Notice).toHaveBeenCalledWith("Error opening chat. Please try again.");
    });
  });

  describe("native Markdown view action", () => {
    const createHistoryView = (file: TFile) => {
      const header = document.createElement("div");
      const action = document.createElement("button");
      document.body.appendChild(header);
      const view = new MarkdownView() as MarkdownView & {
        file: TFile;
        addAction: jest.Mock;
      };
      view.file = file;
      view.addAction = jest.fn(() => {
        header.appendChild(action);
        return action;
      });
      return { view, action, leaf: { view } as any };
    };

    it("registers Resume this chat through MarkdownView.addAction", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-native", created: "2025-01-01" },
      });
      const { view, leaf } = createHistoryView(file);

      (service as any).handleLeafChange(leaf);

      expect(view.addAction).toHaveBeenCalledWith(
        "message-circle",
        "Resume this chat",
        expect.any(Function),
      );
      expect((service as any).resumeActionByView.get(view)).toBeDefined();
    });

    it("keeps the same native action when the view descriptor is unchanged", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-native", created: "2025-01-01" },
      });
      const { view, action, leaf } = createHistoryView(file);
      const remove = jest.spyOn(action, "remove");

      (service as any).handleLeafChange(leaf);
      (service as any).handleLeafChange(leaf);

      expect(view.addAction).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
    });

    it("restores the native action when Obsidian rebuilds the view header", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-native", created: "2025-01-01" },
      });
      const { view, action, leaf } = createHistoryView(file);

      (service as any).handleLeafChange(leaf);
      action.remove();
      (service as any).handleLeafChange(leaf);

      expect(view.addAction).toHaveBeenCalledTimes(2);
      expect(action.isConnected).toBe(true);
    });

    it("routes the native action through the existing chat resume path", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-native", created: "2025-01-01" },
      });
      const { view, leaf } = createHistoryView(file);
      const openChat = jest.spyOn(service, "openChat").mockResolvedValue(undefined);

      (service as any).handleLeafChange(leaf);
      const callback = view.addAction.mock.calls[0][2];
      callback(new MouseEvent("click"));

      expect(openChat).toHaveBeenCalledWith("chat-native", file.path);
    });

    it("removes a stale native action when the view leaves chat history", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-native", created: "2025-01-01" },
      });
      const { view, action, leaf } = createHistoryView(file);
      const remove = jest.spyOn(action, "remove");
      (service as any).handleLeafChange(leaf);

      view.file = new TFile({ path: "Notes/Other.md" });
      (service as any).handleLeafChange(leaf);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(view.addAction).toHaveBeenCalledTimes(1);
      expect((service as any).resumeActionByView.has(view)).toBe(false);
    });

    it("removes every native action during plugin cleanup", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-native", created: "2025-01-01" },
      });
      const { action, leaf } = createHistoryView(file);
      const remove = jest.spyOn(action, "remove");
      (service as any).handleLeafChange(leaf);

      service.cleanup();

      expect(remove).toHaveBeenCalledTimes(1);
      expect((service as any).resumeActionByView.size).toBe(0);
    });

    it("does not recreate native actions from a pending startup refresh after cleanup", () => {
      jest.useFakeTimers();
      try {
        const { app, plugin } = createPluginStub();
        const service = new ResumeChatService(plugin);
        const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
        app.metadataCache.getCache.mockReturnValue({
          frontmatter: { id: "chat-native", created: "2025-01-01" },
        });
        const { view, leaf } = createHistoryView(file);
        app.workspace.iterateAllLeaves.mockImplementation((callback: (leaf: any) => void) => callback(leaf));

        service.cleanup();
        jest.runOnlyPendingTimers();

        expect(view.addAction).not.toHaveBeenCalled();
        expect((service as any).resumeActionByView.size).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("cancels a pending layout refresh during cleanup", () => {
      jest.useFakeTimers();
      try {
        const { app, plugin } = createPluginStub();
        const service = new ResumeChatService(plugin);
        jest.runOnlyPendingTimers();
        app.workspace.iterateAllLeaves.mockClear();
        const layoutHandler = app.workspace.on.mock.calls.find(
          (call: any[]) => call[0] === "layout-change",
        )?.[1];

        layoutHandler?.();
        service.cleanup();
        jest.runOnlyPendingTimers();

        expect(app.workspace.iterateAllLeaves).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it("keeps workspace timers on the primary plugin window when a popout is active", () => {
      jest.useFakeTimers();
      const primaryClearTimeout = jest.spyOn(window, "clearTimeout");
      const popoutWindow = {
        setTimeout: jest.fn(() => 4242),
        clearTimeout: jest.fn(),
      };
      const previousActiveWindow = (window as any).activeWindow;
      try {
        (window as any).activeWindow = popoutWindow;
        const { app, plugin } = createPluginStub();
        const service = new ResumeChatService(plugin);
        const layoutHandler = app.workspace.on.mock.calls.find(
          (call: any[]) => call[0] === "layout-change",
        )?.[1];

        layoutHandler?.();
        service.cleanup();

        expect(primaryClearTimeout).toHaveBeenCalled();
        expect(popoutWindow.setTimeout).not.toHaveBeenCalled();
        expect(popoutWindow.clearTimeout).not.toHaveBeenCalled();
      } finally {
        (window as any).activeWindow = previousActiveWindow;
        primaryClearTimeout.mockRestore();
        jest.useRealTimers();
      }
    });

    it("removes actions for Markdown views that left the workspace layout", () => {
      const { app, plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);
      const file = new TFile({ path: "SystemSculpt/Chats/chat-native.md" });
      app.metadataCache.getCache.mockReturnValue({
        frontmatter: { id: "chat-native", created: "2025-01-01" },
      });
      const { action, leaf } = createHistoryView(file);
      const remove = jest.spyOn(action, "remove");
      (service as any).handleLeafChange(leaf);
      app.workspace.iterateAllLeaves.mockImplementation(() => undefined);

      (service as any).refreshAllLeaves();

      expect(remove).toHaveBeenCalledTimes(1);
      expect((service as any).resumeActionByView.size).toBe(0);
    });

    it("handles cleanup when no actions are registered", () => {
      const { plugin } = createPluginStub();
      const service = new ResumeChatService(plugin);

      expect(() => service.cleanup()).not.toThrow();
    });

    it("refreshes the native action when file-open swaps chat files in the same leaf", () => {
      jest.useFakeTimers();
      try {
        const { app, plugin } = createPluginStub();
        const service = new ResumeChatService(plugin);
        jest.runOnlyPendingTimers();
        const firstFile = new TFile({ path: "SystemSculpt/Chats/chat-one.md" });
        const secondFile = new TFile({ path: "SystemSculpt/Chats/chat-two.md" });
        const { view, action, leaf } = createHistoryView(firstFile);
        const remove = jest.spyOn(action, "remove");

        app.metadataCache.getCache.mockImplementation((path: string) => {
          if (path === firstFile.path) {
            return { frontmatter: { id: "chat-one", created: "2025-01-01" } };
          }
          if (path === secondFile.path) {
            return { frontmatter: { id: "chat-two", created: "2025-01-01" } };
          }
          return null;
        });
        app.workspace.iterateAllLeaves.mockImplementation((callback: (leaf: any) => void) => callback(leaf));

        (service as any).handleLeafChange(leaf);
        view.file = secondFile;

        const fileOpenHandler = app.workspace.on.mock.calls.find(
          (call: any[]) => call[0] === "file-open"
        )?.[1];
        fileOpenHandler?.(secondFile);

        expect(remove).not.toHaveBeenCalled();
        expect(view.addAction).toHaveBeenCalledTimes(1);

        jest.runOnlyPendingTimers();

        expect(remove).toHaveBeenCalledTimes(1);
        expect(view.addAction).toHaveBeenCalledTimes(2);
        expect((service as any).resumeActionByView.get(view)).toMatchObject({
          filePath: secondFile.path,
          chatId: "chat-two",
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it("removes the native action when file-open swaps a chat file to a normal note in the same leaf", () => {
      jest.useFakeTimers();
      try {
        const { app, plugin } = createPluginStub();
        const service = new ResumeChatService(plugin);
        jest.runOnlyPendingTimers();
        const chatFile = new TFile({ path: "SystemSculpt/Chats/chat-one.md" });
        const noteFile = new TFile({ path: "Notes/Plain.md" });
        const { view, action, leaf } = createHistoryView(chatFile);
        const remove = jest.spyOn(action, "remove");

        app.metadataCache.getCache.mockImplementation((path: string) => {
          if (path === chatFile.path) {
            return { frontmatter: { id: "chat-one", created: "2025-01-01" } };
          }
          return null;
        });
        app.workspace.iterateAllLeaves.mockImplementation((callback: (leaf: any) => void) => callback(leaf));

        (service as any).handleLeafChange(leaf);
        view.file = noteFile;

        const fileOpenHandler = app.workspace.on.mock.calls.find(
          (call: any[]) => call[0] === "file-open"
        )?.[1];
        fileOpenHandler?.(noteFile);

        expect(remove).not.toHaveBeenCalled();
        expect((service as any).resumeActionByView.has(view)).toBe(true);

        jest.runOnlyPendingTimers();

        expect(remove).toHaveBeenCalledTimes(1);
        expect((service as any).resumeActionByView.has(view)).toBe(false);
      } finally {
        jest.useRealTimers();
      }
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

    it("registers file-open event", () => {
      const { app, plugin } = createPluginStub();
      new ResumeChatService(plugin);

      const onCalls = app.workspace.on.mock.calls;
      const fileOpenCall = onCalls.find(
        (call: any[]) => call[0] === "file-open"
      );
      expect(fileOpenCall).toBeDefined();
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
      jest.runOnlyPendingTimers();
      app.workspace.iterateAllLeaves.mockClear();

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
      jest.runOnlyPendingTimers();
      app.workspace.iterateAllLeaves.mockClear();

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
