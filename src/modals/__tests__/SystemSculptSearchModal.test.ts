/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { SystemSculptSearchModal } from "../SystemSculptSearchModal";
import { SearchResponse } from "../../services/search/SystemSculptSearchEngine";

const flush = async (cycles = 2) => {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
};

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
    mode: "smart",
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
  whenIndexReady: jest.fn().mockResolvedValue(undefined),
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
    document.body.innerHTML = "";
    plugin = createMockPlugin();
    modal = new SystemSculptSearchModal(plugin);
  });

  afterEach(() => {
    modal.onClose();
    jest.useRealTimers();
  });

  describe("initialization", () => {
    it("creates the engine lazily from plugin.getSearchEngine()", () => {
      expect(plugin.getSearchEngine).toHaveBeenCalled();
      expect(plugin._testEngine.getEmbeddingsIndicator).not.toHaveBeenCalled();
    });

    it("renders one simple search view without metrics, modes, or footer actions", () => {
      modal.onOpen();

      expect((modal as any).searchInputEl).not.toBeNull();
      expect((modal as any).listEl).not.toBeNull();
      expect(modal.contentEl.querySelector(".ss-search__metrics")).toBeNull();
      expect(modal.contentEl.querySelector(".ss-search__state")).toBeNull();
      expect(modal.contentEl.querySelector("[data-mode]")).toBeNull();
      expect(modal.contentEl.querySelector("[data-sort]")).toBeNull();
      expect((modal as any).footerEl.style.display).toBe("none");
    });

    it("renders recent files on open without warming or checking backends", async () => {
      modal.onOpen();
      await flush();

      expect(plugin._testEngine.getRecent).toHaveBeenCalledWith(25);
      expect(plugin._testEngine.getEmbeddingsIndicator).not.toHaveBeenCalled();
      expect((modal as any).listEl?.textContent).toContain("Recent Note");
    });
  });

  describe("recent preview hydration", () => {
    it("hydrates only visible recent previews after the first paint", async () => {
      plugin = createMockPlugin({
        getRecentPreviews: jest.fn().mockResolvedValue(new Map([["notes/recent.md", "Recent note opening text"]])),
      });
      modal = new SystemSculptSearchModal(plugin);

      modal.onOpen();
      await flush();

      expect((modal as any).listEl?.textContent).toContain("Recent Note");
      expect((modal as any).listEl?.textContent).not.toContain("Recent note opening text");

      jest.advanceTimersByTime(30);
      await flush(3);

      expect(plugin._testEngine.getRecentPreviews).toHaveBeenCalledWith(
        ["notes/recent.md"],
        25,
        expect.any(AbortSignal)
      );
      expect((modal as any).listEl?.textContent).toContain("Recent note opening text");
    });

    it("aborts preview hydration when the user starts searching", async () => {
      let previewSignal: AbortSignal | undefined;
      plugin = createMockPlugin({
        getRecentPreviews: jest.fn((_paths, _limit, signal) => {
          previewSignal = signal;
          return new Promise(() => undefined);
        }),
      });
      modal = new SystemSculptSearchModal(plugin);
      modal.onOpen();
      await flush();

      jest.advanceTimersByTime(30);
      await flush();

      const input = (modal as any).searchInputEl as HTMLInputElement;
      input.value = "test";
      input.dispatchEvent(new Event("input"));

      expect(previewSignal?.aborted).toBe(true);
    });
  });

  describe("search execution", () => {
    it("debounces input and uses one smart search path with cancellation support", () => {
      modal.onOpen();
      const searchInput = (modal as any).searchInputEl as HTMLInputElement;

      searchInput.value = "test";
      searchInput.dispatchEvent(new Event("input"));

      expect(plugin._testEngine.search).not.toHaveBeenCalled();
      jest.advanceTimersByTime(180);

      expect(plugin._testEngine.search).toHaveBeenCalledWith("test", {
        mode: "smart",
        sort: "relevance",
        limit: 80,
        signal: expect.any(AbortSignal),
      });
    });

    it("uses query serials to prevent stale responses from replacing newer results", async () => {
      modal.onOpen();

      let resolveFirst: (val: SearchResponse) => void;
      const firstPromise = new Promise<SearchResponse>((resolve) => {
        resolveFirst = resolve;
      });

      plugin._testEngine.search.mockReturnValueOnce(firstPromise);
      plugin._testEngine.search.mockResolvedValueOnce(
        createMockSearchResponse({
          results: [{ path: "notes/second.md", title: "Second", score: 1, origin: "lexical", updatedAt: Date.now() }],
        })
      );

      void (modal as any).executeSearch("first");
      await (modal as any).executeSearch("second");
      resolveFirst!(createMockSearchResponse());
      await flush();

      const listEl = (modal as any).listEl;
      expect(listEl?.querySelector('[data-path="notes/second.md"]')).not.toBeNull();
      expect(listEl?.querySelector('[data-path="notes/test.md"]')).toBeNull();
    });

    it("refreshes metadata-only results after the content index finishes", async () => {
      const first = createMockSearchResponse({
        results: [{ path: "notes/title-hit.md", title: "Title Hit", score: 0.8, origin: "lexical", updatedAt: Date.now() }],
        stats: {
          ...createMockSearchResponse().stats,
          indexingPending: true,
          metadataOnly: true,
        },
      });
      const second = createMockSearchResponse({
        results: [{ path: "notes/body-hit.md", title: "Body Hit", score: 0.95, origin: "lexical", updatedAt: Date.now() }],
      });
      plugin = createMockPlugin({
        search: jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
        whenIndexReady: jest.fn().mockResolvedValue(undefined),
      });
      modal = new SystemSculptSearchModal(plugin);
      modal.onOpen();

      await (modal as any).executeSearch("body");
      jest.advanceTimersByTime(0);
      await flush(4);

      expect(plugin._testEngine.whenIndexReady).toHaveBeenCalled();
      expect((modal as any).listEl?.querySelector('[data-path="notes/body-hit.md"]')).not.toBeNull();
    });
  });

  describe("result rendering", () => {
    it("renders results without scores or origin badges", async () => {
      modal.onOpen();
      await (modal as any).executeSearch("test");

      const listEl = (modal as any).listEl;
      const item = listEl?.querySelector(".ss-search__item");
      expect(item?.getAttribute("data-path")).toBe("notes/test.md");
      expect(listEl?.querySelector(".ss-search__score")).toBeNull();
      expect(listEl?.querySelector(".ss-search__pill--semantic")).toBeNull();
    });

    it("escapes note content while still highlighting matching terms", async () => {
      modal.onOpen();
      plugin._testEngine.search.mockResolvedValue(
        createMockSearchResponse({
          results: [
            {
              path: "notes/xss.md",
              title: 'Machine <img src=x onerror="alert(1)">',
              excerpt: 'Learning <script>alert("x")</script> guide',
              score: 0.9,
              origin: "lexical",
              updatedAt: Date.now(),
            },
          ],
        })
      );

      await (modal as any).executeSearch("machine learning");

      const listEl = (modal as any).listEl as HTMLElement;
      expect(listEl.querySelector("img")).toBeNull();
      expect(listEl.querySelector("script")).toBeNull();
      expect(listEl.textContent).toContain('<img src=x onerror="alert(1)">');
      expect(listEl.querySelectorAll("mark.ss-hl")).toHaveLength(2);
    });

    it("does not show a missing-preview placeholder for metadata-only recents", async () => {
      modal.onOpen();
      await flush();

      const listEl = (modal as any).listEl;
      expect(listEl?.textContent).toContain("Recent Note");
      expect(listEl?.textContent).not.toContain("No preview available");
      expect(listEl?.querySelector(".ss-search__excerpt")).toBeNull();
    });

    it("shows a simple empty state for empty results", async () => {
      modal.onOpen();
      plugin._testEngine.search.mockResolvedValue(createMockSearchResponse({ results: [] }));

      await (modal as any).executeSearch("nonexistent");

      expect((modal as any).listEl?.querySelector(".ss-search__empty")).not.toBeNull();
    });
  });

  describe("result item interaction", () => {
    it("opens a file on delegated item click", async () => {
      modal.onOpen();
      await (modal as any).executeSearch("test");

      const item = (modal as any).listEl?.querySelector(".ss-search__item") as HTMLElement;
      item.click();

      expect(plugin.app.workspace.openLinkText).toHaveBeenCalledWith("notes/test.md", "");
    });

    it("opens a focused result with Enter", async () => {
      modal.onOpen();
      await (modal as any).executeSearch("test");

      const item = (modal as any).listEl?.querySelector(".ss-search__item") as HTMLElement;
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(plugin.app.workspace.openLinkText).toHaveBeenCalledWith("notes/test.md", "");
    });

    it("moves focus from the input to the first result with ArrowDown", async () => {
      document.body.appendChild((modal as any).modalEl);
      modal.onOpen();
      await (modal as any).executeSearch("test");

      const input = (modal as any).searchInputEl as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

      expect(document.activeElement).toBe((modal as any).listEl?.querySelector(".ss-search__item"));
    });
  });

  describe("formatting helpers", () => {
    it("formats today as 'Updated today'", () => {
      modal.onOpen();
      expect((modal as any).formatUpdated(Date.now() - 1000)).toBe("Updated today");
    });

    it("formats sizes", () => {
      modal.onOpen();
      expect((modal as any).formatSize(500)).toBe("500 B");
      expect((modal as any).formatSize(2048)).toBe("2.0 KB");
      expect((modal as any).formatSize(1500000)).toBe("1.4 MB");
    });
  });
});
