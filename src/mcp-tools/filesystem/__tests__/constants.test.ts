/**
 * @jest-environment node
 */
import {
  FILESYSTEM_LIMITS,
  TOOL_DISPLAY_NAMES,
  TOOL_DISPLAY_DESCRIPTIONS,
} from "../constants";

describe("MCP Filesystem Constants", () => {
  describe("FILESYSTEM_LIMITS", () => {
    it("has MAX_FILE_READ_LENGTH set to 25000", () => {
      expect(FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH).toBe(25000);
    });

    it("has MAX_LINE_LENGTH set to 2000", () => {
      expect(FILESYSTEM_LIMITS.MAX_LINE_LENGTH).toBe(2000);
    });

    it("has MAX_OPERATIONS set to 100", () => {
      expect(FILESYSTEM_LIMITS.MAX_OPERATIONS).toBe(100);
    });

    it("has MAX_SEARCH_RESULTS set to 25", () => {
      expect(FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS).toBe(25);
    });

    it("has MAX_FILE_SIZE set to 200000", () => {
      expect(FILESYSTEM_LIMITS.MAX_FILE_SIZE).toBe(200000);
    });

    it("has MAX_CONTENT_SIZE set to 250000", () => {
      expect(FILESYSTEM_LIMITS.MAX_CONTENT_SIZE).toBe(250000);
    });

    it("has HARD_LIMIT equal to MAX_FILE_READ_LENGTH", () => {
      expect(FILESYSTEM_LIMITS.HARD_LIMIT).toBe(FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH);
    });

    it("has MAX_RESPONSE_CHARS set to 25000", () => {
      expect(FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS).toBe(25000);
    });

    it("has CONTEXT_CHARS set to 200", () => {
      expect(FILESYSTEM_LIMITS.CONTEXT_CHARS).toBe(200);
    });

    it("has BATCH_SIZE set to 15", () => {
      expect(FILESYSTEM_LIMITS.BATCH_SIZE).toBe(15);
    });

    it("has MAX_PROCESSING_TIME set to 8000ms", () => {
      expect(FILESYSTEM_LIMITS.MAX_PROCESSING_TIME).toBe(8000);
    });

    it("has MAX_MATCHES_PER_FILE set to 20", () => {
      expect(FILESYSTEM_LIMITS.MAX_MATCHES_PER_FILE).toBe(20);
    });

    it("has MAX_TOTAL_FILES_PROCESSED set to 1000", () => {
      expect(FILESYSTEM_LIMITS.MAX_TOTAL_FILES_PROCESSED).toBe(1000);
    });

    it("has MAX_FILES_PER_REQUEST set to 10", () => {
      expect(FILESYSTEM_LIMITS.MAX_FILES_PER_REQUEST).toBe(10);
    });

    it("has CONCURRENCY_LIMIT set to 10", () => {
      expect(FILESYSTEM_LIMITS.CONCURRENCY_LIMIT).toBe(10);
    });

    it("has MAX_TOOL_RESULT_TOKENS set to 2048", () => {
      expect(FILESYSTEM_LIMITS.MAX_TOOL_RESULT_TOKENS).toBe(2048);
    });

    it("has GREP_BODY_TOKENS set to 1900", () => {
      expect(FILESYSTEM_LIMITS.GREP_BODY_TOKENS).toBe(1900);
    });

    it("has GREP_FOOTER_TOKENS set to 148", () => {
      expect(FILESYSTEM_LIMITS.GREP_FOOTER_TOKENS).toBe(148);
    });

    it("GREP tokens sum is at most MAX_TOOL_RESULT_TOKENS", () => {
      const sum = FILESYSTEM_LIMITS.GREP_BODY_TOKENS + FILESYSTEM_LIMITS.GREP_FOOTER_TOKENS;
      expect(sum).toBeLessThanOrEqual(FILESYSTEM_LIMITS.MAX_TOOL_RESULT_TOKENS);
    });

    it("all values are positive", () => {
      Object.entries(FILESYSTEM_LIMITS).forEach(([key, value]) => {
        expect(value).toBeGreaterThan(0);
      });
    });

    it("all values are numbers", () => {
      Object.values(FILESYSTEM_LIMITS).forEach((value) => {
        expect(typeof value).toBe("number");
      });
    });
  });

  describe("TOOL_DISPLAY_NAMES", () => {
    it("has display name for read", () => {
      expect(TOOL_DISPLAY_NAMES.read).toBe("Read Files");
    });

    it("has display name for write", () => {
      expect(TOOL_DISPLAY_NAMES.write).toBe("Write File");
    });

    it("has display name for edit", () => {
      expect(TOOL_DISPLAY_NAMES.edit).toBe("Edit File");
    });

    it("has display name for create_folders", () => {
      expect(TOOL_DISPLAY_NAMES.create_folders).toBe("Create Folders");
    });

    it("has display name for list_items", () => {
      expect(TOOL_DISPLAY_NAMES.list_items).toBe("List Directory");
    });

    it("has display name for move", () => {
      expect(TOOL_DISPLAY_NAMES.move).toBe("Move/Rename");
    });

    it("has display name for trash", () => {
      expect(TOOL_DISPLAY_NAMES.trash).toBe("Move to Trash");
    });

    it("has display name for find", () => {
      expect(TOOL_DISPLAY_NAMES.find).toBe("Find by Name");
    });

    it("has display name for search", () => {
      expect(TOOL_DISPLAY_NAMES.search).toBe("Search Contents");
    });

    it("has display name for open", () => {
      expect(TOOL_DISPLAY_NAMES.open).toBe("Open in Obsidian");
    });

    it("has display name for context", () => {
      expect(TOOL_DISPLAY_NAMES.context).toBe("Manage Context");
    });

    it("all display names are non-empty strings", () => {
      Object.values(TOOL_DISPLAY_NAMES).forEach((name) => {
        expect(typeof name).toBe("string");
        expect(name.length).toBeGreaterThan(0);
      });
    });
  });

  describe("TOOL_DISPLAY_DESCRIPTIONS", () => {
    it("has description for read", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.read).toContain("Read file");
    });

    it("has description for write", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.write).toContain("Create");
    });

    it("has description for edit", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.edit).toContain("edit");
    });

    it("has description for create_folders", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.create_folders).toContain("directories");
    });

    it("has description for list_items", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.list_items).toContain("List");
    });

    it("has description for move", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.move).toContain("Move");
    });

    it("has description for trash", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.trash).toContain("trash");
    });

    it("has description for find", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.find).toContain("Search");
    });

    it("has description for search", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.search).toContain("search");
    });

    it("has description for open", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.open).toContain("Open");
    });

    it("has description for context", () => {
      expect(TOOL_DISPLAY_DESCRIPTIONS.context).toContain("context");
    });

    it("all descriptions are non-empty strings", () => {
      Object.values(TOOL_DISPLAY_DESCRIPTIONS).forEach((desc) => {
        expect(typeof desc).toBe("string");
        expect(desc.length).toBeGreaterThan(10);
      });
    });

    it("descriptions match corresponding display names", () => {
      Object.keys(TOOL_DISPLAY_NAMES).forEach((key) => {
        expect(TOOL_DISPLAY_DESCRIPTIONS[key]).toBeDefined();
      });
    });
  });
});
