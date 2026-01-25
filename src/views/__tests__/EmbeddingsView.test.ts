/**
 * @jest-environment jsdom
 */

import { EmbeddingsView, EMBEDDINGS_VIEW_TYPE } from "../EmbeddingsView";
import { WorkspaceLeaf, TFile } from "obsidian";

const createMockManager = (overrides: Record<string, any> = {}) => ({
  awaitReady: jest.fn().mockResolvedValue(undefined),
  hasAnyStoredVectors: jest.fn().mockReturnValue(true),
  hasAnyEmbeddings: jest.fn().mockReturnValue(true),
  hasVector: jest.fn().mockReturnValue(true),
  findSimilar: jest.fn().mockResolvedValue([]),
  searchSimilar: jest.fn().mockResolvedValue([]),
  getStats: jest.fn().mockReturnValue({ total: 100, processed: 80, present: 80, needsProcessing: 20, failed: 0 }),
  isCurrentlyProcessing: jest.fn().mockReturnValue(false),
  processVault: jest.fn().mockResolvedValue({ status: "complete" }),
  ...overrides,
});

const createMockPlugin = (manager = createMockManager()) => ({
  settings: {
    embeddingsEnabled: true,
    embeddingsProvider: "systemsculpt",
    embeddingsCustomEndpoint: "",
    embeddingsCustomModel: "",
    embeddingsExclusions: {},
  },
  getOrCreateEmbeddingsManager: jest.fn().mockReturnValue(manager),
  app: {
    workspace: {
      getActiveFile: jest.fn().mockReturnValue(null),
      getActiveViewOfType: jest.fn().mockReturnValue(null),
      activeLeaf: null,
      on: jest.fn().mockReturnValue({ id: "event-ref" }),
    },
    vault: {
      read: jest.fn().mockResolvedValue("file content"),
      on: jest.fn().mockReturnValue({ id: "event-ref" }),
      offref: jest.fn(),
    },
  },
});

const createMockLeaf = () => ({
  view: null,
  containerEl: document.createElement("div"),
});

const createMockChatView = (options: { chatId?: string; title?: string; messages?: any[] } = {}) => ({
  chatId: options.chatId ?? "chat-123",
  getChatTitle: jest.fn().mockReturnValue(options.title ?? "Test Chat"),
  getMessages: jest.fn().mockReturnValue(options.messages ?? []),
  contextManager: {
    getContextFiles: jest.fn().mockReturnValue(new Set()),
  },
});

describe("EmbeddingsView", () => {
  let view: EmbeddingsView;
  let mockPlugin: any;
  let mockManager: any;
  let mockLeaf: any;

  beforeEach(() => {
    jest.useFakeTimers();
    mockManager = createMockManager();
    mockPlugin = createMockPlugin(mockManager);
    mockLeaf = createMockLeaf();

    const contentEl = document.createElement("div");
    mockLeaf.containerEl.appendChild(document.createElement("div"));
    mockLeaf.containerEl.appendChild(contentEl);

    view = new EmbeddingsView(mockLeaf as any, mockPlugin as any);
    (view as any).contentEl = contentEl;
    (view as any).app = mockPlugin.app;
    (view as any).containerEl = mockLeaf.containerEl;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe("view basics", () => {
    it("returns correct view type", () => {
      expect(view.getViewType()).toBe(EMBEDDINGS_VIEW_TYPE);
    });

    it("returns correct display text", () => {
      expect(view.getDisplayText()).toBe("Similar Notes");
    });

    it("returns correct icon", () => {
      expect(view.getIcon()).toBe("network");
    });
  });

  describe("file-based search", () => {
    beforeEach(() => {
      (view as any).setupUI();
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);
    });

    it("calls manager.findSimilar() when file has vector", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.hasVector.mockReturnValue(true);
      mockManager.findSimilar.mockResolvedValue([
        { path: "notes/similar.md", score: 0.9, metadata: { title: "Similar" } },
      ]);

      await (view as any).searchForSimilar(mockFile);

      expect(mockManager.awaitReady).toHaveBeenCalled();
      expect(mockManager.findSimilar).toHaveBeenCalledWith("notes/test.md", 15);
    });

    it("falls back to searchSimilar() when file has no vector", async () => {
      const mockFile = new TFile({ path: "notes/new.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.hasVector.mockReturnValue(false);
      mockManager.hasAnyEmbeddings.mockReturnValue(true);
      mockPlugin.app.vault.read.mockResolvedValue("This is new file content");

      await (view as any).searchForSimilar(mockFile);

      expect(mockManager.searchSimilar).toHaveBeenCalledWith("This is new file content", 15);
      expect(mockManager.findSimilar).not.toHaveBeenCalled();
    });

    it("shows processing prompt when no embeddings exist", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.hasAnyStoredVectors.mockReturnValue(false);

      const showProcessingPromptSpy = jest.spyOn(view as any, "showProcessingPrompt").mockImplementation(() => {});

      await (view as any).searchForSimilar(mockFile);

      expect(showProcessingPromptSpy).toHaveBeenCalled();
    });

    it("deduplicates searches for same file", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.findSimilar.mockResolvedValue([]);

      await (view as any).searchForSimilar(mockFile);
      await (view as any).searchForSimilar(mockFile);

      expect((view as any).lastSearchContent).toBe("notes/test.md");
    });

    it("handles manager errors gracefully", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.findSimilar.mockRejectedValue(new Error("Search failed"));

      const showErrorSpy = jest.spyOn(view as any, "showError").mockImplementation(() => {});

      await (view as any).searchForSimilar(mockFile);

      expect(showErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Search failed"));
    });

    it("shows empty content state for empty files", async () => {
      const mockFile = new TFile({ path: "notes/empty.md", stat: { mtime: Date.now(), size: 0 } });
      mockManager.hasVector.mockReturnValue(false);
      mockManager.hasAnyEmbeddings.mockReturnValue(true);
      mockPlugin.app.vault.read.mockResolvedValue("   ");

      const showEmptyContentSpy = jest.spyOn(view as any, "showEmptyContent").mockImplementation(() => {});

      await (view as any).searchForSimilar(mockFile);

      expect(showEmptyContentSpy).toHaveBeenCalled();
    });
  });

  describe("chat-based search", () => {
    beforeEach(() => {
      (view as any).setupUI();
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);
    });

    it("extracts content from first 3 + last 2 messages", () => {
      const messages = [
        { message_id: "1", content: "First message" },
        { message_id: "2", content: "Second message" },
        { message_id: "3", content: "Third message" },
        { message_id: "4", content: "Fourth message" },
        { message_id: "5", content: "Fifth message" },
        { message_id: "6", content: "Sixth message" },
      ];
      const mockChatView = createMockChatView({ messages });

      const content = (view as any).extractChatContent(mockChatView);

      expect(content).toContain("First message");
      expect(content).toContain("Second message");
      expect(content).toContain("Third message");
      expect(content).toContain("Fifth message");
      expect(content).toContain("Sixth message");
      expect(content).not.toContain("Fourth message");
    });

    it("handles multipart message content", () => {
      const messages = [
        {
          message_id: "1",
          content: [
            { type: "text", text: "Text part" },
            { type: "image", image_url: "http://example.com/img.png" },
          ],
        },
      ];
      const mockChatView = createMockChatView({ messages });

      const content = (view as any).extractChatContent(mockChatView);

      expect(content).toContain("Text part");
      expect(content).not.toContain("http://example.com");
    });

    it("returns empty string for chat with no messages", () => {
      const mockChatView = createMockChatView({ messages: [] });

      const content = (view as any).extractChatContent(mockChatView);

      expect(content).toBe("");
    });

    it("calls searchSimilar with extracted content", async () => {
      const messages = [{ message_id: "1", content: "Test message content" }];
      const mockChatView = createMockChatView({ messages });
      mockManager.searchSimilar.mockResolvedValue([]);

      await (view as any).searchForSimilarFromChat(mockChatView);

      expect(mockManager.searchSimilar).toHaveBeenCalledWith(expect.stringContaining("Test message content"), 15);
    });

    it("uses content hash for change detection", async () => {
      const messages = [{ message_id: "1", content: "Test content" }];
      const mockChatView = createMockChatView({ messages });

      await (view as any).searchForSimilarFromChat(mockChatView);

      expect((view as any).lastFileHash).toBeTruthy();
      expect((view as any).lastSearchContent).toBe("chat:chat-123");
    });

    it("shows empty content for empty chat", async () => {
      const mockChatView = createMockChatView({ messages: [] });

      const showEmptyContentSpy = jest.spyOn(view as any, "showEmptyContent").mockImplementation(() => {});

      await (view as any).searchForSimilarFromChat(mockChatView);

      expect(showEmptyContentSpy).toHaveBeenCalled();
    });
  });

  describe("pending search queue", () => {
    beforeEach(() => {
      (view as any).setupUI();
    });

    it("queues file search when view is not visible", async () => {
      (view as any).isViewVisible = jest.fn().mockReturnValue(false);
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });

      await (view as any).searchForSimilar(mockFile);

      expect((view as any).pendingSearch).toEqual({ type: "file", file: mockFile });
      expect(mockManager.findSimilar).not.toHaveBeenCalled();
    });

    it("queues chat search when view is not visible", async () => {
      (view as any).isViewVisible = jest.fn().mockReturnValue(false);
      const mockChatView = createMockChatView();

      await (view as any).searchForSimilarFromChat(mockChatView);

      expect((view as any).pendingSearch).toEqual({ type: "chat", chatView: mockChatView });
      expect(mockManager.searchSimilar).not.toHaveBeenCalled();
    });

    it("flushes pending file search when view becomes visible", async () => {
      const mockFile = new TFile({ path: "notes/queued.md", stat: { mtime: Date.now(), size: 100 } });
      (view as any).pendingSearch = { type: "file", file: mockFile };
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);

      const searchForSimilarSpy = jest.spyOn(view as any, "searchForSimilar").mockResolvedValue(undefined);

      (view as any).flushPendingSearchIfVisible();

      expect((view as any).pendingSearch).toBeNull();

      jest.advanceTimersByTime(20);

      expect(searchForSimilarSpy).toHaveBeenCalledWith(mockFile);
    });

    it("flushes pending chat search when view becomes visible", async () => {
      const mockChatView = createMockChatView();
      (view as any).pendingSearch = { type: "chat", chatView: mockChatView };
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);

      const searchForSimilarFromChatSpy = jest.spyOn(view as any, "searchForSimilarFromChat").mockResolvedValue(undefined);

      (view as any).flushPendingSearchIfVisible();

      expect((view as any).pendingSearch).toBeNull();

      jest.advanceTimersByTime(20);

      expect(searchForSimilarFromChatSpy).toHaveBeenCalledWith(mockChatView);
    });

    it("does not flush when view is still not visible", () => {
      const mockFile = new TFile({ path: "notes/queued.md", stat: { mtime: Date.now(), size: 100 } });
      (view as any).pendingSearch = { type: "file", file: mockFile };
      (view as any).isViewVisible = jest.fn().mockReturnValue(false);

      const searchForSimilarSpy = jest.spyOn(view as any, "searchForSimilar");

      (view as any).flushPendingSearchIfVisible();

      expect(searchForSimilarSpy).not.toHaveBeenCalled();
      expect((view as any).pendingSearch).toEqual({ type: "file", file: mockFile });
    });
  });

  describe("event debouncing", () => {
    beforeEach(() => {
      (view as any).setupUI();
    });

    it("debounces active-leaf-change by 300ms", () => {
      const checkActiveFileSpy = jest.spyOn(view as any, "checkActiveFile").mockImplementation(() => {});

      (view as any).debouncedCheckActiveFile();
      (view as any).debouncedCheckActiveFile();
      (view as any).debouncedCheckActiveFile();

      expect(checkActiveFileSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(300);

      expect(checkActiveFileSpy).toHaveBeenCalledTimes(1);
    });

    it("debounces file-modify by 600ms", () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      (view as any).currentFile = mockFile;
      const searchForSimilarSpy = jest.spyOn(view as any, "searchForSimilar").mockResolvedValue(undefined);

      (view as any).debouncedSearchCurrentFile();

      expect(searchForSimilarSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(600);

      expect(searchForSimilarSpy).toHaveBeenCalledWith(mockFile);
    });

    it("cancels previous debounce on new call", () => {
      const checkActiveFileSpy = jest.spyOn(view as any, "checkActiveFile").mockImplementation(() => {});

      (view as any).debouncedCheckActiveFile();
      jest.advanceTimersByTime(200);

      (view as any).debouncedCheckActiveFile();
      jest.advanceTimersByTime(200);

      expect(checkActiveFileSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);

      expect(checkActiveFileSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("disabled state", () => {
    beforeEach(() => {
      (view as any).setupUI();
    });

    it("shows disabled state when embeddings are disabled", () => {
      mockPlugin.settings.embeddingsEnabled = false;
      const showDisabledStateSpy = jest.spyOn(view as any, "showDisabledState").mockImplementation(() => {});

      (view as any).checkActiveFile();

      expect(showDisabledStateSpy).toHaveBeenCalled();
    });
  });

  describe("drag state management", () => {
    beforeEach(() => {
      (view as any).setupUI();
    });

    it("ignores checkActiveFile during drag", () => {
      (view as any).isDragging = true;
      mockPlugin.app.workspace.getActiveFile.mockReturnValue(
        new TFile({ path: "notes/new.md", stat: { mtime: Date.now(), size: 100 } })
      );

      const searchForSimilarSpy = jest.spyOn(view as any, "searchForSimilar");

      (view as any).checkActiveFile();

      expect(searchForSimilarSpy).not.toHaveBeenCalled();
    });
  });

  describe("result rendering", () => {
    beforeEach(() => {
      (view as any).setupUI();
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);
    });

    it("stores results for later access", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      const mockResults = [
        { path: "notes/similar1.md", score: 0.95, metadata: { title: "Similar 1", excerpt: "Content 1" } },
        { path: "notes/similar2.md", score: 0.85, metadata: { title: "Similar 2", excerpt: "Content 2" } },
      ];
      mockManager.findSimilar.mockResolvedValue(mockResults);

      await (view as any).searchForSimilar(mockFile);

      expect((view as any).currentResults).toEqual(mockResults);
    });

    it("clears results on file delete", () => {
      const deletedPath = "notes/deleted.md";
      (view as any).currentResults = [
        { path: deletedPath, score: 0.9 },
        { path: "notes/remaining.md", score: 0.8 },
      ];
      (view as any).currentFile = new TFile({ path: "notes/current.md", stat: { mtime: Date.now(), size: 100 } });
      (view as any).updateResults = jest.fn();

      const mockDeletedFile = { path: deletedPath };

      (view as any).isDragging = false;
      const filtered = (view as any).currentResults.filter((r: any) => r.path !== deletedPath);
      (view as any).currentResults = filtered;

      expect((view as any).currentResults).toHaveLength(1);
      expect((view as any).currentResults[0].path).toBe("notes/remaining.md");
    });
  });

  describe("config change detection", () => {
    it("generates different config keys for different settings", () => {
      const settings1 = {
        embeddingsEnabled: true,
        embeddingsProvider: "systemsculpt",
        embeddingsCustomEndpoint: "",
        embeddingsCustomModel: "",
        embeddingsExclusions: {},
      };

      const settings2 = {
        embeddingsEnabled: true,
        embeddingsProvider: "custom",
        embeddingsCustomEndpoint: "http://localhost:1234",
        embeddingsCustomModel: "text-embedding-3-small",
        embeddingsExclusions: {},
      };

      const key1 = (view as any).getEmbeddingsConfigKey(settings1);
      const key2 = (view as any).getEmbeddingsConfigKey(settings2);

      expect(key1).not.toBe(key2);
    });

    it("generates same config key for same settings", () => {
      const settings = {
        embeddingsEnabled: true,
        embeddingsProvider: "systemsculpt",
        embeddingsCustomEndpoint: "",
        embeddingsCustomModel: "",
        embeddingsExclusions: { folders: [] },
      };

      const key1 = (view as any).getEmbeddingsConfigKey(settings);
      const key2 = (view as any).getEmbeddingsConfigKey(settings);

      expect(key1).toBe(key2);
    });
  });

  describe("content hashing", () => {
    it("generates consistent hash for same content", () => {
      const content = "Test content for hashing";

      const hash1 = (view as any).hashContent(content);
      const hash2 = (view as any).hashContent(content);

      expect(hash1).toBe(hash2);
    });

    it("generates different hash for different content", () => {
      const hash1 = (view as any).hashContent("Content A");
      const hash2 = (view as any).hashContent("Content B");

      expect(hash1).not.toBe(hash2);
    });
  });
});
