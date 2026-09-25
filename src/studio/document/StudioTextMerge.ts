/** Prose fields whose concurrent edits may combine within one value. IDs, kinds,
 * paths, models and other strings are indivisible and never merge by character. */
const PROSE_FIELDS = new Set(["value", "prompt", "systemPrompt", "source", "text", "title", "label", "description", "instructions"]);

/** The final key of a reconciliation path such as `canvas.nodes[a].config.value`. */
export function isStudioProseFieldPath(path: string): boolean {
  return PROSE_FIELDS.has(path.slice(path.lastIndexOf(".") + 1));
}

type Hunk = { start: number; end: number; text: string };
const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The one base range a side replaced: everything between its common prefix and suffix. */
function hunk(base: string, side: string): Hunk {
  const limit = Math.min(base.length, side.length);
  let start = 0;
  while (start < limit && base.charCodeAt(start) === side.charCodeAt(start)) start++;
  // Never split a surrogate pair: a boundary inside one would splice half a character.
  if (start > 0 && high(base.charCodeAt(start - 1))) start--;
  let tail = 0;
  while (tail < limit - start && base.charCodeAt(base.length - 1 - tail) === side.charCodeAt(side.length - 1 - tail)) tail++;
  if (tail > 0 && low(base.charCodeAt(base.length - tail))) tail--;
  return { start, end: base.length - tail, text: side.slice(start, side.length - tail) };
}

/**
 * Three-way merge of one string edited on two sides (diff3 restricted to one
 * changed range per side). Separate ranges combine; insertions at the same
 * point keep both, ours first. Touching or overlapping changes return null so
 * the caller keeps one side and preserves the other; nothing is guessed.
 */
export function mergeStudioText(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const a = hunk(base, ours), b = hunk(base, theirs);
  if (a.start === a.end && b.start === b.end && a.start === b.start) {
    return base.slice(0, a.start) + a.text + b.text + base.slice(a.start);
  }
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  if (first.end >= second.start) return null;
  return base.slice(0, first.start) + first.text + base.slice(first.end, second.start) + second.text + base.slice(second.end);
}
