/**
 * @jest-environment node
 */
import {
  extractSearchTerms,
  calculateScore,
  sortByScore,
  formatScoredResults,
  ScoredResult,
} from "../searchScoring";

describe("searchScoring", () => {
  describe("extractSearchTerms", () => {
    it("extracts simple space-separated terms", () => {
      const terms = extractSearchTerms("license upgrade");
      expect(terms).toContain("license");
      expect(terms).toContain("upgrade");
    });

    it("extracts hyphen-separated terms", () => {
      const terms = extractSearchTerms("license-upgrade");
      expect(terms).toContain("license");
      expect(terms).toContain("upgrade");
    });

    it("extracts underscore-separated terms", () => {
      const terms = extractSearchTerms("license_upgrade");
      expect(terms).toContain("license");
      expect(terms).toContain("upgrade");
    });

    it("converts to lowercase", () => {
      const terms = extractSearchTerms("LICENSE UPGRADE");
      expect(terms).toContain("license");
      expect(terms).toContain("upgrade");
    });

    it("generates camelCase variations", () => {
      const terms = extractSearchTerms("license upgrade");
      expect(terms).toContain("licenseUpgrade");
    });

    it("generates PascalCase variations", () => {
      const terms = extractSearchTerms("license upgrade");
      expect(terms).toContain("LicenseUpgrade");
    });

    it("generates snake_case variations", () => {
      const terms = extractSearchTerms("license upgrade");
      expect(terms).toContain("license_upgrade");
    });

    it("generates hyphenated variations", () => {
      const terms = extractSearchTerms("license upgrade");
      expect(terms).toContain("license-upgrade");
    });

    it("filters out empty terms", () => {
      const terms = extractSearchTerms("license  upgrade");
      expect(terms).not.toContain("");
    });

    it("removes duplicates", () => {
      const terms = extractSearchTerms("test test test");
      const testCount = terms.filter((t) => t === "test").length;
      expect(testCount).toBe(1);
    });

    it("handles single term without variations", () => {
      const terms = extractSearchTerms("license");
      expect(terms).toEqual(["license"]);
    });
  });

  describe("calculateScore", () => {
    const context = {
      searchTerms: ["license", "upgrade"],
      originalQuery: "license upgrade",
    };

    it("gives high score for filename match", () => {
      const result = calculateScore(
        "src/services/licenseUpgrade.ts",
        "some content",
        context
      );
      expect(result.score).toBeGreaterThan(30);
      expect(result.matchDetails.matchLocations).toContain("filename");
    });

    it("gives medium score for path match", () => {
      const result = calculateScore(
        "src/license/services/main.ts",
        "some content",
        context
      );
      expect(result.matchDetails.matchLocations).toContain("path");
    });

    it("gives score for content match", () => {
      const result = calculateScore(
        "src/main.ts",
        "handle license upgrade here",
        context
      );
      expect(result.matchDetails.matchLocations).toContain("content");
    });

    it("tracks found keywords", () => {
      const result = calculateScore(
        "license.ts",
        "upgrade process",
        context
      );
      expect(result.matchDetails.keywordsFound).toContain("license");
      expect(result.matchDetails.keywordsFound).toContain("upgrade");
    });

    it("tracks missing keywords", () => {
      const result = calculateScore(
        "main.ts",
        "some other content",
        context
      );
      expect(result.matchDetails.keywordsMissing).toContain("license");
      expect(result.matchDetails.keywordsMissing).toContain("upgrade");
    });

    it("gives bonus for all original terms found", () => {
      const resultWithAll = calculateScore(
        "license-upgrade.ts",
        "",
        context
      );
      const resultWithOne = calculateScore(
        "license.ts",
        "",
        context
      );
      expect(resultWithAll.score).toBeGreaterThan(resultWithOne.score);
    });

    it("gives bonus for exact phrase match", () => {
      const resultWithPhrase = calculateScore(
        "main.ts",
        "Need to handle license upgrade here",
        context
      );
      const resultWithTerms = calculateScore(
        "main.ts",
        "Need license here and upgrade there",
        context
      );
      expect(resultWithPhrase.score).toBeGreaterThan(resultWithTerms.score);
    });

    it("applies penalty for archive directories", () => {
      const resultNormal = calculateScore(
        "src/license/main.ts",
        "",
        context
      );
      const resultArchive = calculateScore(
        "archive/license/main.ts",
        "",
        context
      );
      expect(resultArchive.score).toBeLessThan(resultNormal.score);
    });

    it("gives bonus for relevant directory paths", () => {
      const resultNormal = calculateScore(
        "src/license/main.ts",
        "",
        context
      );
      const resultWithRelevantPath = calculateScore(
        "marketing/email/campaign/license.ts",
        "",
        context
      );
      expect(resultWithRelevantPath.score).toBeGreaterThan(resultNormal.score);
      expect(resultWithRelevantPath.matchDetails.reasoning).toContain("Relevant directory");
    });

    it("caps score at 100", () => {
      const result = calculateScore(
        "license-upgrade/licenseUpgrade.ts",
        "license upgrade license upgrade license upgrade",
        context
      );
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("caps score at minimum 0", () => {
      const result = calculateScore(
        "archive/old/backup/legacy/deprecated/main.ts",
        "",
        context
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("includes file name in result", () => {
      const result = calculateScore("src/services/main.ts", "", context);
      expect(result.file).toBe("main.ts");
    });

    it("includes full path in result", () => {
      const result = calculateScore("src/services/main.ts", "", context);
      expect(result.path).toBe("src/services/main.ts");
    });

    it("includes reasoning in match details", () => {
      const result = calculateScore("license.ts", "upgrade", context);
      expect(result.matchDetails.reasoning).toBeTruthy();
    });

    it("handles undefined content", () => {
      const result = calculateScore("main.ts", undefined, context);
      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("handles empty path", () => {
      const result = calculateScore("", "", context);
      expect(result).toBeDefined();
      expect(result.file).toBe("");
    });
  });

  describe("sortByScore", () => {
    it("sorts results by score descending", () => {
      const results: ScoredResult[] = [
        { file: "a.ts", path: "a.ts", score: 30, matchDetails: { keywordsFound: [], keywordsMissing: [], matchLocations: [], reasoning: "" } },
        { file: "b.ts", path: "b.ts", score: 80, matchDetails: { keywordsFound: [], keywordsMissing: [], matchLocations: [], reasoning: "" } },
        { file: "c.ts", path: "c.ts", score: 50, matchDetails: { keywordsFound: [], keywordsMissing: [], matchLocations: [], reasoning: "" } },
      ];

      const sorted = sortByScore(results);

      expect(sorted[0].score).toBe(80);
      expect(sorted[1].score).toBe(50);
      expect(sorted[2].score).toBe(30);
    });

    it("maintains order for equal scores", () => {
      const results: ScoredResult[] = [
        { file: "a.ts", path: "a.ts", score: 50, matchDetails: { keywordsFound: [], keywordsMissing: [], matchLocations: [], reasoning: "" } },
        { file: "b.ts", path: "b.ts", score: 50, matchDetails: { keywordsFound: [], keywordsMissing: [], matchLocations: [], reasoning: "" } },
      ];

      const sorted = sortByScore(results);

      expect(sorted.length).toBe(2);
    });

    it("handles empty array", () => {
      const sorted = sortByScore([]);
      expect(sorted).toEqual([]);
    });

    it("handles single result", () => {
      const results: ScoredResult[] = [
        { file: "a.ts", path: "a.ts", score: 50, matchDetails: { keywordsFound: [], keywordsMissing: [], matchLocations: [], reasoning: "" } },
      ];

      const sorted = sortByScore(results);

      expect(sorted.length).toBe(1);
      expect(sorted[0].score).toBe(50);
    });
  });

  describe("formatScoredResults", () => {
    const createResult = (file: string, score: number): ScoredResult => ({
      file,
      path: `src/${file}`,
      score,
      matchDetails: {
        keywordsFound: ["test"],
        keywordsMissing: [],
        matchLocations: ["filename"],
        reasoning: "Found in filename",
      },
      contexts: [{ line: 1, text: "test" }],
      created: "2024-01-01",
      modified: "2024-01-02",
      fileSize: 1000,
    });

    it("limits results to maxResults", () => {
      const results = Array.from({ length: 50 }, (_, i) =>
        createResult(`file${i}.ts`, 100 - i)
      );

      const formatted = formatScoredResults(results, 10);

      expect(formatted.results.length).toBe(10);
    });

    it("uses default maxResults of 25", () => {
      const results = Array.from({ length: 50 }, (_, i) =>
        createResult(`file${i}.ts`, 100 - i)
      );

      const formatted = formatScoredResults(results);

      expect(formatted.results.length).toBe(25);
    });

    it("includes totalFound", () => {
      const results = Array.from({ length: 50 }, (_, i) =>
        createResult(`file${i}.ts`, 100 - i)
      );

      const formatted = formatScoredResults(results, 10);

      expect(formatted.totalFound).toBe(50);
    });

    it("calculates searchSummary topScore", () => {
      const results = [
        createResult("a.ts", 80),
        createResult("b.ts", 60),
        createResult("c.ts", 40),
      ];

      const formatted = formatScoredResults(results);

      expect(formatted.searchSummary.topScore).toBe(80);
    });

    it("calculates searchSummary averageScore", () => {
      const results = [
        createResult("a.ts", 90),
        createResult("b.ts", 60),
        createResult("c.ts", 30),
      ];

      const formatted = formatScoredResults(results);

      expect(formatted.searchSummary.averageScore).toBe(60);
    });

    it("sets high confidence for score >= 70", () => {
      const results = [createResult("a.ts", 80)];

      const formatted = formatScoredResults(results);

      expect(formatted.searchSummary.confidenceLevel).toBe("high");
    });

    it("sets medium confidence for score >= 40 and < 70", () => {
      const results = [createResult("a.ts", 50)];

      const formatted = formatScoredResults(results);

      expect(formatted.searchSummary.confidenceLevel).toBe("medium");
    });

    it("sets low confidence for score < 40", () => {
      const results = [createResult("a.ts", 30)];

      const formatted = formatScoredResults(results);

      expect(formatted.searchSummary.confidenceLevel).toBe("low");
    });

    it("handles empty results", () => {
      const formatted = formatScoredResults([]);

      expect(formatted.results).toEqual([]);
      expect(formatted.totalFound).toBe(0);
      expect(formatted.searchSummary.topScore).toBe(0);
      expect(formatted.searchSummary.averageScore).toBe(0);
      expect(formatted.searchSummary.confidenceLevel).toBe("low");
    });

    it("includes all result fields in formatted output", () => {
      const results = [createResult("test.ts", 70)];

      const formatted = formatScoredResults(results);
      const result = formatted.results[0];

      expect(result.file).toBe("test.ts");
      expect(result.path).toBe("src/test.ts");
      expect(result.score).toBe(70);
      expect(result.reasoning).toBe("Found in filename");
      expect(result.keywordsFound).toEqual(["test"]);
      expect(result.keywordsMissing).toEqual([]);
      expect(result.contexts).toEqual([{ line: 1, text: "test" }]);
      expect(result.created).toBe("2024-01-01");
      expect(result.modified).toBe("2024-01-02");
      expect(result.fileSize).toBe(1000);
    });
  });
});
