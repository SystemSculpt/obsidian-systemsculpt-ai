import { SystemSculptSearchEngine } from "../SystemSculptSearchEngine";
import { App, TFile } from "obsidian";

const createMockManager = (overrides: Record<string, any> = {}) => ({
  awaitReady: jest.fn().mockResolvedValue(undefined),
  searchSimilar: jest.fn().mockResolvedValue([]),
  isReady: jest.fn().mockReturnValue(true),
  hasAnyEmbeddings: jest.fn().mockReturnValue(true),
  getStats: jest.fn().mockReturnValue({ total: 100, processed: 80, present: 80, needsProcessing: 20 }),
  ...overrides,
});

const makePlugin = (app: App, options: { embeddingsEnabled?: boolean; manager?: any } = {}) => {
  const manager = options.manager ?? createMockManager();
  return {
    app,
    settings: {
      embeddingsEnabled: options.embeddingsEnabled ?? true,
      embeddingsExclusions: {
        ignoreChatHistory: false,
        respectObsidianExclusions: false,
      },
    },
    vaultFileCache: undefined,
    getOrCreateEmbeddingsManager: jest.fn().mockReturnValue(manager),
  } as any;
};

describe("SystemSculptSearchEngine semantic mode", () => {
  const NOW = Date.now();

  const buildFixture = (pluginOptions?: { embeddingsEnabled?: boolean; manager?: any }) => {
    const app = new App();
    const files = [
      new TFile({ path: "notes/machine-learning.md", stat: { mtime: NOW - 1_000 } }),
      new TFile({ path: "notes/deep-learning.md", stat: { mtime: NOW - 2_000 } }),
      new TFile({ path: "notes/cooking.md", stat: { mtime: NOW - 3_000 } }),
    ];

    const contents: Record<string, string> = {
      "notes/machine-learning.md": "Machine learning is a subset of artificial intelligence.",
      "notes/deep-learning.md": "Deep learning uses neural networks with multiple layers.",
      "notes/cooking.md": "Recipes for delicious meals and cooking tips.",
    };

    app.vault.getFiles.mockReturnValue(files);
    // @ts-expect-error mock injected for tests
    app.vault.cachedRead = jest.fn((file) => Promise.resolve(contents[file.path] ?? ""));
    app.vault.read.mockImplementation(app.vault.cachedRead);
    app.vault.getAbstractFileByPath.mockImplementation((p) => files.find((f) => f.path === p) ?? null);

    const plugin = makePlugin(app, pluginOptions);
    return { app, files, plugin };
  };

  describe("semantic search", () => {
    it("calls embeddingsManager.searchSimilar with query and limit", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockResolvedValue([
          { path: "notes/machine-learning.md", score: 0.95, metadata: { title: "Machine Learning", excerpt: "ML content" } },
        ]),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      await engine.search("artificial intelligence", { mode: "semantic", limit: 10 });

      expect(mockManager.searchSimilar).toHaveBeenCalledWith("artificial intelligence", 10);
    });

    it("returns results with origin='semantic'", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockResolvedValue([
          { path: "notes/machine-learning.md", score: 0.95, metadata: { title: "Machine Learning" } },
        ]),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("neural networks", { mode: "semantic", limit: 10 });

      expect(res.results.length).toBeGreaterThan(0);
      const semanticResult = res.results.find((r) => r.path === "notes/machine-learning.md");
      expect(semanticResult?.origin).toBe("semantic");
    });

    it("times out after 1.5s and returns empty array for semantic", async () => {
      jest.useFakeTimers();

      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockImplementation(() => new Promise(() => {})),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const searchPromise = engine.search("test query", { mode: "semantic", limit: 10 });

      jest.advanceTimersByTime(1600);

      const res = await searchPromise;

      expect(res.stats.usedEmbeddings).toBe(false);

      jest.useRealTimers();
    });

    it("handles manager errors gracefully", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockRejectedValue(new Error("Manager error")),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test query", { mode: "semantic", limit: 10 });

      expect(res.stats.usedEmbeddings).toBe(false);
      expect(res.results).toBeDefined();
    });

    it("awaits manager.awaitReady() before searching", async () => {
      const awaitReadyMock = jest.fn().mockResolvedValue(undefined);
      const searchSimilarMock = jest.fn().mockResolvedValue([]);
      const mockManager = createMockManager({
        awaitReady: awaitReadyMock,
        searchSimilar: searchSimilarMock,
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      await engine.search("test", { mode: "semantic", limit: 10 });

      expect(awaitReadyMock).toHaveBeenCalled();
      const awaitReadyCallOrder = awaitReadyMock.mock.invocationCallOrder[0];
      const searchSimilarCallOrder = searchSimilarMock.mock.invocationCallOrder[0];
      expect(awaitReadyCallOrder).toBeLessThan(searchSimilarCallOrder);
    });
  });

  describe("smart/hybrid search", () => {
    it("combines lexical and semantic results using RRF", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockResolvedValue([
          { path: "notes/deep-learning.md", score: 0.90, metadata: { title: "Deep Learning" } },
          { path: "notes/machine-learning.md", score: 0.85, metadata: { title: "Machine Learning" } },
        ]),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("learning", { mode: "smart", limit: 10 });

      expect(res.stats.usedEmbeddings).toBe(true);
      const blendedResult = res.results.find((r) => r.origin === "blend");
      expect(blendedResult).toBeDefined();
    });

    it("applies blend weights when both lexical and semantic match", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockResolvedValue([
          { path: "notes/machine-learning.md", score: 0.80, metadata: { title: "Machine Learning" } },
        ]),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("machine learning", { mode: "smart", limit: 10 });

      const blendedResult = res.results.find((r) => r.path === "notes/machine-learning.md");
      expect(blendedResult).toBeDefined();
      expect(blendedResult?.lexScore).toBeDefined();
      expect(blendedResult?.semScore).toBeDefined();
    });

    it("falls back to lexical-only when semantic returns empty", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockResolvedValue([]),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("machine", { mode: "smart", limit: 10 });

      expect(res.stats.usedEmbeddings).toBe(false);
      const lexicalResults = res.results.filter((r) => r.origin === "lexical");
      expect(lexicalResults.length).toBeGreaterThan(0);
    });

    it("deduplicates results by path", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockResolvedValue([
          { path: "notes/machine-learning.md", score: 0.90, metadata: { title: "ML" } },
          { path: "notes/deep-learning.md", score: 0.85, metadata: { title: "DL" } },
        ]),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("learning", { mode: "smart", limit: 10 });

      const paths = res.results.map((r) => r.path);
      const uniquePaths = [...new Set(paths)];
      expect(paths.length).toBe(uniquePaths.length);
    });

    it("sorts by score then recency", async () => {
      const mockManager = createMockManager({
        searchSimilar: jest.fn().mockResolvedValue([
          { path: "notes/machine-learning.md", score: 0.70, metadata: { title: "ML" } },
          { path: "notes/deep-learning.md", score: 0.70, metadata: { title: "DL" } },
        ]),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("learning", { mode: "smart", limit: 10 });

      for (let i = 1; i < res.results.length; i++) {
        const prev = res.results[i - 1];
        const curr = res.results[i];
        const scoreDiff = prev.score - curr.score;
        if (Math.abs(scoreDiff) < 0.001) {
          expect(prev.updatedAt).toBeGreaterThanOrEqual(curr.updatedAt || 0);
        } else {
          expect(prev.score).toBeGreaterThanOrEqual(curr.score);
        }
      }
    });
  });

  describe("embeddings status indicator", () => {
    it("returns enabled=false when settings.embeddingsEnabled is false", async () => {
      const { app, plugin } = buildFixture({ embeddingsEnabled: false });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test", { mode: "lexical", limit: 10 });

      expect(res.embeddings.enabled).toBe(false);
      expect(res.embeddings.reason).toContain("disabled");
    });

    it("returns ready=true when manager.isReady() is true", async () => {
      const mockManager = createMockManager({
        isReady: jest.fn().mockReturnValue(true),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test", { mode: "lexical", limit: 10 });

      expect(res.embeddings.ready).toBe(true);
    });

    it("returns ready=false when manager.isReady() is false", async () => {
      const mockManager = createMockManager({
        isReady: jest.fn().mockReturnValue(false),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test", { mode: "lexical", limit: 10 });

      expect(res.embeddings.ready).toBe(false);
    });

    it("returns available=true when hasAnyEmbeddings() is true", async () => {
      const mockManager = createMockManager({
        hasAnyEmbeddings: jest.fn().mockReturnValue(true),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test", { mode: "lexical", limit: 10 });

      expect(res.embeddings.available).toBe(true);
    });

    it("returns available=false when hasAnyEmbeddings() is false", async () => {
      const mockManager = createMockManager({
        hasAnyEmbeddings: jest.fn().mockReturnValue(false),
        getStats: jest.fn().mockReturnValue({ total: 100, processed: 0, present: 0, needsProcessing: 100 }),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test", { mode: "lexical", limit: 10 });

      expect(res.embeddings.available).toBe(false);
    });

    it("returns stats with processed and total counts", async () => {
      const mockManager = createMockManager({
        getStats: jest.fn().mockReturnValue({ total: 200, processed: 150, present: 150, needsProcessing: 50 }),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test", { mode: "lexical", limit: 10 });

      expect(res.embeddings.processed).toBe(150);
      expect(res.embeddings.total).toBe(200);
    });

    it("handles manager errors and returns reason", async () => {
      const { app } = buildFixture();
      const plugin = {
        app,
        settings: { embeddingsEnabled: true, embeddingsExclusions: {} },
        vaultFileCache: undefined,
        getOrCreateEmbeddingsManager: jest.fn().mockImplementation(() => {
          throw new Error("Manager initialization failed");
        }),
      } as any;
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("test", { mode: "lexical", limit: 10 });

      expect(res.embeddings.ready).toBe(false);
      expect(res.embeddings.available).toBe(false);
      expect(res.embeddings.reason).toContain("Manager initialization failed");
    });
  });

  describe("empty query handling", () => {
    it("returns recent files with origin='recent' for empty query", async () => {
      const { app, plugin } = buildFixture();
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("", { mode: "smart", limit: 10 });

      expect(res.results.length).toBeGreaterThan(0);
      expect(res.results.every((r) => r.origin === "recent")).toBe(true);
    });

    it("limits to specified limit for empty query", async () => {
      const { app, plugin } = buildFixture();
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("   ", { mode: "smart", limit: 2 });

      expect(res.results.length).toBeLessThanOrEqual(2);
    });

    it("does not use embeddings for empty query", async () => {
      const mockManager = createMockManager();
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("", { mode: "smart", limit: 10 });

      expect(res.stats.usedEmbeddings).toBe(false);
      expect(mockManager.searchSimilar).not.toHaveBeenCalled();
    });

    it("returns files sorted by recency for empty query", async () => {
      const { app, plugin } = buildFixture();
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("", { mode: "smart", limit: 10 });

      for (let i = 1; i < res.results.length; i++) {
        expect(res.results[i - 1].updatedAt).toBeGreaterThanOrEqual(res.results[i].updatedAt || 0);
      }
    });
  });

  describe("mode fallback behavior", () => {
    it("uses lexical results when semantic mode requested but embeddings unavailable", async () => {
      const mockManager = createMockManager({
        hasAnyEmbeddings: jest.fn().mockReturnValue(false),
        isReady: jest.fn().mockReturnValue(false),
      });
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("machine", { mode: "semantic", limit: 10 });

      expect(res.stats.usedEmbeddings).toBe(false);
      expect(res.results.length).toBeGreaterThan(0);
    });

    it("skips semantic search in lexical mode even when embeddings available", async () => {
      const mockManager = createMockManager();
      const { app, plugin } = buildFixture({ manager: mockManager });
      const engine = new SystemSculptSearchEngine(app as any, plugin);

      const res = await engine.search("machine", { mode: "lexical", limit: 10 });

      expect(mockManager.searchSimilar).not.toHaveBeenCalled();
      expect(res.stats.usedEmbeddings).toBe(false);
    });
  });
});
