import type { TFile } from "obsidian";

/** Field bits stored with every posting: which of a note's fields hold the token. */
export const TITLE_FIELD = 1;
export const PATH_FIELD = 2;
export const BODY_FIELD = 4;
const FIELD_BITS = 8;

/** What the index keeps for one note. Note text is read again when needed. */
export interface IndexedNote {
  file: TFile;
  path: string;
  title: string;
  lowerTitle: string;
  lowerPath: string;
  /** Short list-view excerpt, copied so it doesn't keep the note text alive. */
  preview: string;
  mtime: number;
  size: number;
}

/** A note's tokens, each with the field bits it appears in. */
export type NoteTokens = Map<string, number>;

/**
 * A copy that shares no memory with `value`. V8 slices and regex matches can
 * point into their source string, so one kept slice would keep the whole note
 * text alive; prepending a character forces a fresh flat copy.
 */
export function copyFlat(value: string): string {
  return (" " + value).slice(1);
}

class GrowableUint32 {
  values = new Uint32Array(1024);
  length = 0;

  push(value: number): void {
    if (this.length === this.values.length) {
      const next = new Uint32Array(this.values.length * 2);
      next.set(this.values);
      this.values = next;
    }
    this.values[this.length] = value;
    this.length += 1;
  }
}

/**
 * Inverted index over note titles, paths and bodies, kept as integer postings.
 *
 * Tokens form one sorted vocabulary. Each token's postings sit in one shared
 * Uint32Array as `docId * 8 + fieldBits`, in the order notes were added, so
 * candidates come out in the same order as the insertion-ordered sets this
 * replaced. Document ids follow insertion order too: an updated note keeps its
 * id, and its new postings move to the end of each token's list.
 *
 * Changes are staged with `remove` and `upsert`. `commit` writes the postings
 * in one pass into a new index and leaves this one readable unchanged, so a
 * search running against it keeps consistent document ids; stage further
 * changes on the index `commit` returns.
 */
export class SearchTextIndex {
  private notes: Array<IndexedNote | null> = [];
  private idsByPath = new Map<string, number>();
  private liveCount = 0;
  private tokens: string[] = [];
  private postingStart: Uint32Array = new Uint32Array(1);
  private postings: Uint32Array = new Uint32Array(0);
  /** Token ids ordered by length, then alphabetically; `lengthStart[n]` is where length n begins. */
  private lengthOrder: Uint32Array = new Uint32Array(0);
  private lengthStart: Uint32Array = new Uint32Array(1);
  /** Postings staged by `upsert` as (staged token id, entry) pairs, in arrival order. */
  private stagedIds = new Map<string, number>();
  private stagedTokens: string[] = [];
  private stagedTokenIds = new GrowableUint32();
  private stagedEntries = new GrowableUint32();
  private replacedIds = new Set<number>();
  private hasRemovals = false;

  /** Notes in the index. */
  get size(): number {
    return this.liveCount;
  }

  /** One past the largest document id; masks indexed by document id use this length. */
  get docCount(): number {
    return this.notes.length;
  }

  idOf(path: string): number | undefined {
    return this.idsByPath.get(path);
  }

  note(docId: number): IndexedNote | null {
    return this.notes[docId] ?? null;
  }

  noteByPath(path: string): IndexedNote | null {
    const docId = this.idsByPath.get(path);
    return docId === undefined ? null : this.notes[docId];
  }

  /** Live document ids, in insertion order. */
  *docIds(): Iterable<number> {
    for (let docId = 0; docId < this.notes.length; docId += 1) {
      if (this.notes[docId]) yield docId;
    }
  }

  hasToken(token: string): boolean {
    return this.tokenId(token) !== -1;
  }

  /** Up to `limit` tokens starting with `prefix`, alphabetically. */
  prefixTokens(prefix: string, limit: number): string[] {
    const matches: string[] = [];
    let index = this.lowerBound(prefix);
    while (index < this.tokens.length && this.tokens[index].startsWith(prefix) && matches.length < limit) {
      matches.push(this.tokens[index]);
      index += 1;
    }
    return matches;
  }

  /** Tokens whose length is within [min, max], shortest first, then alphabetically. */
  *tokensByLength(min: number, max: number): Iterable<string> {
    const last = Math.min(max, this.lengthStart.length - 2);
    if (min > last) return;
    const end = this.lengthStart[last + 1];
    for (let index = this.lengthStart[Math.max(0, min)]; index < end; index += 1) {
      yield this.tokens[this.lengthOrder[index]];
    }
  }

  /** Calls `visit` for each note holding `token`, in posting order, with its field bits. */
  forEachPosting(token: string, visit: (docId: number, fields: number) => void): void {
    const tokenId = this.tokenId(token);
    if (tokenId === -1) return;
    for (let index = this.postingStart[tokenId]; index < this.postingStart[tokenId + 1]; index += 1) {
      const entry = this.postings[index];
      const docId = entry >>> 3;
      if (this.notes[docId]) visit(docId, entry & 7);
    }
  }

  /**
   * Marks each note whose body contains `word` anywhere, as `body.includes`
   * would. `word` must be letters, digits and marks only: any occurrence then
   * lies inside one body token, and single-character runs are indexed too.
   */
  bodyContainsWord(word: string): Uint8Array {
    const mask = new Uint8Array(this.notes.length);
    if (!word) return mask;
    const end = this.lengthOrder.length;
    const start = word.length < this.lengthStart.length - 1 ? this.lengthStart[word.length] : end;
    for (let index = start; index < end; index += 1) {
      const tokenId = this.lengthOrder[index];
      if (!this.tokens[tokenId].includes(word)) continue;
      for (let posting = this.postingStart[tokenId]; posting < this.postingStart[tokenId + 1]; posting += 1) {
        const entry = this.postings[posting];
        if ((entry & BODY_FIELD) !== 0) mask[entry >>> 3] = 1;
      }
    }
    return mask;
  }

  /** Drops a note now; its postings go at the next `commit`. */
  remove(path: string): void {
    const docId = this.idsByPath.get(path);
    if (docId === undefined) return;
    this.idsByPath.delete(path);
    this.notes[docId] = null;
    this.liveCount -= 1;
    this.hasRemovals = true;
  }

  /**
   * Adds a note or replaces the note at the same path; postings change at the
   * next `commit`. Each path is upserted at most once between commits. The
   * tokens are staged as integers, so `tokens` isn't kept.
   */
  upsert(note: IndexedNote, tokens: NoteTokens): void {
    let docId = this.idsByPath.get(note.path);
    if (docId === undefined) {
      docId = this.notes.push(note) - 1;
      this.idsByPath.set(note.path, docId);
      this.liveCount += 1;
    } else {
      this.notes[docId] = note;
      this.replacedIds.add(docId);
    }
    for (const [token, fields] of tokens) {
      let stagedId = this.stagedIds.get(token);
      if (stagedId === undefined) {
        const flat = copyFlat(token);
        stagedId = this.stagedTokens.push(flat) - 1;
        this.stagedIds.set(flat, stagedId);
      }
      this.stagedTokenIds.push(stagedId);
      this.stagedEntries.push(docId * FIELD_BITS + fields);
    }
  }

  /** The index with staged changes applied, documents renumbered densely; this one if nothing is staged. */
  commit(): SearchTextIndex {
    if (this.stagedEntries.length === 0 && this.replacedIds.size === 0 && !this.hasRemovals) return this;

    // New ids for live notes; replaced notes drop their old postings too.
    const oldCount = this.notes.length;
    const remap = new Int32Array(oldCount);
    let nextId = 0;
    for (let docId = 0; docId < oldCount; docId += 1) {
      remap[docId] = this.notes[docId] ? nextId++ : -1;
    }
    const remapOld = remap.slice();
    for (const docId of this.replacedIds) remapOld[docId] = -1;

    // Group staged entries by token, keeping arrival order within each token.
    const stagedCount = this.stagedTokens.length;
    const stagedLength = this.stagedEntries.length;
    const stagedTokenIds = this.stagedTokenIds.values;
    const stagedStart = new Uint32Array(stagedCount + 1);
    for (let index = 0; index < stagedLength; index += 1) stagedStart[stagedTokenIds[index] + 1] += 1;
    for (let stagedId = 0; stagedId < stagedCount; stagedId += 1) stagedStart[stagedId + 1] += stagedStart[stagedId];
    const cursor = stagedStart.slice(0, stagedCount);
    const grouped = new Uint32Array(stagedLength);
    for (let index = 0; index < stagedLength; index += 1) {
      grouped[cursor[stagedTokenIds[index]]++] = this.stagedEntries.values[index];
    }
    const stagedOrder = this.stagedTokens.slice().sort();

    const tokens: string[] = [];
    const starts = new Uint32Array(this.tokens.length + stagedCount + 1);
    const postings = new Uint32Array(this.postings.length + stagedLength);
    let length = 0;
    const write = (entries: Uint32Array, from: number, to: number, ids: Int32Array) => {
      for (let index = from; index < to; index += 1) {
        const entry = entries[index];
        const docId = ids[entry >>> 3];
        if (docId !== -1) postings[length++] = docId * FIELD_BITS + (entry & 7);
      }
    };

    let oldId = 0;
    let stagedIndex = 0;
    while (oldId < this.tokens.length || stagedIndex < stagedOrder.length) {
      const tokenStart = length;
      const oldToken = oldId < this.tokens.length ? this.tokens[oldId] : null;
      const stagedToken = stagedIndex < stagedOrder.length ? stagedOrder[stagedIndex] : null;
      const token = oldToken !== null && (stagedToken === null || oldToken <= stagedToken) ? oldToken : stagedToken!;
      if (token === oldToken) {
        write(this.postings, this.postingStart[oldId], this.postingStart[oldId + 1], remapOld);
        oldId += 1;
      }
      if (token === stagedToken) {
        const stagedId = this.stagedIds.get(stagedToken)!;
        write(grouped, stagedStart[stagedId], stagedStart[stagedId + 1], remap);
        stagedIndex += 1;
      }
      // A token no live note holds leaves the vocabulary.
      if (length > tokenStart) {
        starts[tokens.length] = tokenStart;
        tokens.push(token);
      }
    }
    starts[tokens.length] = length;

    const next = new SearchTextIndex();
    for (const note of this.notes) {
      if (!note) continue;
      next.idsByPath.set(note.path, next.notes.length);
      next.notes.push(note);
    }
    next.liveCount = next.notes.length;
    next.adopt(tokens, starts.slice(0, tokens.length + 1), postings.slice(0, length));
    return next;
  }

  private adopt(tokens: string[], postingStart: Uint32Array, postings: Uint32Array): void {
    this.tokens = tokens;
    this.postingStart = postingStart;
    this.postings = postings;
    let maxLength = 0;
    for (const token of this.tokens) maxLength = Math.max(maxLength, token.length);
    const lengthStart = new Uint32Array(maxLength + 2);
    for (const token of this.tokens) lengthStart[token.length + 1] += 1;
    for (let length = 1; length < lengthStart.length; length += 1) lengthStart[length] += lengthStart[length - 1];
    const cursor = lengthStart.slice();
    const lengthOrder = new Uint32Array(this.tokens.length);
    for (let tokenId = 0; tokenId < this.tokens.length; tokenId += 1) {
      lengthOrder[cursor[this.tokens[tokenId].length]++] = tokenId;
    }
    this.lengthOrder = lengthOrder;
    this.lengthStart = lengthStart;
  }

  private tokenId(token: string): number {
    const index = this.lowerBound(token);
    return index < this.tokens.length && this.tokens[index] === token ? index : -1;
  }

  private lowerBound(target: string): number {
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.tokens[mid] < target) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}
