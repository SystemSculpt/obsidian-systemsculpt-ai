/**
 * @jest-environment jsdom
 */
import { MemoryProfiler, MemorySnapshot, ComponentMemory } from "../MemoryProfiler";

// Mock embeddings constant
jest.mock("../../constants/embeddings", () => ({
  DEFAULT_EMBEDDING_DIMENSION: 1536,
}));

// Mock WebGL and Canvas contexts that don't exist fully in jsdom
(global as any).WebGLRenderingContext = class WebGLRenderingContext {};
(global as any).WebGL2RenderingContext = class WebGL2RenderingContext {};
(global as any).CanvasRenderingContext2D = class CanvasRenderingContext2D {};

describe("MemoryProfiler", () => {
  let profiler: MemoryProfiler;

  beforeEach(() => {
    jest.clearAllMocks();
    MemoryProfiler.clearInstance();
    profiler = MemoryProfiler.getInstance();
  });

  afterEach(() => {
    MemoryProfiler.clearInstance();
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = MemoryProfiler.getInstance();
      const instance2 = MemoryProfiler.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("clearInstance", () => {
    it("clears the singleton", () => {
      const instance1 = MemoryProfiler.getInstance();
      MemoryProfiler.clearInstance();
      const instance2 = MemoryProfiler.getInstance();

      expect(instance1).not.toBe(instance2);
    });

    it("clears snapshots", () => {
      const instance = MemoryProfiler.getInstance();
      (instance as any).snapshots.push({ test: "data" });

      MemoryProfiler.clearInstance();

      const newInstance = MemoryProfiler.getInstance();
      expect((newInstance as any).snapshots.length).toBe(0);
    });
  });

  describe("takeSnapshot", () => {
    it("returns a snapshot object", async () => {
      const snapshot = await profiler.takeSnapshot();

      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.heapUsed).toBeDefined();
      expect(snapshot.components).toBeDefined();
      expect(snapshot.summary).toBeDefined();
    });

    it("stores snapshot in history", async () => {
      await profiler.takeSnapshot();

      expect((profiler as any).snapshots.length).toBe(1);
    });

    it("analyzes provided components", async () => {
      const components = {
        TestComponent: { data: "test data" },
      };

      const snapshot = await profiler.takeSnapshot(components);

      expect(snapshot.components.length).toBeGreaterThan(0);
    });

    it("includes summary in snapshot", async () => {
      const snapshot = await profiler.takeSnapshot();

      expect(snapshot.summary).toContain("MEMORY BREAKDOWN");
    });
  });

  describe("analyzeComponent", () => {
    it("analyzes OramaSearchEngine component", () => {
      const mockComponent = {
        documentCache: new Map([["key1", { doc: "data" }]]),
        embeddingCache: new Map([["key2", [1, 2, 3, 4, 5]]]),
        db: { data: { docs: new Map() } },
      };

      const result = (profiler as any).analyzeComponent("OramaSearchEngine", mockComponent);

      expect(result.name).toBe("OramaSearchEngine");
      expect(result.size).toBeGreaterThan(0);
      expect(result.details.documentCache).toBeDefined();
    });

    it("analyzes EmbeddingsManager component", () => {
      const mockComponent = {
        data: { embeddings: [] },
        indexOps: { cache: new Map() },
        retriever: { index: {} },
      };

      const result = (profiler as any).analyzeComponent("EmbeddingsManager", mockComponent);

      expect(result.name).toBe("EmbeddingsManager");
      expect(result.size).toBeGreaterThan(0);
    });

    it("analyzes StorageAdapter component", () => {
      const mockComponent = {
        memoryCache: new Map([["file1", { content: "data" }]]),
      };

      const result = (profiler as any).analyzeComponent("StorageAdapter", mockComponent);

      expect(result.name).toBe("StorageAdapter");
      expect(result.details.memoryCache).toBeDefined();
    });

    it("analyzes generic objects", () => {
      const mockComponent = { foo: "bar", num: 42 };

      const result = (profiler as any).analyzeComponent("GenericComponent", mockComponent);

      expect(result.name).toBe("GenericComponent");
      expect(result.size).toBeGreaterThan(0);
    });
  });

  describe("estimateMapSize", () => {
    it("estimates size of empty Map", () => {
      const map = new Map();

      const size = (profiler as any).estimateMapSize(map);

      expect(size).toBe(0);
    });

    it("estimates size of Map with data", () => {
      const map = new Map([
        ["key1", { value: "test" }],
        ["key2", { value: "test2" }],
      ]);

      const size = (profiler as any).estimateMapSize(map);

      expect(size).toBeGreaterThan(0);
    });
  });

  describe("estimateEmbeddingCacheSize", () => {
    it("estimates embedding cache size", () => {
      const cache = new Map([
        ["doc1", [1, 2, 3, 4, 5]],
        ["doc2", [6, 7, 8, 9, 10]],
      ]);

      const size = (profiler as any).estimateEmbeddingCacheSize(cache);

      // Each key is estimated at key.length * 2 bytes
      // Each embedding is array.length * 8 bytes
      expect(size).toBeGreaterThan(0);
    });
  });

  describe("estimateLRUCacheSize", () => {
    it("returns 0 for null cache", () => {
      const size = (profiler as any).estimateLRUCacheSize(null);

      expect(size).toBe(0);
    });

    it("returns 0 for cache without size method", () => {
      const size = (profiler as any).estimateLRUCacheSize({});

      expect(size).toBe(0);
    });

    it("estimates LRU cache size", () => {
      const mockCache = {
        size: () => 10,
      };

      const size = (profiler as any).estimateLRUCacheSize(mockCache);

      expect(size).toBeGreaterThan(0);
    });
  });

  describe("estimateObjectSize", () => {
    it("estimates string size", () => {
      const size = (profiler as any).estimateObjectSize("test string");

      expect(size).toBe(22); // 11 chars * 2 bytes
    });

    it("estimates number size", () => {
      const size = (profiler as any).estimateObjectSize(42);

      expect(size).toBe(8);
    });

    it("estimates boolean size", () => {
      const size = (profiler as any).estimateObjectSize(true);

      expect(size).toBe(4);
    });

    it("handles arrays", () => {
      const size = (profiler as any).estimateObjectSize([1, 2, 3]);

      expect(size).toBeGreaterThan(0);
    });

    it("handles Maps", () => {
      const size = (profiler as any).estimateObjectSize(new Map([["a", 1]]));

      expect(size).toBeGreaterThan(0);
    });

    it("handles Sets", () => {
      const size = (profiler as any).estimateObjectSize(new Set([1, 2, 3]));

      expect(size).toBeGreaterThan(0);
    });

    it("respects max depth", () => {
      const deepObject = { a: { b: { c: { d: { e: { f: "deep" } } } } } };

      const size = (profiler as any).estimateObjectSize(deepObject, 2, 0);

      expect(size).toBeGreaterThan(0);
    });
  });

  describe("deepAnalyzeOramaDB", () => {
    it("returns empty object for null db", () => {
      const analysis = (profiler as any).deepAnalyzeOramaDB(null);

      expect(analysis).toEqual({});
    });

    it("analyzes db data property", () => {
      const db = {
        data: {
          docs: new Map([["doc1", { content: "test" }]]),
        },
      };

      const analysis = (profiler as any).deepAnalyzeOramaDB(db);

      expect(analysis["orama.data"]).toBeDefined();
    });

    it("analyzes db index property", () => {
      const db = {
        index: { tokens: ["a", "b", "c"] },
      };

      const analysis = (profiler as any).deepAnalyzeOramaDB(db);

      expect(analysis["orama.index"]).toBeDefined();
    });
  });

  describe("deepAnalyzeObject", () => {
    it("handles strings", () => {
      const size = (profiler as any).deepAnalyzeObject("test");

      expect(size).toBe(8); // 4 chars * 2 bytes
    });

    it("handles numbers", () => {
      const size = (profiler as any).deepAnalyzeObject(42);

      expect(size).toBe(8);
    });

    it("handles booleans", () => {
      const size = (profiler as any).deepAnalyzeObject(true);

      expect(size).toBe(4);
    });

    it("handles Float32Array", () => {
      const arr = new Float32Array([1, 2, 3, 4]);

      const size = (profiler as any).deepAnalyzeObject(arr);

      expect(size).toBe(16); // 4 floats * 4 bytes
    });

    it("handles ArrayBuffer", () => {
      const buffer = new ArrayBuffer(100);

      const size = (profiler as any).deepAnalyzeObject(buffer);

      expect(size).toBe(100);
    });

    it("handles circular references via WeakSet", () => {
      const obj: any = { a: 1 };
      obj.self = obj;

      // Should not throw
      const size = (profiler as any).deepAnalyzeObject(obj);

      expect(size).toBeGreaterThan(0);
    });
  });

  describe("deepAnalyzeMap", () => {
    it("analyzes Map entries", () => {
      const map = new Map([
        ["key1", "value1"],
        ["key2", "value2"],
      ]);

      const size = (profiler as any).deepAnalyzeMap(map);

      expect(size).toBeGreaterThan(50); // At least Map overhead
    });
  });

  describe("deepAnalyzeSet", () => {
    it("analyzes Set entries", () => {
      const set = new Set(["a", "b", "c"]);

      const size = (profiler as any).deepAnalyzeSet(set);

      expect(size).toBeGreaterThan(50); // At least Set overhead
    });
  });

  describe("deepAnalyzeArray", () => {
    it("analyzes numeric arrays efficiently", () => {
      const arr = [1, 2, 3, 4, 5];

      const size = (profiler as any).deepAnalyzeArray(arr);

      expect(size).toBe(24 + 5 * 8); // 24 overhead + 5 numbers * 8 bytes
    });

    it("analyzes object arrays", () => {
      const arr = [{ a: 1 }, { b: 2 }];

      const size = (profiler as any).deepAnalyzeArray(arr);

      expect(size).toBeGreaterThan(24);
    });
  });

  describe("getAllProperties", () => {
    it("gets enumerable properties", () => {
      const obj = { a: 1, b: 2 };

      const props = (profiler as any).getAllProperties(obj);

      expect(props).toContain("a");
      expect(props).toContain("b");
    });

    it("handles objects that throw on getOwnPropertyNames", () => {
      const obj = { a: 1 };

      // Should not throw
      const props = (profiler as any).getAllProperties(obj);

      expect(Array.isArray(props)).toBe(true);
    });
  });

  describe("estimateStringSize", () => {
    it("estimates UTF-16 string size", () => {
      const size = (profiler as any).estimateStringSize("hello");

      expect(size).toBe(10); // 5 chars * 2 bytes
    });

    it("handles empty string", () => {
      const size = (profiler as any).estimateStringSize("");

      expect(size).toBe(0);
    });
  });

  describe("createSummary", () => {
    it("creates formatted summary", () => {
      const components: ComponentMemory[] = [
        { name: "Test", size: 1024 * 1024, details: {} },
      ];

      const summary = (profiler as any).createSummary(2 * 1024 * 1024, components, 1024 * 1024);

      expect(summary).toContain("MEMORY BREAKDOWN");
      expect(summary).toContain("Test");
      expect(summary).toContain("1.0MB");
    });

    it("formats different size units", () => {
      const components: ComponentMemory[] = [
        { name: "KB", size: 1024, details: {} },
        { name: "B", size: 100, details: {} },
      ];

      const summary = (profiler as any).createSummary(2048, components, 0);

      expect(summary).toContain("KB");
    });
  });

  describe("getReport", () => {
    it("returns message when no snapshots", () => {
      const report = profiler.getReport();

      expect(report).toBe("No memory snapshots taken");
    });

    it("returns latest snapshot summary", async () => {
      await profiler.takeSnapshot();

      const report = profiler.getReport();

      expect(report).toContain("MEMORY BREAKDOWN");
    });
  });

  describe("clear", () => {
    it("clears all snapshots", async () => {
      await profiler.takeSnapshot();
      await profiler.takeSnapshot();

      profiler.clear();

      expect((profiler as any).snapshots.length).toBe(0);
    });
  });

  describe("isProblematicObject", () => {
    it("returns false for null", () => {
      const result = (profiler as any).isProblematicObject(null);

      expect(result).toBe(false);
    });

    it("returns true for DOM nodes", () => {
      const div = document.createElement("div");

      const result = (profiler as any).isProblematicObject(div);

      expect(result).toBe(true);
    });

    it("returns true for canvas elements", () => {
      const canvas = document.createElement("canvas");

      const result = (profiler as any).isProblematicObject(canvas);

      expect(result).toBe(true);
    });

    it("returns false for plain objects", () => {
      const obj = { a: 1, b: 2 };

      const result = (profiler as any).isProblematicObject(obj);

      expect(result).toBe(false);
    });
  });

  describe("isProblematicProperty", () => {
    it("returns true for parent property", () => {
      const result = (profiler as any).isProblematicProperty("parent");

      expect(result).toBe(true);
    });

    it("returns true for window property", () => {
      const result = (profiler as any).isProblematicProperty("window");

      expect(result).toBe(true);
    });

    it("returns false for normal properties", () => {
      const result = (profiler as any).isProblematicProperty("data");

      expect(result).toBe(false);
    });
  });

  describe("analyzeGlobalScope", () => {
    it("returns array of components", () => {
      const components = (profiler as any).analyzeGlobalScope();

      expect(Array.isArray(components)).toBe(true);
    });
  });

  describe("analyzePlugin", () => {
    it("analyzes plugin with embeddings manager", () => {
      const plugin = {
        embeddingsManager: { data: {} },
        searchEngine: { index: {} },
      };

      const result = (profiler as any).analyzePlugin("test-plugin", plugin);

      expect(result.name).toBe("Plugin.test-plugin");
      expect(result.details.embeddingsManager).toBeDefined();
    });
  });

  describe("analyzeVault", () => {
    it("analyzes vault caches", () => {
      const vault = {
        fileCache: { cached: true },
        otherCache: { data: [] },
      };

      const size = (profiler as any).analyzeVault(vault);

      expect(size).toBeGreaterThan(0);
    });
  });

  describe("analyzeWindowProperties", () => {
    it("returns array of components", () => {
      const components = (profiler as any).analyzeWindowProperties();

      expect(Array.isArray(components)).toBe(true);
    });
  });
});
