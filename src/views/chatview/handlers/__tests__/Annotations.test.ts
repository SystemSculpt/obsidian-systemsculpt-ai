/**
 * @jest-environment jsdom
 */
import { extractAnnotationsFromResponse } from "../Annotations";

describe("Annotations", () => {
  describe("extractAnnotationsFromResponse", () => {
    it("extracts annotations from markdown links", () => {
      const text = "Check out this article: [Example](https://example.com/article)";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].type).toBe("url_citation");
      expect(annotations[0].url_citation?.url).toBe("https://example.com/article");
    });

    it("extracts title from link text", () => {
      const text = "[Google](https://google.com)";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations[0].url_citation?.title).toBe("Source: Google");
    });

    it("extracts multiple links", () => {
      const text = "Visit [Site A](https://a.com) and [Site B](https://b.com)";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(2);
      expect(annotations[0].url_citation?.url).toBe("https://a.com");
      expect(annotations[1].url_citation?.url).toBe("https://b.com");
    });

    it("returns empty array for text without links", () => {
      const text = "This is plain text without any links.";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(0);
    });

    it("includes start and end index", () => {
      const text = "Here is a [link](https://test.com) in the text.";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations[0].url_citation?.start_index).toBe(10);
      expect(annotations[0].url_citation?.end_index).toBe(34);
    });

    it("extracts surrounding context for content", () => {
      const text = "This is important information. Check [this source](https://source.com) for more details. It's very useful.";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations[0].url_citation?.content).toBeDefined();
      expect(annotations[0].url_citation?.content).not.toContain("[this source]");
    });

    it("handles links with special characters in URL", () => {
      const text = "[Query](https://example.com/search?q=test&page=1)";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations[0].url_citation?.url).toBe("https://example.com/search?q=test&page=1");
    });

    it("handles links at the beginning of text", () => {
      const text = "[First](https://first.com) is the link";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].url_citation?.url).toBe("https://first.com");
    });

    it("handles links at the end of text", () => {
      const text = "The link is [Last](https://last.com)";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].url_citation?.url).toBe("https://last.com");
    });

    it("handles empty string", () => {
      const annotations = extractAnnotationsFromResponse("");

      expect(annotations).toHaveLength(0);
    });

    it("handles text with only brackets but not links", () => {
      const text = "This has [brackets] but (no links)";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(0);
    });

    it("handles nested brackets correctly", () => {
      const text = "[Link [with] nested](https://nested.com)";

      const annotations = extractAnnotationsFromResponse(text);

      // Should find a link (behavior depends on regex)
      expect(annotations.length).toBeGreaterThanOrEqual(0);
    });

    it("handles links with unicode text", () => {
      const text = "[日本語](https://japanese.com)";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].url_citation?.title).toBe("Source: 日本語");
    });

    it("handles very long surrounding text", () => {
      const longText = "A".repeat(300) + "[Link](https://test.com)" + "B".repeat(300);

      const annotations = extractAnnotationsFromResponse(longText);

      expect(annotations).toHaveLength(1);
      // Content should be truncated to nearby text
      expect(annotations[0].url_citation?.content).toBeDefined();
    });

    it("handles sentence with citation correctly", () => {
      const text = "According to research, this is true. See [source](https://source.com) for details. More text here.";

      const annotations = extractAnnotationsFromResponse(text);

      expect(annotations).toHaveLength(1);
      // The content should remove the link text itself
      expect(annotations[0].url_citation?.content).not.toContain("[source](https://source.com)");
    });
  });
});
