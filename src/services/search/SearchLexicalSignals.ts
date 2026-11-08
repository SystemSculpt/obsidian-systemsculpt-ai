import type { SearchResult } from "../embeddings/types";

/** Normalize case and outer whitespace without changing phrase spacing. */
export function normalizeSearchQuery(query: string): string {
  return query.toLowerCase().trim();
}

/** Substring presence in already-lowercase fields; preserve query order and duplicates. */
export function presentSearchTerms(terms: readonly string[], fields: readonly string[]): string[] {
  return terms.filter((term) => fields.some((field) => field.includes(term)));
}

/**
 * Refine semantic candidates using their path, title and excerpt, not vault bodies.
 * Keep the existing ASCII-token coverage and 85/15 blend. Indexed modal search
 * uses Unicode exact/prefix/fuzzy matches; find uses compound identifier variants.
 * Those query modes deliberately retain their own term forms and field weights.
 */
export function refineSemanticSearchResults(query: string, results: SearchResult[]): SearchResult[] {
  const normalized = normalizeSearchQuery(query);
  const tokens = [...new Set(normalized.split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/gi, ""))
    .filter((token) => token.length > 1))];
  if (tokens.length === 0) return results;

  return results.map((result) => {
    const haystack = `${result.path} ${result.metadata.title} ${result.metadata.excerpt}`.toLowerCase();
    const lexicalScore = haystack.includes(normalized)
      ? 1
      : presentSearchTerms(tokens, [haystack]).length / tokens.length;
    return {
      ...result,
      score: Math.min(1, 0.85 * result.score + 0.15 * lexicalScore),
      metadata: { ...result.metadata, lexicalScore },
    };
  }).sort((left, right) => right.score - left.score);
}
