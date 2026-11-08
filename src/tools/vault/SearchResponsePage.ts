import { base64ToUtf8, utf8ToBase64 } from "../../utils/base64";
import { sha256HexFromBytesPortable } from "../../utils/sha256";
import { estimateTextTokens } from "../../utils/tokenCounting";
import { FILESYSTEM_LIMITS } from "./constants";
import type { FormattedScoredResults } from "../../services/search/searchScoring";

type SearchResult = FormattedScoredResults["results"][number] & { metadataOmitted?: boolean };
type SearchScan = Readonly<{
  id: string;
  revision: number;
  results: FormattedScoredResults;
  metaResults: readonly unknown[];
  truncated: boolean;
  snippets: readonly Readonly<{ text: string; tokens: number }>[];
}>;
type Cursor = {
  q: string;
  /** Index of the next snippet, compatible with existing search cursors. */
  o: number;
  s?: string;
  /** Character offset within that snippet; result metadata has its own index. */
  c?: number;
  r?: number;
};
type Position = { o: number; c: number; r: number };
type Scope = {
  paths: string[];
  /** When paths cannot fit, these fields describe the full, unchanged scope. */
  total_paths?: number;
  paths_omitted?: number;
  signature?: string;
  notice?: string;
};
type SearchResponse = Omit<FormattedScoredResults, "results"> & {
  results: SearchResult[];
  scope?: Scope;
  page: {
    tokensBudget: number;
    /** Estimate for JSON.stringify(the entire response), including this field. */
    tokensUsed: number;
    bodyTokenBudget: number;
    next_cursor: string | null;
    total_matches: number;
    returned_matches: number;
    omitted_matches: number;
    omitted_tokens: number;
    returned_results: number;
    omitted_results: number;
    /** A fragment is exact text, not a shortened preview; the next cursor resumes it. */
    snippet_offset?: number;
    snippet_continues?: boolean;
  };
  snippets: string[];
  footer: string;
};

const RESTART_NOTICE = "The search behind this cursor was no longer kept, so this page comes from a new search. Some matches may repeat or be missing; search again without a cursor for a fresh list.";
const NOTICE_OMITTED = "[notice omitted to fit page]";
const NOTICE_SUFFIX = "...[truncated to fit page]";

function decodeCursor(raw: string): Cursor {
  try {
    const value: unknown = JSON.parse(base64ToUtf8(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const cursor = value as Record<string, unknown>;
    if (typeof cursor.q !== "string" || typeof cursor.o !== "number") throw new Error();
    if (cursor.s !== undefined && typeof cursor.s !== "string") throw new Error();
    for (const key of ["o", "c", "r"]) {
      const offset = cursor[key];
      if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) {
        throw new Error();
      }
    }
    return cursor as Cursor;
  } catch {
    throw new Error("Invalid search cursor for this query.");
  }
}

/** Do not split a Unicode character between two snippet pages. */
function characterBoundary(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end - 1
    : end;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Owns the complete serialized search page, not just a snippet allowance.
 * Results are page-local, snippets continue losslessly, and optional oversized
 * notices/metadata carry explicit omission markers. An atomic result/path that
 * cannot fit even without redundant metadata throws instead of losing a hit or
 * returning a cursor with no progress. Scope summaries always describe the full
 * requested scope, never a smaller set of searched paths.
 */
export class SearchResponsePage {
  private readonly query: string;
  private readonly cursor: Cursor | null;
  private readonly pageTokens: number;

  constructor(request: { queryId: string; cursor?: string | null; pageTokens?: number | null }) {
    const requestedTokens = request.pageTokens ?? FILESYSTEM_LIMITS.MAX_TOOL_RESULT_TOKENS;
    if (typeof requestedTokens !== "number" || !Number.isFinite(requestedTokens)) {
      throw new Error("Search pageTokens must be a finite number.");
    }
    // These are the existing search API bounds, not a new result limit.
    this.pageTokens = Math.max(512, Math.min(4096, requestedTokens));
    this.query = sha256HexFromBytesPortable(new TextEncoder().encode(request.queryId));
    if (request.cursor != null && (typeof request.cursor !== "string" || request.cursor.length > 4096)) {
      throw new Error("Search cursor must be a string no longer than 4096 characters.");
    }
    this.cursor = request.cursor ? decodeCursor(request.cursor) : null;
    // Existing cursors used the full query instead of its compact digest.
    if (this.cursor && this.cursor.q !== this.query && this.cursor.q !== request.queryId) {
      throw new Error("Invalid search cursor for this query.");
    }
  }

  build(scan: SearchScan, searchPaths: readonly string[] | null): SearchResponse {
    const paths = searchPaths?.map((path) => path || ".") ?? [];
    let scope: Scope | undefined = searchPaths === null ? undefined : { paths };
    let summarizedScope = false;
    const summarizeScope = () => {
      if (scope === undefined || summarizedScope) return false;
      const summary: Scope = {
        paths: [], total_paths: paths.length, paths_omitted: paths.length,
        signature: sha256HexFromBytesPortable(new TextEncoder().encode(JSON.stringify(paths))),
        notice: "All requested paths were searched; scope paths omitted to fit this page.",
      };
      if (JSON.stringify(summary).length >= JSON.stringify(scope).length) return false;
      scope = summary;
      summarizedScope = true;
      return true;
    };
    const metadata = [...(scan.results.metaInfo ?? []), ...scan.metaResults];
    const restarted = this.cursor !== null && this.cursor.s !== scan.id;
    const restartMetadata = restarted
      ? [{ file: "_new_search", notice: RESTART_NOTICE, totalMatches: 0, contexts: [] }]
      : [];
    const metadataMarker = (omitted: number) => ({
      file: "_page_metadata", notice: "Search metadata omitted to fit this page.", omitted,
    });
    let metaInfo: unknown[] = [...restartMetadata, ...(metadata.length ? [metadataMarker(metadata.length)] : [])];
    const notice = [
      scan.results.notice,
      scan.truncated ? `Results were truncated to stay within the ${FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS} character response cap.` : "",
    ].filter(Boolean).join(" ");
    let pageNotice = notice ? NOTICE_OMITTED : "";
    // A replaced scan cannot safely reuse indices into its old streams.
    const source = restarted ? null : this.cursor;
    let position: Position = { o: source?.o ?? 0, c: source?.c ?? 0, r: source?.r ?? 0 };
    this.validatePosition(position, scan);
    const start = { ...position };
    const results: SearchResult[] = [];
    const snippets: string[] = [];
    let progressed = false;
    const remainingSnippetTokens = new Array<number>(scan.snippets.length + 1).fill(0);
    for (let index = scan.snippets.length - 1; index >= 0; index--) {
      remainingSnippetTokens[index] = remainingSnippetTokens[index + 1] + scan.snippets[index].tokens;
    }

    const hasMore = (at: Position) => at.o < scan.snippets.length || at.r < scan.results.results.length;
    const encode = (at: Position): string => utf8ToBase64(JSON.stringify({
      q: this.query, o: at.o, s: scan.id, ...(at.c > 0 ? { c: at.c } : {}), ...(at.r > 0 ? { r: at.r } : {}),
    }));
    const makeResponse = (at: Position): SearchResponse => {
      const remaining = scan.snippets.length > 0
        ? scan.snippets.length - at.o
        : scan.results.results.length - at.r;
      let omittedTokens = remainingSnippetTokens[at.o];
      if (at.c > 0) {
        omittedTokens += estimateTextTokens(scan.snippets[at.o].text.slice(at.c)) - scan.snippets[at.o].tokens;
      }
      const more = hasMore(at);
      const response: SearchResponse = {
        ...scan.results,
        results: [...results],
        ...(scan.results.metaInfo !== undefined || metaInfo.length > 0 ? { metaInfo: [...metaInfo] } : {}),
        ...(notice ? { notice: pageNotice } : {}),
        ...(scan.truncated || summarizedScope || results.some((result) => result.metadataOmitted) ? { truncated: true } : {}),
        ...(scope === undefined ? {} : { scope }),
        page: {
          tokensBudget: this.pageTokens,
          tokensUsed: 0,
          bodyTokenBudget: this.pageTokens,
          next_cursor: more ? encode(at) : null,
          total_matches: scan.snippets.length || scan.results.results.length,
          returned_matches: scan.snippets.length > 0 ? snippets.length : results.length,
          omitted_matches: remaining,
          omitted_tokens: omittedTokens,
          returned_results: results.length,
          omitted_results: scan.results.results.length - at.r,
          ...(start.c > 0 || at.c > 0 ? { snippet_offset: start.c, snippet_continues: at.c > 0 } : {}),
        },
        snippets: [...snippets],
        footer: remaining > 0
          ? `...[omitted ${omittedTokens} tokens across ${remaining} matches]`
          : more ? "More search result metadata follows." : "",
      };
      // The number's own serialized digits are part of the response budget.
      let measured = estimateTextTokens(JSON.stringify(response));
      while (response.page.tokensUsed !== measured) {
        response.page.tokensUsed = measured;
        measured = estimateTextTokens(JSON.stringify(response));
      }
      return response;
    };
    const fits = (at: Position): boolean => {
      const response = makeResponse(at);
      return response.page.tokensUsed <= this.pageTokens
        && JSON.stringify(response).length <= FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS;
    };
    // Return the longest prefix that fits with its real continuation cursor.
    const prefixEnd = (text: string, offset: number, tryEnd: (end: number) => boolean): number => {
      let low = offset + 1;
      let high = text.length - 1;
      let best = offset;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const end = characterBoundary(text, middle);
        if (end > offset && tryEnd(end)) {
          best = end;
          low = middle + 1;
        } else if (end <= offset) {
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return best;
    };
    const snippetPosition = (end: number): Position => end === scan.snippets[position.o].text.length
      ? { ...position, o: position.o + 1, c: 0 }
      : { ...position, c: end };
    const withMinimumSnippet = (at: Position): boolean => {
      if (at.o >= scan.snippets.length) return fits(at);
      const text = scan.snippets[at.o].text;
      const end = characterBoundary(text, at.c + 1) === at.c ? at.c + 2 : at.c + 1;
      snippets.push(text.slice(at.c, end));
      const next = end >= text.length ? { ...at, o: at.o + 1, c: 0 } : { ...at, c: end };
      const accepted = fits(next);
      snippets.pop();
      return accepted;
    };
    const compactResult = (result: SearchResult): SearchResult => ({
      file: result.file, path: result.path, score: result.score,
      reasoning: "[metadata omitted to fit page]", keywordsFound: [], keywordsMissing: [], metadataOmitted: true,
    });

    if (!fits(position) && (!summarizeScope() || !fits(position))) {
      throw new Error("Search response metadata cannot fit within this page's token or character budget.");
    }
    while (hasMore(position)) {
      if (position.r < scan.results.results.length) {
        const result = scan.results.results[position.r];
        const next = { ...position, r: position.r + 1 };
        results.push(result);
        // Reserve actual snippet progress before filling the page with metadata.
        let accepted = withMinimumSnippet(next);
        if (!accepted && summarizeScope()) accepted = withMinimumSnippet(next);
        if (!accepted) {
          results[results.length - 1] = compactResult(result);
          accepted = withMinimumSnippet(next);
        }
        // A long atomic path can require a metadata-only page. Never skip it.
        if (!accepted && !progressed) accepted = fits(next);
        if (accepted) {
          position = next;
          progressed = true;
        } else {
          results.pop();
          if (!progressed) {
            throw new Error("Search result path cannot fit within this page's token or character budget. Request a larger pageTokens value or a narrower search.");
          }
          break;
        }
      }
      if (position.o < scan.snippets.length) {
        const text = scan.snippets[position.o].text;
        const offset = position.c;
        snippets.push(text.slice(offset));
        const next = { ...position, o: position.o + 1, c: 0 };
        if (fits(next)) {
          position = next;
          progressed = true;
          continue;
        }
        snippets.pop();
        let end = prefixEnd(text, offset, (end) => {
          snippets.push(text.slice(offset, end));
          const accepted = fits(snippetPosition(end));
          snippets.pop();
          return accepted;
        });
        if (end === offset && summarizeScope()) {
          end = prefixEnd(text, offset, (end) => {
            snippets.push(text.slice(offset, end));
            const accepted = fits(snippetPosition(end));
            snippets.pop();
            return accepted;
          });
        }
        if (end > offset) {
          snippets.push(text.slice(offset, end));
          position = snippetPosition(end);
          progressed = true;
        }
        if (!progressed) throw new Error("Search snippet cannot fit within this page's token or character budget.");
        break;
      }
    }
    // Optional diagnostics use only space left after real result/snippet progress.
    if (notice) {
      pageNotice = notice;
      if (!fits(position)) {
        const end = prefixEnd(notice, 0, (end) => {
          pageNotice = notice.slice(0, end) + NOTICE_SUFFIX;
          return fits(position);
        });
        pageNotice = end > 0 ? notice.slice(0, end) + NOTICE_SUFFIX : NOTICE_OMITTED;
      }
    }
    const keptMetadata: unknown[] = [];
    for (let index = 0; index < metadata.length; index++) {
      const tail = index + 1 < metadata.length ? [metadataMarker(metadata.length - index - 1)] : [];
      metaInfo = [...restartMetadata, ...keptMetadata, metadata[index], ...tail];
      if (fits(position)) { keptMetadata.push(metadata[index]); continue; }
      const record = recordOf(metadata[index]);
      const text = record?.notice;
      if (typeof text === "string") {
        const end = prefixEnd(text, 0, (end) => {
          metaInfo = [...restartMetadata, ...keptMetadata, { ...record, notice: text.slice(0, end) + NOTICE_SUFFIX, truncated: true }, ...tail];
          return fits(position);
        });
        if (end > 0) {
          keptMetadata.push({ ...record, notice: text.slice(0, end) + NOTICE_SUFFIX, truncated: true });
          metaInfo = [...restartMetadata, ...keptMetadata, ...tail];
          break;
        }
      }
      metaInfo = [...restartMetadata, ...keptMetadata, metadataMarker(metadata.length - index)];
      break;
    }
    // Every returned cursor advances a result or a snippet character/index.
    if (hasMore(position) && position.o === start.o && position.c === start.c && position.r === start.r) {
      throw new Error("Search response cannot make progress within this page's token or character budget.");
    }
    return makeResponse(position);
  }

  private validatePosition(at: Position, scan: SearchScan): void {
    if (at.o > scan.snippets.length || at.r > scan.results.results.length
      || (at.c > 0 && (!scan.snippets[at.o] || at.c >= scan.snippets[at.o].text.length
        || characterBoundary(scan.snippets[at.o].text, at.c) !== at.c))) {
      throw new Error("Invalid search cursor for this scan.");
    }
  }
}
