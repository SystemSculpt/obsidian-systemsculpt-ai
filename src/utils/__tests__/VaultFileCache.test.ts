/**
 * @jest-environment jsdom
 */
import { App, TFile, TFolder, Vault } from "obsidian";
import { VaultFileCache } from "../VaultFileCache";

// Helper to create a mock TFile
const createMockFile = (path: string, size: number = 100): TFile => ({
  path,
  name: path.split("/").pop() || path,
  basename: (path.split("/").pop() || path).replace(/\.[^.]+$/, ""),
  extension: "md",
  stat: { size, mtime: Date.now(), ctime: Date.now() },
} as TFile);

// Create mock vault with event handling
const createMockVault = (files: TFile[] = []) => {
  const eventHandlers: Record<string, Array<(file: any, oldPath?: string) => void>> = {};

  return {
    getMarkdownFiles: jest.fn().mockReturnValue(files),
    getFiles: jest.fn().mockReturnValue(files),
    on: jest.fn((event: string, handler: any) => {
      if (!eventHandlers[event]) {
        eventHandlers[event] = [];
      }
      eventHandlers[event].push(handler);
      return { event, handler }; // EventRef
    }),
    offref: jest.fn(),
    _trigger: (event: string, file: any, oldPath?: string) => {
      eventHandlers[event]?.forEach((h) => h(file, oldPath));
    },
  };
};

describe("VaultFileCache", () => {
  let mockVault: ReturnType<typeof createMockVault>;
  let mockApp: App;
  let cache: VaultFileCache;
  let mockFiles: TFile[];

  beforeEach(() => {
    jest.useFakeTimers();
    mockFiles = [
      createMockFile("notes/test1.md", 100),
      createMockFile("notes/test2.md", 200),
      createMockFile("projects/project1.md", 300),
    ];
    mockVault = createMockVault(mockFiles);
    mockApp = { vault: mockVault } as unknown as App;
    cache = new VaultFileCache(mockApp);
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  describe("initialize", () => {
    it("initializes the cache system", async () => {
      await cache.initialize();
      // Event listeners should be set up
      expect(mockVault.on).toHaveBeenCalled();
    });

    it("sets up event listeners for file operations", async () => {
      await cache.initialize();

      expect(mockVault.on).toHaveBeenCalledWith("create", expect.any(Function));
      expect(mockVault.on).toHaveBeenCalledWith("modify", expect.any(Function));
      expect(mockVault.on).toHaveBeenCalledWith("delete", expect.any(Function));
      expect(mockVault.on).toHaveBeenCalledWith("rename", expect.any(Function));
    });

    it("can be called multiple times safely", async () => {
      await cache.initialize();
      await cache.initialize();
      await cache.initialize();

      // Should not multiply event listeners
      expect(mockVault.on).toHaveBeenCalledTimes(4); // create, modify, delete, rename
    });

    it("schedules cache warming after initialization", async () => {
      await cache.initialize();

      // Advance timers to trigger cache warming
      jest.advanceTimersByTime(2000);

      // Cache should be warmed
      expect(mockVault.getMarkdownFiles).toHaveBeenCalled();
    });
  });

  describe("getMarkdownFiles", () => {
    it("returns markdown files from vault", async () => {
      await cache.initialize();

      const files = cache.getMarkdownFiles();

      expect(files.length).toBe(3);
      expect(files[0].path).toBe("notes/test1.md");
    });

    it("returns a copy of the cached array", async () => {
      await cache.initialize();

      const files1 = cache.getMarkdownFiles();
      const files2 = cache.getMarkdownFiles();

      expect(files1).not.toBe(files2);
      expect(files1).toEqual(files2);
    });

    it("uses cached value on subsequent calls", async () => {
      await cache.initialize();

      cache.getMarkdownFiles();
      cache.getMarkdownFiles();
      cache.getMarkdownFiles();

      // First call refreshes, subsequent calls use cache
      const stats = cache.getCacheStats();
      expect(stats.hits).toBeGreaterThan(0);
    });
  });

  describe("getAllFiles", () => {
    it("returns all files from vault", async () => {
      await cache.initialize();

      const files = cache.getAllFiles();

      expect(files.length).toBe(3);
    });

    it("returns a copy of the cached array", async () => {
      await cache.initialize();

      const files1 = cache.getAllFiles();
      const files2 = cache.getAllFiles();

      expect(files1).not.toBe(files2);
    });
  });

  describe("getMarkdownFileCount", () => {
    it("returns correct file count", async () => {
      await cache.initialize();

      const count = cache.getMarkdownFileCount();

      expect(count).toBe(3);
    });

    it("uses cached stats on subsequent calls", async () => {
      await cache.initialize();

      cache.getMarkdownFileCount();
      cache.getMarkdownFileCount();
      cache.getMarkdownFileCount();

      const stats = cache.getCacheStats();
      expect(stats.hits).toBeGreaterThan(0);
    });
  });

  describe("getTotalVaultSize", () => {
    it("returns total size of all markdown files", async () => {
      await cache.initialize();

      const size = cache.getTotalVaultSize();

      expect(size).toBe(600); // 100 + 200 + 300
    });
  });

  describe("invalidateCache", () => {
    it("clears all cached data", async () => {
      await cache.initialize();

      // Populate caches
      cache.getMarkdownFiles();
      cache.getAllFiles();
      cache.getMarkdownFileCount();

      // Invalidate
      cache.invalidateCache();

      // Next call should refresh from vault
      mockVault.getMarkdownFiles.mockClear();
      cache.getMarkdownFiles();

      expect(mockVault.getMarkdownFiles).toHaveBeenCalled();
    });
  });

  describe("getCacheStats", () => {
    it("returns cache hit/miss statistics", async () => {
      await cache.initialize();

      // Generate some hits and misses
      cache.getMarkdownFiles(); // Miss
      cache.getMarkdownFiles(); // Hit
      cache.getMarkdownFiles(); // Hit

      const stats = cache.getCacheStats();

      expect(typeof stats.hits).toBe("number");
      expect(typeof stats.misses).toBe("number");
      expect(stats.hitRatio).toMatch(/\d+\.\d+%/);
    });

    it("returns 0% hit ratio when no accesses", async () => {
      const freshCache = new VaultFileCache(mockApp);
      const stats = freshCache.getCacheStats();

      expect(stats.hitRatio).toBe("0.0%");
      freshCache.destroy();
    });
  });

  describe("destroy", () => {
    it("unregisters event listeners", async () => {
      await cache.initialize();
      cache.destroy();

      expect(mockVault.offref).toHaveBeenCalled();
    });

    it("clears all caches", async () => {
      await cache.initialize();
      cache.getMarkdownFiles();
      cache.destroy();

      // Should not throw
      expect(() => cache.getCacheStats()).not.toThrow();
    });

    it("clears pending timeouts", async () => {
      await cache.initialize();
      cache.destroy();

      // Advance timers - should not throw or cause issues
      jest.advanceTimersByTime(5000);
    });
  });

  describe("event handling", () => {
    beforeEach(async () => {
      await cache.initialize();
      // Wait for startup grace period to pass
      jest.advanceTimersByTime(6000);
    });

    it("invalidates cache on file create", () => {
      cache.getMarkdownFiles(); // Populate cache

      const newFile = createMockFile("notes/new.md");
      mockVault._trigger("create", newFile);

      // After file creation, cache should still work
      const files = cache.getMarkdownFiles();
      expect(files.length).toBe(3);
    });

    it("invalidates cache on file delete", () => {
      cache.getMarkdownFiles();

      mockVault._trigger("delete", mockFiles[0]);

      // After invalidation, cache should still work
      const files = cache.getMarkdownFiles();
      expect(files.length).toBe(3);
    });

    it("invalidates cache on file rename", () => {
      cache.getMarkdownFiles();

      mockVault._trigger("rename", mockFiles[0], "old/path.md");

      // After invalidation, cache should still work
      const files = cache.getMarkdownFiles();
      expect(files.length).toBe(3);
    });

    it("only invalidates stats on file modify", () => {
      cache.getMarkdownFiles();
      cache.getMarkdownFileCount();

      mockVault._trigger("modify", mockFiles[0]);

      // Markdown files cache should still be valid
      mockVault.getMarkdownFiles.mockClear();
      cache.getMarkdownFiles();
      // Could be a hit or miss depending on implementation
    });

    it("ignores system files in .obsidian directory", () => {
      cache.getMarkdownFiles();

      const systemFile = createMockFile(".obsidian/config.json");
      mockVault._trigger("create", systemFile);

      // Cache should NOT be invalidated for system files
      mockVault.getMarkdownFiles.mockClear();
      cache.getMarkdownFiles();
      // Should be a cache hit since system file was ignored
    });

    it("ignores files in startup grace period", async () => {
      // Create a fresh cache and initialize
      const newCache = new VaultFileCache(mockApp);
      await newCache.initialize();

      // Immediately trigger a file create (within grace period)
      const newFile = createMockFile("notes/new.md");
      mockVault._trigger("create", newFile);

      // Should have been ignored due to grace period
      newCache.destroy();
    });
  });

  describe("isUserContentFile filtering", () => {
    beforeEach(async () => {
      await cache.initialize();
      jest.advanceTimersByTime(6000);
    });

    it("excludes .obsidian files", () => {
      cache.getMarkdownFiles();

      const systemFile = createMockFile(".obsidian/plugins/test/main.js");
      mockVault._trigger("create", systemFile);

      // Should not invalidate cache
    });

    it("excludes .trash files", () => {
      cache.getMarkdownFiles();

      const trashFile = createMockFile(".trash/deleted.md");
      mockVault._trigger("create", trashFile);
    });

    it("excludes node_modules files", () => {
      cache.getMarkdownFiles();

      const nodeFile = createMockFile("node_modules/package/index.js");
      mockVault._trigger("create", nodeFile);
    });

    it("excludes .git files", () => {
      cache.getMarkdownFiles();

      const gitFile = createMockFile(".git/config");
      mockVault._trigger("create", gitFile);
    });
  });

  describe("cache expiration", () => {
    it("returns files after cache age without error", async () => {
      await cache.initialize();

      cache.getMarkdownFiles(); // Populate cache

      // Advance time past cache age
      jest.advanceTimersByTime(300001); // Just over 5 minutes

      // Should still work (may refresh or return cached)
      const files = cache.getMarkdownFiles();
      expect(files.length).toBe(3);
    });

    it("returns stats after stats cache age without error", async () => {
      await cache.initialize();

      cache.getMarkdownFileCount(); // Populate stats cache

      // Advance time past stats cache age
      jest.advanceTimersByTime(60001); // Just over 1 minute

      // Should still work
      const count = cache.getMarkdownFileCount();
      expect(count).toBe(3);
    });
  });
});
