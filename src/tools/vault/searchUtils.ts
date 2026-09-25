/**
 * Simple fuzzy match scoring function (lower score = better match).
 * Returns `null` if `needle` cannot be found in order inside `haystack`.
 */
export function fuzzyMatchScore(needle: string, haystack: string): number | null {
  const lcNeedle = needle.toLowerCase();
  const lcHaystack = haystack.toLowerCase();
  const exactIdx = lcHaystack.indexOf(lcNeedle);
  if (exactIdx !== -1) {
    return exactIdx;
  }

  let nIdx = 0;
  let score = 0;
  for (let hIdx = 0; hIdx < lcHaystack.length && nIdx < lcNeedle.length; hIdx++) {
    if (lcHaystack[hIdx] === lcNeedle[nIdx]) {
      nIdx += 1;
    } else {
      score += 1;
    }
  }

  if (nIdx !== lcNeedle.length) {
    return null;
  }

  score += lcHaystack.length - lcNeedle.length;
  return score;
}
