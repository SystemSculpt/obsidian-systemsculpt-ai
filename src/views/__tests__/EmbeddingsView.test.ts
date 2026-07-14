/**
 * @jest-environment jsdom
 */

import { EmbeddingsView, EMBEDDINGS_VIEW_TYPE } from "../EmbeddingsView";
import { WorkspaceLeaf, TFile } from "obsidian";
import { MANAGED_EMBEDDING_LIMITS } from "../../services/embeddings/ManagedEmbeddingsContract";
import { CHAT_TRANSCRIPT_COMMITTED_EVENT } from "../chatview/ChatTranscriptEvents";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const createMockManager = (overrides: Record<string, any> = {}) => {
  const manager: Record<string, any> = {
    awaitReady: jest.fn().mockResolvedValue(undefined),
    hasAnyEmbeddings: jest.fn().mockReturnValue(true),
    hasVector: jest.fn().mockReturnValue(true),
    findSimilar: jest.fn().mockResolvedValue([]),
    searchSimilar: jest.fn().mockResolvedValue([]),
    getStats: jest.fn().mockReturnValue({ total: 100, processed: 80, present: 80, needsProcessing: 20, failed: 0 }),
    getLifecycleSnapshot: jest.fn().mockReturnValue({
      phase: "idle", ready: true, generation: null, total: 100, completed: 80,
      pending: 20, failed: 0, currentPath: null, lastError: null, updatedAt: 1,
    }),
    subscribeLifecycle: jest.fn((listener: (snapshot: any) => void) => {
      listener(manager.getLifecycleSnapshot());
      return jest.fn();
    }),
    isCurrentlyProcessing: jest.fn().mockReturnValue(false),
    resumeProcessing: jest.fn(),
    processVault: jest.fn().mockResolvedValue({ status: "complete" }),
  };
  manager.getFileIndexSnapshot = jest.fn(() => manager.hasVector()
    ? { state: "ready", ready: true, indexedAt: 1, generation: null }
    : { state: "missing", ready: false, indexedAt: null, generation: null });
  return Object.assign(manager, overrides);
};

const createMockPlugin = (manager = createMockManager()) => ({
  settings: {
    embeddingsEnabled: true,
    embeddingsExclusions: {},
  },
  getOrCreateEmbeddingsManager: jest.fn().mockReturnValue(manager),
  openSettingsTab: jest.fn(),
  app: {
    workspace: {
      getActiveFile: jest.fn().mockReturnValue(null),
      getActiveViewOfType: jest.fn().mockReturnValue(null),
      activeLeaf: null,
      on: jest.fn().mockReturnValue({ id: "event-ref" }),
      getLeaf: jest.fn().mockReturnValue({ openFile: jest.fn().mockResolvedValue(undefined) }),
    },
    vault: {
      read: jest.fn().mockResolvedValue("file content"),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
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
  addFileToContext: jest.fn().mockResolvedValue(undefined),
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
      expect(view.getDisplayText()).toBe("Similar notes");
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
      expect(mockManager.findSimilar).toHaveBeenCalledWith(
        "notes/test.md",
        15,
        expect.any(AbortSignal),
      );
    });

    it("falls back to searchSimilar() when file has no vector", async () => {
      const mockFile = new TFile({ path: "notes/new.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.hasVector.mockReturnValue(false);
      mockManager.hasAnyEmbeddings.mockReturnValue(true);
      mockPlugin.app.vault.read.mockResolvedValue("This is new file content");

      await (view as any).searchForSimilar(mockFile);

      expect(mockManager.searchSimilar).toHaveBeenCalledWith(
        "This is new file content",
        15,
        expect.any(AbortSignal),
      );
      expect(mockManager.findSimilar).not.toHaveBeenCalled();
    });

    it("bounds a long unindexed note before sending the semantic query", async () => {
      const mockFile = new TFile({ path: "notes/long.md", stat: { mtime: Date.now(), size: 20_000 } });
      mockManager.hasVector.mockReturnValue(false);
      mockManager.hasAnyEmbeddings.mockReturnValue(true);
      mockPlugin.app.vault.read.mockResolvedValue(`HEAD ${"x".repeat(12_000)} TAIL`);

      await (view as any).searchForSimilar(mockFile);

      const query = mockManager.searchSimilar.mock.calls[0][0] as string;
      expect(query.length).toBeLessThanOrEqual(MANAGED_EMBEDDING_LIMITS.maxCharsPerText);
      expect(query).toContain("HEAD");
      expect(query).toContain("TAIL");
    });

    it("shows processing prompt when no embeddings exist", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.hasAnyEmbeddings.mockReturnValue(false);
      mockManager.getLifecycleSnapshot.mockReturnValue({
        phase: "idle", ready: true, generation: null, total: 0, completed: 0,
        pending: 0, failed: 0, currentPath: null, lastError: null, updatedAt: 1,
      });

      const showProcessingPromptSpy = jest.spyOn(view as any, "showProcessingPrompt").mockImplementation(() => {});

      await (view as any).searchForSimilar(mockFile);

      expect(showProcessingPromptSpy).toHaveBeenCalled();
    });

    it("keeps repeated searches for the same file on the indexed path", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.findSimilar.mockResolvedValue([]);

      await (view as any).searchForSimilar(mockFile);
      await (view as any).searchForSimilar(mockFile);

      expect(mockManager.findSimilar).toHaveBeenCalledTimes(2);
    });

    it("handles manager errors gracefully", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      mockManager.findSimilar.mockRejectedValue(new Error("Search failed"));

      const showErrorSpy = jest.spyOn(view as any, "showError").mockImplementation(() => {});

      await (view as any).searchForSimilar(mockFile);

      expect(showErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Search failed"));
    });

    it("ignores an older same-source result that resolves after a newer search", async () => {
      const mockFile = new TFile({ path: "notes/race.md", stat: { mtime: Date.now(), size: 100 } });
      const first = deferred<any[]>();
      const second = deferred<any[]>();
      const oldResults = [{ path: "notes/old.md", score: 0.2, metadata: { title: "Old" } }];
      const freshResults = [{ path: "notes/fresh.md", score: 0.9, metadata: { title: "Fresh" } }];
      mockManager.findSimilar
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const updateResults = jest.spyOn(view as any, "updateResults").mockResolvedValue(undefined);

      const olderSearch = (view as any).searchForSimilar(mockFile);
      await Promise.resolve();
      await Promise.resolve();
      const newerSearch = (view as any).searchForSimilar(mockFile);
      await Promise.resolve();
      await Promise.resolve();

      second.resolve(freshResults);
      await newerSearch;
      first.resolve(oldResults);
      await olderSearch;

      expect(updateResults).toHaveBeenCalledTimes(1);
      expect(updateResults).toHaveBeenCalledWith(freshResults, mockFile);
    });

    it("suppresses an older same-source error after a newer search succeeds", async () => {
      const mockFile = new TFile({ path: "notes/race-error.md", stat: { mtime: Date.now(), size: 100 } });
      const first = deferred<any[]>();
      mockManager.findSimilar
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce([]);
      const showError = jest.spyOn(view as any, "showError").mockImplementation(() => undefined);

      const olderSearch = (view as any).searchForSimilar(mockFile);
      await Promise.resolve();
      await Promise.resolve();
      await (view as any).searchForSimilar(mockFile);
      first.reject(new Error("stale failure"));
      await olderSearch;

      expect(showError).not.toHaveBeenCalled();
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

      expect(mockManager.searchSimilar).toHaveBeenCalledWith(
        expect.stringContaining("Test message content"),
        15,
        expect.any(AbortSignal),
      );
    });

    it("uses content hash for change detection", async () => {
      const messages = [{ message_id: "1", content: "Test content" }];
      const mockChatView = createMockChatView({ messages });

      await (view as any).searchForSimilarFromChat(mockChatView);

      expect((view as any).lastFileHash).toBeTruthy();
    });

    it("shows empty content for empty chat", async () => {
      const mockChatView = createMockChatView({ messages: [] });

      const showEmptyContentSpy = jest.spyOn(view as any, "showEmptyContent").mockImplementation(() => {});

      await (view as any).searchForSimilarFromChat(mockChatView);

      expect(showEmptyContentSpy).toHaveBeenCalled();
    });
  });

  describe("event debouncing", () => {
    beforeEach(() => {
      (view as any).setupUI();
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);
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

    it("debounces file-modify by 600ms", async () => {
      const mockFile = new TFile({ path: "notes/test.md", stat: { mtime: Date.now(), size: 100 } });
      (view as any).currentFile = mockFile;

      (view as any).debouncedSearchCurrentFile();

      expect(mockManager.findSimilar).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(600);

      expect(mockManager.findSimilar).toHaveBeenCalledWith(
        mockFile.path,
        15,
        expect.any(AbortSignal),
      );
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

    it("refreshes only the matching chat after a durable transcript commit", async () => {
      const chatView = createMockChatView({
        chatId: "chat-current",
        messages: [{ message_id: "1", role: "user", content: "Committed transcript" }],
      });
      (view as any).currentChatView = chatView;
      (view as any).registerEvents();
      const registration = mockPlugin.app.workspace.on.mock.calls.find(
        ([eventName]: [string]) => eventName === CHAT_TRANSCRIPT_COMMITTED_EVENT,
      );
      const handler = registration?.[1] as (event: { chatId: string; version: number; role: "user"; messageId: string }) => void;

      handler({ chatId: "another-chat", version: 1, role: "user", messageId: "other" });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockManager.searchSimilar).not.toHaveBeenCalled();

      handler({ chatId: "chat-current", version: 2, role: "user", messageId: "current" });
      await jest.advanceTimersByTimeAsync(600);
      expect(mockManager.searchSimilar).toHaveBeenCalledWith(
        expect.stringContaining("Committed transcript"),
        15,
        expect.any(AbortSignal),
      );
    });
  });

  describe("close settlement", () => {
    beforeEach(() => {
      (view as any).setupUI();
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);
    });

    it("aborts an in-flight managed query and ignores its late result", async () => {
      const pending = deferred<any[]>();
      let signal: AbortSignal | undefined;
      mockManager.searchSimilar.mockImplementation((_query: string, _limit: number, nextSignal?: AbortSignal) => {
        signal = nextSignal;
        return pending.promise;
      });
      const chatView = createMockChatView({ messages: [{ message_id: "1", content: "Live transcript" }] });
      const updateResults = jest.spyOn(view as any, "updateResults").mockResolvedValue(undefined);

      const search = (view as any).searchForSimilarFromChat(chatView);
      await Promise.resolve();
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);

      await view.onClose();
      expect(signal?.aborted).toBe(true);
      pending.resolve([{ path: "notes/late.md", score: 1, metadata: { title: "Late" } }]);
      await search;

      expect(updateResults).not.toHaveBeenCalled();
    });

    it("aborts in-flight indexed-vector work", async () => {
      const pending = deferred<any[]>();
      let signal: AbortSignal | undefined;
      mockManager.findSimilar.mockImplementation((_path: string, _limit: number, nextSignal?: AbortSignal) => {
        signal = nextSignal;
        return pending.promise;
      });
      const file = new TFile({ path: "notes/indexed.md", stat: { mtime: Date.now(), size: 100 } });

      const search = (view as any).searchForSimilar(file);
      await Promise.resolve();
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);

      await view.onClose();
      expect(signal?.aborted).toBe(true);
      pending.resolve([]);
      await search;
    });

    it("clears pending debounce timers", async () => {
      const chatView = createMockChatView({ messages: [{ message_id: "1", content: "Live transcript" }] });
      (view as any).currentChatView = chatView;

      (view as any).debouncedSearchCurrentChat();
      await view.onClose();
      jest.advanceTimersByTime(1_000);

      expect(mockManager.searchSimilar).not.toHaveBeenCalled();
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

    it("unsubscribes and clears a previously rendered lifecycle strip", () => {
      const unsubscribe = jest.fn();
      mockManager.subscribeLifecycle.mockReturnValue(unsubscribe);
      (view as any).bindIndexLifecycle();
      const clearIndexSnapshot = jest.spyOn((view as any).presentation, "clearIndexSnapshot");

      mockPlugin.settings.embeddingsEnabled = false;
      (view as any).bindIndexLifecycle();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(clearIndexSnapshot).toHaveBeenCalledTimes(1);
      expect(mockPlugin.getOrCreateEmbeddingsManager).toHaveBeenCalledTimes(1);
    });
  });

  describe("vault source lifecycle", () => {
    beforeEach(() => {
      (view as any).setupUI();
    });

    it("clears a deleted source and never re-queries Obsidian's stale active-file object", () => {
      const source = new TFile({ path: "notes/deleted-source.md", stat: { mtime: Date.now(), size: 100 } });
      (view as any).currentFile = source;
      (view as any).currentResults = [{ path: "notes/related.md", score: 0.9 }];
      mockPlugin.app.workspace.getActiveFile.mockReturnValue(source);
      mockPlugin.app.workspace.activeLeaf = {
        view: { getViewType: () => EMBEDDINGS_VIEW_TYPE },
      };

      (view as any).handleVaultDelete(source);
      (view as any).checkActiveFile();

      expect((view as any).currentFile).toBeNull();
      expect((view as any).currentResults).toEqual([]);
      expect((view as any).lastFileHash).toBe("");
      expect(mockManager.findSimilar).not.toHaveBeenCalled();
      expect(mockPlugin.app.vault.read).not.toHaveBeenCalled();
      expect((view as any).contentEl.textContent).toContain("Open a note or chat");
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

      (view as any).checkActiveFile();

      expect(mockManager.findSimilar).not.toHaveBeenCalled();
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

    it("adds a result to the current chat through the canonical chat method", async () => {
      const resultFile = new TFile({ path: "notes/similar.md", stat: { mtime: Date.now(), size: 100 } });
      const chatView = createMockChatView();
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(resultFile);
      (view as any).currentChatView = chatView;

      await (view as any).addResultToCurrentChat("notes/similar.md");

      expect(chatView.addFileToContext).toHaveBeenCalledWith(resultFile);
    });
  });

  describe("processing completion", () => {
    beforeEach(() => {
      (view as any).setupUI();
      (view as any).isViewVisible = jest.fn().mockReturnValue(true);
    });

    it("refreshes chat results after the vault index finishes", async () => {
      const chatView = createMockChatView({ messages: [{ message_id: "1", content: "Vault context" }] });
      (view as any).currentChatView = chatView;
      const refreshChat = jest.spyOn(view as any, "searchForSimilarFromChat").mockResolvedValue(undefined);

      await (view as any).startProcessing();

      expect(mockManager.resumeProcessing).toHaveBeenCalledTimes(1);
      expect(refreshChat).toHaveBeenCalledWith(chatView);
    });
  });

  describe("config change detection", () => {
    it("generates different config keys for different settings", () => {
      const settings1 = {
        embeddingsEnabled: true,
        embeddingsExclusions: { folders: [] },
      };

      const settings2 = {
        embeddingsEnabled: true,
        embeddingsExclusions: { folders: ["Private"] },
      };

      const key1 = (view as any).getEmbeddingsConfigKey(settings1);
      const key2 = (view as any).getEmbeddingsConfigKey(settings2);

      expect(key1).not.toBe(key2);
    });

    it("generates same config key for same settings", () => {
      const settings = {
        embeddingsEnabled: true,
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
