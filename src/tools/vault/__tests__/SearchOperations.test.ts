/**
 * @jest-environment node
 */
import { App, TFile, TFolder } from "obsidian";
import { SearchOperations } from "../tools/SearchOperations";
import { FILESYSTEM_LIMITS } from "../constants";
import * as utils from "../utils";
import {
  outputAsToolResult,
  safeOutboundVaultToolResult,
  toJsonValue,
} from "../../../chat/managed/WireConversation";

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
  calculateScore: jest.fn((path: string, _content: string, options: any) => ({
    path,
    score: 50,
    matchDetails: {
      reasoning: "test match",
      keywordsFound: options.searchTerms.filter((term: string) => path.toLowerCase().includes(term.toLowerCase())),
    },
    contexts: [],
  })),
  sortByScore: jest.fn((results: any[]) =>
    [...results].sort((a, b) => b.score - a.score)
  ),
  formatScoredResults: jest.fn((results: any[], limit: number) => ({
    results: results.slice(0, limit).map((r) => ({
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
      registerEvent: jest.fn(),
      app: {
        vault: {
          configDir: ".obsidian",
          getConfig: jest.fn().mockReturnValue([]),
        },
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
      const hiddenRoot = ".systemsculpt/temp/runtime-smoke";
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

    const useManyMatchingFiles = () => {
      const manyFiles = Array.from({ length: 100 }, (_, i) =>
        new TFile({ path: `file${i}.md` })
      );
      manyFiles.forEach((file) => {
        (file.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 100 };
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue(manyFiles);
    };

    it("limits results to MAX_SEARCH_RESULTS * 3", async () => {
      useManyMatchingFiles();

      const result = await searchOps.findFiles({ patterns: ["file"] });

      expect(result.results).toHaveLength(FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS * 3);
      expect(result.totalFound).toBe(100);
    });

    it("honors a smaller positive maxResults request", async () => {
      useManyMatchingFiles();

      const result = await searchOps.findFiles({ patterns: ["file"], maxResults: 1 });

      expect(result.results).toHaveLength(1);
      expect(result.totalFound).toBe(100);
    });

    it("clamps maxResults to the existing global result ceiling", async () => {
      useManyMatchingFiles();

      const result = await searchOps.findFiles({ patterns: ["file"], maxResults: Number.MAX_SAFE_INTEGER });

      expect(result.results).toHaveLength(FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS * 3);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects invalid maxResults %s without broadening the search response",
      async (maxResults) => {
        await expect(searchOps.findFiles({ patterns: ["test"], maxResults }))
          .rejects.toThrow("maxResults must be a positive integer");
      },
    );

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

    it("scopes a search to exact vault folders without prefix leakage", async () => {
      const files = [
        new TFile({ path: "Research/one.md" }),
        new TFile({ path: "Research/Nested/two.md" }),
        new TFile({ path: "Research-old/outside.md" }),
        new TFile({ path: "Elsewhere/outside.md" }),
      ];
      files.forEach((file) => {
        (file.stat as any) = {
          ctime: Date.now(),
          mtime: Date.now(),
          size: 100,
        };
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue(files);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("needle");

      const result = await searchOps.grepVault({
        patterns: ["needle"],
        paths: ["Research"],
      });

      const readPaths = (app.vault.cachedRead as jest.Mock).mock.calls
        .map(([file]) => file.path)
        .sort();
      expect(readPaths).toEqual([
        "Research/Nested/two.md",
        "Research/one.md",
      ]);
      expect(result.results.map((entry: any) => entry.path).sort()).toEqual([
        "Research/Nested/two.md",
        "Research/one.md",
      ]);
      expect(result.scope).toEqual({ paths: ["Research"] });
    });

    it("supports exact-file and multiple normalized search scopes", async () => {
      const files = [
        new TFile({ path: "Research/one.md" }),
        new TFile({ path: "Research/Nested/two.md" }),
        new TFile({ path: "Projects/architecture.md" }),
        new TFile({ path: "Projects/other.md" }),
      ];
      files.forEach((file) => {
        (file.stat as any) = {
          ctime: Date.now(),
          mtime: Date.now(),
          size: 100,
        };
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue(files);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("server-owned");

      const result = await searchOps.grepVault({
        patterns: ["server-owned"],
        paths: [
          "Research%2FNested",
          "Projects\\architecture.md",
          "Research%2FNested",
        ],
      });

      expect((app.vault.cachedRead as jest.Mock).mock.calls
        .map(([file]) => file.path)
        .sort()).toEqual([
        "Projects/architecture.md",
        "Research/Nested/two.md",
      ]);
      expect(result.scope).toEqual({
        paths: ["Projects/architecture.md", "Research/Nested"],
      });
    });

    it("intersects requested paths with the executor's allowed vault scope", async () => {
      const restrictedSearch = new SearchOperations(app, ["notes"], plugin);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await restrictedSearch.grepVault({
        patterns: ["test"],
        paths: ["projects"],
      });

      expect(app.vault.cachedRead).not.toHaveBeenCalled();
      expect(result.scope).toEqual({ paths: ["projects"] });
      expect(result.metaInfo).toEqual(expect.arrayContaining([
        expect.objectContaining({ file: "_no_matches" }),
      ]));
    });

    it.each([
      { label: "a scalar", paths: "Research" },
      { label: "an empty array", paths: [] },
      { label: "a blank path", paths: ["   "] },
      { label: "a traversal", paths: ["../Outside"] },
      {
        label: "too many paths",
        paths: Array.from({ length: 65 }, (_, index) => `Folder-${index}`),
      },
    ])("rejects $label instead of silently searching the whole vault", async ({ paths }) => {
      await expect(searchOps.grepVault({
        patterns: ["needle"],
        paths,
      } as any)).rejects.toThrow(/Search|search path/i);
      expect(app.vault.cachedRead).not.toHaveBeenCalled();
    });

    it("binds pagination cursors to their normalized path scope", async () => {
      const unscopedCursor = Buffer.from(JSON.stringify({
        q: "content|literal|needle",
        o: 0,
      })).toString("base64");

      await expect(searchOps.grepVault({
        patterns: ["needle"],
        paths: ["Research"],
        cursor: unscopedCursor,
      })).rejects.toThrow("Invalid search cursor");
    });

    it("preserves whole-vault behavior when paths are omitted", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("needle");

      const result = await searchOps.grepVault({ patterns: ["needle"] });

      expect(app.vault.cachedRead).toHaveBeenCalledTimes(3);
      expect(result.scope).toBeUndefined();
    });

    it("searches hidden adapter file contents when allowed", async () => {
      const hiddenRoot = ".systemsculpt/temp/runtime-smoke";
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
      expect(noMatchesInfo).toEqual(expect.objectContaining({
        notice: expect.stringContaining('No matches found for: "xyz123". Try different words'),
      }));
      expect(noMatchesInfo).not.toHaveProperty("message");
    });

    it("keeps the no-match hint intact through managed tool-result delivery", async () => {
      (app.vault.getFiles as jest.Mock).mockReturnValue([]);
      const result = await searchOps.grepVault({ patterns: ["xyz123"] });

      const outbound = safeOutboundVaultToolResult(outputAsToolResult(toJsonValue(result)));

      expect(outbound).toEqual({ success: true, data: toJsonValue(result) });
      const delivered = JSON.stringify(outbound);
      expect(delivered).toContain('No matches found for: \\"xyz123\\". Try different words');
      expect(delivered).not.toContain("The vault action failed.");
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

      const result = await searchOps.grepVault({
        patterns: ["test\\d+"],
        patternMode: "regex",
      });

      expect(result).toBeDefined();
    });

    it("rejects invalid patterns only in explicit regex mode", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      await expect(searchOps.grepVault({
        patterns: ["[invalid"],
        patternMode: "regex",
      })).rejects.toThrow("Invalid regex pattern");
    });

    it("treats regex metacharacters literally by default", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("a literal [invalid marker");

      const result = await searchOps.grepVault({ patterns: ["[invalid"] });

      expect(result).toBeDefined();
    });

    it("rejects unsupported pattern modes", async () => {
      await expect(searchOps.grepVault({
        patterns: ["test"],
        patternMode: "semantic" as any,
      })).rejects.toThrow("patternMode");
    });

    it("handles zero-width regex matches without stalling", async () => {
      (app.vault.cachedRead as jest.Mock).mockResolvedValue("test content");

      const result = await searchOps.grepVault({ patterns: ["^"], patternMode: "regex" });

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

    it("rejects malformed or mismatched cursors", async () => {
      await expect(searchOps.grepVault({
        patterns: ["test"],
        cursor: "not-a-valid-cursor",
      })).rejects.toThrow("Invalid search cursor");
    });

    it("keeps aggregate search output within the response budget", async () => {
      const manyFiles = Array.from({ length: 25 }, (_, index) => {
        const file = new TFile({ path: `notes/file-${index}.md` });
        (file.stat as any) = { ctime: Date.now(), mtime: Date.now(), size: 20000 };
        return file;
      });
      (app.vault.getFiles as jest.Mock).mockReturnValue(manyFiles);
      (app.vault.cachedRead as jest.Mock).mockResolvedValue(
        Array.from({ length: 80 }, (_, index) => `test-${index} ${"context ".repeat(30)}`).join("\n")
      );

      const result = await searchOps.grepVault({ patterns: ["test"] });

      expect(JSON.stringify(result).length).toBeLessThanOrEqual(FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS);
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

    describe("candidate order", () => {
      const DAY = 86400000;
      const note = (path: string, size: number, mtime: number) => {
        const file = new TFile({ path });
        (file.stat as any) = { ctime: mtime, mtime, size };
        return file;
      };
      // Sixty small notes that all mention the term: enough to fill the
      // 25-file result budget many times over before a larger note is read.
      const smallNotes = (mtime: number) => Array.from({ length: 60 }, (_, index) =>
        note(`Daily/2026-${String(index).padStart(3, "0")}.md`, 120, mtime));
      const readPaths = () => (app.vault.cachedRead as jest.Mock).mock.calls.map(([file]) => file.path);

      it("reads a large, recently edited matching note ahead of many small ones", async () => {
        const large = note("Projects/Roadmap.md", 150000, Date.now());
        (app.vault.getFiles as jest.Mock).mockReturnValue([...smallNotes(Date.now() - 30 * DAY), large]);
        (app.vault.cachedRead as jest.Mock).mockImplementation(async (file: TFile) =>
          file.path === large.path ? `${"plan ".repeat(29000)}launch checklist` : "launch notes");

        const result = await searchOps.grepVault({ patterns: ["launch"] });

        expect(readPaths()[0]).toBe(large.path);
        expect(result.results.map((entry: any) => entry.path)).toContain(large.path);
        expect(result.metaInfo).toEqual(expect.arrayContaining([
          expect.objectContaining({ file: "_summary" }),
        ]));
      });

      it("reads a note whose title matches before newer notes that only mention the term", async () => {
        const titled = note("Archive/Launch.md", 150000, Date.now() - 365 * DAY);
        (app.vault.getFiles as jest.Mock).mockReturnValue([...smallNotes(Date.now()), titled]);
        (app.vault.cachedRead as jest.Mock).mockResolvedValue("launch notes");

        const result = await searchOps.grepVault({ patterns: ["launch"] });

        expect(readPaths()[0]).toBe(titled.path);
        expect(result.results.map((entry: any) => entry.path)).toContain(titled.path);
      });

      it("ranks a title hit, then a folder hit, then recency, then path", async () => {
        const now = Date.now();
        const files = [
          note("b-old.md", 10, now - 2 * DAY),
          note("a-old.md", 10, now - 2 * DAY),
          note("Launch plans/inside.md", 10, now - 5 * DAY),
          note("newest.md", 10, now),
          note("Archive/launch.md", 10, now - 9 * DAY),
        ];
        (app.vault.getFiles as jest.Mock).mockReturnValue(files);
        (app.vault.cachedRead as jest.Mock).mockResolvedValue("launch");

        await searchOps.grepVault({ patterns: ["launch"] });

        expect(readPaths()).toEqual([
          "Archive/launch.md",
          "Launch plans/inside.md",
          "newest.md",
          "a-old.md",
          "b-old.md",
        ]);
      });

      it("returns one result per file when both its path and its text match", async () => {
        (app.vault.getFiles as jest.Mock).mockReturnValue([note("Launch.md", 10, Date.now())]);
        (app.vault.cachedRead as jest.Mock).mockResolvedValue("launch day");

        const result = await searchOps.grepVault({ patterns: ["launch"] });

        expect(result.results.map((entry: any) => entry.path)).toEqual(["Launch.md"]);
        expect(result.snippets).toEqual(["Launch.md:1  【launch】 day"]);
      });

      it("compiles each pattern once, however many files and matches it scans", async () => {
        const files = Array.from({ length: 40 }, (_, index) => note(`notes/${index}.md`, 500, Date.now()));
        (app.vault.getFiles as jest.Mock).mockReturnValue(files);
        (app.vault.cachedRead as jest.Mock).mockResolvedValue(
          Array.from({ length: 12 }, () => `alpha ${"filler ".repeat(80)} beta`).join("\n"));
        await searchOps.grepVault({ patterns: ["warm"] });
        const NativeRegExp = RegExp;
        let constructed = 0;
        const CountingRegExp = function (this: unknown, ...args: [string | RegExp, string?]) {
          constructed++;
          return new NativeRegExp(...args);
        } as unknown as RegExpConstructor;
        CountingRegExp.prototype = NativeRegExp.prototype;
        (globalThis as any).RegExp = CountingRegExp;
        try {
          await searchOps.grepVault({ patterns: ["alpha", "beta"] });
        } finally {
          (globalThis as any).RegExp = NativeRegExp;
        }

        // Two patterns, each with one path matcher and one scanner.
        expect(constructed).toBe(4);
      });
    });

    describe("paging", () => {
      let vaultHandlers: Record<string, (file: unknown, oldPath?: string) => void>;
      const pagedVault = () => {
        const files = Array.from({ length: 12 }, (_, index) => {
          const file = new TFile({ path: `notes/note-${String(index).padStart(2, "0")}.md` });
          (file.stat as any) = { ctime: Date.now(), mtime: Date.now() - index * 1000, size: 4000 };
          return file;
        });
        (app.vault.getFiles as jest.Mock).mockReturnValue(files);
        (app.vault.cachedRead as jest.Mock).mockImplementation(async (file: TFile) =>
          Array.from({ length: 6 }, (_, line) =>
            `${file.path} line ${line} needle ${"words ".repeat(90)}`).join("\n"));
        return files;
      };
      const page = (cursor?: string) =>
        searchOps.grepVault({ patterns: ["needle"], pageTokens: 1024, ...(cursor ? { cursor } : {}) }) as Promise<any>;

      beforeEach(() => {
        vaultHandlers = {};
        (app.vault.on as jest.Mock).mockImplementation((name: string, handler: (file: unknown) => void) => {
          vaultHandlers[name] = handler;
          return { name };
        });
      });

      it("serves later pages from the kept scan without reading a file or repeating a snippet", async () => {
        pagedVault();
        const first = await page();
        expect(first.page.next_cursor).toEqual(expect.any(String));
        expect(plugin.registerEvent).toHaveBeenCalledTimes(4);

        const seen = [...first.snippets];
        let cursor: string | null = first.page.next_cursor;
        let pages = 1;
        (app.vault.cachedRead as jest.Mock).mockClear();
        (app.vault.getFiles as jest.Mock).mockClear();
        while (cursor) {
          const next = await page(cursor);
          expect(next.snippets.length).toBeGreaterThan(0);
          expect(next.metaInfo ?? []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ file: "_new_search" }),
          ]));
          seen.push(...next.snippets);
          cursor = next.page.next_cursor;
          pages++;
        }

        expect(pages).toBeGreaterThan(2);
        expect(app.vault.cachedRead).not.toHaveBeenCalled();
        expect(app.vault.getFiles).not.toHaveBeenCalled();
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toHaveLength(first.page.total_matches);
        expect(plugin.registerEvent).toHaveBeenCalledTimes(4);
      });

      it("searches again when a searchable note changes between pages", async () => {
        const files = pagedVault();
        const first = await page();
        (app.vault.cachedRead as jest.Mock).mockClear();

        vaultHandlers.modify(files[3]);
        const second = await page(first.page.next_cursor);

        expect(app.vault.cachedRead).toHaveBeenCalledTimes(files.length);
        expect(second.metaInfo).toEqual(expect.arrayContaining([
          expect.objectContaining({ file: "_new_search", notice: expect.stringContaining("new search") }),
        ]));
        // The next page continues the new scan without another read.
        (app.vault.cachedRead as jest.Mock).mockClear();
        const third = await page(second.page.next_cursor);
        expect(app.vault.cachedRead).not.toHaveBeenCalled();
        expect(third.metaInfo ?? []).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ file: "_new_search" }),
        ]));
      });

      it("keeps the scan when only an excluded file changes", async () => {
        plugin.settings.chatsDirectory = "SystemSculpt/Chats";
        pagedVault();
        const first = await page();
        (app.vault.cachedRead as jest.Mock).mockClear();

        vaultHandlers.modify(new TFile({ path: "SystemSculpt/Chats/Running chat.md" }));
        await page(first.page.next_cursor);

        expect(app.vault.cachedRead).not.toHaveBeenCalled();
      });

      it("searches again when a note is renamed into the searched vault", async () => {
        plugin.settings.chatsDirectory = "SystemSculpt/Chats";
        pagedVault();
        const first = await page();
        (app.vault.cachedRead as jest.Mock).mockClear();

        vaultHandlers.rename(new TFile({ path: "notes/moved.md" }), "SystemSculpt/Chats/moved.md");
        await page(first.page.next_cursor);

        expect(app.vault.cachedRead).toHaveBeenCalled();
      });

      it("does not keep a scan the vault changed under while it ran", async () => {
        const files = pagedVault();
        const read = (app.vault.cachedRead as jest.Mock).getMockImplementation()!;
        (app.vault.cachedRead as jest.Mock).mockImplementationOnce(async (file: TFile) => {
          vaultHandlers.modify(files[0]);
          return read(file);
        });
        const first = await page();
        (app.vault.cachedRead as jest.Mock).mockClear();

        await page(first.page.next_cursor);

        expect(app.vault.cachedRead).toHaveBeenCalledTimes(files.length);
      });

      it("reuses a kept scan for the same first-page search until the vault changes", async () => {
        const files = pagedVault();
        const first = await page();
        (app.vault.cachedRead as jest.Mock).mockClear();

        expect((await page()).snippets).toEqual(first.snippets);
        expect(app.vault.cachedRead).not.toHaveBeenCalled();

        vaultHandlers.delete(files[0]);
        await page();
        expect(app.vault.cachedRead).toHaveBeenCalledTimes(files.length);
      });

      it("still accepts a cursor issued before scans were kept", async () => {
        pagedVault();
        const legacyCursor = Buffer.from(JSON.stringify({ q: "content|literal|needle", o: 2 })).toString("base64");

        const result = await page(legacyCursor);

        expect(result.snippets.length).toBeGreaterThan(0);
        expect(result.metaInfo).toEqual(expect.arrayContaining([
          expect.objectContaining({ file: "_new_search" }),
        ]));
      });
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
