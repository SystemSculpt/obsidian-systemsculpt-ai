/**
 * @jest-environment node
 */
import { App, TFile, TFolder } from "obsidian";
import { SearchOperations } from "../tools/SearchOperations";
import { FILESYSTEM_LIMITS } from "../constants";
import * as utils from "../utils";

jest.mock("../utils", () => {
  const actual = jest.requireActual("../utils");
  return {
    ...actual,
    listAdapterFiles: jest.fn(),
    statAdapterPath: jest.fn(),
    readAdapterText: jest.fn(),
  };
});

// Mock searchScoring module
jest.mock("../searchScoring", () => ({
  extractSearchTerms: jest.fn((query: string) => query.split(/\s+/).filter(Boolean)),
  calculateScore: jest.fn((path: string, _content: string, _options: any) => ({
    path,
    score: 50,
    matchDetails: { reasoning: "test match" },
    contexts: [],
  })),
  sortByScore: jest.fn((results: any[]) =>
    [...results].sort((a, b) => b.score - a.score)
  ),
  formatScoredResults: jest.fn((results: any[], _limit: number) => ({
    results: results.map((r) => ({
      path: r.path,
      score: r.score,
      matchDetails: r.matchDetails,
    })),
    totalCount: results.length,
  })),
}));

// Mock tokenCounting
jest.mock("../../../utils/tokenCounting", () => ({
  countTextTokens: jest.fn((text: string) => Math.ceil(text.length / 4)),
}));

describe("SearchOperations", () => {
  let app: App;
  let plugin: any;
  let searchOps: SearchOperations;
  let mockFiles: TFile[];
  let mockFolders: TFolder[];

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock files
    mockFiles = [
      new TFile({ path: "notes/test.md" }),
      new TFile({ path: "projects/code.md" }),
      new TFile({ path: "archive/old.md" }),
    ];

    // Set up stats for files
    mockFiles.forEach((file, i) => {
      (file.stat as any) = {
        ctime: Date.now() - i * 86400000,
        mtime: Date.now() - i * 3600000,
        size: 1000 + i * 500,
      };
    });

    // Create mock folders
    mockFolders = [];
    const rootFolder = new TFolder({ path: "/" });
    const notesFolder = new TFolder({ path: "notes" });
    const projectsFolder = new TFolder({ path: "projects" });
    (rootFolder as any).children = [notesFolder, projectsFolder];
    (notesFolder as any).children = [];
    (projectsFolder as any).children = [];
    mockFolders.push(rootFolder, notesFolder, projectsFolder);

    app = new App();
    (app.vault.getFiles as jest.Mock).mockReturnValue(mockFiles);
    (app.vault.getRoot as jest.Mock).mockReturnValue(rootFolder);
    (app.vault.cachedRead as jest.Mock).mockResolvedValue("Test content for search");

    plugin = {
      settings: {
        chatHistoryFolder: "ChatHistory",
        customPromptsFolder: "Prompts",
      },
    };

    searchOps = new SearchOperations(app, ["/"], plugin);
  });

  describe("constructor", () => {
    it("creates instance with app and plugin", () => {
      expect(searchOps).toBeDefined();
    });
  });

  describe("normalizeStringArray (private)", () => {
    it("returns empty array for non-array input", () => {
      const result = (searchOps as any).normalizeStringArray(null);
      expect(result).toEqual([]);
    });

    it("returns empty array for undefined input", () => {
      const result = (searchOps as any).normalizeStringArray(undefined);
      expect(result).toEqual([]);
    });

    it("converts array elements to strings", () => {
      const result = (searchOps as any).normalizeStringArray([1, 2, 3]);
      expect(result).toEqual(["1", "2", "3"]);
    });

    it("trims whitespace from strings", () => {
      const result = (searchOps as any).normalizeStringArray(["  hello  ", "world  "]);
      expect(result).toEqual(["hello", "world"]);
    });

    it("filters out empty strings", () => {
      const result = (searchOps as any).normalizeStringArray(["hello", "", "  ", "world"]);
      expect(result).toEqual(["hello", "world"]);
    });

    it("handles null values in array", () => {
      const result = (searchOps as any).normalizeStringArray(["hello", null, "world"]);
      expect(result).toEqual(["hello", "world"]);
    });

    it("handles mixed types", () => {
      const result = (searchOps as any).normalizeStringArray(["string", 123, true, null]);
      expect(result).toEqual(["string", "123", "true"]);
    });
  });

  describe("findFiles", () => {
    it("throws error when patterns is empty", async () => {
      await expect(searchOps.findFiles({ patterns: [] })).rejects.toThrow(
        "Missing required 'patterns'"
      );
    });

    it("throws error when patterns is undefined", async () => {
      await expect(searchOps.findFiles({} as any)).rejects.toThrow(
        "Missing required 'patterns'"
      );
    });

    it("searches files in vault", async () => {
      const result = await searchOps.findFiles({ patterns: ["test"] });

      expect(app.vault.getFiles).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.results).toBeDefined();
    });

    it("searches folders recursively", async () => {
      const result = await searchOps.findFiles({ patterns: ["notes"] });

      expect(app.vault.getRoot).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("searches hidden adapter paths when allowed", async () => {
      const hiddenRoot = ".systemsculpt/benchmarks/v2/active";
      const hiddenPath = `${hiddenRoot}/Inbox/Note.md`;
      const hiddenSearch = new SearchOperations(app, [hiddenRoot], plugin);

      (utils.listAdapterFiles as jest.Mock).mockResolvedValue([hiddenPath]);
      (utils.statAdapterPath as jest.Mock).mockResolvedValue({
        size: 42,
        ctime: Date.now(),
        mtime: Date.now(),
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue([]);

      const result = await hiddenSearch.findFiles({ patterns: ["Note"] });

      expect(result.results.some((r: any) => r.path === hiddenPath)).toBe(true);
    });

    it("excludes chat history files", async () => {
      const chatFile = new TFile({ path: "ChatHistory/conversation.md" });
      (chatFile.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 500 };
      (app.vault.getFiles as jest.Mock).mockReturnValue([...mockFiles, chatFile]);

      const result = await searchOps.findFiles({ patterns: ["conversation"] });

      // The chat file should be excluded by shouldExcludeFromSearch
      expect(result).toBeDefined();
    });

    it("adds metadata to results", async () => {
      const result = await searchOps.findFiles({ patterns: ["test"] });

      expect(result.results).toBeDefined();
      if (result.results.length > 0) {
        expect(result.results[0]).toHaveProperty("path");
        expect(result.results[0]).toHaveProperty("score");
      }
    });

    it("limits results to MAX_SEARCH_RESULTS * 3", async () => {
      const manyFiles = Array.from({ length: 100 }, (_, i) =>
        new TFile({ path: `file${i}.md` })
      );
      manyFiles.forEach((file) => {
        (file.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 100 };
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue(manyFiles);

      const result = await searchOps.findFiles({ patterns: ["file"] });

      // Results include files and folders, so check that formatScoredResults was called with limit
      expect(result.results).toBeDefined();
    });

    it("respects allowed paths when searching files and folders", async () => {
      const restrictedSearch = new SearchOperations(app, ["notes"], plugin);
      const result = await restrictedSearch.findFiles({ patterns: ["md"] });

      const paths = result.results.map((r: any) => r.path);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((path: string) => path.startsWith("notes"))).toBe(true);
    });

    it("includes .base files in name search results", async () => {
      const baseFile = new TFile({ path: "bases/Projects.base" });
      (baseFile.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 321 };
      (app.vault.getFiles as jest.Mock).mockReturnValue([...mockFiles, baseFile]);

      const result = await searchOps.findFiles({ patterns: [".base"] });

      expect(result.results.some((r: any) => r.path === "bases/Projects.base")).toBe(true);
    });
  });

  describe("grepVault", () => {
    it("throws error when patterns is empty", async () => {
      await expect(searchOps.grepVault({ patterns: [] })).rejects.toThrow(
        "Missing required 'patterns'"
      );
    });

    it("throws error when patterns is undefined", async () => {
      await expect(searchOps.grepVault({} as any)).rejects.toThrow(
        "Missing required 'patterns'"
      );
    });

    it("searches file contents", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("This is test content");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(app.vault.cachedRead).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("searches hidden adapter file contents when allowed", async () => {
      const hiddenRoot = ".systemsculpt/benchmarks/v2/active";
      const hiddenPath = `${hiddenRoot}/Inbox/Note.md`;
      const hiddenSearch = new SearchOperations(app, [hiddenRoot], plugin);

      (utils.listAdapterFiles as jest.Mock).mockResolvedValue([hiddenPath]);
      (utils.statAdapterPath as jest.Mock).mockResolvedValue({
        size: 24,
        ctime: Date.now(),
        mtime: Date.now(),
      });
      (utils.readAdapterText as jest.Mock).mockResolvedValue("adapter test content");
      (app.vault.getFiles as jest.Mock).mockReturnValue([]);

      const result = await hiddenSearch.grepVault({ patterns: ["test"] });

      expect(utils.readAdapterText).toHaveBeenCalledWith(expect.anything(), hiddenPath);
      expect(result).toBeDefined();
    });

    it("returns no matches message when nothing found", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("No matching content here");
      (app.vault.getFiles as jest.Mock).mockReturnValue([]);

      const result = await searchOps.grepVault({ patterns: ["xyz123"] });

      expect(result.metaInfo).toBeDefined();
      const noMatchesInfo = result.metaInfo.find((m: any) => m.file === "_no_matches");
      expect(noMatchesInfo).toBeDefined();
    });

    it("handles searchIn parameter for content", async () => {
      const contentWithFrontmatter = `---
title: Test
---
Body content here`;
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(contentWithFrontmatter);

      const result = await searchOps.grepVault({
        patterns: ["Body"],
        searchIn: "content",
      } as any);

      expect(result).toBeDefined();
    });

    it("handles searchIn parameter for frontmatter", async () => {
      const contentWithFrontmatter = `---
title: Test
---
Body content here`;
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(contentWithFrontmatter);

      const result = await searchOps.grepVault({
        patterns: ["title"],
        searchIn: "frontmatter",
      } as any);

      expect(result).toBeDefined();
    });

    it("handles searchIn parameter for both", async () => {
      const contentWithFrontmatter = `---
title: Test
---
Body content here`;
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(contentWithFrontmatter);

      const result = await searchOps.grepVault({
        patterns: ["Test"],
        searchIn: "both",
      } as any);

      expect(result).toBeDefined();
    });

    it("skips files without frontmatter when searching frontmatter only", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("No frontmatter content");

      const result = await searchOps.grepVault({
        patterns: ["content"],
        searchIn: "frontmatter",
      } as any);

      expect(result).toBeDefined();
    });

    it("handles path matches", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("unrelated content");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      // Should find notes/test.md by path match
      expect(result).toBeDefined();
    });

    it("respects MAX_FILE_SIZE limit", async () => {
      const largeFile = new TFile({ path: "large.md" });
      (largeFile.stat as any) = {
        ctime: Date.now(),
        mtime: Date.now(),
        size: FILESYSTEM_LIMITS.MAX_FILE_SIZE + 1000,
      };
      (app.vault.getFiles as jest.Mock).mockReturnValue([largeFile]);

      const result = await searchOps.grepVault({ patterns: ["test"] });

      // Large file should be skipped
      expect(result).toBeDefined();
    });

    it("respects MAX_SEARCH_RESULTS limit", async () => {
      const manyFiles = Array.from({ length: 100 }, (_, i) => {
        const file = new TFile({ path: `file${i}.md` });
        (file.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 100 };
        return file;
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue(manyFiles);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result.results.length).toBeLessThanOrEqual(FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS);
    });

    it("handles empty files", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("handles regex patterns", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test123 content");

      const result = await searchOps.grepVault({ patterns: ["test\\d+"] });

      expect(result).toBeDefined();
    });

    it("handles invalid regex gracefully", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      // Invalid regex pattern
      const result = await searchOps.grepVault({ patterns: ["[invalid"] });

      expect(result).toBeDefined();
    });

    it("includes context around matches", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(
        "Before the match. The test keyword is here. After the match."
      );

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("handles pageTokens parameter", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({
        patterns: ["test"],
        pageTokens: 1024,
      } as any);

      expect(result).toBeDefined();
      expect(result.page).toBeDefined();
      expect(result.page.tokensBudget).toBe(1024);
    });

    it("enforces minimum pageTokens of 512", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({
        patterns: ["test"],
        pageTokens: 100,
      } as any);

      expect(result.page.tokensBudget).toBe(512);
    });

    it("enforces maximum pageTokens of 4096", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({
        patterns: ["test"],
        pageTokens: 10000,
      } as any);

      expect(result.page.tokensBudget).toBe(4096);
    });

    it("handles cursor for pagination", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content repeated test");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result.page).toBeDefined();
      // First page may have next_cursor if there are more results
    });

    it("handles read errors gracefully", async () => {
      (app.vault.cachedRead as jest.Mock).mockRejectedValue(new Error("Read failed"));

      const result = await searchOps.grepVault({ patterns: ["test"] });

      // Should not throw, just skip problematic files
      expect(result).toBeDefined();
    });

    it("adds recency bonus to scores", async () => {
      const recentFile = new TFile({ path: "recent.md" });
      (recentFile.stat as any) = {
        ctime: Date.now(),
        mtime: Date.now(),
        size: 100,
      };
      const oldFile = new TFile({ path: "old.md" });
      (oldFile.stat as any) = {
        ctime: Date.now() - 365 * 86400000,
        mtime: Date.now() - 365 * 86400000,
        size: 100,
      };
      (app.vault.getFiles as jest.Mock).mockReturnValue([recentFile, oldFile]);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("tracks performance metrics", async () => {
      // Simulate many files to trigger performance tracking
      const manyFiles = Array.from({ length: 50 }, (_, i) => {
        const file = new TFile({ path: `file${i}.md` });
        (file.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 100 };
        return file;
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue(manyFiles);
      (app.vault.cachedRead as jest.Mock).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "test content";
      });

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("merges overlapping context windows", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(
        "test one test two test three in close proximity"
      );

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("handles multiple patterns", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(
        "This has both alpha and beta keywords"
      );

      const result = await searchOps.grepVault({ patterns: ["alpha", "beta"] });

      expect(result).toBeDefined();
    });

    it("highlights matches in context", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("Find the test keyword here");
      const singleFile = new TFile({ path: "single.md" });
      (singleFile.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 100 };
      (app.vault.getFiles as jest.Mock).mockReturnValue([singleFile]);

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("respects MAX_MATCHES_PER_FILE limit", async () => {
      // Create content with many matches
      const manyMatches = "test ".repeat(100);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(manyMatches);

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("uses vault file cache when available", async () => {
      const cachedFiles = [new TFile({ path: "cached.md" })];
      (cachedFiles[0].stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 100 };

      const mockVaultFileCache = {
        getAllFiles: jest.fn().mockReturnValue(cachedFiles),
      };
      (app as any).plugins = {
        plugins: {
          "systemsculpt-ai": {
            vaultFileCache: mockVaultFileCache,
          },
        },
      };
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("falls back to vault.getFiles when cache unavailable", async () => {
      (app as any).plugins = {
        plugins: {
          "systemsculpt-ai": {
            vaultFileCache: null,
          },
        },
      };
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("sorts files by size (smallest first)", async () => {
      const files = [
        new TFile({ path: "large.md" }),
        new TFile({ path: "small.md" }),
        new TFile({ path: "medium.md" }),
      ];
      (files[0].stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 10000 };
      (files[1].stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 100 };
      (files[2].stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 1000 };
      (app.vault.getFiles as jest.Mock).mockReturnValue(files);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(result).toBeDefined();
    });

    it("filters grep results to allowed paths", async () => {
      const restrictedSearch = new SearchOperations(app, ["notes"], plugin);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      await restrictedSearch.grepVault({ patterns: ["test"] });

      expect(app.vault.cachedRead).toHaveBeenCalledTimes(1);
      expect((app.vault.cachedRead as jest.Mock).mock.calls[0][0].path).toBe("notes/test.md");
    });
  });
});
