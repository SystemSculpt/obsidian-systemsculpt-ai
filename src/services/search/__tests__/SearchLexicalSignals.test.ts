import type { SearchResult } from "../../embeddings/types";
import {
  normalizeSearchQuery,
  presentSearchTerms,
  refineSemanticSearchResults,
} from "../SearchLexicalSignals";

function candidate(path: string, score: number, title = "", excerpt = ""): SearchResult {
  return {
    path,
    score,
    chunkId: 2,
    metadata: { title, excerpt, lastModified: 42, sectionTitle: "Details" },
  };
}

describe("search lexical signals", () => {
  it("normalizes query case and outer whitespace without rewriting punctuation or phrase spacing", () => {
    expect(normalizeSearchQuery("  RÉSUMÉ_東京   Alpha-Beta 🚀 \n")).toBe("résumé_東京   alpha-beta 🚀");
    expect(normalizeSearchQuery(" \n\t ")).toBe("");
  });

  it("finds substring terms across fields without creating cross-field matches", () => {
    expect(presentSearchTerms(["alpha", "beta", "alpha", "missing", "a b"], ["alphabet", "beta"]))
      .toEqual(["alpha", "beta", "alpha"]);
  });

  describe("semantic refinement", () => {
    it("preserves the 85/15 semantic blend and reorders candidates by refined score", () => {
      const unrelated = candidate("Unrelated.md", 0.9);
      const related = candidate("Alpha.md", 0.8, "Beta");
      const input = [unrelated, related];

      const refined = refineSemanticSearchResults("ALPHA beta", input);

      expect(refined.map((result) => result.path)).toEqual(["Alpha.md", "Unrelated.md"]);
      expect(refined[0].score).toBeCloseTo(0.85 * 0.8 + 0.15);
      expect(refined[1].score).toBeCloseTo(0.85 * 0.9);
      expect(refined[0].metadata).toEqual({ ...related.metadata, lexicalScore: 1 });
      expect(refined[0].chunkId).toBe(2);
      expect(input).toEqual([unrelated, related]);
      expect(input[0]).toBe(unrelated);
      expect(input[1]).toBe(related);
      expect(unrelated.score).toBe(0.9);
      expect(related.metadata.lexicalScore).toBeUndefined();
    });

    it("deduplicates coverage terms and accepts matches from the excerpt", () => {
      const [result] = refineSemanticSearchResults("alpha alpha beta", [candidate("Note.md", 0.6, "", "BETAMAX")]);

      expect(result.metadata.lexicalScore).toBe(0.5);
      expect(result.score).toBeCloseTo(0.85 * 0.6 + 0.15 * 0.5);
    });

    it("retains exact phrase matching across metadata fields", () => {
      const [result] = refineSemanticSearchResults("co-op 東京", [candidate("Note.md", 0.6, "Co-op", "東京")]);

      // ASCII token normalization makes co-op into coop; the phrase still matches.
      expect(result.metadata.lexicalScore).toBe(1);
    });

    it("keeps ASCII punctuation stripping distinct from find's delimiter splitting", () => {
      const [result] = refineSemanticSearchResults("alpha-beta", [candidate("Note.md", 0.6, "Alpha Beta")]);

      expect(result.metadata.lexicalScore).toBe(0);
      expect(result.score).toBeCloseTo(0.85 * 0.6);
    });

    it.each(["", " \n ", "a", "🚀", "東京", "a 🚀 東京"])(
      "leaves results untouched when query %j has no qualifying ASCII tokens",
      (query) => {
        const input = [candidate("東京 🚀.md", 0.9)];

        expect(refineSemanticSearchResults(query, input)).toBe(input);
        expect(input[0].metadata.lexicalScore).toBeUndefined();
      },
    );

    it("preserves input order for ties and the existing score ceiling", () => {
      const input = [candidate("First.md", 0.7), candidate("Second.md", 0.7)];
      const refined = refineSemanticSearchResults("missing", input);

      expect(refined.map((result) => result.path)).toEqual(["First.md", "Second.md"]);
      expect(refineSemanticSearchResults("alpha", [candidate("Alpha.md", 2)])[0].score).toBe(1);
      expect(refineSemanticSearchResults("alpha", [])).toEqual([]);
    });
  });
});
