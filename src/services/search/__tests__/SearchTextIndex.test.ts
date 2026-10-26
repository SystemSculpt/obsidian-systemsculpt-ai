import { TFile } from "obsidian";
import {
  BODY_FIELD,
  copyFlat,
  PATH_FIELD,
  SearchTextIndex,
  TITLE_FIELD,
  type IndexedNote,
  type NoteTokens,
} from "../SearchTextIndex";

function note(path: string, mtime = 1): IndexedNote {
  const file = new TFile({ path, stat: { mtime } });
  return {
    file,
    path,
    title: file.basename,
    lowerTitle: file.basename.toLowerCase(),
    lowerPath: path.toLowerCase(),
    preview: "",
    mtime,
    size: 0,
  };
}

function tokens(entries: Record<string, number>): NoteTokens {
  return new Map(Object.entries(entries));
}

function postings(index: SearchTextIndex, token: string): string[] {
  const seen: string[] = [];
  index.forEachPosting(token, (docId, fields) => seen.push(`${index.note(docId)!.path}:${fields}`));
  return seen;
}

function build(entries: Array<[string, Record<string, number>]>): SearchTextIndex {
  const index = new SearchTextIndex();
  for (const [path, noteTokens] of entries) index.upsert(note(path), tokens(noteTokens));
  return index.commit();
}

describe("SearchTextIndex", () => {
  it("keeps postings in insertion order with the fields each token came from", () => {
    const index = build([
      ["b.md", { alpha: TITLE_FIELD | BODY_FIELD, beta: BODY_FIELD }],
      ["a.md", { alpha: PATH_FIELD }],
    ]);

    expect(index.size).toBe(2);
    expect(postings(index, "alpha")).toEqual([`b.md:${TITLE_FIELD | BODY_FIELD}`, `a.md:${PATH_FIELD}`]);
    expect(postings(index, "beta")).toEqual([`b.md:${BODY_FIELD}`]);
    expect(Array.from(index.docIds(), (docId) => index.note(docId)!.path)).toEqual(["b.md", "a.md"]);
    expect(index.hasToken("alpha")).toBe(true);
    expect(index.hasToken("gamma")).toBe(false);
  });

  it("stages nothing visible until commit, which leaves the old index readable", () => {
    const first = build([["a.md", { alpha: BODY_FIELD }]]);
    first.upsert(note("b.md"), tokens({ alpha: BODY_FIELD }));
    expect(postings(first, "alpha")).toEqual([`a.md:${BODY_FIELD}`]);

    const second = first.commit();
    expect(second).not.toBe(first);
    expect(postings(second, "alpha")).toEqual([`a.md:${BODY_FIELD}`, `b.md:${BODY_FIELD}`]);
    expect(postings(first, "alpha")).toEqual([`a.md:${BODY_FIELD}`]);
    expect(second.commit()).toBe(second);
  });

  it("keeps an updated note's id and moves its postings to the end of each list", () => {
    const index = build([
      ["a.md", { alpha: BODY_FIELD, old: BODY_FIELD }],
      ["b.md", { alpha: BODY_FIELD }],
    ]);
    index.upsert(note("a.md", 2), tokens({ alpha: TITLE_FIELD, fresh: BODY_FIELD }));
    const next = index.commit();

    expect(next.idOf("a.md")).toBe(0);
    expect(next.note(0)!.mtime).toBe(2);
    expect(postings(next, "alpha")).toEqual([`b.md:${BODY_FIELD}`, `a.md:${TITLE_FIELD}`]);
    expect(next.hasToken("old")).toBe(false);
    expect(postings(next, "fresh")).toEqual([`a.md:${BODY_FIELD}`]);
  });

  it("drops removed notes at once and their postings at commit, renumbering the rest in order", () => {
    const index = build([
      ["a.md", { alpha: BODY_FIELD, only: BODY_FIELD }],
      ["b.md", { alpha: BODY_FIELD }],
      ["c.md", { alpha: BODY_FIELD }],
    ]);
    index.remove("a.md");
    expect(index.noteByPath("a.md")).toBeNull();
    expect(index.size).toBe(2);
    expect(postings(index, "alpha")).toEqual([`b.md:${BODY_FIELD}`, `c.md:${BODY_FIELD}`]);

    index.upsert(note("a.md"), tokens({ alpha: BODY_FIELD }));
    const next = index.commit();
    expect(next.docCount).toBe(3);
    expect(Array.from(next.docIds(), (docId) => next.note(docId)!.path)).toEqual(["b.md", "c.md", "a.md"]);
    expect(postings(next, "alpha")).toEqual([`b.md:${BODY_FIELD}`, `c.md:${BODY_FIELD}`, `a.md:${BODY_FIELD}`]);
    expect(next.hasToken("only")).toBe(false);
  });

  it("lists prefix tokens alphabetically and tokens by length, shortest first", () => {
    const index = build([["a.md", { banana: BODY_FIELD, band: BODY_FIELD, bandit: BODY_FIELD, ban: BODY_FIELD, cab: BODY_FIELD }]]);

    expect(index.prefixTokens("ban", 10)).toEqual(["ban", "banana", "band", "bandit"]);
    expect(index.prefixTokens("ban", 2)).toEqual(["ban", "banana"]);
    expect(Array.from(index.tokensByLength(3, 4))).toEqual(["ban", "cab", "band"]);
    expect(Array.from(index.tokensByLength(7, 9))).toEqual([]);
  });

  it("finds words anywhere in note bodies, including single characters, but not in titles", () => {
    const index = build([
      ["a.md", { squeezed: BODY_FIELD, x: BODY_FIELD }],
      ["b.md", { breeze: TITLE_FIELD }],
    ]);

    expect(Array.from(index.bodyContainsWord("eez"))).toEqual([1, 0]);
    expect(Array.from(index.bodyContainsWord("x"))).toEqual([1, 0]);
    expect(Array.from(index.bodyContainsWord("squeezedtoolong"))).toEqual([0, 0]);
    expect(Array.from(index.bodyContainsWord(""))).toEqual([0, 0]);
  });

  it("copies strings without changing them", () => {
    const source = `${"x".repeat(50)}needle-value-long${"y".repeat(50)}`;
    const slice = source.slice(50, 67);
    expect(copyFlat(slice)).toBe("needle-value-long");
    expect(copyFlat("")).toBe("");
  });
});
