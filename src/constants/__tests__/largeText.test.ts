/**
 * @jest-environment node
 */
import {
  LARGE_TEXT_THRESHOLDS,
  LARGE_TEXT_MESSAGES,
  LARGE_TEXT_UI,
  LargeTextHelpers,
} from "../largeText";

describe("LARGE_TEXT_THRESHOLDS", () => {
  it("has soft warning at 100KB", () => {
    expect(LARGE_TEXT_THRESHOLDS.SOFT_WARNING_KB).toBe(100);
  });

  it("has hard warning at 512KB", () => {
    expect(LARGE_TEXT_THRESHOLDS.HARD_WARNING_KB).toBe(512);
  });

  it("has max size at 1024KB (1MB)", () => {
    expect(LARGE_TEXT_THRESHOLDS.MAX_SIZE_KB).toBe(1024);
  });

  it("has max lines preview at 5", () => {
    expect(LARGE_TEXT_THRESHOLDS.MAX_LINES_PREVIEW).toBe(5);
  });

  it("has collapse threshold at 300 lines", () => {
    expect(LARGE_TEXT_THRESHOLDS.COLLAPSE_THRESHOLD_LINES).toBe(300);
  });

  it("has chunk size at 1000 chars", () => {
    expect(LARGE_TEXT_THRESHOLDS.CHUNK_SIZE_CHARS).toBe(1000);
  });

  it("has bytes per KB at 1024", () => {
    expect(LARGE_TEXT_THRESHOLDS.BYTES_PER_KB).toBe(1024);
  });
});

describe("LARGE_TEXT_MESSAGES", () => {
  it("has size error message", () => {
    expect(LARGE_TEXT_MESSAGES.SIZE_ERROR).toContain("too large");
  });

  it("has size warning prefix", () => {
    expect(LARGE_TEXT_MESSAGES.SIZE_WARNING_PREFIX).toContain("Large text");
  });

  it("has processing message", () => {
    expect(LARGE_TEXT_MESSAGES.PROCESSING).toContain("Processing");
  });

  it("has completed message", () => {
    expect(LARGE_TEXT_MESSAGES.COMPLETED).toContain("completed");
  });

  it("has confirmation prefix", () => {
    expect(LARGE_TEXT_MESSAGES.CONFIRMATION_PREFIX).toContain("processed");
  });

  it("has truncation indicator", () => {
    expect(LARGE_TEXT_MESSAGES.TRUNCATION_INDICATOR).toContain("truncated");
  });
});

describe("LARGE_TEXT_UI", () => {
  it("has placeholder prefix", () => {
    expect(LARGE_TEXT_UI.PLACEHOLDER_PREFIX).toBe("[PASTED TEXT - ");
  });

  it("has placeholder suffix", () => {
    expect(LARGE_TEXT_UI.PLACEHOLDER_SUFFIX).toBe(" LINES OF TEXT]");
  });

  it("has stats prefix", () => {
    expect(LARGE_TEXT_UI.STATS_PREFIX).toContain("Large text content");
  });

  it("has modal title suffix", () => {
    expect(LARGE_TEXT_UI.MODAL_TITLE_SUFFIX).toContain("lines");
  });
});

describe("LargeTextHelpers", () => {
  describe("getTextSizeKB", () => {
    it("returns 0 for empty string", () => {
      expect(LargeTextHelpers.getTextSizeKB("")).toBe(0);
    });

    it("returns correct size for ASCII text", () => {
      // 1024 ASCII characters = 1 KB
      const text = "a".repeat(1024);
      expect(LargeTextHelpers.getTextSizeKB(text)).toBe(1);
    });

    it("handles unicode characters", () => {
      // Unicode chars take more bytes
      const text = "你好世界"; // 4 Chinese characters
      expect(LargeTextHelpers.getTextSizeKB(text)).toBeGreaterThan(0);
    });
  });

  describe("getLineCount", () => {
    it("returns 1 for text without newlines", () => {
      expect(LargeTextHelpers.getLineCount("single line")).toBe(1);
    });

    it("returns 1 for empty string", () => {
      expect(LargeTextHelpers.getLineCount("")).toBe(1);
    });

    it("counts lines correctly", () => {
      expect(LargeTextHelpers.getLineCount("line1\nline2\nline3")).toBe(3);
    });

    it("handles trailing newline", () => {
      expect(LargeTextHelpers.getLineCount("line1\nline2\n")).toBe(3);
    });

    it("handles multiple empty lines", () => {
      expect(LargeTextHelpers.getLineCount("line1\n\n\nline4")).toBe(4);
    });
  });

  describe("shouldCollapseInHistory", () => {
    it("returns false for small text", () => {
      expect(LargeTextHelpers.shouldCollapseInHistory("short text")).toBe(false);
    });

    it("returns true for text over soft warning KB", () => {
      const largeText = "a".repeat(105000); // ~102KB - over 100KB threshold
      expect(LargeTextHelpers.shouldCollapseInHistory(largeText)).toBe(true);
    });

    it("returns true for text with many lines", () => {
      const manyLines = "line\n".repeat(350);
      expect(LargeTextHelpers.shouldCollapseInHistory(manyLines)).toBe(true);
    });

    it("returns false for text just under thresholds", () => {
      const justUnder = "line\n".repeat(200);
      expect(LargeTextHelpers.shouldCollapseInHistory(justUnder)).toBe(false);
    });
  });

  describe("getTextWarningLevel", () => {
    it("returns 'none' for small text", () => {
      expect(LargeTextHelpers.getTextWarningLevel("hello world")).toBe("none");
    });

    it("returns 'soft' for text between 100KB and 512KB", () => {
      const mediumText = "a".repeat(200 * 1024); // ~200KB
      expect(LargeTextHelpers.getTextWarningLevel(mediumText)).toBe("soft");
    });

    it("returns 'hard' for text between 512KB and 1MB", () => {
      const largeText = "a".repeat(700 * 1024); // ~700KB
      expect(LargeTextHelpers.getTextWarningLevel(largeText)).toBe("hard");
    });

    it("returns 'error' for text over 1MB", () => {
      const hugeText = "a".repeat(1100 * 1024); // ~1100KB
      expect(LargeTextHelpers.getTextWarningLevel(hugeText)).toBe("error");
    });
  });

  describe("createPlaceholder", () => {
    it("creates placeholder with line count", () => {
      const placeholder = LargeTextHelpers.createPlaceholder(100);
      expect(placeholder).toBe("[PASTED TEXT - 100 LINES OF TEXT]");
    });

    it("works with zero lines", () => {
      const placeholder = LargeTextHelpers.createPlaceholder(0);
      expect(placeholder).toBe("[PASTED TEXT - 0 LINES OF TEXT]");
    });

    it("works with large line counts", () => {
      const placeholder = LargeTextHelpers.createPlaceholder(10000);
      expect(placeholder).toContain("10000");
    });
  });

  describe("containsPlaceholder", () => {
    it("returns true for text with placeholder", () => {
      const text = "Some text [PASTED TEXT - 50 LINES OF TEXT] more text";
      expect(LargeTextHelpers.containsPlaceholder(text)).toBe(true);
    });

    it("returns false for regular text", () => {
      expect(LargeTextHelpers.containsPlaceholder("normal text")).toBe(false);
    });

    it("returns false for partial placeholder", () => {
      expect(LargeTextHelpers.containsPlaceholder("[PASTED TEXT - ")).toBe(false);
      expect(LargeTextHelpers.containsPlaceholder(" LINES OF TEXT]")).toBe(false);
    });

    it("returns true when placeholder is the entire text", () => {
      const placeholder = LargeTextHelpers.createPlaceholder(25);
      expect(LargeTextHelpers.containsPlaceholder(placeholder)).toBe(true);
    });
  });

  describe("getPreviewContent", () => {
    it("returns all content for short text", () => {
      const text = "line1\nline2\nline3";
      expect(LargeTextHelpers.getPreviewContent(text)).toBe(text);
    });

    it("returns first 5 lines for long text", () => {
      const text = "line1\nline2\nline3\nline4\nline5\nline6\nline7";
      const preview = LargeTextHelpers.getPreviewContent(text);
      expect(preview).toBe("line1\nline2\nline3\nline4\nline5");
    });

    it("returns empty string for empty text", () => {
      expect(LargeTextHelpers.getPreviewContent("")).toBe("");
    });

    it("handles text with exactly 5 lines", () => {
      const text = "1\n2\n3\n4\n5";
      expect(LargeTextHelpers.getPreviewContent(text)).toBe(text);
    });
  });

  describe("formatSize", () => {
    it("rounds to nearest integer", () => {
      expect(LargeTextHelpers.formatSize(100.4)).toBe("100KB");
      expect(LargeTextHelpers.formatSize(100.5)).toBe("101KB");
    });

    it("handles zero", () => {
      expect(LargeTextHelpers.formatSize(0)).toBe("0KB");
    });

    it("handles large numbers", () => {
      expect(LargeTextHelpers.formatSize(1024)).toBe("1024KB");
    });

    it("handles decimal values", () => {
      expect(LargeTextHelpers.formatSize(50.7)).toBe("51KB");
    });
  });
});
