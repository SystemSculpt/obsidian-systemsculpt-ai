/**
 * @jest-environment jsdom
 */
import { SearchService, SearchableField, SearchMatch } from "../SearchService";

describe("SearchService", () => {
  let service: SearchService;

  beforeEach(() => {
    // Reset singleton
    (SearchService as any).instance = null;
    service = SearchService.getInstance();
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = SearchService.getInstance();
      const instance2 = SearchService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("search", () => {
    interface TestItem {
      id: string;
      title: string;
      description?: string;
    }

    const getSearchableFields = (item: TestItem): SearchableField[] => [
      { field: "title", text: item.title, weight: 2.0 },
      { field: "description", text: item.description, weight: 1.0 },
    ];

    it("returns all items with empty query", () => {
      const items: TestItem[] = [
        { id: "1", title: "First Item" },
        { id: "2", title: "Second Item" },
        { id: "3", title: "Third Item" },
      ];

      const results = service.search(items, "", getSearchableFields);

      expect(results).toHaveLength(3);
      expect(results[0].score).toBe(0);
      expect(results[0].matches).toHaveLength(0);
    });

    it("returns items with whitespace-only query", () => {
      const items: TestItem[] = [{ id: "1", title: "Item" }];

      const results = service.search(items, "   ", getSearchableFields);

      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0);
    });

    it("finds items matching single term", () => {
      const items: TestItem[] = [
        { id: "1", title: "Apple Pie" },
        { id: "2", title: "Banana Split" },
        { id: "3", title: "Apple Tart" },
      ];

      const results = service.search(items, "apple", getSearchableFields);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.item.title.toLowerCase().includes("apple"))).toBe(true);
    });

    it("finds items matching multiple terms", () => {
      const items: TestItem[] = [
        { id: "1", title: "Apple Pie Recipe" },
        { id: "2", title: "Apple Tart" },
        { id: "3", title: "Pie Crust" },
      ];

      const results = service.search(items, "apple pie", getSearchableFields);

      expect(results).toHaveLength(1);
      expect(results[0].item.id).toBe("1");
    });

    it("returns empty results when no match found", () => {
      const items: TestItem[] = [
        { id: "1", title: "Apple Pie" },
        { id: "2", title: "Banana Split" },
      ];

      const results = service.search(items, "chocolate", getSearchableFields);

      expect(results).toHaveLength(0);
    });

    it("is case insensitive", () => {
      const items: TestItem[] = [{ id: "1", title: "APPLE PIE" }];

      const results = service.search(items, "apple", getSearchableFields);

      expect(results).toHaveLength(1);
    });

    it("searches in description field", () => {
      const items: TestItem[] = [
        { id: "1", title: "Recipe", description: "A delicious apple pie" },
        { id: "2", title: "Recipe", description: "Chocolate cake" },
      ];

      const results = service.search(items, "apple", getSearchableFields);

      expect(results).toHaveLength(1);
      expect(results[0].item.id).toBe("1");
    });

    it("weights title matches higher than description", () => {
      const items: TestItem[] = [
        { id: "1", title: "Recipe", description: "Apple is the main ingredient" },
        { id: "2", title: "Apple Recipe", description: "A tasty dish" },
      ];

      const results = service.search(items, "apple", getSearchableFields);

      expect(results).toHaveLength(2);
      expect(results[0].item.id).toBe("2"); // Title match should rank higher
    });

    it("respects initialResultsLimit option", () => {
      const items: TestItem[] = Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        title: "Item " + i,
      }));

      const results = service.search(items, "", getSearchableFields, {
        initialResultsLimit: 10,
      });

      expect(results).toHaveLength(10);
    });

    it("respects maxFilteredResults option", () => {
      const items: TestItem[] = Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        title: "Test Item " + i,
      }));

      const results = service.search(items, "test", getSearchableFields, {
        maxFilteredResults: 5,
      });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("sorts results by score descending", () => {
      const items: TestItem[] = [
        { id: "1", title: "One mention of test here" },
        { id: "2", title: "Test Test Test multiple" },
        { id: "3", title: "Another test example" },
      ];

      const results = service.search(items, "test", getSearchableFields);

      // Results should be sorted by score (higher first)
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
      }
    });

    it("handles null field text gracefully", () => {
      const items: TestItem[] = [
        { id: "1", title: "Test" },
      ];

      const getFieldsWithNull = (item: TestItem): SearchableField[] => [
        { field: "title", text: item.title, weight: 2.0 },
        { field: "description", text: null, weight: 1.0 },
      ];

      const results = service.search(items, "test", getFieldsWithNull);

      expect(results).toHaveLength(1);
    });

    it("handles undefined field text gracefully", () => {
      const items: TestItem[] = [
        { id: "1", title: "Test" },
      ];

      const getFieldsWithUndefined = (item: TestItem): SearchableField[] => [
        { field: "title", text: item.title, weight: 2.0 },
        { field: "description", text: undefined, weight: 1.0 },
      ];

      const results = service.search(items, "test", getFieldsWithUndefined);

      expect(results).toHaveLength(1);
    });

    it("adds proximity bonus for close terms", () => {
      const items: TestItem[] = [
        { id: "1", title: "Apple Pie is delicious" },
        { id: "2", title: "Apple is a fruit that goes well in Pie when baked properly" },
      ];

      const results = service.search(items, "apple pie", getSearchableFields);

      // Both match, but item 1 should score higher due to proximity
      expect(results).toHaveLength(2);
      expect(results[0].item.id).toBe("1");
    });

    it("includes match indices in results", () => {
      const items: TestItem[] = [{ id: "1", title: "Hello World" }];

      const results = service.search(items, "world", getSearchableFields);

      expect(results).toHaveLength(1);
      expect(results[0].matches.length).toBeGreaterThan(0);
      expect(results[0].matches[0].indices).toBeDefined();
      expect(results[0].matches[0].indices.length).toBe(5); // "world" is 5 chars
    });
  });

  describe("highlightText", () => {
    it("returns plain text when no matches", () => {
      const fragment = service.highlightText("Hello World", []);

      expect(fragment.textContent).toBe("Hello World");
    });

    it("returns plain text when no search query", () => {
      const matches: SearchMatch[] = [
        { field: "title", text: "Hello World", indices: [0, 1, 2, 3, 4], matchQuality: 1.0 },
      ];

      const fragment = service.highlightText("Hello World", matches);

      expect(fragment.textContent).toBe("Hello World");
    });

    it("highlights matching text", () => {
      const matches: SearchMatch[] = [
        { field: "title", text: "Hello World", indices: [6, 7, 8, 9, 10], matchQuality: 1.0 },
      ];

      const fragment = service.highlightText("Hello World", matches, "world");

      const div = document.createElement("div");
      div.appendChild(fragment);

      expect(div.querySelector(".systemsculpt-search-highlight")).not.toBeNull();
      expect(div.querySelector(".systemsculpt-search-highlight")?.textContent).toBe("World");
    });

    it("highlights multiple occurrences", () => {
      const matches: SearchMatch[] = [
        { field: "title", text: "test test", indices: [0, 1, 2, 3], matchQuality: 1.0 },
      ];

      const fragment = service.highlightText("test test test", matches, "test");

      const div = document.createElement("div");
      div.appendChild(fragment);

      const highlights = div.querySelectorAll(".systemsculpt-search-highlight");
      expect(highlights).toHaveLength(3);
    });

    it("handles multiple search terms", () => {
      const matches: SearchMatch[] = [
        { field: "title", text: "apple pie recipe", indices: [0], matchQuality: 1.0 },
      ];

      const fragment = service.highlightText("apple pie recipe", matches, "apple pie");

      const div = document.createElement("div");
      div.appendChild(fragment);

      const highlights = div.querySelectorAll(".systemsculpt-search-highlight");
      expect(highlights).toHaveLength(2);
      expect(highlights[0].textContent).toBe("apple");
      expect(highlights[1].textContent).toBe("pie");
    });

    it("is case insensitive when highlighting", () => {
      const matches: SearchMatch[] = [
        { field: "title", text: "HELLO", indices: [0], matchQuality: 1.0 },
      ];

      const fragment = service.highlightText("HELLO World", matches, "hello");

      const div = document.createElement("div");
      div.appendChild(fragment);

      const highlight = div.querySelector(".systemsculpt-search-highlight");
      expect(highlight?.textContent).toBe("HELLO");
    });

    it("preserves text around highlights", () => {
      const matches: SearchMatch[] = [
        { field: "title", text: "Hello World", indices: [6], matchQuality: 1.0 },
      ];

      const fragment = service.highlightText("Hello World Today", matches, "world");

      expect(fragment.textContent).toBe("Hello World Today");
    });

    it("escapes special regex characters in search query", () => {
      const matches: SearchMatch[] = [
        { field: "title", text: "test", indices: [0], matchQuality: 1.0 },
      ];

      // This should not throw even with special characters
      const fragment = service.highlightText("test [special] (chars)", matches, "[special]");

      expect(fragment.textContent).toBe("test [special] (chars)");
    });
  });

  describe("getMatchQuality", () => {
    // Access private method
    it("returns 1.0 for word boundary match", () => {
      const quality = (service as any).getMatchQuality("hello world", "world", 6);
      expect(quality).toBe(1.0);
    });

    it("returns 1.0 for start of string match", () => {
      const quality = (service as any).getMatchQuality("hello world", "hello", 0);
      expect(quality).toBe(1.0);
    });

    it("returns 1.0 for end of string match", () => {
      const quality = (service as any).getMatchQuality("hello", "hello", 0);
      expect(quality).toBe(1.0);
    });

    it("returns 0.8 for partial match", () => {
      const quality = (service as any).getMatchQuality("helloworld", "low", 3);
      expect(quality).toBe(0.8);
    });
  });

  describe("escapeRegExp", () => {
    // Access private method
    it("escapes special regex characters", () => {
      const escaped = (service as any).escapeRegExp("test.*+?^$()[]|\\");
      expect(escaped).toBe("test\\.\\*\\+\\?\\^\\$\\(\\)\\[\\]\\|\\\\");
    });

    it("leaves regular text unchanged", () => {
      const escaped = (service as any).escapeRegExp("hello world");
      expect(escaped).toBe("hello world");
    });
  });
});
