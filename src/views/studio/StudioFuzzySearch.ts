export function normalizeStudioSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isBoundaryChar(char: string): boolean {
  return char === " " || char === "." || char === "_" || char === "-" || char === "/" || char === ":";
}

export function scoreStudioFuzzyMatch(haystackRaw: string, queryRaw: string): number | null {
  const haystack = normalizeStudioSearchText(haystackRaw);
  const query = normalizeStudioSearchText(queryRaw);
  if (!query) {
    return 0;
  }

  let scanIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  let boundaryBonus = 0;

  for (const queryChar of query) {
    const matchIndex = haystack.indexOf(queryChar, scanIndex);
    if (matchIndex < 0) {
      return null;
    }
    if (firstMatchIndex < 0) {
      firstMatchIndex = matchIndex;
    }
    if (previousMatchIndex >= 0) {
      gapPenalty += Math.max(0, matchIndex - previousMatchIndex - 1);
    }
    if (matchIndex === 0 || isBoundaryChar(haystack.charAt(matchIndex - 1))) {
      boundaryBonus += 0.4;
    }
    previousMatchIndex = matchIndex;
    scanIndex = matchIndex + 1;
  }

  const span = previousMatchIndex - firstMatchIndex + 1;
  let score =
    firstMatchIndex * 1.6 +
    gapPenalty * 1.3 +
    Math.max(0, span - query.length) * 0.8 +
    haystack.length * 0.01;

  if (haystack.startsWith(query)) {
    score -= 5;
  } else {
    const containsIndex = haystack.indexOf(query);
    if (containsIndex >= 0) {
      score -= 3.2 - Math.min(2, containsIndex * 0.1);
    }
  }

  score -= boundaryBonus;
  return score;
}

export function rankStudioFuzzyItems<T>(options: {
  items: readonly T[];
  query: string;
  getSearchText: (item: T) => string;
  compareWhenEqual?: (left: T, right: T) => number;
}): T[] {
  const normalizedQuery = normalizeStudioSearchText(options.query);
  if (!normalizedQuery) {
    return options.items.slice();
  }

  const ranked = options.items
    .map((item, index) => ({
      item,
      score: scoreStudioFuzzyMatch(options.getSearchText(item), normalizedQuery),
      index,
    }))
    .filter((entry): entry is { item: T; score: number; index: number } => entry.score !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (options.compareWhenEqual) {
        const tieBreak = options.compareWhenEqual(left.item, right.item);
        if (tieBreak !== 0) {
          return tieBreak;
        }
      }
      return left.index - right.index;
    });

  return ranked.map((entry) => entry.item);
}
