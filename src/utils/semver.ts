/**
 * Minimal, dependency-free numeric version helpers for the Obsidian-version
 * compatibility gate (ObsidianCompat). Deliberately strict: anything that is not a dotted run of
 * integers (optionally "v"-prefixed) parses to null so callers can FAIL SAFE
 * rather than compute a bogus comparison — the root of the #168 false-update
 * loop and a guard for the #212 min-version check.
 */

/**
 * Parse "1", "1.2", "1.2.3", "1.2.3.4" (optionally "v"-prefixed) into integer
 * parts. Returns null for anything non-numeric: "latest", "1.2.3-beta", "",
 * whitespace, an HTML error body, or a non-string.
 */
export function parseNumericVersion(version: unknown): number[] | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
  const parts = trimmed.split(".").map((part) => parseInt(part, 10));
  return parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}

/**
 * Compare two numeric version strings.
 * @returns 1 if a > b, -1 if a < b, 0 if equal OR either side is unparseable.
 *
 * Returning 0 for unparseable input is intentional: callers should treat
 * "unknown" as "no action" (no update prompt, no version block), never as a
 * definitive ordering.
 */
export function compareNumericVersions(a: string, b: string): number {
  const partsA = parseNumericVersion(a);
  const partsB = parseNumericVersion(b);
  if (!partsA || !partsB) return 0;

  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const partA = i < partsA.length ? partsA[i] : 0;
    const partB = i < partsB.length ? partsB[i] : 0;
    if (partA > partB) return 1;
    if (partA < partB) return -1;
  }
  return 0;
}
