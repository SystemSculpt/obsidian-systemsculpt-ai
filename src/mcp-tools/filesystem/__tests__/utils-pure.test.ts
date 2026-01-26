/**
 * @jest-environment node
 */

import {
  formatBytes,
  normalizeLineEndings,
  createSimpleDiff,
  runWithConcurrency,
  createLineCalculator,
  evaluateQuery,
  wouldExceedCharLimit,
  fuzzyMatchScore,
} from "../utils";

describe("formatBytes", () => {
  it("returns '0 Bytes' for 0", () => {
    expect(formatBytes(0)).toBe("0 Bytes");
  });

  it("formats bytes correctly", () => {
    expect(formatBytes(500)).toBe("500 Bytes");
    expect(formatBytes(1023)).toBe("1023 Bytes");
  });

  it("formats KB correctly", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("formats MB correctly", () => {
    expect(formatBytes(1048576)).toBe("1 MB");
    expect(formatBytes(1572864)).toBe("1.5 MB");
    expect(formatBytes(5242880)).toBe("5 MB");
  });

  it("formats GB correctly", () => {
    expect(formatBytes(1073741824)).toBe("1 GB");
    expect(formatBytes(1610612736)).toBe("1.5 GB");
  });
});

describe("normalizeLineEndings", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeLineEndings("line1\r\nline2\r\n")).toBe("line1\nline2\n");
  });

  it("leaves LF unchanged", () => {
    expect(normalizeLineEndings("line1\nline2\n")).toBe("line1\nline2\n");
  });

  it("handles mixed line endings", () => {
    expect(normalizeLineEndings("line1\r\nline2\nline3\r\n")).toBe("line1\nline2\nline3\n");
  });

  it("handles empty string", () => {
    expect(normalizeLineEndings("")).toBe("");
  });

  it("handles string without line endings", () => {
    expect(normalizeLineEndings("single line")).toBe("single line");
  });
});

describe("normalizeVaultPath", () => {
  const { normalizeVaultPath } = require("../utils");

  it("trims whitespace", () => {
    expect(normalizeVaultPath("  docs/file.md  ")).toBe("docs/file.md");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeVaultPath("docs\\file.md")).toBe("docs/file.md");
  });

  it("collapses repeated slashes", () => {
    expect(normalizeVaultPath("docs//sub//file.md")).toBe("docs/sub/file.md");
  });

  it("strips leading slashes", () => {
    expect(normalizeVaultPath("/docs/file.md")).toBe("docs/file.md");
  });

  it("strips trailing slashes", () => {
    expect(normalizeVaultPath("docs/folder/")).toBe("docs/folder");
  });

  it("returns empty string for empty-ish input", () => {
    expect(normalizeVaultPath("")).toBe("");
    expect(normalizeVaultPath("   ")).toBe("");
    expect(normalizeVaultPath(null as any)).toBe("");
    expect(normalizeVaultPath(undefined as any)).toBe("");
  });
});

describe("createSimpleDiff", () => {
  it("returns no changes for identical content", () => {
    const content = "line1\nline2\nline3";
    const result = createSimpleDiff(content, content, "test.md");
    expect(result).toBe("No changes made.");
  });

  it("shows added lines", () => {
    const original = "line1\nline2";
    const modified = "line1\nline2\nline3";
    const result = createSimpleDiff(original, modified, "test.md");
    expect(result).toContain("+ line3");
    expect(result).toContain("+1");
  });

  it("shows removed lines", () => {
    const original = "line1\nline2\nline3";
    const modified = "line1\nline2";
    const result = createSimpleDiff(original, modified, "test.md");
    expect(result).toContain("- line3");
    expect(result).toContain("-1");
  });

  it("shows modified lines", () => {
    const original = "line1\noriginal\nline3";
    const modified = "line1\nmodified\nline3";
    const result = createSimpleDiff(original, modified, "test.md");
    expect(result).toContain("- original");
    expect(result).toContain("+ modified");
  });

  it("includes file headers", () => {
    const result = createSimpleDiff("a", "b", "myfile.txt");
    expect(result).toContain("--- myfile.txt");
    expect(result).toContain("+++ myfile.txt");
  });

  it("uses default filepath if not provided", () => {
    const result = createSimpleDiff("a", "b");
    expect(result).toContain("--- file");
    expect(result).toContain("+++ file");
  });

  it("handles CRLF normalization", () => {
    const original = "line1\r\nline2";
    const modified = "line1\nline2";
    const result = createSimpleDiff(original, modified, "test.md");
    expect(result).toBe("No changes made.");
  });
});

describe("runWithConcurrency", () => {
  it("processes all items", async () => {
    const items = ["a", "b", "c"];
    const results = await runWithConcurrency(items, async (item) => item.toUpperCase(), 2);
    expect(results).toContain("A");
    expect(results).toContain("B");
    expect(results).toContain("C");
  });

  it("handles empty array", async () => {
    const results = await runWithConcurrency([], async (item) => item, 5);
    expect(results).toEqual([]);
  });

  it("handles errors in worker", async () => {
    const items = ["good", "bad", "good2"];
    const results = await runWithConcurrency(
      items,
      async (item) => {
        if (item === "bad") throw new Error("Failed");
        return item;
      },
      2
    );

    expect(results.filter((r) => typeof r === "string")).toHaveLength(2);
    expect(results.find((r) => (r as any).error)).toBeDefined();
  });

  it("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const items = ["1", "2", "3", "4", "5"];

    await runWithConcurrency(
      items,
      async (item) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return item;
      },
      2
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe("createLineCalculator", () => {
  it("returns 1 for start of content", () => {
    const calc = createLineCalculator("line1\nline2\nline3");
    expect(calc(0)).toBe(1);
  });

  it("returns correct line for each line start", () => {
    const content = "line1\nline2\nline3";
    const calc = createLineCalculator(content);
    expect(calc(0)).toBe(1); // Start of line 1
    expect(calc(6)).toBe(2); // Start of line 2
    expect(calc(12)).toBe(3); // Start of line 3
  });

  it("returns correct line for positions within lines", () => {
    const content = "abc\ndef\nghi";
    const calc = createLineCalculator(content);
    expect(calc(1)).toBe(1); // 'b' on line 1
    expect(calc(5)).toBe(2); // 'e' on line 2
    expect(calc(9)).toBe(3); // 'h' on line 3
  });

  it("handles single line content", () => {
    const calc = createLineCalculator("single line");
    expect(calc(0)).toBe(1);
    expect(calc(5)).toBe(1);
    expect(calc(10)).toBe(1);
  });

  it("handles empty content", () => {
    const calc = createLineCalculator("");
    expect(calc(0)).toBe(1);
  });
});

describe("evaluateQuery", () => {
  describe("equals operator", () => {
    it("returns true for equal strings", () => {
      expect(evaluateQuery("test", "equals", "test")).toBe(true);
    });

    it("returns false for unequal strings", () => {
      expect(evaluateQuery("test", "equals", "other")).toBe(false);
    });

    it("handles non-date strings as regular equality", () => {
      // Non-date strings are compared directly
      expect(evaluateQuery("foo", "equals", "foo")).toBe(true);
      expect(evaluateQuery("foo", "equals", "bar")).toBe(false);
    });
  });

  describe("not_equals operator", () => {
    it("returns true for unequal values", () => {
      expect(evaluateQuery("a", "not_equals", "b")).toBe(true);
    });

    it("returns false for equal values", () => {
      expect(evaluateQuery("a", "not_equals", "a")).toBe(false);
    });
  });

  describe("contains operator", () => {
    it("returns true if string contains substring", () => {
      expect(evaluateQuery("hello world", "contains", "world")).toBe(true);
    });

    it("returns false if string does not contain substring", () => {
      expect(evaluateQuery("hello", "contains", "world")).toBe(false);
    });

    it("returns true if array contains element", () => {
      expect(evaluateQuery(["a", "b", "c"], "contains", "b")).toBe(true);
    });

    it("returns false if array does not contain element", () => {
      expect(evaluateQuery(["a", "b"], "contains", "c")).toBe(false);
    });

    it("returns false for non-string non-array", () => {
      expect(evaluateQuery(123, "contains", "1")).toBe(false);
    });
  });

  describe("starts_with operator", () => {
    it("returns true if string starts with prefix", () => {
      expect(evaluateQuery("hello world", "starts_with", "hello")).toBe(true);
    });

    it("returns false if string does not start with prefix", () => {
      expect(evaluateQuery("hello world", "starts_with", "world")).toBe(false);
    });

    it("returns false for non-string", () => {
      expect(evaluateQuery(123, "starts_with", "1")).toBe(false);
    });
  });

  describe("greater_than operator", () => {
    it("returns true for greater number", () => {
      expect(evaluateQuery(10, "greater_than", 5)).toBe(true);
    });

    it("returns false for smaller number", () => {
      expect(evaluateQuery(3, "greater_than", 5)).toBe(false);
    });

    it("compares dates correctly", () => {
      expect(evaluateQuery("2024-01-15", "greater_than", "2024-01-01")).toBe(true);
      expect(evaluateQuery("2024-01-01", "greater_than", "2024-01-15")).toBe(false);
    });
  });

  describe("less_than operator", () => {
    it("returns true for smaller number", () => {
      expect(evaluateQuery(3, "less_than", 5)).toBe(true);
    });

    it("returns false for greater number", () => {
      expect(evaluateQuery(10, "less_than", 5)).toBe(false);
    });

    it("compares dates correctly", () => {
      expect(evaluateQuery("2024-01-01", "less_than", "2024-01-15")).toBe(true);
    });
  });

  describe("unknown operator", () => {
    it("returns false for unknown operators", () => {
      expect(evaluateQuery("a", "unknown_op", "b")).toBe(false);
    });
  });
});

describe("wouldExceedCharLimit", () => {
  it("returns false when within limit", () => {
    expect(wouldExceedCharLimit(10, "hello", 100)).toBe(false);
  });

  it("returns true when would exceed limit", () => {
    // "hello" has length 5, so 96 + 5 = 101 > 100
    expect(wouldExceedCharLimit(96, "hello", 100)).toBe(true);
  });

  it("handles objects by stringifying", () => {
    const obj = { key: "value" };
    expect(wouldExceedCharLimit(0, obj, 100)).toBe(false);
    expect(wouldExceedCharLimit(90, obj, 100)).toBe(true);
  });

  it("handles exactly at limit", () => {
    expect(wouldExceedCharLimit(95, "12345", 100)).toBe(false);
    expect(wouldExceedCharLimit(96, "12345", 100)).toBe(true);
  });

  it("returns true for circular objects that fail stringify", () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(wouldExceedCharLimit(0, circular, 1000)).toBe(true);
  });
});

describe("fuzzyMatchScore", () => {
  it("returns 0 for exact substring match at start", () => {
    expect(fuzzyMatchScore("test", "testing")).toBe(0);
  });

  it("returns position for exact substring match not at start", () => {
    expect(fuzzyMatchScore("test", "atest")).toBe(1);
  });

  it("returns null for no match", () => {
    expect(fuzzyMatchScore("xyz", "abc")).toBeNull();
  });

  it("is case insensitive", () => {
    expect(fuzzyMatchScore("TEST", "testing")).toBe(0);
    expect(fuzzyMatchScore("test", "TESTING")).toBe(0);
  });

  it("returns score for fuzzy subsequence match", () => {
    const score = fuzzyMatchScore("abc", "a1b2c3");
    expect(score).not.toBeNull();
    expect(typeof score).toBe("number");
  });

  it("prefers contiguous matches", () => {
    const contiguousScore = fuzzyMatchScore("abc", "abc");
    const gapScore = fuzzyMatchScore("abc", "a1b2c");
    expect(contiguousScore).toBeLessThan(gapScore!);
  });

  it("returns null when needle cannot be found as subsequence", () => {
    expect(fuzzyMatchScore("abcd", "abc")).toBeNull();
  });

  it("handles empty needle", () => {
    expect(fuzzyMatchScore("", "anything")).toBe(0);
  });

  it("handles empty haystack with non-empty needle", () => {
    expect(fuzzyMatchScore("test", "")).toBeNull();
  });
});

describe("isHiddenSystemPath", () => {
  const { isHiddenSystemPath } = require("../utils");

  it("returns true for .systemsculpt/ paths", () => {
    expect(isHiddenSystemPath(".systemsculpt/foo")).toBe(true);
    expect(isHiddenSystemPath(".systemsculpt/bar/baz")).toBe(true);
  });

  it("returns false for regular paths", () => {
    expect(isHiddenSystemPath("regular/path")).toBe(false);
    expect(isHiddenSystemPath("folder/file.md")).toBe(false);
  });

  it("returns false for empty path", () => {
    expect(isHiddenSystemPath("")).toBe(false);
  });

  it("returns false for null-ish values", () => {
    expect(isHiddenSystemPath(null as any)).toBe(false);
    expect(isHiddenSystemPath(undefined as any)).toBe(false);
  });

  it("normalizes backslashes", () => {
    expect(isHiddenSystemPath(".systemsculpt\\foo")).toBe(true);
  });

  it("strips leading slashes", () => {
    expect(isHiddenSystemPath("/.systemsculpt/foo")).toBe(true);
  });
});

describe("resolveAdapterPath", () => {
  const { resolveAdapterPath } = require("../utils");

  it("returns null for null adapter", () => {
    expect(resolveAdapterPath(null, "path")).toBeNull();
  });

  it("returns null for adapter without getBasePath", () => {
    expect(resolveAdapterPath({}, "path")).toBeNull();
  });

  it("returns null when getBasePath returns null", () => {
    const adapter = { getBasePath: () => null };
    expect(resolveAdapterPath(adapter, "path")).toBeNull();
  });

  it("returns basePath for empty vaultPath", () => {
    const adapter = { getBasePath: () => "/vault" };
    expect(resolveAdapterPath(adapter, "")).toBe("/vault");
  });

  it("joins basePath and vaultPath", () => {
    const adapter = { getBasePath: () => "/vault" };
    const result = resolveAdapterPath(adapter, "folder/file.md");
    expect(result).toContain("/vault");
    expect(result).toContain("folder");
  });

  it("normalizes vaultPath slashes", () => {
    const adapter = { getBasePath: () => "/vault" };
    const result = resolveAdapterPath(adapter, "\\folder\\file");
    expect(result).not.toContain("\\\\");
  });

  // Path traversal security tests
  describe("path traversal prevention", () => {
    it("throws on simple path traversal with ../", () => {
      const adapter = { getBasePath: () => "/vault" };
      expect(() => resolveAdapterPath(adapter, "../etc/passwd")).toThrow(
        "Path traversal detected"
      );
    });

    it("throws on deep path traversal", () => {
      const adapter = { getBasePath: () => "/vault" };
      expect(() => resolveAdapterPath(adapter, "../../../etc/passwd")).toThrow(
        "Path traversal detected"
      );
    });

    it("throws on path traversal hidden in middle of path", () => {
      const adapter = { getBasePath: () => "/vault" };
      expect(() => resolveAdapterPath(adapter, "folder/../../../etc/passwd")).toThrow(
        "Path traversal detected"
      );
    });

    it("throws on path traversal with trailing content", () => {
      const adapter = { getBasePath: () => "/vault" };
      expect(() => resolveAdapterPath(adapter, "../../outside/file.txt")).toThrow(
        "Path traversal detected"
      );
    });

    it("throws on Windows-style path traversal", () => {
      const adapter = { getBasePath: () => "/vault" };
      expect(() => resolveAdapterPath(adapter, "..\\..\\etc\\passwd")).toThrow(
        "Path traversal detected"
      );
    });

    it("allows legitimate nested paths within vault", () => {
      const adapter = { getBasePath: () => "/vault" };
      const result = resolveAdapterPath(adapter, "folder/subfolder/file.md");
      expect(result).toContain("folder");
      expect(result).toContain("subfolder");
    });

    it("allows paths that contain .. but stay within vault", () => {
      const adapter = { getBasePath: () => "/vault" };
      // folder/sub/../file.md resolves to folder/file.md which is still in vault
      const result = resolveAdapterPath(adapter, "folder/sub/../file.md");
      expect(result).toBeDefined();
    });

    it("prevents prefix attack (vault-escape vs vault)", () => {
      const adapter = { getBasePath: () => "/vault" };
      // If base is /vault, an attacker might try /vault-escape which starts with /vault
      // but is not actually inside /vault. Our check uses path separator to prevent this.
      expect(() => resolveAdapterPath(adapter, "../vault-escape/secret")).toThrow(
        "Path traversal detected"
      );
    });

    it("throws when path resolves to parent directory", () => {
      const adapter = { getBasePath: () => "/vault/subdir" };
      expect(() => resolveAdapterPath(adapter, "../file.md")).toThrow(
        "Path traversal detected"
      );
    });

    it("throws on URL-encoded traversal patterns after normalization", () => {
      const adapter = { getBasePath: () => "/vault" };
      // Note: normalizeVaultPath doesn't decode URLs, but if someone passes decoded ..
      expect(() => resolveAdapterPath(adapter, "..%2F..%2Fetc/passwd".replace(/%2F/g, "/"))).toThrow(
        "Path traversal detected"
      );
    });
  });
});

describe("validatePath", () => {
  const { validatePath } = require("../utils");

  it("returns true when path starts with allowed path", () => {
    expect(validatePath("docs/file.md", ["docs"])).toBe(true);
    expect(validatePath("docs/subfolder/file.md", ["docs"])).toBe(true);
  });

  it("normalizes leading slashes in path and allowedPaths", () => {
    expect(validatePath("/docs/file.md", ["docs"])).toBe(true);
    expect(validatePath("docs/file.md", ["/docs"])).toBe(true);
    expect(validatePath("/docs/file.md", ["/docs"])).toBe(true);
  });

  it("returns true when allowed path is root", () => {
    expect(validatePath("any/path", ["/"])).toBe(true);
  });

  it("does not allow prefix matches outside path boundary", () => {
    expect(validatePath("docs2/file.md", ["docs"])).toBe(false);
    expect(validatePath("docs-and-more/file.md", ["docs"])).toBe(false);
  });

  it("returns false when path is outside allowed paths", () => {
    expect(validatePath("private/file.md", ["public"])).toBe(false);
  });

  it("handles multiple allowed paths", () => {
    expect(validatePath("docs/file.md", ["src", "docs", "public"])).toBe(true);
    expect(validatePath("private/file.md", ["src", "docs", "public"])).toBe(false);
  });
});

describe("getFilesFromFolder", () => {
  const { getFilesFromFolder } = require("../utils");
  const { TFile, TFolder } = require("obsidian");

  it("returns empty array for folder with no children", () => {
    const folder = new TFolder({ path: "empty" });
    folder.children = [];
    expect(getFilesFromFolder(folder)).toEqual([]);
  });

  it("returns files from folder", () => {
    const file1 = new TFile({ path: "folder/file1.md" });
    const file2 = new TFile({ path: "folder/file2.md" });
    const folder = new TFolder({ path: "folder" });
    folder.children = [file1, file2];

    const result = getFilesFromFolder(folder);
    expect(result).toHaveLength(2);
    expect(result).toContain(file1);
    expect(result).toContain(file2);
  });

  it("recursively gets files from subfolders", () => {
    const file1 = new TFile({ path: "parent/file1.md" });
    const file2 = new TFile({ path: "parent/child/file2.md" });
    const childFolder = new TFolder({ path: "parent/child" });
    childFolder.children = [file2];
    const parentFolder = new TFolder({ path: "parent" });
    parentFolder.children = [file1, childFolder];

    const result = getFilesFromFolder(parentFolder);
    expect(result).toHaveLength(2);
    expect(result).toContain(file1);
    expect(result).toContain(file2);
  });
});

describe("shouldExcludeFromSearch", () => {
  const { shouldExcludeFromSearch } = require("../utils");
  const { TFile } = require("obsidian");

  const createMockPlugin = (overrides: any = {}) => ({
    settings: {
      chatsDirectory: "SystemSculpt/Chats",
      embeddingsExclusions: {
        ignoreChatHistory: true,
        respectObsidianExclusions: false,
        folders: [],
        patterns: [],
        ...overrides.embeddingsExclusions,
      },
      ...overrides.settings,
    },
    app: {
      vault: {
        getConfig: jest.fn().mockReturnValue([]),
      },
    },
    ...overrides,
  });

  it("excludes files in chats directory", () => {
    const plugin = createMockPlugin();
    const file = new TFile({ path: "SystemSculpt/Chats/chat.md" });
    expect(shouldExcludeFromSearch(file, plugin)).toBe(true);
  });

  it("excludes .obsidian files", () => {
    const plugin = createMockPlugin();
    const file = new TFile({ path: ".obsidian/plugins/plugin.json" });
    file.extension = "json";
    expect(shouldExcludeFromSearch(file, plugin)).toBe(true);
  });

  it("excludes node_modules files", () => {
    const plugin = createMockPlugin();
    const file = new TFile({ path: "folder/node_modules/package.json" });
    file.extension = "json";
    expect(shouldExcludeFromSearch(file, plugin)).toBe(true);
  });

  it("excludes SystemSculpt internal directories", () => {
    const plugin = createMockPlugin();

    const recordingsFile = new TFile({ path: "SystemSculpt/Recordings/audio.md" });
    expect(shouldExcludeFromSearch(recordingsFile, plugin)).toBe(true);

    const promptsFile = new TFile({ path: "SystemSculpt/System Prompts/prompt.md" });
    expect(shouldExcludeFromSearch(promptsFile, plugin)).toBe(true);
  });

  it("excludes files in configured exclusion folders", () => {
    const plugin = createMockPlugin({
      settings: {
        embeddingsExclusions: {
          folders: ["private", "drafts"],
        },
      },
    });
    const file = new TFile({ path: "private/secret.md" });
    expect(shouldExcludeFromSearch(file, plugin)).toBe(true);
  });

  it("excludes files matching configured patterns", () => {
    const plugin = createMockPlugin({
      settings: {
        embeddingsExclusions: {
          patterns: ["\\.test\\."],
        },
      },
    });
    const file = new TFile({ path: "src/utils.test.ts" });
    file.extension = "ts";
    expect(shouldExcludeFromSearch(file, plugin)).toBe(true);
  });

  it("does not exclude regular files", () => {
    const plugin = createMockPlugin();
    const file = new TFile({ path: "notes/my-note.md" });
    expect(shouldExcludeFromSearch(file, plugin)).toBe(false);
  });

  it("handles invalid regex patterns gracefully", () => {
    const plugin = createMockPlugin({
      settings: {
        embeddingsExclusions: {
          patterns: ["[invalid"],
        },
      },
    });
    const file = new TFile({ path: "notes/file.md" });
    // Should not throw, just skip invalid pattern
    expect(shouldExcludeFromSearch(file, plugin)).toBe(false);
  });

  it("respects ignoreChatHistory setting when false", () => {
    const plugin = createMockPlugin({
      settings: {
        embeddingsExclusions: {
          ignoreChatHistory: false,
        },
      },
    });
    const file = new TFile({ path: "SystemSculpt/Chats/chat.md" });
    // Chat files should NOT be excluded when ignoreChatHistory is false
    expect(shouldExcludeFromSearch(file, plugin)).toBe(false);
  });

  it("respects Obsidian native exclusions", () => {
    const plugin = createMockPlugin({
      app: {
        vault: {
          getConfig: jest.fn().mockReturnValue(["^templates/"]),
        },
      },
    });
    plugin.settings.embeddingsExclusions.respectObsidianExclusions = true;

    const file = new TFile({ path: "templates/template.md" });
    expect(shouldExcludeFromSearch(file, plugin)).toBe(true);
  });

  it("handles getConfig throwing", () => {
    const plugin = createMockPlugin({
      app: {
        vault: {
          getConfig: jest.fn().mockImplementation(() => {
            throw new Error("Config unavailable");
          }),
        },
      },
    });
    plugin.settings.embeddingsExclusions.respectObsidianExclusions = true;

    const file = new TFile({ path: "regular/file.md" });
    // Should not throw, continue without native exclusions
    expect(shouldExcludeFromSearch(file, plugin)).toBe(false);
  });

  it("handles invalid Obsidian exclusion regex patterns", () => {
    const plugin = createMockPlugin({
      app: {
        vault: {
          getConfig: jest.fn().mockReturnValue(["[invalid"]),
        },
      },
    });
    plugin.settings.embeddingsExclusions.respectObsidianExclusions = true;

    const file = new TFile({ path: "regular/file.md" });
    // Should not throw, skip invalid pattern
    expect(shouldExcludeFromSearch(file, plugin)).toBe(false);
  });

  it("excludes Attachments and Extractions directories", () => {
    const plugin = createMockPlugin();

    const attachmentsFile = new TFile({ path: "SystemSculpt/Attachments/image.md" });
    expect(shouldExcludeFromSearch(attachmentsFile, plugin)).toBe(true);

    const extractionsFile = new TFile({ path: "SystemSculpt/Extractions/data.md" });
    expect(shouldExcludeFromSearch(extractionsFile, plugin)).toBe(true);
  });

  it("handles empty folder array in exclusions", () => {
    const plugin = createMockPlugin({
      settings: {
        embeddingsExclusions: {
          folders: ["", null, undefined],
        },
      },
    });
    const file = new TFile({ path: "regular/file.md" });
    expect(shouldExcludeFromSearch(file, plugin)).toBe(false);
  });
});

describe("ensureAdapterFolder", () => {
  const { ensureAdapterFolder } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates folder using fs.mkdir when basePath available", async () => {
    const mkdirSpy = jest.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const adapter = { getBasePath: () => "/vault" };

    await ensureAdapterFolder(adapter, "folder/path");

    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.stringContaining("folder"),
      { recursive: true }
    );
  });

  it("uses adapter.mkdir when no basePath", async () => {
    const mkdirMock = jest.fn().mockResolvedValue(undefined);
    const adapter = { getBasePath: () => null, mkdir: mkdirMock };

    await ensureAdapterFolder(adapter, "folder/path");

    expect(mkdirMock).toHaveBeenCalledWith("folder/path");
  });

  it("handles empty folderPath", async () => {
    const mkdirMock = jest.fn();
    const adapter = { getBasePath: () => null, mkdir: mkdirMock };

    await ensureAdapterFolder(adapter, "");

    expect(mkdirMock).not.toHaveBeenCalled();
  });
});

describe("adapterPathExists", () => {
  const { adapterPathExists } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns true when fs.access succeeds", async () => {
    jest.spyOn(fs, "access").mockResolvedValue(undefined);
    const adapter = { getBasePath: () => "/vault" };

    const result = await adapterPathExists(adapter, "file.md");

    expect(result).toBe(true);
  });

  it("returns false when fs.access fails", async () => {
    jest.spyOn(fs, "access").mockRejectedValue(new Error("ENOENT"));
    const adapter = { getBasePath: () => "/vault" };

    const result = await adapterPathExists(adapter, "file.md");

    expect(result).toBe(false);
  });

  it("uses adapter.exists when no basePath", async () => {
    const existsMock = jest.fn().mockResolvedValue(true);
    const adapter = { getBasePath: () => null, exists: existsMock };

    const result = await adapterPathExists(adapter, "file.md");

    expect(result).toBe(true);
    expect(existsMock).toHaveBeenCalledWith("file.md");
  });

  it("returns false when adapter.exists fails", async () => {
    const existsMock = jest.fn().mockRejectedValue(new Error("Error"));
    const adapter = { getBasePath: () => null, exists: existsMock };

    const result = await adapterPathExists(adapter, "file.md");

    expect(result).toBe(false);
  });

  it("returns false when no adapter methods available", async () => {
    const adapter = { getBasePath: () => null };

    const result = await adapterPathExists(adapter, "file.md");

    expect(result).toBe(false);
  });
});

describe("readAdapterText", () => {
  const { readAdapterText } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reads file using fs.readFile when basePath available", async () => {
    jest.spyOn(fs, "readFile").mockResolvedValue("file content");
    const adapter = { getBasePath: () => "/vault" };

    const result = await readAdapterText(adapter, "file.md");

    expect(result).toBe("file content");
  });

  it("uses adapter.read when no basePath", async () => {
    const readMock = jest.fn().mockResolvedValue("adapter content");
    const adapter = { getBasePath: () => null, read: readMock };

    const result = await readAdapterText(adapter, "file.md");

    expect(result).toBe("adapter content");
    expect(readMock).toHaveBeenCalledWith("file.md");
  });

  it("throws when no methods available", async () => {
    const adapter = { getBasePath: () => null };

    await expect(readAdapterText(adapter, "file.md")).rejects.toThrow("Adapter base path unavailable");
  });
});

describe("writeAdapterText", () => {
  const { writeAdapterText } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("writes file using fs.writeFile when basePath available", async () => {
    const writeSpy = jest.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const adapter = { getBasePath: () => "/vault" };

    await writeAdapterText(adapter, "file.md", "content");

    expect(writeSpy).toHaveBeenCalledWith(expect.any(String), "content", "utf8");
  });

  it("uses adapter.write when no basePath", async () => {
    const writeMock = jest.fn().mockResolvedValue(undefined);
    const adapter = { getBasePath: () => null, write: writeMock };

    await writeAdapterText(adapter, "file.md", "content");

    expect(writeMock).toHaveBeenCalledWith("file.md", "content");
  });

  it("throws when no methods available", async () => {
    const adapter = { getBasePath: () => null };

    await expect(writeAdapterText(adapter, "file.md", "content")).rejects.toThrow("Adapter base path unavailable");
  });
});

describe("statAdapterPath", () => {
  const { statAdapterPath } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns stat using fs.stat when basePath available", async () => {
    jest.spyOn(fs, "stat").mockResolvedValue({
      size: 1024,
      ctimeMs: 1000,
      mtimeMs: 2000,
    });
    const adapter = { getBasePath: () => "/vault" };

    const result = await statAdapterPath(adapter, "file.md");

    expect(result).toEqual({ size: 1024, ctime: 1000, mtime: 2000 });
  });

  it("uses adapter.stat when no basePath", async () => {
    const statMock = jest.fn().mockResolvedValue({ size: 512, ctime: 100, mtime: 200 });
    const adapter = { getBasePath: () => null, stat: statMock };

    const result = await statAdapterPath(adapter, "file.md");

    expect(result).toEqual({ size: 512, ctime: 100, mtime: 200 });
  });

  it("returns null when adapter.stat returns null", async () => {
    const statMock = jest.fn().mockResolvedValue(null);
    const adapter = { getBasePath: () => null, stat: statMock };

    const result = await statAdapterPath(adapter, "file.md");

    expect(result).toBeNull();
  });

  it("returns null when adapter.stat throws", async () => {
    const statMock = jest.fn().mockRejectedValue(new Error("Error"));
    const adapter = { getBasePath: () => null, stat: statMock };

    const result = await statAdapterPath(adapter, "file.md");

    expect(result).toBeNull();
  });

  it("returns null when no adapter methods available", async () => {
    const adapter = { getBasePath: () => null };

    const result = await statAdapterPath(adapter, "file.md");

    expect(result).toBeNull();
  });

  it("handles stat with missing fields", async () => {
    const statMock = jest.fn().mockResolvedValue({});
    const adapter = { getBasePath: () => null, stat: statMock };

    const result = await statAdapterPath(adapter, "file.md");

    expect(result).toEqual({
      size: 0,
      ctime: expect.any(Number),
      mtime: expect.any(Number),
    });
  });
});

describe("listAdapterFiles", () => {
  const { listAdapterFiles } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns empty array when no adapter", async () => {
    const result = await listAdapterFiles(null, "folder");
    expect(result).toEqual([]);
  });

  it("returns empty array when adapter has no list method", async () => {
    const adapter = { getBasePath: () => null };
    const result = await listAdapterFiles(adapter, "folder");
    expect(result).toEqual([]);
  });

  it("returns empty array when root is empty", async () => {
    const adapter = { getBasePath: () => null, list: jest.fn() };
    const result = await listAdapterFiles(adapter, "");
    expect(result).toEqual([]);
  });

  it("uses adapter.list when no basePath", async () => {
    const listMock = jest.fn().mockResolvedValue({
      files: ["folder/file1.md", "folder/file2.md"],
      folders: [],
    });
    const adapter = { getBasePath: () => null, list: listMock };

    const result = await listAdapterFiles(adapter, "folder");

    expect(result).toContain("folder/file1.md");
    expect(result).toContain("folder/file2.md");
  });

  it("handles nested folders via adapter.list", async () => {
    const listMock = jest.fn()
      .mockResolvedValueOnce({
        files: ["folder/file.md"],
        folders: ["folder/sub"],
      })
      .mockResolvedValueOnce({
        files: ["folder/sub/nested.md"],
        folders: [],
      });
    const adapter = { getBasePath: () => null, list: listMock };

    const result = await listAdapterFiles(adapter, "folder");

    expect(result).toContain("folder/file.md");
    expect(result).toContain("folder/sub/nested.md");
  });

  it("handles adapter.list throwing", async () => {
    const listMock = jest.fn().mockRejectedValue(new Error("Error"));
    const adapter = { getBasePath: () => null, list: listMock };

    const result = await listAdapterFiles(adapter, "folder");

    expect(result).toEqual([]);
  });

  it("walks directories using fs when basePath available", async () => {
    const readdirMock = jest.spyOn(fs, "readdir");
    readdirMock.mockResolvedValueOnce([
      { name: "file.md", isDirectory: () => false, isFile: () => true },
      { name: "subfolder", isDirectory: () => true, isFile: () => false },
    ]);
    readdirMock.mockResolvedValueOnce([
      { name: "nested.md", isDirectory: () => false, isFile: () => true },
    ]);

    const adapter = { getBasePath: () => "/vault" };

    const result = await listAdapterFiles(adapter, "folder");

    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe("listAdapterDirectory", () => {
  const { listAdapterDirectory } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses adapter.list when no basePath", async () => {
    const listMock = jest.fn().mockResolvedValue({
      files: ["folder/file.md"],
      folders: ["folder/sub"],
    });
    const adapter = { getBasePath: () => null, list: listMock };

    const result = await listAdapterDirectory(adapter, "folder");

    expect(result.files).toEqual(["folder/file.md"]);
    expect(result.folders).toEqual(["folder/sub"]);
  });

  it("handles empty listing from adapter.list", async () => {
    const listMock = jest.fn().mockResolvedValue({});
    const adapter = { getBasePath: () => null, list: listMock };

    const result = await listAdapterDirectory(adapter, "folder");

    expect(result.files).toEqual([]);
    expect(result.folders).toEqual([]);
  });

  it("throws when no methods available", async () => {
    const adapter = { getBasePath: () => null };

    await expect(listAdapterDirectory(adapter, "folder")).rejects.toThrow("Adapter base path unavailable");
  });

  it("reads directory using fs when basePath available", async () => {
    jest.spyOn(fs, "readdir").mockResolvedValue([
      { name: "file.md", isDirectory: () => false, isFile: () => true },
      { name: "subfolder", isDirectory: () => true, isFile: () => false },
    ] as any);

    const adapter = { getBasePath: () => "/vault" };

    const result = await listAdapterDirectory(adapter, "folder");

    expect(result.files).toContain("folder/file.md");
    expect(result.folders).toContain("folder/subfolder");
  });

  it("handles root directory", async () => {
    jest.spyOn(fs, "readdir").mockResolvedValue([
      { name: "root.md", isDirectory: () => false, isFile: () => true },
    ] as any);

    const adapter = { getBasePath: () => "/vault" };

    const result = await listAdapterDirectory(adapter, "");

    expect(result.files).toContain("root.md");
  });
});

describe("createSimpleDiff additional coverage", () => {
  const { createSimpleDiff } = require("../utils");

  it("handles single line removal at end", () => {
    const original = "line1\nline2\nline3\nline4";
    const modified = "line1\nline2\nline3";

    const result = createSimpleDiff(original, modified, "test.md");

    expect(result).toContain("- line4");
  });

  it("handles single line addition at end", () => {
    const original = "line1\nline2";
    const modified = "line1\nline2\nline3";

    const result = createSimpleDiff(original, modified, "test.md");

    expect(result).toContain("+ line3");
  });

  it("handles empty original", () => {
    const original = "";
    const modified = "line1";

    const result = createSimpleDiff(original, modified, "test.md");

    expect(result).toContain("+ line1");
  });

  it("handles empty modified", () => {
    const original = "line1";
    const modified = "";

    const result = createSimpleDiff(original, modified, "test.md");

    expect(result).toContain("- line1");
  });
});

describe("listAdapterFiles with fs.readdir error", () => {
  const { listAdapterFiles } = require("../utils");
  const fs = require("node:fs/promises");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("handles fs.readdir throwing error", async () => {
    jest.spyOn(fs, "readdir").mockRejectedValue(new Error("Permission denied"));

    const adapter = { getBasePath: () => "/vault" };

    const result = await listAdapterFiles(adapter, "folder");

    // Should not throw, just return what it can
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("createLineCalculator additional coverage", () => {
  const { createLineCalculator } = require("../utils");

  it("returns line count for index at end", () => {
    const content = "line1\nline2\nline3";
    const calc = createLineCalculator(content);
    // Index at the very end
    expect(calc(content.length)).toBe(3);
  });

  it("handles index beyond content length", () => {
    const content = "abc";
    const calc = createLineCalculator(content);
    expect(calc(100)).toBe(1);
  });

  it("handles content with many lines", () => {
    const content = Array(100).fill("line").join("\n");
    const calc = createLineCalculator(content);
    expect(calc(0)).toBe(1);
    expect(calc(content.length - 1)).toBeGreaterThan(50);
  });
});

describe("evaluateQuery additional coverage", () => {
  const { evaluateQuery } = require("../utils");

  it("equals with same non-date values", () => {
    expect(evaluateQuery("test", "equals", "test")).toBe(true);
  });

  it("not_equals with numbers", () => {
    expect(evaluateQuery(5, "not_equals", 10)).toBe(true);
  });

  it("contains with empty array", () => {
    expect(evaluateQuery([], "contains", "x")).toBe(false);
  });

  it("starts_with with empty string", () => {
    expect(evaluateQuery("hello", "starts_with", "")).toBe(true);
  });

  it("greater_than with equal values", () => {
    expect(evaluateQuery(5, "greater_than", 5)).toBe(false);
  });

  it("less_than with equal values", () => {
    expect(evaluateQuery(5, "less_than", 5)).toBe(false);
  });
});

describe("normalizeLineEndings additional coverage", () => {
  const { normalizeLineEndings } = require("../utils");

  it("handles multiple CRLF in sequence", () => {
    expect(normalizeLineEndings("a\r\n\r\nb")).toBe("a\n\nb");
  });

  it("handles only CRLF content", () => {
    expect(normalizeLineEndings("\r\n\r\n")).toBe("\n\n");
  });
});
