/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { SystemSculptSearchModal } from "../SystemSculptSearchModal";
import { SearchResponse, EmbeddingsIndicator } from "../../services/search/SystemSculptSearchEngine";

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
  getRecent: jest.fn().mockResolvedValue([
    { path: "notes/recent.md", title: "Recent Note", score: 1, origin: "recent" as const, updatedAt: Date.now() },
  ]),
  getEmbeddingsIndicator: jest.fn().mockReturnValue({
    enabled: true,
    ready: true,
    available: true,
    processed: 80,
    total: 100,
  } as EmbeddingsIndicator),
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

    it("defaults mode to 'smart'", () => {
      expect((modal as any).mode).toBe("smart");
    });

    it("defaults sort to 'relevance'", () => {
      expect((modal as any).sort).toBe("relevance");
    });

    it("fetches initial embeddings indicator", () => {
      expect(plugin._testEngine.getEmbeddingsIndicator).toHaveBeenCalled();
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

    it("creates metrics element", () => {
      modal.onOpen();
      expect((modal as any).metricsEl).not.toBeNull();
    });

    it("creates state element", () => {
      modal.onOpen();
      expect((modal as any).stateEl).not.toBeNull();
    });

    it("creates mode buttons", () => {
      modal.onOpen();
      const modeButtons = (modal as any).modeButtons;
      expect(modeButtons.lexical).toBeDefined();
      expect(modeButtons.smart).toBeDefined();
      expect(modeButtons.semantic).toBeDefined();
    });

    it("creates sort buttons", () => {
      modal.onOpen();
      const sortButtons = (modal as any).sortButtons;
      expect(sortButtons.relevance).toBeDefined();
      expect(sortButtons.recency).toBeDefined();
    });

    it("renders recent files on open", async () => {
      modal.onOpen();
      jest.advanceTimersByTime(10);
      await Promise.resolve();
      expect(plugin._testEngine.getRecent).toHaveBeenCalledWith(25);
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

  describe("mode selection", () => {
    it("defaults to 'smart' mode when embeddings available", () => {
      modal.onOpen();
      expect((modal as any).mode).toBe("smart");
      expect((modal as any).modeButtons.smart?.classList.contains("is-active")).toBe(true);
    });

    it("disables semantic button when embeddings unavailable", () => {
      plugin = createMockPlugin({
        getEmbeddingsIndicator: jest.fn().mockReturnValue({
          enabled: true,
          ready: false,
          available: false,
        }),
      });
      modal = new SystemSculptSearchModal(plugin);
      modal.onOpen();

      expect((modal as any).modeButtons.semantic?.disabled).toBe(true);
      expect((modal as any).modeButtons.semantic?.classList.contains("is-disabled")).toBe(true);
    });

    it("disables smart button when embeddings unavailable", () => {
      plugin = createMockPlugin({
        getEmbeddingsIndicator: jest.fn().mockReturnValue({
          enabled: true,
          ready: false,
          available: false,
        }),
      });
      modal = new SystemSculptSearchModal(plugin);
      modal.onOpen();

      expect((modal as any).modeButtons.smart?.disabled).toBe(true);
    });

    it("never disables lexical button", () => {
      plugin = createMockPlugin({
        getEmbeddingsIndicator: jest.fn().mockReturnValue({
          enabled: false,
          ready: false,
          available: false,
        }),
      });
      modal = new SystemSculptSearchModal(plugin);
      modal.onOpen();

      expect((modal as any).modeButtons.lexical?.disabled).toBe(false);
    });

    it("falls back to lexical when embeddings become unavailable", () => {
      modal.onOpen();
      (modal as any).mode = "smart";

      const unavailableIndicator = {
        enabled: false,
        ready: false,
        available: false,
      };
      (modal as any).syncModeAvailability(unavailableIndicator);

      expect((modal as any).mode).toBe("lexical");
    });

    it("changes mode on button click", () => {
      modal.onOpen();
      const lexicalBtn = (modal as any).modeButtons.lexical;

      lexicalBtn?.click();

      expect((modal as any).mode).toBe("lexical");
    });

    it("triggers search on mode change", async () => {
      modal.onOpen();
      (modal as any).currentQuery = "test query";

      const smartBtn = (modal as any).modeButtons.smart;
      smartBtn?.click();

      await Promise.resolve();
      expect(plugin._testEngine.search).toHaveBeenCalled();
    });

    it("updates mode availability after each search", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        embeddings: { enabled: true, ready: false, available: false, processed: 0, total: 100 },
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      expect((modal as any).modeButtons.semantic?.disabled).toBe(true);
    });
  });

  describe("sort toggle", () => {
    it("defaults to relevance sort", () => {
      modal.onOpen();
      expect((modal as any).sort).toBe("relevance");
      expect((modal as any).sortButtons.relevance?.classList.contains("is-active")).toBe(true);
    });

    it("changes sort on button click", () => {
      modal.onOpen();
      const recencyBtn = (modal as any).sortButtons.recency;

      recencyBtn?.click();

      expect((modal as any).sort).toBe("recency");
    });

    it("triggers search on sort change", async () => {
      modal.onOpen();
      (modal as any).currentQuery = "test query";
      plugin._testEngine.search.mockClear();

      const recencyBtn = (modal as any).sortButtons.recency;
      recencyBtn?.click();

      await Promise.resolve();
      expect(plugin._testEngine.search).toHaveBeenCalled();
    });

    it("updates active class on sort buttons", () => {
      modal.onOpen();
      const recencyBtn = (modal as any).sortButtons.recency;

      recencyBtn?.click();

      expect((modal as any).sortButtons.recency?.classList.contains("is-active")).toBe(true);
      expect((modal as any).sortButtons.relevance?.classList.contains("is-active")).toBe(false);
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

    it("passes mode and sort to search engine", async () => {
      modal.onOpen();
      (modal as any).mode = "semantic";
      (modal as any).sort = "recency";

      await (modal as any).executeSearch("test");

      expect(plugin._testEngine.search).toHaveBeenCalledWith("test", {
        mode: "semantic",
        sort: "recency",
        limit: 80,
      });
    });
  });

  describe("state messages", () => {
    it("shows 'Fast – fastest path.' for lexical mode", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, usedEmbeddings: false },
      });
      plugin._testEngine.search.mockResolvedValue(response);

      (modal as any).mode = "lexical";
      await (modal as any).executeSearch("test");

      const stateText = (modal as any).stateTextFor(response);
      expect(stateText).toBe("Fast – fastest path.");
    });

    it("shows smart blend message when embeddings contributed", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, usedEmbeddings: true },
      });
      plugin._testEngine.search.mockResolvedValue(response);

      (modal as any).mode = "smart";
      await (modal as any).executeSearch("test");

      const stateText = (modal as any).stateTextFor(response);
      expect(stateText).toBe("Smart blend: embeddings contributed to these results.");
    });

    it("shows 'Embeddings off in settings' when disabled", () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, usedEmbeddings: false },
        embeddings: { enabled: false, ready: false, available: false, processed: 0, total: 0 },
      });

      (modal as any).mode = "smart";
      const stateText = (modal as any).stateTextFor(response);
      expect(stateText).toBe("Embeddings off in settings – running lexical search only.");
    });

    it("shows 'Embeddings unavailable' with reason when not available", () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, usedEmbeddings: false },
        embeddings: {
          enabled: true,
          ready: true,
          available: false,
          reason: "No vectors generated yet",
          processed: 0,
          total: 100,
        },
      });

      (modal as any).mode = "smart";
      const stateText = (modal as any).stateTextFor(response);
      expect(stateText).toBe("Embeddings unavailable: No vectors generated yet");
    });

    it("shows generic message when embeddings ready but not used", () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, usedEmbeddings: false },
        embeddings: { enabled: true, ready: true, available: true, processed: 80, total: 100 },
      });

      (modal as any).mode = "smart";
      const stateText = (modal as any).stateTextFor(response);
      expect(stateText).toBe("Embeddings ready but not used for this query (short query or no vectors).");
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

    it("renders origin badge", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        results: [
          { path: "notes/semantic.md", title: "Semantic", score: 0.9, origin: "semantic", updatedAt: Date.now() },
        ],
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const badge = (modal as any).listEl?.querySelector(".ss-search__pill--semantic");
      expect(badge).not.toBeNull();
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

  describe("metrics display", () => {
    it("renders totalMs metric", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, totalMs: 42 },
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const metricsEl = (modal as any).metricsEl;
      expect(metricsEl?.textContent).toContain("Total 42 ms");
    });

    it("renders lexMs metric", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, lexMs: 15 },
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const metricsEl = (modal as any).metricsEl;
      expect(metricsEl?.textContent).toContain("Lex 15 ms");
    });

    it("renders semantic metric when present", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, semMs: 30 },
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const metricsEl = (modal as any).metricsEl;
      expect(metricsEl?.textContent).toContain("Semantic 30 ms");
    });

    it("renders indexed count", async () => {
      modal.onOpen();

      const response = createMockSearchResponse({
        stats: { ...createMockSearchResponse().stats, indexedCount: 250 },
      });
      plugin._testEngine.search.mockResolvedValue(response);

      await (modal as any).executeSearch("test");

      const metricsEl = (modal as any).metricsEl;
      expect(metricsEl?.textContent).toContain("250 indexed");
    });
  });

  describe("label formatting", () => {
    it("labelForOrigin returns correct labels", () => {
      modal.onOpen();

      expect((modal as any).labelForOrigin("semantic")).toBe("Semantic");
      expect((modal as any).labelForOrigin("blend")).toBe("Blended");
      expect((modal as any).labelForOrigin("recent")).toBe("Recent");
      expect((modal as any).labelForOrigin("lexical")).toBe("Lexical");
    });

    it("labelForMode returns correct labels", () => {
      modal.onOpen();

      expect((modal as any).labelForMode("lexical")).toBe("Fast");
      expect((modal as any).labelForMode("semantic")).toBe("Semantic first");
      expect((modal as any).labelForMode("smart")).toBe("Smart blend");
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
