/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { SystemSculptSearchModal } from "../SystemSculptSearchModal";
import { SearchResponse } from "../../services/search/SystemSculptSearchEngine";

const createMockSearchResponse = (overrides: Partial<SearchResponse> = {}): SearchResponse => ({
  results: [
    {
      path: "notes/test.md",
      title: "Test Note",
      excerpt: "This is a test excerpt",
      score: 0.85,
      origin: "lexical",
      updatedAt: Date.now() - 1000,
      size: 1024,
    },
  ],
  stats: {
    totalMs: 25,
    lexMs: 20,
    semMs: 0,
    indexMs: 5,
    indexedCount: 100,
    inspectedCount: 50,
    mode: "lexical",
    usedEmbeddings: false,
  },
  embeddings: {
    enabled: true,
    ready: true,
    available: true,
    processed: 80,
    total: 100,
  },
  ...overrides,
});

const createMockEngine = (overrides: Record<string, any> = {}) => ({
  search: jest.fn().mockResolvedValue(createMockSearchResponse()),
  warmIndex: jest.fn().mockResolvedValue(undefined),
  getRecentPreviews: jest.fn().mockResolvedValue(new Map()),
  getRecent: jest.fn().mockResolvedValue([
    { path: "notes/recent.md", title: "Recent Note", score: 1, origin: "recent" as const, updatedAt: Date.now() },
  ]),
  getEmbeddingsIndicator: jest.fn().mockReturnValue({
    enabled: true,
    ready: true,
    available: true,
    processed: 80,
    total: 100,
  }),
  ...overrides,
});

const createMockPlugin = (engineOverrides: Record<string, any> = {}) => {
  const engine = createMockEngine(engineOverrides);
  const app = new App();
  (app.workspace as any).openLinkText = jest.fn().mockResolvedValue(undefined);
  return {
    app,
    getSearchEngine: jest.fn().mockReturnValue(engine),
    _testEngine: engine,
  } as any;
};

describe("SystemSculptSearchModal", () => {
  let plugin: any;
  let modal: SystemSculptSearchModal;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    plugin = createMockPlugin();
    modal = new SystemSculptSearchModal(plugin);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("initialization", () => {
    it("creates engine from plugin.getSearchEngine()", () => {
      expect(plugin.getSearchEngine).toHaveBeenCalled();
    });

    it("does not check backend readiness during construction", () => {
      expect(plugin._testEngine.getEmbeddingsIndicator).not.toHaveBeenCalled();
    });
  });

  describe("onOpen", () => {
    it("creates search input element", () => {
      modal.onOpen();
      expect((modal as any).searchInputEl).not.toBeNull();
    });

    it("creates list element for results", () => {
      modal.onOpen();
      expect((modal as any).listEl).not.toBeNull();
    });

    it("does not create metrics chrome", () => {
      modal.onOpen();
      expect(modal.contentEl.querySelector(".ss-search__metrics")).toBeNull();
    });

    it("does not create backend state chrome", () => {
      modal.onOpen();
      expect(modal.contentEl.querySelector(".ss-search__state")).toBeNull();
    });

    it("does not render mode or sort controls", () => {
      modal.onOpen();
      expect(modal.contentEl.querySelector("[data-mode]")).toBeNull();
      expect(modal.contentEl.querySelector("[data-sort]")).toBeNull();
    });

    it("renders recent files on open", async () => {
      modal.onOpen();
      jest.advanceTimersByTime(10);
      await Promise.resolve();
      expect(plugin._testEngine.getRecent).toHaveBeenCalledWith(25);
    });

    it("does not warm the content index on open", () => {
      modal.onOpen();
      expect(plugin._testEngine.warmIndex).not.toHaveBeenCalled();
    });

    it("does not check backend readiness on open", () => {
      modal.onOpen();
      expect(plugin._testEngine.getEmbeddingsIndicator).not.toHaveBeenCalled();
    });

    it("hydrates only visible recent previews after the initial render", async () => {
      plugin = createMockPlugin({
        getRecentPreviews: jest.fn().mockResolvedValue(new Map([["notes/recent.md", "Recent note opening text"]])),
      });
      modal = new SystemSculptSearchModal(plugin);

      modal.onOpen();
      await Promise.resolve();

      expect((modal as any).listEl?.textContent).toContain("Recent Note");
      expect((modal as any).listEl?.textContent).not.toContain("Recent note opening text");

      jest.runOnlyPendingTimers();
      await Promise.resolve();
      await Promise.resolve();

      expect(plugin._testEngine.getRecentPreviews).toHaveBeenCalledWith(["notes/recent.md"], 25);
      expect((modal as any).listEl?.textContent).toContain("Recent note opening text");
      expect(plugin._testEngine.warmIndex).not.toHaveBeenCalled();
    });
  });

  describe("onClose", () => {
    it("clears debounce handle", () => {
      modal.onOpen();
      (modal as any).debounceHandle = 123;
      modal.onClose();
      expect((modal as any).debounceHandle).toBeNull();
    });
  });

  describe("search execution", () => {
    it("debounces search input by 180ms", () => {
      modal.onOpen();
      const searchInput = (modal as any).searchInputEl;

      searchInput.value = "test";
      searchInput.dispatchEvent(new Event("input"));

      expect(plugin._testEngine.search).not.toHaveBeenCalled();

      jest.advanceTimersByTime(180);

      expect(plugin._testEngine.search).toHaveBeenCalledWith("test", expect.any(Object));
    });

    it("clears previous debounce on new input", () => {
      modal.onOpen();
      const searchInput = (modal as any).searchInputEl;

      searchInput.value = "first";
      searchInput.dispatchEvent(new Event("input"));

      jest.advanceTimersByTime(100);

      searchInput.value = "second";
      searchInput.dispatchEvent(new Event("input"));

      jest.advanceTimersByTime(180);

      expect(plugin._testEngine.search).toHaveBeenCalledTimes(1);
      expect(plugin._testEngine.search).toHaveBeenCalledWith("second", expect.any(Object));
    });

    it("uses query serial to prevent race conditions", async () => {
      modal.onOpen();

      let resolveFirst: (val: SearchResponse) => void;
      const firstPromise = new Promise<SearchResponse>((r) => {
        resolveFirst = r;
      });

      plugin._testEngine.search.mockReturnValueOnce(firstPromise);
      plugin._testEngine.search.mockResolvedValueOnce(
        createMockSearchResponse({
          results: [{ path: "notes/second.md", title: "Second", score: 1, origin: "lexical", updatedAt: Date.now() }],
        })
      );

      (modal as any).executeSearch("first");
      (modal as any).executeSearch("second");
      await Promise.resolve();

      resolveFirst!(createMockSearchResponse());
      await Promise.resolve();

      const listEl = (modal as any).listEl;
      expect(listEl?.querySelector('[data-path="notes/second.md"]')).not.toBeNull();
    });

    it("renders recents for empty query", async () => {
      modal.onOpen();
      await (modal as any).executeSearch("");

      expect(plugin._testEngine.getRecent).toHaveBeenCalled();
    });

    it("uses one adaptive search path", async () => {
      modal.onOpen();

      await (modal as any).executeSearch("test");

      expect(plugin._testEngine.search).toHaveBeenCalledWith("test", {
        mode: "smart",
        sort: "relevance",
        limit: 80,
      });
    });
  });

  describe("result rendering", () => {
    it("renders results with title and path", async () => {
      modal.onOpen();

      const response = createMockSearchResponse();
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const listEl = (modal as any).listEl;
      const item = listEl?.querySelector(".ss-search__item");
      expect(item?.getAttribute("data-path")).toBe("notes/test.md");
    });

    it("does not render origin badges", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        results: [
          { path: "notes/semantic.md", title: "Semantic", score: 0.9, origin: "semantic", updatedAt: Date.now() },
        ],
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const badge = (modal as any).listEl?.querySelector(".ss-search__pill--semantic");
      expect(badge).toBeNull();
    });

    it("renders score as percentage", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        results: [{ path: "notes/test.md", title: "Test", score: 0.857, origin: "lexical", updatedAt: Date.now() }],
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const scoreEl = (modal as any).listEl?.querySelector(".ss-search__score");
      expect(scoreEl?.textContent).toBe("86%");
    });

    it("does not show a missing-preview placeholder for metadata-only recents", async () => {
      modal.onOpen();
      await Promise.resolve();
      await Promise.resolve();

      const listEl = (modal as any).listEl;
      expect(listEl?.textContent).toContain("Recent Note");
      expect(listEl?.textContent).not.toContain("No preview available");
      expect(listEl?.querySelector(".ss-search__excerpt")).toBeNull();
    });

    it("shows 'No matches yet' for empty results", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({ results: [] });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("nonexistent");

      const emptyEl = (modal as any).listEl?.querySelector(".ss-search__empty");
      expect(emptyEl).not.toBeNull();
    });

    it("highlights query terms in title using mark elements", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        results: [
          { path: "notes/test.md", title: "Machine Learning Guide", score: 0.9, origin: "lexical", updatedAt: Date.now() },
        ],
      });
      plugin._testEngine.search.mockResolvedValue(response);

      (modal as any).currentQuery = "machine";
      await (modal as any).executeSearch("machine");

      const titleEl = (modal as any).listEl?.querySelector(".ss-search__title");
      const markEl = titleEl?.querySelector("mark.ss-hl");
      expect(markEl).not.toBeNull();
      expect(markEl?.textContent).toBe("Machine");
    });

    it("highlights multiple query terms", async () => {
      modal.onOpen();
      const highlightedText = (modal as any).getHighlightedText("Machine Learning Guide", "machine guide");
      const container = document.createElement("div");
      container.insertAdjacentHTML("beforeend", highlightedText);
      const marks = container.querySelectorAll("mark.ss-hl");
      expect(marks.length).toBe(2);
    });

    it("returns original text when no query matches", () => {
      modal.onOpen();
      const text = "Machine Learning Guide";
      const result = (modal as any).getHighlightedText(text, "xyz");
      expect(result).toBe(text);
    });
  });

  describe("date formatting", () => {
    it("formats today as 'Updated today'", () => {
      modal.onOpen();
      const now = Date.now();
      expect((modal as any).formatUpdated(now - 1000)).toBe("Updated today");
    });

    it("formats recent days as 'Xd ago'", () => {
      modal.onOpen();
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      expect((modal as any).formatUpdated(threeDaysAgo)).toBe("3d ago");
    });

    it("formats old dates as locale date string", () => {
      modal.onOpen();
      const oldDate = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const result = (modal as any).formatUpdated(oldDate);
      expect(result).toMatch(/\d/);
    });

    it("returns 'No date' for undefined", () => {
      modal.onOpen();
      expect((modal as any).formatUpdated(undefined)).toBe("No date");
    });
  });

  describe("size formatting", () => {
    it("formats bytes", () => {
      modal.onOpen();
      expect((modal as any).formatSize(500)).toBe("500 B");
    });

    it("formats kilobytes", () => {
      modal.onOpen();
      expect((modal as any).formatSize(2048)).toBe("2.0 KB");
    });

    it("formats megabytes", () => {
      modal.onOpen();
      expect((modal as any).formatSize(1500000)).toBe("1.4 MB");
    });
  });

  describe("copy results", () => {
    beforeEach(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: jest.fn().mockResolvedValue(undefined),
        },
        writable: true,
      });
    });

    it("copies paths to clipboard", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        results: [
          { path: "notes/one.md", title: "One", score: 1, origin: "lexical", updatedAt: Date.now() },
          { path: "notes/two.md", title: "Two", score: 0.9, origin: "lexical", updatedAt: Date.now() },
        ],
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");
      await (modal as any).copyResults();

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("notes/one.md\nnotes/two.md");
    });

    it("handles empty results list", async () => {
      modal.onOpen();
      (modal as any).listEl!.textContent = "";

      await expect((modal as any).copyResults()).resolves.not.toThrow();
    });
  });

  describe("drag and drop", () => {
    it("makes results draggable", async () => {
      modal.onOpen();

      const response = createMockSearchResponse();
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      expect((modal as any).listEl?.classList.contains("scs-draggable")).toBe(true);
    });
  });

  describe("result item interaction", () => {
    it("opens file on item click", async () => {
      modal.onOpen();

      const response = createMockSearchResponse();
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const item = (modal as any).listEl?.querySelector(".ss-search__item");
      item?.click();

      expect(plugin.app.workspace.openLinkText).toHaveBeenCalledWith("notes/test.md", "");
    });
  });
});
