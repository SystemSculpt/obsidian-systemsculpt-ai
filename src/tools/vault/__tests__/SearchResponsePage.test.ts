/** @jest-environment node */
import { SearchResponsePage } from "../SearchResponsePage";
import { FILESYSTEM_LIMITS } from "../constants";
import { base64ToUtf8, utf8ToBase64 } from "../../../utils/base64";
import * as tokenCounting from "../../../utils/tokenCounting";

jest.mock("../../../utils/tokenCounting", () => {
  const actual = jest.requireActual<typeof import("../../../utils/tokenCounting")>("../../../utils/tokenCounting");
  return { ...actual, countTextTokens: jest.fn(actual.countTextTokens), estimateTextTokens: jest.fn(actual.estimateTextTokens) };
});
const realTokenCounting = jest.requireActual<typeof import("../../../utils/tokenCounting")>("../../../utils/tokenCounting");

type Scan = Parameters<SearchResponsePage["build"]>[0];
type Response = ReturnType<SearchResponsePage["build"]>;

function result(path: string, index = 0): Scan["results"]["results"][number] {
  return {
    path, file: path.slice(path.lastIndexOf("/") + 1), score: 80 - index,
    reasoning: "A matching note in the requested search scope.",
    keywordsFound: ["needle"], keywordsMissing: [],
    created: "2026-11-01T00:00:00.000Z", modified: "2026-11-07T00:00:00.000Z", fileSize: 1000,
  };
}

function scan(texts: string[], paths: string[] = []): Scan {
  return {
    id: "kept-scan", revision: 1, truncated: false, metaResults: [],
    snippets: texts.map((text) => ({ text, tokens: tokenCounting.estimateTextTokens(text) })),
    results: {
      results: paths.map(result), totalFound: paths.length,
      searchSummary: { topScore: 80, averageScore: 70, confidenceLevel: "high" },
    },
  };
}

function expectBudget(response: Response, budget: number): void {
  const serialized = JSON.stringify(response);
  expect(response.page.tokensBudget).toBe(budget);
  expect(response.page.tokensUsed).toBe(tokenCounting.estimateTextTokens(serialized));
  expect(response.page.tokensUsed).toBeLessThanOrEqual(budget);
  expect(serialized.length).toBeLessThanOrEqual(FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS);
}

function pages(kept: Scan, budget: number, paths: string[] | null = null, queryId = "needle"): Response[] {
  const collected: Response[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = new SearchResponsePage({ queryId, pageTokens: budget, cursor }).build(kept, paths);
    expectBudget(response, budget);
    collected.push(response);
    cursor = response.page.next_cursor;
    if (cursor !== null) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return collected;
}

describe("SearchResponsePage", () => {
  afterEach(() => {
    jest.mocked(tokenCounting.countTextTokens).mockImplementation(realTokenCounting.countTextTokens);
    jest.mocked(tokenCounting.estimateTextTokens).mockImplementation(realTokenCounting.estimateTextTokens);
  });

  it("never memoizes disposable trial pages or remaining snippet text", () => {
    const kept = scan(["needle words ".repeat(4000)]);
    jest.mocked(tokenCounting.countTextTokens).mockClear().mockImplementation(() => {
      throw new Error("Disposable page text must not enter the shared token cache");
    });
    const first = new SearchResponsePage({ queryId: "needle", pageTokens: 512 }).build(kept, null);
    const next = new SearchResponsePage({ queryId: "needle", pageTokens: 512, cursor: first.page.next_cursor }).build(kept, null);
    expectBudget(first, 512);
    expectBudget(next, 512);
    expect(tokenCounting.countTextTokens).not.toHaveBeenCalled();
  });

  it.each([512, 2048, 4096])("counts the whole serialized response within %i tokens", (budget) => {
    const paths = Array.from({ length: 30 }, (_, index) => `Notes/${index}.md`);
    const kept = scan(paths.map((path) => `${path}:1  needle ${"context ".repeat(80)}`), paths);
    const responses = pages(kept, budget, ["Notes"]);

    expect(responses.length).toBeGreaterThan(1);
    expect(responses.flatMap((response) => response.results.map((entry) => entry.path))).toEqual(paths);
    expect(responses.flatMap((response) => response.snippets).join("")).toBe(kept.snippets.map((entry) => entry.text).join(""));
    expect(responses[0].snippets.length).toBeGreaterThan(0);
    expect(responses[0].results.length).toBeGreaterThan(0);
    expect(responses.every((response) => response.scope?.paths[0] === "Notes")).toBe(true);
  });

  it("bounds long metadata and scope without pretending a smaller scope was searched", () => {
    const scopePaths = Array.from({ length: 64 }, (_, index) => `Folder${index}/${"long-subfolder/".repeat(35)}`);
    const resultPaths = Array.from({ length: 40 }, (_, index) => `Notes/${index}.md`);
    const kept = {
      ...scan(resultPaths.map((path) => `${path}:1  needle in the note`), resultPaths),
      metaResults: [{ file: "_summary", notice: "scan details ".repeat(4000), totalMatches: 40, contexts: [] }],
    };
    const responses = pages(kept, 512, scopePaths, `needle|paths:${scopePaths.join("|")}`);

    expect(responses.flatMap((response) => response.results.map((entry) => entry.path))).toEqual(resultPaths);
    expect(responses.flatMap((response) => response.snippets).join("")).toBe(kept.snippets.map((entry) => entry.text).join(""));
    for (const response of responses) {
      expect(response.scope).toMatchObject({ paths: [], total_paths: 64, paths_omitted: 64 });
      expect(response.scope?.notice).toContain("All requested paths were searched");
      expect(response.scope?.signature).toBe(responses[0].scope?.signature);
      expect(JSON.stringify(response.metaInfo)).toMatch(/omitted|truncated to fit page/);
      if (response.page.next_cursor) expect(response.page.next_cursor.length).toBeLessThan(4096);
    }
  });

  it("continues an oversized first snippet instead of skipping its remaining text", () => {
    const text = `First.md:1  needle ${"important match text ".repeat(900)}`;
    const kept = scan([text, "Next.md:1  needle next match"], ["First.md", "Next.md"]);
    const responses = pages(kept, 512);
    const cursor = JSON.parse(base64ToUtf8(responses[0].page.next_cursor!)) as { q: string; o: number; c: number; s: string };

    expect(responses[0].snippets).toHaveLength(1);
    expect(responses[0].page.snippet_continues).toBe(true);
    expect(cursor).toMatchObject({ o: 0, s: kept.id });
    expect(cursor.c).toBeGreaterThan(0);
    expect(responses.flatMap((response) => response.snippets).join("")).toBe(text + kept.snippets[1].text);
    expect(responses.at(-1)?.page.next_cursor).toBeNull();
  });

  it("returns stable exact-once chunks through Unicode and JSON-escaped text", () => {
    const texts = [
      `Unicode.md:1  ${"👩🏽‍💻 漢字 \\\"\n".repeat(400)}`,
      "Second.md:1  a different match",
      `Third.md:9  ${"last ".repeat(700)}`,
    ];
    const kept = scan(texts, ["Unicode.md", "Second.md", "Third.md"]);
    const firstPass = pages(kept, 512);
    const replay = pages(kept, 512);

    expect(firstPass).toEqual(replay);
    expect(firstPass.flatMap((response) => response.snippets).join("")).toBe(texts.join(""));
    for (const fragment of firstPass.flatMap((response) => response.snippets)) {
      expect(fragment).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it("pages path-only results exactly once without a snippet-driven cursor", () => {
    const paths = Array.from({ length: 80 }, (_, index) => `Folders/needle-${index}.md`);
    const kept = scan([], paths);
    const responses = pages(kept, 512);

    expect(responses.length).toBeGreaterThan(1);
    expect(responses.flatMap((response) => response.results.map((entry) => entry.path))).toEqual(paths);
    expect(responses.every((response) => response.snippets.length === 0)).toBe(true);
    expect(responses[0].page.total_matches).toBe(paths.length);
    expect(responses[0].page.returned_matches).toBe(responses[0].results.length);
    expect(responses.at(-1)?.page.omitted_results).toBe(0);
  });

  it("does not lose path-only hits when other results have snippets", () => {
    const paths = ["Content.md", ...Array.from({ length: 30 }, (_, index) => `PathOnly/needle-${index}.md`)];
    const kept = scan([`Content.md:1  ${"needle ".repeat(2000)}`], paths);
    const responses = pages(kept, 512);

    expect(responses.flatMap((response) => response.results.map((entry) => entry.path))).toEqual(paths);
    expect(responses[0].snippets.length).toBeGreaterThan(0);
    expect(responses[0].results).toHaveLength(1);
    expect(responses.flatMap((response) => response.snippets).join("")).toBe(kept.snippets[0].text);
  });

  it("honors the character cap even when the token counter allows much more text", () => {
    jest.mocked(tokenCounting.estimateTextTokens).mockImplementation((text) => Math.ceil(text.length / 100));
    const text = `Note.md:1  ${"x".repeat(FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS * 3)}`;
    const responses = pages(scan([text]), 4096);

    expect(responses.length).toBeGreaterThan(1);
    expect(responses[0].snippets[0].length).toBeGreaterThan(20000);
    expect(responses.flatMap((response) => response.snippets).join("")).toBe(text);
  });

  it("marks oversized redundant result metadata while preserving the complete path", () => {
    const kept = scan(["Note.md:1  needle"], ["Note.md"]);
    kept.results.results[0].reasoning = "redundant ranking explanation ".repeat(5000);
    kept.results.results[0].keywordsFound = Array.from({ length: 5000 }, (_, index) => `keyword-${index}`);
    const responses = pages(kept, 512);

    expect(responses[0].results[0]).toMatchObject({ path: "Note.md", file: "Note.md", metadataOmitted: true });
    expect(responses[0].results[0].reasoning).toContain("metadata omitted");
    expect(responses[0].truncated).toBe(true);
    expect(responses.flatMap((response) => response.snippets)).toEqual(["Note.md:1  needle"]);
    expect(kept.results.results[0].reasoning.length).toBeGreaterThan(100000);
  });

  it("explicitly fails an atomic path that cannot fit instead of dropping it or looping", () => {
    const kept = scan([], [`Notes/${"x".repeat(FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS)}.md`]);

    expect(() => new SearchResponsePage({ queryId: "needle", pageTokens: 512 }).build(kept, null))
      .toThrow("Search result path cannot fit");
  });

  it("explicitly truncates long notices, including responses with no matches", () => {
    const kept = scan([]);
    kept.results.notice = "A very long search notice. ".repeat(5000);
    const response = new SearchResponsePage({ queryId: "needle", pageTokens: 512 }).build(kept, null);

    expectBudget(response, 512);
    expect(response.notice).toContain("truncated to fit page");
    expect(response.page.next_cursor).toBeNull();
    expect(response.page.returned_matches).toBe(0);
  });

  it("keeps an explicit omission marker when arbitrary metadata cannot fit", () => {
    const kept = { ...scan([]), metaResults: [{ details: "x".repeat(50000) }] };
    const response = new SearchResponsePage({ queryId: "needle", pageTokens: 512 }).build(kept, null);

    expectBudget(response, 512);
    expect(response.metaInfo).toEqual([expect.objectContaining({ file: "_page_metadata", omitted: 1 })]);
    expect(response.page.next_cursor).toBeNull();
  });

  it("accepts an existing q/o/s cursor and preserves its snippet index", () => {
    const kept = scan(["first", "second"]);
    const cursor = utf8ToBase64(JSON.stringify({ q: "needle", o: 1, s: kept.id }));
    const response = new SearchResponsePage({ queryId: "needle", cursor, pageTokens: 512 }).build(kept, null);

    expect(response.snippets).toEqual(["second"]);
    expect(response.page.next_cursor).toBeNull();
  });

  it("safely restarts legacy cursors without a scan identity and discloses possible repeats", () => {
    const kept = scan(["first match", "second match"]);
    const cursor = utf8ToBase64(JSON.stringify({ q: "needle", o: 1 }));
    const response = new SearchResponsePage({ queryId: "needle", cursor, pageTokens: 512 }).build(kept, null);

    expectBudget(response, 512);
    expect(response.snippets).toEqual(["first match", "second match"]);
    expect(response.metaInfo).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "_new_search", notice: expect.stringContaining("Some matches may repeat") }),
    ]));
  });

  it("restarts stale scan positions with a visible notice instead of applying old character offsets", () => {
    const kept = scan(["needle ".repeat(2000)], ["Old.md"]);
    const first = new SearchResponsePage({ queryId: "needle", pageTokens: 512 }).build(kept, null);
    const replacement = { ...scan(["New.md:1  needle"], ["New.md"]), id: "replacement" };
    const response = new SearchResponsePage({ queryId: "needle", cursor: first.page.next_cursor, pageTokens: 512 })
      .build(replacement, null);

    expectBudget(response, 512);
    expect(response.snippets).toEqual(["New.md:1  needle"]);
    expect(response.results.map((entry) => entry.path)).toEqual(["New.md"]);
    expect(response.metaInfo).toEqual(expect.arrayContaining([expect.objectContaining({ file: "_new_search" })]));
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite pageTokens %s", (pageTokens) => {
    expect(() => new SearchResponsePage({ queryId: "needle", pageTokens })).toThrow("finite number");
  });

  it.each([
    { q: "wrong query", o: 0 }, { q: "needle", o: -1 }, { q: "needle", o: 0.5 },
    { q: "needle", o: 0, c: -1 }, { q: "needle", o: 0, r: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed or mismatched cursors %j", (state) => {
    const cursor = utf8ToBase64(JSON.stringify(state));
    expect(() => new SearchResponsePage({ queryId: "needle", cursor })).toThrow("Invalid search cursor");
  });

  it("rejects offsets outside the kept scan or inside a surrogate pair", () => {
    const kept = scan(["👩 needle"]);
    for (const state of [{ o: 2 }, { o: 0, c: 1 }, { o: 0, r: 1 }]) {
      const cursor = utf8ToBase64(JSON.stringify({ q: "needle", s: kept.id, ...state }));
      expect(() => new SearchResponsePage({ queryId: "needle", cursor }).build(kept, null)).toThrow("Invalid search cursor");
    }
  });
});
