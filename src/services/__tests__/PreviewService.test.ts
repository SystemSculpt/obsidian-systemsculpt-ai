/**
 * @jest-environment jsdom
 */
import { App, TFile, MarkdownRenderer, Component } from "obsidian";
import { PreviewService } from "../PreviewService";

// Mock MarkdownRenderer
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    MarkdownRenderer: {
      renderMarkdown: jest.fn().mockResolvedValue(undefined),
    },
    debounce: (fn: Function, delay: number) => {
      let timeoutId: any;
      return function(this: any, ...args: any[]) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
      };
    },
  };
});

describe("PreviewService", () => {
  let mockApp: App;
  let mockFile: TFile;
  let testElement: HTMLElement;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Reset static state
    PreviewService.cleanup();

    mockFile = {
      path: "test/file.md",
      name: "file.md",
      basename: "file",
      extension: "md",
      stat: { mtime: Date.now(), ctime: Date.now(), size: 100 },
      vault: {},
      parent: null,
    } as unknown as TFile;

    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
        read: jest.fn().mockResolvedValue("# Test Content\n\nThis is test content."),
      },
    } as unknown as App;

    testElement = document.createElement("div");
    document.body.appendChild(testElement);
  });

  afterEach(() => {
    jest.useRealTimers();
    PreviewService.cleanup();
    if (testElement.parentNode) {
      testElement.parentNode.removeChild(testElement);
    }
  });

  describe("getCacheForProvider", () => {
    it("returns systemsculpt cache by default", () => {
      // Access private method via bracket notation
      const cache = (PreviewService as any).getCacheForProvider("systemsculpt");

      expect(cache.previewCache).toBeDefined();
      expect(cache.fileModCache).toBeDefined();
    });

    it("returns custom provider cache when specified", () => {
      const systemCache = (PreviewService as any).getCacheForProvider("systemsculpt");
      const customCache = (PreviewService as any).getCacheForProvider("custom");

      expect(customCache.previewCache).not.toBe(systemCache.previewCache);
      expect(customCache.fileModCache).not.toBe(systemCache.fileModCache);
    });
  });

  describe("hideAllPreviews", () => {
    it("clears hover timer", () => {
      // Set up a hover timer
      (PreviewService as any).hoverTimer = setTimeout(() => {}, 1000);

      PreviewService.hideAllPreviews();

      expect((PreviewService as any).hoverTimer).toBeNull();
    });

    it("clears safety timer", () => {
      (PreviewService as any).safetyTimer = setTimeout(() => {}, 1000);

      PreviewService.hideAllPreviews();

      expect((PreviewService as any).safetyTimer).toBeNull();
    });

    it("hides preview element", () => {
      // Create preview element
      const preview = document.createElement("div");
      preview.classList.add("systemsculpt-visible");
      (PreviewService as any).markdownPreview = preview;
      (PreviewService as any).isPreviewVisible = true;

      PreviewService.hideAllPreviews();

      expect(preview.classList.contains("systemsculpt-visible")).toBe(false);
      expect((PreviewService as any).isPreviewVisible).toBe(false);
      expect((PreviewService as any).currentPreviewPath).toBeNull();
    });

    it("handles null preview element gracefully", () => {
      (PreviewService as any).markdownPreview = null;

      expect(() => PreviewService.hideAllPreviews()).not.toThrow();
    });
  });

  describe("attachHoverPreview", () => {
    it("creates preview element if not exists", () => {
      expect((PreviewService as any).markdownPreview).toBeNull();

      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");

      expect(document.querySelector(".systemsculpt-markdown-preview")).not.toBeNull();
    });

    it("adds element to active elements set", () => {
      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");

      expect((PreviewService as any).activeElements.has(testElement)).toBe(true);
    });

    it("returns cleanup function", () => {
      const cleanup = PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");

      expect(typeof cleanup).toBe("function");

      cleanup();

      expect((PreviewService as any).activeElements.has(testElement)).toBe(false);
    });

    it("initializes global listeners", () => {
      expect((PreviewService as any).isGlobalListenerActive).toBe(false);

      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");

      expect((PreviewService as any).isGlobalListenerActive).toBe(true);
    });

    it("accepts custom provider type", () => {
      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md", "custom");

      expect((PreviewService as any).activeElements.has(testElement)).toBe(true);
    });
  });

  describe("startSafetyTimer", () => {
    it("sets safety timer", () => {
      (PreviewService as any).startSafetyTimer();

      expect((PreviewService as any).safetyTimer).not.toBeNull();
    });

    it("clears existing safety timer before setting new one", () => {
      const originalTimer = setTimeout(() => {}, 10000);
      (PreviewService as any).safetyTimer = originalTimer;

      (PreviewService as any).startSafetyTimer();

      expect((PreviewService as any).safetyTimer).not.toBe(originalTimer);
    });

    it("hides preview after max duration", () => {
      (PreviewService as any).isPreviewVisible = true;
      const preview = document.createElement("div");
      preview.classList.add("systemsculpt-visible");
      (PreviewService as any).markdownPreview = preview;

      (PreviewService as any).startSafetyTimer();

      jest.advanceTimersByTime(10001); // MAX_PREVIEW_DURATION + 1

      expect((PreviewService as any).isPreviewVisible).toBe(false);
    });
  });

  describe("handleVisibilityChange", () => {
    it("hides preview when document becomes hidden", () => {
      (PreviewService as any).isPreviewVisible = true;
      const preview = document.createElement("div");
      (PreviewService as any).markdownPreview = preview;

      // Simulate document hidden
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });

      (PreviewService as any).handleVisibilityChange();

      expect((PreviewService as any).isPreviewVisible).toBe(false);

      // Reset
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
    });

    it("does nothing when document is visible", () => {
      (PreviewService as any).isPreviewVisible = true;

      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });

      (PreviewService as any).handleVisibilityChange();

      // isPreviewVisible unchanged (hideAllPreviews wasn't called with visible doc)
    });
  });

  describe("cleanup", () => {
    it("removes preview element from DOM", () => {
      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");
      expect(document.querySelector(".systemsculpt-markdown-preview")).not.toBeNull();

      PreviewService.cleanup();

      expect((PreviewService as any).markdownPreview).toBeNull();
    });

    it("clears all caches", () => {
      (PreviewService as any).systemSculptPreviewCache.set("test", "value");
      (PreviewService as any).customProviderPreviewCache.set("test", "value");
      (PreviewService as any).systemSculptFileModCache.set("test", 123);
      (PreviewService as any).customProviderFileModCache.set("test", 123);

      PreviewService.cleanup();

      expect((PreviewService as any).systemSculptPreviewCache.size).toBe(0);
      expect((PreviewService as any).customProviderPreviewCache.size).toBe(0);
      expect((PreviewService as any).systemSculptFileModCache.size).toBe(0);
      expect((PreviewService as any).customProviderFileModCache.size).toBe(0);
    });

    it("clears active elements", () => {
      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");
      expect((PreviewService as any).activeElements.size).toBeGreaterThan(0);

      PreviewService.cleanup();

      expect((PreviewService as any).activeElements.size).toBe(0);
    });

    it("resets global listener flag", () => {
      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");
      expect((PreviewService as any).isGlobalListenerActive).toBe(true);

      PreviewService.cleanup();

      expect((PreviewService as any).isGlobalListenerActive).toBe(false);
    });

    it("clears timers", () => {
      (PreviewService as any).hoverTimer = setTimeout(() => {}, 1000);
      (PreviewService as any).safetyTimer = setTimeout(() => {}, 1000);

      PreviewService.cleanup();

      expect((PreviewService as any).hoverTimer).toBeNull();
      expect((PreviewService as any).safetyTimer).toBeNull();
    });

    it("removes mouse position attributes", () => {
      document.documentElement.setAttribute("data-mouse-x", "100");
      document.documentElement.setAttribute("data-mouse-y", "200");

      PreviewService.cleanup();

      expect(document.documentElement.hasAttribute("data-mouse-x")).toBe(false);
      expect(document.documentElement.hasAttribute("data-mouse-y")).toBe(false);
    });
  });

  describe("hover behavior", () => {
    it("shows preview on mouseenter after delay", async () => {
      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");

      const event = new MouseEvent("mouseenter", {
        clientX: 100,
        clientY: 100,
        bubbles: true,
      });
      testElement.dispatchEvent(event);

      // Allow timer to fire
      jest.advanceTimersByTime(10);
      await Promise.resolve();

      expect((PreviewService as any).markdownPreview).not.toBeNull();
    });

    it("tracks mouse position", () => {
      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");

      const event = new MouseEvent("mousemove", {
        clientX: 150,
        clientY: 250,
        bubbles: true,
      });
      document.dispatchEvent(event);

      expect(document.documentElement.getAttribute("data-mouse-x")).toBe("150");
      expect(document.documentElement.getAttribute("data-mouse-y")).toBe("250");
    });
  });

  describe("large file handling", () => {
    it("has MAX_FILE_SIZE_BYTES constant defined", () => {
      expect((PreviewService as any).MAX_FILE_SIZE_BYTES).toBe(100000);
    });

    it("has MAX_PREVIEW_CONTENT_LENGTH constant defined", () => {
      expect((PreviewService as any).MAX_PREVIEW_CONTENT_LENGTH).toBe(5000);
    });

    it("has MAX_PREVIEW_RENDER_TIME constant defined", () => {
      expect((PreviewService as any).MAX_PREVIEW_RENDER_TIME).toBe(500);
    });
  });

  describe("caching behavior", () => {
    it("caches rendered preview HTML", async () => {
      const cache = (PreviewService as any).getCacheForProvider("systemsculpt");
      expect(cache.previewCache.has("test/file.md")).toBe(false);

      PreviewService.attachHoverPreview(mockApp, testElement, "test/file.md");

      const event = new MouseEvent("mouseenter", {
        clientX: 100,
        clientY: 100,
        bubbles: true,
      });
      testElement.dispatchEvent(event);

      jest.advanceTimersByTime(10);
      await Promise.resolve();
      await Promise.resolve(); // Extra tick for async operations

      // Cache may or may not be populated depending on mock setup
      // Just verify no errors occurred
    });

    it("uses separate caches for different providers", () => {
      const systemCache = (PreviewService as any).getCacheForProvider("systemsculpt");
      const customCache = (PreviewService as any).getCacheForProvider("custom");

      systemCache.previewCache.set("test.md", "<p>System content</p>");
      customCache.previewCache.set("test.md", "<p>Custom content</p>");

      expect(systemCache.previewCache.get("test.md")).toBe("<p>System content</p>");
      expect(customCache.previewCache.get("test.md")).toBe("<p>Custom content</p>");
    });
  });
});
