import {
  normalizeStudioSearchText,
  rankStudioFuzzyItems,
  scoreStudioFuzzyMatch,
} from "../StudioFuzzySearch";

describe("StudioFuzzySearch", () => {
  it("normalizes casing and whitespace for search text", () => {
    expect(normalizeStudioSearchText("  GPT   5\tMINI  ")).toBe("gpt 5 mini");
  });

  it("returns null score when query cannot be matched", () => {
    expect(scoreStudioFuzzyMatch("model selector", "zzz")).toBeNull();
  });

  it("keeps original item order when query is empty", () => {
    const items = ["alpha", "beta", "gamma"];
    const ranked = rankStudioFuzzyItems({
      items,
      query: "   ",
      getSearchText: (item) => item,
    });
    expect(ranked).toEqual(items);
    expect(ranked).not.toBe(items);
  });

  it("uses tie-break comparator when fuzzy scores are equal", () => {
    const items = [
      { label: "Zulu" },
      { label: "Alpha" },
    ];
    const ranked = rankStudioFuzzyItems({
      items,
      query: "same",
      getSearchText: () => "same",
      compareWhenEqual: (left, right) => left.label.localeCompare(right.label),
    });
    expect(ranked.map((item) => item.label)).toEqual(["Alpha", "Zulu"]);
  });

  it("prioritizes stronger prefix matches", () => {
    const items = [
      { id: "middle", text: "beta model alpha" },
      { id: "prefix", text: "alpha model beta" },
    ];
    const ranked = rankStudioFuzzyItems({
      items,
      query: "alpha",
      getSearchText: (item) => item.text,
    });
    expect(ranked.map((item) => item.id)).toEqual(["prefix", "middle"]);
  });
});
