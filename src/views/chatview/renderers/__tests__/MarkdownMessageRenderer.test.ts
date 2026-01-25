/**
 * @jest-environment jsdom
 */
import { App, Component, MarkdownRenderer } from "obsidian";
import { MarkdownMessageRenderer } from "../MarkdownMessageRenderer";

// Mock MarkdownRenderer
jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    MarkdownRenderer: {
      render: jest.fn().mockResolvedValue(undefined),
    },
  };
});

describe("MarkdownMessageRenderer", () => {
  let renderer: MarkdownMessageRenderer;
  let mockApp: App;
  let containerEl: HTMLElement;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockApp = new App();
    renderer = new MarkdownMessageRenderer(mockApp);
    containerEl = document.createElement("div");
    document.body.appendChild(containerEl);
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.removeChild(containerEl);
  });

  describe("render", () => {
    it("renders markdown content", async () => {
      await renderer.render("# Hello World", containerEl);

      expect(MarkdownRenderer.render).toHaveBeenCalledWith(
        mockApp,
        "# Hello World",
        containerEl,
        "systemsculpt-chat.md",
        expect.any(Object)
      );
    });

    it("throttles streaming renders", async () => {
      await renderer.render("Chunk 1", containerEl, true);
      await renderer.render("Chunk 2", containerEl, true);
      await renderer.render("Chunk 3", containerEl, true);

      // Should only schedule one render
      expect(MarkdownRenderer.render).not.toHaveBeenCalled();

      jest.advanceTimersByTime(150);
      await Promise.resolve();

      expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
      // Should use the latest content
      expect(MarkdownRenderer.render).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining("Chunk 3"),
        containerEl,
        expect.any(String),
        expect.any(Object)
      );
    });

    it("clears pending timeout on final render", async () => {
      // Start streaming
      await renderer.render("Streaming...", containerEl, true);

      // Final render should clear the timeout
      await renderer.render("Final content", containerEl, false);

      expect(MarkdownRenderer.render).toHaveBeenCalledWith(
        mockApp,
        "Final content",
        containerEl,
        expect.any(String),
        expect.any(Object)
      );
    });

    it("preprocesses mermaid diagrams", async () => {
      const markdown = "```mermaid\ngraph TD\nA[Label Text]\n```";

      await renderer.render(markdown, containerEl);

      expect(MarkdownRenderer.render).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining('A["Label Text"]'),
        containerEl,
        expect.any(String),
        expect.any(Object)
      );
    });

    it("empties container before rendering", async () => {
      containerEl.innerHTML = "<p>Old content</p>";

      await renderer.render("New content", containerEl);

      // empty() is called before rendering
      expect(containerEl.innerHTML).toBe("");
    });
  });

  describe("renderCitations", () => {
    it("does nothing when citations array is empty", () => {
      renderer.renderCitations(containerEl, []);

      expect(containerEl.querySelector(".systemsculpt-citations-container")).toBeNull();
    });

    it("renders citations container", () => {
      renderer.renderCitations(containerEl, [
        { url: "https://example.com", title: "Example Site" },
      ]);

      expect(containerEl.querySelector(".systemsculpt-citations-container")).not.toBeNull();
      expect(containerEl.querySelector(".systemsculpt-citations-header")).not.toBeNull();
      expect(containerEl.querySelector(".systemsculpt-citations-list")).not.toBeNull();
    });

    it("renders citation items with title and url", () => {
      renderer.renderCitations(containerEl, [
        { url: "https://example.com", title: "Example Site" },
        { url: "https://test.org", title: "Test Org" },
      ]);

      const items = containerEl.querySelectorAll(".systemsculpt-citation-item");
      expect(items).toHaveLength(2);

      const firstLink = items[0].querySelector("a");
      expect(firstLink?.textContent).toBe("Example Site");
      expect(firstLink?.getAttribute("href")).toBe("https://example.com");
      expect(firstLink?.getAttribute("target")).toBe("_blank");
    });

    it("uses hostname when title is missing", () => {
      renderer.renderCitations(containerEl, [
        { url: "https://example.com/path/to/page", title: "" },
      ]);

      const link = containerEl.querySelector(".systemsculpt-citation-title");
      expect(link?.textContent).toBe("example.com");
    });

    it("displays full URL under title", () => {
      renderer.renderCitations(containerEl, [
        { url: "https://example.com/page", title: "Page" },
      ]);

      const urlEl = containerEl.querySelector(".systemsculpt-citation-url");
      expect(urlEl?.textContent).toBe("https://example.com/page");
    });

    it("renders divider between content and citations", () => {
      renderer.renderCitations(containerEl, [
        { url: "https://example.com", title: "Example" },
      ]);

      expect(containerEl.querySelector(".systemsculpt-citations-divider")).not.toBeNull();
    });
  });

  describe("postProcess", () => {
    it("adds systemsculpt-code-block class to pre elements", async () => {
      containerEl.innerHTML = "<pre><code>const x = 1;</code></pre>";

      // Access private method
      (renderer as any).postProcess(containerEl);

      expect(containerEl.querySelector("pre")?.classList.contains("systemsculpt-code-block")).toBe(true);
    });

    it("adds copy button to code blocks", async () => {
      containerEl.innerHTML = "<pre><code>const x = 1;</code></pre>";

      (renderer as any).postProcess(containerEl);

      const copyBtn = containerEl.querySelector(".copy-code-button");
      expect(copyBtn).not.toBeNull();
      expect(copyBtn?.textContent).toBe("Copy");
    });

    it("does not duplicate copy buttons on re-render", async () => {
      containerEl.innerHTML = "<pre><code>const x = 1;</code></pre>";

      (renderer as any).postProcess(containerEl);
      (renderer as any).postProcess(containerEl);

      const copyBtns = containerEl.querySelectorAll(".copy-code-button");
      expect(copyBtns).toHaveLength(1);
    });

    it("adds click handler to images", async () => {
      containerEl.innerHTML = '<img src="test.png" />';

      (renderer as any).postProcess(containerEl);

      const img = containerEl.querySelector("img");
      expect(img?.classList.contains("systemsculpt-message-image")).toBe(true);
      expect(img?.style.cursor).toBe("pointer");
    });
  });

  describe("preprocessMermaid", () => {
    it("converts Node([Label]) to Node[\"Label\"]", () => {
      const input = '```mermaid\ngraph TD\nA([Start])\n```';

      const result = (renderer as any).preprocessMermaid(input);

      // The function adds extra quotes around the label
      expect(result).toContain('A["');
      expect(result).toContain('Start');
    });

    it("converts Node[Label] to Node[\"Label\"]", () => {
      const input = '```mermaid\ngraph TD\nA[My Label]\n```';

      const result = (renderer as any).preprocessMermaid(input);

      expect(result).toContain('A["');
      expect(result).toContain('My Label');
    });

    it("handles multiline labels", () => {
      const input = '```mermaid\ngraph TD\nA[Line 1\nLine 2]\n```';

      const result = (renderer as any).preprocessMermaid(input);

      // Newlines should be collapsed to spaces
      expect(result).toContain('Line 1 Line 2');
    });

    it("does not modify content outside mermaid blocks", () => {
      const input = "Normal [[wiki link]] text";

      const result = (renderer as any).preprocessMermaid(input);

      expect(result).toBe(input);
    });

    it("processes mermaid block correctly", () => {
      const input = '```mermaid\nmindmap\n  root([Root])\n```';

      const result = (renderer as any).preprocessMermaid(input);

      expect(result).toContain('mermaid');
      expect(result).toContain('root');
    });
  });

  describe("isElementVisible", () => {
    it("returns true when element is visible", () => {
      // Mock getBoundingClientRect
      jest.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
        top: 100,
        bottom: 200,
        left: 100,
        right: 200,
        width: 100,
        height: 100,
        x: 100,
        y: 100,
        toJSON: () => {},
      });

      const result = (renderer as any).isElementVisible(containerEl);

      expect(result).toBe(true);
    });

    it("returns false when element is above viewport", () => {
      jest.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
        top: -200,
        bottom: -100,
        left: 100,
        right: 200,
        width: 100,
        height: 100,
        x: 100,
        y: -200,
        toJSON: () => {},
      });

      const result = (renderer as any).isElementVisible(containerEl);

      expect(result).toBe(false);
    });

    it("returns true on error", () => {
      jest.spyOn(containerEl, "getBoundingClientRect").mockImplementation(() => {
        throw new Error("Test error");
      });

      const result = (renderer as any).isElementVisible(containerEl);

      expect(result).toBe(true);
    });
  });
});
